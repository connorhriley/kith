import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CoordDatabase } from './db.js';
import { FencingAndAgentManager } from './fencing.js';

export interface SpawnedWorktree {
  agentId: string;
  worktreePath: string;
  branch: string;
  hydrationMethod: 'apfs-cow' | 'reflink-cow' | 'symlink' | 'none';
  hydratedDirs: string[];
  durationMs: number;
}

export class CoWWorktreeManager {
  private static readonly HYDRATABLE_DIRS = ['node_modules', '.venv', 'venv', '.turbo'];
  private static readonly ENV_FILES = ['.env', '.env.local', '.env.development', '.env.test'];

  constructor(
    private readonly coordDb: CoordDatabase,
    private readonly fencing: FencingAndAgentManager
  ) {}

  /**
   * Spawns an isolated Git worktree for `agentId` and hydrates `node_modules` / `.env`
   * using APFS Copy-on-Write (`cp -cR`) on macOS or reflink on Linux (with symlink fallback).
   */
  public spawnWorktree(params: {
    agentId: string;
    branch?: string;
    baseRef?: string;
  }): SpawnedWorktree {
    const start = Date.now();
    const safeId = params.agentId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const branch = params.branch ?? `kith/${safeId}`;
    const baseRef = params.baseRef ?? 'HEAD';
    const worktreePath = path.join(this.coordDb.coordDir, 'worktrees', safeId);

    if (fs.existsSync(worktreePath)) {
      this.removeWorktree(params.agentId);
    }

    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    execFileSync('git', ['worktree', 'add', '-B', branch, worktreePath, baseRef], {
      cwd: this.coordDb.repoRoot,
      stdio: 'ignore',
    });

    const hydratedDirs: string[] = [];
    let hydrationMethod: SpawnedWorktree['hydrationMethod'] = 'none';

    for (const dirName of CoWWorktreeManager.HYDRATABLE_DIRS) {
      const srcDir = path.join(this.coordDb.repoRoot, dirName);
      const destDir = path.join(worktreePath, dirName);
      if (!fs.existsSync(srcDir) || fs.existsSync(destDir)) continue;

      const method = this.cloneDirectoryCoW(srcDir, destDir);
      hydrationMethod = method;
      hydratedDirs.push(dirName);
    }

    for (const envName of CoWWorktreeManager.ENV_FILES) {
      const srcEnv = path.join(this.coordDb.repoRoot, envName);
      const destEnv = path.join(worktreePath, envName);
      if (fs.existsSync(srcEnv) && !fs.existsSync(destEnv)) {
        fs.copyFileSync(srcEnv, destEnv);
      }
    }

    this.coordDb.withTransaction(() => {
      this.coordDb.db
        .prepare(`UPDATE agents SET worktree_path = ?, branch = ? WHERE id = ?`)
        .run(worktreePath, branch, params.agentId);

      this.coordDb.logEvent(params.agentId, 'worktree_spawned', {
        worktreePath,
        branch,
        hydrationMethod,
        hydratedDirs,
      });
    });

    return {
      agentId: params.agentId,
      worktreePath,
      branch,
      hydrationMethod,
      hydratedDirs,
      durationMs: Date.now() - start,
    };
  }

  private cloneDirectoryCoW(
    srcDir: string,
    destDir: string
  ): 'apfs-cow' | 'reflink-cow' | 'symlink' {
    if (process.platform === 'darwin') {
      try {
        execFileSync('cp', ['-cR', srcDir, destDir], {
          stdio: 'ignore',
          timeout: 5000,
        });
        return 'apfs-cow';
      } catch {
        // Fallback if volume is not APFS
      }
    } else if (process.platform === 'linux') {
      try {
        execFileSync('cp', ['--reflink=always', '-R', srcDir, destDir], {
          stdio: 'ignore',
          timeout: 5000,
        });
        return 'reflink-cow';
      } catch {
        // Fallback if filesystem does not support reflinks
      }
    }

    fs.symlinkSync(srcDir, destDir, 'dir');
    return 'symlink';
  }

  public removeWorktree(agentId: string): boolean {
    const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const worktreePath = path.join(this.coordDb.coordDir, 'worktrees', safeId);

    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: this.coordDb.repoRoot,
        stdio: 'ignore',
      });
    } catch {
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      try {
        execFileSync('git', ['worktree', 'prune'], {
          cwd: this.coordDb.repoRoot,
          stdio: 'ignore',
        });
      } catch {
        // Ignore prune errors
      }
    }

    this.coordDb.db
      .prepare(`UPDATE agents SET worktree_path = NULL WHERE id = ?`)
      .run(agentId);

    return true;
  }

  public listWorktrees(): Array<{ path: string; head: string; branch: string | null }> {
    try {
      const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: this.coordDb.repoRoot,
        encoding: 'utf8',
      });

      const entries: Array<{ path: string; head: string; branch: string | null }> = [];
      let current: { path: string; head: string; branch: string | null } | null = null;

      for (const line of out.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
          if (current) entries.push(current);
          current = { path: line.slice('worktree '.length).trim(), head: '', branch: null };
        } else if (line.startsWith('HEAD ') && current) {
          current.head = line.slice('HEAD '.length).trim();
        } else if (line.startsWith('branch ') && current) {
          current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim();
        }
      }
      if (current) entries.push(current);
      return entries;
    } catch {
      return [];
    }
  }
}
