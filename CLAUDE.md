# CLAUDE.md — Turnstile: x402 `batch-settlement` for Algorand

You are the build agent for **Turnstile**, the first AVM implementation of the x402 `batch-settlement`
scheme: ASA escrow channels, ed25519 cumulative vouchers verified off-chain in microseconds, batched
on-chain claims, dynamic (`upto`-style) pricing. Goal: a working, tested, demoable system on LocalNet
and TestNet, packaged as an **x402 mechanism plugin** that plugs into the official `@x402/*` SDK, plus
a draft spec that can be upstreamed.

Read `PRD.md` (why/what) and `docs/spec/scheme_batch_settlement_avm.md` (the protocol) before coding.

---

## 0. What already exists and is verified (do not rewrite without cause)

| Artifact | State |
|---|---|
| `contracts/smart_contracts/x402_batch_settlement/contract.py` | Compiles with puyapy 5.10 (≈1.6 KB approval). 25 offline tests pass (`contracts/tests/`), including fuzzed conservation and TS↔contract signature parity |
| `packages/core` | Voucher/channel-id encoding, ed25519 sign/verify, Algorand address codec, wire types, error codes, network constants. 11 vitest tests; golden vectors in `test/vectors.json` |
| `docs/spec/scheme_batch_settlement_avm.md` | Draft binding |
| `docs/reference/` | Vendored upstream specs (x402 commit in `UPSTREAM_COMMIT.txt`) |

The offline tests use `algorand-python-testing` (an emulator). They do **not** prove fees, opcode
budget, box references or real signing work on a node. Phase 1 closes that gap on LocalNet.

---

## 1. Operating rules

1. **Autonomy.** Work through phases P0→P7 in order without waiting for approval. Stop and ask only if:
   a spec ambiguity changes on-chain behavior, a dependency is missing/broken with no workaround, or
   an invariant test cannot be made to pass. Otherwise decide, record the decision in
   `docs/DECISIONS.md` (date, decision, alternatives, reason), and continue.
2. **References first.** Run `pnpm refs` (clones `.refs/x402` and `.refs/x402-demo`). Before writing
   each package, open its counterpart in `.refs/x402/typescript/packages/mechanisms/evm/src/batch-settlement/`
   and mirror structure, naming, hooks and error handling. When our spec and the EVM spec differ, our
   spec wins for AVM specifics, the EVM spec wins for wire/lifecycle semantics. Note every deviation in
   `docs/spec-notes.md`.
3. **Verify versions** with `npm view` / `pip index versions` before pinning. Never pin from memory.
4. **Invariants are the definition of done** (§9). Each has a named test. A phase is not done while any
   of its invariants is red.
5. **Keep the contract small and boring.** Any contract change requires: updated offline tests,
   updated LocalNet tests, regenerated ARC-56 + typed client, regenerated golden vectors if encoding
   changes, and a DECISIONS entry.
6. **Secrets.** Keys only from env. Never log mnemonics, secret keys or full signatures at info level.
   The agent's funding key never signs vouchers; the session key never holds funds.
7. **No fake numbers.** Benchmarks and dashboards display measured values only.
8. After each phase: all tests green, update `docs/PROGRESS.md` (done / next / risks), commit with
   message `P<n>: <summary>`.

---

## 2. Target repo layout

```
turnstile/
├─ CLAUDE.md  PRD.md  README.md  .env.example  package.json  pnpm-workspace.yaml
├─ contracts/
│  ├─ smart_contracts/x402_batch_settlement/contract.py      # exists
│  ├─ smart_contracts/x402_batch_settlement/artifacts/       # arc56.json, teal, bin (generated)
│  ├─ tests/test_contract.py, test_vectors.py, vectors.json  # exist (offline)
│  ├─ tests/localnet/                                        # P1: real-node tests
│  └─ scripts/deploy.py                                      # P1: create app, fund MBR, opt in USDC
├─ packages/
│  ├─ core/                 # exists: encoding, crypto, wire types
│  ├─ escrow-client/        # P1: typed ARC-56 client wrapper + tx builders (deposit group, claim batch, settle, refund, withdraw)
│  ├─ x402-avm-batch/       # P2–P3: the x402 mechanism plugin
│  │   └─ src/{client,server,facilitator}/   (mirror EVM batch-settlement file names)
│  ├─ settler/              # P4: claim/settle worker
│  └─ adversary/            # P5: attack suite + fuzz vs LocalNet
├─ apps/
│  ├─ facilitator/          # P3: self-hosted AVM batch facilitator (/verify /settle /supported)
│  ├─ demo-merchant/        # P3: Express + @x402/express; /v1/infer (dynamic), /v1/data (flat); exact fallback
│  ├─ demo-agent/           # P3: @x402/fetch client loop + bench
│  └─ dashboard/            # P6: React/Vite
├─ docs/  spec/  reference/  RESOURCES.md  PROGRESS.md  DECISIONS.md  spec-notes.md  DEMO.md
└─ scripts/fetch-references.sh
```

