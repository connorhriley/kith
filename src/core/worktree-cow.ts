import { physicalPath } from './repository.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CoordDatabase } from './db.js';
import { FencingAndAgentManager } from './fencing.js';
import {
  adoptIfUnambiguous as adoptLinkedIfUnambiguous,
  adoptWorktree as adoptLinkedWorktree,
  clearRegistration,
  forgetWorktree as forgetLinkedWorktree,
  isKithOwnedWorktree,
  listGitWorktrees,
  listRegistrations as listStoredRegistrations,
  liveAdoption as inspectLiveAdoption,
  readRegistration,
  recordCreatedWorktree,
  syncRegistration as syncStoredRegistration,
  type ListedWorktree,
  type LiveAdoption,
  type WorktreeBinding,
  type WorktreeRegistration,
} from './worktree-adopt.js';

export interface SpawnedWorktree {
  agentId: string;
  worktreePath: string;
  branch: string | null;
  hydrationMethod: 'apfs-cow' | 'reflink-cow' | 'copy' | 'none';
  hydratedDirs: string[];
  durationMs: number;
  provenance?: WorktreeBinding['provenance'];
  source?: WorktreeBinding['source'];
  detached?: boolean;
  dirty?: boolean;
  branchCheckedOutElsewhere?: boolean;
  alreadyRegistered?: boolean;
  notes?: string[];
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
   * using APFS Copy-on-Write (`cp -cR`) on macOS or reflink on Linux (with independent-copy fallback).
   */
  public spawnWorktree(params: {
    agentId: string;
    branch?: string;
    baseRef?: string;
  }): SpawnedWorktree {
    this.fencing.assertSession(params.agentId);
    const start = Date.now();
    const safeId = params.agentId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const branch = params.branch ?? `kith/${safeId}`;
    const baseRef = params.baseRef ?? 'HEAD';
    const worktreePath = path.join(this.coordDb.coordDir, 'worktrees', safeId);

    if (!this.fencing.getAgent(params.agentId)) throw new Error(`Unknown agent: ${params.agentId}`);
    if (!safeId || safeId === '.' || safeId === '..') throw new Error('Invalid agent ID');
    if (fs.existsSync(worktreePath)) {
      throw new Error(`Worktree already exists: ${worktreePath}. Commit or preserve its work before removing it.`);
    }

    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, baseRef], {
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
      if (hydrationMethod !== 'copy') hydrationMethod = method;
      hydratedDirs.push(dirName);
    }

    for (const envName of CoWWorktreeManager.ENV_FILES) {
      const srcEnv = path.join(this.coordDb.repoRoot, envName);
      const destEnv = path.join(worktreePath, envName);
      if (fs.existsSync(srcEnv) && !fs.existsSync(destEnv)) {
        fs.copyFileSync(srcEnv, destEnv);
      }
    }

    let head: string | null = null;
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch { head = null; }
    this.coordDb.withTransaction(() => {
      this.fencing.assertSession(params.agentId);
      this.coordDb.db
        .prepare(`UPDATE agents SET worktree_path = ?, branch = ? WHERE id = ?`)
        .run(worktreePath, branch, params.agentId);

      this.coordDb.logEvent(params.agentId, 'worktree_spawned', {
        worktreePath,
        branch,
        hydrationMethod,
        hydratedDirs,
      });
      recordCreatedWorktree(this.coordDb, this.fencing, { agentId: params.agentId, worktreePath, branch, head });
    });

