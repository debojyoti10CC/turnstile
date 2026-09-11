# Scheme: `batch-settlement` on `AVM` (Algorand)

> Status: **draft v0.2** (Turnstile) — verified against a working reference implementation (contract,
> TypeScript SDK, facilitator, demo merchant/agent, 24/24-attack adversary suite, and a live deployment
> on Algorand TestNet; see `docs/PROGRESS.md`). Companion to the network-agnostic
> [`scheme_batch_settlement.md`](../reference/scheme_batch_settlement.md). Structure and field names
> mirror the EVM and SVM bindings ([evm](../reference/scheme_batch_settlement_evm.md),
> [svm](../reference/scheme_batch_settlement_svm.md)) so this document can be upstreamed as
> `specs/schemes/batch-settlement/scheme_batch_settlement_avm.md`. Known deviations from this document
> in the reference implementation are called out inline and tracked in `docs/DECISIONS.md`.
> Reference contract: `contracts/smart_contracts/x402_batch_settlement/contract.py`.

## 1. Summary

A **capital-backed** binding using unidirectional payment channels held by one Algorand application
(the *escrow app*). A client deposits an ASA (typically USDC) into a channel once, then signs an
ed25519 **cumulative voucher** per request. The server verifies vouchers off-chain with a single
signature check, serves immediately, and later claims many channels in one app call. Claimed funds
accumulate per `(receiver, asset)` and are swept to the receiver by a permissionless `settle`.

Dynamic pricing: the voucher authorizes a ceiling (`maxClaimableAmount`); the receiver side claims the
actual charged total (`totalClaimed ≤ maxClaimableAmount`).

## 2. Mapping the core requirements to AVM

| Requirement | AVM mechanism |
|---|---|
| Commitment format | ed25519 signature over a 102-byte domain-separated message (§4) |
| Verification | `ed25519verify_bare` on-chain; any ed25519 library off-chain |
| Storage | Server stores latest voucher per channel; commitment id = `b64(channelId) + ":" + maxClaimableAmount` |
| Double-spend prevention | Cumulative vouchers + on-chain monotonic `totalClaimed`; channel boxes are never deleted |
| Expiry | Vouchers carry no expiry; `withdrawDelay` bounds the redemption window after a timed withdrawal |
| Redemption | Receiver or receiverAuthorizer calls `claim(rows[])`; anyone calls `settle(receiver, asset)` |
| Trust model | Capital-backed. Client risks at most the signed ceiling; receiver risks unclaimed vouchers if it misses the withdraw window |

## 3. Escrow application

One app per network (canonical id is an SDK constant; clients MUST NOT trust an app id solely because a
402 advertised it, see §7).

### 3.1 Channel config (immutable, ARC-4 static struct, 176 bytes)

| Field | Type | Notes |
|---|---|---|
| payer | address | Signs the deposit asset transfer; receives refunds/withdrawals |
| payerAuthorizer | address (ed25519 pk) | Voucher signing key. Usually a session key distinct from `payer` |
| receiver | address | `payTo` |
| receiverAuthorizer | address | May claim and refund (as may `receiver`) |
| asset | uint64 | ASA id |
| withdrawDelay | uint64 | Seconds, 900–2,592,000 |
| salt | byte[32] | Differentiates otherwise identical channels |

`channelId = sha256("x402-avm-bs-channel-v1" ‖ genesisHash ‖ itob(appId) ‖ arc4(config))`.

### 3.2 Channel state (box `"c" ‖ channelId`)

`config`, `balance` (deposited − refunded − withdrawn), `totalClaimed` (monotonic),
`withdrawRequestedAt` (unix seconds, 0 = none), `withdrawAmount`.
Boxes are **never deleted**: deleting would reset `totalClaimed` and allow replay of old vouchers if the
same config is re-funded. Clients rotate `salt` for a fresh channel.

### 3.3 Methods

