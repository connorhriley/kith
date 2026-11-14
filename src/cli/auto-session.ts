import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as SqliteDatabaseSync } from 'node:sqlite';
import { KithEngine } from '../core/engine.js';
import { FencingAndAgentManager } from '../core/fencing.js';
import { isWithin, physicalPath, type RepositoryLayout } from '../core/repository.js';

const PRESENCE_TTL_MS = 12 * 60 * 60 * 1000;
const require = createRequire(import.meta.url);

function openSqlite(filePath: string): SqliteDatabaseSync {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL;');
  const existingCols = db.prepare('PRAGMA table_info(presence)').all() as Array<{ name: string; pk: number }>;
  const pkCount = existingCols.filter((c) => c.pk > 0).length;
  if (existingCols.length > 0 && pkCount < 2) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE presence_v2 (
        session_key TEXT NOT NULL,
        repo_common_dir TEXT NOT NULL,
        checkout_root TEXT NOT NULL,
        client TEXT NOT NULL,
        pid INTEGER NOT NULL,
        touched_files_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (repo_common_dir, session_key)
      );
      INSERT OR REPLACE INTO presence_v2 (session_key, repo_common_dir, checkout_root, client, pid, touched_files_json, created_at, last_seen_at)
      SELECT session_key, repo_common_dir, checkout_root, client, pid, touched_files_json, created_at, last_seen_at FROM presence;
      DROP TABLE presence;
      ALTER TABLE presence_v2 RENAME TO presence;
      COMMIT;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS presence (
      session_key TEXT NOT NULL,
      repo_common_dir TEXT NOT NULL,
      checkout_root TEXT NOT NULL,
      client TEXT NOT NULL,
      pid INTEGER NOT NULL,
      touched_files_json TEXT NOT NULL DEFAULT '[]',
      recent_files_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (repo_common_dir, session_key)
    );
    CREATE INDEX IF NOT EXISTS idx_presence_repo ON presence(repo_common_dir, last_seen_at);
    CREATE TABLE IF NOT EXISTS capabilities (
      repo_common_dir TEXT NOT NULL,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_token TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (repo_common_dir, session_key)
    );
  `);
  const colsAfter = db.prepare('PRAGMA table_info(presence)').all() as Array<{ name: string }>;
  if (!colsAfter.some((c) => c.name === 'recent_files_json')) {
    db.exec(`
      ALTER TABLE presence ADD COLUMN recent_files_json TEXT NOT NULL DEFAULT '[]';
      UPDATE presence SET recent_files_json = touched_files_json WHERE recent_files_json = '[]';
    `);
  }
  return db;
}

export interface ActivePresence {
  sessionKey: string;
  agentId: string;
  repoCommonDir: string;
  checkoutRoot: string;
  client: string;
  pid: number;
  touchedFiles: string[];
  recentFiles: string[];
  createdAt: number;
  lastSeenAt: number;
}

export function resolveHomeDir(explicitHome?: string): string {
  const raw = explicitHome || process.env.KITH_HOME || process.env.HOME || os.homedir();
  return physicalPath(raw);
}

export function presenceDbPath(home?: string): string {
  return path.join(resolveHomeDir(home), '.local/share/kith/presence.db');
}

export function extractHookSessionKey(
  client: string | boolean | undefined,
  payload?: Record<string, any>
): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const rawId = typeof payload.session_id === 'string' && payload.session_id.trim()
    ? payload.session_id.trim()
    : typeof payload.conversation_id === 'string' && payload.conversation_id.trim()
      ? payload.conversation_id.trim()
      : null;
  if (!rawId || rawId.length > 200) return null;
  const prefix = typeof client === 'string' && /^[a-z0-9_-]{1,20}$/i.test(client) ? client.toLowerCase() : 'auto';
  return `${prefix}:${rawId}`;
}

function existingParentDir(targetPath: string): string | null {
  let cur = targetPath;
  while (true) {
    try {
      const stat = fs.statSync(cur);
      return stat.isDirectory() ? cur : path.dirname(cur);
    } catch {
      const next = path.dirname(cur);
      if (next === cur) return null;
      cur = next;
    }
  }
}

function hasGitAncestor(dir: string): boolean {
  let cur = dir;
  while (true) {
    if (fs.existsSync(path.join(cur, '.git'))) return true;
    const next = path.dirname(cur);
    if (next === cur) return false;
    cur = next;
  }
}

export function resolveHookStartDir(
  explicitRepo: string | boolean | undefined,
  payload?: Record<string, any>,
  fallbackCwd = process.cwd()
): string {
  if (typeof explicitRepo === 'string' && explicitRepo.trim()) return path.resolve(explicitRepo);
  let baseCwd = fallbackCwd;
  if (typeof payload?.cwd === 'string' && path.isAbsolute(payload.cwd) && fs.existsSync(payload.cwd)) {
    baseCwd = payload.cwd;
  } else if (Array.isArray(payload?.workspace_roots)) {
    const first = payload.workspace_roots.find((p: unknown) => typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p));
    if (first) baseCwd = first;
  }

  const input = payload?.tool_input;
  if (input && typeof input === 'object') {
    const rawFile =
      input.file_path ??
      input.notebook_path ??
      input.target_file ??
      input.path ??
      (Array.isArray(input.edits) ? input.edits[0]?.file_path : undefined);
    if (typeof rawFile === 'string' && rawFile.trim()) {
      const resolvedFile = path.isAbsolute(rawFile) ? rawFile : path.resolve(baseCwd, rawFile);
      const dir = existingParentDir(resolvedFile);
      if (dir && hasGitAncestor(dir)) return dir;
    }
    if (typeof input.command === 'string' && input.command.trim()) {
      const cdMatch = /(?:^|[;&|]\s*|\bgit\s+-C\s+|\bcd\s+)(?:['"]([^'"]+)['"]|([^\s;&|'"`]+))/.exec(input.command);
      const rawTarget = cdMatch?.[1] ?? cdMatch?.[2];
      if (rawTarget && !rawTarget.startsWith('-')) {
        const resolvedDir = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(baseCwd, rawTarget);
        const dir = existingParentDir(resolvedDir);
        if (dir && hasGitAncestor(dir)) return dir;
      }
    }
  }

  return baseCwd;
}

