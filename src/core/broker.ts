import { fork } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
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

export interface SupervisedCommandOptions {
  agentId: string; command: string | string[]; cwd?: string;
  timeoutMs?: number; commandTimeoutMs?: number; leaseDurationMs?: number;
  killGraceMs?: number; signal?: AbortSignal; maxOutputBytes?: number;
  onStdout?: (chunk: Buffer) => void; onStderr?: (chunk: Buffer) => void;
}
interface CommandLifecycle {
  prepare: () => Promise<{ command: string[]; env: Record<string, string> }>;
  renew: () => void;
  release: () => void;
}

export class ResourceBroker {
  private activeExecutions = 0;
  public hasActiveCommands(): boolean { return this.activeExecutions > 0; }
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
    this.fencing.assertSession(params.agentId);
    const basePort = params.basePort ?? 3100;
    const leaseMs = FencingAndAgentManager.validateLease(params.leaseDurationMs ?? FencingAndAgentManager.DEFAULT_LEASE_MS);
    const now = Date.now();
    const expiresAt = now + leaseMs;
    if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65535) throw new Error('basePort must be an integer between 1 and 65535');
    const resourceKey = `${params.agentId}:${params.serviceName}`;

    // Check if this agent already holds a port for this service
    const existing = this.getResource('port', resourceKey);
    if (existing && existing.expires_at > now) {
      return this.coordDb.withTransaction(() => {
        this.fencing.assertSession(params.agentId);
        this.coordDb.db.prepare(`UPDATE resources SET expires_at = ? WHERE id = ?`).run(expiresAt, existing.id);
        return {
          port: Number(existing.value), fencingToken: existing.fencing_token,
          resource: this.getResource('port', resourceKey)!,
        };
      });
    }

    if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65535) {
      throw new Error('basePort must be an integer between 1 and 65535');
    }
    const limit = Math.min(basePort + 500, 65536);
    for (let candidatePort = basePort; candidatePort < limit; candidatePort++) {
      if (!(await ResourceBroker.isTcpPortFree(candidatePort))) continue;
      // The OS probe is asynchronous. Recheck reservations under the writer lock.
      const reservation = this.coordDb.withTransaction(() => {
        this.fencing.assertSession(params.agentId);
        const now = Date.now();
        const sameService = this.getResource('port', resourceKey);
        if (sameService && sameService.expires_at > now) {
          return { port: Number(sameService.value), fencingToken: sameService.fencing_token, resource: sameService };
        }
        const taken = this.coordDb.db.prepare(
          `SELECT id FROM resources WHERE type = 'port' AND value = ? AND expires_at > ?`
        ).get(String(candidatePort), now);
        if (taken) return null;
        const token = this.coordDb.nextFencingToken();
        this.coordDb.db.prepare(`
          INSERT OR REPLACE INTO resources (
            id, type, name, value, owner_agent_id, fencing_token, queue_json, acquired_at, expires_at
          ) VALUES (?, 'port', ?, ?, ?, ?, '[]', ?, ?)
        `).run(`res_${crypto.randomBytes(6).toString('hex')}`, resourceKey,
          String(candidatePort), params.agentId, token, now, now + leaseMs);
        this.coordDb.logEvent(params.agentId, 'port_leased', {
          serviceName: params.serviceName, port: candidatePort, fencingToken: token,
        });
        return { port: candidatePort, fencingToken: token, resource: this.getResource('port', resourceKey)! };
      });
      if (reservation) return reservation;
    }
    throw new Error(`No free port available in range ${basePort}-${limit - 1}`);
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

  /** FIFO order survives releases; queued requests belong to a specific session epoch. */
  public tryAcquireMutex(params: {
    agentId: string; mutexName: string; leaseDurationMs?: number; requestId?: string;
  }): { acquired: boolean; fencingToken: number; holderAgentId: string; queuePosition: number } {
    this.fencing.reapDeadAgents();
    const leaseMs = FencingAndAgentManager.validateLease(params.leaseDurationMs ?? FencingAndAgentManager.DEFAULT_LEASE_MS);
    return this.coordDb.withTransaction(() => {
      const epoch = this.fencing.assertSession(params.agentId);
      const now = Date.now();
      const requestId = params.requestId ?? `session:${epoch}`;
      this.pruneWaiters(params.mutexName);
      const run = this.getRun(params.mutexName);
      const guarded = run && this.runIsAlive(run);
      if (run && !guarded) this.clearRun(run);
      const existing = this.getResource('mutex', params.mutexName);
      if (!guarded && existing && existing.expires_at > now && existing.owner_agent_id === params.agentId) {
        this.coordDb.db.prepare('UPDATE resources SET expires_at=? WHERE id=?').run(now + leaseMs, existing.id);
        return { acquired: true, fencingToken: existing.fencing_token, holderAgentId: params.agentId, queuePosition: 0 };
      }
      const start = FencingAndAgentManager.getProcessStartTime(process.pid);
      if (!start) throw new Error('Cannot inspect mutex waiter process. Sandboxed MCP clients can use kith_run_with_mutex instead.');
      this.coordDb.db.prepare(`INSERT INTO mutex_waiters
        (mutex_name, request_id, owner_agent_id, session_epoch, waiter_pid, waiter_start, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mutex_name, request_id) DO UPDATE SET expires_at=excluded.expires_at
      `).run(params.mutexName, requestId, params.agentId, epoch, process.pid, start, now + leaseMs);
      const waiters = this.waiters(params.mutexName);
      const position = waiters.findIndex((w) => w.request_id === requestId) + 1;
      if (guarded || (existing && existing.expires_at > now) || position !== 1) {
        return { acquired: false, fencingToken: run?.fencing_token ?? existing?.fencing_token ?? 0,
          holderAgentId: guarded ? run!.owner_agent_id : existing?.owner_agent_id ?? waiters[0].owner_agent_id,
          queuePosition: position };
      }
      const token = this.coordDb.nextFencingToken();
      this.coordDb.db.prepare(`INSERT OR REPLACE INTO resources
        (id, type, name, value, owner_agent_id, fencing_token, queue_json, acquired_at, expires_at)
        VALUES (?, 'mutex', ?, 'locked', ?, ?, '[]', ?, ?)
      `).run(existing?.id ?? `res_${crypto.randomBytes(6).toString('hex')}`, params.mutexName, params.agentId, token, now, now + leaseMs);
      this.coordDb.db.prepare('DELETE FROM mutex_waiters WHERE mutex_name=? AND request_id=?').run(params.mutexName, requestId);
      this.coordDb.logEvent(params.agentId, 'mutex_acquired', { mutexName: params.mutexName, fencingToken: token });
      return { acquired: true, fencingToken: token, holderAgentId: params.agentId, queuePosition: 0 };
    });
  }

  public renewMutex(params: { agentId: string; mutexName: string; fencingToken: number; leaseDurationMs?: number }): void {
    const lease = FencingAndAgentManager.validateLease(params.leaseDurationMs ?? FencingAndAgentManager.DEFAULT_LEASE_MS);
    this.coordDb.withTransaction(() => {
      this.fencing.assertSession(params.agentId);
      const resource = this.getResource('mutex', params.mutexName);
      if (!resource || resource.owner_agent_id !== params.agentId || resource.expires_at <= Date.now()) {
        throw new Error(`Mutex lease lost: ${params.mutexName}`);
      }
      this.fencing.verifyFencingToken(params.mutexName, params.fencingToken, resource.fencing_token);
      this.coordDb.db.prepare('UPDATE resources SET expires_at=? WHERE id=?').run(Date.now() + lease, resource.id);
    });
  }

  public releaseMutex(params: { agentId: string; mutexName: string; fencingToken: number }): boolean {
    return this.coordDb.withTransaction(() => {
      this.fencing.assertSession(params.agentId);
      const resource = this.getResource('mutex', params.mutexName);
      if (!resource || resource.owner_agent_id !== params.agentId) return false;
      this.fencing.verifyFencingToken(params.mutexName, params.fencingToken, resource.fencing_token);
      const run = this.getRun(params.mutexName);
      if (run && this.runIsAlive(run)) throw new Error('Cannot release a mutex while its supervised process group is alive');
      this.coordDb.db.prepare('DELETE FROM resources WHERE id=?').run(resource.id);
      this.coordDb.logEvent(params.agentId, 'mutex_released', { mutexName: params.mutexName });
      return true;
    });
  }

  /** Launch on the allocated port, without interpreting arguments as shell code. */
  public async executeWithPort(params: Omit<SupervisedCommandOptions, 'command'> & {
    command: string[]; serviceName: string; basePort?: number;
    onPort?: (port: number) => void;
  }) {
    if (!params.command.length || !params.command[0]) throw new Error('A command is required');
    if (!params.serviceName || params.serviceName.length > 128) throw new Error('serviceName must contain 1 to 128 characters');
    const mutexName = `dev-port:${params.agentId}:${params.serviceName}`;
    let allocation: Awaited<ReturnType<ResourceBroker['acquirePort']>> | undefined;
    const leaseMs = FencingAndAgentManager.validateLease(params.leaseDurationMs ?? FencingAndAgentManager.DEFAULT_LEASE_MS);
    const result = await this.executeGuarded({ ...params, mutexName }, {
      prepare: async () => {
        allocation = await this.acquirePort({ ...params, basePort: params.basePort ?? 3000 });
        params.onPort?.(allocation.port);
        return { command: params.command.map((arg) => arg.replaceAll('{port}', String(allocation!.port))),
          env: { PORT: String(allocation.port), KITH_PORT: String(allocation.port) } };
      },
      renew: () => {
        if (!allocation) return;
        this.coordDb.withTransaction(() => {
          this.fencing.assertSession(params.agentId);
          const resource = this.getResource('port', `${params.agentId}:${params.serviceName}`);
          if (!resource || resource.fencing_token !== allocation!.fencingToken || resource.expires_at <= Date.now()) {
            throw new Error('Dev server port lease lost');
          }
          this.coordDb.db.prepare('UPDATE resources SET expires_at=? WHERE id=?').run(Date.now() + leaseMs, resource.id);
        });
      },
      release: () => {
        if (allocation) this.coordDb.db.prepare("DELETE FROM resources WHERE type='port' AND name=? AND fencing_token=?")
          .run(`${params.agentId}:${params.serviceName}`, allocation.fencingToken);
      },
    });
    return { ...result, port: allocation!.port };
  }

  /** Renew leases while a detached, recorded process group runs; stop it before releasing. */
  public executeWithMutex(params: SupervisedCommandOptions & { mutexName: string }) {
    return this.executeGuarded(params);
  }

  private async executeGuarded(params: SupervisedCommandOptions & { mutexName: string }, lifecycle?: CommandLifecycle):
    Promise<{ stdout: string; stderr: string; exitCode: number; waitedMs: number }> {
    if (process.platform === 'win32') throw new Error('Supervised mutex commands currently require macOS or Linux process groups');
    if (!params.command.length) throw new Error('A command is required');
    const leaseMs = FencingAndAgentManager.validateLease(params.leaseDurationMs ?? FencingAndAgentManager.DEFAULT_LEASE_MS);
    const waitTimeout = params.timeoutMs ?? 60_000;
    const grace = params.killGraceMs ?? 1000;
    if (!Number.isFinite(waitTimeout) || waitTimeout < 0 || !Number.isFinite(grace) || grace < 0 ||
        (params.commandTimeoutMs !== undefined && (!Number.isFinite(params.commandTimeoutMs) || params.commandTimeoutMs <= 0))) {
      throw new Error('Timeouts must be finite nonnegative milliseconds (command timeout must be positive)');
    }
    if (params.maxOutputBytes !== undefined && (!Number.isSafeInteger(params.maxOutputBytes) || params.maxOutputBytes <= 0)) throw new Error('maxOutputBytes must be a positive integer');
    const epoch = this.fencing.assertSession(params.agentId);
    const requestId = crypto.randomUUID();
    const started = Date.now();
    let run: MutexRun | null = null;
    const abortError = () => new DOMException('Mutex command cancelled', 'AbortError');
    this.activeExecutions++;
    try {
      while (!run) {
        if (params.signal?.aborted) throw abortError();
        run = this.coordDb.withTransaction(() => {
          const attempt = this.tryAcquireMutex({ ...params, requestId });
          if (!attempt.acquired) return null;
          const record: MutexRun = {
            mutex_name: params.mutexName, run_id: requestId, owner_agent_id: params.agentId,
            session_epoch: epoch, fencing_token: attempt.fencingToken, supervisor_pid: process.pid,
            supervisor_start: FencingAndAgentManager.getProcessStartTime(process.pid)!, worker_pid: null, worker_start: null,
          };
          this.coordDb.db.prepare(`INSERT INTO mutex_runs
            (mutex_name, run_id, owner_agent_id, session_epoch, fencing_token, supervisor_pid, supervisor_start)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(record.mutex_name, record.run_id, record.owner_agent_id, epoch, record.fencing_token, process.pid, record.supervisor_start);
          return record;
        });
        if (run) break;
        if (Date.now() - started >= waitTimeout) throw new Error(`Timed out waiting for mutex '${params.mutexName}'`);
        this.fencing.heartbeat(params.agentId);
        await delay(Math.min(50, Math.max(10, leaseMs / 4)));
      }
      const waitedMs = Date.now() - started;
      const prepared = await lifecycle?.prepare();
      if (params.signal?.aborted) throw abortError();
      const candidates = ['./command-worker.js', '../command-worker.js', '../../dist/command-worker.js']
        .map((name) => fileURLToPath(new URL(name, import.meta.url)));
      const script = candidates.find((name) => fs.existsSync(name));
      if (!script) throw new Error('Missing command worker. Build Kith before running supervised commands.');
      const worker = fork(script, [], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
      const workerPid = worker.pid;
      if (!workerPid) {
        worker.on('error', () => {});
        throw new Error('Could not start command supervisor');
      }
      let workerIdentity = FencingAndAgentManager.getProcessStartTime(workerPid);
      let failure: Error | undefined;
      let outcome: { exitCode: number; error?: string } | undefined;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let stopDeadline: number | undefined;
      let disposed = false;
      let finishStopped!: () => void;
      const stopped = new Promise<void>((resolve) => { finishStopped = resolve; });
      const stop = (err?: Error) => {
        if (disposed) return;
        failure ??= err;
        const termError = signalGroup(workerPid, 'SIGTERM', workerIdentity);
        failure ??= termError;
        killTimer ??= setTimeout(() => {
          const killError = signalGroup(workerPid, 'SIGKILL', workerIdentity);
          failure ??= killError;
        }, grace);
        stopDeadline ??= Date.now() + grace + 5000;
        stopTimer ??= setTimeout(finishStopped, Math.max(0, stopDeadline - Date.now()));
      };
      const onAbort = () => stop(abortError());
      params.signal?.addEventListener('abort', onAbort, { once: true });
      const interval = setInterval(() => {
        try {
          this.fencing.heartbeat(params.agentId);
          this.renewMutex({ ...params, fencingToken: run!.fencing_token });
          lifecycle?.renew();
        } catch (err) { stop(err instanceof Error ? err : new Error(String(err))); }
      }, Math.max(10, Math.floor(leaseMs / 3)));
      const commandTimer = params.commandTimeoutMs === undefined ? undefined
        : setTimeout(() => stop(new Error('Mutex command execution timed out')), params.commandTimeoutMs);
      const capture = (destination: Buffer[], stream?: (chunk: Buffer) => void) => (chunk: Buffer) => {
        stream?.(chunk);
        outputBytes += chunk.length;
        if (outputBytes > (params.maxOutputBytes ?? 16 * 1024 * 1024)) stop(new Error('Mutex command output limit exceeded'));
        else destination.push(chunk);
      };
      worker.stdout!.on('data', capture(stdout, params.onStdout));
      worker.stderr!.on('data', capture(stderr, params.onStderr));
      worker.on('message', (message: { ready?: boolean; exitCode?: number; error?: string }) => {
        if (disposed) return;
        if (message.ready) {
          try {
            if (params.signal?.aborted) throw abortError();
            this.coordDb.withTransaction(() => {
              this.fencing.assertSession(params.agentId);
              const identity = FencingAndAgentManager.getProcessStartTime(workerPid);
              if (!identity) throw new Error('Cannot inspect command worker');
              this.coordDb.db.prepare('UPDATE mutex_runs SET worker_pid=?, worker_start=? WHERE run_id=?')
                .run(workerPid, identity, requestId);
              run!.worker_pid = workerPid;
              run!.worker_start = identity;
              workerIdentity = identity;
              this.renewMutex({ ...params, fencingToken: run!.fencing_token });
              lifecycle?.renew();
            });
            worker.send({ command: prepared?.command ?? params.command, env: prepared?.env, cwd: params.cwd ?? this.coordDb.repoRoot, mutexName: params.mutexName });
          } catch (err) { stop(err instanceof Error ? err : new Error(String(err))); }
        } else {
          outcome = { exitCode: message.exitCode ?? 1, error: message.error };
        }
      });
      worker.once('exit', () => { if (!disposed && groupIsAlive(workerPid, workerIdentity)) stop(); });
      try {
        await Promise.race([new Promise<void>((resolve, reject) => {
          worker.once('close', () => resolve());
          worker.once('error', reject);
        }), stopped]);
        if (params.signal?.aborted) failure ??= abortError();
        if (failure) throw failure;
        if (!outcome) throw new Error('Command worker exited without a result');
        if (outcome.error) throw new Error(outcome.error);
        return { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), exitCode: outcome.exitCode, waitedMs };
      } finally {
        clearInterval(interval);
        if (commandTimer) clearTimeout(commandTimer);
        params.signal?.removeEventListener('abort', onAbort);
        if (groupIsAlive(workerPid, workerIdentity)) {
          const killError = signalGroup(workerPid, 'SIGKILL', workerIdentity);
          failure ??= killError;
          const deadline = stopDeadline ?? Date.now() + 5000;
          while (groupIsAlive(workerPid, workerIdentity) && Date.now() < deadline) await delay(20);
        }
        disposed = true;
        if (killTimer) clearTimeout(killTimer);
        if (stopTimer) clearTimeout(stopTimer);
        if (groupIsAlive(workerPid, workerIdentity)) {
          // Retain the durable guard, but don't leave this caller pinned forever.
          worker.stdout?.destroy(); worker.stderr?.destroy();
          if (worker.connected) worker.disconnect();
          worker.unref();
          throw new Error('Command group has not stopped; mutex guard retained for safety');
        }
      }
    } finally {
      try {
        this.coordDb.withTransaction(() => {
          this.coordDb.db.prepare('DELETE FROM mutex_waiters WHERE mutex_name=? AND request_id=? AND session_epoch=?')
            .run(params.mutexName, requestId, epoch);
          if (run && !this.runIsAlive(run)) this.clearRun(run);
          // No protected command can start before the worker-group handshake.
          if (run && run.worker_pid === null) this.clearRun(run);
          if (!this.getRun(params.mutexName)) lifecycle?.release();
        });
      } finally { this.activeExecutions--; }
    }
  }

  private getRun(name: string): MutexRun | null {
    return (this.coordDb.db.prepare('SELECT * FROM mutex_runs WHERE mutex_name=?').get(name) as MutexRun | undefined) ?? null;
  }

  private runIsAlive(run: MutexRun): boolean {
    return run.worker_pid !== null ? groupIsAlive(run.worker_pid, run.worker_start)
      : FencingAndAgentManager.isProcessAlive(run.supervisor_pid, run.supervisor_start);
  }

  private clearRun(run: MutexRun): void {
    this.coordDb.db.prepare('DELETE FROM mutex_runs WHERE mutex_name=? AND run_id=?').run(run.mutex_name, run.run_id);
    this.coordDb.db.prepare("DELETE FROM resources WHERE type='mutex' AND name=? AND fencing_token=?")
      .run(run.mutex_name, run.fencing_token);
  }

  private waiters(name: string): MutexWaiter[] {
    return this.coordDb.db.prepare('SELECT * FROM mutex_waiters WHERE mutex_name=? ORDER BY ticket').all(name) as unknown as MutexWaiter[];
  }

  private pruneWaiters(name: string): void {
    for (const waiter of this.waiters(name)) {
      const agent = this.fencing.getAgent(waiter.owner_agent_id);
      const session = this.coordDb.db.prepare('SELECT epoch FROM agent_sessions WHERE agent_id=?').get(waiter.owner_agent_id) as { epoch: number } | undefined;
      if (!agent || agent.status !== 'active' || agent.lease_expires_at <= Date.now() || session?.epoch !== waiter.session_epoch ||
          waiter.expires_at <= Date.now() || !FencingAndAgentManager.isProcessAlive(waiter.waiter_pid, waiter.waiter_start)) {
        this.coordDb.db.prepare('DELETE FROM mutex_waiters WHERE ticket=?').run(waiter.ticket);
      }
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
      queue: row.type === 'mutex' ? this.waiters(String(row.name)).map((w) => w.owner_agent_id) : [],
      acquired_at: Number(row.acquired_at),
      expires_at: Number(row.expires_at),
    };
  }
}

interface MutexRun {
  mutex_name: string; run_id: string; owner_agent_id: string; session_epoch: number;
  fencing_token: number; supervisor_pid: number; supervisor_start: string;
  worker_pid: number | null; worker_start: string | null;
}
interface MutexWaiter {
  ticket: number; request_id: string; owner_agent_id: string; session_epoch: number;
  waiter_pid: number; waiter_start: string; expires_at: number;
}
function groupIsAlive(pgid: number, expectedStart?: string | null): boolean {
  if (expectedStart) {
    const currentStart = FencingAndAgentManager.getProcessStartTime(pgid);
    if (currentStart && currentStart !== expectedStart) return false;
  }
  try { process.kill(-pgid, 0); }
  catch (err) { return (err as NodeJS.ErrnoException).code !== 'ESRCH'; }
  if (process.platform === 'linux') {
    // A killed, adopted zombie cannot execute writes. Some container PID 1s
    // leave zombies unreaped, so kill(-pgid, 0) alone would retain guards forever.
    try {
      for (const pid of fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
        let stat: string;
        try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
        catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ESRCH') continue; return true; }
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') return true;
      }
      return false;
    } catch { return true; }
  }
  return true;
}
function signalGroup(pgid: number, signal: NodeJS.Signals, expectedStart?: string | null): Error | undefined {
  if (!groupIsAlive(pgid, expectedStart)) return;
  try { process.kill(-pgid, signal); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return err instanceof Error ? err : new Error(String(err));
  }
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
