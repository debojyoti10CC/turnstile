# @turnstile/settler

The background worker that turns signed vouchers into real on-chain settlement: claims the
highest accepted voucher per channel, then settles accumulated unsettled balances to the
receiver's own wallet. Runs alongside (but independent of) the x402 resource server — it reads
the same `ChannelStorage` the server writes to and re-reads on-chain state before every submit, so
a crash mid-batch is always safe to retry (`claim()` is a no-op on stale rows).

Three claim policies (`policies.ts`): **threshold** (unclaimed ≥ T), **periodic** (age since last
claim ≥ A), **on-withdraw** (claim immediately, regardless of threshold/periodic, once the payer
has requested a withdraw — this is what makes I8 hold: the settler claims before the withdraw
delay expires). Settlement then moves anything unsettled for a `(receiver, asset)` pair once it
reaches `settleMinUnsettledAtomic`.

```ts
import { Settler } from '@turnstile/settler';

const settler = new Settler({
  storage, algorand, appClient,
  receiverSender: receiverAuthorizerAddress,
  pollIntervalMs: 5_000,
  withdrawDelayMs: channelWithdrawDelaySeconds * 1000,
  claimPolicy: { unclaimedThresholdAtomic: 1_000_000n, maxAgeMs: 60_000 },
});
settler.start(); // or: await settler.tick() to drive it manually (tests, CLIs)
```

The constructor asserts `pollIntervalMs * 3 < withdrawDelayMs` at startup — the settler refuses to
run with a polling interval so coarse it couldn't reliably beat a payer's withdraw window.

Claim batches respect `maxRowsPerClaimBatch` (default 4, the worst case under
`MAX_APP_CALL_FOREIGN_REFERENCES=8` when rows span different receivers; see
`@turnstile/escrow-client`'s `fees.ts` for the exact box-reference accounting and when it's safe to
raise toward 7). Verified against I8 on real LocalNet transactions in `test/localnet.test.ts`.
