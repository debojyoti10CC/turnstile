import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeClientHooks,
  SchemeNetworkClient,
} from '@x402/core/types';
import type { PaymentResponseContext } from '@x402/core/client';
import {
  channelId as computeChannelId,
  configToWire,
  decodeAddress,
  encodeAddress,
  fromB64,
  newSessionKey,
  signVoucher,
  toB64,
  verifyVoucher,
  type AvmBatchExtra,
  type AvmBatchPayload,
  type ChannelConfig,
  type Deployment,
} from '@turnstile/core';
import { BATCH_SETTLEMENT_SCHEME, DEFAULT_SERVER_MIN_DEPOSIT_MULTIPLIER, MIN_WITHDRAW_DELAY } from '../constants.js';
import type { ClientChannelRecord, ClientChannelStorage } from './storage.js';
import { InMemoryClientChannelStorage } from './storage.js';

export interface BuildDepositGroupArgs {
  config: ChannelConfig;
  amount: bigint;
}

/** Builds the real on-chain deposit group; injected so this scheme stays testable without a live node/signer. */
export type BuildDepositGroup = (args: BuildDepositGroupArgs) => Promise<{ paymentGroup: string[] }>;

export interface BatchSettlementAvmClientConfig {
  payerAddress: string;
  deployment: Deployment;
  buildDepositGroup: BuildDepositGroup;
  storage?: ClientChannelStorage;
  /** Fresh deposits are sized as max(minDeposit, amount * depositMultiplier). */
  depositMultiplier?: number;
}

/**
 * Client-side `batch-settlement` scheme for AVM networks. Scoped per
 * docs/DECISIONS.md: deposit group construction is delegated to
 * `buildDepositGroup` (real tx building lives in `@turnstile/escrow-client`
 * + a live signer, which don't belong inside a unit-testable scheme class).
 */
export class BatchSettlementAvmClientScheme implements SchemeNetworkClient {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly schemeHooks: SchemeClientHooks;

  private readonly storage: ClientChannelStorage;
  private readonly config: BatchSettlementAvmClientConfig;

  constructor(config: BatchSettlementAvmClientConfig) {
    this.config = config;
    this.storage = config.storage ?? new InMemoryClientChannelStorage();
    this.schemeHooks = {
      onPaymentResponse: (ctx) => this.onPaymentResponse(ctx),
    };
  }

  getStorage(): ClientChannelStorage {
    return this.storage;
  }

  async createPaymentPayload(
    _x402Version: number,
    requirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const extra = requirements.extra as unknown as AvmBatchExtra;
    const existing = await this.storage.findByDestination(requirements.payTo, requirements.asset);

    if (existing) {
      return { x402Version: 2, payload: await this.buildVoucherPayload(existing, requirements) };
    }

    return { x402Version: 2, payload: await this.buildDepositPayload(requirements, extra) };
  }

  // ----------------------------------------------------------------- steady state
  private async buildVoucherPayload(
    record: ClientChannelRecord,
    requirements: PaymentRequirements,
  ): Promise<AvmBatchPayload> {
    const amount = BigInt(requirements.amount);
    const newMax = BigInt(record.chargedCumulativeAmount) + amount;
    const channelId = fromB64(record.channelId);
    const sig = await signVoucher(record.sessionKey, this.config.deployment, channelId, newMax);
    const signature = toB64(sig);

    await this.storage.set({ ...record, signedMaxClaimable: newMax.toString(), signature, confirmed: false });

    return {
      type: 'voucher',
      channelConfig: record.channelConfig,
      voucher: { channelId: record.channelId, maxClaimableAmount: newMax.toString(), signature },
    };
  }

