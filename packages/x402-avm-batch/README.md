# @turnstile/x402-avm-batch

**The x402 `batch-settlement` scheme for Algorand.** A drop-in plugin for the official
[`@x402/core`](https://www.npmjs.com/package/@x402/core) SDK — implements `SchemeNetworkClient`,
`SchemeNetworkServer`, and `SchemeNetworkFacilitator`, the exact interfaces the official `exact`
scheme implements, so it works with unmodified [`@x402/express`](https://www.npmjs.com/package/@x402/express)
and [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch).

Register it once, then every subsequent paid request is a local ed25519 signature check — no
blockchain round-trip — until a settler batches many vouchers into a handful of real transactions.

```bash
npm install @turnstile/x402-avm-batch @x402/core algosdk
```

## Why

x402's `batch-settlement` scheme (channel deposits + off-chain signed vouchers + batched on-chain
claims) has reference bindings for EVM and SVM chains. This is the missing Algorand binding, built
to the same wire contract. If you already know `@x402/avm`'s `exact` scheme, this slots in as a
second `accepts` option on the same route — same middleware, same client, different economics for
high-frequency callers (AI agents, per-token billing, anything calling your API hundreds of times a
session).

## Quickstart

### Server (Express)

```ts
import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express';
import { caip2FromGenesisHash } from '@turnstile/core';
import { getAppClient, getChannel } from '@turnstile/escrow-client';
import { BatchSettlementAvmScheme, SqliteChannelStorage } from '@turnstile/x402-avm-batch';

const algorand = AlgorandClient.defaultLocalNet(); // or .testNet() / .mainNet()
const appClient = getAppClient(algorand, appId);
const params = await algorand.client.algod.getTransactionParams().do();
const network = caip2FromGenesisHash(params.genesisHash);

const scheme = new BatchSettlementAvmScheme({
  deployment: { genesisHash: params.genesisHash, appId },
  appId,
  receiverAuthorizer: receiverAuthorizerAddress,
  withdrawDelay: 900, // seconds; 15 min – 30 days
  network,
  // On-chain mirror used for cold-start recovery and periodic balance
  // refresh -- read the channel box directly rather than trusting anything
  // cached, since the server must never accept a voucher above real balance.
  fetchOnchain: async (channelId) => {
    const state = await getChannel(algorand, appClient, channelId);
    return state && { balance: state.balance, totalClaimed: state.totalClaimed, withdrawRequestedAt: Number(state.withdrawRequestedAt) };
  },
  // Optional: defaults to an in-memory store, fine for a demo. Pass this to
  // persist across restarts and let a separate settler process share it.
  storage: new SqliteChannelStorage('./channels.sqlite'),
});

const facilitator = new HTTPFacilitatorClient({ url: 'http://localhost:4402' });
const resourceServer = new x402ResourceServer(facilitator).register(network, scheme);

app.use(
  paymentMiddleware(
    {
      '/v1/data': { accepts: { scheme: 'batch-settlement', payTo: receiverAddress, network, price: { amount: '1000', asset: assetId } } },
    },
    resourceServer,
  ),
);
```

### Client (`@x402/fetch`)

The scheme generates and holds its own session key per channel internally (in `ClientChannelStorage`)
— you only need to supply the payer's address and a function that builds and submits the one-time
on-chain deposit when a channel opens cold. This keeps the scheme class chain-I/O-free and unit-testable.

```ts
import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { caip2FromGenesisHash } from '@turnstile/core';
import { deposit, getAppClient } from '@turnstile/escrow-client';
import { BatchSettlementAvmClientScheme, type BuildDepositGroup } from '@turnstile/x402-avm-batch';

const algorand = AlgorandClient.defaultLocalNet();
algorand.account.setSigner(payerAddress, payerSigner); // your signer for the payer's key
const appClient = getAppClient(algorand, appId);
const params = await algorand.client.algod.getTransactionParams().do();
const deployment = { genesisHash: params.genesisHash, appId };
const network = caip2FromGenesisHash(params.genesisHash);

const buildDepositGroup: BuildDepositGroup = async ({ config, amount }) => {
  const channelId = await deposit({ algorand, appClient, config, amount }, deployment);
  return { paymentGroup: [Buffer.from(channelId).toString('base64')] };
};

const clientScheme = new BatchSettlementAvmClientScheme({
  payerAddress,
  deployment,
  buildDepositGroup,
  depositMultiplier: 10, // fresh deposit sized as max(minDeposit, price * depositMultiplier)
});

const x402client = new x402Client().register(network, clientScheme);
const fetchWithPayment = wrapFetchWithPayment(fetch, x402client);

const res = await fetchWithPayment('https://your-merchant.example/v1/data');
```

### Facilitator

```ts
import { BatchSettlementAvmFacilitatorScheme } from '@turnstile/x402-avm-batch';
import { refund } from '@turnstile/escrow-client';

const scheme = new BatchSettlementAvmFacilitatorScheme({
  channelManager,
  receiverAuthorizerAddress,
  executeRefund: (args) => refund({ appClient, sender: receiverAuthorizerAddress, ...args }),
});

app.post('/verify', async (req, res) => res.json(await scheme.verify(req.body.paymentPayload, req.body.paymentRequirements)));
app.post('/settle', async (req, res) => res.json(await scheme.settle(req.body.paymentPayload, req.body.paymentRequirements)));
app.get('/supported', (_req, res) => res.json({ kinds: [{ x402Version: 2, scheme: scheme.scheme, network }], signers: {} }));
```

See [`apps/facilitator`](../../apps/facilitator), [`apps/demo-merchant`](../../apps/demo-merchant),
and [`apps/demo-agent`](../../apps/demo-agent) in this repo for complete, running wiring —
everything above is extracted from code that's actually deployed and tested, not illustrative pseudocode.

## API reference

| Export | What it is |
|---|---|
| `BatchSettlementAvmScheme` | `SchemeNetworkServer` implementation. Config: `deployment`, `appId`, `receiverAuthorizer`, `withdrawDelay`, `network`, `fetchOnchain`, optional `storage` |
| `BatchSettlementChannelManager` | Voucher verification (I4 channel-id binding, I9 signed-max/balance bounds), atomic charge commits (I12 serialization), cold-start recovery |
| `ChannelStorage` | Interface: `get`, `list`, `updateChannel` (atomic read-modify-write) |
| `InMemoryChannelStorage` | Default backend — per-channel async lock, no persistence |
| `SqliteChannelStorage` | Persistent backend on Node's built-in `node:sqlite` (no native build step). Safe for a merchant and a separate `@turnstile/settler`-based process to share one file |
| `BatchSettlementAvmClientScheme` | `SchemeNetworkClient` implementation. Builds deposit payloads cold, voucher payloads in steady state, verifies any server-reported corrective-402 state against its own key before adopting it (I11) |
| `ClientChannelStorage` / `InMemoryClientChannelStorage` | Client-side channel bookkeeping (signed ceiling, confirmed charged amount) |
| `BatchSettlementAvmFacilitatorScheme` | `SchemeNetworkFacilitator` implementation — validates vouchers/deposits/refunds, submits cooperative `refund()` |
| `BATCH_SETTLEMENT_SCHEME` | The wire scheme string: `'batch-settlement'` |
| `MAX_REASONABLE_FEE_PER_TXN`, `DEFAULT_SERVER_MIN_DEPOSIT_MULTIPLIER`, `MIN_WITHDRAW_DELAY`, `MAX_WITHDRAW_DELAY` | Constants mirrored from the spec |

Full type signatures are in the shipped `.d.ts` files — every export above is documented at the
type level; there is no separate types package to keep in sync.

## Design notes

- Mirrors the official EVM `batch-settlement` mechanism's structure and naming; where AVM specifics
  force a difference (box-reference batch-size limits instead of opcode-budget math, no fee-payer
  sponsorship yet), it's called out inline in [the protocol spec](../../docs/spec/scheme_batch_settlement_avm.md).
- Deliberately does **not** include the EVM reference's pending-request TTL reservation system or an
  auto claim/settle/refund loop — that loop is [`@turnstile/settler`](../settler), kept as a
  separate concern so the scheme itself has no timers or background state.

## Testing

```bash
pnpm -F @turnstile/x402-avm-batch test
```

15 tests: channel-id binding (I4), signature/balance/signed-max bounds (I9), 50-concurrent-request
serialization (I12), cold-start recovery, corrective-402 round-trip with client-side re-verification
(I11), and `SqliteChannelStorage` persistence across process restarts.
