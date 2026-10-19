import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export interface CoordEvent {
  id: number;
  timestamp: number;
  agent_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
}

export class CoordDatabase {
  public readonly db: DatabaseSyncType;
  public readonly repoRoot: string;
  public readonly coordDir: string;
  public readonly dbPath: string;
  private inTransaction = false;

  constructor(repoRoot: string, customDbPath?: string) {
    this.repoRoot = path.resolve(repoRoot);
    this.coordDir = path.join(this.repoRoot, '.coord');
    fs.mkdirSync(this.coordDir, { recursive: true });
    fs.mkdirSync(path.join(this.coordDir, 'shadow-index'), { recursive: true });
    fs.mkdirSync(path.join(this.coordDir, 'quarantine'), { recursive: true });
    fs.mkdirSync(path.join(this.coordDir, 'snapshots'), { recursive: true });
    fs.mkdirSync(path.join(this.coordDir, 'worktrees'), { recursive: true });

    this.dbPath = customDbPath ?? path.join(this.coordDir, 'state.db');
    this.db = new DatabaseSync(this.dbPath);

    this.configurePragmas();
    this.migrate();
  }

  private configurePragmas(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 10000;
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
    `);
  }

  private migrate(): void {
    this.withTransaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        INSERT OR IGNORE INTO meta (key, value) VALUES ('fencing_epoch', '1000');
        INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');

        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          client TEXT NOT NULL,
          pid INTEGER NOT NULL,
          pid_start_time TEXT NOT NULL,
          pgid INTEGER NOT NULL,
          worktree_path TEXT,
          branch TEXT,
          shadow_tree_sha TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          last_seen_event_id INTEGER NOT NULL DEFAULT 0,
          registered_at INTEGER NOT NULL,
          last_heartbeat_at INTEGER NOT NULL,
          lease_expires_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          intent_summary TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          priority INTEGER NOT NULL DEFAULT 0,
          owner_agent_id TEXT,
          fencing_token INTEGER,
          depends_on_json TEXT NOT NULL DEFAULT '[]',
          scope_globs_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC);
        CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_agent_id);

        CREATE TABLE IF NOT EXISTS locks (
          id TEXT PRIMARY KEY,
          pattern TEXT NOT NULL,
          lock_type TEXT NOT NULL DEFAULT 'glob',
          mode TEXT NOT NULL DEFAULT 'exclusive',
          owner_agent_id TEXT NOT NULL,
          task_id TEXT,
          fencing_token INTEGER NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          acquired_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_locks_owner ON locks(owner_agent_id);
        CREATE INDEX IF NOT EXISTS idx_locks_pattern ON locks(pattern);

        CREATE TABLE IF NOT EXISTS file_deps (
          source_file TEXT NOT NULL,
          target_file TEXT NOT NULL,
          imported_symbols_json TEXT NOT NULL DEFAULT '[]',
          file_hash TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (source_file, target_file)
        );

        CREATE INDEX IF NOT EXISTS idx_file_deps_target ON file_deps(target_file);

        CREATE TABLE IF NOT EXISTS contracts (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          symbol_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          signature TEXT NOT NULL,
          ast_hash TEXT NOT NULL,
          params_fingerprint TEXT NOT NULL,
          doc_comment TEXT NOT NULL DEFAULT '',
          owner_agent_id TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          is_breaking INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          UNIQUE(file_path, symbol_name)
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS contracts_fts USING fts5(
          contract_id UNINDEXED,
          file_path,
          symbol_name,
          tokenized_name,
          signature,
          doc_comment
        );

        CREATE TABLE IF NOT EXISTS conflicts (
          id TEXT PRIMARY KEY,
          agent_a TEXT NOT NULL,
          agent_b TEXT NOT NULL,
          file_path TEXT NOT NULL,
          severity TEXT NOT NULL,
          details_json TEXT NOT NULL,
          detected_at INTEGER NOT NULL,
          UNIQUE(agent_a, agent_b, file_path)
        );

        CREATE TABLE IF NOT EXISTS merge_queue (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          branch TEXT NOT NULL,
          worktree_path TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          fencing_token INTEGER NOT NULL,
          verification_cmd TEXT,
          diagnostics_output TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS resources (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          value TEXT NOT NULL,
          owner_agent_id TEXT NOT NULL,
          fencing_token INTEGER NOT NULL,
          queue_json TEXT NOT NULL DEFAULT '[]',
          acquired_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          UNIQUE(type, name)
        );

        CREATE TABLE IF NOT EXISTS quarantine (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          command TEXT NOT NULL,
          file_path TEXT NOT NULL,
          patch_path TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          agent_id TEXT,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
      `);
    });
  }

  /**
   * Executes a synchronous callback inside a `BEGIN IMMEDIATE` transaction
   * with automatic jittered backoff retries if another process temporarily holds the WAL write lock.
   */
  public withTransaction<T>(fn: () => T, maxRetries = 12): T {
    if (this.inTransaction) {
      return fn();
    }

    let attempt = 0;
    while (true) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        this.inTransaction = true;
        try {
          const result = fn();
          this.db.exec('COMMIT');
          this.inTransaction = false;
          return result;
        } catch (innerErr) {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            // Ignore rollback errors if connection already rolled back
          }
          this.inTransaction = false;
          throw innerErr;
        }
      } catch (err: unknown) {
        this.inTransaction = false;
        const msg = err instanceof Error ? err.message : String(err);
        if (
          attempt < maxRetries &&
          (msg.includes('SQLITE_BUSY') || msg.includes('database is locked'))
        ) {
          attempt++;
          const sleepMs = Math.min(250, 5 * Math.pow(1.5, attempt) + Math.random() * 10);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(sleepMs));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Atomically increments and returns the next monotonic fencing token.
   */
  public nextFencingToken(): number {
    return this.withTransaction(() => {
      this.db.prepare(`
        UPDATE meta
        SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
        WHERE key = 'fencing_epoch'
      `).run();

      const row = this.db
        .prepare(`SELECT value FROM meta WHERE key = 'fencing_epoch'`)
        .get() as { value: string } | undefined;

      return Number(row?.value ?? 1001);
    });
  }

  public currentFencingEpoch(): number {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = 'fencing_epoch'`)
      .get() as { value: string } | undefined;
    return Number(row?.value ?? 1000);
  }

  public logEvent(
    agentId: string | null,
    eventType: string,
    payload: Record<string, unknown> = {}
  ): number {
    const res = this.db
      .prepare(`
        INSERT INTO events (timestamp, agent_id, event_type, payload_json)
        VALUES (?, ?, ?, ?)
      `)
      .run(Date.now(), agentId, eventType, JSON.stringify(payload));
    return Number(res.lastInsertRowid);
  }

  public getEventsSince(sinceId: number, limit = 100): CoordEvent[] {
    const rows = this.db
      .prepare(`
        SELECT id, timestamp, agent_id, event_type, payload_json
        FROM events
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(sinceId, limit) as Array<{
      id: number;
      timestamp: number;
      agent_id: string | null;
      event_type: string;
      payload_json: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      agent_id: r.agent_id,
      event_type: r.event_type,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    }));
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore already closed
    }
  }
}
