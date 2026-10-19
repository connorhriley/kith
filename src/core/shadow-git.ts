import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AstAnalyzer } from './ast-analyzer.js';
import { CoordDatabase } from './db.js';
import { FencingAndAgentManager } from './fencing.js';
import { LockEngine } from './locks.js';

export interface ConflictRecord {
  id: string;
  agent_a: string;
  agent_b: string;
  file_path: string;
  severity:
    | 'text_conflict'
    | 'ast_conflict'
    | 'transitive_contract_break'
    | 'auto_mergeable';
  details: {
    reason: string;
    baseBlob?: string;
    blobA?: string;
    blobB?: string;
    autoMergedPreview?: string;
  };
  detected_at: number;
}

export interface DirtyMergeProbeResult {
  clean: boolean;
  mergedTreeSha: string | null;
  conflicts: ConflictRecord[];
  autoMergeableFiles: string[];
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
    return path.join(this.coordDb.coordDir, 'shadow-index', `${safeId}.index`);
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
      for (const mod of params.modifiedFiles) {
        const relPath = LockEngine.normalizePattern(targetDir, mod.filePath);
        const absPath = path.join(targetDir, relPath);
        const content =
          mod.content ??
          (fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : null);

        if (content === null) {
          // File was deleted
          try {
            execFileSync('git', [' update-index', '--force-remove', relPath], {
              cwd: targetDir,
              env,
              stdio: 'ignore',
            });
          } catch {
            // Ignore if not in index
          }
        } else {
          const blobSha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: targetDir,
            input: content,
            encoding: 'utf8',
          }).trim();

          execFileSync(
            'git',
            ['update-index', '--add', '--cacheinfo', `100644,${blobSha},${relPath}`],
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

    this.coordDb.db
      .prepare(`UPDATE agents SET shadow_tree_sha = ? WHERE id = ?`)
      .run(shadowCommitSha, params.agentId);

    return shadowCommitSha;
  }

  /**
   * Runs `git merge-tree --write-tree` across `agentId`'s dirty shadow commit and every
   * other active agent's dirty shadow commit (or branch), filtering false positives with AST analysis.
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
      return { clean: true, mergedTreeSha: null, conflicts: [], autoMergeableFiles: [] };
    }

    const activeAgents = this.fencing
      .listAgents(true)
      .filter((a) => a.id !== agentId && a.shadow_tree_sha);

    const allConflicts: ConflictRecord[] = [];
    const autoMergeableFiles: string[] = [];
    let lastMergedTreeSha: string | null = null;

    // Clear outdated text/ast conflicts for this agent before re-probing
    this.coordDb.db
      .prepare(
        `DELETE FROM conflicts WHERE (agent_a = ? OR agent_b = ?) AND severity IN ('text_conflict', 'ast_conflict', 'auto_mergeable')`
      )
      .run(agentId, agentId);

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
      for (const c of res.conflicts) {
        if (c.severity === 'auto_mergeable') {
          autoMergeableFiles.push(c.file_path);
        } else {
          allConflicts.push(c);
        }
      }
    }

    return {
      clean: allConflicts.length === 0,
      mergedTreeSha: lastMergedTreeSha,
      conflicts: allConflicts,
      autoMergeableFiles,
    };
  }

  public probePairConflict(
    agentA: string,
    commitA: string,
    agentB: string,
    commitB: string
  ): DirtyMergeProbeResult {
    try {
      const stdout = execFileSync(
        'git',
        ['merge-tree', '--write-tree', commitA, commitB],
        {
          cwd: this.coordDb.repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ).trim();

      const mergedTreeSha = stdout.split(/\r?\n/)[0]?.trim() ?? null;
      return {
        clean: true,
        mergedTreeSha,
        conflicts: [],
        autoMergeableFiles: [],
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

      for (const line of stdout.split(/\r?\n/)) {
        // Format: 100644 <blob-sha> <stage>\t<file-path>
        const m = line.match(/^\d+\s+([0-9a-f]{40})\s+([123])\t(.+)$/);
        if (m) {
          const [, blobSha, stage, filePath] = m;
          const entry = stageBlobsByFile.get(filePath) ?? {};
          if (stage === '1') entry.stage1 = blobSha;
          if (stage === '2') entry.stage2 = blobSha;
          if (stage === '3') entry.stage3 = blobSha;
          stageBlobsByFile.set(filePath, entry);
        }
      }

      const conflicts: ConflictRecord[] = [];
      const autoMergeableFiles: string[] = [];
      const now = Date.now();

      for (const [filePath, stages] of stageBlobsByFile.entries()) {
        const baseContent = stages.stage1 ? this.readGitBlob(stages.stage1) : '';
        const contentA = stages.stage2 ? this.readGitBlob(stages.stage2) : '';
        const contentB = stages.stage3 ? this.readGitBlob(stages.stage3) : '';

        const additiveCheck = AstAnalyzer.checkAdditiveMergeability(
          filePath,
          baseContent,
          contentA,
          contentB
        );

        const severity: ConflictRecord['severity'] = additiveCheck.autoMergeable
          ? 'auto_mergeable'
          : /\.(ts|tsx|js|jsx|py)$/.test(filePath)
            ? 'ast_conflict'
            : 'text_conflict';

        if (additiveCheck.autoMergeable) {
          autoMergeableFiles.push(filePath);
        }

        const record: ConflictRecord = {
          id: `conf_${crypto.randomBytes(6).toString('hex')}`,
          agent_a: agentA,
          agent_b: agentB,
          file_path: filePath,
          severity,
          details: {
            reason: additiveCheck.reason,
            baseBlob: stages.stage1,
            blobA: stages.stage2,
            blobB: stages.stage3,
            autoMergedPreview: additiveCheck.mergedContent,
          },
          detected_at: now,
        };

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

        conflicts.push(record);
      }

      if (conflicts.some((c) => c.severity !== 'auto_mergeable')) {
        this.coordDb.logEvent(agentA, 'dirty_merge_conflict', {
          peerAgent: agentB,
          files: conflicts
            .filter((c) => c.severity !== 'auto_mergeable')
            .map((c) => c.file_path),
        });
      }

      return {
        clean: conflicts.every((c) => c.severity === 'auto_mergeable'),
        mergedTreeSha: null,
        conflicts,
        autoMergeableFiles,
      };
    }
  }

  private readGitBlob(blobSha: string): string {
    try {
      return execFileSync('git', ['cat-file', '-p', blobSha], {
        cwd: this.coordDb.repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  }

  public listConflicts(): ConflictRecord[] {
    this.fencing.reapDeadAgents();
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
