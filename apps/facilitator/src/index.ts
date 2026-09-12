import express from 'express';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { refund } from '@turnstilealgo/escrow-client';
import { BatchSettlementAvmFacilitatorScheme } from '@turnstilealgo/x402-avm-batch';
import { setupChain } from './chain.js';

const PORT = Number(process.env.FACILITATOR_PORT ?? 4402);
const APP_ID = BigInt(process.env.X402_AVM_APP_ID ?? '0');
const RECEIVER_AUTHORIZER_ADDRESS = process.env.RECEIVER_AUTHORIZER_ADDRESS ?? '';

async function main() {
  if (!APP_ID) throw new Error('X402_AVM_APP_ID env var is required');
  if (!RECEIVER_AUTHORIZER_ADDRESS) throw new Error('RECEIVER_AUTHORIZER_ADDRESS env var is required');

  const chain = await setupChain({ appId: APP_ID });

  const scheme = new BatchSettlementAvmFacilitatorScheme({
    channelManager: chain.channelManager,
    receiverAuthorizerAddress: RECEIVER_AUTHORIZER_ADDRESS,
    executeRefund: async ({ channelId, amount, asset, payer }) =>
      refund({
        appClient: chain.appClient,
        sender: RECEIVER_AUTHORIZER_ADDRESS,
        channelId,
        amount,
        asset,
        payer,
      }),
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    console.log(`[facilitator] ${req.method} ${req.path}`);
    next();
  });

  app.post('/verify', async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
      const result = await scheme.verify(paymentPayload, paymentRequirements);
      res.json(result);
    } catch (err) {
      res.status(500).json({ isValid: false, invalidReason: 'internal_error', invalidMessage: String(err) });
    }
  });

  app.post('/settle', async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
      const result = await scheme.settle(paymentPayload, paymentRequirements);
      res.status(result.success ? 200 : 402).json(result);
    } catch (err) {
      res.status(500).json({ success: false, errorReason: 'internal_error', errorMessage: String(err), transaction: '', network: chain.network });
    }
  });

  app.get('/supported', (_req, res) => {
    res.json({
      kinds: [{ x402Version: 2, scheme: scheme.scheme, network: chain.network }],
      extensions: [],
      signers: { [scheme.caipFamily]: scheme.getSigners(chain.network) },
    });
  });

  app.listen(PORT, () => {
    console.log(`[facilitator] listening on :${PORT} (app ${APP_ID}, network ${chain.network})`);
  });
}

main().catch((err) => {
  console.error('[facilitator] fatal startup error', err);
  process.exit(1);
});