  // ----------------------------------------------------------------- cold start
  private async buildDepositPayload(
    requirements: PaymentRequirements,
    extra: AvmBatchExtra,
  ): Promise<AvmBatchPayload> {
    const session = await newSessionKey();
    const config: ChannelConfig = {
      payer: this.config.payerAddress,
      payerAuthorizer: encodeAddress(session.pk),
      receiver: requirements.payTo,
      receiverAuthorizer: extra.receiverAuthorizer,
      asset: BigInt(requirements.asset),
      withdrawDelay: BigInt(extra.withdrawDelay ?? MIN_WITHDRAW_DELAY),
      salt: crypto.getRandomValues(new Uint8Array(32)),
    };

    const amount = BigInt(requirements.amount);
    const depositMultiplier = BigInt(this.config.depositMultiplier ?? DEFAULT_SERVER_MIN_DEPOSIT_MULTIPLIER);
    const minDeposit = extra.minDeposit ? BigInt(extra.minDeposit) : 0n;
    const depositAmount = amount * depositMultiplier > minDeposit ? amount * depositMultiplier : minDeposit;

    const { paymentGroup } = await this.config.buildDepositGroup({ config, amount: depositAmount });

    const channelId = computeChannelId(config, this.config.deployment);
    const sig = await signVoucher(session.sk, this.config.deployment, channelId, amount);
    const signature = toB64(sig);
    const channelIdB64 = toB64(channelId);
    const configWire = configToWire(config);

    await this.storage.set({
      channelId: channelIdB64,
      channelConfig: configWire,
      sessionKey: session.sk,
      chargedCumulativeAmount: '0',
      signedMaxClaimable: amount.toString(),
      signature,
      confirmed: false,
    });

    return {
      type: 'deposit',
      channelConfig: configWire,
      voucher: { channelId: channelIdB64, maxClaimableAmount: amount.toString(), signature },
      deposit: { amount: depositAmount.toString(), paymentGroup },
    };
  }

  // ----------------------------------------------------------------- response handling
  private async onPaymentResponse(ctx: PaymentResponseContext): Promise<void | { recovered: true }> {
    const raw = ctx.paymentPayload.payload as unknown as AvmBatchPayload;
    if (raw.type === 'refund') return;

    if (ctx.settleResponse?.success) {
      const record = await this.storage.get(raw.voucher.channelId);
      if (record) {
        await this.storage.set({
          ...record,
          chargedCumulativeAmount: BigInt(raw.voucher.maxClaimableAmount) >= BigInt(record.chargedCumulativeAmount)
            ? raw.voucher.maxClaimableAmount
            : record.chargedCumulativeAmount,
          confirmed: true,
        });
      }
      return;
    }

    // Corrective-402: the server may have attached its view of this channel
    // in extra.channelState/voucherState. Never adopt it without verifying
    // the voucher signature ourselves first (I11) -- a malicious facilitator
    // or server cannot forge our session key's signature, so a signature
    // that verifies under our own public key is proof we actually produced
    // it, regardless of what the server claims.
    const corrective = ctx.paymentRequired?.accepts.find((r) => r.scheme === BATCH_SETTLEMENT_SCHEME)
      ?.extra as AvmBatchExtra | undefined;
    if (!corrective?.voucherState || !corrective.channelState) return;

    const record = await this.storage.get(raw.voucher.channelId);
    if (!record) return;

    const payerAuthorizerPk = decodeAddress(record.channelConfig.payerAuthorizer);
    const claimedMax = BigInt(corrective.voucherState.signedMaxClaimable);
    const sigValid = await verifyVoucher(
      payerAuthorizerPk,
      this.config.deployment,
      fromB64(raw.voucher.channelId),
      claimedMax,
      fromB64(corrective.voucherState.signature),
    );
    if (!sigValid) return; // refuse to adopt unverifiable server-claimed state

    await this.storage.set({
      ...record,
      chargedCumulativeAmount: corrective.channelState.chargedCumulativeAmount,
      signedMaxClaimable: corrective.voucherState.signedMaxClaimable,
      signature: corrective.voucherState.signature,
      confirmed: true,
    });
    return { recovered: true };
  }
}
