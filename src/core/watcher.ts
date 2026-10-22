import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface FileChangeEvent {
  filePath: string;
  repoPath: string;
  timestamp: number;
  processInfo?: string;
}

export interface CollisionAlert {
  id: string;
  filePath: string;
  repos: string[];
  severity: 'collision' | 'cross_repo_contract' | 'concurrent_write';
  message: string;
  timestamp: number;
}

export class PassiveConflictWatcher {
  private isWatching = false;
  private watchTimer: NodeJS.Timeout | null = null;
  private recentEdits = new Map<string, { timestamp: number; repo: string; hash?: string }>();
  private activeCollisions = new Map<string, CollisionAlert>();

  constructor(
    public readonly rootDir: string,
    private readonly options: {
      intervalMs?: number;
      notify?: boolean;
      onCollision?: (alert: CollisionAlert) => void;
      onFileChange?: (event: FileChangeEvent) => void;
    } = {}
  ) {}

  public static notifyMac(title: string, message: string): void {
    if (process.platform !== 'darwin') return;
    try {
      const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}" sound name "Submarine"`;
      execFileSync('osascript', ['-e', script], { stdio: 'ignore' });
    } catch {
      // Ignore notification failures
    }
  }

  public discoverGitRepos(): string[] {
    const repos: string[] = [];
    if (fs.existsSync(path.join(this.rootDir, '.git'))) {
      repos.push(this.rootDir);
    }
    try {
      const entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const sub = path.join(this.rootDir, entry.name);
          if (fs.existsSync(path.join(sub, '.git'))) {
            repos.push(sub);
          }
        }
      }
    } catch {
      // Ignore read errors
    }
    return repos;
  }

  public async scanOnce(): Promise<CollisionAlert[]> {
    const repos = this.discoverGitRepos();
    const now = Date.now();
    const newCollisions: CollisionAlert[] = [];

    // Scan active processes to attribute editors
    let activeEditorPids = '';
    try {
      const { stdout } = await execFileAsync('ps', ['-eo', 'pid,command'], { timeout: 3000 });
      activeEditorPids = stdout;
    } catch {
      // Ignore
    }

    const currentDirtyFilesByRepo = new Map<string, Set<string>>();

    for (const repo of repos) {
      const dirty = new Set<string>();
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1'],
          { cwd: repo, timeout: 4000 }
        );
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const relPath = line.slice(3).trim();
          if (
            relPath.startsWith('.coord') ||
            relPath.endsWith('.log') ||
            relPath.endsWith('.tmp') ||
            relPath.endsWith('.bak')
          ) {
            continue;
          }
          dirty.add(relPath);

          const key = `${path.basename(repo)}/${relPath}`;
          const prev = this.recentEdits.get(key);
          this.recentEdits.set(key, { timestamp: now, repo });

          if (this.options.onFileChange && (!prev || now - prev.timestamp > 10000)) {
            this.options.onFileChange({
              filePath: relPath,
              repoPath: repo,
              timestamp: now,
            });
          }
        }
      } catch {
        // Ignore git errors
      }
      currentDirtyFilesByRepo.set(repo, dirty);
    }

    // 1. Detect duplicate or colliding file paths across active sub-repos / worktrees
    const genericFilenames = new Set([
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'README.md',
      '.gitignore',
      'page.tsx',
      'layout.tsx',
      'route.ts',
      'index.ts',
      'globals.css',
    ]);

    const fileToRepos = new Map<string, Set<string>>();
    for (const [repo, dirtyFiles] of currentDirtyFilesByRepo.entries()) {
      const repoName = path.basename(repo);
      for (const file of dirtyFiles) {
        const baseName = path.basename(file);
        if (genericFilenames.has(baseName)) {
          // Generic files are only collisions if the exact relative path is modified across worktrees of the same codebase
          continue;
        }
        const set = fileToRepos.get(baseName) ?? new Set<string>();
        set.add(repoName);
        fileToRepos.set(baseName, set);
      }
    }

    for (const [baseName, repoSet] of fileToRepos.entries()) {
      const repoList = Array.from(repoSet);
      if (repoList.length > 1) {
        const alertId = `col_${baseName}`;
        if (!this.activeCollisions.has(alertId)) {
          const alert: CollisionAlert = {
            id: alertId,
            filePath: baseName,
            repos: repoList,
            severity: 'collision',
            message: `Multiple repositories/worktrees (${repoList.join(', ')}) are modifying '${baseName}' simultaneously!`,
            timestamp: now,
          };
          this.activeCollisions.set(alertId, alert);
          newCollisions.push(alert);
          if (this.options.notify) {
            PassiveConflictWatcher.notifyMac(
              '⚠️ Kith Conflict Alert',
              `Parallel agents are both editing ${baseName} in ${repoList.join(' & ')}`
            );
          }
          if (this.options.onCollision) {
            this.options.onCollision(alert);
          }
        }
      }
    }

    // 2. Cross-repo contract divergence check (e.g. atlasInvestigation vs investigation-api)
    const allModified = Array.from(this.recentEdits.keys());
    const contracts = allModified.filter((f) => f.includes('contract') || f.includes('api'));
    if (contracts.length > 1) {
      const distinctRepos = new Set(contracts.map((c) => c.split('/')[0]));
      if (distinctRepos.size > 1) {
        const contractAlertId = 'contract_sync';
        if (!this.activeCollisions.has(contractAlertId)) {
          const alert: CollisionAlert = {
            id: contractAlertId,
            filePath: contracts.join(', '),
            repos: Array.from(distinctRepos),
            severity: 'cross_repo_contract',
            message: `Active cross-repo contract edits across ${Array.from(distinctRepos).join(' and ')}. Verify API compatibility before committing.`,
            timestamp: now,
          };
          this.activeCollisions.set(contractAlertId, alert);
          newCollisions.push(alert);
        }
      }
    }

    return Array.from(this.activeCollisions.values());
  }

  public start(): void {
    if (this.isWatching) return;
    this.isWatching = true;
    const interval = this.options.intervalMs ?? 3000;

    const tick = async () => {
      if (!this.isWatching) return;
      try {
        await this.scanOnce();
      } catch {
        // Ignore scan errors
      }
      if (this.isWatching) {
        this.watchTimer = setTimeout(tick, interval);
      }
    };

    tick();
  }

  public stop(): void {
    this.isWatching = false;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
  }

  public getActiveCollisions(): CollisionAlert[] {
    return Array.from(this.activeCollisions.values());
  }

  public getRecentEdits(): Array<{ key: string; repo: string; ageSec: number }> {
    const now = Date.now();
    return Array.from(this.recentEdits.entries())
      .map(([key, data]) => ({
        key,
        repo: data.repo,
        ageSec: Math.round((now - data.timestamp) / 1000),
      }))
      .filter((e) => e.ageSec < 300)
      .sort((a, b) => a.ageSec - b.ageSec);
  }
}
