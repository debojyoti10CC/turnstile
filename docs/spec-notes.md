# Spec notes — AVM `batch-settlement` vs. the EVM binding

Written against `.refs/x402` at the commit in `docs/reference/UPSTREAM_COMMIT.txt`
(`3c2ddfb9`), specifically `typescript/packages/mechanisms/evm/src/batch-settlement/`.
`typescript/packages/mechanisms/avm/` currently only implements `exact` — there is no
upstream AVM `batch-settlement` to diff against, so this scheme is new, mirrored
structurally off the EVM one.

## Header names (unchanged across mechanisms, from `@x402/core`)

Confirmed from `.refs/x402/typescript/packages/core/src/http/x402HTTPClient.ts`:
the 402 response body is plain JSON (no special header carries it), the client
sends `X-PAYMENT` on the retried request, and the server replies with
`X-PAYMENT-RESPONSE`. The doc-comment in `packages/core/src/wire.ts` calling
these `PAYMENT-REQUIRED`/`PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE` is stale —
**fix that comment in P2** when `x402-avm-batch` actually wires headers; no
code currently depends on the wrong names so it's a doc-only fix, not urgent.

## Payload shapes

EVM `types.ts` defines `BatchSettlementDepositPayload | VoucherPayload | RefundPayload`
(client→server) and a separate `BatchSettlementFacilitatorSettlePayload` union
(server→facilitator: deposit | claim | settle | enrichedRefund). Our
`packages/core/src/wire.ts` already mirrors the client-facing union
(`AvmBatchPayload`) with AVM substitutions:

| EVM field | AVM equivalent | Why |
|---|---|---|
| `token: 0x...` | `asset: string` (ASA id) | ARC-200/ASA instead of ERC-20 |
| `deposit.authorization.{erc3009,permit2}` | `deposit.paymentGroup: string[]` (b64 msgpack txns) | AVM has no meta-tx standard; the payer co-signs a transaction group (`axfer(payer→app), pay(MBR→app), appl deposit(...)`) instead of an off-chain-signed authorization blob |
| `refundNonce: bigint` (EVM tracks nonce for replay-safe refunds) | *(not yet modeled)* | Our contract's refund path needs the same replay guard — **add `refundNonce` to `ChannelStateWire` in P1** once the contract's refund semantics are locked; currently absent from `wire.ts` |
| `chargedCumulativeAmount` | present (`ChannelStateWire`) | kept as-is |

The facilitator-side union (claim batch, settle, deposit submission) does not exist
yet in `packages/core` — it belongs in `packages/escrow-client` (P1) /
`packages/x402-avm-batch/src/facilitator` (P3), not in core, since it is
algod-transaction-shaped rather than wire-shaped.

## Hooks to implement (from `SchemeServerHooks` / `SchemeNetworkClient`)

Server (`server/verify.ts` + `server/settle.ts` in the EVM package):
`beforeVerify`, `afterVerify`, `enrichPaymentRequiredResponse`, `verifyFailure`,
`verifiedPaymentCanceled`, `beforeSettle`, `afterSettle`,
`enrichSettlementPayload`, `enrichSettlementResponse`, `settleFailure`.
`packages/x402-avm-batch/src/server/` must export the same ten hooks with AVM
channel-manager logic swapped in; file-by-file mirror: `scheme.ts`,
`channelManager.ts`, `storage.ts`, `verify.ts`, `settle.ts`, `utils.ts`.

Client (`client/scheme.ts` + `client/hooks.ts`): deposit-policy hook, channel
config construction, steady-state update, cold-start recovery, corrective-402
adoption (must re-verify own voucher signature before trusting server state —
invariant I11). No AVM-specific deviation expected here beyond signer type
(`AuthorizerSigner` becomes an ed25519 keypair instead of a `viem` typed-data
signer) and deposit construction (txn group vs. EIP-3009/Permit2 signature).

## Storage interface

EVM `server/storage.ts` defines `ChannelStorage` with `get/set/list` over a
`Channel` record plus optimistic-concurrency `version`. CLAUDE.md §6 already
specifies our SQLite schema 1:1 with that shape (decimal-string bigints,
`version` column, `responses`/`claims` side tables for idempotent replay and
settler bookkeeping). No deviation — implement `ChannelStorage` interface in
`packages/x402-avm-batch/src/server/storage.ts` mirroring the EVM file, with
`InMemoryChannelStorage` (named to match EVM) plus a `SqliteChannelStorage`.

## What differs on AVM (beyond the payload/storage notes above)

- **No meta-transaction signature for deposits.** The payer must co-sign a real
  transaction group; the "deposit payload" carries partially-signed txns, not a
  typed-data signature. This pushes more responsibility onto the client's txn
  builder (`packages/escrow-client`) than the EVM client needs.
- **Claims are accounting-only; `settle` is a separate sweep** (see
  `docs/DECISIONS.md`), whereas EVM transfers tokens at claim time. The settler
  (P4) must call `claim` then `settle` as two steps, and the facilitator
  `/settle` endpoint name maps to our on-chain `settle`, not `claim`.
- **Box MBR, opcode budget, inner-txn fee pooling** are AVM-specific resource
  constraints with no EVM analog; encoded in CLAUDE.md §5/§7, not reflected in
  the EVM reference at all.
- **Voucher message format is fixed-width binary** (102 bytes, ASCII domain tag
  + genesis hash + app id + channel id + max claimable), not EIP-712 typed
  data. Already implemented in `packages/core/src/voucher.ts`.
- **No `expiresAt` field** (see DECISIONS.md) — EVM binding doesn't have one
  either at the type level shown here, consistent with our choice.

## Open item carried into P1/P2

Header-name TODO above; `refundNonce` field gap; facilitator-side payload types
still to be written in `packages/escrow-client` / `x402-avm-batch/facilitator`.
