# @turnstile/escrow-client

Typed transaction builders for the `X402BatchSettlement` ARC-56 contract, on top of
`@algorandfoundation/algokit-utils` (9.2.x, stable) + `algosdk` v3. Every builder submits explicit
box/account/asset references rather than relying on simulate-based auto-population — see
`docs/DECISIONS.md` for why that's unreliable on this algod/algokit-utils pairing.

```ts
import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { getAppClient, deposit, claimBatch, settle, getChannel } from '@turnstile/escrow-client';

const algorand = AlgorandClient.defaultLocalNet();
const appClient = getAppClient(algorand, appId);

const channelId = await deposit({ algorand, appClient, config, amount }, deployment);
const claimed = await claimBatch({ appClient, sender, rows, receiverByChannel });
const settled = await settle({ appClient, sender, receiver, asset });
const state = await getChannel(algorand, appClient, channelId);
```

Exports: `deposit`, `claimBatch` (+ `MAX_CLAIM_ROWS_PER_CALL` / `MAX_CLAIM_ROWS_PER_CALL_SAME_RECEIVER`,
found empirically — see `docs/DECISIONS.md`), `settle`, `refund`, `initiateWithdraw` /
`finalizeWithdraw`, `getChannel` / `getChannelView` / `getUnsettled`, and the box-name / fee helpers
each of those builds on.

Verified against real transactions on LocalNet, not just the offline emulator — see
`test/localnet.test.ts`.
