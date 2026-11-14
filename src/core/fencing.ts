import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CoordDatabase } from './db.js';
import { captureAbandoned } from './handoff-store.js';
import { ignoredPaths } from './git-ignore.js';

export interface AgentRecord {
  id: string;
  name: string;
  client: string;
  pid: number;
  pid_start_time: string;
  pgid: number;
  worktree_path: string | null;
  branch: string | null;
  shadow_tree_sha: string | null;
  status: 'active' | 'idle' | 'dead' | 'completed';
  last_seen_event_id: number;
  registered_at: number;
  last_heartbeat_at: number;
  lease_expires_at: number;
}

export class SessionOwnershipError extends Error {
  constructor(agentId: string) {
    super(`No valid active session capability for '${agentId}'. Start a session, or resume it with its session token.`);
    this.name = 'SessionOwnershipError';
  }
}

export class StaleFencingTokenError extends Error {
  constructor(public readonly resourceId: string, public readonly providedToken: number, public readonly expectedToken: number) {
    super(`Fencing token mismatch for '${resourceId}': provided ${providedToken}, expected ${expectedToken}.`);
    this.name = 'StaleFencingTokenError';
  }
}

interface SessionRow { token_hash: string; epoch: number }
export interface SessionRegistration { agent: AgentRecord; fencingToken: number; sessionToken: string; sessionEpoch: number }

export class FencingAndAgentManager {
  public static readonly DEFAULT_LEASE_MS = 5 * 60 * 1000;
  private readonly capabilities = new Map<string, string>();
  private static ownWindowsStart: string | null = null;
  private static inspectionFailure: string | null = null;

  constructor(private readonly coordDb: CoordDatabase) {}

  public static validateLease(duration: number): number {
    if (!Number.isSafeInteger(duration) || duration < 100 || duration > 86_400_000) {
      throw new Error('Lease duration must be an integer between 100 and 86400000 milliseconds');
    }
    return duration;
  }