    return {
      agentId: params.agentId,
      worktreePath,
      branch,
      hydrationMethod,
      hydratedDirs,
      durationMs: Date.now() - start,
      provenance: 'created',
      source: 'kith',
      detached: false,
      dirty: false,
      branchCheckedOutElsewhere: false,
      alreadyRegistered: false,
      notes: [],
    };
  }

  private cloneDirectoryCoW(
    srcDir: string,
    destDir: string
  ): 'apfs-cow' | 'reflink-cow' | 'copy' {
    const cowTimeoutMs = Number(process.env.KITH_COW_TIMEOUT_MS) || 60_000;
    if (process.platform === 'darwin') {
      try {
        execFileSync('cp', ['-cR', srcDir, destDir], {
          stdio: 'ignore',
          timeout: cowTimeoutMs,
        });
        return 'apfs-cow';
      } catch {
        // Fallback if volume is not APFS
      }
    } else if (process.platform === 'linux') {
      try {
        execFileSync('cp', ['--reflink=always', '-R', srcDir, destDir], {
          stdio: 'ignore',
          timeout: cowTimeoutMs,
        });
        return 'reflink-cow';
      } catch {
        // Fallback if filesystem does not support reflinks
      }
    }

    // A failed clone can leave a partial destination. Copy into an independent tree.
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.cpSync(srcDir, destDir, { recursive: true, dereference: false });
    return 'copy';
  }

  public removeWorktree(agentId: string, options?: { deleteAdopted?: boolean }): boolean {
    this.fencing.assertSession(agentId);
    const registration = readRegistration(this.coordDb, agentId);
    const agentPath = this.fencing.getAgent(agentId)?.worktree_path ?? null;
    const adopted = registration?.provenance === 'adopted'
      || Boolean(agentPath && !isKithOwnedWorktree(this.coordDb, agentPath));
    if (adopted) {
      if (!options?.deleteAdopted) {
        throw new Error(`Refusing to remove an adopted worktree Kith did not create (${agentPath ?? registration?.worktreePath}). The directory was left in place. Pass --delete-adopted to remove it explicitly, or \`kith worktree forget\` to unregister it.`);
      }
      const target = agentPath ?? registration?.worktreePath;
      if (!target || !fs.existsSync(target)) {
        throw new Error(`Adopted worktree directory is missing (${target ?? 'unknown'}). Nothing was deleted. Use \`kith worktree forget\` to drop the registration.`);
      }
      this.removeCheckout(target, true);
      this.clearAgentWorktree(agentId);
      return true;
    }

    const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const worktreePath = path.join(this.coordDb.coordDir, 'worktrees', safeId);

    if (!fs.existsSync(worktreePath)) return false;
    const registered = agentPath;
    if (!registered || physicalPath(registered) !== physicalPath(worktreePath)
      || this.fencing.listAgents(true).some(agent => agent.id !== agentId && agent.worktree_path && physicalPath(agent.worktree_path) === physicalPath(worktreePath))) {
      throw new Error('Refusing to remove a worktree that is not exclusively registered to this agent.');
    }
    this.removeCheckout(worktreePath, false);
    this.clearAgentWorktree(agentId);
    return true;
  }

  private removeCheckout(worktreePath: string, adopted: boolean): void {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--ignored=matching'], {
      cwd: worktreePath, encoding: 'utf8',
    });
    if (status.trim()) {
      throw new Error(`Refusing to remove dirty worktree: ${worktreePath}. Commit or preserve changed, untracked, and ignored files first.`);
    }
    // The explicit status check also protects ignored files such as .env.
    try {
      execFileSync('git', ['worktree', 'remove', worktreePath], {
        cwd: this.coordDb.repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (!adopted) throw err;
      const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr ?? '') : '';
      throw new Error(`git worktree remove failed; the adopted directory was left in place. ${stderr}`.trim());
    }
  }

  private clearAgentWorktree(agentId: string): void {
    this.coordDb.withTransaction(() => {
      this.fencing.assertSession(agentId);
      clearRegistration(this.coordDb, agentId);
      this.coordDb.db.prepare(`UPDATE agents SET worktree_path = NULL, branch = NULL WHERE id = ?`).run(agentId);
    });
  }

  public listWorktrees(): ListedWorktree[] {
    return listGitWorktrees(this.coordDb.repoRoot);
  }

  public registrationFor(agentId: string): WorktreeRegistration | null {
    return readRegistration(this.coordDb, agentId);
  }

  public listRegistrations(): WorktreeRegistration[] {
    return listStoredRegistrations(this.coordDb);
  }

  public adoptWorktree(params: { agentId: string; path?: string; explicit?: boolean }): WorktreeBinding {
    return adoptLinkedWorktree(this.coordDb, this.fencing, {
      agentId: params.agentId, path: params.path, explicit: params.explicit !== false,
    });
  }

  public adoptIfUnambiguous(params: { agentId: string; cwd: string }): WorktreeBinding | null {
    return adoptLinkedIfUnambiguous(this.coordDb, this.fencing, params);
  }

  public syncRegistration(agentId: string): WorktreeRegistration | null {
    return syncStoredRegistration(this.coordDb, this.fencing, agentId);
  }

  public liveAdoption(agent: { id: string; worktree_path?: string | null; branch?: string | null; status?: string } | null | undefined): LiveAdoption | null {
    return inspectLiveAdoption(this.coordDb, this.fencing, agent as Parameters<typeof inspectLiveAdoption>[2]);
  }

  public forgetWorktree(agentId: string): boolean {
    return forgetLinkedWorktree(this.coordDb, this.fencing, agentId);
  }
}
