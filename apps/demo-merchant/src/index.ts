import express from 'express';
import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { x402ResourceServer } from '@x402/core/server';
import { paymentMiddleware, setSettlementOverrides } from '@x402/express';
import type { Network } from '@x402/core/types';
import { caip2FromGenesisHash, type Deployment } from '@turnstile/core';
import { getAppClient, getChannel as escrowGetChannel } from '@turnstile/escrow-client';
import { BatchSettlementAvmScheme, type OnchainMirror } from '@turnstile/x402-avm-batch';

const PORT = Number(process.env.MERCHANT_PORT ?? 4403);
const APP_ID = BigInt(process.env.X402_AVM_APP_ID ?? '0');
const ASSET_ID = process.env.X402_AVM_ASSET_ID ?? '0';
const RECEIVER_ADDRESS = process.env.RECEIVER_ADDRESS ?? '';
const RECEIVER_AUTHORIZER_ADDRESS = process.env.RECEIVER_AUTHORIZER_ADDRESS ?? RECEIVER_ADDRESS;
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'http://localhost:4402';
const WITHDRAW_DELAY = Number(process.env.WITHDRAW_DELAY ?? 900);

async function main() {
  if (!APP_ID || ASSET_ID === '0' || !RECEIVER_ADDRESS) {
    throw new Error('X402_AVM_APP_ID, X402_AVM_ASSET_ID, RECEIVER_ADDRESS env vars are required');
  }

  const algorand = process.env.NETWORK === 'testnet' ? AlgorandClient.testNet() : AlgorandClient.defaultLocalNet();
  const appClient = getAppClient(algorand, APP_ID);
  const params = await algorand.client.algod.getTransactionParams().do();
  const deployment: Deployment = { genesisHash: params.genesisHash, appId: APP_ID };
  const network = caip2FromGenesisHash(params.genesisHash) as Network;

  const fetchOnchain = async (channelId: Uint8Array): Promise<OnchainMirror | undefined> => {
    const state = await escrowGetChannel(algorand, appClient, channelId);
    if (!state) return undefined;
    return { balance: state.balance, totalClaimed: state.totalClaimed, withdrawRequestedAt: Number(state.withdrawRequestedAt) };
  };

  const scheme = new BatchSettlementAvmScheme({
    deployment,
    appId: APP_ID,
    receiverAuthorizer: RECEIVER_AUTHORIZER_ADDRESS,
    withdrawDelay: WITHDRAW_DELAY,
    fetchOnchain,
    network,
  });

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator).register(network, scheme);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    console.log(`[demo-merchant] ${req.method} ${req.path} paid=${Boolean(req.headers['x-payment'] ?? req.headers['payment-signature'])}`);
    next();
  });

  app.use(
    paymentMiddleware(
      {
        '/v1/data': {
          accepts: { scheme: 'batch-settlement', payTo: RECEIVER_ADDRESS, network, price: { amount: '1000', asset: ASSET_ID } },
        },
        '/v1/infer': {
          accepts: {
            scheme: 'batch-settlement',
            payTo: RECEIVER_ADDRESS,
            network,
            // Pre-authorized ceiling per call (max prompt length 20 chars * 50 = 1000,
            // plus headroom); the handler charges actual usage via setSettlementOverrides.
            // Every voucher reserves this full ceiling against the channel balance
            // regardless of actual usage (the client can't know the actual in advance),
            // so a tight ceiling matters for how many calls one deposit can fund.
            price: { amount: '1200', asset: ASSET_ID },
          },
        },
      },
      resourceServer,
    ),
  );

  // Debug-only: exposes the merchant's local channel ledger for the demo's
  // end-to-end consistency check (agent state vs merchant DB vs on-chain).
  app.get('/debug/channel', async (req, res) => {
    const channelId = typeof req.query.id === 'string' ? req.query.id : '';
    const channel = await scheme.getStorage().get(channelId);
    res.json(channel ?? null);
  });

  app.get('/v1/data', (_req, res) => {
    res.json({ data: 'flat-priced response', servedAt: new Date().toISOString() });
  });

  app.post('/v1/infer', (req, res) => {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
    // Stub "model": one atomic unit per character, floored at 1.
    const outputTokens = Math.max(1, prompt.length);
    const pricePerToken = 50n;
    const actual = (BigInt(outputTokens) * pricePerToken).toString();
    setSettlementOverrides(res, { amount: actual });
    res.json({ output: `stub-inference(${outputTokens} tokens)`, chargedAtomicUnits: actual });
  });

  app.listen(PORT, () => {
    console.log(`[demo-merchant] listening on :${PORT} (app ${APP_ID}, network ${network})`);
  });
}

main().catch((err) => {
  console.error('[demo-merchant] fatal startup error', err);
  process.exit(1);
});