  /** A real kernel process identity; tests must not supply liveness sentinels. */
  public static getProcessStartTime(pid: number): string | null {
    this.inspectionFailure = null;
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
      if (process.platform === 'linux') {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return `linux:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
      }
      if (process.platform === 'win32') {
        // Only our own identity is immutable for this process lifetime. Never cache other PIDs.
        if (pid === process.pid && this.ownWindowsStart) return this.ownWindowsStart;
        const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        // Query the kernel-backed Process API directly, avoiding cold Get-Process module auto-loading.
        const ticks = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
          `([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true }).trim();
        if (!/^\d+$/.test(ticks)) { this.inspectionFailure = 'invalid kernel creation-time response'; return null; }
        const identity = `windows:${ticks}`;
        if (pid === process.pid) this.ownWindowsStart = identity;
        return identity;
      }
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500,
        env: { ...process.env, LC_ALL: 'C' },
      }).trim();
      return out || null;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { status?: number; signal?: string };
      this.inspectionFailure = [failure.code, failure.status === undefined ? null : `exit ${failure.status}`, failure.signal].filter(Boolean).join(', ') || 'inspection unavailable';
      return null;
    }
  }

  public static isProcessAlive(pid: number, expectedStartTime: string): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false; }
    const current = this.getProcessStartTime(pid);
    // Failure to inspect a live process is not evidence that its locks can be stolen.
    return current === null || current === expectedStartTime;
  }

  public registerAgent(params: {
    id: string; name?: string; client?: string; pid?: number; pgid?: number;
    worktreePath?: string | null; branch?: string | null; leaseDurationMs?: number;
    sessionToken?: string;
  }): SessionRegistration {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(params.id)) throw new Error('Invalid agent ID');
    const leaseMs = FencingAndAgentManager.validateLease(params.leaseDurationMs ?? FencingAndAgentManager.DEFAULT_LEASE_MS);
    this.reapDeadAgents();
    return this.coordDb.withTransaction(() => {
      const existing = this.getAgent(params.id);
      const supplied = params.sessionToken ?? this.capabilities.get(params.id);
      if (existing?.status === 'active') {
        const epoch = this.assertSession(params.id, supplied);
        // Resuming never changes the process anchor or session generation.
        this.capabilities.set(params.id, supplied!);
        this.heartbeat(params.id, leaseMs);
        return { agent: this.getAgent(params.id)!, fencingToken: epoch, sessionToken: supplied!, sessionEpoch: epoch };
      }
      if (params.sessionToken !== undefined) throw new SessionOwnershipError(params.id);
      const pid = params.pid ?? process.pid;
      const start = FencingAndAgentManager.getProcessStartTime(pid);
      if (!start) throw new Error(`Cannot determine start time of live session owner PID ${pid} (${FencingAndAgentManager.inspectionFailure ?? 'inspection unavailable'})`);
      const now = Date.now();
      const epoch = this.coordDb.nextFencingToken();
      const token = crypto.randomBytes(32).toString('base64url');
      const latest = (this.coordDb.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get() as { id: number }).id;
      this.coordDb.db.prepare(`
        INSERT INTO agents (id, name, client, pid, pid_start_time, pgid, worktree_path, branch,
          shadow_tree_sha, status, last_seen_event_id, registered_at, last_heartbeat_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, client=excluded.client, pid=excluded.pid,
          pid_start_time=excluded.pid_start_time, pgid=excluded.pgid, status='active',
          worktree_path=COALESCE(agents.worktree_path, excluded.worktree_path),
          branch=CASE WHEN agents.worktree_path IS NOT NULL THEN COALESCE(agents.branch, excluded.branch) ELSE excluded.branch END,
          shadow_tree_sha=NULL, last_seen_event_id=excluded.last_seen_event_id,
          registered_at=excluded.registered_at, last_heartbeat_at=excluded.last_heartbeat_at,
          lease_expires_at=excluded.lease_expires_at
      `).run(params.id, params.name ?? existing?.name ?? params.id, params.client ?? 'unknown',
        pid, start, params.pgid ?? pid, params.worktreePath ?? (this.coordDb.isLinkedWorktree ? this.coordDb.repoRoot : null), params.branch ?? null,
        latest, now, now, now + leaseMs);
      this.coordDb.db.prepare('INSERT OR REPLACE INTO agent_sessions(agent_id, token_hash, epoch) VALUES (?, ?, ?)')
        .run(params.id, this.hash(token), epoch);
      this.capabilities.set(params.id, token);
      this.coordDb.logEvent(params.id, 'agent_registered', { client: params.client ?? 'unknown', pid, sessionEpoch: epoch });
      return { agent: this.getAgent(params.id)!, fencingToken: epoch, sessionToken: token, sessionEpoch: epoch };
    });
  }

  public resumeSession(agentId: string, sessionToken: string): number {
    const epoch = this.assertSession(agentId, sessionToken);
    this.capabilities.set(agentId, sessionToken);
    return epoch;
  }

  public assertSession(agentId: string, sessionToken = this.capabilities.get(agentId)): number {
    const agent = this.getAgent(agentId);
    const session = this.coordDb.db.prepare('SELECT token_hash, epoch FROM agent_sessions WHERE agent_id = ?')
      .get(agentId) as SessionRow | undefined;
    const now = Date.now();
    if (!agent || agent.status !== 'active' || !session ||
        !sessionToken || this.hash(sessionToken) !== session.token_hash ||
        !FencingAndAgentManager.isProcessAlive(agent.pid, agent.pid_start_time)) {
      throw new SessionOwnershipError(agentId);
    }
    if (agent.lease_expires_at <= now) {
      if (!agentId.startsWith('auto-')) {
        throw new SessionOwnershipError(agentId);
      }
      const extended = now + 30 * 60 * 1000;
      this.coordDb.db.prepare('UPDATE agents SET last_heartbeat_at=?, lease_expires_at=? WHERE id=?').run(now, extended, agentId);
    }
    return session.epoch;
  }

  public sessionEnvironment(agentId: string): NodeJS.ProcessEnv {
    this.assertSession(agentId);
    return { ...process.env, KITH_AGENT_ID: agentId, KITH_SESSION_TOKEN: this.capabilities.get(agentId)! };
  }

  public heartbeat(agentId: string, leaseDurationMs = FencingAndAgentManager.DEFAULT_LEASE_MS): AgentRecord {
    const lease = FencingAndAgentManager.validateLease(leaseDurationMs);
    return this.coordDb.withTransaction(() => {
      this.assertSession(agentId);
      const now = Date.now();
      const expires = now + lease;
      this.coordDb.db.prepare('UPDATE agents SET last_heartbeat_at=?, lease_expires_at=? WHERE id=?').run(now, expires, agentId);
      this.coordDb.db.prepare('UPDATE locks SET expires_at=MAX(expires_at, ?) WHERE owner_agent_id=? AND expires_at>?')
        .run(expires, agentId, now);
      // Mutex renewal requires its exact acquisition token, not just a session heartbeat.
      this.coordDb.db.prepare("UPDATE resources SET expires_at=MAX(expires_at, ?) WHERE type='port' AND owner_agent_id=? AND expires_at>?")
        .run(expires, agentId, now);
      return this.getAgent(agentId)!;
    });
  }

  public getAgent(agentId: string): AgentRecord | null {
    return (this.coordDb.db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) as AgentRecord | undefined) ?? null;
  }

  public listAgents(onlyActive = false): AgentRecord[] {
    this.reapDeadAgents();
    return this.coordDb.db.prepare(onlyActive
      ? "SELECT * FROM agents WHERE status='active' ORDER BY registered_at"
      : 'SELECT * FROM agents ORDER BY registered_at DESC').all() as unknown as AgentRecord[];
  }

  private lastIgnoredPurge = 0;

  /** Fast SQLite probe so startup cleanup does zero Git work on clean repositories. */
  public hasIgnoredCleanupTargets(): boolean {
    const row = this.coordDb.db.prepare(`
      SELECT (
        EXISTS(SELECT 1 FROM conflicts)
        OR EXISTS(SELECT 1 FROM locks WHERE lock_type = 'file')
        OR EXISTS(SELECT 1 FROM contracts)
        OR EXISTS(SELECT 1 FROM file_deps)
      ) AS any_rows
    `).get() as { any_rows: number } | undefined;
    return Boolean(row?.any_rows);
  }

  /**
   * Drop recorded conflicts, file claims, and AST contract/dep rows on paths Git ignores
   * (dev-server logs, traces, build output). Older versions recorded them; they must neither block
   * a session nor survive an upgrade.
   */
  public purgeIgnoredClaims(force = false): { conflicts: number; locks: number } {
    const now = Date.now();
    if (!force && now - this.lastIgnoredPurge < 30_000) return { conflicts: 0, locks: 0 };
    this.lastIgnoredPurge = now;
    const db = this.coordDb.db;
    const conflictRows = db.prepare('SELECT id, file_path FROM conflicts').all() as Array<{ id: string; file_path: string }>;
    const lockRows = db.prepare("SELECT id, pattern FROM locks WHERE lock_type = 'file'").all() as Array<{ id: string; pattern: string }>;
    const contractFiles = db.prepare('SELECT DISTINCT file_path FROM contracts').all() as Array<{ file_path: string }>;
    const depRows = db.prepare('SELECT DISTINCT source_file, target_file FROM file_deps').all() as Array<{ source_file: string; target_file: string }>;
    const lockFile = (pattern: string) => pattern.startsWith('file:') ? pattern.slice(5) : pattern;
    const allPaths = [
      ...conflictRows.map(r => r.file_path),
      ...lockRows.map(r => lockFile(r.pattern)),
      ...contractFiles.map(r => r.file_path),
      ...depRows.flatMap(r => [r.source_file, r.target_file]),
    ];
    if (!allPaths.length) return { conflicts: 0, locks: 0 };
    const ignored = ignoredPaths(this.coordDb.repoRoot, allPaths);
    const conflicts = conflictRows.filter(r => ignored.has(r.file_path));
    const locks = lockRows.filter(r => ignored.has(lockFile(r.pattern)));
    const badContracts = contractFiles.filter(r => ignored.has(r.file_path)).map(r => r.file_path);
    const badDeps = [...new Set(depRows.flatMap(r => [r.source_file, r.target_file]))].filter(p => ignored.has(p));
    if (conflicts.length || locks.length || badContracts.length || badDeps.length) {
      this.coordDb.withTransaction(() => {
        for (const r of conflicts) db.prepare('DELETE FROM conflicts WHERE id = ?').run(r.id);
        for (const r of locks) db.prepare('DELETE FROM locks WHERE id = ?').run(r.id);
        for (const p of badContracts) db.prepare('DELETE FROM contracts WHERE file_path = ?').run(p);
        for (const p of badDeps) db.prepare('DELETE FROM file_deps WHERE source_file = ? OR target_file = ?').run(p, p);
      });
    }
    return { conflicts: conflicts.length, locks: locks.length };
  }

  public reapDeadAgents(): string[] {
    try { this.purgeIgnoredClaims(); } catch { /* Housekeeping must never block a session. */ }
    const now = Date.now();
    const agents = this.coordDb.db.prepare("SELECT * FROM agents WHERE status='active'").all() as unknown as AgentRecord[];
    const liveness = new Map<string, boolean>();
    const toExtend: string[] = [];
    const candidates = agents.filter((a) => {
      const key = `${a.pid}:${a.pid_start_time}`;
      if (!liveness.has(key)) liveness.set(key, FencingAndAgentManager.isProcessAlive(a.pid, a.pid_start_time));
      const alive = Boolean(liveness.get(key));
      if (!alive) return true;
      if (a.lease_expires_at <= now) {
        if (a.id.startsWith('auto-')) {
          toExtend.push(a.id);
          return false;
        }
        return true;
      }
      return false;
    });
    if (toExtend.length) {
      const nextExpiry = now + 30 * 60 * 1000;
      this.coordDb.withTransaction(() => {
        for (const id of toExtend) {
          this.coordDb.db.prepare("UPDATE agents SET lease_expires_at=? WHERE id=? AND status='active'").run(nextExpiry, id);
          this.coordDb.db.prepare('UPDATE locks SET expires_at=MAX(expires_at, ?) WHERE owner_agent_id=?').run(nextExpiry, id);
        }
      });
    }
    if (!candidates.length) return [];
    return this.coordDb.withTransaction(() => {
      const reaped: string[] = [];
      for (const previous of candidates) {
        const current = this.getAgent(previous.id);
        // Recheck after taking the writer lock: a heartbeat or replacement may have won.
        if (!current || current.status !== 'active' || current.registered_at !== previous.registered_at ||
            current.pid !== previous.pid || current.pid_start_time !== previous.pid_start_time) continue;
        if (current.lease_expires_at > Date.now() && FencingAndAgentManager.isProcessAlive(current.pid, current.pid_start_time)) continue;
        this.reclaim(current.id, 'dead', 'process_died_or_lease_expired');
        reaped.push(current.id);
      }
      return reaped;
    });
  }

  /**
   * Operator escape hatch: release an agent's claims and mark it dead without its session token.
   * Used by `kith session clear` for an auto-session whose capability was lost or is stuck.
   */
  public forceReclaimAgent(agentId: string, reason = 'manual_clear'): boolean {
    return this.coordDb.withTransaction(() => {
      const agent = this.getAgent(agentId);
      if (!agent || agent.status !== 'active') return false;
      this.reclaim(agentId, 'dead', reason);
      return true;
    });
  }

  /** Delete recorded conflicts involving `agentId`, or every conflict when omitted. */
  public clearConflicts(agentId?: string): number {
    return this.coordDb.withTransaction(() => {
      const r = agentId
        ? this.coordDb.db.prepare('DELETE FROM conflicts WHERE agent_a=? OR agent_b=?').run(agentId, agentId)
        : this.coordDb.db.prepare('DELETE FROM conflicts').run();
      return Number(r.changes);
    });
  }

  public completeAgentSession(agentId: string): void {
    this.coordDb.withTransaction(() => { this.assertSession(agentId); this.reclaim(agentId, 'completed', 'session_completed'); });
    this.capabilities.delete(agentId);
  }

  public abandonAgentSession(agentId: string): void {
    this.coordDb.withTransaction(() => { this.assertSession(agentId); this.reclaim(agentId, 'dead', 'client_disconnected'); });
    this.capabilities.delete(agentId);
  }

  private reclaim(agentId: string, status: 'dead' | 'completed', reason: string): void {
    const epoch = this.coordDb.nextFencingToken();
    const now = Date.now();
    // Record what was in flight before the claims that describe it are released. Never let this block reclaim.
    if (status === 'dead') { try { captureAbandoned(this.coordDb, agentId, reason); } catch { /* Best effort. */ } }
    this.coordDb.db.prepare('UPDATE agents SET status=?, last_heartbeat_at=? WHERE id=?').run(status, now, agentId);
    this.coordDb.db.prepare('DELETE FROM locks WHERE owner_agent_id=?').run(agentId);
    this.coordDb.db.prepare('DELETE FROM resources WHERE owner_agent_id=?').run(agentId);
    this.coordDb.db.prepare('DELETE FROM mutex_waiters WHERE owner_agent_id=?').run(agentId);
    // Live command guards survive session expiry until their process group has stopped.
    this.coordDb.db.prepare('DELETE FROM conflicts WHERE agent_a=? OR agent_b=?').run(agentId, agentId);
    if (status === 'dead') {
      this.coordDb.db.prepare("UPDATE tasks SET status='queued', owner_agent_id=NULL, fencing_token=NULL, updated_at=? WHERE owner_agent_id=? AND status='active'")
        .run(now, agentId);
    } else {
      this.coordDb.db.prepare("UPDATE tasks SET status='done', updated_at=? WHERE owner_agent_id=? AND status='active'")
        .run(now, agentId);
    }
    this.coordDb.logEvent(agentId, `agent_${status}`, { reason, newFencingEpoch: epoch });
  }

  public verifyFencingToken(resourceId: string, provided: number, expected: number): void {
    if (provided !== expected) throw new StaleFencingTokenError(resourceId, provided, expected);
  }

  private hash(token: string): string { return crypto.createHash('sha256').update(token).digest('hex'); }
}
