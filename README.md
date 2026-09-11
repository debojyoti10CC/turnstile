# Turnstile — x402 batch-settlement for Algorand

Pay-per-request for AI agents without a blockchain transaction per request. Agents deposit USDC into an
Algorand escrow once, pay each call with an ed25519 voucher verified in microseconds, and merchants
settle hundreds of calls in one transaction. Built as a plugin for the official `@x402/*` SDK.

**Status:** pre-build package. Contract compiles and passes 25 offline tests; core library ready.
Claude Code builds the rest from `CLAUDE.md` (start with `docs/KICKOFF_PROMPT.md`).

## Quick checks
```bash
pip install -r contracts/requirements.txt
pnpm contracts:build && pnpm contracts:test      # 25 passed
cd packages/core && npm i && npx vitest run       # 11 passed
```

## Map
- `PRD.md` — why and what · `CLAUDE.md` — build brief · `docs/spec/` — protocol binding
- `contracts/` — Algorand Python escrow · `packages/core` — voucher/channel primitives
- `docs/reference/` — upstream x402 specs (Apache-2.0)
