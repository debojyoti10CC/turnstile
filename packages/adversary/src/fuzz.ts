import { encodeAddress, newSessionKey, signVoucher, type ChannelConfig } from '@turnstile/core';
import { claimBatch, deposit, getChannel, getUnsettled, refund, settle } from '@turnstile/escrow-client';
import type { AttackResult } from './report.js';
import { bootstrap } from './world.js';

/**
 * Random op sequences on real LocalNet (default 500 steps, satisfying
 * CLAUDE.md's "≥500 steps" fuzz requirement -- confirmed to run in well
 * under a minute against a local node), asserting I1 (totalClaimed <=
 * balance), I2 (totalClaimed monotonic) and I3 (conservation) after every
 * step. The op set here (deposit/claim/stale-claim/refund/settle) omits
 * withdraw/finalize -- see docs/DECISIONS.md: that path needs a dev-mode
 * clock advance (two extra transactions) per attempt, and is already
 * covered by dedicated real-node tests elsewhere (escrow-client's localnet
 * suite, the settler's I8 test); the offline pytest fuzz
 * (contracts/tests/test_contract.py `test_fuzz_conservation`) additionally
 * covers withdraw/finalize cheaply against the algopy emulator.
 */
export async function runFuzz(steps: number): Promise<AttackResult> {
  const world = await bootstrap();
  const rng = mulberry32(402);

  const session = await newSessionKey();
  const config: ChannelConfig = {
    payer: world.summary.payer,
    payerAuthorizer: encodeAddress(session.pk),
    receiver: world.summary.receiver,
    receiverAuthorizer: world.summary.receiver,
    asset: BigInt(world.summary.asset_id),
    withdrawDelay: 900n,
    salt: new Uint8Array(32).map(() => Math.floor(rng() * 256)),
  };

  let deposited = 1000n;
  let paidOut = 0n;
  let refunded = 0n;
  let signedMax = 0n;

  const cid = await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: deposited }, world.deployment);

  try {
    for (let i = 0; i < steps; i++) {
      const state = await getChannel(world.algorand, world.appClient, cid);
      const balance = state!.balance;
      const claimed = state!.totalClaimed;
      const op = (['dep', 'claim', 'stale', 'refund', 'settle'] as const)[Math.floor(rng() * 5)]!;

      if (op === 'dep') {
        const amount = 1n + BigInt(Math.floor(rng() * 500));
        await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount }, world.deployment);
        deposited += amount;
      } else if (op === 'claim' && balance > claimed) {
        const max = claimed + 1n + BigInt(Math.floor(rng() * Number(balance - claimed)));
        const total = claimed + BigInt(Math.floor(rng() * Number(max - claimed + 1n)));
        const sig = await signVoucher(session.sk, world.deployment, cid, max);
        await claimBatch({
          appClient: world.appClient,
          sender: world.summary.receiver,
          rows: [{ channelId: cid, maxClaimable: max, signature: sig, totalClaimed: total }],
          receiverByChannel: () => ({ receiver: world.summary.receiver, asset: BigInt(world.summary.asset_id) }),
        });
        signedMax = max > signedMax ? max : signedMax;
      } else if (op === 'stale' && claimed > 0n) {
        const sig = await signVoucher(session.sk, world.deployment, cid, claimed);
        const newlyClaimed = await claimBatch({
          appClient: world.appClient,
          sender: world.summary.receiver,
          rows: [{ channelId: cid, maxClaimable: claimed, signature: sig, totalClaimed: claimed }],
          receiverByChannel: () => ({ receiver: world.summary.receiver, asset: BigInt(world.summary.asset_id) }),
        });
        if (newlyClaimed !== 0n) throw new Error(`stale claim was not a no-op: claimed ${newlyClaimed} more`);
      } else if (op === 'refund' && balance > claimed) {
        const amount = 1n + BigInt(Math.floor(rng() * Number(balance - claimed)));
        const amt = await refund({ appClient: world.appClient, sender: world.summary.receiver, channelId: cid, amount, asset: config.asset, payer: world.summary.payer });
        refunded += amt;
      } else if (op === 'settle') {
        const unsettled = await getUnsettled(world.algorand, world.appClient, world.summary.receiver, config.asset);
        if (unsettled > 0n) {
          const amt = await settle({ appClient: world.appClient, sender: world.summary.receiver, receiver: world.summary.receiver, asset: config.asset });
          paidOut += amt;
        }
      }

      const after = await getChannel(world.algorand, world.appClient, cid);
      if (after!.totalClaimed > after!.balance) throw new Error(`I1 violated at step ${i} (${op}): totalClaimed > balance`);
      if (after!.totalClaimed < claimed) throw new Error(`I2 violated at step ${i} (${op}): totalClaimed regressed`);
      const unsettledNow = await getUnsettled(world.algorand, world.appClient, world.summary.receiver, config.asset);
      const lhs = deposited;
      const rhs = (after!.balance - after!.totalClaimed) + unsettledNow + paidOut + refunded;
      if (lhs !== rhs) throw new Error(`I3 violated at step ${i} (${op}): deposited=${lhs} != (balance-totalClaimed)+unsettled+paidOut+refunded=${rhs}`);
    }
    return { attack: `fuzz_${steps}_steps_I1_I2_I3`, layer: 'fuzz', expected: 'rejected', actual: 'rejected', pass: true, detail: `${steps} steps, final signedMax=${signedMax}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { attack: `fuzz_${steps}_steps_I1_I2_I3`, layer: 'fuzz', expected: 'rejected', actual: 'accepted', pass: false, detail: message.slice(0, 400) };
  }
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
