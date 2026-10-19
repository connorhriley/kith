import crypto from 'node:crypto';
import path from 'node:path';
import picomatch from 'picomatch';
import { CoordDatabase } from './db.js';
import { FencingAndAgentManager, StaleFencingTokenError } from './fencing.js';

export interface LockRecord {
  id: string;
  pattern: string;
  lock_type: 'glob' | 'file' | 'symbol';
  mode: 'exclusive' | 'shared';
  owner_agent_id: string;
  task_id: string | null;
  fencing_token: number;
  reason: string;
  acquired_at: number;
  expires_at: number;
}

export interface LockConflict {
  existingLock: LockRecord;
  requestedPattern: string;
  ownerAgentName: string;
  ownerIntent: string | null;
}

export interface AcquireLockResult {
  ok: boolean;
  fencingToken: number;
  locks: LockRecord[];
  conflicts: LockConflict[];
}

export class LockEngine {
  constructor(
    private readonly coordDb: CoordDatabase,
    private readonly fencing: FencingAndAgentManager
  ) {}

  public static normalizePattern(repoRoot: string, rawPattern: string): string {
    let p = rawPattern.trim().replace(/\\/g, '/');
    if (p.startsWith('symbol:')) {
      const hash = p.indexOf('#');
      if (hash < 0) throw new Error('Symbol scope must include #symbolName');
      return `symbol:${LockEngine.normalizePattern(repoRoot, p.slice(7, hash))}${p.slice(hash)}`;
    }
    const normRoot = path.resolve(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.startsWith(normRoot + '/')) p = p.slice(normRoot.length + 1);
    else if (path.posix.isAbsolute(p)) throw new Error(`Scope is outside repository: ${rawPattern}`);
    p = path.posix.normalize(p);
    if (!p || p === '.' || p === '..' || p.startsWith('../')) {
      throw new Error(`Invalid repository scope: ${rawPattern}`);
    }
    return p;
  }

