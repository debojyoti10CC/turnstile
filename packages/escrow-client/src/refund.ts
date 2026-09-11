import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client';
import { channelBoxName } from './boxes.js';
import { SINGLE_INNER_TRANSFER_EXTRA_FEE } from './fees.js';

export interface RefundParams {
  appClient: AppClient;
  /** Must be config.receiver or config.receiverAuthorizer. */
  sender: string;
  channelId: Uint8Array;
  amount: bigint;
  asset: bigint;
  /** config.payer -- the refund's destination. Not an ABI arg, so it must be
   * supplied as an explicit account reference or the inner AssetTransfer to
   * it fails with "unavailable Account" (same issue settle() has for its
   * receiver arg; see docs/DECISIONS.md). */
  payer: string;
}

/** Cooperative refund by the receiver side, capped to unclaimed escrow on-chain. */
export async function refund(params: RefundParams): Promise<bigint> {
  const { appClient, sender, channelId, amount, asset, payer } = params;
  const result = await appClient.send.call({
    sender,
    method: 'refund',
    args: [channelId, amount],
    extraFee: SINGLE_INNER_TRANSFER_EXTRA_FEE,
    accountReferences: [payer],
    assetReferences: [asset],
    boxReferences: [{ appId: appClient.appId, name: channelBoxName(channelId) }],
    populateAppCallResources: false,
    coverAppCallInnerTransactionFees: false,
  });
  return result.return as bigint;
}
