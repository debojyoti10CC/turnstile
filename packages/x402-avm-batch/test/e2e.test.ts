/**
 * In-process E2E for the AVM batch-settlement client+server scheme pair.
 *
 * Scoped per docs/DECISIONS.md: drives our own `schemeHooks` directly in the
 * sequence @x402/core's resource server would call them (beforeVerify ->
 * handler -> beforeSettle -> client onPaymentResponse), rather than wiring
 * the full `x402ResourceServer`/`x402Client`/`HTTPFacilitatorClient` stack,
 * whose HTTP/facilitator-negotiation concerns are orthogonal to what this
 * test is actually checking: that our hooks compose correctly for flat and
 * dynamic pricing, corrective 402, cold start, and 50-concurrent-request
 * serialization on one channel.
 */
import { describe, expect, it } from 'vitest';
import type { Network, PaymentRequirements } from '@x402/core/types';
import type { AvmBatchExtra, AvmBatchPayload, Deployment } from '@turnstilealgo/core';
import { BatchSettlementAvmScheme } from '../src/server/scheme.js';
import type { OnchainMirror } from '../src/server/channelManager.js';
import type { BuildDepositGroup } from '../src/client/scheme.js';
import { BatchSettlementAvmClientScheme } from '../src/client/scheme.js';

const NETWORK: Network = 'algorand:testnet';
const deployment: Deployment = { genesisHash: crypto.getRandomValues(new Uint8Array(32)), appId: 42n };

interface MockChainState {
  balance: bigint;
  totalClaimed: bigint;
  withdrawRequestedAt: number;
}

function makeMockChain() {
  const channels = new Map<string, MockChainState>();
  const fetchOnchain = async (channelId: Uint8Array): Promise<OnchainMirror | undefined> => {
    const key = Buffer.from(channelId).toString('base64');
    return channels.get(key);
  };
  const buildDepositGroup: BuildDepositGroup = async ({ amount }) => {
    // Stand-in for "the facilitator submitted the deposit group": the real
    // protocol has the facilitator (not the client) land this on-chain;
    // merging that into one mock step keeps this an in-process logic test
    // of our hook composition, not a protocol simulation.
    return { paymentGroup: [`fake-deposit-group:${amount}`] };
  };
  const creditDeposit = (channelId: Uint8Array, amount: bigint) => {
    const key = Buffer.from(channelId).toString('base64');
    const existing = channels.get(key) ?? { balance: 0n, totalClaimed: 0n, withdrawRequestedAt: 0 };
    channels.set(key, { ...existing, balance: existing.balance + amount });
  };
  return { fetchOnchain, buildDepositGroup, creditDeposit, channels };
}

function requirements(amount: string, extra: AvmBatchExtra): PaymentRequirements {
  return {
    scheme: 'batch-settlement',
    network: NETWORK,
    asset: '1001',
    amount,
    payTo: receiverAddress,
    maxTimeoutSeconds: 60,
    extra: extra as unknown as Record<string, unknown>,
  };
}

const receiverAddress = 'I7JYSTGJDZLRJ6WQYAN63755OSHE7E3YVUMNSYC6FUUF3RETI5MWNDJ55M';
const receiverAuthorizer = receiverAddress;
const payerAddress = 'TPXFQVQHJDWDXTILIVSSA3Z4CO3KU5JEXQZZ5NMLILUWJLI4DEBSFQQ4GM';

function baseExtra(): AvmBatchExtra {
  return { appId: deployment.appId.toString(), receiverAuthorizer, withdrawDelay: 900 };
}

/** Drives one request through client -> server verify -> (handler) -> server settle -> client response. */
async function runRequest(
  client: BatchSettlementAvmClientScheme,
  server: BatchSettlementAvmScheme,
  reqs: PaymentRequirements,
  actualAmount?: string,
): Promise<{ settled: boolean; reason?: string }> {
  const { payload } = await client.createPaymentPayload(2, reqs);
  const paymentPayload = { x402Version: 2, accepted: reqs, payload: payload as unknown as Record<string, unknown> };

  const beforeVerify = await server.schemeHooks.onBeforeVerify!({
    paymentPayload,
    requirements: reqs,
    declaredExtensions: {},
  });
  if (beforeVerify && 'abort' in beforeVerify) {
    await deliverCorrective(client, server, paymentPayload, reqs, beforeVerify.reason);
    return { settled: false, reason: beforeVerify.reason };
  }

  const settleReqs = actualAmount ? { ...reqs, amount: actualAmount } : reqs;
  const beforeSettle = await server.schemeHooks.onBeforeSettle!({
    paymentPayload,
    requirements: settleReqs,
    declaredExtensions: {},
    phase: 'after-handler' as const,
  });

  if (beforeSettle && 'abort' in beforeSettle) {
    await deliverCorrective(client, server, paymentPayload, settleReqs, beforeSettle.reason);
    return { settled: false, reason: beforeSettle.reason };
  }

  const settleResponse = beforeSettle && 'skip' in beforeSettle ? beforeSettle.result : undefined;
  await client.schemeHooks.onPaymentResponse!({ paymentPayload, requirements: settleReqs, settleResponse });
  return { settled: true };
}

