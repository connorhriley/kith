import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scopeSegments, scopesOverlap } from './glob.js';
import { caseSensitivePaths, isWithin, physicalPath, repositoryFile } from './repository.js';
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
  private readonly pathCase = new Map<string, boolean>();
  constructor(
    private readonly coordDb: CoordDatabase,
    private readonly fencing: FencingAndAgentManager
  ) {}

  public static normalizePattern(repoRoot: string, rawPattern: string): string {
    if (rawPattern.startsWith('file:')) return LockEngine.literalScope(LockEngine.normalizeFile(repoRoot, rawPattern.slice(5)));
    if (rawPattern.startsWith('symbol:')) {
      const hash = rawPattern.indexOf('#');
      const name = rawPattern.slice(hash + 1);
      if (hash < 0 || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) throw new Error('Symbol scope must include #symbolName');
      const file = LockEngine.normalizeFile(repoRoot, rawPattern.slice(7, hash));
      return `symbol:${file}#${name}`;
    }
    if (!rawPattern || /[\\\x00-\x1f\x7f]/u.test(rawPattern)) throw new Error(`Invalid repository scope: ${rawPattern}`);
    const root = physicalPath(repoRoot);
    const parts = rawPattern.split('/');
    const magic = parts.findIndex(p => /[?*]/u.test(p));
    // Resolve the literal prefix before normalizing .., so symlink/.. cannot escape.
    const prefix = magic < 0 ? rawPattern : parts.slice(0, magic).join('/') || '.';
    const absolute = physicalPath(path.isAbsolute(prefix) ? prefix : root + '/' + prefix);
    if (!isWithin(root, absolute)) throw new Error(`Scope is outside repository: ${rawPattern}`);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const suffix = magic < 0 ? '' : parts.slice(magic).join('/');
    const normalized = [relative, suffix].filter(Boolean).join('/');
    scopeSegments(normalized);
    return normalized;
  }

  public static normalizeFile(repoRoot: string, file: string): string {
    const normalized = repositoryFile(repoRoot, file);
    scopeSegments(normalized, true);
    return normalized;
  }

  private static literalScope(file: string): string {
    try {
      scopeSegments(file);
      if (!/[?*]/u.test(file) && !file.startsWith('symbol:') && !file.startsWith('file:')) return file;
    } catch { /* Explicit literal scopes support filenames containing reserved glob syntax. */ }
    return 'file:' + file;
  }

  private rootForAgent(agentId: string): string {
    return this.fencing.getAgent(agentId)?.worktree_path ?? this.coordDb.repoRoot;
  }

  // A wildcard can traverse an alias that maps to a different scope. If exact
  // lexical comparison was disjoint, retain exclusion when such aliases exist.
  private wildcardHasAliases(pattern: string): boolean {
    if (pattern.startsWith('symbol:') || pattern.startsWith('file:')) return false;
    const segments = scopeSegments(pattern);
    const first = segments.findIndex(s => /[?*]/u.test(s));
    if (first < 0) return false;
    const prefix = segments.slice(0, first).join('/');
    const recursivePrefix = Boolean(prefix) && segments.length === first + 1 && segments[first] === '**';
    const roots = new Set([this.coordDb.repoRoot, ...this.fencing.listAgents(true).map(a => a.worktree_path).filter((p): p is string => Boolean(p))]);
    const pending = [...roots].map(root => ({ root, relative: prefix }));
    let budget = 10_000;
    while (pending.length) {
      const { root, relative } = pending.pop()!;
      const dir = path.join(root, relative);
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; return true; }
      for (const entry of entries) {
        if (--budget < 0) return true;
        const file = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isSymbolicLink()) {
          if (!recursivePrefix) return true;
          try {
            const scopeRoot = physicalPath(path.join(root, prefix));
            const linkTarget = fs.realpathSync(path.join(dir, entry.name));
            if (!isWithin(scopeRoot, linkTarget)) return true;
            continue;
          } catch {
            return true;
          }
        }
        const fold = (value: string) => value.normalize('NFC').toLowerCase().replace(/ς/g, 'σ');
        if (!LockEngine.patternsOverlap(fold(pattern), fold(file)) && !LockEngine.patternsOverlap(fold(pattern), fold(file + '/**'))) continue;
        if (entry.isDirectory()) pending.push({ root, relative: file });
      }
    }
    return false;
  }

  /** Exact overlap for the documented scope grammar; legacy unsupported locks block conservatively. */
  public static patternsOverlap(rawA: string, rawB: string): boolean {
    const decode = (value: string) => {
      if (value.startsWith('symbol:')) {
        const match = /^symbol:(.+)#([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(value);
        if (!match) throw new Error('Invalid symbol scope');
        scopeSegments(match[1], true);
        return { file: match[1], symbol: match[2], literal: true };
      }
      const literal = value.startsWith('file:');
      const file = literal ? value.slice(5) : value;
      scopeSegments(file, literal);
      return { file, symbol: null, literal };
    };
    try {
      const a = decode(rawA), b = decode(rawB);
      if (a.symbol && b.symbol) return a.file === b.file && a.symbol === b.symbol;
      return scopesOverlap(a.file, b.file, a.literal, b.literal);
    } catch { return true; }
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
      new Set(params.patterns.map((p) => LockEngine.normalizePattern(this.rootForAgent(params.agentId), lockType === 'file' && !p.startsWith('file:') ? 'file:' + p : p)))
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

          if (this.overlapsExisting(reqPattern, existing.pattern)) {
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
        const inferredType = pattern.startsWith('file:') ? 'file' : pattern.startsWith('symbol:')
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
    const normPath = LockEngine.normalizeFile(this.rootForAgent(params.agentId), params.filePath);
    const requested = LockEngine.literalScope(normPath);
    const now = Date.now();

    const activeLocks = this.coordDb.db
      .prepare(`SELECT * FROM locks WHERE expires_at > ?`)
      .all(now) as unknown as LockRecord[];

    for (const lock of activeLocks) {
      if (this.overlapsExisting(requested, lock.pattern)) {
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
              (p) => LockEngine.normalizePattern(this.rootForAgent(params.agentId), p) === lock.pattern
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
        const norm = LockEngine.normalizePattern(this.rootForAgent(params.agentId), rawPattern);
        const res = this.coordDb.db
          .prepare(`DELETE FROM locks WHERE owner_agent_id = ? AND pattern = ?`)
          .run(params.agentId, norm);
        count += Number(res.changes);
      }
      return count;
    });
  }

  private overlapsExisting(requested: string, existing: string): boolean {
    try {
      const normalized = LockEngine.normalizePattern(this.coordDb.repoRoot, existing);
      const roots = [this.coordDb.repoRoot, ...this.fencing.listAgents(true).map(a => a.worktree_path).filter((p): p is string => Boolean(p))];
      const insensitive = roots.some(root => {
        if (!this.pathCase.has(root)) this.pathCase.set(root, caseSensitivePaths(root));
        return !this.pathCase.get(root);
      });
      const fold = (scope: string) => {
        const hash = scope.startsWith('symbol:') ? scope.lastIndexOf('#') : -1;
        const file = hash < 0 ? scope : scope.slice(0, hash);
        return file.normalize('NFC').toLowerCase().replace(/ς/g, 'σ') + (hash < 0 ? '' : scope.slice(hash));
      };
      const overlap = (a: string, b: string) => LockEngine.patternsOverlap(a, b)
        || insensitive && LockEngine.patternsOverlap(fold(a), fold(b));
      return overlap(requested, existing) || overlap(requested, normalized)
        || this.wildcardHasAliases(requested) || this.wildcardHasAliases(normalized);
    }
    catch { return true; }
  }

  public listLocks(): LockRecord[] {
    this.fencing.reapDeadAgents();
    return this.coordDb.db
      .prepare(`SELECT * FROM locks WHERE expires_at > ? ORDER BY acquired_at ASC`)
      .all(Date.now()) as unknown as LockRecord[];
  }
}

export { StaleFencingTokenError };
