import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import { CoordDatabase } from './db.js';
import { FencingAndAgentManager } from './fencing.js';

export interface ResourceRecord {
  id: string;
  type: 'port' | 'mutex';
  name: string;
  value: string;
  owner_agent_id: string;
  fencing_token: number;
  queue: string[];
  acquired_at: number;
  expires_at: number;
}

export class ResourceBroker {
  constructor(
    private readonly coordDb: CoordDatabase,
    private readonly fencing: FencingAndAgentManager
  ) {}

  /**
   * Acquires a collision-free port lease for `(agentId, serviceName)`.
   * Verifies both SQLite resource table and OS TCP socket availability.
   */
  public async acquirePort(params: {
    agentId: string;
    serviceName: string;
    basePort?: number;
    leaseDurationMs?: number;
  }): Promise<{ port: number; fencingToken: number; resource: ResourceRecord }> {
    this.fencing.reapDeadAgents();
    const basePort = params.basePort ?? 3100;
    const leaseMs = params.leaseDurationMs ?? FencingAndAgentManager.DEFAULT_LEASE_MS;
    const now = Date.now();
    const expiresAt = now + leaseMs;
    const resourceKey = `${params.agentId}:${params.serviceName}`;

    // Check if this agent already holds a port for this service
    const existing = this.getResource('port', resourceKey);
    if (existing && existing.expires_at > now) {
      this.coordDb.db
        .prepare(`UPDATE resources SET expires_at = ? WHERE id = ?`)
        .run(expiresAt, existing.id);
      return {
        port: Number(existing.value),
        fencingToken: existing.fencing_token,
        resource: this.getResource('port', resourceKey)!,
      };
    }

    const allocatedPorts = new Set<number>(
      (
        this.coordDb.db
          .prepare(`SELECT value FROM resources WHERE type = 'port' AND expires_at > ?`)
          .all(now) as Array<{ value: string }>
      ).map((r) => Number(r.value))
    );

    let candidatePort = basePort;
    while (candidatePort < basePort + 500) {
      if (!allocatedPorts.has(candidatePort)) {
        const freeOnOs = await ResourceBroker.isTcpPortFree(candidatePort);
        if (freeOnOs) {
          break;
        }
      }
      candidatePort++;
    }

    return this.coordDb.withTransaction(() => {
      const token = this.coordDb.nextFencingToken();
      const id = `res_${crypto.randomBytes(6).toString('hex')}`;

      this.coordDb.db
        .prepare(`
          INSERT OR REPLACE INTO resources (
            id, type, name, value, owner_agent_id,
            fencing_token, queue_json, acquired_at, expires_at
          )
          VALUES (?, 'port', ?, ?, ?, ?, '[]', ?, ?)
        `)
        .run(
          id,
          resourceKey,
          String(candidatePort),
          params.agentId,
          token,
          now,
          expiresAt
        );

      this.coordDb.logEvent(params.agentId, 'port_leased', {
        serviceName: params.serviceName,
        port: candidatePort,
        fencingToken: token,
      });

      return {
        port: candidatePort,
        fencingToken: token,
        resource: this.getResource('port', resourceKey)!,
      };
    });
  }

  public static isTcpPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.on('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
  }