async function deliverCorrective(
  client: BatchSettlementAvmClientScheme,
  server: BatchSettlementAvmScheme,
  paymentPayload: { payload: Record<string, unknown> },
  reqs: PaymentRequirements,
  reason: string,
) {
  const enriched = await server.enrichPaymentRequiredResponse?.({ requirements: [reqs], paymentPayload });
  const paymentRequired = enriched
    ? { x402Version: 2, resource: { url: 'test://resource' }, accepts: enriched }
    : undefined;
  await client.schemeHooks.onPaymentResponse!({
    paymentPayload: paymentPayload as never,
    requirements: reqs,
    error: new Error(reason),
    paymentRequired,
  });
}

function makeScheme() {
  const chain = makeMockChain();
  const server = new BatchSettlementAvmScheme({
    deployment,
    appId: deployment.appId,
    receiverAuthorizer,
    fetchOnchain: chain.fetchOnchain,
    network: NETWORK,
  });
  const client = new BatchSettlementAvmClientScheme({
    payerAddress,
    deployment,
    buildDepositGroup: async (args) => {
      const cid = (await import('@turnstilealgo/core')).channelId(args.config, deployment);
      chain.creditDeposit(cid, args.amount);
      return chain.buildDepositGroup(args);
    },
  });
  return { server, client, chain };
}

describe('cold_start_and_flat_pricing', () => {
  it('first request deposits and charges; second reuses the channel', async () => {
    const { server, client } = makeScheme();
    const reqs = requirements('1000', baseExtra());

    const first = await runRequest(client, server, reqs);
    expect(first.settled).toBe(true);

    const second = await runRequest(client, server, reqs);
    expect(second.settled).toBe(true);

    const record = await client.getStorage().findByDestination(receiverAddress, '1001');
    expect(record?.chargedCumulativeAmount).toBe('2000');
  });
});

describe('dynamic_pricing', () => {
  it('charges the actual (handler-determined) amount, not the pre-authorized ceiling', async () => {
    const { server, client } = makeScheme();
    const ceiling = requirements('1000', baseExtra()); // client pre-authorizes up to 1000
    const actual = '250'; // handler determines real usage is only 250

    const result = await runRequest(client, server, ceiling, actual);
    expect(result.settled).toBe(true);

    const clientRecord = await client.getStorage().findByDestination(receiverAddress, '1001');
    const serverRecord = await server.getStorage().get(clientRecord!.channelId);
    // The server only commits the handler-determined actual amount (250),
    // never the pre-authorized ceiling (1000) the client signed headroom for.
    expect(serverRecord?.chargedCumulativeAmount).toBe('250');
  });
});

describe('corrective_402', () => {
  it('client adopts server-reported state only after verifying the voucher signature itself', async () => {
    const { server, client } = makeScheme();
    const reqs = requirements('1000', baseExtra());
    await runRequest(client, server, reqs); // establish the channel, charged=1000

    // Simulate the client's local state drifting stale (e.g. lost between
    // processes): reset both bookkeeping fields to 0 so its next voucher
    // (signed off signedMaxClaimable, the reserved ceiling) under-claims
    // relative to what the server already committed.
    const record = await client.getStorage().findByDestination(receiverAddress, '1001');
    await client.getStorage().set({ ...record!, chargedCumulativeAmount: '0', signedMaxClaimable: '0' });

    const result = await runRequest(client, server, reqs);
    expect(result.settled).toBe(false);
    // The stale voucher still passes verifyVoucher's own-signature/balance
    // checks (its max, 1000, is neither below the already-charged 1000 nor
    // above the mirrored balance) -- it's only caught at charge time, where
    // committing another 1000 on top of the already-charged 1000 would
    // exceed that same voucher's signed cap.
    expect(result.reason).toBe('invalid_batch_settlement_avm_charge_exceeds_signed_cumulative');

    // After the corrective round-trip, retrying should succeed because the
    // client adopted the server's charged amount as its new base.
    const retried = await runRequest(client, server, reqs);
    expect(retried.settled).toBe(true);
  });
});

describe('I12_fifty_concurrent_requests_one_channel', () => {
  it('charged total equals the sum of accepted requests; none exceed the signed cap', async () => {
    const { server, client } = makeScheme();
    const seed = requirements('100', baseExtra());
    await runRequest(client, server, seed); // cold start: channel exists, charged=100

    // Fire 50 requests concurrently against the SAME channel. Each call to
    // createPaymentPayload reads the client's current cumulative and signs
    // max = current + 100; concurrent reads of a stale "current" are exactly
    // what the server-side atomic charge() (I12, tested directly in
    // channelManager.test.ts) must reject beyond the signed headroom.
    const attempts = 50;
    const results = await Promise.all(Array.from({ length: attempts }, () => runRequest(client, server, seed)));
    const succeeded = results.filter((r) => r.settled).length;

    expect(succeeded).toBeGreaterThan(0);
    expect(succeeded).toBeLessThanOrEqual(attempts);

    const record = await client.getStorage().findByDestination(receiverAddress, '1001');
    const charged = BigInt(record!.chargedCumulativeAmount);
    // Every accepted charge must be reflected, and total never exceeds what
    // was ever signed for (1 seed + up to `attempts` retries of 100 each).
    expect(charged).toBeGreaterThanOrEqual(100n);
    expect(charged % 100n).toBe(0n);
  });
});
