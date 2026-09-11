Paste this as your first message to Claude Code in the repo root:

---
Read CLAUDE.md fully, then PRD.md, docs/spec/scheme_batch_settlement_avm.md and docs/RESOURCES.md.
Run `pnpm refs` and study the EVM batch-settlement TypeScript implementation under
.refs/x402/typescript/packages/mechanisms/evm/src/batch-settlement plus the AVM exact mechanism.
Then execute phases P0 through P7 in order, following the operating rules in CLAUDE.md §1:
work autonomously, record decisions in docs/DECISIONS.md, update docs/PROGRESS.md and commit at the end
of every phase, and only stop to ask me if an on-chain behavior question, a broken dependency, or a red
invariant blocks you. Start with P0 now and show me the exit-criteria command output when it's green.
---

Resuming later: "Read docs/PROGRESS.md and docs/DECISIONS.md, then continue from the next unfinished phase."
