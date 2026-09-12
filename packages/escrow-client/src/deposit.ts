import type { AlgorandClient } from '@algorandfoundation/algokit-utils';
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client';
import { microAlgos } from '@algorandfoundation/algokit-utils';
import { channelId, type ChannelConfig, type Deployment } from '@turnstilealgo/core';
import { configToTuple } from './client.js';
import { channelBoxName, unsettledBoxName } from './boxes.js';

export interface DepositParams {
  algorand: AlgorandClient;
  appClient: AppClient;
  config: ChannelConfig;
  amount: bigint;
  /** Transaction signer; defaults to config.payer. The axfer MUST be signed by config.payer regardless. */
  feePayer?: string;
}

/**
 * Reads `open_mbr` and submits the deposit group
 * `[axfer(payer->app), pay(mbr->app), appl deposit(config, axfer, pay)]`.
 *
 * Box refs are supplied explicitly rather than relying on simulate-based
 * auto-population -- see docs/DECISIONS.md for why that's unreliable for
 * ABI method calls on this algod/algokit-utils pairing.
 */
export async function deposit(params: DepositParams, deployment: Deployment): Promise<Uint8Array> {
  const { algorand, appClient, config, amount } = params;
  const appAddress = appClient.appAddress.toString();
  const cfgTuple = configToTuple(config);
  // Computed locally (not read back from the contract) so it's available up
  // front for box references -- this must stay byte-for-byte identical to
  // the on-chain `channel_id()` view method, which the offline TS<->contract
  // signature-parity tests in contracts/tests/test_vectors.py already check.
  const cid = channelId(config, deployment);
  const boxRefs = [
    { appId: appClient.appId, name: channelBoxName(cid) },
    { appId: appClient.appId, name: unsettledBoxName(config.receiver, config.asset) },
  ];

  const mbrNeeded = (await appClient.send.call({
    method: 'open_mbr',
    args: [cfgTuple],
    sender: params.feePayer ?? config.payer,
    boxReferences: boxRefs,
    populateAppCallResources: false,
  })).return as bigint;

  const xfer = await algorand.createTransaction.assetTransfer({
    sender: config.payer,
    receiver: appAddress,
    assetId: config.asset,
    amount,
  });
  const mbr = await algorand.createTransaction.payment({
    sender: params.feePayer ?? config.payer,
    receiver: appAddress,
    amount: microAlgos(mbrNeeded),
  });

  const result = await appClient.send.call({
    sender: params.feePayer ?? config.payer,
    method: 'deposit',
    args: [cfgTuple, xfer, mbr],
    boxReferences: boxRefs,
    populateAppCallResources: false,
    coverAppCallInnerTransactionFees: false,
  });
  return result.return as Uint8Array;
}
