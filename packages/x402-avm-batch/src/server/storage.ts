import type { ChannelConfigWire } from '@turnstilealgo/core';

export interface Channel {
  channelId: string; // base64, 32 bytes
  channelConfig: ChannelConfigWire;
  chargedCumulativeAmount: string; // decimal string, bigint
  signedMaxClaimable: string;
  signature: string; // base64, 64 bytes
  balance: string; // last-known on-chain balance (mirrored)
  totalClaimed: string; // last-known on-chain totalClaimed (mirrored)
  withdrawRequestedAt: number;
  onchainSyncedAt: number; // ms epoch of the last mirror refresh
  lastRequestTimestamp: number;
}

export interface ChannelUpdateResult {
  channel: Channel | undefined;
  status: 'updated' | 'unchanged' | 'deleted';
}

export interface ChannelStorage {
  get(channelId: string): Promise<Channel | undefined>;
  list(): Promise<Channel[]>;
  /**
   * Atomically inspects and mutates a channel record. Implementations must
   * guarantee no concurrent mutation interleaves between reading `current`
   * and writing the callback's result, for every application instance
   * sharing the backend. The in-memory backend only guarantees this inside
   * one JS runtime -- a multi-instance deployment needs a backend with
   * real atomic conditional mutation (SQL transaction, Redis script, etc).
   */
  updateChannel(
    channelId: string,
    update: (current: Channel | undefined) => Channel | undefined,
  ): Promise<ChannelUpdateResult>;
}

/** In-memory {@link ChannelStorage} backed by a Map, serialized per channel. */
export class InMemoryChannelStorage implements ChannelStorage {
  private readonly channels = new Map<string, Channel>();
  private readonly channelLocks = new Map<string, Promise<void>>();

  async get(channelId: string): Promise<Channel | undefined> {
    return this.channels.get(channelId);
  }

  async list(): Promise<Channel[]> {
    return [...this.channels.values()];
  }

  async updateChannel(
    channelId: string,
    update: (current: Channel | undefined) => Channel | undefined,
  ): Promise<ChannelUpdateResult> {
    return this.withChannelLock(channelId, async () => {
      const current = this.channels.get(channelId);
      const next = update(current);

      if (next === current) {
        return { channel: current, status: 'unchanged' as const };
      }
      if (!next) {
        this.channels.delete(channelId);
        return { channel: undefined, status: current ? ('deleted' as const) : ('unchanged' as const) };
      }
      this.channels.set(channelId, next);
      return { channel: next, status: 'updated' as const };
    });
  }

  /** Runs `fn` after any prior locked work for this channel key has finished. */
  private async withChannelLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.channelLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => {}).then(() => current);
    this.channelLocks.set(key, next);

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.channelLocks.get(key) === next) {
        this.channelLocks.delete(key);
      }
    }
  }
}
