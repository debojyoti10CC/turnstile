# @turnstile/core

**The shared vocabulary of Turnstile's Algorand batch-settlement scheme.** Pure, dependency-light
primitives with no chain I/O and no HTTP: address codec, ed25519 voucher signing/verification,
channel-id and voucher-message encoding (byte-for-byte identical to the on-chain contract's own
encoding), the wire types every other package passes over HTTP, and CAIP-2 network-id helpers.

```bash
npm install @turnstile/core
```

Safe to import from a browser, a CLI, a server, or a test file — nothing in this package touches a
network, a filesystem, or the clock.

## Why it's separate

The client, server, and facilitator schemes in [`@turnstile/x402-avm-batch`](../x402-avm-batch) all
need to construct the exact same channel-id and voucher-message bytes the on-chain contract
verifies with `ed25519verify_bare`. Getting that encoding wrong in even one byte means signatures
silently fail to verify on-chain while looking fine in TypeScript. Centralizing it here — with
[golden test vectors](test/vectors.json) checked against the contract's own emulator tests — is what
makes "TS↔contract signature parity" a real, continuously-verified property instead of an assumption.

## Quickstart

```ts
import { newSessionKey, signVoucher, channelId, encodeAddress, toB64, type ChannelConfig, type Deployment } from '@turnstile/core';

// A session key is the "hot" key that signs a voucher on every request --
// see the security model in the top-level README for why it's never the
// same key that holds funds.
const session = await newSessionKey(); // { sk, pk }

const config: ChannelConfig = {
  payer, payerAuthorizer: encodeAddress(session.pk),
  receiver, receiverAuthorizer,
  asset: assetId.toString(),
  withdrawDelay: 900, // seconds
  salt: toB64(crypto.getRandomValues(new Uint8Array(32))),
};
const deployment: Deployment = { genesisHash, appId };

const cid = channelId(config, deployment);
const signature = await signVoucher(session.sk, deployment, cid, maxClaimable);
```

## API reference

| Module | Exports |
|---|---|
| `address` | `encodeAddress(publicKey)`, `decodeAddress(algorandAddress)` — Algorand's checksummed base32 address format |
| `bytes` | `u64be`, `concat`, `toHex`/`fromHex`, `toB64`/`fromB64`, `eq` — the byte-level building blocks every encoder above uses |
| `config` | `ChannelConfig`, `Deployment` interfaces; `encodeConfig(config)` (ARC-4 struct encoding); `channelId(config, deployment)` |
| `voucher` | `voucherMessage(deployment, channelId, maxClaimable)`, `signVoucher(secretKey, ...)`, `verifyVoucher(publicKey, ...)`, `newSessionKey()`, `publicKeyOf(secretKey)` |
| `constants` | `SCHEME`, `VOUCHER_PREFIX`/`CHANNEL_PREFIX` (domain-separation bytes, must match `contract.py` byte-for-byte), `CAIP2` (MainNet/TestNet ids), `GENESIS_HASH_B64`, `USDC_ASA_ID`, `WITHDRAW_DELAY_MIN`/`MAX`, `caip2FromGenesisHash(hash)` |
| `wire` | HTTP wire types (`ChannelConfigWire`, `VoucherWire`, `AvmBatchPayload`, `ChannelStateWire`, `SettlementResponseAvmBatch`), converters (`configToWire`/`configFromWire`/`channelIdFromWire`), type guards (`isDepositPayload`/`isVoucherPayload`/`isRefundPayload`), and `ERR` — every stable error code this scheme can return |

## Encoding this package implements

- **`channelId = sha256("x402-avm-bs-channel-v1" ‖ genesisHash(32) ‖ itob(appId) ‖ arc4(config))`**
- **Voucher message (102 bytes):**
  `"x402-avm-bs-voucher-v1" ‖ genesisHash(32) ‖ itob(appId) ‖ channelId(32) ‖ itob(maxClaimable)`
- Signatures are raw ed25519 over that message — the contract checks them with
  `ed25519verify_bare`, not `ed25519verify` (which prepends `ProgData` + a program hash; using the
  wrong opcode is a classic AVM pitfall this package's tests exist partly to catch).

Full byte layout and field-by-field rationale: [`docs/spec/scheme_batch_settlement_avm.md`](../../docs/spec/scheme_batch_settlement_avm.md).

## Testing

```bash
pnpm -F @turnstile/core test
```

11 tests, including round-trip encode/decode, cross-checking `channelId`/`voucherMessage` output
against [`test/vectors.json`](test/vectors.json) — the same golden vectors the Python contract's
offline test suite checks against, so a change here that silently breaks on-chain compatibility
fails in CI on both sides, not just one.
