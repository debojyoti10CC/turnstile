import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client';
import { channelBoxName } from './boxes.js';
import { SINGLE_INNER_TRANSFER_EXTRA_FEE } from './fees.js';

export interface InitiateWithdrawParams {
  appClient: AppClient;
  /** Must be config.payer or config.payerAuthorizer. */
  sender: string;
  channelId: Uint8Array;
  amount: bigint;
}

/** Starts the withdraw-delay clock; returns the unix timestamp it becomes eligible at. */
export async function initiateWithdraw(params: InitiateWithdrawParams): Promise<bigint> {
  const { appClient, sender, channelId, amount } = params;
  const result = await appClient.send.call({
    sender,
    method: 'initiate_withdraw',
    args: [channelId, amount],
    boxReferences: [{ appId: appClient.appId, name: channelBoxName(channelId) }],
    populateAppCallResources: false,
  });
  return result.return as bigint;
}

export interface FinalizeWithdrawParams {
  appClient: AppClient;
  /** Must be config.payer or config.payerAuthorizer. */
  sender: string;
  channelId: Uint8Array;
  asset: bigint;
  /** config.payer -- required as an explicit account reference only when
   * `sender` is the payerAuthorizer (a different address); if sender IS the
   * payer it's already available as Txn.sender. */
  payer?: string;
}

/** Sweeps the requested amount back to the payer once the withdraw delay has elapsed. */
export async function finalizeWithdraw(params: FinalizeWithdrawParams): Promise<bigint> {
  const { appClient, sender, channelId, asset, payer } = params;
  const result = await appClient.send.call({
    sender,
    method: 'finalize_withdraw',
    args: [channelId],
    extraFee: SINGLE_INNER_TRANSFER_EXTRA_FEE,
    accountReferences: payer && payer !== sender ? [payer] : undefined,
    assetReferences: [asset],
    boxReferences: [{ appId: appClient.appId, name: channelBoxName(channelId) }],
    populateAppCallResources: false,
    coverAppCallInnerTransactionFees: false,
  });
  return result.return as bigint;
}
