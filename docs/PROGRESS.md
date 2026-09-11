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
  **Risks:**
  (1) `puyapy`/`mypy` cannot run in this sandbox — Windows Application Control
  policy blocks mypy's compiled DLL import (`ImportError: DLL load failed ...
  Application Control policy has blocked this file`). Contract **cannot be
  recompiled here**; the checked-in `artifacts/` (approval/clear TEAL + bin +
  ARC-56) are used as-is and the 25 offline tests (which exercise them via
  `algorand-python-testing`) still pass, so this only blocks *regeneration*,
  not correctness of what's committed. Needs a non-restricted machine or a
  policy exception to rebuild after any contract.py change.
  (2) Docker Desktop's Linux engine is not running in this environment
  (`docker info` → `failed to connect ... dockerDesktopLinuxEngine`) and I
  cannot start the GUI app from this sandboxed shell. LocalNet-dependent work
  (P1 exit criteria I1–I7, I9, I10 on real txns) needs the user to run
  `algokit localnet start` (or start Docker Desktop) before those tests can
  execute; code for P1 can still be written and will auto-skip until then.
  (3) `algokit` CLI itself is not installed yet (`command not found`) —
  needs `pipx install algokit` or `pip install algokit`, deferred to P1 start.
