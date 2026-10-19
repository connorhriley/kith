import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CoordDatabase } from './db.js';
import { DependencyAndContractEngine } from './dep-graph.js';
import { FencingAndAgentManager } from './fencing.js';
import { LockEngine } from './locks.js';
import { ShadowGitEngine } from './shadow-git.js';

export interface FileSnapshotEntry {
  relPath: string;
  mtimeMs: number;
  size: number;
  sha256: string;
  lockedByOther: boolean;
  backupContentBase64?: string;
}

export interface QuarantineRecord {
  id: string;
  agent_id: string;
  command: string;
  file_path: string;
  patch_path: string;
  reason: string;
  created_at: number;
}

export interface BashGuardPostReport {
  allowed: boolean;
  authorizedModifiedFiles: string[];
  quarantinedViolations: QuarantineRecord[];
}

const DESTRUCTIVE_SHARED_TREE_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /\bgit\s+reset\s+--hard\b/,
    reason: 'Blocked destructive `git reset --hard` in shared workspace while parallel agents are active.',
  },
  {
    regex: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    reason: 'Blocked destructive `git clean -f` in shared workspace while parallel agents are active.',
  },
  {
    regex: /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/,
    reason: 'Blocked whole-tree `git checkout/restore .` in shared workspace while parallel agents are active.',
  },
];

export class BashMerkleGuard {
  constructor(
    private readonly coordDb: CoordDatabase,
    private readonly fencing: FencingAndAgentManager,
    private readonly lockEngine: LockEngine,
    private readonly depGraph: DependencyAndContractEngine,
    private readonly shadowGit: ShadowGitEngine
  ) {}

  /**
   * Checks whether a shell command is safe to execute in the workspace.
   */
  public checkCommandSafety(params: {
    agentId: string;
    command: string;
    inIsolatedWorktree?: boolean;
  }): { safe: boolean; reason?: string } {
    if (params.inIsolatedWorktree) {
      return { safe: true };
    }

    const otherActiveAgents = this.fencing
      .listAgents(true)
      .filter((a) => a.id !== params.agentId && !a.worktree_path);

    if (otherActiveAgents.length > 0) {
      for (const rule of DESTRUCTIVE_SHARED_TREE_PATTERNS) {
        if (rule.regex.test(params.command)) {
          this.coordDb.logEvent(params.agentId, 'bash_destructive_command_blocked', {
            command: params.command,
            reason: rule.reason,
          });
          return { safe: false, reason: rule.reason };
        }
      }
    }

    return { safe: true };
  }

