# Decisions

| Date | Decision | Alternatives | Reason |
|---|---|---|---|
| 2026-09-11 | Channel boxes are never deleted | Delete on close + tombstone | Deleting resets totalClaimed → replay of old vouchers on re-fund. Salt gives fresh channels |
| 2026-09-11 | claim = accounting, settle = sweep | Transfer per claim | Mirrors EVM binding; one transfer for many channels |
| 2026-09-11 | Stale claim rows are no-ops | Revert | Idempotent settler retries; one bad row shouldn't sink a batch |
| 2026-09-11 | Withdraw delay in seconds (latest_timestamp), 900–2,592,000 | Rounds | Same units/bounds as EVM & SVM bindings |
| 2026-09-11 | payerAuthorizer may also start/finalize withdrawals | Payer only | Funds always go to payer, so hot key gains no theft path; lets agents exit without the cold key |
| 2026-09-11 | No voucher expiry | expiresAt field | SVM binding requires expiresAt = 0 for the same reason: withdraw delay already bounds redemption |
