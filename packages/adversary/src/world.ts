import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import algosdk from 'algosdk';
import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils';
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client';
import { channelId as computeChannelId, newSessionKey, signVoucher, type ChannelConfig, type Deployment } from '@turnstilealgo/core';
import { getAppClient, channelBoxName, unsettledBoxName } from '@turnstilealgo/escrow-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, '../../../');
const deployScript = path.join(repoRoot, 'contracts', 'scripts', 'deploy.py');
export const venvPython = path.join(repoRoot, 'contracts', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

export interface DeploySummary {
  app_id: number;
  app_address: string;
  asset_id: number;
  deployer: string;
  payer: string;
  payer_private_key: string;
  receiver: string;
  receiver_private_key: string;
}

export interface World {
  algorand: AlgorandClient;
  appClient: AppClient;
  deployment: Deployment;
  summary: DeploySummary;
  payer: algosdk.Account;
  receiver: algosdk.Account;
}

function toAccount(address: string, privateKeyB64: string): algosdk.Account {
  return { addr: algosdk.Address.fromString(address), sk: Buffer.from(privateKeyB64, 'base64') };
}

export async function bootstrap(): Promise<World> {
  const summaryJson = execFileSync(venvPython, [deployScript], { cwd: repoRoot, encoding: 'utf-8' });
  const summary = JSON.parse(summaryJson) as DeploySummary;

  const algorand = AlgorandClient.defaultLocalNet();
  // This suite fires many structurally-identical transactions in quick
  // succession (e.g. repeated settle() calls with no varying fields); with
  // algokit-utils' default suggested-params cache, two such calls inside the
  // cache window get the same firstValid/lastValid and become byte-identical
  // (and therefore same-txid) transactions, which algod rejects as
  // "already in ledger" -- a harness artifact, not a protocol issue.
  algorand.setSuggestedParamsCacheTimeout(0);
  const payer = toAccount(summary.payer, summary.payer_private_key);
  const receiver = toAccount(summary.receiver, summary.receiver_private_key);
  algorand.account.setSigner(summary.payer, algosdk.makeBasicAccountTransactionSigner(payer));
  algorand.account.setSigner(summary.receiver, algosdk.makeBasicAccountTransactionSigner(receiver));
  await algorand.account.localNetDispenser();

  const appClient = getAppClient(algorand, BigInt(summary.app_id));
  const params = await algorand.client.algod.getTransactionParams().do();
  const deployment: Deployment = { genesisHash: params.genesisHash, appId: BigInt(summary.app_id) };

  return { algorand, appClient, deployment, summary, payer, receiver };
}

export function freshConfig(world: World, payerAuthorizerPk: Uint8Array, overrides?: Partial<ChannelConfig>): ChannelConfig {
  return {
    payer: world.summary.payer,
    payerAuthorizer: algosdk.encodeAddress(payerAuthorizerPk),
    receiver: world.summary.receiver,
    receiverAuthorizer: world.summary.receiver,
    asset: BigInt(world.summary.asset_id),
    withdrawDelay: 900n,
    salt: randomBytes(32),
    ...overrides,
  };
}

export async function newChannel(world: World, amount = 100_000n) {
  const session = await newSessionKey();
  const config = freshConfig(world, session.pk);
  const cid = computeChannelId(config, world.deployment);
  return { session, config, cid };
}

/**
 * Deposit builder that, unlike `@turnstilealgo/escrow-client`'s `deposit()`,
 * lets every field be overridden -- this package's whole job is submitting
 * transactions the safe builder would never construct.
 */
export async function maliciousDeposit(
  world: World,
  config: ChannelConfig,
  amount: bigint,
  overrides: {
    axferSender?: string;
    axferReceiver?: string;
    axferAssetId?: bigint;
    rekeyTo?: string;
    closeAssetTo?: string;
    clawbackTarget?: string;
    appCallSender?: string;
  } = {},
): Promise<void> {
  const appAddress = world.appClient.appAddress.toString();
  const cid = computeChannelId(config, world.deployment);
  const cfgTuple = [
    config.payer, config.payerAuthorizer, config.receiver, config.receiverAuthorizer,
    config.asset, config.withdrawDelay, config.salt,
  ];
  const boxRefs = [
    { appId: world.appClient.appId, name: channelBoxName(cid) },
    { appId: world.appClient.appId, name: unsettledBoxName(config.receiver, config.asset) },
  ];

  const mbrNeeded = (await world.appClient.send.call({
    method: 'open_mbr',
    args: [cfgTuple],
    sender: world.summary.deployer,
    boxReferences: boxRefs,
    populateAppCallResources: false,
  })).return as bigint;

  const xfer = await world.algorand.createTransaction.assetTransfer({
    sender: overrides.axferSender ?? config.payer,
    receiver: overrides.axferReceiver ?? appAddress,
    assetId: overrides.axferAssetId ?? config.asset,
    amount,
    rekeyTo: overrides.rekeyTo,
    closeAssetTo: overrides.closeAssetTo,
    clawbackTarget: overrides.clawbackTarget,
  });
  const mbr = await world.algorand.createTransaction.payment({
    sender: config.payer,
    receiver: appAddress,
    amount: microAlgos(mbrNeeded),
  });

  await world.appClient.send.call({
    sender: overrides.appCallSender ?? config.payer,
    method: 'deposit',
    args: [cfgTuple, xfer, mbr],
    boxReferences: boxRefs,
    populateAppCallResources: false,
    coverAppCallInnerTransactionFees: false,
  });
}

export async function sign(session: { sk: Uint8Array }, deployment: Deployment, cid: Uint8Array, max: bigint): Promise<Uint8Array> {
  return signVoucher(session.sk, deployment, cid, max);
}