---

## 3. Stack

| Concern | Choice |
|---|---|
| Contract | Algorand Python (puyapy), ARC-56 app spec |
| Typed client | `algokit generate client contracts/smart_contracts/x402_batch_settlement/artifacts/X402BatchSettlement.arc56.json --output packages/escrow-client/src/generated/client.ts` (or algokit-utils `AppClient` with the ARC-56 JSON if generation is unavailable) |
| Chain SDK | `algosdk` v3 + `@algorandfoundation/algokit-utils` (match the major used by `@x402/avm`) |
| x402 SDK | `@x402/core`, `@x402/avm` (exact), `@x402/express`, `@x402/fetch` |
| Crypto | `@noble/ed25519`, `@noble/hashes` (already in core) |
| Storage | `ChannelStorage` interface (mirror EVM `server/storage.ts`); impls: in-memory, file/SQLite (`better-sqlite3`, WAL); Redis optional |
| Tests | vitest (TS), pytest (contract offline + LocalNet) |
| Tooling | pnpm workspaces, TypeScript strict, Node 22, Python 3.12, AlgoKit CLI + Docker for LocalNet |

---

## 4. Phases

### P0 — Scaffold (target: 1–2 h)
- `pnpm refs`; `pnpm install`; convert `packages/core` into the workspace (it has its own package.json).
- `algokit localnet start` works; add `contracts/tests/localnet/conftest.py` that skips cleanly if LocalNet is down (so offline CI still passes).
- Read all of `docs/reference/`, the EVM batch-settlement TS implementation, and `.refs/x402/typescript/packages/mechanisms/avm/src`. Write `docs/spec-notes.md`: header names, payload shapes, hooks you'll implement, storage interface, what differs on AVM.
- **Exit:** `pnpm contracts:build && pnpm contracts:test && pnpm -F @turnstile/core test` green.

### P1 — Contract on a real node + escrow client
- `contracts/scripts/deploy.py`: create app, fund app account (0.1 ALGO base + asset opt-in MBR), call `opt_in_asset(USDC)`. On LocalNet, create a mock USDC ASA (6 decimals) and fund test accounts.
- `packages/escrow-client`: builders for
  - deposit group `[axfer(payer→app), pay(MBR → app), appl deposit(config, axfer, pay)]` with optional separate app-call sender (fee payer). Use `open_mbr` (readonly, via simulate) to size the MBR payment.
  - claim batch: one app call with `Claim[]`; compute extra fee for op-ups (`n × 2600` budget → about `ceil(n × 2600 / 700)` op-up inner txns); populate box refs (`"c"+channelId` per row, `"u"+receiver+assetId`). Prefer algokit-utils resource population via simulate. Find the max rows per call empirically and export it as a constant.
  - settle, refund, initiate/finalize withdraw, `getChannel` (read box directly via algod and decode ARC-4 struct; fall back to readonly call).
- `contracts/tests/localnet/`: port every offline test to real transactions **plus**: fee pooling works; op-up budget suffices for max batch; box MBR math equals `open_mbr`; signature produced by `@turnstile/core` (golden vector flow, but with the real app id and LocalNet genesis) is accepted; timestamps: use `algod` dev-mode block timestamp offset (`/v2/devmode/blocks/offset`) to advance time for withdraw tests.
- **Exit:** I1–I7, I9, I10 green on LocalNet.

### P2 — x402 mechanism plugin: client + server (`packages/x402-avm-batch`)
Mirror `evm/src/batch-settlement/{client,server}` file by file. Implement:
- **Client** `BatchSettlementAvmScheme implements SchemeNetworkClient`
  - deposit policy (`minDeposit` or `amount × depositMultiplier`, capped by `maxDeposit`), channel config construction (payer from signer, `payerAuthorizer` = session key, random or deterministic salt), channel id, deposit payload with `paymentGroup`, voucher payload, refund payload.
  - local channel storage (in-memory + file), steady-state update rules, cold-start recovery from on-chain `totalClaimed`, corrective-402 handling (verify `voucherState.signature` with own key before adopting server state).
  - verify `extra.appId` against configured canonical app id.
