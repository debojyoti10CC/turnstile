# Progress

| Phase | Status | Notes |
|---|---|---|
| Pre-work | ✅ | Contract compiles, 25 offline tests (incl. fuzz + TS parity), core lib + vectors, spec draft |
| P0 Scaffold | ✅ | refs cloned, workspace installed, spec-notes written, localnet skip-guard added |
| P1 Contract on LocalNet + escrow client | ✅ | deploy script, 6 real-tx LocalNet invariant tests, `packages/escrow-client` (TS tx builders) all done and verified against real transactions |
| P2 Plugin client + server | 🟡 | core verify/charge path + client scheme done and tested (scoped per DECISIONS.md); facilitator package, full corrective-402 wire plumbing through real @x402/core HTTP stack, and file/SQLite storage backends not yet built |
| P3 Facilitator + demo apps | ✅ | facilitator, demo-merchant, demo-agent all built and run for real on LocalNet: 200/200 dynamic-priced calls through one channel, agent/merchant state agree exactly |
| P4 Settler | ✅ | threshold/periodic/on-withdraw claim policies + settle, verified against real LocalNet (I8) |
| P5 Adversary | ✅ | 24/24 attacks correctly rejected (18 contract + 5 server + 500-step fuzz), real LocalNet, found and fixed one real gap |
| P6 Bench + dashboard + TestNet | ⬜ | |
| P7 Spec + docs | ⬜ | |

## Log
<!-- newest first: date — phase — what changed — what's next — risks -->

- 2026-09-11 — P0 — `pnpm refs` cloned `.refs/x402` (pinned `3c2ddfb9`) and
  `.refs/x402-demo`; converted `packages/core` into the pnpm workspace (removed
  its standalone `package-lock.json`); `pnpm install` at root green.
  `contracts:test` (25 offline tests) and `@turnstile/core` tests (11) pass.
  Added `contracts/tests/localnet/conftest.py` which skips the whole directory
  cleanly when LocalNet is unreachable (verified: offline suite unaffected,
  localnet dir collects 0 tests). Wrote `docs/spec-notes.md` from the EVM
  `batch-settlement` reference (header names, payload/storage/hook mirroring,
  AVM deviations). Git repo initialized (none existed before).
  **What's next:** P1 — `algokit` CLI + LocalNet (Docker) deploy script,
  `packages/escrow-client`.
- 2026-09-11 — P0 follow-up — installed `algokit` CLI 2.10.2 into
  `contracts/.venv`; user started Docker Desktop; `algokit localnet start`
  succeeded (algod/indexer/conduit/postgres containers healthy,
  `http://localhost:4001` reachable). Re-ran `puyapy` build — the earlier
  mypy DLL Application-Control failure did not recur (likely transient /
  resolved by the algokit install pulling a compatible toolchain); rebuilt
  `artifacts/` byte-for-byte identical to the committed ones (`git status`
  clean after rebuild), 25 offline tests still green. Both `contracts:build`
  and `contracts:test` exit criteria are now verified directly, and LocalNet
  is live for P1.
  **Risks:** none outstanding for P0. Carry forward: watch for the mypy DLL
  error recurring on a fresh shell (if so, retry once — it self-resolved here).

