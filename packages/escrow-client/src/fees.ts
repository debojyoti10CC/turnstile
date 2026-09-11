import { microAlgos } from '@algorandfoundation/algokit-utils';
import type { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount';

/** Mirrors contract.py: ED25519_COST=1900, PER_ROW_OVERHEAD=700, op-up grants ~700/call. */
const ED25519_COST = 1_900;
const PER_ROW_OVERHEAD = 700;
const OP_UP_GRANT = 700;
const MIN_TXN_FEE_MICRO_ALGO = 1_000;

/**
 * Extra fee (on top of the app call's own min fee) needed to cover the
 * `claim()` op-up inner transactions for a batch of `rows` claims.
 *
 * Verified empirically on LocalNet (see docs/DECISIONS.md): for n=1 row,
 * ceil(2600/700)=4 op-ups are required; 3 under-funds and the group is
 * rejected with "group fee too small".
 */
export function claimOpUpExtraFee(rows: number): AlgoAmount {
  const budget = rows * (ED25519_COST + PER_ROW_OVERHEAD);
  const opUps = Math.ceil(budget / OP_UP_GRANT);
  return microAlgos(opUps * MIN_TXN_FEE_MICRO_ALGO);
}

/** settle/refund/finalizeWithdraw/optInAsset each submit exactly one fee=0 inner AssetTransfer. */
export const SINGLE_INNER_TRANSFER_EXTRA_FEE = microAlgos(MIN_TXN_FEE_MICRO_ALGO);

/**
 * Maximum claim rows per `claim()` call. Found empirically on LocalNet (not
 * derived from the opcode-budget formula above, which turned out not to be
 * the binding constraint -- see docs/DECISIONS.md): n=7 succeeds, n=8 fails.
 * The actual bottleneck is `MAX_APP_CALL_FOREIGN_REFERENCES` (8): each claim
 * row needs its channel's box, plus one shared "unsettled" box per distinct
 * receiver among the rows. Opcode budget (op-up) was never the limiter --
 * 30-row batches still priced fine, they just couldn't fit their box refs.
 *
 * - Best case, all rows same receiver: 1 unsettled box + n channel boxes <= 8
 *   => n <= 7.
 * - Worst case, every row a different receiver: n channel boxes + n
 *   unsettled boxes <= 8 => n <= 4.
 *
 * Exported conservatively as the worst case; callers batching rows known to
 * share one receiver (the common case) may safely use up to 7.
 */
export const MAX_CLAIM_ROWS_PER_CALL = 4;
export const MAX_CLAIM_ROWS_PER_CALL_SAME_RECEIVER = 7;
export const MAX_APP_CALL_FOREIGN_REFERENCES = 8;
