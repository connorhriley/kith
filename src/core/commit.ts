import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ancestorChain, listRepoPresence, ownedByCaller, resolveHomeDir } from '../cli/auto-session.js';
import type { KithEngine } from './engine.js';
import { FencingAndAgentManager } from './fencing.js';
import { resyncStaleIndexEntries } from './gc.js';
import { ignoredPaths } from './git-ignore.js';
import { LockEngine } from './locks.js';

export interface CommitParams {
  agentId?: string;
  sessionToken?: string;
  message: string;
  files?: string[];
  callerPid?: number;
  home?: string;
}

export interface CommitResult {
  ok: boolean;
  commit: string | null;
  branch: string | null;
  files: string[];
  agentId: string | null;
  message: string;
  error?: string;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withCommitLock<T>(coordDir: string, fn: () => T, timeoutMs = 15_000): T {
  fs.mkdirSync(coordDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(coordDir, 'commit.lock');
  const started = Date.now();
  let fd: number | undefined;
  while (true) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number; startedAt?: number };
        if (raw.pid && raw.pid > 0) {
          try {
            process.kill(raw.pid, 0);
          } catch (killErr) {
            if ((killErr as NodeJS.ErrnoException).code === 'ESRCH') {
              try { fs.unlinkSync(lockPath); continue; } catch { /* raced */ }
            }
          }
        }
      } catch { /* lock file being written */ }
      if (Date.now() - started >= timeoutMs) {
        throw new Error('Timed out waiting for concurrent kith commit lock (.coord/commit.lock).');
      }
      sleepSync(40);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

function listDirtyFiles(rootDir: string): string[] {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tokens = out.split('\0');
    const files: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (!entry || entry.length < 4) continue;
      const status = entry.slice(0, 2);
      const file = entry.slice(3);
      if (file) files.push(file);
      if ((status.startsWith('R') || status.startsWith('C')) && i + 1 < tokens.length && tokens[i + 1]) {
        files.push(tokens[++i]);
      }
    }
    return Array.from(new Set(files));
  } catch {
    return [];
  }
}

/**
 * Commits only the specified (or caller-recorded) files using a temporary Git index,
 * `git commit-tree`, and compare-and-swap `git update-ref`, then syncs those paths in
 * `.git/index` so shared-checkout `main` sessions never sweep sibling edits or leave
 * phantom staged deletions/modifications.
 */