  /**
   * Attempts to acquire a named FIFO toolchain mutex (e.g. `package-install`, `db-migrate`, `build`).
   * If another live agent holds it, adds `agentId` to the FIFO queue and returns `acquired: false`.
   */
  public tryAcquireMutex(params: {
    agentId: string;
    mutexName: string;
    leaseDurationMs?: number;
  }): {
    acquired: boolean;
    fencingToken: number;
    holderAgentId: string;
    queuePosition: number;
  } {
    this.fencing.reapDeadAgents();
    const now = Date.now();
    const expiresAt =
      now + (params.leaseDurationMs ?? FencingAndAgentManager.DEFAULT_LEASE_MS);

    return this.coordDb.withTransaction(() => {
      const existing = this.getResource('mutex', params.mutexName);

      if (!existing || existing.expires_at <= now) {
        const token = this.coordDb.nextFencingToken();
        const id = existing?.id ?? `res_${crypto.randomBytes(6).toString('hex')}`;
        const nextQueue = (existing?.queue ?? []).filter((id) => id !== params.agentId);

        this.coordDb.db
          .prepare(`
            INSERT OR REPLACE INTO resources (
              id, type, name, value, owner_agent_id,
              fencing_token, queue_json, acquired_at, expires_at
            )
            VALUES (?, 'mutex', ?, 'locked', ?, ?, ?, ?, ?)
          `)
          .run(
            id,
            params.mutexName,
            params.agentId,
            token,
            JSON.stringify(nextQueue),
            now,
            expiresAt
          );

        this.coordDb.logEvent(params.agentId, 'mutex_acquired', {
          mutexName: params.mutexName,
          fencingToken: token,
        });

        return {
          acquired: true,
          fencingToken: token,
          holderAgentId: params.agentId,
          queuePosition: 0,
        };
      }

      if (existing.owner_agent_id === params.agentId) {
        this.coordDb.db
          .prepare(`UPDATE resources SET expires_at = ? WHERE id = ?`)
          .run(expiresAt, existing.id);
        return {
          acquired: true,
          fencingToken: existing.fencing_token,
          holderAgentId: params.agentId,
          queuePosition: 0,
        };
      }

      // Add to FIFO queue if not already queued
      const queue = [...existing.queue];
      if (!queue.includes(params.agentId)) {
        queue.push(params.agentId);
        this.coordDb.db
          .prepare(`UPDATE resources SET queue_json = ? WHERE id = ?`)
          .run(JSON.stringify(queue), existing.id);
      }

      return {
        acquired: false,
        fencingToken: existing.fencing_token,
        holderAgentId: existing.owner_agent_id,
        queuePosition: queue.indexOf(params.agentId) + 1,
      };
    });
  }

  public releaseMutex(params: {
    agentId: string;
    mutexName: string;
    fencingToken?: number;
  }): boolean {
    return this.coordDb.withTransaction(() => {
      const existing = this.getResource('mutex', params.mutexName);
      if (!existing || existing.owner_agent_id !== params.agentId) {
        return false;
      }
      if (params.fencingToken !== undefined) {
        this.fencing.verifyFencingToken(
          params.mutexName,
          params.fencingToken,
          existing.fencing_token
        );
      }

      this.coordDb.db
        .prepare(`DELETE FROM resources WHERE id = ?`)
        .run(existing.id);

      this.coordDb.logEvent(params.agentId, 'mutex_released', {
        mutexName: params.mutexName,
      });
      return true;
    });
  }

  /**
   * Blocks until `mutexName` is acquired (polling with backoff), executes `command`,
   * and guarantees mutex release in `finally`.
   */
  public executeWithMutex(params: {
    agentId: string;
    mutexName: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
  }): { stdout: string; exitCode: number; waitedMs: number } {
    const startWait = Date.now();
    const maxWaitMs = params.timeoutMs ?? 60_000;
    let fencingToken = 0;

    while (true) {
      const attempt = this.tryAcquireMutex({
        agentId: params.agentId,
        mutexName: params.mutexName,
      });
      if (attempt.acquired) {
        fencingToken = attempt.fencingToken;
        break;
      }
      if (Date.now() - startWait > maxWaitMs) {
        throw new Error(
          `Timed out waiting for mutex '${params.mutexName}' (held by '${attempt.holderAgentId}').`
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }

    const waitedMs = Date.now() - startWait;
    try {
      const stdout = execSync(params.command, {
        cwd: params.cwd ?? this.coordDb.repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { stdout, exitCode: 0, waitedMs };
    } finally {
      this.releaseMutex({
        agentId: params.agentId,
        mutexName: params.mutexName,
        fencingToken,
      });
    }
  }

  public getResource(type: 'port' | 'mutex', name: string): ResourceRecord | null {
    const row = this.coordDb.db
      .prepare(`SELECT * FROM resources WHERE type = ? AND name = ?`)
      .get(type, name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  public listResources(): ResourceRecord[] {
    this.fencing.reapDeadAgents();
    const rows = this.coordDb.db
      .prepare(`SELECT * FROM resources WHERE expires_at > ? ORDER BY acquired_at ASC`)
      .all(Date.now()) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): ResourceRecord {
    return {
      id: String(row.id),
      type: row.type as 'port' | 'mutex',
      name: String(row.name),
      value: String(row.value),
      owner_agent_id: String(row.owner_agent_id),
      fencing_token: Number(row.fencing_token),
      queue: JSON.parse(String(row.queue_json ?? '[]')) as string[],
      acquired_at: Number(row.acquired_at),
      expires_at: Number(row.expires_at),
    };
  }
}
