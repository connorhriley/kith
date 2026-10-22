import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverRepository } from './repository.js';

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
export interface ScanIssue { repository: string; message: string }

/** Read-only overlap observations. This cannot identify writers or establish semantic conflicts. */
export class PassiveConflictWatcher {
  private isWatching = false;
  private watchTimer: NodeJS.Timeout | null = null;
  private recentEdits = new Map<string, { timestamp: number; repo: string; fingerprint: string }>();
  private activeCollisions = new Map<string, CollisionAlert>();
  private repositories = new Map<string, string>();
  private errors: ScanIssue[] = [];

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
        if (inspected.has(layout.commonGitDir)) continue;
        inspected.add(layout.commonGitDir);
        const listing = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: layout.checkoutRoot, encoding: 'utf8', timeout: 4000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        for (const record of listing.split('\0')) if (record.startsWith('worktree ')) {
          const linked = discoverRepository(record.slice(9));
          if (linked.commonGitDir !== layout.commonGitDir) throw new Error('Worktree repository identity changed during discovery');
          this.repositories.set(linked.checkoutRoot, layout.commonGitDir);
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
    const overlaps = new Map<string, { file: string; repos: string[] }>();
    for (const repo of repos) {
      try {
        const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repo, timeout: 4000, maxBuffer: 4 * 1024 * 1024 });
        const records = stdout.split('\0');
        const dirty = new Map<string, string>();
        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          if (!record) continue;
          const status = record.slice(0, 2);
          dirty.set(record.slice(3), status);
          if (/[RC]/.test(status)) dirty.set(records[++i], status); // NUL format carries both rename paths.
        }
        for (const [file, status] of dirty) {
          if (!file || file === '.coord' || file.startsWith('.coord/')) continue;
          const key = JSON.stringify([repo, file]);
          seen.add(key);
          let modified = now, fingerprint = status;
          try {
            const stat = fs.lstatSync(path.join(repo, file));
            modified = Math.min(now, stat.mtimeMs);
            fingerprint += `:${stat.mtimeMs}:${stat.size}`;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const previous = this.recentEdits.get(key);
          if (!previous || previous.fingerprint !== fingerprint) {
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
      const previous = this.activeCollisions.get(id);
      const alert: CollisionAlert = { id, filePath: overlap.file, repos: overlap.repos, severity: 'collision', timestamp: previous?.timestamp ?? now,
        message: `Overlapping uncommitted changes to '${overlap.file}' in linked worktrees: ${overlap.repos.join(', ')}` };
      current.set(id, alert);
      if (!previous) {
        this.options.onCollision?.(alert);
        if (this.options.notify) PassiveConflictWatcher.notifyMac('Kith worktree overlap', alert.message);
      }
    }
    // A failed scan cannot establish that a previously observed overlap is resolved.
    this.activeCollisions = this.errors.length ? new Map([...this.activeCollisions, ...current]) : current;
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
  public getScanState() { return { complete: this.errors.length === 0, errors: [...this.errors], repos: [...this.repositories.keys()] }; }
  public getActiveCollisions(): CollisionAlert[] { return [...this.activeCollisions.values()]; }
  public getRecentEdits(): Array<{ key: string; repo: string; ageSec: number }> {
    const now = Date.now();
    return [...this.recentEdits].map(([key, value]) => ({ key: `${value.repo}/${JSON.parse(key)[1]}`, repo: value.repo, ageSec: Math.max(0, Math.round((now - value.timestamp) / 1000)) }))
      .filter(value => value.ageSec < 300).sort((a, b) => a.ageSec - b.ageSec);
  }
}