  /**
   * Determines whether two file paths or glob patterns can match any common file.
   * Handles concrete-to-glob, glob-to-concrete, and glob-to-glob intersections.
   */
  public static patternsOverlap(rawA: string, rawB: string): boolean {
    const a = rawA.replace(/\\/g, '/').replace(/^\.\//, '');
    const b = rawB.replace(/\\/g, '/').replace(/^\.\//, '');

    if (a === b) return true;

    // Symbol locks (`symbol:src/auth.ts#verifyToken`)
    if (a.startsWith('symbol:') || b.startsWith('symbol:')) {
      if (a.startsWith('symbol:') && b.startsWith('symbol:')) {
        return a === b;
      }
      const symFile = (a.startsWith('symbol:') ? a : b).slice('symbol:'.length).split('#')[0];
      const otherPattern = a.startsWith('symbol:') ? b : a;
      return LockEngine.patternsOverlap(symFile, otherPattern);
    }

    try {
      if (picomatch.isMatch(a, b) || picomatch.isMatch(b, a)) {
        return true;
      }
    } catch {
      // Fallback to segment intersection below
    }

    // Generate concrete sample paths from each pattern and test against the other
    const samplesA = LockEngine.generateSamplePaths(a);
    const samplesB = LockEngine.generateSamplePaths(b);

    try {
      const matchA = picomatch(a);
      const matchB = picomatch(b);
      for (const sA of samplesA) {
        if (matchB(sA)) return true;
      }
      for (const sB of samplesB) {
        if (matchA(sB)) return true;
      }
    } catch {
      // Ignore regex errors
    }

    // Segment-by-segment prefix intersection check
    const segsA = a.split('/');
    const segsB = b.split('/');
    const minLen = Math.min(segsA.length, segsB.length);

    for (let i = 0; i < minLen; i++) {
      const sa = segsA[i];
      const sb = segsB[i];
      if (sa === '**' || sb === '**') {
        return true;
      }
      if (sa === sb) continue;
      const segOverlap =
        picomatch.isMatch(sa.replace(/\*/g, 'x'), sb) ||
        picomatch.isMatch(sb.replace(/\*/g, 'x'), sa);
      if (!segOverlap) {
        return false;
      }
    }

    return false;
  }

  private static generateSamplePaths(pattern: string): string[] {
    const base = pattern
      .replace(/\/\*\*\/?/g, '/nested/dir/')
      .replace(/\*\*/g, 'nested/dir')
      .replace(/\*\.([a-zA-Z0-9]+)/g, 'sample.$1')
      .replace(/\*/g, 'sample')
      .replace(/\?/g, 'a')
      .replace(/\{([^,}]+),[^}]*\}/g, '$1');

    const shallow = pattern
      .replace(/\/\*\*\//g, '/')
      .replace(/\/\*\*$/g, '/file.ts')
      .replace(/\*\*/g, 'file.ts')
      .replace(/\*\.([a-zA-Z0-9]+)/g, 'sample.$1')
      .replace(/\*/g, 'sample');

    return [base, shallow, `${base}/index.ts`, `${shallow}.ts`];
  }

  /**
   * Atomically acquires locks on one or more file/glob/symbol patterns.
   * All-or-nothing: if any pattern conflicts with another live agent, no locks are created.
   */
  public acquireLocks(params: {
    agentId: string;
    patterns: string[];
    mode?: 'exclusive' | 'shared';
    lockType?: 'glob' | 'file' | 'symbol';
    taskId?: string | null;
    reason?: string;
    leaseDurationMs?: number;
  }): AcquireLockResult {
    this.fencing.reapDeadAgents();

    const mode = params.mode ?? 'exclusive';
    const lockType = params.lockType ?? 'glob';
    const now = Date.now();
    const expiresAt = now + (params.leaseDurationMs ?? FencingAndAgentManager.DEFAULT_LEASE_MS);
    const normalizedPatterns = Array.from(
      new Set(params.patterns.map((p) => LockEngine.normalizePattern(this.coordDb.repoRoot, p)))
    );

    return this.coordDb.withTransaction(() => {
      this.fencing.assertSession(params.agentId);
      const existingLocks = this.coordDb.db
        .prepare(`SELECT * FROM locks WHERE expires_at > ?`)
        .all(now) as unknown as LockRecord[];

      const conflicts: LockConflict[] = [];

      for (const reqPattern of normalizedPatterns) {
        for (const existing of existingLocks) {
          if (existing.owner_agent_id === params.agentId) {
            continue;
          }
          const bothShared = mode === 'shared' && existing.mode === 'shared';
          if (bothShared) {
            continue;
          }

          if (LockEngine.patternsOverlap(reqPattern, existing.pattern)) {
            const owner = this.fencing.getAgent(existing.owner_agent_id);
            const activeTask = this.coordDb.db
              .prepare(
                `SELECT intent_summary FROM tasks WHERE owner_agent_id = ? AND status = 'active' LIMIT 1`
              )
              .get(existing.owner_agent_id) as { intent_summary: string } | undefined;

            conflicts.push({
              existingLock: existing,
              requestedPattern: reqPattern,
              ownerAgentName: owner?.name ?? existing.owner_agent_id,
              ownerIntent: activeTask?.intent_summary ?? existing.reason ?? null,
            });
          }
        }
      }

      if (conflicts.length > 0) {
        this.coordDb.logEvent(params.agentId, 'lock_conflict', {
          requestedPatterns: normalizedPatterns,
          conflicts: conflicts.map((c) => ({
            pattern: c.existingLock.pattern,
            owner: c.existingLock.owner_agent_id,
          })),
        });
        return {
          ok: false,
          fencingToken: this.coordDb.currentFencingEpoch(),
          locks: [],
          conflicts,
        };
      }

      const token = this.coordDb.nextFencingToken();
      const acquired: LockRecord[] = [];

      for (const pattern of normalizedPatterns) {
        // Upsert if same agent already holds this exact pattern
        this.coordDb.db
          .prepare(`DELETE FROM locks WHERE owner_agent_id = ? AND pattern = ?`)
          .run(params.agentId, pattern);

        const id = `lock_${crypto.randomBytes(6).toString('hex')}`;
        const inferredType = pattern.startsWith('symbol:')
          ? 'symbol'
          : pattern.includes('*') || pattern.includes('?') || pattern.includes('{')
            ? 'glob'
            : lockType === 'glob'
              ? 'file'
              : lockType;

        this.coordDb.db
          .prepare(`
            INSERT INTO locks (
              id, pattern, lock_type, mode, owner_agent_id,
              task_id, fencing_token, reason, acquired_at, expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            id,
            pattern,
            inferredType,
            mode,
            params.agentId,
            params.taskId ?? null,
            token,
            params.reason ?? '',
            now,
            expiresAt
          );

        acquired.push({
          id,
          pattern,
          lock_type: inferredType,
          mode,
          owner_agent_id: params.agentId,
          task_id: params.taskId ?? null,
          fencing_token: token,
          reason: params.reason ?? '',
          acquired_at: now,
          expires_at: expiresAt,
        });
      }

      this.coordDb.logEvent(params.agentId, 'locks_acquired', {
        patterns: normalizedPatterns,
        fencingToken: token,
      });

      return {
        ok: true,
        fencingToken: token,
        locks: acquired,
        conflicts: [],
      };
    });
  }

  /**
   * Checks whether `agentId` is allowed to edit `filePath`.
   * Also verifies the fencing token if provided.
   */
  public checkFileWriteAccess(params: {
    agentId: string;
    filePath: string;
    fencingToken?: number;
  }): {
    allowed: boolean;
    reason?: string;
    conflictingLock?: LockRecord;
    ownerIntent?: string | null;
  } {
    this.fencing.reapDeadAgents();
    this.fencing.assertSession(params.agentId);
    const normPath = LockEngine.normalizePattern(this.coordDb.repoRoot, params.filePath);
    const now = Date.now();

    const activeLocks = this.coordDb.db
      .prepare(`SELECT * FROM locks WHERE expires_at > ?`)
      .all(now) as unknown as LockRecord[];

    for (const lock of activeLocks) {
      if (LockEngine.patternsOverlap(normPath, lock.pattern)) {
        if (lock.owner_agent_id !== params.agentId) {
          const activeTask = this.coordDb.db
            .prepare(
              `SELECT intent_summary FROM tasks WHERE owner_agent_id = ? AND status = 'active' LIMIT 1`
            )
            .get(lock.owner_agent_id) as { intent_summary: string } | undefined;

          return {
            allowed: false,
            reason: `File '${normPath}' is locked by agent '${lock.owner_agent_id}' (pattern: '${lock.pattern}', token: ${lock.fencing_token}). Intent: ${
              activeTask?.intent_summary ?? (lock.reason || 'active work')
            }`,
            conflictingLock: lock,
            ownerIntent: activeTask?.intent_summary ?? lock.reason ?? null,
          };
        } else if (params.fencingToken !== undefined) {
          this.fencing.verifyFencingToken(normPath, params.fencingToken, lock.fencing_token);
        }
      }
    }

    return { allowed: true };
  }

  public releaseLocks(params: {
    agentId: string;
    patterns?: string[];
    fencingToken?: number;
  }): number {
    return this.coordDb.withTransaction(() => {
      this.fencing.assertSession(params.agentId);
      const myLocks = this.coordDb.db
        .prepare(`SELECT * FROM locks WHERE owner_agent_id = ?`)
        .all(params.agentId) as unknown as LockRecord[];

      if (params.fencingToken !== undefined) {
        for (const lock of myLocks) {
          if (
            !params.patterns ||
            params.patterns.some(
              (p) => LockEngine.normalizePattern(this.coordDb.repoRoot, p) === lock.pattern
            )
          ) {
            this.fencing.verifyFencingToken(lock.pattern, params.fencingToken, lock.fencing_token);
          }
        }
      }

      if (!params.patterns || params.patterns.length === 0) {
        const res = this.coordDb.db
          .prepare(`DELETE FROM locks WHERE owner_agent_id = ?`)
          .run(params.agentId);
        return Number(res.changes);
      }

      let count = 0;
      for (const rawPattern of params.patterns) {
        const norm = LockEngine.normalizePattern(this.coordDb.repoRoot, rawPattern);
        const res = this.coordDb.db
          .prepare(`DELETE FROM locks WHERE owner_agent_id = ? AND pattern = ?`)
          .run(params.agentId, norm);
        count += Number(res.changes);
      }
      return count;
    });
  }

  public listLocks(): LockRecord[] {
    this.fencing.reapDeadAgents();
    return this.coordDb.db
      .prepare(`SELECT * FROM locks WHERE expires_at > ? ORDER BY acquired_at ASC`)
      .all(Date.now()) as unknown as LockRecord[];
  }
}

export { StaleFencingTokenError };
