# @turnstile/x402-avm-batch

The x402 `batch-settlement` scheme plugin for `@x402/core`, targeting the Algorand Virtual Machine.
Mirrors the official EVM batch-settlement mechanism's structure and naming, adapted for AVM's
ed25519-voucher/box-storage design — see `docs/spec-notes.md` for the deviations and
`docs/DECISIONS.md` for this package's scope cuts (no pending-request TTL reservation system, no
auto claim/settle/refund loop — that's `@turnstile/settler`).

- **`server/`** — `BatchSettlementAvmScheme` (implements `SchemeNetworkServer`) +
  `BatchSettlementChannelManager` (voucher verification, I4/I9 bound checks against a mirrored
  on-chain balance, atomic charge commits) + `ChannelStorage` (in-memory; swap in a DB-backed
  implementation for production).
- **`client/`** — `BatchSettlementAvmClientScheme` (implements `SchemeNetworkClient`): builds
  deposit payloads cold and voucher payloads in steady state, verifies any server-reported
  corrective-402 state against its own public key before adopting it (I11).
- **`facilitator/`** — `BatchSettlementAvmFacilitatorScheme` (implements `SchemeNetworkFacilitator`):
  validates vouchers/deposits/refunds and submits the on-chain `refund()` call.

```ts
import { x402ResourceServer } from '@x402/core/server';
import { BatchSettlementAvmScheme } from '@turnstile/x402-avm-batch';

const scheme = new BatchSettlementAvmScheme({ deployment, appId, receiverAuthorizer, fetchOnchain, network });
const server = new x402ResourceServer(facilitatorClient).register(network, scheme);
```

See `apps/demo-merchant`, `apps/facilitator`, and `apps/demo-agent` for a full working wiring.
