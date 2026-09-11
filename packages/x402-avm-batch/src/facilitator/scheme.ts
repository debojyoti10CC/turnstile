import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
} from '@x402/core/types';
import type { VerifyResponse, SettleResponse } from '@x402/core/types';
import { fromB64, isDepositPayload, isRefundPayload, isVoucherPayload, type AvmBatchPayload } from '@turnstile/core';
import { BATCH_SETTLEMENT_SCHEME } from '../constants.js';
import { BatchSettlementChannelManager } from '../server/channelManager.js';

export interface RefundExecutor {
  (args: { channelId: Uint8Array; amount: bigint; asset: bigint; payer: string }): Promise<bigint>;
}

export interface BatchSettlementAvmFacilitatorConfig {
  channelManager: BatchSettlementChannelManager;
  receiverAuthorizerAddress: string;
  /** Submits the on-chain refund() call; the merchant/demo wires this to escrow-client. */
  executeRefund: RefundExecutor;
}

/**
 * Facilitator-side `batch-settlement` scheme for AVM networks. Scoped for
 * this pass (see docs/DECISIONS.md): the deposit transaction is submitted
 * directly by the client/agent using its own keys via
 * `@turnstile/escrow-client` before the payload is even sent, rather than
 * by the facilitator on the client's behalf. That means `verify()` for a
 * deposit payload only needs to confirm the deposit already landed
 * on-chain (the channel manager's cold-start mirror read does exactly
 * that) -- it does not build, co-sign, or submit anything itself. A real
 * production facilitator that sponsors fees or accepts partially-signed
 * groups over the wire would need that submission logic; it's a
 * documented gap here, not silently skipped.
 */
export class BatchSettlementAvmFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly caipFamily = 'algorand:*';

  constructor(private readonly config: BatchSettlementAvmFacilitatorConfig) {}

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return undefined;
  }

  getSigners(_network: string): string[] {
    return [this.config.receiverAuthorizerAddress];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const raw = payload.payload as unknown as AvmBatchPayload;

    if (isVoucherPayload(raw) || isDepositPayload(raw)) {
      const result = await this.config.channelManager.verifyVoucher(raw.channelConfig, raw.voucher);
      if (!result.ok) {
        return { isValid: false, invalidReason: result.error, invalidMessage: result.message };
      }
      return { isValid: true, payer: result.channel.channelConfig.payer };
    }

    if (isRefundPayload(raw)) {
      const result = await this.config.channelManager.verifyVoucher(raw.channelConfig, raw.voucher);
      if (!result.ok) {
        return { isValid: false, invalidReason: result.error, invalidMessage: result.message };
      }
      if (raw.voucher.maxClaimableAmount !== result.channel.chargedCumulativeAmount) {
        return {
          isValid: false,
          invalidReason: 'invalid_batch_settlement_avm_cumulative_amount_mismatch',
          invalidMessage: 'refund voucher must claim exactly the current charged cumulative amount',
        };
      }
      return { isValid: true, payer: result.channel.channelConfig.payer };
    }

    return { isValid: false, invalidReason: 'invalid_batch_settlement_avm_deposit_payload', invalidMessage: 'unrecognized payload type' };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const raw = payload.payload as unknown as AvmBatchPayload;

    if (!isRefundPayload(raw)) {
      // Voucher/deposit payloads are settled locally by the merchant's
      // BatchSettlementAvmScheme.beforeSettle (it returns `skip: true`), so
      // @x402/core never actually calls this method for them. Reaching here
      // with one of those types means something upstream didn't skip --
      // fail loudly rather than silently fabricate a transaction hash.
      return {
        success: false,
        errorReason: 'invalid_batch_settlement_avm_voucher_payload',
        errorMessage: 'settle() should not be reached for voucher/deposit payloads',
        transaction: '',
        network: requirements.network,
      };
    }

    const channelId = fromB64(raw.voucher.channelId);
    const amount = raw.amount ? BigInt(raw.amount) : BigInt(raw.voucher.maxClaimableAmount);
    try {
      const refunded = await this.config.executeRefund({
        channelId,
        amount,
        asset: BigInt(requirements.asset),
        payer: raw.channelConfig.payer,
      });
      return {
        success: true,
        transaction: '',
        network: requirements.network,
        payer: raw.channelConfig.payer,
        amount: refunded.toString(),
      };
    } catch (err) {
      return {
        success: false,
        errorReason: 'invalid_batch_settlement_avm_channel_busy',
        errorMessage: err instanceof Error ? err.message : String(err),
        transaction: '',
        network: requirements.network,
      };
    }
  }
}
