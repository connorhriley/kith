import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoordDatabase } from './db.js';
import { FencingAndAgentManager } from './fencing.js';
import { LockEngine } from './locks.js';
import { ignoredPaths } from './git-ignore.js';

function isGitBlob(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value);
}

function sameIdSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const have = new Set(left);
  return right.every((id) => have.has(id));
}

export interface ConflictRecord {
  id: string;
  agent_a: string;
  agent_b: string;
  file_path: string;
  severity:
    | 'text_conflict'
    | 'transitive_contract_break';
  details: {
    reason: string;
    baseBlob?: string;
    blobA?: string;
    blobB?: string;
  };
  detected_at: number;
}

export interface DirtyMergeProbeResult {
  clean: boolean;
  mergedTreeSha: string | null;
  conflicts: ConflictRecord[];
}

export class ShadowGitEngine {
  constructor(
    private readonly coordDb: CoordDatabase,
    private readonly fencing: FencingAndAgentManager
  ) {}

  public isGitRepository(dir = this.coordDb.repoRoot): boolean {
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: dir,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  private blobAt(commit: string, filePath: string): string | null {
    try {
      const out = execFileSync('git', ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', filePath], { cwd: this.coordDb.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return /^\d+ blob ([0-9a-f]+)\t/.exec(out)?.[1] ?? null;
    } catch { return null; }
  }

  public getHeadCommit(dir = this.coordDb.repoRoot): string | null {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  }

  private getShadowIndexPath(agentId: string): string {
    const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const epoch = this.fencing.assertSession(agentId);
    return path.join(this.coordDb.coordDir, 'shadow-index', `${safeId}-${epoch}.index`);
  }

  /**
   * Updates an agent's ephemeral shadow Git index (`.coord/shadow-index/<agent-id>.index`)
   * without touching the repository's real `.git/index`, and creates a synthetic shadow
   * commit object in `.git/objects` so `git merge-tree --write-tree` can run 3-way merges
   * across uncommitted files in <15ms.
   */
  public updateAgentShadowTree(params: {
    agentId: string;
    modifiedFiles?: Array<{ filePath: string; content?: string }>;
    worktreeDir?: string;
  }): string | null {
    this.fencing.assertSession(params.agentId);
    const targetDir = params.worktreeDir ?? this.coordDb.repoRoot;
    if (!this.isGitRepository(targetDir)) return null;

    const headCommit = this.getHeadCommit(targetDir);
    if (!headCommit) return null;

    const shadowIndex = this.getShadowIndexPath(params.agentId);
    const env = { ...process.env, GIT_INDEX_FILE: shadowIndex };

    // Initialize shadow index from HEAD if it doesn't exist yet
    if (!fs.existsSync(shadowIndex)) {
      execFileSync('git', ['read-tree', headCommit], {
        cwd: targetDir,
        env,
        stdio: 'ignore',
      });
      fs.writeFileSync(`${shadowIndex}.base`, headCommit);
    } else {
      this.rebaseShadowIndex(shadowIndex, targetDir, env, headCommit);
    }

    if (params.worktreeDir && (!params.modifiedFiles || params.modifiedFiles.length === 0)) {
      // In an isolated worktree, stage all dirty working-tree files into the shadow index
      execFileSync('git', ['read-tree', headCommit], {
        cwd: targetDir,
        env,
        stdio: 'ignore',
      });
      execFileSync('git', ['add', '-A'], {
        cwd: targetDir,
        env,
        stdio: 'ignore',
      });
    } else if (params.modifiedFiles && params.modifiedFiles.length > 0) {
      const ignored = ignoredPaths(targetDir, params.modifiedFiles.map(m => LockEngine.normalizeFile(targetDir, m.filePath)));
      for (const mod of params.modifiedFiles) {
        const relPath = LockEngine.normalizeFile(targetDir, mod.filePath);
        if (ignored.has(relPath)) continue;
        const absPath = path.join(targetDir, relPath);
        const content =
          mod.content ??
          (fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : null);

        if (content === null) {
          // File was deleted
          {
            execFileSync('git', ['--literal-pathspecs', 'update-index', '--force-remove', '--', relPath], {
              cwd: targetDir,
              env,
              stdio: 'ignore',
            });
          }
        } else {
          const tracked = execFileSync('git', ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', relPath], {
            cwd: targetDir, env, encoding: 'utf8',
          }).split('\0').find(Boolean);
          const trackedMode = tracked?.split(' ')[0];
          const stat = fs.existsSync(absPath) ? fs.lstatSync(absPath) : null;
          if (trackedMode && !['100644', '100755'].includes(trackedMode) || stat?.isSymbolicLink()) {
            throw new Error(`Cannot report symlinks or special entries as source content: ${relPath}`);
          }
          const mode = trackedMode ?? (stat && stat.mode & 0o111 ? '100755' : '100644');
          const blobSha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: targetDir,
            input: content,
            encoding: 'utf8',
          }).trim();

          execFileSync(
            'git',
            ['update-index', '--add', '--cacheinfo', `${mode},${blobSha},${relPath}`],
            {
              cwd: targetDir,
              env,
              stdio: 'ignore',
            }
          );
        }
      }
    }

