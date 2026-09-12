import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemeServerHooks,
  SupportedKind,
} from '@x402/core/types';
import type {
  SettleContext,
  VerifyContext,
  VerifyResultContext,
} from '@x402/core/server';
import { parseMoney } from '@x402/core/utils';
import {
  USDC_ASA_ID,
  USDC_DECIMALS,
  isDepositPayload,
  isRefundPayload,
  isVoucherPayload,
  type AvmBatchExtra,
  type AvmBatchPayload,
  type ChannelStateWire,
  type Deployment,
} from '@turnstilealgo/core';
import { BATCH_SETTLEMENT_SCHEME, MIN_WITHDRAW_DELAY } from '../constants.js';
import { BatchSettlementChannelManager, type FetchOnchainChannel } from './channelManager.js';
import { InMemoryChannelStorage, type ChannelStorage } from './storage.js';

export interface BatchSettlementAvmServerConfig {
  deployment: Deployment;
  appId: bigint;
  receiverAuthorizer: string;
  withdrawDelay?: number;
  minDeposit?: string;
  fetchOnchain: FetchOnchainChannel;
  storage?: ChannelStorage;
  network: Network;
  onchainMirrorTtlMs?: number;
}

/**
 * Server-side `batch-settlement` scheme for AVM networks. Scoped per
 * docs/DECISIONS.md: implements the per-request verify/charge path with
 * `BatchSettlementChannelManager`; does not implement an auto claim/settle/
 * refund loop (`packages/settler`, P4) or a pending-request TTL reservation.
 */
export class BatchSettlementAvmScheme implements SchemeNetworkServer {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly defaultAssetTransferMethod = 'default';
  // "authorization" (verify before handler, single settle after handler)
  // matches the EVM batch-settlement reference exactly -- @x402/core's
  // "escrow" flow is a *different* concept (two settle phases, before AND
  // after the handler) that doesn't fit this scheme at all; picking it
  // caused beforeSettle to be invoked twice per request and double-charge.
  readonly paymentFlows: Readonly<Record<string, PaymentFlowConfig>> = {
    default: { supported: ['authorization'], default: 'authorization' },
  };
  readonly schemeHooks: SchemeServerHooks;

  private readonly channelManager: BatchSettlementChannelManager;
  private readonly storage: ChannelStorage;
  private readonly config: BatchSettlementAvmServerConfig;

  constructor(config: BatchSettlementAvmServerConfig) {
    this.config = config;
    this.storage = config.storage ?? new InMemoryChannelStorage();
    this.channelManager = new BatchSettlementChannelManager({
      storage: this.storage,
      deployment: config.deployment,
      fetchOnchain: config.fetchOnchain,
      onchainMirrorTtlMs: config.onchainMirrorTtlMs,
    });

    this.schemeHooks = {
      onBeforeVerify: (ctx) => this.beforeVerify(ctx),
      onAfterVerify: (ctx) => this.afterVerify(ctx),
      onBeforeSettle: (ctx) => this.beforeSettle(ctx),
    };
  }

  getChannelManager(): BatchSettlementChannelManager {
    return this.channelManager;
  }

  getStorage(): ChannelStorage {
    return this.storage;
  }

  // ------------------------------------------------------------- hooks
  private async beforeVerify(ctx: VerifyContext) {
    const raw = ctx.paymentPayload.payload as unknown as AvmBatchPayload;
    if (isRefundPayload(raw)) return; // zero-charge; nothing to pre-check here
    if (!isVoucherPayload(raw) && !isDepositPayload(raw)) return;

    const result = await this.channelManager.verifyVoucher(raw.channelConfig, raw.voucher);
    if (!result.ok) {
      console.error('[x402-avm-batch] beforeVerify abort', result.error, result.message);
      return { abort: true as const, reason: result.error, message: result.message };
    }
    return;
  }

  private async afterVerify(_ctx: VerifyResultContext) {
    // Local verification already ran in beforeVerify; nothing additional to
    // commit here -- the charge commit happens in beforeSettle, once the
    // resource handler has determined the actual (possibly dynamic) amount.
    return;
  }

