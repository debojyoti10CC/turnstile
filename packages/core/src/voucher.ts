import * as ed from '@noble/ed25519';
import { concat, u64be } from './bytes.js';
import { VOUCHER_MESSAGE_BYTES, VOUCHER_PREFIX } from './constants.js';
import type { Deployment } from './config.js';

/** msg = VOUCHER_PREFIX || genesisHash || itob(appId) || channelId || itob(maxClaimable). */
export function voucherMessage(d: Deployment, channelId: Uint8Array, maxClaimable: bigint): Uint8Array {
  if (channelId.length !== 32) throw new Error('channelId must be 32 bytes');
  const m = concat(VOUCHER_PREFIX, d.genesisHash, u64be(d.appId), channelId, u64be(maxClaimable));
  if (m.length !== VOUCHER_MESSAGE_BYTES) throw new Error('voucher message size');
  return m;
}

/** Raw ed25519 (verified on-chain with ed25519verify_bare). sk = 32-byte seed. */
export async function signVoucher(sk: Uint8Array, d: Deployment, channelId: Uint8Array, maxClaimable: bigint) {
  return ed.signAsync(voucherMessage(d, channelId, maxClaimable), sk);
}

export async function verifyVoucher(
  pk: Uint8Array, d: Deployment, channelId: Uint8Array, maxClaimable: bigint, sig: Uint8Array,
): Promise<boolean> {
  if (sig.length !== 64 || pk.length !== 32) return false;
  try { return await ed.verifyAsync(sig, voucherMessage(d, channelId, maxClaimable), pk); }
  catch { return false; }
}

export const newSessionKey = async () => {
  const sk = ed.utils.randomPrivateKey();
  return { sk, pk: await ed.getPublicKeyAsync(sk) };
};
export const publicKeyOf = (sk: Uint8Array) => ed.getPublicKeyAsync(sk);