| Method | Caller | Effect |
|---|---|---|
| `opt_in_asset(asset, pay)` | anyone | App opts into an ASA (pay ≥ 0.1 ALGO MBR) |
| `deposit(config, axfer, pay) → channelId` | anyone (e.g. fee payer) | `axfer.sender == payer`, receiver = app, no close/rekey/clawback. Creates channel on first deposit (validates `withdrawDelay`, `payer ≠ receiver`), else tops up (config must match). `pay` covers new box MBR (`open_mbr(config)`), may be 0 otherwise |
| `claim(Claim[]) → uint64` | receiver or receiverAuthorizer of every row | Per row: `totalClaimed ≤ maxClaimable ≤ balance`; if `totalClaimed > onchain.totalClaimed`, verify voucher and add delta to `unsettled[receiver, asset]`; otherwise no-op (idempotent retries) |
| `settle(receiver, asset) → uint64` | anyone | Inner transfer of `unsettled[receiver, asset]` to `receiver` |
| `refund(channelId, amount) → uint64` | receiver / receiverAuthorizer | Returns `min(amount, balance − totalClaimed)` to payer immediately; caps or cancels a pending withdrawal |
| `initiate_withdraw(channelId, amount)` | payer / payerAuthorizer | `0 < amount ≤ balance − totalClaimed`; starts the delay |
| `finalize_withdraw(channelId) → uint64` | payer / payerAuthorizer | After `withdrawRequestedAt + withdrawDelay`: returns `min(withdrawAmount, balance − totalClaimed)` |
| `get_channel`, `get_unsettled`, `channel_id`, `voucher_message`, `open_mbr` | readonly | Views for clients, servers, tests |

`Claim = { channelId: byte[32], maxClaimable: uint64, signature: byte[64], totalClaimed: uint64 }`.

Fees: all inner transactions use fee 0; the outer transaction pools fees. `claim` calls
`ensure_budget(n × 2600)` with group-credit op-ups; the submitter must add enough extra fee.

One `claim` call's row count is bounded by Algorand's per-transaction box-reference limit
(`MAX_APP_CALL_FOREIGN_REFERENCES = 8`), not by opcode budget (empirically never the binding
constraint — see `docs/DECISIONS.md`, 2026-09-11). Each row needs its own channel box plus one
shared unsettled-balance box per distinct receiver, so the exact cap is 7 rows when every row
shares a receiver (`MAX_CLAIM_ROWS_PER_CALL_SAME_RECEIVER`) down to 4 when every row has a
different receiver (`MAX_CLAIM_ROWS_PER_CALL`); `@turnstile/escrow-client`'s `claimBatch` enforces
this bound and chunks larger batches into multiple calls.

## 4. Voucher

```
message = "x402-avm-bs-voucher-v1" (22 B) ‖ genesisHash (32 B) ‖ itob(appId) (8 B) ‖ channelId (32 B) ‖ itob(maxClaimableAmount) (8 B)
signature = Ed25519(payerAuthorizer_sk, message)      // raw; verified with ed25519verify_bare
```
`genesisHash` is the full 32-byte genesis hash (not the CAIP-2 truncation). Distinct prefixes per signed
type prevent cross-function replay if more signed messages are added later.

## 5. Wire format (x402 v2)

Transport is unchanged: `PAYMENT-REQUIRED` on 402, `PAYMENT-SIGNATURE` on the paid request,
`PAYMENT-RESPONSE` on the response.

### 5.1 PaymentRequirements

```json
{
  "scheme": "batch-settlement",
  "network": "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
  "amount": "1000",
  "asset": "<USDC ASA id>",
  "payTo": "<receiver address>",
  "maxTimeoutSeconds": 300,
  "extra": {
    "appId": "<escrow app id>",
    "receiverAuthorizer": "<address>",
    "withdrawDelay": 900,
    "minDeposit": "1000000",
    "feePayer": "<optional sponsor address for deposit groups>"
  }
}
```
`amount` is the per-request **maximum**. `extra.channelState` / `extra.voucherState` appear only in
corrective 402s (as in EVM/SVM).

