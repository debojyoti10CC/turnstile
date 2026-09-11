/**
 * x402 v2 wire types for batch-settlement on AVM. Names mirror the EVM/SVM bindings
 * (scheme_batch_settlement_evm.md / _svm.md). Amounts are decimal strings on the wire.
 * Per @x402/core's actual HTTP client (see docs/spec-notes.md): the 402 body is plain
 * JSON (no special header), the request carries `X-PAYMENT`, and the server replies
 * with `X-PAYMENT-RESPONSE`.
 */
import { channelId as computeChannelId, type ChannelConfig, type Deployment } from './config.js';
import { toB64, fromB64 } from './bytes.js';
export interface AvmBatchExtra {
  appId: string;               // escrow application id (canonical per network, client MUST verify)
  receiverAuthorizer: string;
  withdrawDelay: number;       // seconds
  minDeposit?: string;
  feePayer?: string;           // optional sponsor for deposit groups (as in exact_algo)
  channelState?: ChannelStateWire;   // corrective-only
  voucherState?: VoucherStateWire;   // corrective-only
}

export interface PaymentRequirementsAvmBatch {
  scheme: 'batch-settlement';
  network: string;             // CAIP-2
  amount: string;              // per-request max, atomic units
  asset: string;               // ASA id as string
  payTo: string;
  maxTimeoutSeconds: number;
  extra: AvmBatchExtra;
}

export interface ChannelConfigWire {
  payer: string; payerAuthorizer: string; receiver: string; receiverAuthorizer: string;
  asset: string; withdrawDelay: number; salt: string; // salt = base64 32 bytes
}

export interface VoucherWire { channelId: string; maxClaimableAmount: string; signature: string } // b64

export function configToWire(c: ChannelConfig): ChannelConfigWire {
  return {
    payer: c.payer, payerAuthorizer: c.payerAuthorizer, receiver: c.receiver,
    receiverAuthorizer: c.receiverAuthorizer, asset: c.asset.toString(),
    withdrawDelay: Number(c.withdrawDelay), salt: toB64(c.salt),
  };
}

export function configFromWire(w: ChannelConfigWire): ChannelConfig {
  return {
    payer: w.payer, payerAuthorizer: w.payerAuthorizer, receiver: w.receiver,
    receiverAuthorizer: w.receiverAuthorizer, asset: BigInt(w.asset),
    withdrawDelay: BigInt(w.withdrawDelay), salt: fromB64(w.salt),
  };
}

export function channelIdFromWire(w: ChannelConfigWire, d: Deployment): Uint8Array {
  return computeChannelId(configFromWire(w), d);
}

export type AvmBatchPayload =
  | { type: 'deposit'; channelConfig: ChannelConfigWire; voucher: VoucherWire;
      deposit: { amount: string; paymentGroup: string[] } } // b64 msgpack signed/unsigned txns
  | { type: 'voucher'; channelConfig: ChannelConfigWire; voucher: VoucherWire }
  | { type: 'refund'; channelConfig: ChannelConfigWire; voucher: VoucherWire; amount?: string };

export function isDepositPayload(p: AvmBatchPayload): p is Extract<AvmBatchPayload, { type: 'deposit' }> {
  return p.type === 'deposit';
}
export function isVoucherPayload(p: AvmBatchPayload): p is Extract<AvmBatchPayload, { type: 'voucher' }> {
  return p.type === 'voucher';
}
export function isRefundPayload(p: AvmBatchPayload): p is Extract<AvmBatchPayload, { type: 'refund' }> {
  return p.type === 'refund';
}

export interface ChannelStateWire {
  channelId: string; balance: string; totalClaimed: string;
  withdrawRequestedAt: number; chargedCumulativeAmount: string;
}
export interface VoucherStateWire { signedMaxClaimable: string; signature: string }

export interface SettlementResponseAvmBatch {
  success: boolean; transaction: string; network: string; payer: string; amount: string;
  extra: { commitmentId?: string; chargedAmount?: string; channelState: ChannelStateWire };
}

export const ERR = {
  cumulativeMismatch: 'invalid_batch_settlement_avm_cumulative_amount_mismatch',
  cumulativeBelowClaimed: 'invalid_batch_settlement_avm_cumulative_below_claimed',
  cumulativeExceedsBalance: 'invalid_batch_settlement_avm_cumulative_exceeds_balance',
  voucherSignature: 'invalid_batch_settlement_avm_voucher_signature',
  channelIdMismatch: 'invalid_batch_settlement_avm_channel_id_mismatch',
  channelNotFound: 'invalid_batch_settlement_avm_channel_not_found',
  channelBusy: 'invalid_batch_settlement_avm_channel_busy',
  withdrawPending: 'invalid_batch_settlement_avm_withdraw_pending',
  receiverMismatch: 'invalid_batch_settlement_avm_receiver_mismatch',
  receiverAuthorizerMismatch: 'invalid_batch_settlement_avm_receiver_authorizer_mismatch',
  assetMismatch: 'invalid_batch_settlement_avm_asset_mismatch',
  withdrawDelayMismatch: 'invalid_batch_settlement_avm_withdraw_delay_mismatch',
  appIdMismatch: 'invalid_batch_settlement_avm_app_id_mismatch',
  networkMismatch: 'invalid_batch_settlement_avm_network_mismatch',
  depositPayload: 'invalid_batch_settlement_avm_deposit_payload',
  voucherPayload: 'invalid_batch_settlement_avm_voucher_payload',
  chargeExceedsSigned: 'invalid_batch_settlement_avm_charge_exceeds_signed_cumulative',
} as const;
export type ErrorCode = (typeof ERR)[keyof typeof ERR];
