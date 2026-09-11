# PRD — Turnstile: x402 batch-settlement channels for Algorand

**Team veg momo:** Debojyoti De Majumder, Sylvia Barick, Sampurnaa Nag, Diptomoy Das · **Track:** Algorand
**Version:** 2.0 (pivot) · September 11, 2026 · Build brief: `CLAUDE.md` · Protocol: `docs/spec/scheme_batch_settlement_avm.md`

## 1. One-liner
Turnstile brings x402's `batch-settlement` scheme to Algorand: agents deposit USDC once, pay every
request with a signed voucher the merchant checks in microseconds, and the merchant settles hundreds of
payments in one transaction. Same one-line middleware experience as before; completely different engine.

## 2. Why pivot (research summary)
Turnstile v1 ("one-line middleware to charge agents via x402 on Algorand, with a ledger dashboard") is
already served by free, ecosystem-endorsed tools:

| Existing | Covers |
|---|---|
| Algorand Foundation `x402-demo` + `@x402/avm` | Official `exact` scheme client/server/facilitator for AVM |
| `satishccy/x402-express-algo` | Drop-in Express middleware, facilitator, gasless, paywall |
| GoPlausible facilitator | Production settlement + public dashboard, directory, receipts, analytics — free; mandatory for the Global x402 Challenge |
| `ap2-algorand`, Akita (ARC-58) | Buyer-side mandates / smart-wallet spend policies |
| AC2 (Algorand Foundation + Pera) | Cryptographic human approvals for agent actions |

The x402 standard now has three schemes: `exact`, `upto`, `batch-settlement`. Upstream has
`batch-settlement` bindings for **EVM and SVM only**; AVM ships `exact` only. That is the gap.

## 3. Problem
1. **Latency:** `exact` puts a ~3 s on-chain settlement inside every request.
2. **Chain load / fees:** one transaction per call; at sub-cent prices overhead dominates.
3. **No honest dynamic pricing:** LLM/compute cost is known only after serving.
4. **Hot-key risk:** agents paying with `exact` hold a key to a funded wallet.

## 4. Solution
- **Escrow app** (Algorand Python): channels keyed by an immutable config, USDC held by the app, ed25519
  vouchers verified with `ed25519verify_bare`, batched `claim`, permissionless `settle`, cooperative
  `refund`, timed `withdraw` escape hatch (15 min–30 days).
- **x402 mechanism plugin** `@turnstile/x402-avm-batch` implementing the official SDK interfaces
  (client, server, facilitator) — so merchants keep using `@x402/express` and agents keep using
  `@x402/fetch`. Merchants advertise both `batch-settlement` and `exact`; clients choose.
- **Session keys:** the voucher signer is a hot key whose worst case is "sign vouchers up to the deposit".
- **Settler** that claims on threshold / age / withdrawal and sweeps with `settle`.
- **Adversary suite** proving every attack is rejected, **benchmark**, **dashboard**, **spec** for upstream.

## 5. Users
| User | Job |
|---|---|
| API / inference merchant | Charge per token or per call without 3 s latency or a txn per request |
| Agent developer | Let an agent pay thousands of times with a key that can't lose more than the deposit |
| Ecosystem / judges | See Algorand's x402 stack move forward, not another wrapper |

## 6. Scope
**MVP (must):** contract + LocalNet tests; core lib; plugin client/server/facilitator; SQLite storage;
settler; demo merchant (dynamic `/v1/infer`, flat `/v1/data`, exact fallback); demo agent; adversary
suite; benchmark; dashboard; TestNet deployment; spec draft.
**Stretch:** Redis storage; AC2-approved channel opens ("human sets the budget once"); NFD names;
MainNet `exact` endpoint for the Global x402 Challenge.
**Non-goals:** multi-hop/bidirectional channels, signer rotation, MainNet escrow before review,
replacing GoPlausible.

## 7. Requirements
Functional requirements are the phase exit criteria in `CLAUDE.md §4`; protocol rules are in the spec
§3–§7. Security invariants I1–I12 (`CLAUDE.md §9`) are acceptance tests.

## 8. Success metrics (measured, never hard-coded)
| Metric | `exact` | Turnstile target |
|---|---|---|
| Added latency per paid call | one confirmation (~3 s) | < 5 ms p95 server-side verify |
| On-chain txns for 1,000 calls | 1,000 | 1 deposit group + ⌈1000/rows-per-claim⌉ claims + 1 settle (+ close) |
| Dynamic pricing | flat only | exact per-token charge ≤ ceiling |
| Adversary suite | — | 100% rejected |

## 9. Demo (4 min) — details in `docs/DEMO.md`
Honest landscape slide → exact vs batch race → dashboard exposure + one batched claim on TestNet →
per-token pricing → agent vanishes, payer withdraws, settler claims in time, conservation green →
live adversary run → "we wrote the AVM spec".

## 10. Global x402 Challenge note
The Challenge ranks MainNet `exact` payments settled through GoPlausible. Voucher traffic won't count.
The merchant always also offers `exact`; deploying that path to MainNet is the qualification route.

## 11. Risks
| Risk | Mitigation |
|---|---|
| Upstream ships AVM batch-settlement first | Mirror EVM naming, open spec PR early, be the reference impl |
| Opcode budget / box refs in large batches | Measure max rows on LocalNet; export constant; fall back to smaller batches |
| Settler offline during withdraw window | On-withdraw policy, dashboard alert, long default delay |
| Wire drift from SDK | Build as an SDK plugin; parity tests against `@x402/core` types |
| Scope creep | Non-goals are binding |

## 12. Team split (suggested)
Debojyoti: contract on LocalNet + escrow client + settler · Sylvia: spec, server plugin, adversary ·
Sampurnaa: client plugin + demo agent + bench · Diptomoy: facilitator app, demo merchant, dashboard.
