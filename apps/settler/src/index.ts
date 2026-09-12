import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import algosdk from 'algosdk';
import { getAppClient } from '@turnstile/escrow-client';
import { SqliteChannelStorage } from '@turnstile/x402-avm-batch';
import { Settler } from '@turnstile/settler';

const APP_ID = BigInt(process.env.X402_AVM_APP_ID ?? '0');
const CHANNEL_DB_PATH = process.env.CHANNEL_DB_PATH ?? '';
const RECEIVER_SENDER_ADDRESS = process.env.RECEIVER_SENDER_ADDRESS ?? '';
const RECEIVER_SENDER_PRIVATE_KEY = process.env.RECEIVER_SENDER_PRIVATE_KEY ?? '';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
const WITHDRAW_DELAY_SECONDS = Number(process.env.WITHDRAW_DELAY_SECONDS ?? 900);
const CLAIM_THRESHOLD_ATOMIC = process.env.CLAIM_THRESHOLD_ATOMIC ? BigInt(process.env.CLAIM_THRESHOLD_ATOMIC) : undefined;
const CLAIM_PERIODIC_MS = process.env.CLAIM_PERIODIC_MS ? Number(process.env.CLAIM_PERIODIC_MS) : undefined;
const SETTLE_MIN_UNSETTLED_ATOMIC = process.env.SETTLE_MIN_UNSETTLED_ATOMIC
  ? BigInt(process.env.SETTLE_MIN_UNSETTLED_ATOMIC)
  : undefined;
const MAX_ROWS_PER_CLAIM_BATCH = process.env.MAX_ROWS_PER_CLAIM_BATCH ? Number(process.env.MAX_ROWS_PER_CLAIM_BATCH) : undefined;

/**
 * Standalone long-running settler process (CLAUDE.md P4's "on-withdraw"
 * policy in particular depends on *something* polling continuously, not
 * being invoked by hand). Reads the same on-disk `ChannelStorage` the
 * merchant process writes to (`CHANNEL_DB_PATH`, backed by
 * `SqliteChannelStorage` -- SQLite's own file locking makes it safe for the
 * merchant and this process to share one file, one writer at a time), then
 * runs `@turnstile/settler`'s claim/settle policies from `packages/settler`
 * on a timer against real on-chain state. `packages/settler` itself is
 * chain-agnostic and already fully tested (including I8 on real LocalNet);
 * this file is only wiring: env config in, `Settler.start()`, structured
 * logs out, graceful shutdown on SIGINT/SIGTERM.
 */
async function main() {
  if (!APP_ID) throw new Error('X402_AVM_APP_ID env var is required');
  if (!CHANNEL_DB_PATH) {
    throw new Error(
      'CHANNEL_DB_PATH env var is required -- point it at the same file the merchant was started with ' +
        '(CHANNEL_DB_PATH there too), since InMemoryChannelStorage cannot be shared across processes',
    );
  }
  if (!RECEIVER_SENDER_ADDRESS) throw new Error('RECEIVER_SENDER_ADDRESS env var is required');

  const algorand =
    process.env.NETWORK === 'mainnet'
      ? AlgorandClient.mainNet()
      : process.env.NETWORK === 'testnet'
        ? AlgorandClient.testNet()
        : AlgorandClient.defaultLocalNet();

  if (RECEIVER_SENDER_PRIVATE_KEY) {
    // TestNet (or any network without a local KMD wallet holding this
    // address): register the signer explicitly, same pattern as demo-agent.
    const account: algosdk.Account = {
      addr: algosdk.Address.fromString(RECEIVER_SENDER_ADDRESS),
      sk: Buffer.from(RECEIVER_SENDER_PRIVATE_KEY, 'base64'),
    };
    algorand.account.setSigner(RECEIVER_SENDER_ADDRESS, algosdk.makeBasicAccountTransactionSigner(account));
  }
  // On LocalNet, deploy.py-created accounts are KMD-tracked and algokit-utils'
  // default account manager resolves a signer for them automatically -- no
  // explicit registration needed, matching apps/facilitator's approach.

  const appClient = getAppClient(algorand, APP_ID);
  const storage = new SqliteChannelStorage(CHANNEL_DB_PATH);

  const settler = new Settler({
    storage,
    algorand,
    appClient,
    receiverSender: RECEIVER_SENDER_ADDRESS,
    pollIntervalMs: POLL_INTERVAL_MS,
    withdrawDelayMs: WITHDRAW_DELAY_SECONDS * 1000,
    claimPolicy: { thresholdAtomic: CLAIM_THRESHOLD_ATOMIC, periodicMs: CLAIM_PERIODIC_MS },
    settleMinUnsettledAtomic: SETTLE_MIN_UNSETTLED_ATOMIC,
    maxRowsPerClaimBatch: MAX_ROWS_PER_CLAIM_BATCH,
    onClaim: (result) => console.log(`[settler] claimed ${result.claimed} atomic units on channel ${result.channelId}`),
    onSettle: (result) =>
      console.log(`[settler] settled ${result.amount} atomic units of asset ${result.asset} to ${result.receiver}`),
    onError: (err) => console.error('[settler] tick error (will retry next poll)', err),
  });

  settler.start();
  console.log(
    `[settler] started (app ${APP_ID}, pollIntervalMs=${POLL_INTERVAL_MS}, withdrawDelaySeconds=${WITHDRAW_DELAY_SECONDS}, db=${CHANNEL_DB_PATH})`,
  );

  const shutdown = () => {
    console.log('[settler] shutting down');
    settler.stop();
    storage.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[settler] fatal startup error', err);
  process.exit(1);
});
