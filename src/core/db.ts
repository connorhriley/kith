import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { discoverRepository, isWithin, physicalPath } from './repository.js';
import { tokenizeIdentifier } from './identifier-tokens.js';

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
  public readonly supportsFts5: boolean;
  public readonly repoRoot: string;
  public readonly commonGitDir: string | null;
  public readonly isLinkedWorktree: boolean;
  public readonly coordDir: string;
  public readonly dbPath: string;
  private inTransaction = false;

  constructor(repoRoot: string, customDbPath?: string) {
    const layout = discoverRepository(repoRoot);
    this.repoRoot = layout.checkoutRoot;
    this.commonGitDir = layout.commonGitDir;
    this.isLinkedWorktree = layout.isLinkedWorktree;
    for (let current = fs.realpathSync.native(repoRoot); isWithin(this.repoRoot, current); current = path.dirname(current)) {
      const local = path.join(current, '.coord');
      if (local !== layout.coordDir && fs.existsSync(path.join(local, 'state.db'))) {
        throw new Error(`Legacy checkout-local coordination state found at ${local}. Stop clients and preserve that directory before consolidating shared state.`);
      }
      if (current === this.repoRoot) break;
    }
    this.coordDir = layout.coordDir;
    if (physicalPath(this.coordDir) !== this.coordDir) throw new Error('Coordination directory must not be a symlink');
    this.dbPath = customDbPath ?? path.join(this.coordDir, 'state.db');
    if (!customDbPath && physicalPath(this.dbPath) !== this.dbPath) throw new Error('Coordination database must not be a symlink');
    const recoveryFiles = !customDbPath && (fs.existsSync(path.join(this.coordDir, 'merge-train.lock')) ||
      ['shadow-index', 'quarantine', 'snapshots', 'worktrees'].some(name => {
        const dir = path.join(this.coordDir, name);
        return fs.existsSync(dir) && (!fs.lstatSync(dir).isDirectory() || fs.readdirSync(dir).length > 0);
      }));
    const sidecars = ['-wal', '-shm', '-journal'].some(suffix => fs.existsSync(this.dbPath + suffix));
    if (!fs.existsSync(this.dbPath) && (recoveryFiles || sidecars)) {
      throw new Error('Missing coordination database with existing recovery state. Stop clients and preserve the database, sidecars and worktrees before repair.');
    }
    // Reject unknown state through a read-only connection before pragmas, checkpoints or setup writes.
    if (fs.existsSync(this.dbPath)) {
      const probe = new DatabaseSync(this.dbPath, { readOnly: true });
      try {
        probe.exec('PRAGMA busy_timeout=10000; BEGIN');
        CoordDatabase.schemaVersion(probe, !recoveryFiles);
        const check = probe.prepare('PRAGMA quick_check(1)').get() as { quick_check: string };
        if (check.quick_check !== 'ok') throw new Error('Damaged coordination database. Preserve all state before repair.');
      } finally { probe.close(); }
    }
    fs.mkdirSync(this.coordDir, { recursive: true, mode: 0o700 });
    for (const name of ['shadow-index', 'quarantine', 'snapshots', 'worktrees']) {
      const target = path.join(this.coordDir, name);
      if (!isWithin(this.coordDir, physicalPath(target)) || physicalPath(target) !== target) {
        throw new Error(`Coordination subdirectory must not be a symlink: ${name}`);
      }
      fs.mkdirSync(target, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);

    try {
      this.supportsFts5 = CoordDatabase.hasFts5(this.db);
      this.configurePragmas(); this.migrate(!recoveryFiles);
    }
    catch (err) { this.db.close(); throw err; }
  }

  public static hasFts5(db: DatabaseSyncType): boolean {
    return Boolean(db.prepare("SELECT 1 FROM pragma_module_list WHERE name='fts5'").get());
  }

  public markContractSearchDirty(): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES('contracts_fts_dirty','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  }

  /** Contracts are authoritative. Rebuild once after a runtime without FTS5 changed them. */
  public refreshContractSearch(): void {
    if (!this.supportsFts5) return;
    const dirty = () => (this.db.prepare("SELECT value FROM meta WHERE key='contracts_fts_dirty'").get() as { value: string } | undefined)?.value === '1';
    if (!dirty()) return;
    this.withTransaction(() => {
      if (!dirty()) return;
      this.db.exec('DELETE FROM contracts_fts');
      const insert = this.db.prepare('INSERT INTO contracts_fts(contract_id,file_path,symbol_name,tokenized_name,signature,doc_comment) VALUES(?,?,?,?,?,?)');
      const rows = this.db.prepare('SELECT id,file_path,symbol_name,signature,doc_comment FROM contracts').all() as Array<Record<string, string>>;
      for (const row of rows) insert.run(row.id, row.file_path, row.symbol_name, tokenizeIdentifier(row.symbol_name), row.signature, row.doc_comment);
      this.db.prepare("UPDATE meta SET value='0' WHERE key='contracts_fts_dirty'").run();
    });
  }

  private configureContractSearch(): void {
    if (!this.supportsFts5) { this.markContractSearchDirty(); return; }
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='contracts_fts'").get();
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS contracts_fts USING fts5(
          contract_id UNINDEXED,
          file_path,
          symbol_name,
          tokenized_name,
          signature,
          doc_comment
        );`);
    if (!exists) this.markContractSearchDirty();
    this.refreshContractSearch();
  }

  private configurePragmas(): void {
    this.db.exec(`
      PRAGMA busy_timeout = 10000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
    `);
  }

  private static schemaVersion(db: DatabaseSyncType, allowEmpty: boolean): number {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all() as Array<{ name: string }>;
    if (!tables.length) {
      if (!allowEmpty) throw new Error('Empty coordination database with existing recovery files. Preserve all state before repair.');
      return 1; // Fresh or interrupted first initialization, with no recovery files.
    }
    if (!tables.some(table => table.name === 'meta')) throw new Error('Missing coordination schema metadata. Preserve the database before repair.');
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
    if (row?.value !== '1' && row?.value !== '2') {
      throw new Error(`Unsupported coordination schema version: ${String(row?.value)}. Preserve the database before upgrading or repairing it.`);
    }
    const version = Number(row.value);
    const required = ['agents', 'tasks', 'locks', 'file_deps', 'contracts', 'conflicts', 'merge_queue', 'resources', 'quarantine', 'events',
      ...(version === 2 ? ['agent_sessions', 'mutex_waiters', 'mutex_runs'] : [])];
    if (required.some(name => !tables.some(table => table.name === name))) {
      throw new Error('Incomplete coordination schema. Preserve the database before repair.');
    }
    // Check ownership fields that could otherwise make live owners or guards appear absent.
    const columns: Record<string, string> = {
      agents: 'id,pid,pid_start_time,status,registered_at,lease_expires_at,worktree_path,branch',
      tasks: 'status,owner_agent_id,fencing_token,scope_globs_json,depends_on_json',
      locks: 'owner_agent_id,pattern,mode,fencing_token,expires_at',
      resources: 'type,name,owner_agent_id,fencing_token,expires_at',
      ...(version === 2 ? {
        agent_sessions: 'agent_id,token_hash,epoch',
        mutex_waiters: 'ticket,mutex_name,request_id,owner_agent_id,session_epoch,waiter_pid,waiter_start,expires_at',
        mutex_runs: 'mutex_name,run_id,owner_agent_id,session_epoch,fencing_token,supervisor_pid,supervisor_start,worker_pid,worker_start',
      } : {}),
    };
    for (const [table, fields] of Object.entries(columns)) {
      try { db.prepare(`SELECT ${fields} FROM ${table} LIMIT 0`); }
      catch { throw new Error(`Incomplete coordination schema (${table}). Preserve the database before repair.`); }
    }
    const epoch = CoordDatabase.fencingEpoch(db);
    const tokens = ['SELECT fencing_token AS token FROM locks', 'SELECT fencing_token FROM tasks',
      'SELECT fencing_token FROM resources', 'SELECT fencing_token FROM merge_queue',
      ...(version === 2 ? ['SELECT epoch FROM agent_sessions', 'SELECT session_epoch FROM mutex_waiters', 'SELECT fencing_token FROM mutex_runs'] : [])];
    if (db.prepare(`SELECT 1 FROM (${tokens.join(' UNION ALL ')}) WHERE token IS NOT NULL AND (typeof(token)!='integer' OR token<0 OR token>?) LIMIT 1`).get(epoch)) {
      throw new Error('Invalid or regressed fencing counter. Preserve the database before repair.');
    }
    return version;
  }

  private static fencingEpoch(db: DatabaseSyncType): number {
    const row = db.prepare("SELECT value FROM meta WHERE key='fencing_epoch'").get() as { value: string } | undefined;
    const epoch = Number(row?.value);
    if (!row || typeof row.value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.value) || !Number.isSafeInteger(epoch)) {
      throw new Error('Missing or invalid fencing counter. Preserve the database before repair.');
    }
    return epoch;
  }

  private migrate(allowEmpty: boolean): void {
    this.withTransaction(() => {
      const version = CoordDatabase.schemaVersion(this.db, allowEmpty);
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
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_sessions (
          agent_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, epoch INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mutex_waiters (
          ticket INTEGER PRIMARY KEY AUTOINCREMENT, mutex_name TEXT NOT NULL,
          request_id TEXT NOT NULL, owner_agent_id TEXT NOT NULL, session_epoch INTEGER NOT NULL,
          waiter_pid INTEGER NOT NULL, waiter_start TEXT NOT NULL, expires_at INTEGER NOT NULL,
          UNIQUE(mutex_name, request_id)
        );
        CREATE TABLE IF NOT EXISTS mutex_runs (
          mutex_name TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, owner_agent_id TEXT NOT NULL,
          session_epoch INTEGER NOT NULL, fencing_token INTEGER NOT NULL,
          supervisor_pid INTEGER NOT NULL, supervisor_start TEXT NOT NULL,
          worker_pid INTEGER, worker_start TEXT
        );
      `);
      if (version < 2) {
        // Legacy sessions have no capability. Invalidate coordination ownership, never files.
        this.db.exec(`
          UPDATE tasks SET status='queued', owner_agent_id=NULL, fencing_token=NULL
            WHERE status='active' AND owner_agent_id IN (SELECT id FROM agents);
          DELETE FROM locks;
          DELETE FROM resources;
          DELETE FROM conflicts;
          UPDATE agents SET status='dead' WHERE status='active';
          UPDATE meta SET value='2' WHERE key='schema_version';
        `);
      }
      this.configureContractSearch();
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
      const next = this.currentFencingEpoch() + 1;
      if (!Number.isSafeInteger(next)) throw new Error('Fencing counter exhausted; preserve state before recovery.');
      this.db.prepare("UPDATE meta SET value=? WHERE key='fencing_epoch'").run(String(next));
      return next;
    });
  }

  public currentFencingEpoch(): number {
    return CoordDatabase.fencingEpoch(this.db);
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
