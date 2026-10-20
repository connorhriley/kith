import crypto from 'node:crypto';
import { physicalPath } from './repository.js';
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

const GIT_PREFIX = String.raw`\bgit(?:\s+(?:-C|-c|--git-dir|--work-tree)(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)|\s+--(?:no-pager|literal-pathspecs|no-optional-locks))*\s+`;
const DESTRUCTIVE_SHARED_TREE = new RegExp(GIT_PREFIX + String.raw`(?:reset|clean|checkout|restore|switch|stash|merge|rebase|pull|cherry-pick|revert|am)\b`);
const DESTRUCTIVE_SHARED_REFS = new RegExp(GIT_PREFIX + String.raw`(?:update-ref|symbolic-ref|worktree\s+(?:remove|prune)|branch\s+(?:-[dDmMfF]|--(?:delete|move|force)))\b`);

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
    this.fencing.assertSession(params.agentId);
    const root = physicalPath(this.fencing.getAgent(params.agentId)?.worktree_path ?? this.coordDb.repoRoot);
    const peers = this.fencing.listAgents(true).filter(a => a.id !== params.agentId);
    const sharesCheckout = peers.some(a => physicalPath(a.worktree_path ?? this.coordDb.repoRoot) === root);
    if (peers.length && DESTRUCTIVE_SHARED_REFS.test(params.command) || sharesCheckout && DESTRUCTIVE_SHARED_TREE.test(params.command)) {
      return { safe: false, reason: 'Git operation can replace shared work or refs while peer agents are active. Coordinate the operation before retrying.' };
    }

    return { safe: true };
  }

  private getSnapshotFilePath(agentId: string): string {
    const epoch = this.fencing.assertSession(agentId);
    const safeId = crypto.createHash('sha256').update(`${agentId}:${epoch}`).digest('hex');
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
      { encoding: 'utf8', mode: 0o600 }
    );
    return snapPath;
  }

  /**
   * Compares workspace state after a Bash command completes against the pre-Bash Merkle snapshot.
   * Saves recovery copies of edits to files locked by sibling agents. Restoration is opt-in,
   * and indexes authorized modifications into the AST Contract Blackboard & Dirty-Tree Conflict Radar.
   */
  public verifyPostBashAndQuarantine(params: {
    agentId: string;
    command: string;
    rootDir?: string;
    restoreLockedFiles?: boolean;
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
          restoreLockedFiles: params.restoreLockedFiles ?? false,
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
            restoreLockedFiles: params.restoreLockedFiles ?? false,
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
          this.depGraph.recordFileModification(params.agentId, relFile, fs.readFileSync(absFile, 'utf8'));
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
    restoreLockedFiles: boolean;
    prevEntry: FileSnapshotEntry | null;
    reason: string;
  }): QuarantineRecord {
    const id = `quar_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();
    const safeName = params.relPath.replace(/[^a-zA-Z0-9._-]/g, '_');
    const patchPath = path.join(
      this.coordDb.coordDir,
      'quarantine',
      `${id}_${safeName}.quarantine`
    );

    if (params.unauthorizedBuf) {
      fs.writeFileSync(patchPath, params.unauthorizedBuf, { mode: 0o600 });
    } else {
      fs.writeFileSync(patchPath, `[DELETED BY COMMAND: ${params.command}]\n`, { encoding: 'utf8', mode: 0o600 });
    }

    if (params.prevEntry?.backupContentBase64 !== undefined) {
      fs.writeFileSync(patchPath + '.before', Buffer.from(params.prevEntry.backupContentBase64, 'base64'), { mode: 0o600 });
    }
    const absTarget = path.join(params.rootDir, params.relPath);
    if (params.restoreLockedFiles && params.prevEntry === null) {
      // Newly created unauthorized file -> remove it
      if (fs.existsSync(absTarget)) {
        fs.unlinkSync(absTarget);
      }
    } else if (params.restoreLockedFiles && params.prevEntry?.backupContentBase64 !== undefined) {
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
