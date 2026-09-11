export const BATCH_SETTLEMENT_SCHEME = 'batch-settlement' as const;

/** Mirrors @x402/avm's own constant (see docs/DECISIONS.md for version rationale). */
export const MAX_REASONABLE_FEE_PER_TXN = 5000;

/** Default multiplier applied to a dynamic price's max to size a fresh deposit. */
export const DEFAULT_SERVER_MIN_DEPOSIT_MULTIPLIER = 10;

export const MIN_WITHDRAW_DELAY = 900;
export const MAX_WITHDRAW_DELAY = 2_592_000;
