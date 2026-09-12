# @turnstile/settler-service

A ready-to-run standalone process wrapping [`@turnstile/settler`](../../packages/settler)'s
claim/settle policy engine. If you just want a settler running against your deployment without
writing any code, this is it — `packages/settler` is the library for embedding the same logic into
your own process instead.

## Run it

```bash
CHANNEL_DB_PATH=./channels.sqlite \
  X402_AVM_APP_ID=<app_id> \
  RECEIVER_SENDER_ADDRESS=<receiver_or_receiverAuthorizer> \
  RECEIVER_SENDER_PRIVATE_KEY=<its_base64_secret_key> \
  POLL_INTERVAL_MS=30000 \
  CLAIM_THRESHOLD_ATOMIC=100000 \
  SETTLE_MIN_UNSETTLED_ATOMIC=1 \
  node dist/index.js
```

`CHANNEL_DB_PATH` **must** point at the same SQLite file your merchant process was started with
(`CHANNEL_DB_PATH` there too) — this process reads the merchant's `ChannelStorage` directly rather
than talking to it over HTTP, since `InMemoryChannelStorage` can't be shared across processes.
`RECEIVER_SENDER_PRIVATE_KEY` can be omitted on LocalNet if the address is one of the KMD-tracked
accounts `contracts/scripts/deploy.py` created; any other network needs it explicitly. Add
`NETWORK=testnet` (or `mainnet`) to point at a network other than LocalNet.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `X402_AVM_APP_ID` | yes | The deployed escrow app id |
| `CHANNEL_DB_PATH` | yes | Path to the SQLite file shared with the merchant process |
| `RECEIVER_SENDER_ADDRESS` | yes | Address authorized to claim/settle — `config.receiver` or `config.receiverAuthorizer` |
| `RECEIVER_SENDER_PRIVATE_KEY` | no | Base64 secret key; omit only on LocalNet with a KMD-tracked address |
| `POLL_INTERVAL_MS` | no (default `30000`) | Must satisfy `pollIntervalMs × 3 < withdrawDelaySeconds × 1000` — the process refuses to start otherwise |
| `WITHDRAW_DELAY_SECONDS` | no (default `900`) | The channel's on-chain withdraw delay, used only for the startup safety check above |
| `CLAIM_THRESHOLD_ATOMIC` | no | Claim a channel once its unclaimed amount reaches this |
| `CLAIM_PERIODIC_MS` | no | Claim a channel once this long has passed since its last claim, regardless of amount |
| `SETTLE_MIN_UNSETTLED_ATOMIC` | no (default: anything `> 0`) | Settle a `(receiver, asset)` pair once its unsettled balance reaches this |
| `MAX_ROWS_PER_CLAIM_BATCH` | no (default `4`) | See `@turnstile/escrow-client`'s box-reference batching notes |
| `NETWORK` | no (default `localnet`) | `localnet` \| `testnet` \| `mainnet` |

The process logs every claim and settle to stdout and exits non-zero on a startup config error;
tick-level errors (a failed claim/settle submission) are logged and retried on the next poll rather
than crashing the process. `SIGINT`/`SIGTERM` stop the timer and close the database cleanly.
