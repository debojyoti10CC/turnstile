# Demo script (TestNet, ~4 minutes)

Prep: escrow deployed, merchant + facilitator + settler + dashboard running, agent wallet funded with
TestNet ALGO + USDC, `WITHDRAW_DELAY_SECONDS=900`, bench already run once for the chart.

1. **Landscape (20 s).** "Middleware for x402 on Algorand already exists, three times over. The missing
   piece is batch-settlement: EVM and Solana have it, Algorand doesn't. We built it."
2. **Race (60 s).** Split terminal: `demo-agent --mode exact --calls 50` vs `--mode batch --calls 50`.
   Batch finishes while exact is still settling. Dashboard bench panel shows measured latency + txn counts.
3. **Money moves (40 s).** Dashboard: channel exposure rising. Settler hits threshold → one claim txn for
   many vouchers → `settle` → click explorer link.
4. **Dynamic pricing (30 s).** Three `/v1/infer` prompts of different lengths; per-call charges differ,
   all ≤ ceiling; `chargedCumulativeAmount` matches on client, server and chain.
5. **Exit safety (50 s).** Kill the agent mid-session. Payer runs `initiate_withdraw`. Settler detects it and
   claims immediately. (Pre-recorded clip for the 15-min finalize, or a LocalNet run with time offset.)
   Conservation check turns green.
6. **Attacks (30 s).** `pnpm adversary` live: replay, forged sig, cross-channel, over-balance, malicious
   deposit group… all rejected.
7. **Close (10 s).** "Spec draft for `scheme_batch_settlement_avm.md` is ready to PR upstream."
