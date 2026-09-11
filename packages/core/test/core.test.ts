import { describe, expect, it } from 'vitest';
import vectors from './vectors.json' with { type: 'json' };
import {
  channelId, decodeAddress, encodeAddress, fromHex, newSessionKey, signVoucher, toHex,
  verifyVoucher, voucherMessage, type ChannelConfig,
} from '../src/index.js';

const d = { genesisHash: fromHex(vectors.deployment.genesisHash), appId: BigInt(vectors.deployment.appId) };
const cfg: ChannelConfig = {
  ...vectors.config, asset: BigInt(vectors.config.asset), withdrawDelay: BigInt(vectors.config.withdrawDelay),
  salt: fromHex(vectors.config.salt),
};

describe('address', () => {
  it('round-trips', async () => {
    const { pk } = await newSessionKey();
    expect(toHex(decodeAddress(encodeAddress(pk)))).toBe(toHex(pk));
  });
  it('rejects bad checksum', () => {
    const a = cfg.payer; const bad = a.slice(0, -1) + (a.endsWith('A') ? 'B' : 'A');
    expect(() => decodeAddress(bad)).toThrow();
  });
});

describe('golden vectors', () => {
  it('channelId is stable', () => expect(toHex(channelId(cfg, d))).toBe(vectors.channelId));
  it.each(vectors.vouchers)('voucher $maxClaimable', async (v) => {
    const cid = fromHex(vectors.channelId); const max = BigInt(v.maxClaimable);
    expect(toHex(voucherMessage(d, cid, max))).toBe(v.message);
    expect(toHex(await signVoucher(fromHex(vectors.signerSeed), d, cid, max))).toBe(v.signature);
  });
});

describe('domain separation', () => {
  const cid = fromHex(vectors.channelId);
  const pk = decodeAddress(cfg.payerAuthorizer);
  it('valid voucher verifies', async () => {
    const sig = await signVoucher(fromHex(vectors.signerSeed), d, cid, 500n);
    expect(await verifyVoucher(pk, d, cid, 500n, sig)).toBe(true);
  });
  it('rejects other amount / channel / app / network / bitflip', async () => {
    const sig = await signVoucher(fromHex(vectors.signerSeed), d, cid, 500n);
    expect(await verifyVoucher(pk, d, cid, 501n, sig)).toBe(false);
    const other = cid.slice(); other[0]! ^= 1;
    expect(await verifyVoucher(pk, d, other, 500n, sig)).toBe(false);
    expect(await verifyVoucher(pk, { ...d, appId: d.appId + 1n }, cid, 500n, sig)).toBe(false);
    expect(await verifyVoucher(pk, { ...d, genesisHash: new Uint8Array(32) }, cid, 500n, sig)).toBe(false);
    const flipped = sig.slice(); flipped[10]! ^= 1;
    expect(await verifyVoucher(pk, d, cid, 500n, flipped)).toBe(false);
  });
  it('channelId binds every config field', () => {
    const base = toHex(channelId(cfg, d));
    const variants: ChannelConfig[] = [
      { ...cfg, payer: cfg.receiver }, { ...cfg, payerAuthorizer: cfg.payer }, { ...cfg, receiver: cfg.payer },
      { ...cfg, receiverAuthorizer: cfg.payer }, { ...cfg, asset: cfg.asset + 1n },
      { ...cfg, withdrawDelay: cfg.withdrawDelay + 1n }, { ...cfg, salt: new Uint8Array(32) },
    ];
    for (const v of variants) expect(toHex(channelId(v, d))).not.toBe(base);
    expect(toHex(channelId(cfg, { ...d, appId: 1n }))).not.toBe(base);
  });
  it('rejects out-of-range withdrawDelay', () => {
    expect(() => channelId({ ...cfg, withdrawDelay: 899n }, d)).toThrow(RangeError);
  });
});
