import { execFileSync } from 'node:child_process';
import type { LockRecord } from './locks.js';
import { LockEngine } from './locks.js';
import { ignoredPaths } from './git-ignore.js';

export interface RecordedTask {
  status: string;
  owner_agent_id: string | null;
  scope_globs: string[];
}

/**
 * Working-tree paths `git status` reports as changed, including both sides of a rename.
 * This is the candidate set `kith commit` filters recorded locks and task scopes against.
 */
export function listDirtyFiles(rootDir: string): string[] {
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
 * Files `kith commit` would stage when the caller omits an explicit path list:
 * active file and narrow-glob locks, presence touched paths, and active task scopes,
 * limited to dirty paths Git is not ignoring. A `**` lock does not record every file.
 */
export function collectRecordedFiles(params: {
  worktreeRoot: string;
  callerAgentIds: ReadonlySet<string>;
  locks: LockRecord[];
  tasks: RecordedTask[];
  presenceTouched: string[];
  dirtyFiles: string[];
}): string[] {
  const dirtySet = new Set(params.dirtyFiles);
  const collected = new Set<string>();
  for (const lock of params.locks) {
    if (!params.callerAgentIds.has(lock.owner_agent_id)) continue;
    if (lock.lock_type === 'file' || !/[?*]/.test(lock.pattern)) {
      const rel = lock.pattern.startsWith('file:') ? lock.pattern.slice(5) : lock.pattern;
      if (!rel.startsWith('symbol:')) collected.add(rel);
    } else if (lock.pattern !== '**') {
      for (const df of params.dirtyFiles) {
        if (LockEngine.patternsOverlap(LockEngine.literalScope(df), lock.pattern)) collected.add(df);
      }
    }
  }
  for (const touched of params.presenceTouched) {
    try {
      collected.add(LockEngine.normalizeFile(params.worktreeRoot, touched));
    } catch { /* ignore invalid path */ }
  }
  for (const task of params.tasks) {
    if (task.status !== 'active' || !task.owner_agent_id || !params.callerAgentIds.has(task.owner_agent_id)) continue;
    for (const glob of task.scope_globs) {
      if (glob === '**') continue;
      for (const df of params.dirtyFiles) {
        if (LockEngine.patternsOverlap(LockEngine.literalScope(df), glob)) collected.add(df);
      }
    }
  }
  const candidates = [...collected].filter((f) => dirtySet.has(f));
  const ignored = candidates.length ? ignoredPaths(params.worktreeRoot, candidates) : new Set<string>();
  return candidates.filter((f) => !ignored.has(f));
}

/** True when `kith commit` would treat `relPath` as this caller's recorded file, even if the worktree is clean. */
export function pathRecordedByCaller(params: {
  worktreeRoot: string;
  relPath: string;
  callerAgentIds: ReadonlySet<string>;
  locks: LockRecord[];
  tasks: RecordedTask[];
  presenceTouched: string[];
}): boolean {
  const relPath = params.relPath.replace(/\\/g, '/');
  const requested = LockEngine.literalScope(relPath);
  for (const lock of params.locks) {
    if (!params.callerAgentIds.has(lock.owner_agent_id)) continue;
    if (lock.pattern.startsWith('symbol:')) continue;
    if (lock.pattern === '**') continue;
    if (lock.lock_type === 'file' || !/[?*]/.test(lock.pattern)) {
      const rel = lock.pattern.startsWith('file:') ? lock.pattern.slice(5) : lock.pattern;
      if (rel === relPath) return true;
    } else if (LockEngine.patternsOverlap(requested, lock.pattern)) {
      return true;
    }
  }
  for (const touched of params.presenceTouched) {
    try {
      if (LockEngine.normalizeFile(params.worktreeRoot, touched) === relPath) return true;
    } catch { /* ignore invalid path */ }
  }
  for (const task of params.tasks) {
    if (task.status !== 'active' || !task.owner_agent_id || !params.callerAgentIds.has(task.owner_agent_id)) continue;
    for (const glob of task.scope_globs) {
      if (glob === '**') continue;
      if (LockEngine.patternsOverlap(requested, glob)) return true;
    }
  }
  return false;
}

/** The other live agent's lock that overlaps `relPath`, if any. Symbol locks and `**` count. */
export function peerClaimOnPath(params: {
  relPath: string;
  callerAgentIds: ReadonlySet<string>;
  locks: LockRecord[];
}): { agentId: string; pattern: string } | null {
  const requested = LockEngine.literalScope(params.relPath.replace(/\\/g, '/'));
  for (const lock of params.locks) {
    if (params.callerAgentIds.has(lock.owner_agent_id)) continue;
    if (LockEngine.patternsOverlap(requested, lock.pattern)) {
      return { agentId: lock.owner_agent_id, pattern: lock.pattern };
    }
  }
  return null;
}
