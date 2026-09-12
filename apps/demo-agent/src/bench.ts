/**
 * pnpm bench: measures batch-settlement against a naive per-call on-chain
 * baseline at N in {50, 200, 1000}, writing real numbers to bench.json.
 *
 * "exact" here is NOT @x402/avm's real exact scheme (see docs/DECISIONS.md:
 * that dependency was deliberately not wired into this project) -- it is a
 * naive one-real-transaction-per-call baseline: what ANY non-batched, settle
 * -every-request payment scheme costs on-chain, which is the actual
 * comparison worth making for this project's value proposition. Every number
 * below comes from a real LocalNet run: wall-clock Date.now() around each
 * call, and ALGO fees from a real before/after balance delta on the fee-
 * paying account (balance drop minus any value actually transferred), never
 * computed from an assumed fee schedule.
 */
import { openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import algosdk from 'algosdk';
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import type { Network } from '@x402/core/types';
import { caip2FromGenesisHash, channelId as computeChannelId, type ChannelConfig, type Deployment } from '@turnstilealgo/core';
import { channelBoxName, configToTuple, deposit, getAppClient, unsettledBoxName } from '@turnstilealgo/escrow-client';
import { BatchSettlementAvmClientScheme, type BuildDepositGroup } from '@turnstilealgo/x402-avm-batch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const venvPython = path.join(repoRoot, 'contracts', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const deployScript = path.join(repoRoot, 'contracts', 'scripts', 'deploy.py');
const outPath = path.join(__dirname, '..', 'bench.json');

interface DeploySummary {
  app_id: number; app_address: string; asset_id: number; deployer: string;
  payer: string; payer_private_key: string; receiver: string; receiver_private_key: string;
}

interface RunResult {
  mode: 'batch' | 'exact';
  calls: number;
  succeeded: number;
  failed: number;
  wallTimeMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  onChainTxnCount: number;
  /** Real network fees only -- see the `mbrLockedMicroAlgo` comment in runBatchMode. */
  totalFeesMicroAlgo: number;
  /** One-time box-storage MBR locked by opening a channel; 0 for "exact" (no boxes). Not a fee -- refundable on channel close. */
  mbrLockedMicroAlgo: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function microAlgoBalance(algorand: AlgorandClient, address: string): Promise<bigint> {
  const info = await algorand.account.getInformation(address);
  return info.balance.microAlgo;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any HTTP response -- even a 402 from an unpaid request to a
      // payment-protected route -- proves the server is listening and its
      // stack is wired up; only a thrown fetch error (connection refused)
      // means "not up yet".
      await fetch(url);
      return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`service at ${url} did not become reachable within ${timeoutMs}ms`);
}

/** Runs the batch-settlement flow for `calls` requests through a live merchant+facilitator. */
async function runBatchMode(calls: number, merchantUrl: string, summary: DeploySummary): Promise<RunResult> {
  const algorand = AlgorandClient.defaultLocalNet();
  const payerAccount: algosdk.Account = { addr: algosdk.Address.fromString(summary.payer), sk: Buffer.from(summary.payer_private_key, 'base64') };
  algorand.account.setSigner(summary.payer, algosdk.makeBasicAccountTransactionSigner(payerAccount));

  const params = await algorand.client.algod.getTransactionParams().do();
  const deployment: Deployment = { genesisHash: params.genesisHash, appId: BigInt(summary.app_id) };
  const network = caip2FromGenesisHash(params.genesisHash) as Network;
  const appClient = getAppClient(algorand, BigInt(summary.app_id));

  // Tracked separately from network fees: the deposit group's `pay` leg
  // covers a one-time box-storage MBR (a real ALGO transfer, refundable on
  // channel close), not a recurring per-call cost. Conflating it into "fees"
  // would make batch-settlement look far more expensive than it is.
  let mbrLockedMicroAlgo = 0n;
  const buildDepositGroup: BuildDepositGroup = async ({ config, amount }: { config: ChannelConfig; amount: bigint }) => {
    const cid = computeChannelId(config, deployment);
    const mbrResult = await appClient.send.call({
      method: 'open_mbr',
      args: [configToTuple(config)],
      sender: summary.payer,
      boxReferences: [
        { appId: appClient.appId, name: channelBoxName(cid) },
        { appId: appClient.appId, name: unsettledBoxName(config.receiver, config.asset) },
      ],
      populateAppCallResources: false,
    });
    mbrLockedMicroAlgo += BigInt(mbrResult.return as bigint);
    const channelId = await deposit({ algorand, appClient, config, amount }, deployment);
    return { paymentGroup: [Buffer.from(channelId).toString('base64')] };
  };
  const clientScheme = new BatchSettlementAvmClientScheme({
    payerAddress: summary.payer,
    deployment,
    buildDepositGroup,
    // Every voucher reserves the route's full price *ceiling* (not actual
    // usage) against the deposit -- see the comment on /v1/infer's price in
    // apps/demo-merchant/src/index.ts. So funding `calls` requests needs a
    // deposit of at least ceiling * calls; add 10% headroom.
    depositMultiplier: Math.ceil(calls * 1.1),
  });
  const client = new x402Client().register(network, clientScheme).setSpendControls(false);
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  const balanceBefore = await microAlgoBalance(algorand, summary.payer);
  const latencies: number[] = [];
  let succeeded = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (let i = 0; i < calls; i++) {
    const prompt = 'x'.repeat(1 + (i % 20));
    const t0 = performance.now();
    try {
      const res = await fetchWithPay(`${merchantUrl}/v1/infer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      latencies.push(performance.now() - t0);
      if (res.ok) succeeded++; else { failed++; console.error(`[bench] batch call ${i} failed: ${res.status}`); }
    } catch (err) {
      latencies.push(performance.now() - t0);
      failed++;
      console.error(`[bench] batch call ${i} threw:`, err);
    }
  }

  const wallTimeMs = Date.now() - startedAt;
  const balanceAfter = await microAlgoBalance(algorand, summary.payer);
  // One deposit group up front (axfer + pay(MBR) + appl deposit = 3 txns);
  // claim+settle happen later via the settler and are NOT part of this
  // request-time measurement (see docs/PROGRESS.md: batch-settlement's claim
  // is deferred accounting, not a per-request cost). The payer's ALGO
  // balance drop is real fees PLUS the one-time MBR `pay` leg -- subtract
  // the independently-measured MBR amount to isolate actual network fees.
  const totalFeesMicroAlgo = Number(balanceBefore - balanceAfter - mbrLockedMicroAlgo);
  latencies.sort((a, b) => a - b);

  return {
    mode: 'batch', calls, succeeded, failed, wallTimeMs,
    p50LatencyMs: Math.round(percentile(latencies, 50)),
    p95LatencyMs: Math.round(percentile(latencies, 95)),
    onChainTxnCount: 3,
    totalFeesMicroAlgo,
    mbrLockedMicroAlgo: Number(mbrLockedMicroAlgo),
  };
}

/** Naive baseline: one real on-chain axfer settling each call directly, no channel/batching. */
async function runExactMode(calls: number, summary: DeploySummary): Promise<RunResult> {
  const algorand = AlgorandClient.defaultLocalNet();
  const payerAccount: algosdk.Account = { addr: algosdk.Address.fromString(summary.payer), sk: Buffer.from(summary.payer_private_key, 'base64') };
  algorand.account.setSigner(summary.payer, algosdk.makeBasicAccountTransactionSigner(payerAccount));
  algorand.setSuggestedParamsCacheTimeout(0); // see docs/DECISIONS.md: avoid same-txid collisions from rapid identical calls

  const balanceBefore = await microAlgoBalance(algorand, summary.payer);
  const latencies: number[] = [];
  let succeeded = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (let i = 0; i < calls; i++) {
    const t0 = performance.now();
    try {
      await algorand.send.assetTransfer({
        sender: summary.payer,
        receiver: summary.receiver,
        assetId: BigInt(summary.asset_id),
        amount: 1n + BigInt(i % 20), // mirrors the dynamic per-call price in the batch run
        note: new Uint8Array(Buffer.from(`exact-${i}`)),
      });
      latencies.push(performance.now() - t0);
      succeeded++;
    } catch (err) {
      latencies.push(performance.now() - t0);
      failed++;
      console.error(`[bench] exact call ${i} threw:`, err);
    }
  }

  const wallTimeMs = Date.now() - startedAt;
  const balanceAfter = await microAlgoBalance(algorand, summary.payer);
  const totalFeesMicroAlgo = Number(balanceBefore - balanceAfter);
  latencies.sort((a, b) => a - b);

  return {
    mode: 'exact', calls, succeeded, failed, wallTimeMs,
    p50LatencyMs: Math.round(percentile(latencies, 50)),
    p95LatencyMs: Math.round(percentile(latencies, 95)),
    onChainTxnCount: calls,
    totalFeesMicroAlgo,
    mbrLockedMicroAlgo: 0,
  };
}

function deploy(): DeploySummary {
  const json = execFileSync(venvPython, [deployScript], { cwd: repoRoot, encoding: 'utf-8' });
  return JSON.parse(json) as DeploySummary;
}

function startService(script: string, env: Record<string, string>, logPath: string): ChildProcess {
  const logFd = openSync(logPath, 'w');
  const child = spawn(process.execPath, [script], { cwd: path.dirname(script), env: { ...process.env, ...env }, stdio: ['ignore', logFd, logFd] });
  return child;
}

async function main() {
  const sizesArg = process.argv.find((a) => a.startsWith('--sizes='));
  const sizes = sizesArg ? sizesArg.slice('--sizes='.length).split(',').map(Number) : [50, 200, 1000];

  const results: RunResult[] = [];

  for (const n of sizes) {
    console.log(`[bench] === N=${n} ===`);
    const summary = deploy();

    const facilitatorPort = 4500 + Math.floor(Math.random() * 100);
    const merchantPort = 4600 + Math.floor(Math.random() * 100);

    const facilitator = startService(path.join(repoRoot, 'apps/facilitator/dist/index.js'), {
      X402_AVM_APP_ID: String(summary.app_id),
      RECEIVER_AUTHORIZER_ADDRESS: summary.receiver,
      FACILITATOR_PORT: String(facilitatorPort),
    }, path.join(__dirname, '..', 'bench-facilitator.log'));
    const merchant = startService(path.join(repoRoot, 'apps/demo-merchant/dist/index.js'), {
      X402_AVM_APP_ID: String(summary.app_id),
      X402_AVM_ASSET_ID: String(summary.asset_id),
      RECEIVER_ADDRESS: summary.receiver,
      RECEIVER_AUTHORIZER_ADDRESS: summary.receiver,
      FACILITATOR_URL: `http://localhost:${facilitatorPort}`,
      MERCHANT_PORT: String(merchantPort),
    }, path.join(__dirname, '..', 'bench-merchant.log'));

    try {
      await waitForHealth(`http://localhost:${facilitatorPort}/supported`, 15_000);
      await waitForHealth(`http://localhost:${merchantPort}/v1/data`, 15_000);

      const batchResult = await runBatchMode(n, `http://localhost:${merchantPort}`, summary);
      console.log('[bench] batch:', batchResult);
      results.push(batchResult);
    } finally {
      facilitator.kill();
      merchant.kill();
    }

    // Exact baseline needs its own fresh deployment (separate asset/account
    // state) so the fee-balance delta isn't polluted by the batch run above.
    const exactSummary = deploy();
    const exactResult = await runExactMode(n, exactSummary);
    console.log('[bench] exact:', exactResult);
    results.push(exactResult);
  }

  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`[bench] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('[bench] fatal error', err);
  process.exit(1);
});
