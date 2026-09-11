import {
  channelIdFromWire,
  decodeAddress,
  ERR,
  toB64,
  fromB64,
  verifyVoucher,
  type ChannelConfigWire,
  type Deployment,
  type VoucherWire,
} from '@turnstile/core';
import type { Channel, ChannelStorage } from './storage.js';

export interface OnchainMirror {
  balance: bigint;
  totalClaimed: bigint;
  withdrawRequestedAt: number;
}

/** Reads authoritative on-chain channel state; used for cold-start and mirror refresh. */
export type FetchOnchainChannel = (channelId: Uint8Array) => Promise<OnchainMirror | undefined>;

export interface ChannelManagerConfig {
  storage: ChannelStorage;
  deployment: Deployment;
  fetchOnchain: FetchOnchainChannel;
  /** Re-fetch on-chain state when the local mirror is older than this (ms). */
  onchainMirrorTtlMs?: number;
}

export type VerifyVoucherError =
  | typeof ERR.channelIdMismatch
  | typeof ERR.voucherSignature
  | typeof ERR.cumulativeBelowClaimed
  | typeof ERR.cumulativeExceedsBalance
  | typeof ERR.channelNotFound;

export type ChargeError = typeof ERR.chargeExceedsSigned | typeof ERR.cumulativeExceedsBalance | typeof ERR.channelNotFound;

function toChannelIdB64(channelId: Uint8Array): string {
  return toB64(channelId);
}

/**
 * Manages server-side channel state for the `batch-settlement` scheme's
 * per-request path: local voucher verification, on-chain mirror refresh,
 * and atomic charge commits. Deliberately scoped narrower than the EVM
 * reference's `channelManager.ts` -- see docs/DECISIONS.md -- this class
 * does not run an auto claim/settle/refund loop (that's `packages/settler`,
 * P4) and does not implement a separate pending-request TTL reservation
 * (the atomic charge commit in `charge()` already enforces I9/I12 without
 * it).
 */
export class BatchSettlementChannelManager {
  private readonly storage: ChannelStorage;
  private readonly deployment: Deployment;
  private readonly fetchOnchain: FetchOnchainChannel;
  private readonly onchainMirrorTtlMs: number;

  constructor(config: ChannelManagerConfig) {
    this.storage = config.storage;
    this.deployment = config.deployment;
    this.fetchOnchain = config.fetchOnchain;
    this.onchainMirrorTtlMs = config.onchainMirrorTtlMs ?? 30_000;
  }

  /**
   * Validates a voucher's binding, signature, and cumulative bounds against
   * the mirrored on-chain balance (I4, I9). Performs cold-start recovery
   * (reading on-chain state) when no local record exists yet. Returns the
   * channel record to use going forward (not yet charged for this request).
   */
  async verifyVoucher(
    configWire: ChannelConfigWire,
    voucher: VoucherWire,
  ): Promise<{ ok: true; channel: Channel } | { ok: false; error: VerifyVoucherError; message: string }> {
    const expectedChannelId = channelIdFromWire(configWire, this.deployment);
    const expectedChannelIdB64 = toChannelIdB64(expectedChannelId);
    if (voucher.channelId !== expectedChannelIdB64) {
      return { ok: false, error: ERR.channelIdMismatch, message: 'voucher.channelId does not match channelConfig' };
    }

    let channel = await this.storage.get(expectedChannelIdB64);
    channel = await this.ensureFreshMirror(expectedChannelId, expectedChannelIdB64, configWire, channel);
    if (!channel) {
      return { ok: false, error: ERR.channelNotFound, message: 'channel does not exist on-chain' };
    }

    const payerAuthorizerPk = decodeAddress(configWire.payerAuthorizer);
    const sigOk = await verifyVoucher(
      payerAuthorizerPk,
      this.deployment,
      expectedChannelId,
      BigInt(voucher.maxClaimableAmount),
      fromB64(voucher.signature),
    );
    if (!sigOk) {
      return { ok: false, error: ERR.voucherSignature, message: 'ed25519 voucher signature invalid' };
    }

    const maxClaimable = BigInt(voucher.maxClaimableAmount);
    if (maxClaimable < BigInt(channel.chargedCumulativeAmount)) {
      return {
        ok: false,
        error: ERR.cumulativeBelowClaimed,
        message: 'voucher maxClaimable is below the already-charged cumulative amount',
      };
    }
    if (maxClaimable > BigInt(channel.balance)) {
      return {
        ok: false,
        error: ERR.cumulativeExceedsBalance,
        message: 'voucher maxClaimable exceeds the mirrored on-chain balance',
      };
    }

    return { ok: true, channel };
  }