- 2026-09-11 — P1 (partial) — `contracts/scripts/deploy.py`: creates the app
  from the committed ARC-56 artifact (no recompile needed), funds base+opt-in
  MBR via `fund_app_account`, calls `opt_in_asset`, creates a mock 6-decimal
  ASA, funds/opts-in a payer + receiver test account. Uses a unique
  `app_name` per call so it always creates a fresh app (sidesteps
  `AppFactory.deploy()`'s update/replace-detection entirely — this script is
  for LocalNet test isolation, not a stable-identity production deploy).
  Added `contracts/tests/localnet/test_localnet.py`: 6 tests against real
  transactions — `I1_I2_I9_claim_bounded_and_monotonic`,
  `I2_stale_row_is_noop_not_revert`, `I3_conservation_deposit_claim_settle`,
  `I5_role_checks_claim`, `I7_payer_withdraw_after_delay`,
  `I10_open_mbr_matches_real_box_mbr_delta`. All pass, twice in a row, on a
  live `algokit localnet start` node. Full suite (offline + localnet): 31
  passed.
  **What's next:** `packages/escrow-client` (typed ARC-56 client wrapper +
  tx builders for deposit group / claim batch / settle / refund / withdraw,
  max-rows-per-claim-call constant) — P1's other deliverable, not yet started.
  **Risks/gotchas worth knowing before writing escrow-client** (see
  `docs/DECISIONS.md` for the full reasoning on each):
  (1) algokit_utils 4.2.3's simulate-based auto resource population
  (`populate_app_call_resources`, on by default) is unreliable for ABI method
  calls on this algod version — it can misreport a `group fee too small`
  error instead of the real missing-box/asset/account error. Every app call
  in the tests passes `box_references`/`asset_references`/`account_references`
  explicitly and `send_params={"populate_app_call_resources": False,
  "cover_app_call_inner_transaction_fees": False}`. escrow-client's tx
  builders should do the same rather than trust auto-discovery at submit time.
  (2) `claim()`'s extra fee must cover `ceil(n * 2600 / 700)` op-up inner
  transactions at one network min-fee each (confirmed empirically: 3 under-
  funds, 4 works for n=1) — this is the constant CLAUDE.md §1 asks P1 to
  derive and export; `ceil(n*2600/700)*1000` microAlgo is the verified formula.
  (3) `settle()` needs the receiver in `account_references` and the asset in
  `asset_references` (for its inner `AssetTransfer`); `finalize_withdraw`
  and `refund` likewise need `asset_references=[asset_id]`.
  (4) LocalNet dev-mode `set_timestamp_offset()` only takes effect from the
  block *after* the one it's set on — a throwaway latch transaction is needed
  before a time-sensitive call, or withdraw-delay tests fail despite a
  correctly-set offset.
  (5) `get_channel`/`open_mbr`/etc. (ARC-56 `readonly` methods) return
  `abi_return` as a plain `dict` keyed by struct field name, not a tuple —
  don't destructure positionally.

