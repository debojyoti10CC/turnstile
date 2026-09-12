# @turnstile/escrow-client

**Typed transaction builders for the `X402BatchSettlement` ARC-56 contract.** One function per
on-chain operation — deposit, claim, settle, refund, initiate/finalize withdraw, and channel
reads — on top of [`@algorandfoundation/algokit-utils`](https://www.npmjs.com/package/@algorandfoundation/algokit-utils)
(9.2.x, stable) and [`algosdk`](https://www.npmjs.com/package/algosdk) v3.

```bash
npm install @turnstile/escrow-client @algorandfoundation/algokit-utils algosdk
```

Every builder passes explicit box/account/asset references rather than relying on algokit-utils'
simulate-based auto-population — this is deliberate (not an oversight): auto-discovery for an ABI
method call intermittently misreports a `group fee too small` error instead of the real
missing-resource error on this algod/algokit-utils pairing. See
[`docs/DECISIONS.md`](../../docs/DECISIONS.md) for the full story. If you're building your own
transaction against this contract, compute references the same explicit way — don't trust
`allowUnnamedResources` blindly at submit time.

## Quickstart

```ts
import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { getAppClient, deposit, claimBatch, settle, getChannel } from '@turnstile/escrow-client';

const algorand = AlgorandClient.defaultLocalNet(); // or .testNet() / .mainNet()
const appClient = getAppClient(algorand, appId);

// One-time: open a channel by depositing into escrow.
const channelId = await deposit({ algorand, appClient, config, amount }, deployment);

// Per settlement pass: batch many signed vouchers into one app call.
const claimed = await claimBatch({
  appClient,
  sender: receiverOrAuthorizerAddress,
  rows: [{ channelId, maxClaimable, signature, totalClaimed }],
  receiverByChannel: (row) => ({ receiver: channelConfig.receiver, asset: BigInt(channelConfig.asset) }),
});

// Sweep whatever's been claimed-but-not-yet-transferred to the receiver's wallet.
const settled = await settle({ appClient, sender: receiverOrAuthorizerAddress, receiver, asset });

// Read a channel's full on-chain state directly (no readonly call needed).
const state = await getChannel(algorand, appClient, channelId);
// state: { config, balance, totalClaimed, withdrawRequestedAt, withdrawAmount }
```

## API reference

| Function | What it does |
|---|---|
| `getAppClient(algorand, appId)` | Returns an ARC-56 `AppClient` for the deployed escrow app |
| `deposit(params, deployment)` | Builds and submits `[axfer(payer→app), pay(MBR→app), appl deposit(...)]` as one group; returns the resulting `channelId` |
| `claimBatch(params)` | Submits a batch `claim()` call for many vouchers at once; returns total claimed. Batch size is bounded by box references, not opcode budget — see `fees.ts` |
| `settle(params)` | Sweeps a `(receiver, asset)` pair's accumulated unsettled balance to the receiver's wallet |
| `refund(params)` | Cooperative refund: receiver-side agrees to return unclaimed funds to the payer before the withdraw delay |
| `initiateWithdraw(params)` | Payer starts the unilateral exit clock |
| `finalizeWithdraw(params)` | Payer completes the exit once `withdrawDelay` has elapsed, recovering `balance - totalClaimed` |
| `getChannel(algorand, appClient, channelId)` | Reads a channel's full state (including its config) directly from its box via algod; `undefined` if it doesn't exist |
| `getChannelView(appClient, sender, channelId)` | Fallback for callers without direct box-read access — calls the contract's `get_channel` readonly ABI method. Narrower: omits `config` |
| `getUnsettled(algorand, appClient, receiver, asset)` | Reads a `(receiver, asset)` pair's unsettled-balance box |
| `channelBoxName(channelId)` / `unsettledBoxName(receiver, assetId)` | Box-key builders, exported so callers computing their own resource references don't have to reimplement the layout |
| `configToTuple(config)` | `ChannelConfig` → the ARC-4 tuple shape the contract's ABI methods expect |
| `claimOpUpExtraFee(rows)` | The extra fee (in `AlgoAmount`) a `claimBatch` call must pool to cover opcode-budget op-ups |
| `MAX_CLAIM_ROWS_PER_CALL` (4) / `MAX_CLAIM_ROWS_PER_CALL_SAME_RECEIVER` (7) / `MAX_APP_CALL_FOREIGN_REFERENCES` (8) | Batch-size constants, found empirically against real LocalNet transactions — see [`docs/DECISIONS.md`](../../docs/DECISIONS.md) for how |

Full parameter shapes (`DepositParams`, `ClaimParams`/`ClaimRow`, `SettleParams`, `RefundParams`,
`InitiateWithdrawParams`/`FinalizeWithdrawParams`, `ChannelState`/`ChannelView`) are in the shipped
`.d.ts` files.

## A note on batch size

`claim()`'s row limit is Algorand's `MAX_APP_CALL_FOREIGN_REFERENCES = 8`, not opcode budget as
originally assumed — each row needs its channel's box plus one shared "unsettled" box per distinct
receiver among the batch's rows. `claimBatch` checks the exact box count rather than a fixed row
number, so a batch where every row shares one receiver (the common settler case) can carry up to 7
rows; a batch spanning different receivers is capped at 4.

## Testing

```bash
pnpm -F @turnstile/escrow-client test
```

Not an emulator test — `test/localnet.test.ts` runs the full deposit → claim → settle → refund →
initiateWithdraw → finalizeWithdraw lifecycle against a live LocalNet node (bootstrapping via
[`contracts/scripts/deploy.py`](../../contracts/scripts/deploy.py)), asserting real fees, real box
MBR, and a real ed25519 signature accepted on-chain.
