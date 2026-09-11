import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client';
import { unsettledBoxName } from './boxes.js';
import { SINGLE_INNER_TRANSFER_EXTRA_FEE } from './fees.js';

export interface SettleParams {
  appClient: AppClient;
  sender: string;
  receiver: string;
  asset: bigint;
}

/** Permissionless sweep of a receiver's claimed-but-unsettled balance for one asset. */
export async function settle(params: SettleParams): Promise<bigint> {
  const { appClient, sender, receiver, asset } = params;
  const result = await appClient.send.call({
    sender,
    method: 'settle',
    args: [receiver, asset],
    extraFee: SINGLE_INNER_TRANSFER_EXTRA_FEE,
    accountReferences: [receiver],
    assetReferences: [asset],
    boxReferences: [{ appId: appClient.appId, name: unsettledBoxName(receiver, asset) }],
    populateAppCallResources: false,
    coverAppCallInnerTransactionFees: false,
  });
  return result.return as bigint;
}
