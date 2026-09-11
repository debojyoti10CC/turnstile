import { decodeAddress } from '@turnstile/core';

/** Box key for a channel: `"c" + channelId` (32 bytes). Matches BoxMap(key_prefix=b"c"). */
export function channelBoxName(channelId: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 32);
  out[0] = 0x63; // 'c'
  out.set(channelId, 1);
  return out;
}

/** Box key for a receiver+asset unsettled balance: `"u" + receiver(32) + itob(assetId)(8)`. */
export function unsettledBoxName(receiver: string, assetId: bigint): Uint8Array {
  const out = new Uint8Array(1 + 32 + 8);
  out[0] = 0x75; // 'u'
  out.set(decodeAddress(receiver), 1);
  new DataView(out.buffer).setBigUint64(33, assetId, false);
  return out;
}
