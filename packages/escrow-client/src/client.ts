import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client';
import arc56 from './generated/X402BatchSettlement.arc56.json' with { type: 'json' };
import type { ChannelConfig } from '@turnstilealgo/core';

/** ABI tuple arg order matches ChannelConfig struct field order in contract.py. */
export type ConfigTuple = [string, string, string, string, bigint, bigint, Uint8Array];

export function configToTuple(c: ChannelConfig): ConfigTuple {
  return [c.payer, c.payerAuthorizer, c.receiver, c.receiverAuthorizer, c.asset, c.withdrawDelay, c.salt];
}

export function getAppClient(algorand: AlgorandClient, appId: bigint): AppClient {
  return algorand.client.getAppClientById({
    appId,
    appSpec: JSON.stringify(arc56),
  });
}
