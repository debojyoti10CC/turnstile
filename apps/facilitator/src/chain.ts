import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client';
import { getAppClient, getChannel as escrowGetChannel } from '@turnstile/escrow-client';
import { caip2FromGenesisHash, type Deployment } from '@turnstile/core';
import { BatchSettlementChannelManager, type OnchainMirror } from '@turnstile/x402-avm-batch';
import { InMemoryChannelStorage } from '@turnstile/x402-avm-batch';

export interface FacilitatorChainConfig {
  appId: bigint;
  receiverAuthorizerMnemonic?: string;
}

export async function setupChain(config: FacilitatorChainConfig) {
  const algorand =
    process.env.NETWORK === 'mainnet'
      ? AlgorandClient.mainNet()
      : process.env.NETWORK === 'testnet'
        ? AlgorandClient.testNet()
        : AlgorandClient.defaultLocalNet();
  const appClient: AppClient = getAppClient(algorand, config.appId);

  const params = await algorand.client.algod.getTransactionParams().do();
  const deployment: Deployment = { genesisHash: params.genesisHash, appId: config.appId };
  const network = caip2FromGenesisHash(params.genesisHash);

  const fetchOnchain = async (channelId: Uint8Array): Promise<OnchainMirror | undefined> => {
    const state = await escrowGetChannel(algorand, appClient, channelId);
    if (!state) return undefined;
    return { balance: state.balance, totalClaimed: state.totalClaimed, withdrawRequestedAt: Number(state.withdrawRequestedAt) };
  };

  const storage = new InMemoryChannelStorage();
  const channelManager = new BatchSettlementChannelManager({ storage, deployment, fetchOnchain });

  return { algorand, appClient, deployment, network, storage, channelManager };
}