### 5.2 PaymentPayload variants

- `deposit`: `{ type, channelConfig, voucher, deposit: { amount, paymentGroup: [b64 txns] } }`.
  `paymentGroup` is `[axfer(payer→app), pay(MBR), appl(deposit)]`. The client signs the axfer (and pay
  if it funds MBR). The spec permits a sponsored variant where `extra.feePayer` is set and the appl
  sender is a fee payer who co-signs after validation (same pattern as `exact` on Algorand); **this
  reference implementation does not use it** — the client/agent submits its own fully-signed deposit
  group directly (see `docs/DECISIONS.md`), so `extra.feePayer` is always absent on the wire here.
- `voucher`: `{ type, channelConfig, voucher: { channelId, maxClaimableAmount, signature } }`.
- `refund`: zero-charge voucher (`maxClaimableAmount == chargedCumulativeAmount`) plus optional `amount`.

Byte fields on the wire are base64; amounts are decimal strings; addresses are Algorand base32.

### 5.3 SettlementResponse

Voucher-only: `transaction: ""`, `amount: ""`, `extra: { commitmentId, chargedAmount, channelState }`.
Deposit: `transaction` = deposit group's app-call txid, `amount` = deposited amount.
Refund: `transaction` = refund txid, `amount` = refunded amount, no `chargedAmount`.

## 6. Server rules

Identical to EVM §"Server: State & Forwarding" with these AVM specifics:

1. Recompute `channelId` from `channelConfig` + canonical `(genesisHash, appId)`; reject mismatch.
2. `channelConfig.receiver == payTo`, `receiverAuthorizer == extra.receiverAuthorizer`, `asset == asset`,
   `withdrawDelay == extra.withdrawDelay`.
3. Verify the ed25519 signature against `channelConfig.payerAuthorizer`.
4. Fresh voucher MUST satisfy `maxClaimableAmount == chargedCumulativeAmount + amount` (else corrective
   402) and `maxClaimableAmount ≤ balance` (mirrored on-chain state, refreshed when stale).
5. Serialize per channel. Update state only after the handler succeeds:
   `chargedCumulativeAmount += actual` with `actual ≤ amount`.
6. If `withdrawRequestedAt ≠ 0`, the server SHOULD refuse new vouchers whose value it cannot claim before
   `withdrawRequestedAt + withdrawDelay − safetyMargin`, and MUST claim outstanding vouchers before then.
7. Deposit groups: before signing as fee payer, verify group size, order, app id, method selector,
   argument equality with `channelConfig`, `axfer` fields, no rekey/close fields on any txn, and a
   fee cap. Simulate before submitting. (Not exercised by this reference implementation, which never
   acts as fee payer for a deposit — see rule 7 of §5.2.)

## 7. Client rules

Same as EVM §"Client Verification Rules" (local state is authoritative; `PAYMENT-RESPONSE` is untrusted;
corrective 402 accepted only with a voucher signature the client verifies against its own key). AVM additions:
the client MUST check `extra.appId` against its configured canonical app id for the network and MUST cap
deposits locally.

## 8. Security

1. Client capital risk ≤ signed `maxClaimableAmount`; over-claiming within the ceiling is a trust
   violation, not a protocol violation (same as EVM).
2. Cumulative accounting and non-deleted boxes make nonces unnecessary.
3. Cross-network and cross-deployment replay prevented by `genesisHash` and `appId` in both
   `channelId` and the voucher message.
4. Withdraw delay bounds (15 min–30 days) protect both sides.
5. Hot-key blast radius: compromise of `payerAuthorizer` can only sign vouchers (bounded by deposit) or
   start a withdrawal that pays `payer`.

## 9. Error codes

`invalid_batch_settlement_avm_*`, mirroring the EVM list where applicable; see
`packages/core/src/wire.ts` for the canonical set.