- **Server** `BatchSettlementAvmScheme implements SchemeNetworkServer`
  - `parsePrice` using `@x402/avm` default assets; `enrichPaymentRequiredResponse` adds `appId`, `receiverAuthorizer`, `withdrawDelay`, `minDeposit`, `feePayer`, and corrective `channelState`/`voucherState`.
  - channel manager with per-channel mutex, ChannelStorage (memory + SQLite), local voucher verification path, on-chain mirror refresh with TTL, rules from spec §6, `chargedCumulativeAmount += actual` only after handler success, dynamic charge API for handlers (e.g. `res.locals.x402.setCharge(actual)` or whatever hook the EVM server uses — mirror it).
  - Idempotent retry cache keyed by `(channelId, maxClaimableAmount)` like SVM.
- **Exit:** unit tests for every rule + an in-process E2E (client ↔ server with a mocked facilitator) for flat and dynamic pricing, corrective 402, cold start, 50 concurrent requests on one channel.

### P3 — Facilitator + demo apps
- `packages/x402-avm-batch/src/facilitator` + `apps/facilitator` (HTTP `/verify`, `/settle`, `/supported`): validates and submits deposit groups (sign as fee payer only after the §6.7 checks + simulate), returns channel snapshots, performs cooperative refunds (claim then refund), exposes claim/settle for the settler.
- `apps/demo-merchant`: `@x402/express` `paymentMiddleware` with **two** accepted options per route: `batch-settlement` (our scheme, our facilitator) and `exact` (`@x402/avm`, GoPlausible facilitator URL from env). Routes: `POST /v1/infer` dynamic per output token (stub model by default), `GET /v1/data` flat.
- `apps/demo-agent`: `@x402/fetch` with our client scheme registered for `algorand:*`; `--mode batch|exact --calls N --concurrency K`.
- **Exit:** on LocalNet, agent completes 200 dynamic-priced calls through a single channel; merchant DB, on-chain state and agent state agree.

### P4 — Settler (`packages/settler`)
- Policies: threshold (unclaimed ≥ T), periodic (age ≥ A), on-withdraw (channel has `withdrawRequestedAt ≠ 0` → claim immediately). Then `settle(receiver, asset)` when unsettled ≥ S.
- Batch rows up to the P1 constant; idempotent (contract no-ops stale rows); re-read state before submit; mark claimed after confirmation; survive restarts.
- Startup assertion: `pollInterval × 3 < withdrawDelay`.
- **Exit:** I8 test: payer initiates withdraw mid-session, settler claims highest voucher before the delay; payer finalizes and receives exactly `balance − totalClaimed`.

### P5 — Adversary suite (`packages/adversary`) — every attack MUST be rejected
Contract-level (LocalNet): replay lower voucher; voucher from channel A on B; other app id; other genesis; bit-flipped sig; wrong signer; `maxClaimable > balance`; `totalClaimed > maxClaimable`; non-receiver claim; non-receiver refund; non-payer withdraw/finalize; finalize before delay; deposit with rekey / close_to / clawback / wrong asset / wrong receiver / sender ≠ payer; top-up with mismatched config; drain + re-fund + replay.
Server-level: stale voucher; skipped increment (`max ≠ charged + amount`); forged corrective-402 state (client must reject); voucher above mirrored balance; voucher during withdraw window past safety margin; malicious deposit group for fee payer (extra txn, fee > cap, rekey in any txn, different app id/method).
Fuzz: random op sequences on LocalNet (≥ 500 steps) asserting I1–I3 after each.
Output `packages/adversary/report.json` (attack, layer, expected, actual, pass). Non-zero exit on any accepted attack.

### P6 — Benchmark + dashboard + TestNet
- `pnpm bench`: N ∈ {50, 200, 1000}; modes batch vs exact (exact on LocalNet via a local exact facilitator from `@x402/avm`, or TestNet GoPlausible). Record wall time, p50/p95 added latency, on-chain txn count, total fees → `bench.json`.
- Dashboard (React/Vite, polls a read-only API exposed by merchant + settler): channels (deposit, charged, signed max, claimed, exposure, withdraw countdown), settlement feed with explorer links, bench chart, adversary report, NFD name resolution for addresses (optional, cache results).
- Deploy escrow to TestNet (`pnpm deploy:testnet`), run the full demo script in `docs/DEMO.md`.
- **Exit:** demo script runs end-to-end on TestNet.

### P7 — Spec, docs, polish
- Finalize `docs/spec/scheme_batch_settlement_avm.md` against what was built (field names, errors, examples from real runs).
- README: 60-second pitch, architecture diagram (mermaid), quickstart (LocalNet in < 5 commands), security model, limitations.
- Optional (only if `docs/DECISIONS.md` records team approval): MainNet `exact` endpoint via GoPlausible with Bazaar + `x402-global-challenge` tag. The escrow contract stays off MainNet until reviewed.

---

