import { execFileSync } from 'node:child_process';
import { CoordDatabase } from './db.js';

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

export class StaleFencingTokenError extends Error {
  public readonly providedToken: number;
  public readonly expectedToken: number;
  public readonly resourceId: string;

  constructor(resourceId: string, providedToken: number, expectedToken: number) {
    super(
      `Stale fencing token for '${resourceId}': provided token ${providedToken} < current token ${expectedToken}. Your lock/session was preempted or expired.`
    );
    this.name = 'StaleFencingTokenError';
    this.resourceId = resourceId;
    this.providedToken = providedToken;
    this.expectedToken = expectedToken;
  }
}

export class FencingAndAgentManager {
  public static readonly DEFAULT_LEASE_MS = 5 * 60 * 1000; // 5 minutes TTL fallback

  constructor(private readonly coordDb: CoordDatabase) {}

  /**
   * Captures the OS kernel process start time (`lstart`) for a given PID.
   * Prevents PID-reuse false positives when checking if an agent process is still alive.
   */
  public static getProcessStartTime(pid: number): string | null {
    if (pid <= 0) return null;
    try {
      process.kill(pid, 0);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') {
        return null;
      }
    }

    try {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
      }).trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  }

  /**
   * Checks whether a recorded (pid, pid_start_time) process is still alive at the OS level.
   */
  public static isProcessAlive(pid: number, expectedStartTime: string): boolean {
    if (expectedStartTime === 'simulated-alive') {
      return true;
    }
    if (expectedStartTime === 'simulated-dead') {
      return false;
    }
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') {
        return false;
      }
    }

    const currentStart = FencingAndAgentManager.getProcessStartTime(pid);
    if (!currentStart) return false;
    return currentStart === expectedStartTime;
  }

  /**
   * Registers or refreshes an agent session.
   */
  public registerAgent(params: {
    id: string;
    name?: string;
    client?: string;
    pid?: number;
    pidStartTime?: string;
    pgid?: number;
    worktreePath?: string | null;
    branch?: string | null;
    leaseDurationMs?: number;
  }): { agent: AgentRecord; fencingToken: number } {
    this.reapDeadAgents();

    const pid = params.pid ?? (process.ppid || process.pid);
    const pidStartTime =
      params.pidStartTime ??
      FencingAndAgentManager.getProcessStartTime(pid) ??
      'simulated-alive';
    const pgid = params.pgid ?? pid;
    const now = Date.now();
    const leaseMs = params.leaseDurationMs ?? FencingAndAgentManager.DEFAULT_LEASE_MS;
    const leaseExpiresAt = now + leaseMs;

    return this.coordDb.withTransaction(() => {
      const token = this.coordDb.nextFencingToken();
      const latestEvent = this.coordDb.db
        .prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM events`)
        .get() as { max_id: number };

      const existing = this.getAgent(params.id);
      if (existing) {
        this.coordDb.db
          .prepare(`
            UPDATE agents
            SET name = ?,
                client = ?,
                pid = ?,
                pid_start_time = ?,
                pgid = ?,
                worktree_path = COALESCE(?, worktree_path),
                branch = COALESCE(?, branch),
                status = 'active',
                last_heartbeat_at = ?,
                lease_expires_at = ?
            WHERE id = ?
          `)
          .run(
            params.name ?? existing.name,
            params.client ?? existing.client,
            pid,
            pidStartTime,
            pgid,
            params.worktreePath ?? null,
            params.branch ?? null,
            now,
            leaseExpiresAt,
            params.id
          );
      } else {
        this.coordDb.db
          .prepare(`
            INSERT INTO agents (
              id, name, client, pid, pid_start_time, pgid,
              worktree_path, branch, shadow_tree_sha, status,
              last_seen_event_id, registered_at, last_heartbeat_at, lease_expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, ?, ?)
          `)
          .run(
            params.id,
            params.name ?? params.id,
            params.client ?? 'unknown',
            pid,
            pidStartTime,
            pgid,
            params.worktreePath ?? null,
            params.branch ?? null,
            latestEvent.max_id,
            now,
            now,
            leaseExpiresAt
          );
      }

      this.coordDb.logEvent(params.id, 'agent_registered', {
        client: params.client ?? 'unknown',
        pid,
        fencingToken: token,
      });

      return {
        agent: this.getAgent(params.id)!,
        fencingToken: token,
      };
    });
  }

  public heartbeat(agentId: string, leaseDurationMs?: number): AgentRecord | null {
    const now = Date.now();
    const leaseMs = leaseDurationMs ?? FencingAndAgentManager.DEFAULT_LEASE_MS;
    const expiresAt = now + leaseMs;

    return this.coordDb.withTransaction(() => {
      const existing = this.getAgent(agentId);
      if (!existing) return null;

      this.coordDb.db
        .prepare(`
          UPDATE agents
          SET last_heartbeat_at = ?, lease_expires_at = ?, status = 'active'
          WHERE id = ?
        `)
        .run(now, expiresAt, agentId);

      this.coordDb.db
        .prepare(`
          UPDATE locks
          SET expires_at = MAX(expires_at, ?)
          WHERE owner_agent_id = ?
        `)
        .run(expiresAt, agentId);

      this.coordDb.db
        .prepare(`
          UPDATE resources
          SET expires_at = MAX(expires_at, ?)
          WHERE owner_agent_id = ?
        `)
        .run(expiresAt, agentId);

      return this.getAgent(agentId);
    });
  }

  public getAgent(agentId: string): AgentRecord | null {
    const row = this.coordDb.db
      .prepare(`SELECT * FROM agents WHERE id = ?`)
      .get(agentId) as AgentRecord | undefined;
    return row ?? null;
  }

  public listAgents(onlyActive = false): AgentRecord[] {
    this.reapDeadAgents();
    if (onlyActive) {
      return this.coordDb.db
        .prepare(`SELECT * FROM agents WHERE status = 'active' ORDER BY registered_at ASC`)
        .all() as unknown as AgentRecord[];
    }
    return this.coordDb.db
      .prepare(`SELECT * FROM agents ORDER BY registered_at DESC`)
      .all() as unknown as AgentRecord[];
  }

  /**
   * Scans all active agents, verifies OS process liveness `(pid, pid_start_time)` and lease TTL,
   * and atomically reclaims locks, ports, mutexes, and tasks from dead or expired sessions.
   */
  public reapDeadAgents(): string[] {
    const now = Date.now();
    const activeAgents = this.coordDb.db
      .prepare(`SELECT * FROM agents WHERE status = 'active'`)
      .all() as unknown as AgentRecord[];

    const deadIds: string[] = [];

    for (const agent of activeAgents) {
      const leaseExpired = agent.lease_expires_at < now;
      const pidAlive = FencingAndAgentManager.isProcessAlive(
        agent.pid,
        agent.pid_start_time
      );

      if (!pidAlive || leaseExpired) {
        deadIds.push(agent.id);
      }
    }

    if (deadIds.length === 0) {
      return [];
    }

    this.coordDb.withTransaction(() => {
      for (const agentId of deadIds) {
        this.reclaimAgentResourcesInternal(agentId, 'dead', 'process_died_or_lease_expired');
      }
    });

    return deadIds;
  }

  public completeAgentSession(agentId: string): void {
    this.coordDb.withTransaction(() => {
      this.reclaimAgentResourcesInternal(agentId, 'completed', 'session_completed');
    });
  }

  private reclaimAgentResourcesInternal(
    agentId: string,
    newStatus: 'dead' | 'completed',
    reason: string
  ): void {
    const newEpoch = this.coordDb.nextFencingToken();
    const now = Date.now();

    this.coordDb.db
      .prepare(`UPDATE agents SET status = ?, last_heartbeat_at = ? WHERE id = ?`)
      .run(newStatus, now, agentId);

    this.coordDb.db
      .prepare(`DELETE FROM locks WHERE owner_agent_id = ?`)
      .run(agentId);

    this.coordDb.db
      .prepare(`DELETE FROM resources WHERE owner_agent_id = ?`)
      .run(agentId);

    this.coordDb.db
      .prepare(`DELETE FROM conflicts WHERE agent_a = ? OR agent_b = ?`)
      .run(agentId, agentId);

    if (newStatus === 'dead') {
      // Return unfinished orchestrated tasks to queued so another live worker can pick them up
      this.coordDb.db
        .prepare(`
          UPDATE tasks
          SET status = 'queued', owner_agent_id = NULL, fencing_token = NULL, updated_at = ?
          WHERE owner_agent_id = ? AND status = 'active'
        `)
        .run(now, agentId);
    } else {
      this.coordDb.db
        .prepare(`
          UPDATE tasks
          SET status = 'done', updated_at = ?
          WHERE owner_agent_id = ? AND status = 'active'
        `)
        .run(now, agentId);
    }

    this.coordDb.logEvent(agentId, `agent_${newStatus}`, {
      reason,
      newFencingEpoch: newEpoch,
    });
  }

  /**
   * Deterministically verifies that a fencing token presented by an agent is >= the active lock's token.
   */
  public verifyFencingToken(
    resourceId: string,
    providedToken: number,
    expectedToken: number
  ): void {
    if (providedToken < expectedToken) {
      throw new StaleFencingTokenError(resourceId, providedToken, expectedToken);
    }
  }
}
