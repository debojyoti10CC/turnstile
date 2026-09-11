import type { ChannelConfigWire } from '@turnstile/core';

export interface ClientChannelRecord {
  channelId: string; // base64
  channelConfig: ChannelConfigWire;
  /** ed25519 seed for the session key that signs vouchers (payerAuthorizer). */
  sessionKey: Uint8Array;
  chargedCumulativeAmount: string;
  signedMaxClaimable: string;
  signature: string; // base64
  /** True once the server has confirmed this voucher (a successful response came back for it). */
  confirmed: boolean;
}

export interface ClientChannelStorage {
  get(channelId: string): Promise<ClientChannelRecord | undefined>;
  /**
   * Finds the channel the client would reuse for a given (receiver, asset)
   * pair. Callers should use one storage instance per app deployment
   * (appId), since `ChannelConfigWire` has no appId field of its own.
   */
  findByDestination(receiver: string, asset: string): Promise<ClientChannelRecord | undefined>;
  set(record: ClientChannelRecord): Promise<void>;
}

export class InMemoryClientChannelStorage implements ClientChannelStorage {
  private readonly channels = new Map<string, ClientChannelRecord>();

  async get(channelId: string): Promise<ClientChannelRecord | undefined> {
    return this.channels.get(channelId);
  }

  async findByDestination(receiver: string, asset: string): Promise<ClientChannelRecord | undefined> {
    for (const record of this.channels.values()) {
      if (record.channelConfig.receiver === receiver && record.channelConfig.asset === asset) return record;
    }
    return undefined;
  }

  async set(record: ClientChannelRecord): Promise<void> {
    this.channels.set(record.channelId, record);
  }
}
