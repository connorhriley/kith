import { discoverRepository, physicalPath } from './repository.js';
import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AstAnalyzer } from './ast-analyzer.js';
import { FencingAndAgentManager } from './fencing.js';
import { CoordDatabase } from './db.js';

export interface MergeTrainEntry {
  id: string;
  agent_id: string;
  branch: string;
  worktree_path: string | null;
  status: 'queued' | 'testing' | 'merged' | 'failed';
  fencing_token: number;
  verification_cmd: string | null;
  diagnostics_output: string | null;
  created_at: number;
  updated_at: number;
}

export interface SpeculativeMergeResult {
  merged: boolean;
  entry: MergeTrainEntry;
  autoResolvedFiles: string[];
  mergedCommitSha: string | null;
  diagnostics: string;
}

export class SpeculativeMergeTrain {
  constructor(private readonly coordDb: CoordDatabase, private readonly fencing: FencingAndAgentManager) {}

  /**
   * Enqueues and executes a Bors-style speculative integration test in an isolated staging
   * worktree before advancing the main repository branch.
   * Automatically resolves AST-additive conflicts (like disjoint exports or JSON keys)
   * and runs `verificationCmd` (e.g. `tsc --noEmit` or `npm test`) before fast-forwarding `main`.
   */
  public enqueueAndMerge(params: {
    agentId: string;
    branch: string;
    worktreePath?: string | null;
    verificationCmd?: string | null;
    commitMessage?: string;
  }): SpeculativeMergeResult {
    this.fencing.assertSession(params.agentId);
    const sessionEnv = this.fencing.sessionEnvironment(params.agentId);
    const now = Date.now();
    const id = `mrg_${crypto.randomBytes(6).toString('hex')}`;
    const token = this.coordDb.nextFencingToken();

    this.coordDb.withTransaction(() => {
      this.fencing.assertSession(params.agentId);
      this.coordDb.db
        .prepare(`
          INSERT INTO merge_queue (
            id, agent_id, branch, worktree_path, status,
            fencing_token, verification_cmd, diagnostics_output,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 'testing', ?, ?, NULL, ?, ?)
        `)
        .run(
          id,
          params.agentId,
          params.branch,
          params.worktreePath ?? null,
          token,
          params.verificationCmd ?? null,
          now,
          now
        );
    });

    const stageDir = path.join(this.coordDb.coordDir, 'worktrees', `_merge_train_${id}`);
    const autoResolvedFiles: string[] = [];
    const lockPath = path.join(this.coordDb.coordDir, 'merge-train.lock');
    let lockFd: number | undefined;

    try {
      try {
        lockFd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, entryId: id }));
      } catch {
        throw new Error('Merge train is busy. If its owner crashed, inspect .coord/merge-train.lock before removing it.');
      }
      const baseHead = this.gitHead(this.coordDb.repoRoot);
      const targetBranch = this.gitBranch(this.coordDb.repoRoot);
      if (!targetBranch) throw new Error('Merge target must be on a branch, not a detached HEAD.');
      this.requireCleanTarget();
      // Validate ownership and repository/branch identity before staging any source bytes.
      if (params.worktreePath) {
        const registered = this.fencing.getAgent(params.agentId)?.worktree_path;
        if (!registered || physicalPath(registered) !== physicalPath(params.worktreePath)) {
          throw new Error("Source checkout must be the agent's registered worktree.");
        }
        const source = discoverRepository(params.worktreePath);
        if (source.commonGitDir !== this.coordDb.commonGitDir || source.checkoutRoot !== physicalPath(params.worktreePath)
          || this.gitBranch(source.checkoutRoot) !== params.branch.replace(/^refs\/heads\//, '')) {
          throw new Error('Source checkout repository or branch does not match the requested integration.');
        }
      }
      // 1. If the agent's worktree has uncommitted changes, commit them to its branch first
      if (params.worktreePath) {
        const statusOut = execFileSync('git', ['status', '--porcelain'], {
          cwd: params.worktreePath,
          encoding: 'utf8',
        }).trim();
        if (statusOut.length > 0) {
          execFileSync('git', ['add', '-A'], { cwd: params.worktreePath, env: sessionEnv, stdio: 'ignore' });
          execFileSync(
            'git',
            [
              'commit',
              '-m',
              params.commitMessage ?? `feat(${params.agentId}): automated worktree checkpoint`,
            ],
            { cwd: params.worktreePath, env: sessionEnv, stdio: 'ignore' }
          );
        }
      }

      // Freeze the source ref after its checkpoint; never interpret a user ref as merge options.
      const sourceSha = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${params.branch}^{commit}`], {
        cwd: this.coordDb.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      // Clean up any previous staging worktree
      this.cleanupStageWorktree(stageDir);

      // Create detached staging worktree at repoRoot's HEAD
      execFileSync('git', ['worktree', 'add', '--detach', stageDir, baseHead], {
        cwd: this.coordDb.repoRoot,
        stdio: 'ignore',
      });

      // Hydrate node_modules into staging worktree if present
      const rootNodeModules = path.join(this.coordDb.repoRoot, 'node_modules');
      const stageNodeModules = path.join(stageDir, 'node_modules');
      const hydratedNodeModules = fs.existsSync(rootNodeModules) && !fs.existsSync(stageNodeModules);
      if (hydratedNodeModules) {
        fs.symlinkSync(rootNodeModules, stageNodeModules, 'dir');
      }

      // 2. Attempt merge of `params.branch` into detached HEAD in `stageDir`
      try {
        execFileSync(
          'git',
          ['merge', '--no-ff', '-m', `Merge branch '${params.branch}' (${params.agentId})`, sourceSha],
          {
            cwd: stageDir, env: sessionEnv,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
      } catch {
        // Check if conflicts can be AST-additively resolved!
        const unmergedOut = execFileSync(
          'git',
          ['diff', '--name-only', '--diff-filter=U', '-z'],
          { cwd: stageDir, env: sessionEnv, encoding: 'utf8' }
        );

        const conflictedFiles = unmergedOut.split('\0').filter(Boolean);
        if (conflictedFiles.length === 0) {
          throw new Error(`git merge failed on branch '${params.branch}'.`);
        }

        for (const relFile of conflictedFiles) {
          const stages = execFileSync('git', ['--literal-pathspecs', 'ls-files', '--unmerged', '-z', '--', relFile], {
            cwd: stageDir, encoding: 'utf8',
          }).split('\0').filter(Boolean).map(record => /^(\d{6}) [0-9a-f]+ ([123])\t/.exec(record));
          const modes = stages.map(stage => stage?.[1]);
          if (stages.length !== 3 || new Set(stages.map(stage => stage?.[2])).size !== 3
            || !modes.every(mode => mode === modes[0] && (mode === '100644' || mode === '100755'))) {
            throw new Error(`Merge conflict in '${relFile}': missing stages, symlink, or changed file modes require explicit resolution.`);
          }
          const baseContent = this.readStageBlob(stageDir, 1, relFile);
          const oursContent = this.readStageBlob(stageDir, 2, relFile);
          const theirsContent = this.readStageBlob(stageDir, 3, relFile);

          const check = AstAnalyzer.checkAdditiveMergeability(
            relFile,
            baseContent,
            oursContent,
            theirsContent
          );

          if (!check.autoMergeable || !check.mergedContent) {
            throw new Error(
              `Merge conflict in '${relFile}': ${check.reason}. Resolve conflicts in '${params.branch}' before merging.`
            );
          }

          fs.writeFileSync(path.join(stageDir, relFile), check.mergedContent, 'utf8');
          execFileSync('git', ['--literal-pathspecs', 'add', '--', relFile], { cwd: stageDir, env: sessionEnv, stdio: 'ignore' });
          autoResolvedFiles.push(relFile);
        }

        execFileSync(
          'git',
          [
            'commit',
            '-m',
            `Merge branch '${params.branch}' (${params.agentId}) [AST auto-resolved: ${autoResolvedFiles.join(', ')}]`,
          ],
          { cwd: stageDir, env: sessionEnv, stdio: 'ignore' }
        );
      }

      const verifiedSha = this.gitHead(stageDir);

      // 3. Run verification command inside the speculative staging tree if specified
      let diagnostics = 'Speculative merge clean.';
      if (params.verificationCmd) {
        try {
          const out = execSync(params.verificationCmd, {
            cwd: stageDir, env: sessionEnv,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 120_000,
          });
          diagnostics = `Verification passed (${params.verificationCmd}):\n${out.trim()}`.trim();
        } catch (verifyErr: unknown) {
          const stdout = (verifyErr as { stdout?: string })?.stdout ?? '';
          const stderr = (verifyErr as { stderr?: string })?.stderr ?? '';
          const combined = `${stdout}\n${stderr}`.trim();
          throw new Error(
            `Speculative verification failed ('${params.verificationCmd}'):\n${combined}`
          );
        }
      }

      // 4. Advance the main repository to the verified speculative commit
      const stageChanges = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=normal'], {
        cwd: stageDir, encoding: 'utf8',
      }).split('\0').filter(Boolean);
      const unchangedHydration = hydratedNodeModules && fs.lstatSync(stageNodeModules, { throwIfNoEntry: false })?.isSymbolicLink()
        && fs.readlinkSync(stageNodeModules) === rootNodeModules;
      if (this.gitHead(stageDir) !== verifiedSha || stageChanges.some(change => !(unchangedHydration && change === '?? node_modules'))) {
        throw new Error('Verification changed the staging checkout. Apply fixes in the source worktree and retry with a read-only check.');
      }

      if (this.gitHead(this.coordDb.repoRoot) !== baseHead ||
          this.gitBranch(this.coordDb.repoRoot) !== targetBranch) {
        throw new Error('Merge target changed during verification. Retry against the new target.');
      }
      this.fencing.assertSession(params.agentId);
      this.requireCleanTarget();
      execFileSync('git', ['merge', '--ff-only', verifiedSha], {
        cwd: this.coordDb.repoRoot,
        stdio: 'ignore',
      });

      this.cleanupStageWorktree(stageDir);

      const updatedAt = Date.now();
      this.coordDb.withTransaction(() => {
        this.coordDb.db
          .prepare(`
            UPDATE merge_queue
            SET status = 'merged', diagnostics_output = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(diagnostics, updatedAt, id);

        this.coordDb.logEvent(params.agentId, 'merge_train_succeeded', {
          id,
          branch: params.branch,
          verifiedSha,
          autoResolvedFiles,
        });
      });

      return {
        merged: true,
        entry: this.getEntry(id)!,
        autoResolvedFiles,
        mergedCommitSha: verifiedSha,
        diagnostics,
      };
    } catch (err: unknown) {
      this.cleanupStageWorktree(stageDir);
      const diagnostics = err instanceof Error ? err.message : String(err);
      const updatedAt = Date.now();

      this.coordDb.withTransaction(() => {
        this.coordDb.db
          .prepare(`
            UPDATE merge_queue
            SET status = 'failed', diagnostics_output = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(diagnostics, updatedAt, id);

        this.coordDb.logEvent(params.agentId, 'merge_train_failed', {
          id,
          branch: params.branch,
          diagnostics,
        });
      });

      return {
        merged: false,
        entry: this.getEntry(id)!,
        autoResolvedFiles,
        mergedCommitSha: null,
        diagnostics,
      };
    } finally {
      if (lockFd !== undefined) {
        fs.closeSync(lockFd);
        fs.unlinkSync(lockPath);
      }
    }
  }

  private gitHead(cwd: string): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  }

  private gitBranch(cwd: string): string {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  }

  private requireCleanTarget(): void {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: this.coordDb.repoRoot, encoding: 'utf8',
    });
    if (status.split(/\r?\n/).some((line) => line && line !== '?? .coord/')) {
      throw new Error('Merge target has local changes. Commit or preserve them before integrating.');
    }
  }

  private readStageBlob(cwd: string, stage: 1 | 2 | 3, relFile: string): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(execFileSync('git', ['show', `:${stage}:${relFile}`], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  }

  private cleanupStageWorktree(stageDir: string): void {
    if (!fs.existsSync(stageDir)) return;
    try {
      execFileSync('git', ['worktree', 'remove', '--force', stageDir], {
        cwd: this.coordDb.repoRoot,
        stdio: 'ignore',
      });
    } catch {
      if (fs.existsSync(stageDir)) {
        fs.rmSync(stageDir, { recursive: true, force: true });
      }
      try {
        execFileSync('git', ['worktree', 'prune'], {
          cwd: this.coordDb.repoRoot,
          stdio: 'ignore',
        });
      } catch {
        // Ignore
      }
    }
  }

  public getEntry(id: string): MergeTrainEntry | null {
    const row = this.coordDb.db
      .prepare(`SELECT * FROM merge_queue WHERE id = ?`)
      .get(id) as MergeTrainEntry | undefined;
    return row ?? null;
  }

  public listQueue(): MergeTrainEntry[] {
    return this.coordDb.db
      .prepare(`SELECT * FROM merge_queue ORDER BY created_at DESC`)
      .all() as unknown as MergeTrainEntry[];
  }
}
