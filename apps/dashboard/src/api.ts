export const MERCHANT_URL = import.meta.env.VITE_MERCHANT_URL ?? 'http://localhost:4403';

export interface Channel {
  channelId: string;
  channelConfig: {
    payer: string;
    receiver: string;
    asset: string;
    withdrawDelay: number;
    salt: string;
  };
  chargedCumulativeAmount: string;
  signedMaxClaimable: string;
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  onchainSyncedAt: number;
  lastRequestTimestamp: number;
}

export interface ChannelsResponse {
  appId: string;
  network: string;
  withdrawDelaySeconds: number;
  channels: Channel[];
}

export interface BenchRun {
  mode: 'batch' | 'exact';
  calls: number;
  succeeded: number;
  failed: number;
  wallTimeMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  onChainTxnCount: number;
  totalFeesMicroAlgo: number;
  mbrLockedMicroAlgo: number;
}

export interface AdversaryResult {
  attack: string;
  layer: string;
  expected: string;
  actual: string;
  pass: boolean;
  detail?: string;
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${MERCHANT_URL}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const fetchChannels = () => getJson<ChannelsResponse>('/debug/channels');
export const fetchBench = () => getJson<BenchRun[]>('/debug/bench');
export const fetchAdversaryReport = () => getJson<AdversaryResult[]>('/debug/adversary-report');