  private getSnapshotFilePath(agentId: string): string {
    const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.coordDb.coordDir, 'snapshots', `${safeId}.json`);
  }

  /**
   * Captures a Merkle snapshot of workspace files before a Bash tool execution.
   * For any file locked by another active agent, stores a full lossless backup so
   * unauthorized mutations by bash scripts (`sed`, `python`, etc.) can be reverted atomically.
   */
  public capturePreBashSnapshot(agentId: string, rootDir = this.coordDb.repoRoot): string {
    const activeLocks = this.lockEngine
      .listLocks()
      .filter((l) => l.owner_agent_id !== agentId);

    const entries: Record<string, FileSnapshotEntry> = {};
    const files = this.walkWorkspaceFiles(rootDir);

    for (const absPath of files) {
      const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/');
      const stat = fs.statSync(absPath);
      if (stat.size > 5 * 1024 * 1024) continue; // Skip >5MB binaries

      const buf = fs.readFileSync(absPath);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const lockedByOther = activeLocks.some((l) =>
        LockEngine.patternsOverlap(relPath, l.pattern)
      );

      entries[relPath] = {
        relPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sha256,
        lockedByOther,
        backupContentBase64: lockedByOther ? buf.toString('base64') : undefined,
      };
    }

    const snapPath = this.getSnapshotFilePath(agentId);
    fs.writeFileSync(
      snapPath,
      JSON.stringify({ timestamp: Date.now(), rootDir, entries }),
      'utf8'
    );
    return snapPath;
  }

  /**
   * Compares workspace state after a Bash command completes against the pre-Bash Merkle snapshot.
   * Automatically reverts and quarantines any edits to files locked by sibling agents,
   * and indexes authorized modifications into the AST Contract Blackboard & Dirty-Tree Conflict Radar.
   */
  public verifyPostBashAndQuarantine(params: {
    agentId: string;
    command: string;
    rootDir?: string;
  }): BashGuardPostReport {
    const snapPath = this.getSnapshotFilePath(params.agentId);
    if (!fs.existsSync(snapPath)) {
      return { allowed: true, authorizedModifiedFiles: [], quarantinedViolations: [] };
    }

    const rawSnap = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as {
      timestamp: number;
      rootDir: string;
      entries: Record<string, FileSnapshotEntry>;
    };
    const rootDir = params.rootDir ?? rawSnap.rootDir ?? this.coordDb.repoRoot;
    const beforeEntries = rawSnap.entries;

    const currentFiles = this.walkWorkspaceFiles(rootDir);
    const seenCurrentRelPaths = new Set<string>();
    const authorizedModifiedFiles: string[] = [];
    const quarantinedViolations: QuarantineRecord[] = [];

    for (const absPath of currentFiles) {
      const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/');
      seenCurrentRelPaths.add(relPath);
      const stat = fs.statSync(absPath);
      if (stat.size > 5 * 1024 * 1024) continue;

      const prev = beforeEntries[relPath];
      if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
        continue;
      }

      const buf = fs.readFileSync(absPath);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      if (prev && prev.sha256 === sha256) {
        continue;
      }

      // File was created or modified during the bash command!
      const access = this.lockEngine.checkFileWriteAccess({
        agentId: params.agentId,
        filePath: relPath,
      });

      if (!access.allowed) {
        const violation = this.quarantineAndRevertFile({
          agentId: params.agentId,
          command: params.command,
          rootDir,
          relPath,
          unauthorizedBuf: buf,
          prevEntry: prev ?? null,
          reason: access.reason ?? 'Locked by another agent',
        });
        quarantinedViolations.push(violation);
      } else {
        authorizedModifiedFiles.push(relPath);
      }
    }

    // Also check if any previously existing file was deleted by the bash command
    for (const [relPath, prev] of Object.entries(beforeEntries)) {
      if (!seenCurrentRelPaths.has(relPath)) {
        const access = this.lockEngine.checkFileWriteAccess({
          agentId: params.agentId,
          filePath: relPath,
        });
        if (!access.allowed) {
          const violation = this.quarantineAndRevertFile({
            agentId: params.agentId,
            command: params.command,
            rootDir,
            relPath,
            unauthorizedBuf: null,
            prevEntry: prev,
            reason: access.reason ?? 'Deleted file locked by another agent',
          });
          quarantinedViolations.push(violation);
        } else {
          authorizedModifiedFiles.push(relPath);
        }
      }
    }

    // Clean up snapshot file
    try {
      fs.unlinkSync(snapPath);
    } catch {
      // Ignore
    }

    // Update AST contracts and shadow git tree for authorized modifications
    if (authorizedModifiedFiles.length > 0) {
      for (const relFile of authorizedModifiedFiles) {
        const absFile = path.join(rootDir, relFile);
        if (fs.existsSync(absFile) && /\.(ts|tsx|js|jsx|mjs|py)$/.test(relFile)) {
          this.depGraph.recordFileModification(params.agentId, relFile);
        }
      }
      this.shadowGit.probeAllActiveConflicts(
        params.agentId,
        authorizedModifiedFiles.map((f) => ({ filePath: f })),
        rootDir
      );
    }

    return {
      allowed: quarantinedViolations.length === 0,
      authorizedModifiedFiles,
      quarantinedViolations,
    };
  }

  private quarantineAndRevertFile(params: {
    agentId: string;
    command: string;
    rootDir: string;
    relPath: string;
    unauthorizedBuf: Buffer | null;
    prevEntry: FileSnapshotEntry | null;
    reason: string;
  }): QuarantineRecord {
    const id = `quar_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();
    const safeName = params.relPath.replace(/[^a-zA-Z0-9._-]/g, '_');
    const patchPath = path.join(
      this.coordDb.coordDir,
      'quarantine',
      `${now}_${params.agentId}_${safeName}.quarantine`
    );

    if (params.unauthorizedBuf) {
      fs.writeFileSync(patchPath, params.unauthorizedBuf);
    } else {
      fs.writeFileSync(patchPath, `[DELETED BY COMMAND: ${params.command}]\n`, 'utf8');
    }

    const absTarget = path.join(params.rootDir, params.relPath);
    if (params.prevEntry === null) {
      // Newly created unauthorized file -> remove it
      if (fs.existsSync(absTarget)) {
        fs.unlinkSync(absTarget);
      }
    } else if (params.prevEntry.backupContentBase64 !== undefined) {
      // Restore exact pre-command bytes
      fs.mkdirSync(path.dirname(absTarget), { recursive: true });
      fs.writeFileSync(
        absTarget,
        Buffer.from(params.prevEntry.backupContentBase64, 'base64')
      );
    }

    const record: QuarantineRecord = {
      id,
      agent_id: params.agentId,
      command: params.command,
      file_path: params.relPath,
      patch_path: patchPath,
      reason: params.reason,
      created_at: now,
    };

    this.coordDb.withTransaction(() => {
      this.coordDb.db
        .prepare(`
          INSERT INTO quarantine (id, agent_id, command, file_path, patch_path, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          record.id,
          record.agent_id,
          record.command,
          record.file_path,
          record.patch_path,
          record.reason,
          record.created_at
        );

      this.coordDb.logEvent(params.agentId, 'bash_mutation_quarantined', {
        filePath: params.relPath,
        command: params.command,
        patchPath,
        reason: params.reason,
      });
    });

    return record;
  }

  private walkWorkspaceFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === '.git' ||
        entry.name === '.coord' ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'coverage' ||
        entry.name === '.next' ||
        entry.name === 'target'
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkWorkspaceFiles(fullPath, acc);
      } else if (entry.isFile()) {
        acc.push(fullPath);
      }
    }
    return acc;
  }

  public listQuarantined(): QuarantineRecord[] {
    return this.coordDb.db
      .prepare(`SELECT * FROM quarantine ORDER BY created_at DESC`)
      .all() as unknown as QuarantineRecord[];
  }
}
