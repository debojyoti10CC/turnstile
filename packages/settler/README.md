# @turnstile/settler

**Turns signed vouchers into real on-chain settlement.** The claim/settle policy engine behind
Turnstile's batch-settlement scheme: a `Settler` instance polls channel state, decides which
channels are worth claiming right now, batches them into as few `claim()` app calls as the
Algorand box-reference limit allows, and periodically sweeps unsettled balances to each receiver
with `settle()`.

```bash
npm install @turnstile/settler
```

This package is chain-agnostic policy logic plus one class that drives real transactions through
[`@turnstile/escrow-client`](../escrow-client) — it has no HTTP server and no timers beyond its own
`start()`/`stop()`. For a ready-to-run standalone process, see [`apps/settler`](../../apps/settler),
which wraps this package with env-var configuration and process lifecycle handling.

## Why a separate settler

The x402 batch-settlement model defers the expensive part (an on-chain transaction) away from the
request path entirely. Something still has to eventually turn accepted vouchers into real token
transfers — that's this package's whole job, run independently of the merchant server so a slow or
crashed settlement pass never blocks a paid request.

## Quickstart

```ts
import { Settler } from '@turnstile/settler';

const settler = new Settler({
  storage,                              // the same ChannelStorage your x402 server writes to
  algorand,                             // an AlgorandClient with a signer registered for receiverSender
  appClient,                            // from @turnstile/escrow-client's getAppClient()
  receiverSender: receiverAddress,      // must be config.receiver or config.receiverAuthorizer
  pollIntervalMs: 30_000,
  withdrawDelayMs: 900_000,             // the channel's on-chain withdraw_delay, in ms
  claimPolicy: { thresholdAtomic: 1_000_000n, periodicMs: 5 * 60_000 },
  settleMinUnsettledAtomic: 1n,
  onClaim: (r) => console.log(`claimed ${r.claimed} on ${r.channelId}`),
  onSettle: (r) => console.log(`settled ${r.amount} of asset ${r.asset} to ${r.receiver}`),
  onError: (err) => console.error('settler tick failed, will retry next poll', err),
});

settler.start();          // polls on a timer
// or, for tests/CLIs:
await settler.tick();     // drives exactly one claim pass + one settle pass
```

The constructor throws immediately if `pollIntervalMs * 3 >= withdrawDelayMs` — the settler's whole
reason to exist is beating a payer's withdraw window (invariant **I8**), so it refuses to start with
a polling interval too coarse to reliably do that.

## Claim policies

A channel is claimed this tick if **any** of these hold (checked in this order — on-withdraw always
wins):

| Policy | Config field | Rule |
|---|---|---|
| On-withdraw | *(always active)* | The channel has a pending withdraw request — claim immediately, regardless of threshold/periodic, so I8 holds |
| Threshold | `claimPolicy.thresholdAtomic` | `unclaimedAmount >= thresholdAtomic` |
| Periodic | `claimPolicy.periodicMs` | Time since this settler's last successful claim on that channel `>= periodicMs` |

A channel with nothing unclaimed is never eligible, even mid-withdrawal. Settlement is separate and
simpler: once a `(receiver, asset)` pair's on-chain unsettled balance reaches
`settleMinUnsettledAtomic` (default: anything `> 0`), `settle()` sweeps it.

## Batching and safety

- Claims are batched up to `maxRowsPerClaimBatch` (default `4` — the worst case under Algorand's
  `MAX_APP_CALL_FOREIGN_REFERENCES = 8` when every row has a different receiver; safe to raise
  toward `7` if your channels share one receiver — see `@turnstile/escrow-client`'s `fees.ts`).
- Every tick re-reads on-chain state before submitting; nothing is trusted from a previous tick.
- `claim()` is a no-op on stale rows on-chain, so a crash mid-batch is always safe to retry on the
  next poll — no idempotency tracking needed on this side.
- `tick()` never overlaps itself: a slow tick delays the next timer fire rather than running
  concurrently with it.

## API reference

| Export | What it is |
|---|---|
| `Settler` | The class above — `start()`, `stop()`, `tick()` |
| `SettlerConfig` | Constructor config (see Quickstart) |
| `ClaimResult`, `SettleResult` | Shapes passed to `onClaim` / `onSettle` |
| `ClaimPolicyConfig` | `{ thresholdAtomic?: bigint; periodicMs?: number }` |
| `isClaimEligible(candidate, config, nowMs)` | Pure decision function behind the claim policy table above — unit-test your own policy logic against it directly |
| `shouldSettle(unsettled, minUnsettled)` | Pure decision function behind settlement |
| `assertPollIntervalSafe(pollIntervalMs, withdrawDelayMs)` | The `pollIntervalMs * 3 < withdrawDelayMs` guard, exported so a host process can validate its own config before constructing a `Settler` |
| `chunk(items, size)` | Small batching helper used internally, exported since claim-batch sizing is a common thing to want standalone |

## Testing

```bash
pnpm -F @turnstile/settler test
```

15 tests: 14 pure policy-logic tests (`policies.test.ts` — no chain, no I/O) plus **I8** verified
against real transactions on LocalNet (`settler.localnet.test.ts`): a payer initiates a withdrawal
mid-session, the settler claims the highest signed voucher before the delay elapses, and the payer's
finalized withdrawal recovers exactly `balance - totalClaimed`.
