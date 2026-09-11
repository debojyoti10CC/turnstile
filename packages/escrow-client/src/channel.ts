import type { AlgorandClient } from '@algorandfoundation/algokit-utils';
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client';
import { encodeAddress, type ChannelConfig } from '@turnstile/core';
import { channelBoxName, unsettledBoxName } from './boxes.js';

export interface ChannelState {
  config: ChannelConfig;
  balance: bigint;
  totalClaimed: bigint;
  withdrawRequestedAt: bigint;
  withdrawAmount: bigint;
}

function readU64(b: Uint8Array, offset: number): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(offset, false);
}

/**
 * Decodes a 208-byte ChannelState box value (ARC-4 static struct -- every
 * field is fixed-width, so this is a plain concatenation, no ARC-4
 * head/tail table to resolve). Field order and sizes mirror contract.py's
 * `ChannelConfig`/`ChannelState` structs exactly.
 */
export function decodeChannelState(box: Uint8Array): ChannelState {
  if (box.length !== 208) throw new Error(`expected a 208-byte ChannelState box, got ${box.length}`);
  const addr = (o: number) => encodeAddress(box.slice(o, o + 32));
  const config: ChannelConfig = {
    payer: addr(0),
    payerAuthorizer: addr(32),
    receiver: addr(64),
    receiverAuthorizer: addr(96),
    asset: readU64(box, 128),
    withdrawDelay: readU64(box, 136),
    salt: box.slice(144, 176),
  };
  return {
    config,
    balance: readU64(box, 176),
    totalClaimed: readU64(box, 184),
    withdrawRequestedAt: readU64(box, 192),
    withdrawAmount: readU64(box, 200),
  };
}

/**
 * Reads a channel's full on-chain state (including its immutable config)
 * directly from its box via algod. Returns `undefined` if the channel does
 * not exist.
 */
export async function getChannel(
  algorand: AlgorandClient,
  appClient: AppClient,
  channelId: Uint8Array,
): Promise<ChannelState | undefined> {
  try {
    const box = await algorand.app.getBoxValue(appClient.appId, channelBoxName(channelId));
    return decodeChannelState(box);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/404|not found|no value/i.test(message)) return undefined;
    throw err;
  }
}

export interface ChannelView {
  balance: bigint;
  totalClaimed: bigint;
  withdrawRequestedAt: bigint;
  withdrawAmount: bigint;
}

/**
 * Fallback for callers without direct box-read access (e.g. an
 * indexer/API-gateway-only client): the `get_channel` readonly ABI method.
 * Narrower than `getChannel` -- it omits `config`, since the contract's view
 * struct doesn't return it.
 */
export async function getChannelView(
  appClient: AppClient,
  sender: string,
  channelId: Uint8Array,
): Promise<ChannelView> {
  const res = await appClient.send.call({
    sender,
    method: 'get_channel',
    args: [channelId],
    boxReferences: [{ appId: appClient.appId, name: channelBoxName(channelId) }],
    populateAppCallResources: false,
  });
  return res.return as unknown as ChannelView;
}

export async function getUnsettled(
  algorand: AlgorandClient,
  appClient: AppClient,
  receiver: string,
  asset: bigint,
): Promise<bigint> {
  const boxName = unsettledBoxName(receiver, asset);
  try {
    const box = await algorand.app.getBoxValue(appClient.appId, boxName);
    return new DataView(box.buffer, box.byteOffset, box.byteLength).getBigUint64(0, false);
  } catch {
    return 0n;
  }
}