  private async beforeSettle(ctx: SettleContext) {
    const raw = ctx.paymentPayload.payload as unknown as AvmBatchPayload;
    if (!isVoucherPayload(raw) && !isDepositPayload(raw)) return;

    const cid = raw.voucher.channelId;
    const actual = BigInt(ctx.requirements.amount);
    const result = await this.channelManager.charge(cid, actual, raw.voucher);
    if (!result.ok) {
      console.error('[x402-avm-batch] beforeSettle abort', result.error, result.message);
      return { abort: true as const, reason: result.error, message: result.message };
    }

    const channel = result.channel;
    const channelState: ChannelStateWire = {
      channelId: channel.channelId,
      balance: channel.balance,
      totalClaimed: channel.totalClaimed,
      withdrawRequestedAt: channel.withdrawRequestedAt,
      chargedCumulativeAmount: channel.chargedCumulativeAmount,
    };

    return {
      skip: true as const,
      result: {
        success: true,
        transaction: '',
        network: ctx.requirements.network,
        payer: channel.channelConfig.payer,
        amount: actual.toString(),
        extra: { channelState, chargedAmount: actual.toString() },
      },
    };
  }

  // --------------------------------------------------------- SchemeNetworkServer
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === 'object' && price !== null && 'amount' in price) {
      if (!price.asset) throw new Error(`Asset must be specified for AssetAmount on network ${network}`);
      return { amount: price.amount, asset: price.asset, extra: price.extra ?? {} };
    }
    const { amount } = parseMoney(price);
    const asset = network.includes('testnet') || network.includes('SGO1') ? USDC_ASA_ID.testnet : USDC_ASA_ID.mainnet;
    const atomic = BigInt(Math.round(Number(amount) * 10 ** USDC_DECIMALS));
    return { amount: atomic.toString(), asset: asset.toString() };
  }

  getAssetDecimals(asset: string, _network: Network): number | undefined {
    if (asset === USDC_ASA_ID.mainnet.toString() || asset === USDC_ASA_ID.testnet.toString()) return USDC_DECIMALS;
    return undefined;
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    const delay = this.config.withdrawDelay ?? MIN_WITHDRAW_DELAY;
    const extra: AvmBatchExtra = {
      appId: this.config.appId.toString(),
      receiverAuthorizer: this.config.receiverAuthorizer,
      withdrawDelay: delay,
      ...(this.config.minDeposit ? { minDeposit: this.config.minDeposit } : {}),
    };
    return { ...paymentRequirements, extra: { ...paymentRequirements.extra, ...extra } };
  }

  /**
   * Corrective-402: when the failed request's payload names a channel we
   * have local state for, attach the server's channel/voucher view so the
   * client can reconcile (and re-sign from the correct base) without
   * guessing. The client MUST re-verify this voucher's signature itself
   * before adopting it (I11) -- this server cannot make that safe on its
   * own, since the whole point is the client doesn't trust the server blindly.
   */
  async enrichPaymentRequiredResponse(ctx: {
    requirements: PaymentRequirements[];
    paymentPayload?: { payload: Record<string, unknown> };
  }): Promise<PaymentRequirements[] | void> {
    const raw = ctx.paymentPayload?.payload as unknown as AvmBatchPayload | undefined;
    if (!raw || (!isVoucherPayload(raw) && !isDepositPayload(raw))) return;

    const channel = await this.storage.get(raw.voucher.channelId);
    if (!channel) return;

    const channelState: ChannelStateWire = {
      channelId: channel.channelId,
      balance: channel.balance,
      totalClaimed: channel.totalClaimed,
      withdrawRequestedAt: channel.withdrawRequestedAt,
      chargedCumulativeAmount: channel.chargedCumulativeAmount,
    };

    return ctx.requirements.map((r) => ({
      ...r,
      extra: {
        ...r.extra,
        channelState,
        voucherState: { signedMaxClaimable: channel.signedMaxClaimable, signature: channel.signature },
      },
    }));
  }
}
