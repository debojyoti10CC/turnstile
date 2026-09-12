import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteChannelStorage } from '../src/server/sqliteStorage.js';
import type { Channel } from '../src/server/storage.js';

const CHANNEL_CONFIG = {
  payer: 'PAYER',
  payerAuthorizer: 'PAYER_AUTH',
  receiver: 'RECEIVER',
  receiverAuthorizer: 'RECEIVER_AUTH',
  asset: '1',
  withdrawDelay: 900,
  salt: 'c2FsdA==',
};

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    channelId: 'channel-1',
    channelConfig: CHANNEL_CONFIG,
    chargedCumulativeAmount: '0',
    signedMaxClaimable: '1000',
    signature: 'sig',
    balance: '10000',
    totalClaimed: '0',
    withdrawRequestedAt: 0,
    onchainSyncedAt: 1,
    lastRequestTimestamp: 1,
    ...overrides,
  };
}

describe('SqliteChannelStorage (I9/I12 persistence backend)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'turnstile-sqlite-'));
    dirs.push(dir);
    return join(dir, 'channels.sqlite');
  }

  it('get() returns undefined for an unknown channel', async () => {
    const storage = new SqliteChannelStorage(tempDbPath());
    await expect(storage.get('missing')).resolves.toBeUndefined();
    storage.close();
  });

  it('updateChannel() creates, then updates, a row; list() reflects it', async () => {
    const storage = new SqliteChannelStorage(tempDbPath());

    const created = await storage.updateChannel('channel-1', (current) => {
      expect(current).toBeUndefined();
      return makeChannel();
    });
    expect(created.status).toBe('updated');
    expect(created.channel?.chargedCumulativeAmount).toBe('0');

    const updated = await storage.updateChannel('channel-1', (current) => {
      expect(current?.chargedCumulativeAmount).toBe('0');
      return { ...current!, chargedCumulativeAmount: '500' };
    });
    expect(updated.status).toBe('updated');
    expect(updated.channel?.chargedCumulativeAmount).toBe('500');

    const listed = await storage.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.chargedCumulativeAmount).toBe('500');

    storage.close();
  });

  it('updateChannel() returning the same reference reports "unchanged"', async () => {
    const storage = new SqliteChannelStorage(tempDbPath());
    await storage.updateChannel('channel-1', () => makeChannel());

    const result = await storage.updateChannel('channel-1', (current) => current);
    expect(result.status).toBe('unchanged');

    storage.close();
  });

  it('updateChannel() returning undefined deletes the row', async () => {
    const storage = new SqliteChannelStorage(tempDbPath());
    await storage.updateChannel('channel-1', () => makeChannel());

    const deleted = await storage.updateChannel('channel-1', () => undefined);
    expect(deleted.status).toBe('deleted');
    await expect(storage.get('channel-1')).resolves.toBeUndefined();

    storage.close();
  });

  it('persists across instances reopening the same file (I9/I12 survive a restart)', async () => {
    const dbPath = tempDbPath();
    const first = new SqliteChannelStorage(dbPath);
    await first.updateChannel('channel-1', () => makeChannel({ chargedCumulativeAmount: '750' }));
    first.close();

    const second = new SqliteChannelStorage(dbPath);
    const reloaded = await second.get('channel-1');
    expect(reloaded?.chargedCumulativeAmount).toBe('750');
    second.close();
  });

  it('I12: concurrent updateChannel calls on one channel never lose an increment', async () => {
    const storage = new SqliteChannelStorage(tempDbPath());
    await storage.updateChannel('channel-1', () => makeChannel({ chargedCumulativeAmount: '0' }));

    const bump = () =>
      storage.updateChannel('channel-1', (current) => ({
        ...current!,
        chargedCumulativeAmount: String(BigInt(current!.chargedCumulativeAmount) + 1n),
      }));

    await Promise.all(Array.from({ length: 20 }, bump));

    const final = await storage.get('channel-1');
    expect(final?.chargedCumulativeAmount).toBe('20');

    storage.close();
  });
});