/**
 * Hooks are often spawned inside transient `/bin/sh -c` subshells that exit as soon as the
 * hook finishes. Walk past shell wrappers on POSIX so fencing binds to the persistent host PID.
 */
export function resolvePersistentOwnerPid(startPid = process.ppid || process.pid): number {
  if (process.platform === 'win32' || !Number.isSafeInteger(startPid) || startPid <= 1) {
    return startPid > 0 ? startPid : process.pid;
  }
  let current = startPid;
  for (let hop = 0; hop < 4; hop++) {
    try {
      const line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(current)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).trim();
      const match = /^(\d+)\s+(.+)$/.exec(line);
      if (!match) break;
      const parentPid = Number(match[1]);
      const base = path.basename(match[2].trim()).replace(/^-/, '').toLowerCase();
      if (!['sh', 'dash', 'bash', 'zsh', 'ash', 'ksh'].includes(base)) break;
      if (!Number.isSafeInteger(parentPid) || parentPid <= 1) break;
      current = parentPid;
    } catch {
      break;
    }
  }
  return current > 0 ? current : process.pid;
}

function withPresenceDb<T>(home: string | undefined, create: boolean, fn: (db: SqliteDatabaseSync) => T): T | null {
  const file = presenceDbPath(home);
  if (!create && !fs.existsSync(file)) return null;
  const dir = path.dirname(file);
  if (create) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (physicalPath(dir) !== dir) return null;
  if (fs.existsSync(file) && physicalPath(file) !== file) return null;
  const db = openSqlite(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function rowToPresence(row: Record<string, any>): ActivePresence {
  let touchedFiles: string[] = [];
  let recentFiles: string[] = [];
  try {
    const parsed = JSON.parse(String(row.touched_files_json ?? '[]'));
    if (Array.isArray(parsed)) touchedFiles = parsed.filter((x): x is string => typeof x === 'string');
  } catch { /* ignore malformed json */ }
  try {
    const parsedRecent = JSON.parse(String(row.recent_files_json ?? '[]'));
    if (Array.isArray(parsedRecent)) recentFiles = parsedRecent.filter((x): x is string => typeof x === 'string');
  } catch { /* ignore malformed json */ }
  if (recentFiles.length === 0 && touchedFiles.length > 0) {
    recentFiles = [...touchedFiles];
  }
  const sessionKey = String(row.session_key);
  const client = String(row.client);
  const agentId = typeof row.agent_id === 'string' && row.agent_id
    ? row.agent_id
    : deterministicAgentId(client, sessionKey);
  return {
    sessionKey,
    agentId,
    repoCommonDir: String(row.repo_common_dir),
    checkoutRoot: String(row.checkout_root),
    client,
    pid: Number(row.pid),
    touchedFiles,
    recentFiles,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function pruneDeadPresence(db: SqliteDatabaseSync, now: number): void {
  const rows = db.prepare('SELECT session_key, repo_common_dir, pid, last_seen_at FROM presence').all() as Array<{
    session_key: string;
    repo_common_dir: string;
    pid: number;
    last_seen_at: number;
  }>;
  for (const row of rows) {
    if (!isPidAlive(row.pid)) {
      db.prepare('DELETE FROM presence WHERE session_key = ?').run(row.session_key);
      db.prepare('DELETE FROM capabilities WHERE session_key = ?').run(row.session_key);
    } else if (row.last_seen_at < now - PRESENCE_TTL_MS) {
      db.prepare('DELETE FROM presence WHERE repo_common_dir = ? AND session_key = ?').run(row.repo_common_dir, row.session_key);
      db.prepare('DELETE FROM capabilities WHERE repo_common_dir = ? AND session_key = ?').run(row.repo_common_dir, row.session_key);
    }
  }
  db.prepare(`
    DELETE FROM capabilities
    WHERE updated_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM presence p
        WHERE p.repo_common_dir = capabilities.repo_common_dir
          AND p.session_key = capabilities.session_key
      )
  `).run(now - PRESENCE_TTL_MS);
}

export function recordPresence(
  home: string | undefined,
  params: {
    sessionKey: string;
    repoCommonDir: string;
    checkoutRoot: string;
    client: string;
    pid: number;
    filePath?: string;
    clearTouchedFiles?: boolean;
  }
): ActivePresence[] {
  const now = Date.now();
  return withPresenceDb(home, true, (db) => {
    pruneDeadPresence(db, now);
    const existing = db.prepare('SELECT touched_files_json, recent_files_json, created_at FROM presence WHERE repo_common_dir = ? AND session_key = ?')
      .get(params.repoCommonDir, params.sessionKey) as { touched_files_json?: string; recent_files_json?: string; created_at?: number } | undefined;
    let touched: string[] = [];
    let recent: string[] = [];
    if (!params.clearTouchedFiles && existing?.touched_files_json) {
      try {
        const parsed = JSON.parse(existing.touched_files_json);
        if (Array.isArray(parsed)) touched = parsed.filter((x): x is string => typeof x === 'string');
      } catch { /* ignore */ }
    }
    const rawRecent = existing?.recent_files_json && existing.recent_files_json !== '[]'
      ? existing.recent_files_json
      : existing?.touched_files_json;
    if (rawRecent) {
      try {
        const parsedRecent = JSON.parse(rawRecent);
        if (Array.isArray(parsedRecent)) recent = parsedRecent.filter((x): x is string => typeof x === 'string');
      } catch { /* ignore */ }
    }
    if (params.filePath) {
      touched = [params.filePath, ...touched.filter(f => f !== params.filePath)].slice(0, 50);
      recent = [params.filePath, ...recent.filter(f => f !== params.filePath)].slice(0, 10);
    }
    db.prepare(`
      INSERT INTO presence (session_key, repo_common_dir, checkout_root, client, pid, touched_files_json, recent_files_json, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_common_dir, session_key) DO UPDATE SET
        checkout_root = excluded.checkout_root,
        client = excluded.client,
        pid = excluded.pid,
        touched_files_json = excluded.touched_files_json,
        recent_files_json = excluded.recent_files_json,
        last_seen_at = excluded.last_seen_at
    `).run(
      params.sessionKey,
      params.repoCommonDir,
      params.checkoutRoot,
      params.client,
      params.pid,
      JSON.stringify(touched),
      JSON.stringify(recent),
      existing?.created_at ?? now,
      now
    );
    const rows = db.prepare(`
      SELECT p.*, c.agent_id
      FROM presence p
      LEFT JOIN capabilities c
        ON c.repo_common_dir = p.repo_common_dir AND c.session_key = p.session_key
      WHERE p.repo_common_dir = ?
      ORDER BY p.created_at
    `).all(params.repoCommonDir) as Array<Record<string, any>>;
    return rows.map(rowToPresence);
  }) ?? [];
}

export function listRepoPresence(home: string | undefined, repoCommonDir: string): ActivePresence[] {
  const now = Date.now();
  return withPresenceDb(home, false, (db) => {
    pruneDeadPresence(db, now);
    const rows = db.prepare(`
      SELECT p.*, c.agent_id
      FROM presence p
      LEFT JOIN capabilities c
        ON c.repo_common_dir = p.repo_common_dir AND c.session_key = p.session_key
      WHERE p.repo_common_dir = ?
      ORDER BY p.created_at
    `).all(repoCommonDir) as Array<Record<string, any>>;
    return rows.map(rowToPresence);
  }) ?? [];
}

export function listSessionPresence(home: string | undefined, sessionKey: string): ActivePresence[] {
  const now = Date.now();
  return withPresenceDb(home, false, (db) => {
    pruneDeadPresence(db, now);
    const rows = db.prepare(`
      SELECT p.*, c.agent_id
      FROM presence p
      LEFT JOIN capabilities c
        ON c.repo_common_dir = p.repo_common_dir AND c.session_key = p.session_key
      WHERE p.session_key = ?
      ORDER BY p.last_seen_at DESC
    `).all(sessionKey) as Array<Record<string, any>>;
    return rows.map(rowToPresence);
  }) ?? [];
}

export function listAllLiveRepoRoots(home?: string): string[] {
  const now = Date.now();
  return withPresenceDb(home, false, (db) => {
    pruneDeadPresence(db, now);
    const rows = db.prepare('SELECT DISTINCT checkout_root FROM presence WHERE last_seen_at >= ?')
      .all(now - PRESENCE_TTL_MS) as Array<{ checkout_root: string }>;
    return rows.map(r => r.checkout_root).filter(root => fs.existsSync(root));
  }) ?? [];
}

export function getAutoCapability(
  home: string | undefined,
  repoCommonDir: string,
  sessionKey: string
): { agentId: string; sessionToken: string } | null {
  return withPresenceDb(home, false, (db) => {
    const row = db.prepare('SELECT agent_id, session_token FROM capabilities WHERE repo_common_dir = ? AND session_key = ?')
      .get(repoCommonDir, sessionKey) as { agent_id: string; session_token: string } | undefined;
    return row ? { agentId: row.agent_id, sessionToken: row.session_token } : null;
  });
}

export function clearPresenceAndCapability(
  home: string | undefined,
  sessionKey: string,
  repoCommonDir?: string
): void {
  withPresenceDb(home, false, (db) => {
    if (repoCommonDir) {
      db.prepare('DELETE FROM presence WHERE repo_common_dir = ? AND session_key = ?').run(repoCommonDir, sessionKey);
      db.prepare('DELETE FROM capabilities WHERE repo_common_dir = ? AND session_key = ?').run(repoCommonDir, sessionKey);
    } else {
      db.prepare('DELETE FROM presence WHERE session_key = ?').run(sessionKey);
      db.prepare('DELETE FROM capabilities WHERE session_key = ?').run(sessionKey);
    }
  });
}

function deterministicAgentId(client: string, sessionKey: string): string {
  const cleanClient = client.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'agent';
  const hash = crypto.createHash('sha1').update(sessionKey).digest('hex').slice(0, 8);
  return `auto-${cleanClient}-${hash}`;
}

function loadCapMap(home: string | undefined, repoCommonDir: string): Map<string, { agentId: string; sessionToken: string }> {
  return withPresenceDb(home, false, (db) => {
    const rows = db.prepare('SELECT session_key, agent_id, session_token FROM capabilities WHERE repo_common_dir = ?')
      .all(repoCommonDir) as Array<{ session_key: string; agent_id: string; session_token: string }>;
    return new Map(rows.map(r => [r.session_key, { agentId: r.agent_id, sessionToken: r.session_token }]));
  }) ?? new Map();
}

function saveCap(home: string | undefined, repoCommonDir: string, sessionKey: string, agentId: string, sessionToken: string): void {
  withPresenceDb(home, true, (db) => {
    db.prepare(`
      INSERT OR REPLACE INTO capabilities (repo_common_dir, session_key, agent_id, session_token, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(repoCommonDir, sessionKey, agentId, sessionToken, Date.now());
  });
}

/**
 * Hide `.coord/` in Git's repository-local `.git/info/exclude` before auto-promotion
 * creates `.coord/state.db`, so working trees stay clean in `git status`.
 */
export function ensureMachineLocalExclude(layout: RepositoryLayout): void {
  if (!layout.commonGitDir) return;
  try {
    const exclude = path.join(layout.commonGitDir, 'info/exclude');
    const safeDir = physicalPath(path.dirname(exclude));
    if (!isWithin(layout.commonGitDir, safeDir)) return;
    try {
      execFileSync('git', ['check-ignore', '-q', '--', '.coord/state.db'], {
        cwd: layout.checkoutRoot,
        stdio: 'ignore',
      });
      return;
    } catch { /* Not yet ignored by .gitignore or info/exclude. */ }
    const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (existing.split(/\r?\n/).some(line => ['.coord/', '/.coord/', '.coord'].includes(line.trim()))) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const next = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + '# Kith local state (auto-joined)\n/.coord/\n';
    fs.writeFileSync(exclude, next, 'utf8');
  } catch { /* Non-fatal if Git exclude cannot be updated. */ }
}

export class AutoSessionConflictError extends Error {
  constructor(public readonly sessionKey: string) {
    super(`Auto-session capability conflict for ${sessionKey}`);
    this.name = 'AutoSessionConflictError';
  }
}

export function ancestorChain(pid: number): Set<number> {
  const chain = new Set<number>([pid]);
  if (process.platform === 'win32') return chain;
  let current = pid;
  for (let hop = 0; hop < 16; hop++) {
    try {
      const line = execFileSync('ps', ['-o', 'ppid=', '-p', String(current)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 500,
      }).trim();
      const parentPid = Number(line);
      if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || chain.has(parentPid)) break;
      chain.add(parentPid);
      current = parentPid;
    } catch {
      break;
    }
  }
  return chain;
}

export function ownedByCaller(agentPid: number, callerPid: number): boolean {
  if (agentPid === callerPid) return true;
  if (process.platform === 'win32' || agentPid <= 1 || callerPid <= 1) return false;
  return ancestorChain(callerPid).has(agentPid) || ancestorChain(agentPid).has(callerPid);
}

/** A concurrent hook of the same session may have registered since our capability read. */
function resumeFresh(home: string | undefined, engine: KithEngine, repoCommonDir: string, sessionKey: string) {
  const cap = loadCapMap(home, repoCommonDir).get(sessionKey);
  if (!cap) return null;
  try {
    engine.fencing.resumeSession(cap.agentId, cap.sessionToken);
    engine.fencing.heartbeat(cap.agentId, PRESENCE_TTL_MS);
    return { ...cap, newlyJoined: false };
  } catch { return null; }
}

function registerOrResumeAgent(
  home: string | undefined,
  engine: KithEngine,
  existingCaps: Map<string, { agentId: string; sessionToken: string }>,
  params: { repoCommonDir: string; sessionKey: string; client: string; pid: number }
): { agentId: string; sessionToken: string; newlyJoined: boolean } | null {
  const existingCap = existingCaps.get(params.sessionKey);
  if (existingCap) {
    try {
      engine.fencing.resumeSession(existingCap.agentId, existingCap.sessionToken);
      engine.fencing.heartbeat(existingCap.agentId, PRESENCE_TTL_MS);
      return { ...existingCap, newlyJoined: false };
    } catch {
      const current = engine.fencing.getAgent(existingCap.agentId);
      if (current?.status === 'active' && current.lease_expires_at > Date.now() &&
          FencingAndAgentManager.isProcessAlive(current.pid, current.pid_start_time)) {
        const fresh = resumeFresh(home, engine, params.repoCommonDir, params.sessionKey);
        if (fresh) return fresh;
        if (!ownedByCaller(current.pid, params.pid)) return null;
        engine.fencing.forceReclaimAgent(current.id, 'auto_session_token_lost');
      }
    }
  }
  const agentId = deterministicAgentId(params.client, params.sessionKey);
  const current = engine.fencing.getAgent(agentId);
  if (current?.status === 'active' && current.lease_expires_at > Date.now() &&
      FencingAndAgentManager.isProcessAlive(current.pid, current.pid_start_time)) {
    // Same owner process tree, token unknown to us: the session is ours, so take it over rather
    // than blocking every command it runs. A different live owner still stays a conflict.
    const fresh = resumeFresh(home, engine, params.repoCommonDir, params.sessionKey);
    if (fresh) return fresh;
    if (!ownedByCaller(current.pid, params.pid)) return null;
    engine.fencing.forceReclaimAgent(agentId, 'auto_session_token_lost');
  }
  const reg = engine.fencing.registerAgent({
    id: agentId,
    client: params.client,
    pid: params.pid,
    leaseDurationMs: PRESENCE_TTL_MS,
  });
  saveCap(home, params.repoCommonDir, params.sessionKey, agentId, reg.sessionToken);
  return { agentId, sessionToken: reg.sessionToken, newlyJoined: true };
}

/**
 * When an agent registers via MCP (`kith_begin_work` / `kith_work`), bind its capability to
 * the parent client's auto-hook session in `presence.db` (if present) and reclaim any stale
 * `auto-*` agent for that session so hooks and MCP share one identity and conflict state is cleared.
 */
export function bindMcpSessionToAutoPresence(
  home: string | undefined,
  engine: KithEngine,
  params: { repoCommonDir: string | null; mcpPid?: number; agentId: string; sessionToken: string }
): void {
  if (!params.repoCommonDir) return;
  try {
    const ancestors = ancestorChain(params.mcpPid ?? process.pid);
    const peers = listRepoPresence(home, params.repoCommonDir).filter(p => ancestors.has(p.pid));
    if (peers.length !== 1) return;
    const match = peers[0];
    const caps = loadCapMap(home, params.repoCommonDir);
    const prevCap = caps.get(match.sessionKey);
    const autoId = deterministicAgentId(match.client, match.sessionKey);
    for (const staleId of new Set([prevCap?.agentId, autoId])) {
      if (!staleId || staleId === params.agentId) continue;
      const staleAgent = engine.fencing.getAgent(staleId);
      if (!staleAgent || staleAgent.status !== 'active') continue;
      if (!ownedByCaller(staleAgent.pid, match.pid)) continue;
      engine.coordDb.withTransaction(() => {
        engine.coordDb.db.prepare('DELETE FROM locks WHERE owner_agent_id = ? AND pattern IN (SELECT pattern FROM locks WHERE owner_agent_id = ?)').run(staleId, params.agentId);
        engine.coordDb.db.prepare('UPDATE locks SET owner_agent_id = ? WHERE owner_agent_id = ?').run(params.agentId, staleId);
      });
      engine.fencing.forceReclaimAgent(staleId, 'promoted_to_mcp_session');
    }
    saveCap(home, params.repoCommonDir, match.sessionKey, params.agentId, params.sessionToken);
  } catch { /* Non-fatal if presence.db is not in use. */ }
}

/**
 * Ensure the active hook session (and any unpromoted live peers in `presence.db`)
 * hold real Kith capabilities and retrospective file locks on files already touched solo.
 */
export function promoteAutoSession(
  home: string | undefined,
  engine: KithEngine,
  params: {
    repoCommonDir: string;
    sessionKey: string;
    client: string;
    pid: number;
    peers: ActivePresence[];
    pendingFile?: string;
  }
): { agentId: string; sessionToken: string; newlyJoined: boolean } {
  engine.fencing.reapDeadAgents();
  const existingCaps = loadCapMap(home, params.repoCommonDir);
  const self = registerOrResumeAgent(home, engine, existingCaps, {
    repoCommonDir: params.repoCommonDir,
    sessionKey: params.sessionKey,
    client: params.client,
    pid: params.pid,
  });
  if (!self) {
    throw new AutoSessionConflictError(params.sessionKey);
  }

  for (const peer of params.peers) {
    if (peer.sessionKey === params.sessionKey) continue;
    if (!Number.isSafeInteger(peer.pid) || peer.pid <= 0) continue;
    try {
      process.kill(peer.pid, 0);
    } catch {
      continue;
    }
    try {
      const peerSession = registerOrResumeAgent(home, engine, existingCaps, {
        repoCommonDir: params.repoCommonDir,
        sessionKey: peer.sessionKey,
        client: peer.client,
        pid: peer.pid,
      });
      if (peerSession && peer.touchedFiles.length) {
        engine.locks.acquireLocks({
          agentId: peerSession.agentId,
          patterns: peer.touchedFiles,
          lockType: 'file',
          reason: `Auto-locked from earlier solo edit (${peer.client})`,
        });
      }
    } catch { /* Best effort for sibling peers whose PID may not be inspectable. */ }
  }

  const selfPresence = params.peers.find(p => p.sessionKey === params.sessionKey);
  const earlierSelfFiles = (selfPresence?.touchedFiles ?? []).filter(f => f !== params.pendingFile);
  if (self.newlyJoined && earlierSelfFiles.length) {
    try {
      engine.locks.acquireLocks({
        agentId: self.agentId,
        patterns: earlierSelfFiles,
        lockType: 'file',
        reason: `Auto-locked from earlier solo edit (${params.client})`,
      });
    } catch { /* Best effort if a peer already claimed one of the files. */ }
  }

  // Switch default capabilities back to caller before exiting helper.
  engine.fencing.resumeSession(self.agentId, self.sessionToken);
  return self;
}

/**
 * Operator escape hatch behind `kith session clear`: forget an auto-session's capability and
 * presence, release its claims, and delete conflicts recorded against it (or every conflict).
 * `target` is a session key (`claude:<id>`), an agent id (`auto-claude-1a2b3c4d`), or omitted
 * to clear conflicts only.
 */
export function clearAutoSession(
  home: string | undefined,
  engine: KithEngine,
  params: { repoCommonDir: string; target?: string; conflictsOnly?: boolean }
): { agentId: string | null; reclaimed: boolean; conflictsCleared: number } {
  let agentId: string | null = null;
  if (params.target) {
    const caps = loadCapMap(home, params.repoCommonDir);
    const bySession = caps.get(params.target);
    agentId = bySession?.agentId ?? (engine.fencing.getAgent(params.target) ? params.target : null);
    if (!agentId) {
      const m = /^([a-z0-9_-]+):/i.exec(params.target);
      if (m) agentId = deterministicAgentId(m[1], params.target);
    }
    clearPresenceAndCapability(home, params.target, params.repoCommonDir);
    for (const [key, cap] of caps) {
      if (key === params.target || cap.agentId === agentId) clearPresenceAndCapability(home, key, params.repoCommonDir);
    }
  }
  const scope = params.conflictsOnly || !agentId ? undefined : agentId;
  const before = (scope
    ? engine.coordDb.db.prepare('SELECT COUNT(*) AS n FROM conflicts WHERE agent_a=? OR agent_b=?').get(scope, scope)
    : engine.coordDb.db.prepare('SELECT COUNT(*) AS n FROM conflicts').get()) as { n: number };
  let reclaimed = false;
  if (agentId && !params.conflictsOnly) reclaimed = engine.fencing.forceReclaimAgent(agentId);
  engine.fencing.clearConflicts(scope);
  const conflictsCleared = Number(before.n);
  return { agentId, reclaimed, conflictsCleared };
}