    const treeSha = execFileSync('git', ['write-tree'], {
      cwd: targetDir,
      env,
      encoding: 'utf8',
    }).trim();

    const shadowCommitSha = execFileSync(
      'git',
      ['commit-tree', treeSha, '-p', headCommit, '-m', `kith-shadow:${params.agentId}`],
      {
        cwd: targetDir,
        encoding: 'utf8',
      }
    ).trim();

    this.coordDb.withTransaction(() => {
      this.fencing.assertSession(params.agentId);
      this.coordDb.db.prepare(`UPDATE agents SET shadow_tree_sha = ? WHERE id = ?`).run(shadowCommitSha, params.agentId);
    });

    return shadowCommitSha;
  }

  /**
   * HEAD moves when anyone commits (including via a temporary index). Entries the agent never
   * touched must follow HEAD, or committed work reads as an uncommitted divergence and later
   * surfaces as a false merge conflict.
   */
  private rebaseShadowIndex(shadowIndex: string, dir: string, env: NodeJS.ProcessEnv, head: string): void {
    const baseFile = `${shadowIndex}.base`;
    let base = '';
    try { base = fs.readFileSync(baseFile, 'utf8').trim(); } catch { /* Index predates base tracking. */ }
    if (base === head) return;
    try {
      if (base) {
        const raw = execFileSync('git', ['diff-tree', '-r', '-z', '--raw', '--no-renames', base, head], { cwd: dir, encoding: 'utf8' }).split('\0');
        const staged = new Map<string, string>();
        for (const line of execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: dir, env, encoding: 'utf8' }).split('\0')) {
          const m = /^\d+ ([0-9a-f]+) \d\t([\s\S]+)$/.exec(line);
          if (m) staged.set(m[2], m[1]);
        }
        const zero = '0'.repeat(40);
        const info: string[] = [];
        for (let i = 0; i + 1 < raw.length; i += 2) {
          const m = /^:\d+ (\d+) ([0-9a-f]+) ([0-9a-f]+) /.exec(raw[i]);
          if (!m) continue;
          const [, newMode, oldSha, newSha] = m;
          const file = raw[i + 1];
          const mine = staged.get(file);
          const untouched = oldSha === zero ? mine === undefined : mine === oldSha;
          if (untouched) info.push(newSha === zero ? `0 ${zero}\t${file}` : `${newMode} ${newSha}\t${file}`);
        }
        if (info.length) execFileSync('git', ['update-index', '--index-info', '-z'], { cwd: dir, env, input: info.join('\0') + '\0', stdio: ['pipe', 'ignore', 'ignore'] });
      }
      fs.writeFileSync(baseFile, head);
    } catch { /* A stale index only costs accuracy; the conflict filter still applies. */ }
  }

  /**
   * Runs `git merge-tree --write-tree` across `agentId`'s dirty shadow commit and every
   * other active agent's dirty shadow commit (or branch).
   */
  public probeAllActiveConflicts(
    agentId: string,
    modifiedFiles?: Array<{ filePath: string; content?: string }>,
    worktreeDir?: string
  ): DirtyMergeProbeResult {
    const myShadowCommit = this.updateAgentShadowTree({
      agentId,
      modifiedFiles,
      worktreeDir,
    });

    if (!myShadowCommit) {
      return { clean: true, mergedTreeSha: null, conflicts: [] };
    }

    // Do not skip a peer because it shares this process's pid. Claude Code subagents record
    // the same owner pid on purpose, and so does every agent registered in one process
    // (the default anchor is process.pid). A missing, zero, or null pid is not an identity
    // either: treating those as equal would hide a real conflict. 0.1.8 already drops a
    // side that matches HEAD at probe time, which is what made a temporary-index commit
    // look like a merge conflict.
    const activeAgents = this.fencing
      .listAgents(true)
      .filter((a) => a.id !== agentId && a.shadow_tree_sha);

    const allConflicts: ConflictRecord[] = [];
    let lastMergedTreeSha: string | null = null;

    // Also clear legacy derived conflict classifications before re-probing.
    this.coordDb.withTransaction(() => {
      this.fencing.assertSession(agentId);
      this.coordDb.db.prepare(`DELETE FROM conflicts WHERE (agent_a = ? OR agent_b = ?) AND severity IN ('text_conflict', 'ast_conflict', 'auto_mergeable')`).run(agentId, agentId);
    });

    for (const peer of activeAgents) {
      if (!peer.shadow_tree_sha) continue;
      const res = this.probePairConflict(
        agentId,
        myShadowCommit,
        peer.id,
        peer.shadow_tree_sha
      );
      if (res.mergedTreeSha) {
        lastMergedTreeSha = res.mergedTreeSha;
      }
      allConflicts.push(...res.conflicts);
    }

    return {
      clean: allConflicts.length === 0,
      mergedTreeSha: lastMergedTreeSha,
      conflicts: allConflicts,
    };
  }

  public probePairConflict(
    agentA: string,
    commitA: string,
    agentB: string,
    commitB: string
  ): DirtyMergeProbeResult {
    this.fencing.assertSession(agentA);
    try {
      const stdout = execFileSync(
        'git',
        ['merge-tree', '--write-tree', '-z', commitA, commitB],
        {
          cwd: this.coordDb.repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ).trim();

      const mergedTreeSha = stdout.split('\0')[0]?.trim() ?? null;
      return {
        clean: true,
        mergedTreeSha,
        conflicts: [],
      };
    } catch (err: unknown) {
      const stdout =
        typeof (err as { stdout?: unknown })?.stdout === 'string'
          ? ((err as { stdout: string }).stdout ?? '')
          : '';

      const stageBlobsByFile = new Map<
        string,
        { stage1?: string; stage2?: string; stage3?: string }
      >();

      for (const line of stdout.split('\0')) {
        // Format: 100644 <blob-sha> <stage>\t<file-path>
        const m = line.match(/^(\d{6}) ([0-9a-f]+) ([123])\t([\s\S]+)$/);
        if (m) {
          const [, , blobSha, stage, filePath] = m;
          const entry = stageBlobsByFile.get(filePath) ?? {};
          if (stage === '1') entry.stage1 = blobSha;
          if (stage === '2') entry.stage2 = blobSha;
          if (stage === '3') entry.stage3 = blobSha;
          stageBlobsByFile.set(filePath, entry);
        }
      }

      if (stageBlobsByFile.size === 0) {
        throw new Error(`git merge-tree failed without a usable conflict result: ${err instanceof Error ? err.message : String(err)}`);
      }
      const conflicts: ConflictRecord[] = [];
      const now = Date.now();
      const ignored = ignoredPaths(this.coordDb.repoRoot, [...stageBlobsByFile.keys()]);

      const head = this.getHeadCommit();
      for (const [filePath, stages] of stageBlobsByFile.entries()) {
        if (ignored.has(filePath)) continue;
        // A side that already equals HEAD has nothing uncommitted, so the other side is not a conflict.
        const committed = head ? this.blobAt(head, filePath) : null;
        if (stages.stage2 && stages.stage2 === stages.stage3) continue;
        if (committed && (stages.stage2 === committed || stages.stage3 === committed)) continue;
        const severity = 'text_conflict' as const;

        const record: ConflictRecord = {
          id: `conf_${crypto.randomBytes(6).toString('hex')}`,
          agent_a: agentA,
          agent_b: agentB,
          file_path: filePath,
          severity,
          details: {
            reason: 'Git merge conflict requires explicit resolution',
            baseBlob: stages.stage1,
            blobA: stages.stage2,
            blobB: stages.stage3,
          },
          detected_at: now,
        };

        this.coordDb.withTransaction(() => {
          this.fencing.assertSession(agentA);
          this.coordDb.db
            .prepare(`
            INSERT OR REPLACE INTO conflicts (
              id, agent_a, agent_b, file_path, severity, details_json, detected_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            record.id,
            agentA,
            agentB,
            filePath,
            severity,
            JSON.stringify(record.details),
            now
          );
        });

        conflicts.push(record);
      }

      this.fencing.assertSession(agentA);
      if (!conflicts.length) return { clean: true, mergedTreeSha: null, conflicts };
      if (conflicts.length) {
        this.coordDb.logEvent(agentA, 'dirty_merge_conflict', {
          peerAgent: agentB,
          files: conflicts.map((c) => c.file_path),
        });
      }

      return {
        clean: false,
        mergedTreeSha: null,
        conflicts,
      };
    }
  }

  /** Remove orphaned shadow Git index files left behind by dead or completed sessions. */
  public pruneStaleShadowIndexes(dryRun = false): number {
    const indexDir = path.join(this.coordDb.coordDir, 'shadow-index');
    if (!fs.existsSync(indexDir)) return 0;
    const activeRows = this.coordDb.db
      .prepare(`
        SELECT a.id AS agent_id, s.epoch AS epoch
        FROM agents a JOIN agent_sessions s ON a.id = s.agent_id
        WHERE a.status = 'active'
      `)
      .all() as Array<{ agent_id: string; epoch: number }>;
    const keep = new Set(activeRows.map(r => `${r.agent_id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${r.epoch}.index`));
    let removed = 0;
    for (const entry of fs.readdirSync(indexDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.index') || keep.has(entry.name)) continue;
      if (dryRun) {
        removed++;
        continue;
      }
      try {
        fs.unlinkSync(path.join(indexDir, entry.name));
        removed++;
      } catch { /* Best effort */ }
    }
    return removed;
  }

  /** Counts from the most recent {@link pruneFalseConflicts} call. Tests assert the probe budget. */
  public lastConflictHygiene: { mergeFileProbes: number; headReads: number; removed: number; probeDir: string | null } = {
    mergeFileProbes: 0, headReads: 0, removed: 0, probeDir: null,
  };

  /**
   * Drop stored conflicts that are no longer real. 0.1.8 already refuses to record a side equal
   * to HEAD, or two identical sides, while probing. Rows written before that commit, or before
   * HEAD moved, stay until something reads them. `git merge-file` runs only for triples not
   * already settled, at most `maxMergeProbes` per call, and the decision is cached by HEAD sha
   * plus conflict id so a later status read does not spawn those processes again. Probe files
   * live in the system temp directory and are removed before this returns.
   */
  public pruneFalseConflicts(maxMergeProbes = 100): number {
    const stats = { mergeFileProbes: 0, headReads: 0, removed: 0, probeDir: null as string | null };
    this.lastConflictHygiene = stats;
    const rows = this.coordDb.db.prepare('SELECT * FROM conflicts').all() as Array<Record<string, unknown>>;
    if (!rows.length) return 0;

    const parsed = rows.map((row) => {
      let details: ConflictRecord['details'] = { reason: '' };
      try { details = JSON.parse(String(row.details_json)) as ConflictRecord['details']; } catch { /* Keep unreadable rows. */ }
      return {
        id: String(row.id),
        file: String(row.file_path),
        severity: String(row.severity),
        details,
      };
    });
    const doomed = new Set<string>();
    for (const row of parsed) {
      const { blobA, blobB } = row.details;
      if (row.severity === 'text_conflict' && isGitBlob(blobA) && blobA === blobB) doomed.add(row.id);
    }

    const cache = this.readHygieneCache();
    const head = this.getHeadCommit();
    const headChecked = new Set(cache.head === head ? cache.headChecked : []);
    const mergeSettled = new Set(cache.mergeSettled);
    const needHead = parsed.filter((row) => !doomed.has(row.id) && row.severity === 'text_conflict'
      && (isGitBlob(row.details.blobA) || isGitBlob(row.details.blobB)) && !headChecked.has(row.id));
    if (needHead.length) {
      const atHead = head ? this.blobsAtCommit(head, [...new Set(needHead.map((row) => row.file))], stats) : null;
      if (atHead) {
        for (const row of needHead) {
          const committed = atHead.get(row.file) ?? null;
          if (committed && (row.details.blobA === committed || row.details.blobB === committed)) doomed.add(row.id);
          headChecked.add(row.id);
        }
      }
    }

    const needMerge = parsed.filter((row) => !doomed.has(row.id) && row.severity === 'text_conflict'
      && isGitBlob(row.details.baseBlob) && isGitBlob(row.details.blobA) && isGitBlob(row.details.blobB)
      && !mergeSettled.has(row.id));
    const batch = needMerge.slice(0, Math.max(0, maxMergeProbes));
    if (batch.length) {
      const dir = fs.mkdtempSync(path.join(this.mergeProbeParent(), 'kith-merge-probe-'));
      stats.probeDir = dir;
      try {
        for (const row of batch) {
          stats.mergeFileProbes++;
          const merged = this.blobsMergeCleanly(dir, row.details.baseBlob!, row.details.blobA!, row.details.blobB!);
          if (merged === 'clean') doomed.add(row.id);
          else if (merged === 'conflict') mergeSettled.add(row.id);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    for (const row of parsed) {
      if (doomed.has(row.id)) continue;
      const probeable = row.severity === 'text_conflict'
        && isGitBlob(row.details.baseBlob) && isGitBlob(row.details.blobA) && isGitBlob(row.details.blobB);
      if (!probeable) mergeSettled.add(row.id);
    }

    if (doomed.size) {
      this.coordDb.withTransaction(() => {
        const del = this.coordDb.db.prepare('DELETE FROM conflicts WHERE id = ?');
        for (const id of doomed) del.run(id);
      });
    }
    stats.removed = doomed.size;
    const remain = new Set(parsed.filter((row) => !doomed.has(row.id)).map((row) => row.id));
    const nextCache = {
      head,
      headChecked: [...headChecked].filter((id) => remain.has(id)),
      mergeSettled: [...mergeSettled].filter((id) => remain.has(id)),
    };
    if (doomed.size || !sameIdSet(cache.headChecked, nextCache.headChecked) || !sameIdSet(cache.mergeSettled, nextCache.mergeSettled) || cache.head !== head) {
      this.writeHygieneCache(nextCache);
    }
    return doomed.size;
  }

  private blobsAtCommit(commit: string, files: string[], stats: { headReads: number }): Map<string, string | null> | null {
    const found = new Map<string, string | null>();
    try {
      for (let offset = 0; offset < files.length; offset += 200) {
        const chunk = files.slice(offset, offset + 200);
        stats.headReads++;
        const out = execFileSync('git', ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', ...chunk], {
          cwd: this.coordDb.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
        });
        for (const line of out.split('\0')) {
          const match = /^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
          if (match) found.set(match[2], match[1]);
        }
      }
    } catch {
      return null;
    }
    for (const file of files) if (!found.has(file)) found.set(file, null);
    return found;
  }

  /** `conflict` is a real overlap. `error` is not cached, so a later read can retry the probe. */
  private blobsMergeCleanly(dir: string, base: string, blobA: string, blobB: string): 'clean' | 'conflict' | 'error' {
    const show = (sha: string, name: string) => {
      const file = path.join(dir, name);
      const bytes = execFileSync('git', ['cat-file', 'blob', sha], {
        cwd: this.coordDb.repoRoot, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
      });
      fs.writeFileSync(file, bytes);
      return file;
    };
    try {
      const ours = show(blobA, 'a');
      const baseFile = show(base, 'base');
      const theirs = show(blobB, 'b');
      try {
        execFileSync('git', ['merge-file', ours, baseFile, theirs], { cwd: dir, stdio: 'ignore' });
        return 'clean';
      } catch (err) {
        const status = (err as { status?: number }).status;
        return typeof status === 'number' && status > 0 ? 'conflict' : 'error';
      }
    } catch {
      return 'error';
    }
  }

  /** Prefer the system temp dir. If that lives inside this checkout, step outside it. */
  private mergeProbeParent(): string {
    const repo = fs.realpathSync(this.coordDb.repoRoot);
    for (const candidate of [os.tmpdir(), '/tmp', os.homedir()]) {
      try {
        const real = fs.realpathSync(candidate);
        const relative = path.relative(repo, real);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return real;
      } catch { /* Try the next directory. */ }
    }
    return fs.realpathSync(os.tmpdir());
  }

  private hygieneCachePath(): string {
    return path.join(this.coordDb.coordDir, 'conflict-hygiene.json');
  }

  private readHygieneCache(): { head: string | null; headChecked: string[]; mergeSettled: string[] } {
    try {
      const raw = JSON.parse(fs.readFileSync(this.hygieneCachePath(), 'utf8')) as {
        head?: unknown; headChecked?: unknown; mergeSettled?: unknown;
      };
      const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      return {
        head: typeof raw.head === 'string' || raw.head === null ? raw.head : null,
        headChecked: strings(raw.headChecked),
        mergeSettled: strings(raw.mergeSettled),
      };
    } catch {
      return { head: null, headChecked: [], mergeSettled: [] };
    }
  }

  private writeHygieneCache(cache: { head: string | null; headChecked: string[]; mergeSettled: string[] }): void {
    const file = this.hygieneCachePath();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, file);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* Best effort. */ }
    }
  }

  public listConflicts(): ConflictRecord[] {
    this.fencing.reapDeadAgents();
    try { this.pruneFalseConflicts(); } catch { /* Hygiene must never break a read. */ }
    const rows = this.coordDb.db
      .prepare(`SELECT * FROM conflicts ORDER BY detected_at DESC`)
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      agent_a: String(r.agent_a),
      agent_b: String(r.agent_b),
      file_path: String(r.file_path),
      severity: r.severity as ConflictRecord['severity'],
      details: JSON.parse(String(r.details_json)) as ConflictRecord['details'],
      detected_at: Number(r.detected_at),
    }));
  }
}
