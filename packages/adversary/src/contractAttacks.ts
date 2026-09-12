import { randomBytes } from 'node:crypto';
import algosdk from 'algosdk';
import { microAlgos } from '@algorandfoundation/algokit-utils';
import {
  channelId as computeChannelId,
  newSessionKey,
  toB64,
  fromB64,
  type Deployment,
} from '@turnstilealgo/core';
import {
  claimBatch,
  deposit,
  finalizeWithdraw,
  getChannel,
  initiateWithdraw,
  refund,
  channelBoxName,
} from '@turnstilealgo/escrow-client';
import { expectFalsy, expectRejected, type AttackResult } from './report.js';
import { bootstrap, freshConfig, maliciousDeposit, newChannel, sign, type World } from './world.js';

async function claimOne(world: World, sender: string, cid: Uint8Array, max: bigint, sig: Uint8Array, totalClaimed: bigint) {
  await claimBatch({
    appClient: world.appClient,
    sender,
    rows: [{ channelId: cid, maxClaimable: max, signature: sig, totalClaimed }],
    receiverByChannel: () => ({ receiver: world.summary.receiver, asset: BigInt(world.summary.asset_id) }),
  });
}

export async function runContractAttacks(): Promise<AttackResult[]> {
  const world = await bootstrap();
  const results: AttackResult[] = [];

  // --- 1. Replay a lower voucher after a higher one already claimed: must no-op, not regress ---
  results.push(
    await expectFalsy('replay_lower_voucher_after_higher_claimed', 'contract', async () => {
      const { session, config, cid } = await newChannel(world, 1_000_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 1_000_000n }, world.deployment);
      const highSig = await sign(session, world.deployment, cid, 600_000n);
      await claimOne(world, world.summary.receiver, cid, 600_000n, highSig, 600_000n);
      // Replay: submit the SAME voucher again with a lower total_claimed target.
      // The call itself succeeds (stale rows are no-ops, not reverts) -- the
      // attack is "accepted" only if it actually moved total_claimed backward.
      const lowSig = await sign(session, world.deployment, cid, 600_000n);
      await claimOne(world, world.summary.receiver, cid, 600_000n, lowSig, 300_000n);
      const state = await getChannel(world.algorand, world.appClient, cid);
      return state!.totalClaimed !== 600_000n; // true = attack succeeded (bad)
    }),
  );

  // --- 2. Voucher signed for channel A submitted against channel B's claim row ---
  results.push(
    await expectRejected('voucher_from_channel_a_used_on_channel_b', 'contract', async () => {
      const a = await newChannel(world, 100_000n);
      const b = await newChannel(world, 100_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config: a.config, amount: 100_000n }, world.deployment);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config: b.config, amount: 100_000n }, world.deployment);
      const sigForA = await sign(a.session, world.deployment, a.cid, 50_000n);
      // Claim row claims b.cid but carries A's signature over A's message.
      await claimOne(world, world.summary.receiver, b.cid, 50_000n, sigForA, 50_000n);
    }),
  );

  // --- 3. Voucher signed for a different app id (simulated: different genesis/app in the signed message) ---
  results.push(
    await expectRejected('voucher_signed_for_other_app_id', 'contract', async () => {
      const { session, config, cid } = await newChannel(world, 100_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 100_000n }, world.deployment);
      const wrongDeployment: Deployment = { genesisHash: world.deployment.genesisHash, appId: world.deployment.appId + 999n };
      const sig = await sign(session, wrongDeployment, cid, 50_000n);
      await claimOne(world, world.summary.receiver, cid, 50_000n, sig, 50_000n);
    }),
  );

  // --- 4. Voucher signed for a different genesis hash ---
  results.push(
    await expectRejected('voucher_signed_for_other_genesis', 'contract', async () => {
      const { session, config, cid } = await newChannel(world, 100_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 100_000n }, world.deployment);
      const wrongDeployment: Deployment = { genesisHash: randomBytes(32), appId: world.deployment.appId };
      const sig = await sign(session, wrongDeployment, cid, 50_000n);
      await claimOne(world, world.summary.receiver, cid, 50_000n, sig, 50_000n);
    }),
  );

  // --- 5. Bit-flipped signature ---
  results.push(
    await expectRejected('bit_flipped_signature', 'contract', async () => {
      const { session, config, cid } = await newChannel(world, 100_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 100_000n }, world.deployment);
      const sig = await sign(session, world.deployment, cid, 50_000n);
      const flipped = new Uint8Array(sig);
      flipped[0] = flipped[0]! ^ 0xff;
      await claimOne(world, world.summary.receiver, cid, 50_000n, flipped, 50_000n);
    }),
  );

  // --- 6. Wrong signer (different keypair signs the exact same message) ---
  results.push(
    await expectRejected('wrong_signer', 'contract', async () => {
      const { config, cid } = await newChannel(world, 100_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 100_000n }, world.deployment);
      const impostor = await newSessionKey();
      const sig = await sign(impostor, world.deployment, cid, 50_000n);
      await claimOne(world, world.summary.receiver, cid, 50_000n, sig, 50_000n);
    }),
  );

  // --- 7. maxClaimable > balance ---
  results.push(
    await expectRejected('max_claimable_exceeds_balance', 'contract', async () => {
      const { session, config, cid } = await newChannel(world, 100_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 100_000n }, world.deployment);
      const sig = await sign(session, world.deployment, cid, 999_999_999n);
      await claimOne(world, world.summary.receiver, cid, 999_999_999n, sig, 999_999_999n);
    }),
  );

  // --- 8. total_claimed (row target) > max_claimable (signed cap) ---
  results.push(
    await expectRejected('total_claimed_exceeds_signed_max', 'contract', async () => {
      const { session, config, cid } = await newChannel(world, 100_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 100_000n }, world.deployment);
      const sig = await sign(session, world.deployment, cid, 50_000n);
      await claimOne(world, world.summary.receiver, cid, 50_000n, sig, 60_000n);
    }),
  );

  // --- 9. Non-receiver claim ---
  results.push(
    await expectRejected('non_receiver_claim', 'contract', async () => {
      const { session, config, cid } = await newChannel(world, 100_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 100_000n }, world.deployment);
      const sig = await sign(session, world.deployment, cid, 50_000n);
      await claimOne(world, world.summary.payer, cid, 50_000n, sig, 50_000n); // payer isn't receiver/receiverAuthorizer
    }),
  );

  // --- 10. Non-receiver refund ---
  results.push(
    await expectRejected('non_receiver_refund', 'contract', async () => {
      const { config, cid } = await newChannel(world, 100_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 100_000n }, world.deployment);
      await refund({
        appClient: world.appClient, sender: world.summary.payer, channelId: cid,
        amount: 1_000n, asset: BigInt(world.summary.asset_id), payer: world.summary.payer,
      });
    }),
  );

  // --- 11. Non-payer withdraw ---
  results.push(
    await expectRejected('non_payer_initiate_withdraw', 'contract', async () => {
      const { config, cid } = await newChannel(world, 100_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 100_000n }, world.deployment);
      await initiateWithdraw({ appClient: world.appClient, sender: world.summary.receiver, channelId: cid, amount: 50_000n });
    }),
  );

  // --- 12. Finalize before the withdraw delay elapses ---
  results.push(
    await expectRejected('finalize_before_delay', 'contract', async () => {
      const { config, cid } = await newChannel(world, 100_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 100_000n }, world.deployment);
      await initiateWithdraw({ appClient: world.appClient, sender: world.summary.payer, channelId: cid, amount: 50_000n });
      await finalizeWithdraw({ appClient: world.appClient, sender: world.summary.payer, channelId: cid, asset: BigInt(world.summary.asset_id) });
    }),
  );

  // --- 13-17. Malicious deposit groups ---
  const depositAttacks: Array<[string, Parameters<typeof maliciousDeposit>[3]]> = [
    ['deposit_with_rekey', { rekeyTo: world.summary.receiver }],
    ['deposit_with_close_to', { closeAssetTo: world.summary.deployer }],
    ['deposit_with_clawback', { clawbackTarget: world.summary.deployer }],
    ['deposit_wrong_receiver', { axferReceiver: world.summary.receiver }],
    ['deposit_sender_not_payer', { axferSender: world.summary.receiver }],
  ];
  for (const [name, overrides] of depositAttacks) {
    results.push(
      await expectRejected(name, 'contract', async () => {
        const { config } = await newChannel(world, 100_000n);
        await maliciousDeposit(world, config, 100_000n, overrides);
      }),
    );
  }

  // --- 18. Drain (withdraw all) + re-fund + replay the pre-drain voucher ---
  // Attack succeeds only if the replay lets totalClaimed exceed what was
  // genuinely claimed before the drain (i.e. the old voucher gets double-spent
  // against the new deposit). This is exactly why channel boxes are never
  // deleted: total_claimed must survive a drain + re-fund cycle.
  results.push(
    await expectFalsy('drain_refund_replay_old_voucher', 'contract', async () => {
      const { session, config, cid } = await newChannel(world, 200_000n);
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 200_000n }, world.deployment);
      const sig1 = await sign(session, world.deployment, cid, 150_000n);
      await claimOne(world, world.summary.receiver, cid, 150_000n, sig1, 150_000n);
      // Cooperative refund drains the rest.
      await refund({
        appClient: world.appClient, sender: world.summary.receiver, channelId: cid,
        amount: 50_000n, asset: BigInt(world.summary.asset_id), payer: world.summary.payer,
      });
      // Re-fund the SAME channel (same config/salt -> same channelId; box is never deleted).
      await deposit({ algorand: world.algorand, appClient: world.appClient, config, amount: 200_000n }, world.deployment);
      // Replay the ORIGINAL voucher: total_claimed is already 150_000 on-chain,
      // so asking for the same 150_000 again must be a no-op, not a fresh claim.
      await claimOne(world, world.summary.receiver, cid, 150_000n, sig1, 150_000n);
      const state = await getChannel(world.algorand, world.appClient, cid);
      return state!.totalClaimed !== 150_000n; // true = replay double-spent (bad)
    }),
  );

  return results;
}
