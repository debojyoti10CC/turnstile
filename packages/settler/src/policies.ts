/** Pure, chain-free decision logic -- kept separate from settler.ts so it's trivially unit-testable. */

export interface ClaimCandidate {
  channelId: string;
  /** min(signedMaxClaimable, on-chain balance) - on-chain totalClaimed. Never negative; 0 means nothing to claim. */
  unclaimedAmount: bigint;
  /** On-chain withdraw_requested_at, unix seconds; 0 means no pending withdrawal. */
  withdrawRequestedAt: number;
  /** ms epoch of this settler's last successful claim for this channel, if any. */
  lastClaimedAtMs?: number;
}

export interface ClaimPolicyConfig {
  /** Claim when unclaimedAmount >= this (atomic units). */
  thresholdAtomic?: bigint;
  /** Claim when age since lastClaimedAtMs >= this, regardless of amount. */
  periodicMs?: number;
}

/**
 * Decides whether one channel should be claimed this tick.
 *
 * Rule order mirrors CLAUDE.md P4 exactly: on-withdraw always wins (I8 --
 * the settler must claim before a payer's withdraw delay elapses, so a
 * pending withdrawal is claimed regardless of threshold/periodic config),
 * then threshold, then periodic. A channel with nothing unclaimed is never
 * eligible, even mid-withdrawal -- there is nothing to claim.
 */
export function isClaimEligible(candidate: ClaimCandidate, config: ClaimPolicyConfig, nowMs: number): boolean {
  if (candidate.unclaimedAmount <= 0n) return false;
  if (candidate.withdrawRequestedAt > 0) return true;
  if (config.thresholdAtomic !== undefined && candidate.unclaimedAmount >= config.thresholdAtomic) return true;
  if (config.periodicMs !== undefined) {
    const age = nowMs - (candidate.lastClaimedAtMs ?? 0);
    if (age >= config.periodicMs) return true;
  }
  return false;
}

/** Claim when on-chain unsettled >= minUnsettled (atomic units) for a (receiver, asset) pair. */
export function shouldSettle(unsettledAtomic: bigint, minUnsettled: bigint): boolean {
  return unsettledAtomic >= minUnsettled;
}

/** Splits rows into batches of at most `maxPerBatch`, preserving order. */
export function chunk<T>(rows: readonly T[], maxPerBatch: number): T[][] {
  if (maxPerBatch <= 0) throw new RangeError('maxPerBatch must be positive');
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += maxPerBatch) {
    out.push(rows.slice(i, i + maxPerBatch));
  }
  return out;
}

/**
 * Startup assertion from CLAUDE.md P4: the settler must be able to claim a
 * withdrawing channel well before the withdraw delay elapses. `pollIntervalMs
 * * 3 < withdrawDelayMs` leaves two full poll cycles of margin after the one
 * that first observes the pending withdrawal (to survive one missed/failed
 * tick) before finalize_withdraw becomes callable.
 */
export function assertPollIntervalSafe(pollIntervalMs: number, withdrawDelayMs: number): void {
  if (pollIntervalMs * 3 >= withdrawDelayMs) {
    throw new Error(
      `settler pollIntervalMs (${pollIntervalMs}) * 3 must be < withdrawDelayMs (${withdrawDelayMs}); ` +
        'otherwise a pending withdrawal could finalize before the settler gets a chance to claim it',
    );
  }
}
