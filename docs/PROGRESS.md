# Progress

| Phase | Status | Notes |
|---|---|---|
| Pre-work | ✅ | Contract compiles, 25 offline tests (incl. fuzz + TS parity), core lib + vectors, spec draft |
| P0 Scaffold | ✅ | refs cloned, workspace installed, spec-notes written, localnet skip-guard added |
| P1 Contract on LocalNet + escrow client | 🟡 | deploy script + 6 real-tx LocalNet invariant tests done; `packages/escrow-client` TS package not started |
| P2 Plugin client + server | ⬜ | |
| P3 Facilitator + demo apps | ⬜ | |
| P4 Settler | ⬜ | |
| P5 Adversary | ⬜ | |
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