## 5. Contract facts you must respect

- Voucher message (102 bytes): `"x402-avm-bs-voucher-v1" ‖ genesisHash(32) ‖ itob(appId) ‖ channelId(32) ‖ itob(maxClaimable)`.
- `channelId = sha256("x402-avm-bs-channel-v1" ‖ genesisHash ‖ itob(appId) ‖ arc4(config))`.
- `claim` asserts sender ∈ {receiver, receiverAuthorizer}; stale rows are **no-ops**, not reverts.
- `deposit` requires `axfer.sender == config.payer`; the app-call sender can be a fee payer.
- Channel boxes are never deleted (replay protection). Box value = 208 bytes, key = 33 bytes → MBR 98,900 µALGO; unsettled box key 41 + value 8 → 22,100 µALGO. Use `open_mbr` rather than hard-coding.
- Timestamps are `Global.latest_timestamp` (seconds). On LocalNet use dev-mode timestamp offset to test delays.
- All inner txns fee 0 → callers pool fees.

## 6. Storage schema (SQLite reference impl; mirror EVM ChannelStorage semantics)

```sql
CREATE TABLE channels (
  channel_id TEXT PRIMARY KEY,           -- b64
  config_json TEXT NOT NULL,
  charged_cumulative TEXT NOT NULL,      -- decimal string (bigint)
  signed_max_claimable TEXT NOT NULL,
  signature TEXT NOT NULL,               -- b64
  balance TEXT NOT NULL, total_claimed TEXT NOT NULL,
  withdraw_requested_at INTEGER NOT NULL DEFAULT 0,
  onchain_synced_at INTEGER NOT NULL, last_request_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0     -- optimistic concurrency
);
CREATE TABLE responses (channel_id TEXT, max_claimable TEXT, body BLOB, headers TEXT,
  PRIMARY KEY (channel_id, max_claimable));
CREATE TABLE claims (tx_id TEXT PRIMARY KEY, round INTEGER, rows_json TEXT, total TEXT, created_at INTEGER);
```
All bigint values as decimal strings. Updates via `UPDATE … WHERE version = ?`.

## 7. Known AVM pitfalls

- `ed25519verify_bare`, not `ed25519verify` (the latter prefixes `ProgData` + program hash).
- Box refs and foreign refs are limited per txn; share via group or let simulate populate them.
- Opcode budget pools across the group; `ensure_budget(..., GroupCredit)` needs outer extra fee.
- Asset receiver must be opted in: the app opts in via `opt_in_asset`; receivers/payers need USDC opt-in (fund test accounts accordingly).
- CAIP-2 network ids are **truncated** genesis hashes; message encodings use the **full** 32-byte hash.
- Fee caps: reuse `MAX_REASONABLE_FEE_PER_TXN` logic from `@x402/avm` when signing as fee payer.
- `algod` simulate with `allowUnnamedResources` is great for discovery; do not rely on it in production submits.

## 8. Style

TypeScript strict, no `any`, amounts are `bigint` internally and decimal strings on the wire. Typed
errors with stable codes from `packages/core/src/wire.ts`. Pure functions in core; side effects at the
edges. Structured JSON logs. Every public function tested. Test names include invariant ids
(`I3_conservation`).

## 9. Invariants (acceptance tests)

| ID | Invariant | Layer |
|---|---|---|
| I1 | `totalClaimed ≤ balance` always | contract |
| I2 | `totalClaimed` monotonic | contract |
| I3 | Conservation: deposited = (balance − totalClaimed) + unsettled + settled-out + refunded/withdrawn | contract |
| I4 | Voucher valid only for its (genesis, app, channel) | contract + server |
| I5 | Role checks: only receiver side claims/refunds; only payer side withdraws | contract |
| I6 | After a drain (refund/withdraw), no voucher can claim beyond the remaining balance; re-funding cannot resurrect old vouchers | contract |
| I7 | Payer can always recover unclaimed funds after the delay without receiver cooperation | contract |
| I8 | An online settler claims the highest accepted voucher before a withdrawal finalizes | settler |
| I9 | Server never accepts `maxClaimable > mirrored balance` and never increments `charged` beyond the signed max | server |
| I10 | Box MBR sizing: `open_mbr` equals the real MBR delta on LocalNet | contract |
| I11 | Client never adopts server state without verifying its own voucher signature | client |
| I12 | Per-channel serialization: K concurrent requests → charged == Σ actual, no double-accept | server |

## 10. Definition of done

`pnpm contracts:test && pnpm contracts:localnet && pnpm test && pnpm adversary && pnpm bench` all green
on a clean clone with LocalNet; TestNet demo script executed and recorded; spec finalized; README quickstart
verified from scratch.
