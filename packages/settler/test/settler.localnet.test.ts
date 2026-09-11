/**
 * I8 (real LocalNet): "An online settler claims the highest accepted
 * voucher before a withdrawal finalizes." Skips cleanly when LocalNet is
 * unreachable, mirroring the pattern in packages/escrow-client/test.
 *
 * Bootstraps a fresh app/asset/payer/receiver via the already-proven
 * contracts/scripts/deploy.py, deposits real funds, signs a real voucher,
 * seeds an in-memory ChannelStorage as a stand-in for what a merchant's
 * server scheme would have recorded, then drives the settler directly
 * (tick(), not its timer) through: payer initiates a withdrawal mid-session
 * -> settler claims the outstanding voucher -> dev-mode clock advances past
 * the withdraw delay -> payer finalizes and receives exactly
 * balance - totalClaimed.
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
  channelId as computeChannelId,
  configToWire,
  newSessionKey,
  signVoucher,
  toB64,
  type ChannelConfig,
  type Deployment,
} from '@turnstile/core';
import { deposit, getAppClient, initiateWithdraw, finalizeWithdraw, getChannel } from '@turnstile/escrow-client';
import { InMemoryChannelStorage, type Channel } from '@turnstile/x402-avm-batch';
import { Settler } from '../src/settler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const deployScript = path.join(repoRoot, 'contracts', 'scripts', 'deploy.py');
const venvPython = path.join(repoRoot, 'contracts', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

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

describe('I8: settler claims the highest voucher before a withdrawal finalizes', () => {
  it('payer recovers exactly balance - totalClaimed after the settler claims mid-session', async () => {
    if (!localnetUp || !existsSync(venvPython)) {
      console.warn('LocalNet unreachable or contracts/.venv missing; skipping settler I8 test.');
      return;
    }

    const summaryJson = execFileSync(venvPython, [deployScript], { cwd: repoRoot, encoding: 'utf-8' });
    const summary = JSON.parse(summaryJson) as DeploySummary;

    const payer = toAccount(summary.payer, summary.payer_private_key);
    const receiver = toAccount(summary.receiver, summary.receiver_private_key);
    algorand.account.setSigner(summary.payer, algosdk.makeBasicAccountTransactionSigner(payer));
    algorand.account.setSigner(summary.receiver, algosdk.makeBasicAccountTransactionSigner(receiver));
    await algorand.account.localNetDispenser(); // registers the dispenser signer this test's client also needs

    const appClient = getAppClient(algorand, BigInt(summary.app_id));
    const params = await algorand.client.algod.getTransactionParams().do();
    const deployment: Deployment = { genesisHash: params.genesisHash, appId: BigInt(summary.app_id) };
    const withdrawDelaySec = 900; // matches deploy.py's MIN_WITHDRAW_DELAY

    const session = await newSessionKey();
    const config: ChannelConfig = {
      payer: summary.payer,
      payerAuthorizer: algosdk.encodeAddress(session.pk),
      receiver: summary.receiver,
      receiverAuthorizer: summary.receiver,
      asset: BigInt(summary.asset_id),
      withdrawDelay: BigInt(withdrawDelaySec),
      salt: randomBytes(32),
    };

    const depositAmount = 1_000_000n;
    const cid = await deposit({ algorand, appClient, config, amount: depositAmount }, deployment);
    const cidB64 = toB64(cid);
    expect(cidB64).toBe(toB64(computeChannelId(config, deployment)));

    // Simulate several requests' worth of charging: the highest voucher the
    // payer's session key ever signed, which the settler must claim.
    const signedMax = 600_000n;
    const signature = await signVoucher(session.sk, deployment, cid, signedMax);

    const storage = new InMemoryChannelStorage();
    const channelRecord: Channel = {
      channelId: cidB64,
      channelConfig: configToWire(config),
      chargedCumulativeAmount: signedMax.toString(),
      signedMaxClaimable: signedMax.toString(),
      signature: toB64(signature),
      balance: depositAmount.toString(),
      totalClaimed: '0',
      withdrawRequestedAt: 0,
      onchainSyncedAt: Date.now(),
      lastRequestTimestamp: Date.now(),
    };
    await storage.updateChannel(cidB64, () => channelRecord);

    const settler = new Settler({
      storage,
      algorand,
      appClient,
      receiverSender: summary.receiver,
      pollIntervalMs: 10_000,
      withdrawDelayMs: withdrawDelaySec * 1000,
      claimPolicy: {},
    });

    // Payer initiates a withdrawal mid-session, before the settler has
    // claimed anything.
    await initiateWithdraw({ appClient, sender: summary.payer, channelId: cid, amount: depositAmount });

    const midWithdraw = await getChannel(algorand, appClient, cid);
    expect(midWithdraw?.withdrawRequestedAt).toBeGreaterThan(0n);
    expect(midWithdraw?.totalClaimed).toBe(0n);

    // The settler's on-withdraw policy must claim regardless of threshold/periodic config.
    await settler.tick();

    const afterClaim = await getChannel(algorand, appClient, cid);
    expect(afterClaim?.totalClaimed).toBe(signedMax);

    // Advance the dev-mode clock past the withdraw delay (see
    // docs/DECISIONS.md: a throwaway latch transaction is required for a
    // newly-set offset to actually apply to the next block).
    await algorand.client.algod.setBlockOffsetTimestamp(withdrawDelaySec + 60).do();
    await algorand.send.payment({
      sender: summary.payer,
      receiver: summary.payer,
      amount: microAlgos(0),
      note: new Uint8Array(randomBytes(8)),
    });

    const finalState = await getChannel(algorand, appClient, cid);
    const expectedWithdraw = finalState!.balance - finalState!.totalClaimed;

    const withdrawn = await finalizeWithdraw({ appClient, sender: summary.payer, channelId: cid, asset: BigInt(summary.asset_id) });
    expect(withdrawn).toBe(expectedWithdraw);
    expect(withdrawn).toBe(depositAmount - signedMax);
  }, 60_000);
});