export function commitScopedFiles(engine: KithEngine, params: CommitParams): CommitResult {
  const message = (params.message ?? '').trim();
  if (!message) {
    return {
      ok: false,
      commit: null,
      branch: null,
      files: [],
      agentId: params.agentId ?? null,
      message: '',
      error: 'Commit message is required (-m "<message>").',
    };
  }

  engine.fencing.reapDeadAgents();
  const callerPid = params.callerPid ?? process.pid;
  const ancestors = ancestorChain(callerPid);
  const callerAgentIds = new Set<string>();

  const home = resolveHomeDir(params.home);
  const allPresenceMatches = engine.coordDb.commonGitDir
    ? listRepoPresence(home, engine.coordDb.commonGitDir).filter((p) => ownedByCaller(p.pid, callerPid))
    : [];
  const presencePeers = allPresenceMatches.length === 1 ? allPresenceMatches : [];

  if (params.agentId) {
    if (params.sessionToken) {
      engine.fencing.resumeSession(params.agentId, params.sessionToken);
      callerAgentIds.add(params.agentId);
    } else {
      try {
        engine.fencing.assertSession(params.agentId);
        callerAgentIds.add(params.agentId);
      } catch {
        const record = engine.fencing.getAgent(params.agentId);
        if (record && record.status === 'active' && ownedByCaller(record.pid, callerPid)) {
          callerAgentIds.add(params.agentId);
        }
      }
    }
  } else {
    const mutexRuns = engine.coordDb.db
      .prepare('SELECT owner_agent_id, supervisor_pid, worker_pid FROM mutex_runs')
      .all() as Array<{ owner_agent_id: string; supervisor_pid: number; worker_pid: number | null }>;
    for (const run of mutexRuns) {
      if (
        (run.worker_pid && ownedByCaller(run.worker_pid, callerPid)) ||
        ownedByCaller(run.supervisor_pid, callerPid)
      ) {
        callerAgentIds.add(run.owner_agent_id);
      }
    }
    const pidMatchedAgents = engine.fencing.listAgents(true).filter((a) => ownedByCaller(a.pid, callerPid));
    if (pidMatchedAgents.length === 1) {
      callerAgentIds.add(pidMatchedAgents[0]!.id);
    }
  }

  for (const peer of presencePeers) {
    const digest = crypto.createHash('sha1').update(peer.sessionKey).digest('hex').slice(0, 8);
    const autoId = `auto-${peer.client}-${digest}`;
    if (!params.agentId || params.agentId === autoId) {
      callerAgentIds.add(autoId);
    }
  }

  if (params.agentId && !callerAgentIds.has(params.agentId)) {
    const existing = engine.fencing.getAgent(params.agentId);
    if (existing && existing.status === 'active' && FencingAndAgentManager.isProcessAlive(existing.pid, existing.pid_start_time)) {
      return {
        ok: false,
        commit: null,
        branch: null,
        files: [],
        agentId: params.agentId,
        message,
        error: `Session '${params.agentId}' is owned by another live process. Pass its session token or run kith commit from the owning session.`,
      };
    }
    callerAgentIds.add(params.agentId);
  }

  const primaryAgentId = params.agentId ?? [...callerAgentIds][0] ?? null;
  const worktreeRoot =
    (primaryAgentId ? engine.fencing.getAgent(primaryAgentId)?.worktree_path : null) ??
    engine.coordDb.repoRoot;

  const dirtyFiles = listDirtyFiles(worktreeRoot);
  const dirtySet = new Set(dirtyFiles);
  const activeLocks = engine.locks.listLocks();

  let targetFiles: string[] = [];
  if (params.files && params.files.length > 0) {
    targetFiles = Array.from(
      new Set(params.files.map((f) => LockEngine.normalizeFile(worktreeRoot, f)))
    );
  } else {
    const collected = new Set<string>();
    for (const lock of activeLocks) {
      if (!callerAgentIds.has(lock.owner_agent_id)) continue;
      if (lock.lock_type === 'file' || !/[?*]/.test(lock.pattern)) {
        const rel = lock.pattern.startsWith('file:') ? lock.pattern.slice(5) : lock.pattern;
        if (!rel.startsWith('symbol:')) collected.add(rel);
      } else if (lock.pattern !== '**') {
        for (const df of dirtyFiles) {
          if (LockEngine.patternsOverlap(LockEngine.literalScope(df), lock.pattern)) {
            collected.add(df);
          }
        }
      }
    }
    for (const peer of presencePeers) {
      for (const touched of peer.touchedFiles) {
        try {
          collected.add(LockEngine.normalizeFile(worktreeRoot, touched));
        } catch { /* ignore invalid path */ }
      }
    }
    for (const task of engine.intents.listTasks()) {
      if (task.status !== 'active' || !task.owner_agent_id || !callerAgentIds.has(task.owner_agent_id)) continue;
      for (const glob of task.scope_globs) {
        if (glob === '**') continue;
        for (const df of dirtyFiles) {
          if (LockEngine.patternsOverlap(LockEngine.literalScope(df), glob)) {
            collected.add(df);
          }
        }
      }
    }
    const candidates = [...collected].filter((f) => dirtySet.has(f));
    const ignored = candidates.length ? ignoredPaths(worktreeRoot, candidates) : new Set<string>();
    targetFiles = candidates.filter((f) => !ignored.has(f));
  }

  if (targetFiles.length === 0) {
    return {
      ok: false,
      commit: null,
      branch: null,
      files: [],
      agentId: primaryAgentId,
      message,
      error:
        'No recorded modified files found for this session. Pass explicit file paths (`kith commit -m "<message>" <files...>`) or claim/edit files first.',
    };
  }

  // Refuse if any target file is locked by another live agent outside this caller's session.
  for (const relFile of targetFiles) {
    const requested = LockEngine.literalScope(relFile);
    for (const lock of activeLocks) {
      if (callerAgentIds.has(lock.owner_agent_id)) continue;
      if (LockEngine.patternsOverlap(requested, lock.pattern)) {
        return {
          ok: false,
          commit: null,
          branch: null,
          files: [],
          agentId: primaryAgentId,
          message,
          error: `Cannot commit '${relFile}': locked by active peer agent '${lock.owner_agent_id}' (${lock.pattern}).`,
        };
      }
    }
  }

  return withCommitLock(engine.coordDb.coordDir, () => {
    let headBefore: string | null = null;
    try {
      headBefore = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: worktreeRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      headBefore = null;
    }

    let branch: string | null = null;
    try {
      branch =
        execFileSync('git', ['symbolic-ref', '-q', '--short', 'HEAD'], {
          cwd: worktreeRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null;
    } catch {
      branch = null;
    }

    const tempIndex = path.join(
      engine.coordDb.coordDir,
      'shadow-index',
      `commit-${process.pid}-${crypto.randomBytes(6).toString('hex')}.index`
    );
    fs.mkdirSync(path.dirname(tempIndex), { recursive: true, mode: 0o700 });
    const gitEnv = { ...process.env, GIT_INDEX_FILE: tempIndex };

    try {
      if (headBefore) {
        execFileSync('git', ['read-tree', headBefore], {
          cwd: worktreeRoot,
          env: gitEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }

      execFileSync('git', ['add', '-A', '--', ...targetFiles], {
        cwd: worktreeRoot,
        env: gitEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const diffOut = headBefore
        ? execFileSync('git', ['diff-index', '--cached', '--name-only', '-z', headBefore], {
            cwd: worktreeRoot,
            env: gitEnv,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : execFileSync('git', ['ls-files', '--cached', '-z'], {
            cwd: worktreeRoot,
            env: gitEnv,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });

      const committedFiles = Array.from(new Set(diffOut.split('\0').filter(Boolean)));
      if (committedFiles.length === 0) {
        return {
          ok: false,
          commit: null,
          branch,
          files: [],
          agentId: primaryAgentId,
          message,
          error: 'Specified files have no changes relative to HEAD.',
        };
      }

      const treeSha = execFileSync('git', ['write-tree'], {
        cwd: worktreeRoot,
        env: gitEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();

      const commitArgs = ['commit-tree', treeSha, ...(headBefore ? ['-p', headBefore] : []), '-m', message];
      const commitSha = execFileSync('git', commitArgs, {
        cwd: worktreeRoot,
        env: gitEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();

      const subject = message.split(/\r?\n/, 1)[0];
      const oldRef = headBefore ?? '0000000000000000000000000000000000000000';
      execFileSync('git', ['update-ref', '-m', `commit: ${subject}`, 'HEAD', commitSha, oldRef], {
        cwd: worktreeRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Keep the real .git/index aligned with the new HEAD on the committed paths so git status
      // never shows phantom staged deletions (D) or modifications (MM).
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          execFileSync('git', ['reset', '-q', 'HEAD', '--', ...committedFiles], {
            cwd: worktreeRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          break;
        } catch {
          sleepSync(40);
        }
      }
      resyncStaleIndexEntries(worktreeRoot);

      engine.coordDb.logEvent(primaryAgentId, 'scoped_commit', {
        commit: commitSha,
        branch,
        files: committedFiles,
        message: subject,
      });

      return {
        ok: true,
        commit: commitSha,
        branch,
        files: committedFiles,
        agentId: primaryAgentId,
        message,
      };
    } finally {
      try {
        fs.unlinkSync(tempIndex);
      } catch { /* ignore */ }
    }
  });
}
