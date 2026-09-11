/**
 * Real-node LocalNet test for `packages/escrow-client`. Skips cleanly (not
 * fails) when LocalNet is unreachable, so offline `pnpm test` stays green.
 *
 * Bootstraps a fresh app + mock ASA + funded payer/receiver accounts by
 * shelling out to `contracts/scripts/deploy.py` (already proven against
 * real transactions in the Python localnet suite) rather than re-solving
 * AppFactory.deploy() quirks a second time in TS -- this test's job is to
 * verify escrow-client's own tx-building logic, not to re-prove deployment.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import algosdk from 'algosdk';
import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils';
import {
  newSessionKey,
  signVoucher,
  type ChannelConfig,
  type Deployment,
} from '@turnstile/core';
import {
  claimBatch,
  deposit,
  finalizeWithdraw,
  getAppClient,
  getChannel,
  initiateWithdraw,
  refund,
  settle,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const deployScript = path.join(repoRoot, 'contracts', 'scripts', 'deploy.py');
const venvPython = path.join(
  repoRoot,
  'contracts',
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

interface DeploySummary {
  app_id: number;
  app_address: string;
  asset_id: number;
  deployer: string;
  payer: string;
  payer_private_key: string;
  receiver: string;
  receiver_private_key: string;
}

function toAccount(address: string, privateKeyB64: string): algosdk.Account {
  return { addr: algosdk.Address.fromString(address), sk: Buffer.from(privateKeyB64, 'base64') };
}

let algorand: AlgorandClient;
let localnetUp = false;

beforeAll(async () => {
  algorand = AlgorandClient.defaultLocalNet();
  try {
    await algorand.client.algod.status().do();
    localnetUp = true;
  } catch {
    localnetUp = false;
  }
});

const maybeDescribe = describe;

maybeDescribe('escrow-client against a real LocalNet node', () => {
  it('runs the full deposit -> claim -> settle -> refund -> withdraw lifecycle', async () => {
    if (!localnetUp) {
      console.warn('LocalNet unreachable; skipping escrow-client real-node test.');
      return;
    }
    if (!existsSync(venvPython)) {
      console.warn('contracts/.venv not found; skipping escrow-client real-node test.');
      return;
    }

    const summaryJson = execFileSync(venvPython, [deployScript], { cwd: repoRoot, encoding: 'utf-8' });
    const summary = JSON.parse(summaryJson) as DeploySummary;

    const payerAccount = toAccount(summary.payer, summary.payer_private_key);
    const receiverAccount = toAccount(summary.receiver, summary.receiver_private_key);
    algorand.account.setSigner(summary.payer, algosdk.makeBasicAccountTransactionSigner(payerAccount));
    algorand.account.setSigner(summary.receiver, algosdk.makeBasicAccountTransactionSigner(receiverAccount));
    // deploy.py ran in a separate process/AlgorandClient instance, so this
    // client never had the dispenser (== summary.deployer)'s signer registered.
    await algorand.account.localNetDispenser();

    const appClient = getAppClient(algorand, BigInt(summary.app_id));

    const params = await algorand.client.algod.getTransactionParams().do();
    const deployment: Deployment = { genesisHash: params.genesisHash, appId: BigInt(summary.app_id) };

    const session = await newSessionKey();
    const config: ChannelConfig = {
      payer: summary.payer,
      payerAuthorizer: algosdk.encodeAddress(session.pk),
      receiver: summary.receiver,
      receiverAuthorizer: summary.receiver,
      asset: BigInt(summary.asset_id),
      withdrawDelay: 900n,
      salt: randomBytes(32),
    };

    const cid = await deposit({ algorand, appClient, config, amount: 1_000_000n }, deployment);

    const maxClaimable = 300_000n;
    const signature = await signVoucher(session.sk, deployment, cid, maxClaimable);
    const claimed = await claimBatch({
      appClient,
      sender: summary.receiver,
      rows: [{ channelId: cid, maxClaimable, signature, totalClaimed: maxClaimable }],
      receiverByChannel: () => ({ receiver: summary.receiver, asset: BigInt(summary.asset_id) }),
    });
    expect(claimed).toBe(maxClaimable);

    const afterClaim = await getChannel(algorand, appClient, cid);
    expect(afterClaim?.totalClaimed).toBe(maxClaimable);
    expect(afterClaim?.config.payer).toBe(summary.payer);

    const settled = await settle({
      appClient,
      sender: summary.deployer,
      receiver: summary.receiver,
      asset: BigInt(summary.asset_id),
    });
    expect(settled).toBeGreaterThanOrEqual(maxClaimable);

    const refunded = await refund({
      appClient,
      sender: summary.receiver,
      channelId: cid,
      amount: 200_000n,
      asset: BigInt(summary.asset_id),
      payer: summary.payer,
    });
    expect(refunded).toBe(200_000n);

    const beforeWithdraw = await getChannel(algorand, appClient, cid);
    const remaining = beforeWithdraw!.balance - beforeWithdraw!.totalClaimed;
    await initiateWithdraw({ appClient, sender: summary.payer, channelId: cid, amount: remaining });

    await algorand.client.algod.setBlockOffsetTimestamp(1_000).do();
    await algorand.send.payment({
      sender: summary.payer,
      receiver: summary.payer,
      amount: microAlgos(0),
      note: new Uint8Array(randomBytes(8)),
    });

    const withdrawn = await finalizeWithdraw({
      appClient,
      sender: summary.payer,
      channelId: cid,
      asset: BigInt(summary.asset_id),
    });
    expect(withdrawn).toBe(remaining);

    const final = await getChannel(algorand, appClient, cid);
    expect(final?.balance).toBe(final?.totalClaimed);
  }, 60_000);
});
