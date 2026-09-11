import {
  encodeAddress,
  newSessionKey,
  signVoucher,
  toB64,
  channelIdFromWire as computeChannelId,
  type ChannelConfigWire,
  type Deployment,
} from '@turnstile/core';
import { BatchSettlementChannelManager, InMemoryChannelStorage, type OnchainMirror } from '@turnstile/x402-avm-batch';
import { BatchSettlementAvmClientScheme, InMemoryClientChannelStorage } from '@turnstile/x402-avm-batch';
import { expectFalsy, type AttackResult } from './report.js';

const deployment: Deployment = { genesisHash: crypto.getRandomValues(new Uint8Array(32)), appId: 777n };

function randomAddress(): string {
  return encodeAddress(crypto.getRandomValues(new Uint8Array(32)));
}

async function makeConfig(): Promise<{ config: ChannelConfigWire; sk: Uint8Array }> {
  const session = await newSessionKey();
  const config: ChannelConfigWire = {
    payer: randomAddress(),
    payerAuthorizer: encodeAddress(session.pk),
    receiver: randomAddress(),
    receiverAuthorizer: randomAddress(),
    asset: '9001',
    withdrawDelay: 900,
    salt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
  };
  return { config, sk: session.sk };
}

function manager(balance: bigint, overrides?: Partial<OnchainMirror>, now?: () => number) {
  const storage = new InMemoryChannelStorage();
  const mgr = new BatchSettlementChannelManager({
    storage,
    deployment,
    fetchOnchain: async () => ({ balance, totalClaimed: 0n, withdrawRequestedAt: 0, ...overrides }),
    now,
  });
  return { storage, mgr };
}

