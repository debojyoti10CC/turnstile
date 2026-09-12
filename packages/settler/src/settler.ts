import type { AlgorandClient } from '@algorandfoundation/algokit-utils';
import type { AppClient } from '@algorandfoundation/algokit-utils/types/app-client';
import { claimBatch, settle as escrowSettle, getChannel, getUnsettled, type ClaimRow } from '@turnstilealgo/escrow-client';
import type { Channel, ChannelStorage } from '@turnstilealgo/x402-avm-batch';
import { fromB64 } from '@turnstilealgo/core';
import { assertPollIntervalSafe, chunk, isClaimEligible, shouldSettle, type ClaimPolicyConfig } from './policies.js';

export interface ClaimResult {
  channelId: string;
  claimed: bigint;
}

export interface SettleResult {
  receiver: string;
  asset: bigint;
  amount: bigint;
}

export interface SettlerConfig {
  /** Shared with the merchant/facilitator server scheme -- the settler discovers channels and their latest voucher from here. */
  storage: ChannelStorage;
  algorand: AlgorandClient;
  appClient: AppClient;
  /** Address authorized to claim/settle: config.receiver or config.receiverAuthorizer. */
  receiverSender: string;
  pollIntervalMs: number;
  /** The channel's on-chain withdraw_delay, in ms. Used for the startup safety assertion. */
  withdrawDelayMs: number;
  claimPolicy?: ClaimPolicyConfig;
  /** Settle a (receiver, asset) pair once its on-chain unsettled balance reaches this. Default: settle anything > 0. */
  settleMinUnsettledAtomic?: bigint;
  /**
   * Rows per claim() call. Defaults to 4 (MAX_APP_CALL_FOREIGN_REFERENCES=8
   * worst case: channel box + unsettled box per row, different receivers).
   * Safe to raise toward 7 if the settler's channels are known to share one
   * receiver (see @turnstilealgo/escrow-client's fees.ts for the exact math).
   */
  maxRowsPerClaimBatch?: number;
  onClaim?: (result: ClaimResult) => void;
  onSettle?: (result: SettleResult) => void;
  onError?: (error: unknown) => void;
}

/**
 * Policies: threshold (unclaimed >= T), periodic (age >= A), on-withdraw
 * (always, regardless of threshold/periodic). Then settle(receiver, asset)
 * once unsettled >= settleMinUnsettledAtomic. Batches respect the box-
 * reference cap claim() is subject to; claims are idempotent (the contract
 * no-ops stale rows), so a crash mid-batch is safe to retry on the next tick
 * -- this settler always re-reads on-chain state before submitting rather
 * than trusting anything it remembers from a previous tick.
 */
export class Settler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly lastClaimedAtMs = new Map<string, number>();
  private ticking = false;

  constructor(private readonly config: SettlerConfig) {
    assertPollIntervalSafe(config.pollIntervalMs, config.withdrawDelayMs);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.config.onError?.(err));
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs one claim pass then one settle pass. Exposed directly so tests/CLIs can drive it without a timer. */
  async tick(): Promise<void> {
    if (this.ticking) return; // never overlap ticks
    this.ticking = true;
    try {
      await this.runClaims();
      await this.runSettles();
    } finally {
      this.ticking = false;
    }
  }

  private async runClaims(): Promise<void> {
    const channels = await this.config.storage.list();
    const now = Date.now();
    const candidates: Array<{ channel: Channel; row: ClaimRow }> = [];

    for (const channel of channels) {
      const channelId = fromB64(channel.channelId);
      const onchain = await getChannel(this.config.algorand, this.config.appClient, channelId);
      if (!onchain) continue; // channel not deposited on-chain yet (or box read unavailable)

      const signedMax = BigInt(channel.signedMaxClaimable);
      const cappedMax = signedMax < onchain.balance ? signedMax : onchain.balance;
      const unclaimed = cappedMax - onchain.totalClaimed;

      const eligible = isClaimEligible(
        {
          channelId: channel.channelId,
          unclaimedAmount: unclaimed > 0n ? unclaimed : 0n,
          withdrawRequestedAt: Number(onchain.withdrawRequestedAt),
          lastClaimedAtMs: this.lastClaimedAtMs.get(channel.channelId),
        },
        this.config.claimPolicy ?? {},
        now,
      );
      if (!eligible || unclaimed <= 0n) continue;

      candidates.push({
        channel,
        row: { channelId, maxClaimable: signedMax, signature: fromB64(channel.signature), totalClaimed: cappedMax },
      });
    }

    if (candidates.length === 0) return;

    const maxPerBatch = this.config.maxRowsPerClaimBatch ?? 4;
    for (const batch of chunk(candidates, maxPerBatch)) {
      const rowToChannel = new Map(batch.map((b) => [b.row, b.channel] as const));
      try {
        const claimed = await claimBatch({
          appClient: this.config.appClient,
          sender: this.config.receiverSender,
          rows: batch.map((b) => b.row),
          receiverByChannel: (row) => {
            const channel = rowToChannel.get(row)!;
            return { receiver: channel.channelConfig.receiver, asset: BigInt(channel.channelConfig.asset) };
          },
        });
        const committedAtMs = Date.now();
        for (const { channel } of batch) {
          this.lastClaimedAtMs.set(channel.channelId, committedAtMs);
          this.config.onClaim?.({ channelId: channel.channelId, claimed });
        }
      } catch (err) {
        // No per-channel state to roll back: claim() is idempotent on-chain,
        // and lastClaimedAtMs is only advanced on success, so a failed batch
        // is simply retried (re-read, re-evaluated) on the next tick.
        this.config.onError?.(err);
      }
    }
  }

  private async runSettles(): Promise<void> {
    const channels = await this.config.storage.list();
    const seenDestinations = new Set<string>();

    for (const channel of channels) {
      const destinationKey = `${channel.channelConfig.receiver}:${channel.channelConfig.asset}`;
      if (seenDestinations.has(destinationKey)) continue;
      seenDestinations.add(destinationKey);

      const asset = BigInt(channel.channelConfig.asset);
      const unsettled = await getUnsettled(this.config.algorand, this.config.appClient, channel.channelConfig.receiver, asset);
      if (!shouldSettle(unsettled, this.config.settleMinUnsettledAtomic ?? 1n)) continue;

      try {
        const amount = await escrowSettle({
          appClient: this.config.appClient,
          sender: this.config.receiverSender,
          receiver: channel.channelConfig.receiver,
          asset,
        });
        this.config.onSettle?.({ receiver: channel.channelConfig.receiver, asset, amount });
      } catch (err) {
        this.config.onError?.(err);
      }
    }
  }
}
