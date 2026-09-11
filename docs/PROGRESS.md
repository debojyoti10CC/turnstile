# Progress

| Phase | Status | Notes |
|---|---|---|
| Pre-work | ✅ | Contract compiles, 25 offline tests (incl. fuzz + TS parity), core lib + vectors, spec draft |
| P0 Scaffold | ✅ | refs cloned, workspace installed, spec-notes written, localnet skip-guard added |
| P1 Contract on LocalNet + escrow client | ⬜ | |
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