  /**
   * Atomically charges `amount` against the channel, capped by the voucher's
   * signed maximum and the mirrored balance (I9). Commits the voucher as the
   * channel's latest known-good voucher. Safe under concurrent calls for the
   * same channel (I12): only one commit can win per unit of signed headroom.
   */
  async charge(
    channelId: string,
    amount: bigint,
    voucher: VoucherWire,
  ): Promise<{ ok: true; channel: Channel } | { ok: false; error: ChargeError; message: string }> {
    const signedCap = BigInt(voucher.maxClaimableAmount);
    let error: { error: ChargeError; message: string } | undefined;
    let committed: Channel | undefined;

    const result = await this.storage.updateChannel(channelId, (current) => {
      if (!current) {
        error = { error: ERR.channelNotFound, message: 'no local channel record' };
        return current;
      }
      const newCharged = BigInt(current.chargedCumulativeAmount) + amount;
      if (newCharged > signedCap) {
        error = { error: ERR.chargeExceedsSigned, message: `charging ${newCharged} would exceed signed max ${signedCap}` };
        return current;
      }
      if (newCharged > BigInt(current.balance)) {
        error = { error: ERR.cumulativeExceedsBalance, message: `charging ${newCharged} would exceed mirrored balance ${current.balance}` };
        return current;
      }
      const next: Channel = {
        ...current,
        chargedCumulativeAmount: newCharged.toString(),
        signedMaxClaimable: voucher.maxClaimableAmount,
        signature: voucher.signature,
        lastRequestTimestamp: Date.now(),
      };
      committed = next;
      return next;
    });

    if (error) return { ok: false, ...error };
    if (result.status !== 'updated' || !committed) {
      return { ok: false, error: ERR.channelNotFound, message: 'concurrent update raced out the commit' };
    }
    return { ok: true, channel: committed };
  }

  /** Records a freshly-deposited channel (first request on a brand-new channel). */
  async recordDeposit(configWire: ChannelConfigWire, onchain: OnchainMirror): Promise<Channel> {
    const channelId = channelIdFromWire(configWire, this.deployment);
    const channelIdB64 = toChannelIdB64(channelId);
    const channel: Channel = {
      channelId: channelIdB64,
      channelConfig: configWire,
      chargedCumulativeAmount: '0',
      signedMaxClaimable: '0',
      signature: '',
      balance: onchain.balance.toString(),
      totalClaimed: onchain.totalClaimed.toString(),
      withdrawRequestedAt: onchain.withdrawRequestedAt,
      onchainSyncedAt: Date.now(),
      lastRequestTimestamp: Date.now(),
    };
    await this.storage.updateChannel(channelIdB64, () => channel);
    return channel;
  }

  private async ensureFreshMirror(
    channelId: Uint8Array,
    channelIdB64: string,
    configWire: ChannelConfigWire,
    existing: Channel | undefined,
  ): Promise<Channel | undefined> {
    const stale = !existing || Date.now() - existing.onchainSyncedAt > this.onchainMirrorTtlMs;
    if (!stale) return existing;

    const onchain = await this.fetchOnchain(channelId);
    if (!onchain) return existing; // chain read failed transiently; trust the stale mirror rather than fail closed on the hot path

    const result = await this.storage.updateChannel(channelIdB64, (current) => ({
      channelId: channelIdB64,
      channelConfig: current?.channelConfig ?? configWire,
      chargedCumulativeAmount: current?.chargedCumulativeAmount ?? '0',
      signedMaxClaimable: current?.signedMaxClaimable ?? '0',
      signature: current?.signature ?? '',
      balance: onchain.balance.toString(),
      totalClaimed: onchain.totalClaimed.toString(),
      withdrawRequestedAt: onchain.withdrawRequestedAt,
      onchainSyncedAt: Date.now(),
      lastRequestTimestamp: current?.lastRequestTimestamp ?? Date.now(),
    }));
    return result.channel;
  }
}
