import { describe, expect, it } from 'vitest';
import { assertPollIntervalSafe, chunk, isClaimEligible, shouldSettle } from '../src/policies.js';

describe('isClaimEligible', () => {
  it('never claims a channel with nothing unclaimed, even mid-withdrawal', () => {
    expect(isClaimEligible({ channelId: 'a', unclaimedAmount: 0n, withdrawRequestedAt: 123 }, {}, 0)).toBe(false);
  });

  it('on-withdraw always wins regardless of threshold/periodic config', () => {
    expect(
      isClaimEligible(
        { channelId: 'a', unclaimedAmount: 1n, withdrawRequestedAt: 123 },
        { thresholdAtomic: 1_000_000n, periodicMs: 1_000_000 },
        0,
      ),
    ).toBe(true);
  });

  it('claims once unclaimedAmount reaches the threshold', () => {
    const candidate = { channelId: 'a', unclaimedAmount: 500n, withdrawRequestedAt: 0 };
    expect(isClaimEligible(candidate, { thresholdAtomic: 500n }, 0)).toBe(true);
    expect(isClaimEligible(candidate, { thresholdAtomic: 501n }, 0)).toBe(false);
  });

  it('claims once age since lastClaimedAtMs reaches the periodic interval', () => {
    const candidate = { channelId: 'a', unclaimedAmount: 1n, withdrawRequestedAt: 0, lastClaimedAtMs: 1000 };
    expect(isClaimEligible(candidate, { periodicMs: 5000 }, 1000 + 5000)).toBe(true);
    expect(isClaimEligible(candidate, { periodicMs: 5000 }, 1000 + 4999)).toBe(false);
  });

  it('treats a never-claimed channel as infinitely aged for the periodic check', () => {
    const candidate = { channelId: 'a', unclaimedAmount: 1n, withdrawRequestedAt: 0 };
    expect(isClaimEligible(candidate, { periodicMs: 5000 }, 10_000)).toBe(true);
  });

  it('is not eligible when no policy matches', () => {
    const candidate = { channelId: 'a', unclaimedAmount: 1n, withdrawRequestedAt: 0 };
    expect(isClaimEligible(candidate, { thresholdAtomic: 1000n, periodicMs: 5000 }, 0)).toBe(false);
  });
});

describe('shouldSettle', () => {
  it('settles once unsettled reaches the minimum', () => {
    expect(shouldSettle(100n, 100n)).toBe(true);
    expect(shouldSettle(99n, 100n)).toBe(false);
  });
});

describe('chunk', () => {
  it('splits rows preserving order', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one chunk when rows fit within maxPerBatch', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('returns no chunks for empty input', () => {
    expect(chunk([], 4)).toEqual([]);
  });

  it('rejects a non-positive maxPerBatch', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('assertPollIntervalSafe', () => {
  it('passes when pollIntervalMs * 3 is comfortably under withdrawDelayMs', () => {
    expect(() => assertPollIntervalSafe(1000, 900_000)).not.toThrow();
  });

  it('throws when pollIntervalMs * 3 would not leave margin before the withdraw delay elapses', () => {
    expect(() => assertPollIntervalSafe(500_000, 900_000)).toThrow(/pollIntervalMs/);
  });

  it('throws at the exact boundary (>= is unsafe, not just >)', () => {
    expect(() => assertPollIntervalSafe(300_000, 900_000)).toThrow();
  });
});
