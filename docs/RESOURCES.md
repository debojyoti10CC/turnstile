# Resources (read in this order)

All links verified September 11, 2026. Upstream specs are vendored in `docs/reference/` (commit in
`UPSTREAM_COMMIT.txt`). Run `scripts/fetch-references.sh` to clone full reference code into `.refs/`
(git-ignored).

## 1. Protocol specs (x402-foundation/x402, Apache-2.0)
| What | Where | Why you need it |
|---|---|---|
| x402 v2 core spec | `docs/reference/x402-specification-v2.md` | Headers, envelopes, facilitator API |
| batch-settlement (generic) | `docs/reference/scheme_batch_settlement.md` | The 7 things every binding must define |
| batch-settlement EVM | `docs/reference/scheme_batch_settlement_evm.md` | **Primary template**: payloads, server state, corrective 402, error codes, client recovery |
| batch-settlement SVM | `docs/reference/scheme_batch_settlement_svm.md` | Closest analogue: ed25519 vouchers, fee payer, draft binding style |
| exact on Algorand | `docs/reference/scheme_exact_algo.md` | CAIP-2 ids, `paymentGroup`, `feePayer` pattern we reuse for deposits |
| upto | `docs/reference/scheme_upto.md` | Dynamic pricing semantics |
| **Our draft** | `docs/spec/scheme_batch_settlement_avm.md` | The binding you are implementing |

## 2. Reference code (clone via `scripts/fetch-references.sh`)
| Path in `.refs/x402` | Use |
|---|---|
| `typescript/packages/mechanisms/evm/src/batch-settlement/{client,server,facilitator}` | File-by-file template for `packages/x402-avm-batch` (~7.6k LOC). Mirror its structure, hooks, storage interfaces, recovery and corrective-402 logic |
| `typescript/packages/mechanisms/avm/src` | Existing AVM `exact` mechanism: signer abstraction, constants, network normalization, fee caps (`MAX_REASONABLE_FEE_PER_TXN`) |
| `typescript/packages/core/src/types/mechanisms.ts` | `SchemeNetworkClient/Server/Facilitator` interfaces you implement |
| `typescript/packages/http/express` | `@x402/express` middleware used by the demo merchant |
| `examples/typescript/{servers,clients}/batch-settlement`, `examples/typescript/facilitator` | Wiring examples for apps |
| `.refs/x402-demo` (algorandfoundation/x402-demo) | Working Algorand `exact` client/server examples, GoPlausible facilitator usage |

## 3. Packages (check latest versions with `npm view <pkg> version`)
`@x402/core`, `@x402/avm`, `@x402/express`, `@x402/fetch` (upstream was 2.25.0 at commit time),
`algosdk` (v3), `@algorandfoundation/algokit-utils` (v10 line used by x402-demo), `@noble/ed25519`,
`@noble/hashes`, `better-sqlite3`. Python: `algorand-python`, `puyapy`, `algorand-python-testing`,
`algokit-utils`, `algokit` CLI.

## 4. Algorand docs
- Algorand Python (Puya): https://dev.algorand.co/algokit/languages/python/overview/
- Opcodes and costs (ed25519verify_bare = 1900): https://dev.algorand.co/concepts/smart-contracts/opcodes-overview/
- Boxes and MBR (2500 + 400 × (key + value) µAlgo): https://dev.algorand.co/concepts/smart-contracts/storage/box/
- Resource availability / box references: https://dev.algorand.co/concepts/smart-contracts/resource-usage/
- Inner transactions + fee pooling: https://dev.algorand.co/concepts/smart-contracts/inner-txn/
- AlgoKit LocalNet: https://dev.algorand.co/algokit/cli/localnet/
- TestNet dispenser (ALGO): https://bank.testnet.algorand.network ; TestNet USDC: https://faucet.circle.com
If a URL has moved, search dev.algorand.co for the topic; do not guess.

## 5. Ecosystem context (for README/pitch, not for code)
- GoPlausible facilitator (exact only): https://facilitator.goplausible.xyz — used for the `exact` fallback
- Global x402 Challenge rules: https://algorand.co/global-x402-challenge
- AC2 protocol (human approvals, stretch): https://algorand.co/blog/introducing-ac2-protocol-the-missing-security-layer-for-ai-agents
- x402 batch settlement announcement: https://x402.org/writing/x402-batch-settlement

## 6. Constants (from @x402/avm, re-verify)
| | MainNet | TestNet |
|---|---|---|
| CAIP-2 | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k` | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe` |
| Genesis hash | `wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` | `SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` |
| USDC ASA | 31566704 | 10458941 |