export async function runServerAttacks(): Promise<AttackResult[]> {
  const results: AttackResult[] = [];

  // --- 1. Stale voucher: below already-charged cumulative ---
  results.push(
    await expectFalsy('server_stale_voucher_below_charged', 'server', async () => {
      const { config, sk } = await makeConfig();
      const { mgr } = manager(1_000_000n);
      const cid = computeChannelId(config, deployment);
      const cidB64 = toB64(cid);
      const highSig = await signVoucher(sk, deployment, cid, 1000n);
      const highVoucher = { channelId: cidB64, maxClaimableAmount: '1000', signature: toB64(highSig) };
      const v1 = await mgr.verifyVoucher(config, highVoucher);
      if (!v1.ok) throw new Error('setup failed: ' + v1.message);
      await mgr.charge(cidB64, 1000n, highVoucher);

      const staleSig = await signVoucher(sk, deployment, cid, 500n);
      const staleVoucher = { channelId: cidB64, maxClaimableAmount: '500', signature: toB64(staleSig) };
      const v2 = await mgr.verifyVoucher(config, staleVoucher);
      return v2.ok; // true = attack accepted (bad)
    }),
  );

  // --- 2. Skipped increment: charge more than the voucher's signed headroom allows ---
  results.push(
    await expectFalsy('server_charge_exceeds_signed_headroom', 'server', async () => {
      const { config, sk } = await makeConfig();
      const { mgr } = manager(1_000_000n);
      const cid = computeChannelId(config, deployment);
      const cidB64 = toB64(cid);
      const sig = await signVoucher(sk, deployment, cid, 100n);
      const voucher = { channelId: cidB64, maxClaimableAmount: '100', signature: toB64(sig) };
      await mgr.verifyVoucher(config, voucher);
      // Try to charge 150 against a voucher only authorizing 100.
      const result = await mgr.charge(cidB64, 150n, voucher);
      return result.ok; // true = attack accepted (bad)
    }),
  );

  // --- 3. Voucher above mirrored on-chain balance ---
  results.push(
    await expectFalsy('server_voucher_above_mirrored_balance', 'server', async () => {
      const { config, sk } = await makeConfig();
      const { mgr } = manager(1_000n); // small mirrored balance
      const cid = computeChannelId(config, deployment);
      const sig = await signVoucher(sk, deployment, cid, 50_000n);
      const voucher = { channelId: toB64(cid), maxClaimableAmount: '50000', signature: toB64(sig) };
      const result = await mgr.verifyVoucher(config, voucher);
      return result.ok; // true = attack accepted (bad)
    }),
  );

  // --- 4. Voucher submitted once a pending withdrawal is within its safety margin ---
  results.push(
    await expectFalsy('server_voucher_during_withdraw_safety_margin', 'server', async () => {
      const { config, sk } = await makeConfig();
      const nowSec = 1_800_000_000;
      // Withdraw was requested 850s ago; delay is 900s; margin is default 60s
      // -> finalizable at +900, margin kicks in at +840, so "now" is already past it.
      const withdrawRequestedAt = nowSec - 850;
      const { mgr } = manager(1_000_000n, { withdrawRequestedAt }, () => nowSec);
      const cid = computeChannelId(config, deployment);
      const sig = await signVoucher(sk, deployment, cid, 100n);
      const voucher = { channelId: toB64(cid), maxClaimableAmount: '100', signature: toB64(sig) };
      const result = await mgr.verifyVoucher(config, voucher);
      return result.ok; // true = attack accepted (bad)
    }),
  );

  // --- 5. Forged corrective-402 state: client must verify the signature itself before adopting it (I11) ---
  results.push(
    await expectFalsy('server_forged_corrective_402_state', 'server', async () => {
      const clientStorage = new InMemoryClientChannelStorage();
      const client = new BatchSettlementAvmClientScheme({
        payerAddress: randomAddress(),
        deployment,
        buildDepositGroup: async () => ({ paymentGroup: [] }),
        storage: clientStorage,
      });

      const session = await newSessionKey();
      const configWire: ChannelConfigWire = {
        payer: randomAddress(),
        payerAuthorizer: encodeAddress(session.pk),
        receiver: randomAddress(),
        receiverAuthorizer: randomAddress(),
        asset: '9001',
        withdrawDelay: 900,
        salt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      };
      const cid = computeChannelId(configWire, deployment);
      const cidB64 = toB64(cid);
      await clientStorage.set({
        channelId: cidB64,
        channelConfig: configWire,
        sessionKey: session.sk,
        chargedCumulativeAmount: '0',
        signedMaxClaimable: '0',
        signature: '',
        confirmed: false,
      });

      // A malicious server/facilitator claims a huge chargedCumulativeAmount
      // backed by a signature it made up (it cannot actually forge the
      // client's ed25519 signature -- that's the point).
      const forgedSignature = toB64(crypto.getRandomValues(new Uint8Array(64)));
      const fakeVoucher = { channelId: cidB64, maxClaimableAmount: '999999', signature: forgedSignature };

      const paymentPayload = {
        x402Version: 2,
        accepted: { scheme: 'batch-settlement', network: 'algorand:fake', asset: '9001', amount: '1', payTo: configWire.receiver, maxTimeoutSeconds: 60, extra: {} },
        payload: { type: 'voucher', channelConfig: configWire, voucher: { channelId: cidB64, maxClaimableAmount: '1', signature: '' } },
      };

      await client.schemeHooks.onPaymentResponse?.({
        paymentPayload: paymentPayload as never,
        requirements: paymentPayload.accepted as never,
        error: new Error('invalid_batch_settlement_avm_charge_exceeds_signed_cumulative'),
        paymentRequired: {
          x402Version: 2,
          resource: { url: 'test://' },
          accepts: [
            {
              ...paymentPayload.accepted,
              extra: {
                channelState: { channelId: cidB64, balance: '1000000', totalClaimed: '0', withdrawRequestedAt: 0, chargedCumulativeAmount: '999999' },
                voucherState: { signedMaxClaimable: fakeVoucher.maxClaimableAmount, signature: fakeVoucher.signature },
              },
            },
          ],
        } as never,
      });

      const record = await clientStorage.get(cidB64);
      return record?.chargedCumulativeAmount === '999999'; // true = attack accepted (bad)
    }),
  );

  return results;
}
