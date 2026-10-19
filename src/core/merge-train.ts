import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AstAnalyzer } from './ast-analyzer.js';
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
  constructor(private readonly coordDb: CoordDatabase) {}

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
    const now = Date.now();
    const id = `mrg_${crypto.randomBytes(6).toString('hex')}`;
    const token = this.coordDb.nextFencingToken();

    // 1. If the agent's worktree has uncommitted changes, commit them to its branch first
    if (params.worktreePath && fs.existsSync(params.worktreePath)) {
      const statusOut = execFileSync('git', ['status', '--porcelain'], {
        cwd: params.worktreePath,
        encoding: 'utf8',
      }).trim();
      if (statusOut.length > 0) {
        execFileSync('git', ['add', '-A'], { cwd: params.worktreePath, stdio: 'ignore' });
        execFileSync(
          'git',
          [
            'commit',
            '-m',
            params.commitMessage ?? `feat(${params.agentId}): automated worktree checkpoint`,
          ],
          { cwd: params.worktreePath, stdio: 'ignore' }
        );
      }
    }

    this.coordDb.withTransaction(() => {
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

    const stageDir = path.join(this.coordDb.coordDir, 'worktrees', '_merge_train_stage');
    const autoResolvedFiles: string[] = [];

    try {
      // Clean up any previous staging worktree
      this.cleanupStageWorktree(stageDir);

      // Create detached staging worktree at repoRoot's HEAD
      execFileSync('git', ['worktree', 'add', '--detach', stageDir, 'HEAD'], {
        cwd: this.coordDb.repoRoot,
        stdio: 'ignore',
      });

      // Hydrate node_modules into staging worktree if present
      const rootNodeModules = path.join(this.coordDb.repoRoot, 'node_modules');
      const stageNodeModules = path.join(stageDir, 'node_modules');
      if (fs.existsSync(rootNodeModules) && !fs.existsSync(stageNodeModules)) {
        fs.symlinkSync(rootNodeModules, stageNodeModules, 'dir');
      }

      // 2. Attempt merge of `params.branch` into detached HEAD in `stageDir`
      try {
        execFileSync(
          'git',
          ['merge', '--no-ff', '-m', `Merge branch '${params.branch}' (${params.agentId})`, params.branch],
          {
            cwd: stageDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
      } catch {
        // Check if conflicts can be AST-additively resolved!
        const unmergedOut = execFileSync(
          'git',
          ['diff', '--name-only', '--diff-filter=U'],
          { cwd: stageDir, encoding: 'utf8' }
        ).trim();

        const conflictedFiles = unmergedOut.split(/\r?\n/).filter(Boolean);
        if (conflictedFiles.length === 0) {
          throw new Error(`git merge failed on branch '${params.branch}'.`);
        }

        for (const relFile of conflictedFiles) {
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
          execFileSync('git', ['add', relFile], { cwd: stageDir, stdio: 'ignore' });
          autoResolvedFiles.push(relFile);
        }

        execFileSync(
          'git',
          [
            'commit',
            '-m',
            `Merge branch '${params.branch}' (${params.agentId}) [AST auto-resolved: ${autoResolvedFiles.join(', ')}]`,
          ],
          { cwd: stageDir, stdio: 'ignore' }
        );
      }

      // 3. Run verification command inside the speculative staging tree if specified
      let diagnostics = 'Speculative merge clean.';
      if (params.verificationCmd) {
        try {
          const out = execSync(params.verificationCmd, {
            cwd: stageDir,
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
      const verifiedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: stageDir,
        encoding: 'utf8',
      }).trim();

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
    }
  }

  private readStageBlob(cwd: string, stage: 1 | 2 | 3, relFile: string): string {
    try {
      return execFileSync('git', ['show', `:${stage}:${relFile}`], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  }

  private cleanupStageWorktree(stageDir: string): void {
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
