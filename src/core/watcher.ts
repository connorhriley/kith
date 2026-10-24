import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverRepository, physicalPath } from './repository.js';
import { readCoordinationState } from './observation.js';
import { coordinationView, type CoordinationView } from './coordination-view.js';
import { inspectWorkspaceContracts, type LinkedWorkspaceContract } from './workspace-contracts.js';

const execFileAsync = promisify(execFile);
export interface FileChangeEvent { filePath: string; repoPath: string; timestamp: number }
export interface CollisionAlert {
  id: string;
  filePath: string;
  repos: string[];
  severity: 'collision';
  message: string;
  timestamp: number;
}
export interface RadarWorktree {
  path: string;
  label: string;
  activity: 'active' | 'retained' | 'unregistered' | 'unknown';
  agentIds: string[];
  detail: string;
  dirtyFiles: number | null;
  sharedDirtyPaths: number;
}
export interface ScanIssue { repository: string; message: string }

// Compare current bytes, not dirty filenames or Git status codes. Unknown/large
// objects remain advisory overlaps; never follow a symlink outside the checkout.
function contentIdentity(repo: string, file: string): string | null {
  const target = path.join(repo, file);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw error; }
  const parent = fs.realpathSync(path.dirname(target));
  const relative = path.relative(repo, parent);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Path redirected outside checkout: ${file}`);
  if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(target)}`;
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs) throw new Error(`File changed during comparison: ${file}`);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let offset = 0; offset < before.size;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!count) throw new Error(`File changed during comparison: ${file}`);
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`File changed during comparison: ${file}`);
    return `file:${before.mode & 0o111}:${hash.digest('hex')}`;
  } finally { fs.closeSync(fd); }
}

/** Read-only overlap observations. This cannot identify writers or establish semantic conflicts. */
export class PassiveConflictWatcher {
  private isWatching = false;
  private watchTimer: NodeJS.Timeout | null = null;
  private recentEdits = new Map<string, { timestamp: number; repo: string; fingerprint: string }>();
  private activeCollisions = new Map<string, CollisionAlert>();
  private repositories = new Map<string, string>();
  private errors: ScanIssue[] = [];
  private primaryRoots = new Map<string, string>();
  private worktrees: RadarWorktree[] = [];
  private linkedContracts: LinkedWorkspaceContract[] = [];
  private coordination: CoordinationView = {available:false,working:[],queued:[],sessions:0,sessionKeys:[],waiting:[],using:[],attention:[]};

  constructor(public readonly rootDir: string, private readonly options: {
    intervalMs?: number;
    notify?: boolean;
    onCollision?: (alert: CollisionAlert) => void;
    onFileChange?: (event: FileChangeEvent) => void;
    onScanError?: (errors: ScanIssue[]) => void;
  } = {}) {
    if (options.intervalMs !== undefined && (!Number.isFinite(options.intervalMs) || options.intervalMs < 100)) throw new Error('Watch interval must be at least 100ms.');
  }

