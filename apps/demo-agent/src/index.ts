import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import algosdk from 'algosdk';
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import type { Network } from '@x402/core/types';
import { caip2FromGenesisHash, type ChannelConfig, type Deployment } from '@turnstilealgo/core';
import { deposit, getAppClient, getChannel } from '@turnstilealgo/escrow-client';
import { BatchSettlementAvmClientScheme, type BuildDepositGroup } from '@turnstilealgo/x402-avm-batch';

const MERCHANT_URL = process.env.MERCHANT_URL ?? 'http://localhost:4403';
const APP_ID = BigInt(process.env.X402_AVM_APP_ID ?? '0');
const PAYER_ADDRESS = process.env.PAYER_ADDRESS ?? '';
const PAYER_PRIVATE_KEY_B64 = process.env.PAYER_PRIVATE_KEY ?? '';

function parseArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

async function main() {
  if (!APP_ID || !PAYER_ADDRESS || !PAYER_PRIVATE_KEY_B64) {
    throw new Error('X402_AVM_APP_ID, PAYER_ADDRESS, PAYER_PRIVATE_KEY env vars are required');
  }
  const mode = parseArg('mode', 'batch');
  const calls = Number(parseArg('calls', '10'));
  const concurrency = Number(parseArg('concurrency', '1'));
  if (mode !== 'batch') throw new Error(`mode "${mode}" not supported by this demo (only "batch")`);

  const algorand =
    process.env.NETWORK === 'mainnet'
      ? AlgorandClient.mainNet()
      : process.env.NETWORK === 'testnet'
        ? AlgorandClient.testNet()
        : AlgorandClient.defaultLocalNet();
  const payerAccount: algosdk.Account = { addr: algosdk.Address.fromString(PAYER_ADDRESS), sk: Buffer.from(PAYER_PRIVATE_KEY_B64, 'base64') };
  algorand.account.setSigner(PAYER_ADDRESS, algosdk.makeBasicAccountTransactionSigner(payerAccount));

  const params = await algorand.client.algod.getTransactionParams().do();
  const deployment: Deployment = { genesisHash: params.genesisHash, appId: APP_ID };
  const network = caip2FromGenesisHash(params.genesisHash) as Network;

  // Per docs/DECISIONS.md: the agent submits its own deposit directly with
  // its own keys, rather than handing an unsigned group to the facilitator.
  const appClient = getAppClient(algorand, APP_ID);
  const buildDepositGroup: BuildDepositGroup = async ({ config, amount }: { config: ChannelConfig; amount: bigint }) => {
    const channelId = await deposit({ algorand, appClient, config, amount }, deployment);
    return { paymentGroup: [Buffer.from(channelId).toString('base64')] };
  };

  // Default depositMultiplier (10x the per-call ceiling) is sized for a
  // handful of calls; a 200-call dynamic-pricing run needs real headroom.
  const clientScheme = new BatchSettlementAvmClientScheme({
    payerAddress: PAYER_ADDRESS,
    deployment,
    buildDepositGroup,
    // Sized for a 200-call run: each voucher reserves the full per-call
    // ceiling (not the dynamic actual) against channel balance, so total
    // reservation headroom needed is ceiling * calls, not actual * calls.
    depositMultiplier: 250,
  });
  // Our test ASA isn't in x402Client's default-asset allowlist; this is a
  // LocalNet demo with a throwaway mock USDC, not a production spend policy.
  const x402client = new x402Client().register(network, clientScheme).setSpendControls(false);
  const fetchWithPay = wrapFetchWithPayment(fetch, x402client);

  console.log(`[demo-agent] mode=${mode} calls=${calls} concurrency=${concurrency} network=${network}`);

  let succeeded = 0;
  let failed = 0;
  const startedAt = Date.now();

  async function makeCall(i: number) {
    try {
      const prompt = 'x'.repeat(1 + (i % 20)); // varying length -> varying dynamic charge
      const res = await fetchWithPay(`${MERCHANT_URL}/v1/infer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (res.ok) {
        succeeded++;
      } else {
        failed++;
        const paymentRequiredHeader = res.headers.get('payment-required');
        let detail = '';
        if (paymentRequiredHeader) {
          try {
            detail = JSON.stringify(JSON.parse(Buffer.from(paymentRequiredHeader, 'base64').toString()));
          } catch {
            detail = paymentRequiredHeader;
          }
        }
        console.error(`[demo-agent] call ${i} failed: ${res.status} body=${await res.text()} paymentRequired=${detail}`);
      }
    } catch (err) {
      failed++;
      console.error(`[demo-agent] call ${i} threw:`, err);
    }
  }

  let next = 0;
  async function worker() {
    while (next < calls) {
      const i = next++;
      await makeCall(i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  const elapsedMs = Date.now() - startedAt;
  console.log(`[demo-agent] done: ${succeeded} succeeded, ${failed} failed, ${elapsedMs}ms total`);

  if (succeeded > 0) {
    const receiverAddress = process.env.RECEIVER_ADDRESS ?? '';
    const assetId = process.env.X402_AVM_ASSET_ID ?? '';
    const record = await clientScheme.getStorage().findByDestination(receiverAddress, assetId);
    if (record) {
      const onchain = await getChannel(algorand, appClient, Buffer.from(record.channelId, 'base64'));
      console.log('[demo-agent] channelId:', record.channelId);
      console.log('[demo-agent] agent-local chargedCumulativeAmount:', record.chargedCumulativeAmount);
      console.log('[demo-agent] on-chain balance/totalClaimed:', onchain?.balance.toString(), onchain?.totalClaimed.toString());
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[demo-agent] fatal error', err);
  process.exit(1);
});
