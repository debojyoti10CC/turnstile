import { describe, expect, it } from 'vitest';
import {
  channelIdFromWire,
  encodeAddress,
  newSessionKey,
  signVoucher,
  type ChannelConfigWire,
  type Deployment,
} from '@turnstilealgo/core';
import { BatchSettlementChannelManager, type OnchainMirror } from '../src/server/channelManager.js';
import { InMemoryChannelStorage } from '../src/server/storage.js';

function randomAddress(): string {
  return encodeAddress(crypto.getRandomValues(new Uint8Array(32)));
}

const deployment: Deployment = {
  genesisHash: crypto.getRandomValues(new Uint8Array(32)),
  appId: 1234n,
};

async function makeConfig(): Promise<{ config: ChannelConfigWire; sk: Uint8Array }> {
  const session = await newSessionKey();
  const config: ChannelConfigWire = {
    payer: randomAddress(),
    payerAuthorizer: encodeAddress(session.pk),
    receiver: randomAddress(),
    receiverAuthorizer: randomAddress(),
    asset: '1001',
    withdrawDelay: 900,
    salt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
  };
  return { config, sk: session.sk };
}

function manager(balance: bigint, overrides?: Partial<OnchainMirror>) {
  const storage = new InMemoryChannelStorage();
  const mgr = new BatchSettlementChannelManager({
    storage,
    deployment,
    fetchOnchain: async () => ({ balance, totalClaimed: 0n, withdrawRequestedAt: 0, ...overrides }),
  });
  return { storage, mgr };
}

describe('I4_voucher_scoped_to_channel', () => {
  it('rejects a voucher whose channelId does not match the claimed config', async () => {
    const { config, sk } = await makeConfig();
    const { mgr } = manager(1_000_000n);
    const sig = await signVoucher(sk, deployment, crypto.getRandomValues(new Uint8Array(32)), 100n);
    const result = await mgr.verifyVoucher(config, {
      channelId: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      maxClaimableAmount: '100',
      signature: Buffer.from(sig).toString('base64'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_batch_settlement_avm_channel_id_mismatch');
  });
});

describe('I9_never_over_claim', () => {
  it('rejects a voucher whose signature does not verify', async () => {
    const { config } = await makeConfig();
    const { mgr } = manager(1_000_000n);
    const cid = channelIdFromWire(config, deployment);
    const result = await mgr.verifyVoucher(config, {
      channelId: Buffer.from(cid).toString('base64'),
      maxClaimableAmount: '100',
      signature: Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_batch_settlement_avm_voucher_signature');
  });

  it('rejects a voucher whose maxClaimable exceeds the mirrored on-chain balance', async () => {
    const { config, sk } = await makeConfig();
    const { mgr } = manager(1_000n); // small balance
    const cid = channelIdFromWire(config, deployment);
    const sig = await signVoucher(sk, deployment, cid, 10_000n); // max > balance
    const result = await mgr.verifyVoucher(config, {
      channelId: Buffer.from(cid).toString('base64'),
      maxClaimableAmount: '10000',
      signature: Buffer.from(sig).toString('base64'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_batch_settlement_avm_cumulative_exceeds_balance');
  });

  it('never lets charge() push chargedCumulativeAmount past the voucher-signed max', async () => {
    const { config, sk } = await makeConfig();
    const { mgr } = manager(1_000_000n);
    const cid = channelIdFromWire(config, deployment);
    const cidB64 = Buffer.from(cid).toString('base64');
    const signedMax = 1_000n;
    const sig = await signVoucher(sk, deployment, cid, signedMax);
    const voucher = { channelId: cidB64, maxClaimableAmount: signedMax.toString(), signature: Buffer.from(sig).toString('base64') };

    const verified = await mgr.verifyVoucher(config, voucher);
    expect(verified.ok).toBe(true);

    const first = await mgr.charge(cidB64, 600n, voucher);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.channel.chargedCumulativeAmount).toBe('600');

    const overCharge = await mgr.charge(cidB64, 500n, voucher); // 600+500=1100 > 1000 signed max
    expect(overCharge.ok).toBe(false);
    if (!overCharge.ok) expect(overCharge.error).toBe('invalid_batch_settlement_avm_charge_exceeds_signed_cumulative');

    const withinBudget = await mgr.charge(cidB64, 400n, voucher); // 600+400=1000, exactly at cap
    expect(withinBudget.ok).toBe(true);
    if (withinBudget.ok) expect(withinBudget.channel.chargedCumulativeAmount).toBe('1000');
  });
});

describe('I12_per_channel_serialization', () => {
  it('K concurrent charges on one channel: charged == sum(actual), no double-accept beyond the signed cap', async () => {
    const { config, sk } = await makeConfig();
    const { mgr, storage } = manager(1_000_000n);
    const cid = channelIdFromWire(config, deployment);
    const cidB64 = Buffer.from(cid).toString('base64');
    const signedMax = 500n; // enough for exactly 5 charges of 100 each
    const sig = await signVoucher(sk, deployment, cid, signedMax);
    const voucher = { channelId: cidB64, maxClaimableAmount: signedMax.toString(), signature: Buffer.from(sig).toString('base64') };
    await mgr.verifyVoucher(config, voucher);

    const attempts = 50;
    const results = await Promise.all(
      Array.from({ length: attempts }, () => mgr.charge(cidB64, 100n, voucher)),
    );
    const succeeded = results.filter((r) => r.ok).length;
    expect(succeeded).toBe(5); // exactly signedMax / 100

    const final = await storage.get(cidB64);
    expect(final?.chargedCumulativeAmount).toBe('500');
  });
});