  public static notifyMac(title: string, message: string): void {
    if (process.platform !== 'darwin') return;
    try {
      // Pass filenames as arguments, never as AppleScript source.
      execFileSync('osascript', ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run', title, message], { stdio: 'ignore', timeout: 2000 });
    } catch { /* Optional notifications do not determine scan health. */ }
  }

  public discoverGitRepos(): string[] {
    this.errors = [];
    this.repositories.clear();
    this.primaryRoots.clear();
    const candidates: string[] = [];
    const marker = (dir: string) => {
      try { fs.lstatSync(path.join(dir, '.git')); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    };
    try {
      const root = fs.realpathSync(this.rootDir);
      if (marker(root)) candidates.push(root);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const sub = path.join(root, entry.name);
          if (marker(sub)) candidates.push(sub);
        }
      }
    } catch (error) {
      this.errors.push({ repository: this.rootDir, message: `Cannot discover repositories: ${error instanceof Error ? error.message : String(error)}` });
    }
    const inspected = new Set<string>();
    for (const candidate of candidates) {
      try {
        const layout = discoverRepository(candidate);
        if (!layout.commonGitDir) throw new Error('Git repository unavailable');
        this.repositories.set(layout.checkoutRoot, layout.commonGitDir);
        if (!layout.isLinkedWorktree) this.primaryRoots.set(layout.commonGitDir, layout.checkoutRoot);
        if (inspected.has(layout.commonGitDir)) continue;
        inspected.add(layout.commonGitDir);
        const listing = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: layout.checkoutRoot, encoding: 'utf8', timeout: 4000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        for (const record of listing.split('\0')) if (record.startsWith('worktree ')) {
          const linked = discoverRepository(record.slice(9));
          if (linked.commonGitDir !== layout.commonGitDir) throw new Error('Worktree repository identity changed during discovery');
          this.repositories.set(linked.checkoutRoot, layout.commonGitDir);
          if (!linked.isLinkedWorktree) this.primaryRoots.set(layout.commonGitDir, linked.checkoutRoot);
        }
      } catch (error) {
        this.errors.push({ repository: candidate, message: `Cannot inspect repository: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (!candidates.length && !this.errors.length) this.errors.push({ repository: this.rootDir, message: 'No Git repositories found in this directory or its immediate children.' });
    return [...this.repositories.keys()];
  }

  public async scanOnce(): Promise<CollisionAlert[]> {
    const repos = this.discoverGitRepos();
    const now = Date.now();
    const seen = new Set<string>();
    const dirtyCounts = new Map<string, number>();
    const overlaps = new Map<string, { file: string; repos: string[] }>();
    for (const repo of repos) {
      try {
        const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repo, timeout: 4000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
        const records = stdout.split('\0');
        const dirty = new Map<string, string>();
        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          if (!record) continue;
          const status = record.slice(0, 2);
          dirty.set(record.slice(3), status);
          if (/[RC]/.test(status)) dirty.set(records[++i], status); // NUL format carries both rename paths.
        }
        dirtyCounts.set(repo, [...dirty.keys()].filter(file => file && file !== '.coord' && !file.startsWith('.coord/')).length);
        for (const [file, status] of dirty) {
          if (!file || file === '.coord' || file.startsWith('.coord/')) continue;
          const key = JSON.stringify([repo, file]);
          seen.add(key);
          let modified: number | undefined, fingerprint = status;
          try {
            const stat = fs.lstatSync(path.join(repo, file));
            // Missing files and future mtimes cannot establish when an edit happened.
            if (Number.isFinite(stat.mtimeMs) && stat.mtimeMs <= now) modified = stat.mtimeMs;
            fingerprint += `:${stat.mtimeMs}:${stat.size}`;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const previous = this.recentEdits.get(key);
          if (modified === undefined) this.recentEdits.delete(key);
          else if (!previous || previous.fingerprint !== fingerprint) {
            this.recentEdits.set(key, { repo, fingerprint, timestamp: modified });
            this.options.onFileChange?.({ repoPath: repo, filePath: file, timestamp: modified });
          }
          const identity = JSON.stringify([this.repositories.get(repo), file]);
          const overlap = overlaps.get(identity) ?? { file, repos: [] };
          overlap.repos.push(repo);
          overlaps.set(identity, overlap);
        }
      } catch (error) {
        this.errors.push({ repository: repo, message: `Git scan unavailable: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (!this.errors.length) for (const key of this.recentEdits.keys()) if (!seen.has(key)) this.recentEdits.delete(key);
    const current = new Map<string, CollisionAlert>();
    for (const [id, overlap] of overlaps) if (overlap.repos.length > 1) {
      let identical = false;
      try {
        const identities = overlap.repos.map(repo => contentIdentity(repo, overlap.file));
        identical = identities.every(value => value !== null && value === identities[0]);
      } catch (error) {
        this.errors.push({ repository: overlap.repos.join(', '), message: `Cannot compare ${overlap.file}: ${error instanceof Error ? error.message : String(error)}` });
      }
      if (identical) continue;
      const previous = this.activeCollisions.get(id);
      const alert: CollisionAlert = { id, filePath: overlap.file, repos: overlap.repos, severity: 'collision', timestamp: previous?.timestamp ?? now,
        message: `Shared dirty path '${overlap.file}' has different or unverified contents in linked worktrees: ${overlap.repos.join(', ')}. This is not a proven merge conflict.` };
      current.set(id, alert);
      if (!previous) {
        this.options.onCollision?.(alert);
        if (this.options.notify) PassiveConflictWatcher.notifyMac('Kith worktree overlap', alert.message);
      }
    }
    // A failed scan cannot establish that a previously observed overlap is resolved.
    this.activeCollisions = this.errors.length ? new Map([...this.activeCollisions, ...current]) : current;
    // Read a private SQLite snapshot once per repository. Never open the engine,
    // renew/reap owners, or mistake an expired lease for a current participant.
    const states = new Map<string, ReturnType<typeof readCoordinationState>>();
    this.worktrees = repos.map(repo => {
      const common = this.repositories.get(repo)!;
      const primary = this.primaryRoots.get(common);
      const row: RadarWorktree = { path: repo,
        label: `${path.basename(primary ?? path.dirname(common))} / ${repo === primary ? 'primary' : path.basename(repo)}`,
        activity: 'unknown', agentIds: [], detail: 'Ownership unavailable; inspect kith status --offline before recovery.',
        dirtyFiles: dirtyCounts.get(repo) ?? null,
        sharedDirtyPaths: [...this.activeCollisions.values()].filter(alert => alert.repos.includes(repo)).length };
      try {
        let state = states.get(common);
        if (!state) { state = readCoordinationState(primary ?? repo, { coordinationOnly: true }); states.set(common, state); }
        if (state.state === 'unavailable') { row.detail += ` ${state.error}`; return row; }
        const owners = state.agents.filter(agent => agent.worktree_path ? physicalPath(agent.worktree_path) === repo : repo === primary);
        const active = owners.filter(agent => agent.status === 'active' && Number.isFinite(agent.lease_expires_at) && agent.lease_expires_at > state.observedAt);
        row.agentIds = (active.length ? active : owners).map(agent => agent.id);
        row.activity = active.length ? 'active' : owners.length ? 'retained' : 'unregistered';
        row.detail = active.length ? 'Current recorded Kith lease; does not identify file writers.'
          : owners.length ? `Recorded ${[...new Set(owners.map(agent => agent.status === 'active' ? 'expired lease' : agent.status))].join(', ')}; preserve work and inspect before cleanup.`
          : 'No recorded Kith session; activity and ownership outside Kith are unknown.';
      } catch (error) { row.detail += ` ${error instanceof Error ? error.message : String(error)}`; }
      return row;
    });
    const views = [...states.values()].map(coordinationView);
    this.coordination = {available: this.errors.length === 0 && views.every(v=>v.available),
      sessions: views.reduce((n,v)=>n+v.sessions,0), sessionKeys: views.flatMap(v=>v.sessionKeys), working: views.flatMap(v=>v.working),
      queued: views.flatMap(v=>v.queued ?? []),
      waiting: views.flatMap(v=>v.waiting), using: views.flatMap(v=>v.using), attention: views.flatMap(v=>v.attention)};
    this.linkedContracts = [...new Set(this.primaryRoots.values())].flatMap(root => {
      try { return inspectWorkspaceContracts(root).linkedContracts; } catch { return []; }
    });
    if (this.errors.length) this.options.onScanError?.(this.errors);
    return this.getActiveCollisions();
  }

  public start(): void {
    if (this.isWatching) return;
    this.isWatching = true;
    const tick = async () => {
      try { await this.scanOnce(); }
      catch (error) { this.errors = [{ repository: this.rootDir, message: String(error) }]; this.options.onScanError?.(this.errors); }
      if (this.isWatching) this.watchTimer = setTimeout(tick, this.options.intervalMs ?? 3000);
    };
    void tick();
  }
  public stop(): void {
    this.isWatching = false;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }
  public getScanState() { return { coordination: this.coordination, linkedContracts: [...this.linkedContracts], complete: this.errors.length === 0, errors: [...this.errors], repos: [...this.repositories.keys()], ownershipComplete: this.worktrees.every(row => row.activity !== 'unknown'), worktrees: this.worktrees.map(row => ({ ...row, agentIds: [...row.agentIds] })) }; }
  public getActiveCollisions(): CollisionAlert[] { return [...this.activeCollisions.values()]; }
  public getRecentEdits(): Array<{ key: string; repo: string; ageSec: number }> {
    const now = Date.now();
    return [...this.recentEdits].map(([key, value]) => ({ key: `${value.repo}/${JSON.parse(key)[1]}`, repo: value.repo, ageSec: Math.max(0, Math.round((now - value.timestamp) / 1000)) }))
      .filter(value => value.ageSec < 300).sort((a, b) => a.ageSec - b.ageSec);
  }
}
