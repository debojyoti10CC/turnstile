import { sha256 } from '@noble/hashes/sha256';
import { decodeAddress } from './address.js';
import { concat, u64be } from './bytes.js';
import { CHANNEL_PREFIX, CONFIG_BYTES, WITHDRAW_DELAY_MAX, WITHDRAW_DELAY_MIN } from './constants.js';

/** Immutable channel config. Field order == ARC-4 struct order in contract.py. */
export interface ChannelConfig {
  payer: string;              // Algorand address, funds + refund destination
  payerAuthorizer: string;    // address form of the ed25519 voucher key (session key)
  receiver: string;           // payTo
  receiverAuthorizer: string; // account allowed to claim/refund
  asset: bigint;              // ASA id
  withdrawDelay: bigint;      // seconds, 900..2592000
  salt: Uint8Array;           // 32 bytes
}

export interface Deployment {
  genesisHash: Uint8Array; // full 32-byte genesis hash (NOT the CAIP-2 truncation)
  appId: bigint;
}

export function encodeConfig(c: ChannelConfig): Uint8Array {
  if (c.salt.length !== 32) throw new Error('salt must be 32 bytes');
  if (c.withdrawDelay < BigInt(WITHDRAW_DELAY_MIN) || c.withdrawDelay > BigInt(WITHDRAW_DELAY_MAX))
    throw new RangeError('withdrawDelay out of range');
  const out = concat(
    decodeAddress(c.payer), decodeAddress(c.payerAuthorizer),
    decodeAddress(c.receiver), decodeAddress(c.receiverAuthorizer),
    u64be(c.asset), u64be(c.withdrawDelay), c.salt,
  );
  if (out.length !== CONFIG_BYTES) throw new Error('config encoding size');
  return out;
}

/** channelId = sha256(CHANNEL_PREFIX || genesisHash || itob(appId) || arc4(config)). */
export function channelId(c: ChannelConfig, d: Deployment): Uint8Array {
  if (d.genesisHash.length !== 32) throw new Error('genesisHash must be 32 bytes');
  return sha256(concat(CHANNEL_PREFIX, d.genesisHash, u64be(d.appId), encodeConfig(c)));
}
