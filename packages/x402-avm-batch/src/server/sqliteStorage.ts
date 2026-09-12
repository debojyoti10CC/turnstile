import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { ChannelConfigWire } from '@turnstilealgo/core';
import type { Channel, ChannelStorage, ChannelUpdateResult } from './storage.js';

// Loaded via createRequire rather than a static `import ... from 'node:sqlite'`:
// Vite's SSR module graph (used by vitest to run this package's tests) does
// not yet recognize this newer node: builtin and tries to resolve it as a
// bare npm package named "sqlite", which does not exist. require() bypasses
// Vite's resolution entirely and hits Node's real module loader.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

interface ChannelRow {
  channel_id: string;
  config_json: string;
  charged_cumulative: string;
  signed_max_claimable: string;
  signature: string;
  balance: string;
  total_claimed: string;
  withdraw_requested_at: number;
  onchain_synced_at: number;
  last_request_at: number;
  version: number;
}

function rowToChannel(row: ChannelRow): Channel {
  return {
    channelId: row.channel_id,
    channelConfig: JSON.parse(row.config_json) as ChannelConfigWire,
    chargedCumulativeAmount: row.charged_cumulative,
    signedMaxClaimable: row.signed_max_claimable,
    signature: row.signature,
    balance: row.balance,
    totalClaimed: row.total_claimed,
    withdrawRequestedAt: row.withdraw_requested_at,
    onchainSyncedAt: row.onchain_synced_at,
    lastRequestTimestamp: row.last_request_at,
  };
}

/**
 * SQLite-backed {@link ChannelStorage}, per CLAUDE.md §6's schema, built on
 * Node's built-in `node:sqlite` (no native addon / build toolchain needed --
 * see docs/DECISIONS.md for why this replaced `better-sqlite3`).
 *
 * Every mutation runs inside one `BEGIN IMMEDIATE` transaction, so
 * `updateChannel`'s read-modify-write is atomic even across multiple OS
 * processes sharing the same database file (SQLite's own file locking
 * serializes writers) -- not just within one JS runtime, which is the limit
 * of {@link InMemoryChannelStorage}.
 */
export class SqliteChannelStorage implements ChannelStorage {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        charged_cumulative TEXT NOT NULL,
        signed_max_claimable TEXT NOT NULL,
        signature TEXT NOT NULL,
        balance TEXT NOT NULL,
        total_claimed TEXT NOT NULL,
        withdraw_requested_at INTEGER NOT NULL DEFAULT 0,
        onchain_synced_at INTEGER NOT NULL,
        last_request_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  async get(channelId: string): Promise<Channel | undefined> {
    const row = this.db.prepare('SELECT * FROM channels WHERE channel_id = ?').get(channelId) as
      | ChannelRow
      | undefined;
    return row ? rowToChannel(row) : undefined;
  }

  async list(): Promise<Channel[]> {
    const rows = this.db.prepare('SELECT * FROM channels').all() as unknown as ChannelRow[];
    return rows.map(rowToChannel);
  }

  async updateChannel(
    channelId: string,
    update: (current: Channel | undefined) => Channel | undefined,
  ): Promise<ChannelUpdateResult> {
    // BEGIN IMMEDIATE takes the write lock up front, so two processes racing
    // on the same file serialize instead of one silently losing a
    // lost-update race (node:sqlite has no built-in transaction() helper,
    // unlike better-sqlite3, so this is done by hand).
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM channels WHERE channel_id = ?').get(channelId) as
        | ChannelRow
        | undefined;
      const current = row ? rowToChannel(row) : undefined;
      const next = update(current);

      let result: ChannelUpdateResult;
      if (next === current) {
        result = { channel: current, status: 'unchanged' };
      } else if (!next) {
        this.db.prepare('DELETE FROM channels WHERE channel_id = ?').run(channelId);
        result = { channel: undefined, status: current ? 'deleted' : 'unchanged' };
      } else {
        const nextVersion = (row?.version ?? 0) + 1;
        this.db
          .prepare(
            `INSERT INTO channels (
               channel_id, config_json, charged_cumulative, signed_max_claimable,
               signature, balance, total_claimed, withdraw_requested_at,
               onchain_synced_at, last_request_at, version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(channel_id) DO UPDATE SET
               config_json = excluded.config_json,
               charged_cumulative = excluded.charged_cumulative,
               signed_max_claimable = excluded.signed_max_claimable,
               signature = excluded.signature,
               balance = excluded.balance,
               total_claimed = excluded.total_claimed,
               withdraw_requested_at = excluded.withdraw_requested_at,
               onchain_synced_at = excluded.onchain_synced_at,
               last_request_at = excluded.last_request_at,
               version = excluded.version`,
          )
          .run(
            next.channelId,
            JSON.stringify(next.channelConfig),
            next.chargedCumulativeAmount,
            next.signedMaxClaimable,
            next.signature,
            next.balance,
            next.totalClaimed,
            next.withdrawRequestedAt,
            next.onchainSyncedAt,
            next.lastRequestTimestamp,
            nextVersion,
          );
        result = { channel: next, status: 'updated' };
      }
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