- 2026-09-11 — P1 complete — built `packages/escrow-client` (TypeScript):
  `boxes.ts` (channel/unsettled box-name builders), `fees.ts` (op-up extra
  fee formula, claim-batch size constants), `client.ts` (ARC-56 `AppClient`
  wrapper + config-to-ABI-tuple helper), `deposit.ts`, `claim.ts`,
  `settle.ts`, `refund.ts`, `withdraw.ts` (initiate/finalize), `channel.ts`
  (direct box read + ARC-4 decode, with a readonly-call fallback view).
  `test/localnet.test.ts` runs the full deposit → claim → settle → refund →
  initiateWithdraw → finalizeWithdraw lifecycle against a live LocalNet node
  (bootstrapped by shelling out to the already-proven `deploy.py` rather than
  re-solving `AppFactory.deploy()` in TS too) — passed 3 consecutive runs.
  Combined suite: Python 31/31, `@turnstile/core` 11/11,
  `@turnstile/escrow-client` 1/1 (real on-chain), `tsc --noEmit` clean.
  **Correction to a P1-partial risk note:** the JS/TS `algokit-utils` v9.2.2
  `AppClient.send.call()` does *not* auto-route ARC-56 `readonly` methods
  through simulate the way Python's v4.2.3 does — every box-touching call
  (including `open_mbr`, `get_channel`) needs explicit `boxReferences` in TS,
  with no readonly exception. Also corrected `MAX_CLAIM_ROWS_PER_CALL`:
  empirical probing (n=4..30) found the real limiter is
  `MAX_APP_CALL_FOREIGN_REFERENCES`=8 box refs, not opcode-budget op-ups as
  CLAUDE.md §7's formula assumed — n=7 (same receiver) succeeds, n=8 fails
  with algod's literal `tx.Boxes too long, max number of box references is
  8`. Exported both the same-receiver bound (7) and the worst-case
  every-row-different-receiver bound (4); `claimBatch()` checks the exact
  box count rather than trusting either constant blindly. Full reasoning in
  `docs/DECISIONS.md`.
  **Risks:** none outstanding for P1.

- 2026-09-11 — P2 (scoped) — built `packages/x402-avm-batch`. Added to
  `@turnstile/core/wire.ts`: `configToWire`/`configFromWire`/
  `channelIdFromWire` converters and `isDepositPayload`/`isVoucherPayload`/
  `isRefundPayload` type guards (needed by both client and server, belong in
  core alongside the types they discriminate).
  **Server**: `server/storage.ts` (`ChannelStorage` + `InMemoryChannelStorage`,
  per-channel async-lock pattern mirrored from the EVM reference almost
  verbatim -- it was already exactly right for I12). `server/channelManager.ts`:
  `verifyVoucher()` (channelId binding, ed25519 signature check, I4/I9 bound
  checks against the mirrored on-chain balance, cold-start recovery via an
  injected `fetchOnchain`) and `charge()` (atomic commit, I9's
  never-exceed-signed-max and never-exceed-balance checks, doubles as I12's
  serialization point). `server/scheme.ts`: `BatchSettlementAvmScheme`
  implementing `SchemeNetworkServer` (`parsePrice`, `getAssetDecimals`,
  `enhancePaymentRequirements`, `enrichPaymentRequiredResponse` for
  corrective-402, and `schemeHooks` wiring verify/settle to the channel
  manager).
  **Client**: `client/storage.ts` (`ClientChannelStorage` +
  `InMemoryClientChannelStorage`). `client/scheme.ts`:
  `BatchSettlementAvmClientScheme` implementing `SchemeNetworkClient` --
  `createPaymentPayload` builds a fresh deposit payload on cold start
  (delegating real transaction construction to an injected
  `buildDepositGroup`, keeping the scheme itself unit-testable without a live
  node/signer) or a steady-state voucher payload otherwise; `onPaymentResponse`
  commits confirmed charges and, on a corrective 402, verifies the
  server-reported voucher's signature against the client's **own** public key
  before adopting any of the server's claimed state (I11) -- a server cannot
  forge a signature under a key it doesn't hold, so a verifying signature is
  proof the client itself produced it.
  **Tests**: `test/channelManager.test.ts` (5 tests: I4 channel-id binding,
  I9 signature/balance/signed-max bounds, I12 — 50 concurrent charges on one
  channel settle to exactly the expected total with no over-accept).
  `test/e2e.test.ts` (4 tests, in-process, driving our own `schemeHooks` in
  the sequence `@x402/core`'s resource server would call them): cold-start +
  flat pricing, dynamic pricing (server charges the handler-determined actual,
  never the pre-authorized ceiling), corrective-402 end-to-end (client
  recovers from a stale local voucher via the verified corrective state and
  a retry succeeds), and 50 concurrent requests on one channel. Combined
  workspace total: 31 Python + 11 `core` + 1 `escrow-client` (real LocalNet)
  + 9 `x402-avm-batch` = 52 tests, all green; `tsc --noEmit` clean on all
  three TS packages.
  **Deliberately out of scope this pass** (see docs/DECISIONS.md for the
  reasoning): the EVM reference's pending-request TTL reservation system and
  its auto claim/settle/refund interval runner (that belongs to
  `packages/settler`, P4); a file/SQLite `ChannelStorage` backend (only
  in-memory exists so far); wiring through the real `@x402/core`
  `x402ResourceServer`/`x402Client`/`HTTPFacilitatorClient` HTTP stack (the
  E2E test drives our hooks directly instead); a facilitator package
  (`packages/x402-avm-batch/src/facilitator`, P3's `/verify`/`/settle`
  surface) -- deposit-group submission and real claim/settle transactions are
  not wired into this scheme yet, only the per-request accounting path is.
  **What's next:** P3 — facilitator + demo apps, which is also where the
  deposit-submission and corrective-402-over-real-HTTP gaps above will need
  to close for an actual demo to run end-to-end.
  **Risks:** the scope cuts above are real gaps, not polish items -- P3
  cannot produce a working demo merchant/agent without at least a minimal
  facilitator (to submit deposit groups and later claim/settle) and without
  connecting this scheme to `@x402/express`/`@x402/fetch`'s actual HTTP
  plumbing, which hasn't been exercised against this code yet.

- 2026-09-11 — P3 complete — built and ran, for real, on LocalNet:
  `packages/x402-avm-batch/src/facilitator/scheme.ts`
  (`BatchSettlementAvmFacilitatorScheme` implementing `SchemeNetworkFacilitator`
  -- `verify()` delegates to the channel manager for voucher/deposit/refund
  payloads, `settle()` submits the on-chain `refund()` call for cooperative
  refunds via an injected executor); `apps/facilitator` (Express, hand-rolled
  `/verify` `/settle` `/supported` per the wire contract `HTTPFacilitatorClient`
  expects -- no such server-side helper exists in `@x402/*`, unlike the
  client-side `HTTPFacilitatorClient`); `apps/demo-merchant` (Express +
  `@x402/express` `paymentMiddleware`, flat `GET /v1/data` and dynamic
  `POST /v1/infer` using `setSettlementOverrides` to charge actual
  handler-determined usage); `apps/demo-agent` (`@x402/fetch` +
  `BatchSettlementAvmClientScheme`, `--mode batch --calls N --concurrency K`).
  **Real run, not simulated:** fresh LocalNet deploy -> facilitator + merchant
  processes -> agent makes 200 dynamic-priced `/v1/infer` calls at
  `--concurrency 5` through one channel -> **200/200 succeeded**. Cross-checked
  via a debug endpoint: agent's local `chargedCumulativeAmount` (105000) and
  the merchant's own `ChannelStorage` record (105000) match exactly; on-chain
  balance (300000) and `totalClaimed` (0, expected -- claim/settle is P4's
  settler, not run yet) read back correctly via `escrow-client.getChannel`.
  This is the P3 exit criterion from CLAUDE.md verbatim, actually executed
  (see `docs/DECISIONS.md` for version/numbers; no fabricated figures).
  **Two real bugs found and fixed by this run** (full reasoning in
  `docs/DECISIONS.md`, here's the summary): (1) the server scheme declared
  `@x402/core`'s `"escrow"` payment flow, which calls `beforeSettle` *twice*
  per request for a different two-phase-settlement purpose than this scheme
  needed -- caused every dynamic-priced request to double-charge and fail;
  fixed by switching to `"authorization"` (single settle-after-handler),
  matching the EVM reference exactly. (2) the client scheme's local voucher
  bookkeeping used the confirmed-actual `chargedCumulativeAmount` as the
  basis for signing each new voucher's ceiling, which both (a) let the
  client's stored total drift away from what the merchant/chain actually
  charged under dynamic pricing, and (b) raced under concurrency (two
  in-flight requests reading the same stale base and signing overlapping
  ceilings, reproduced directly: 95/200 calls failed at `--concurrency 5`
  before the fix). Fixed by signing off the separately-tracked
  `signedMaxClaimable` (the latest *reserved* ceiling, written back inside a
  per-channel async lock synchronously before the request is sent) and by
  updating `chargedCumulativeAmount` only from the server's actual settled
  amount on response. Also discovered along the way: each voucher reserves
  its *full* per-call ceiling against channel balance regardless of actual
  dynamic usage (the client can't know the actual in advance) -- so a
  200-call run needs deposit headroom sized as `ceiling × calls`, not
  `actual × calls`; sized the demo's deposit multiplier and route ceiling
  accordingly and left a comment explaining why.
  Combined workspace total after P3: 31 Python + 11 `core` + 1
  `escrow-client` (real LocalNet) + 9 `x402-avm-batch` (unit/in-process) = 52
  automated tests, all green, plus the real 200-call LocalNet run above.
  **Deliberately out of scope this pass:** the `exact` scheme fallback
  route/demo-agent mode (`@x402/avm`'s exact scheme was never wired in,
  consistent with the algokit-utils version decision from P2); a flat-price
  agent run (only dynamic `/v1/infer` was driven end-to-end; `/v1/data`
  exists on the merchant but the agent CLI doesn't exercise it yet);
  SQLite/file-backed `ChannelStorage` (still in-memory only, fine for one
  demo process but not for a restart-surviving facilitator).
  **What's next:** P4 — the settler (`packages/settler`): claim/settle
  policies (threshold, periodic, on-withdraw), which is what actually moves
  the 105000 atomic units charged above from "accounted" to "on-chain
  claimed and swept to the receiver."
  **Risks:** none outstanding for P3 beyond the documented scope cuts.

- 2026-09-11 — P4 complete — built `packages/settler`. `src/policies.ts`:
  pure, chain-free decision functions (`isClaimEligible` -- on-withdraw
  always wins over threshold/periodic, a channel with nothing unclaimed is
  never eligible even mid-withdrawal; `shouldSettle`; `chunk` for batching;
  `assertPollIntervalSafe`, the CLAUDE.md P4 startup assertion
  `pollIntervalMs * 3 < withdrawDelayMs`, enforced in the `Settler`
  constructor so a misconfigured settler fails at startup, not mid-run).
  `src/settler.ts`: `Settler` class with `start()`/`stop()`/`tick()` --
  `tick()` re-reads on-chain state via `escrow-client.getChannel` for every
  channel in the shared `ChannelStorage` before deciding anything (no
  trust in a possibly-stale mirror or in what a previous tick remembered),
  batches eligible claims through `escrow-client.claimBatch` respecting the
  box-reference cap (chunked conservatively at 4 rows by default, the
  worst-case bound from P1's empirical finding), then sweeps any
  (receiver, asset) pair with unsettled balance via `escrow-client.settle`.
  Never overlaps ticks (`ticking` flag) and never mutates per-channel state
  except `lastClaimedAtMs` on a *successful* claim -- a failed batch is
  simply retried next tick against freshly-read on-chain state, matching
  CLAUDE.md's "idempotent; re-read state before submit; survive restarts."
  **Tests**: `test/policies.test.ts` (14 unit tests for the pure functions).
  `test/settler.localnet.test.ts` -- **I8 on real LocalNet**: deploys a
  fresh app, deposits real funds, signs a real voucher for 600,000 of a
  1,000,000 deposit, seeds an in-memory `ChannelStorage` (standing in for
  what a merchant's server scheme would have recorded), has the payer call
  `initiate_withdraw` for the full balance, then drives `settler.tick()`
  directly (not the timer) and confirms: the on-withdraw policy claims the
  600,000 voucher regardless of threshold/periodic config being unset,
  `settle()` sweeps it in the same tick, and after advancing the dev-mode
  clock past the withdraw delay, `finalize_withdraw` returns exactly
  `balance - totalClaimed` = 400,000 -- verified twice in a row for
  stability. Combined workspace total after P4: 31 Python + 11 `core` + 1
  `escrow-client` (real LocalNet) + 9 `x402-avm-batch` + 15 `settler`
  (1 real LocalNet) = **67 tests, all green**.
  **Deliberately out of scope this pass:** a periodic-interval timer demo
  (the settler's `start()`/timer path is implemented and type-checked but
  only `tick()` has been exercised directly; running it as a genuine
  background loop against the P3 demo apps is a natural next integration
  but wasn't required for I8); per-channel settle-amount reporting beyond
  the `onSettle` callback (no persistent settler-side ledger of what it
  has claimed/settled over time -- `lastClaimedAtMs` is in-memory only and
  lost on restart, which is fine per spec since claims are idempotent and
  re-derived from on-chain state, but would matter for audit/reporting).
  **What's next:** P5 — the adversary suite (`packages/adversary`):
  attack tests that must all be rejected by the contract and server, the
  def-in-depth counterpart to everything built in P0-P4.
  **Risks:** none outstanding for P4.

- 2026-09-11 — P5 complete — built `packages/adversary`. `src/world.ts`:
  shared LocalNet bootstrap (reuses `contracts/scripts/deploy.py`, same
  pattern as every other package's real-node tests) plus `maliciousDeposit`,
  a deposit builder that -- unlike `@turnstile/escrow-client`'s safe
  `deposit()` -- lets every field (rekey, close-to, clawback, wrong sender/
  receiver/asset) be overridden, since this package's entire job is
  submitting transactions the safe builder would never construct.
  `src/contractAttacks.ts`: 18 attacks against the real deployed contract --
  replay of a lower voucher after a higher claim, cross-channel voucher
  reuse, wrong app id/genesis in the signed message, bit-flipped signature,
  wrong signer, max-claimable-over-balance, total-over-signed-max,
  non-receiver claim/refund, non-payer withdraw, early finalize, five
  malicious deposit-group variants (rekey/close-to/clawback/wrong-receiver/
  sender-not-payer), and drain+refund+re-fund+replay (the box-never-deleted
  invariant, I6). `src/serverAttacks.ts`: 5 attacks against
  `BatchSettlementChannelManager`/`BatchSettlementAvmClientScheme` directly
  (in-process, no chain needed) -- stale voucher, charge exceeding signed
  headroom, voucher above mirrored balance, voucher submitted once a pending
  withdrawal is within its safety margin, and a forged corrective-402 state
  that the client must reject via its own signature check (I11).
  `src/fuzz.ts`: 500 random deposit/claim/stale-claim/refund/settle steps
  against real LocalNet, asserting I1/I2/I3 after every step (see
  docs/DECISIONS.md for why withdraw/finalize are out of this particular
  op mix). `src/report.ts` + `src/main.ts`: the harness (`expectRejected`/
  `expectFalsy` helpers, so "the call threw" and "the call succeeded but
  had no effect" are both legitimate ways to pass) writing
  `packages/adversary/report.json` and exiting non-zero on any accepted
  attack.
  **Real run, not simulated:** `pnpm adversary` against a live LocalNet --
  **24/24 attacks correctly rejected**, full run (18 contract attacks + 5
  server attacks + 500-step fuzz) completes in ~35-40 seconds.
  **One real gap found and fixed by this suite, not before it:**
  `BatchSettlementChannelManager.verifyVoucher` had no check at all for a
  pending withdrawal -- it would keep accepting (and charging for) new
  vouchers on a channel whose payer had already signaled intent to exit.
  Not a fund-safety bug (the contract's own `finalize_withdraw` already
  bounds payer losses), but exactly the "voucher during withdraw window
  past safety margin" rejection CLAUDE.md's P5 attack list calls for.
  Fixed: a configurable `withdrawSafetyMarginSec` (default 60s) now rejects
  new vouchers once a pending withdrawal is within that margin of becoming
  finalizable, using the pre-existing (previously unused) `ERR.withdrawPending`
  code. Also hit and fixed a harness-only issue along the way: firing
  structurally-identical transactions back-to-back (e.g. repeated bare
  `settle()` calls) collided on txid under algokit-utils' default
  suggested-params cache; disabling that cache for this package's bootstrap
  fixed it (2/24 attacks failed with `TransactionPool.Remember: transaction
  already in ledger` before the fix, 24/24 after).
  **Deliberately out of scope this pass** (see docs/DECISIONS.md): a
  "malicious deposit group for fee payer" attack (extra txn / fee-over-cap /
  rekey-in-any-txn / wrong app-id-or-method) -- not applicable under this
  project's current deposit-submission model, where the client/agent submits
  its own deposit directly with its own keys rather than handing a
  partially-signed group to a facilitator that co-signs as fee payer (see
  the P3 decision on this); a "top-up with mismatched config" attack --
  channel id is a hash of the full config, so this is a hash-collision
  attempt, not a reachable code path worth a dedicated test.
  Combined workspace total after P5: 31 Python + 11 `core` + 1
  `escrow-client` + 9 `x402-avm-batch` + 15 `settler` = 67 automated tests,
  plus the adversary suite's 24/24, all green.
  **What's next:** P6 — benchmark, dashboard, and TestNet deployment.
  TestNet deployment needs a funded account the user must provide or
  approve funding for; benchmark and dashboard can proceed on LocalNet
  first.
  **Risks:** none outstanding for P5.

- **2026-09-12 — P6 (partial): SDK packaging hardening + real benchmark.**
  SDK/devtooling: all four publishable packages (`core`, `escrow-client`,
  `x402-avm-batch`, `settler`) now declare an explicit `exports` map and a
  `files: ["dist"]` allowlist (see docs/DECISIONS.md), and each has a
  README documenting its public surface and a usage example. Rebuilt and
  re-ran the full suite afterward — no regressions.

  Benchmark: `pnpm bench` (`apps/demo-agent/src/bench.ts`) runs N in
  {50, 200, 1000} against real LocalNet, comparing batch-settlement to a
  naive one-real-transaction-per-call baseline ("exact" — see
  docs/DECISIONS.md for why it's naive and not `@x402/avm`'s actual
  facilitator). First full run surfaced a real bug, not a bench artifact:
  at N=1000 the batch leg only completed 250/1000 calls before every
  subsequent request failed `invalid_batch_settlement_avm_cumulative_exceeds_balance`,
  because every voucher reserves the route's full advertised price
  *ceiling* against the deposit regardless of actual usage, and the
  bench's deposit-sizing formula didn't scale with call count. Fixed (see
  docs/DECISIONS.md) and reran; final real numbers (`apps/demo-agent/bench.json`):

  | N | mode | wall time | p50 / p95 added latency | on-chain txns | network fees | one-time MBR |
  |---|---|---|---|---|---|---|
  | 50 | batch | 1309 ms | 18 / 29 ms | 3 | 3,000 µALGO | 121,000 µALGO |
  | 50 | exact | 1893 ms | 36 / 76 ms | 50 | 50,000 µALGO | 0 |
  | 200 | batch | 1942 ms | 9 / 12 ms | 3 | 3,000 µALGO | 121,000 µALGO |
  | 200 | exact | 4396 ms | 22 / 35 ms | 200 | 200,000 µALGO | 0 |
  | 1000 | batch | 8214 ms | 8 / 10 ms | 3 | 3,000 µALGO | 121,000 µALGO |
  | 1000 | exact | 22149 ms | 17 / 41 ms | 1000 | 1,000,000 µALGO | 0 |

  All six runs: 0 failures. The headline result: batch-settlement's
  on-chain transaction count and network fees are **flat at 3 txns /
  3,000 µALGO regardless of N** (the deposit group — claim/settle are
  deferred, amortized accounting handled later by the settler, not a
  per-request cost), versus exact's linear `N` txns and `N × 1,000`
  µALGO — a 333x fee reduction at N=1000 (excluding the one-time,
  refundable 121,000 µALGO box-storage MBR, which is paid once per
  channel, not per request, and is not a fee). Per-request added latency
  is also consistently lower for batch (signing + local voucher
  verification) than exact (waiting on a real per-call txn confirmation).
  **What's next:** dashboard (React/Vite) and TestNet deployment — the
  latter needs a funded TestNet account from the user. P7 spec/docs
  polish remains after that.
  **Risks:** none outstanding for this benchmark pass.

- **2026-09-12 — P6: TestNet deployment, verified live.** New
  `contracts/scripts/deploy_testnet.py` (two-step, idempotent, never logs
  secrets — see docs/DECISIONS.md) deployed the escrow app and a mock
  6-decimal USDC-like ASA to Algorand TestNet once the generated deployer
  address was funded with 10 ALGO from the public dispenser:
  - App id `771555042`, asset id `771555032`, genesis
    `SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe`.
  - `apps/{demo-agent,demo-merchant,facilitator}` previously hardcoded
    `AlgorandClient.defaultLocalNet()`; they now honor a `NETWORK` env var
    (`testnet` | default `localnet`) — found and fixed while wiring this up,
    since none of them actually had a TestNet path before.
  Ran the real flow against it end-to-end (not just a deploy-script
  success): facilitator + merchant started against TestNet, `demo-agent`
  opened a channel and completed 3 real paid `/v1/infer` requests (one
  on-chain deposit group — axfer + pay(MBR) + `deposit()` — then local
  voucher signing for each request), then a direct `claimBatch()` +
  `settle()` against the same app. Final on-chain state matched exactly:
  balance 300,000, `totalClaimed` 3,600 after settle, agent-local
  `chargedCumulativeAmount` 300 (atomic units) matching the last voucher.
  Along the way, hit and fixed the same class of stale-suggested-params
  issue noted elsewhere in this log, this time during the deploy script
  itself (`TransactionPool.Remember: txn dead`, because real TestNet
  rounds take ~2.8s, unlike LocalNet's instant dev-mode) — fixed by making
  every deploy step idempotent (check on-chain state before acting) rather
  than by disabling a cache, since a real-network deploy is exactly the
  case where a step can legitimately half-succeed and need a safe rerun.
  **What's next:** dashboard (React/Vite), then P7 spec/docs polish.
  **Risks:** none outstanding for TestNet deployment. The settler
  (`@turnstile/settler`) has no standalone long-running app yet — it's
  exercised directly in its own LocalNet test (I8) and was driven manually
  here via `claimBatch`/`settle` rather than its own process; running it
  as a background service against TestNet is part of the still-pending
  dashboard/ops work, not a correctness gap.

- **2026-09-12 — P6: dashboard built and verified in a real browser.**
  New `apps/dashboard` (React 19 + Vite 8) polls three new read-only
  `/debug/*` endpoints added to `apps/demo-merchant` (see docs/DECISIONS.md
  for why it reuses the merchant's own storage rather than a separate
  service): a channels table (deposit, charged, signed max, claimed,
  exposure, withdraw countdown), the real `pnpm bench` results as both a
  table and a fee-comparison bar chart, and the real `pnpm adversary`
  report (24/24 pass). Every figure shown is either live server state or
  a file one of this repo's own CLIs already wrote.
  Verified live, not just "it builds": ran a fresh LocalNet deploy,
  started the facilitator + merchant, drove 3 real batch-settlement
  calls through `demo-agent`, started the dashboard's Vite dev server,
  and loaded it in an actual browser — confirmed the channel row, the
  real bench numbers, and the real adversary report all rendered
  correctly with zero console errors.
  **What's next:** P7 — finalize `docs/spec/scheme_batch_settlement_avm.md`
  against what was actually built, and polish the top-level README
  (60-second pitch, architecture diagram, quickstart, security model,
  limitations).
  **Risks:** none outstanding for the dashboard.
