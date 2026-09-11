# @turnstile/core

Pure, dependency-light primitives shared by every other `turnstile` package: Algorand address
codec, ed25519 voucher signing/verification, channel-id / voucher-message encoding (byte-for-byte
matching `contract.py`), the AVM batch-settlement wire types, and CAIP-2 network-id helpers.

No chain I/O, no HTTP, no side effects — safe to import from a browser, a CLI, a server, or a test.

```ts
import { newSessionKey, signVoucher, channelId, type ChannelConfig, type Deployment } from '@turnstile/core';

const session = await newSessionKey();
const config: ChannelConfig = { payer, payerAuthorizer: /* session pubkey as an address */ ..., receiver, receiverAuthorizer, asset, withdrawDelay, salt };
const deployment: Deployment = { genesisHash, appId };
const cid = channelId(config, deployment);
const signature = await signVoucher(session.sk, deployment, cid, maxClaimable);
```

See `docs/spec/scheme_batch_settlement_avm.md` for the protocol this encodes.
