import crypto from 'node:crypto';
import { physicalPath } from './repository.js';
import fs from 'node:fs';
import path from 'node:path';
import { CoordDatabase } from './db.js';
import { DependencyAndContractEngine } from './dep-graph.js';
import { FencingAndAgentManager } from './fencing.js';
import { ignoredPaths, walkNonIgnoredFiles } from './git-ignore.js';
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

const WRITE_PRIMITIVE_RE = /(?:>>?|\b(?:tee|rm|mv|cp|dd|patch|truncate|touch|unlink|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\b|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\.write_(?:text|bytes)\(|open\([^)]*['"][wa+])/u;
const READ_ONLY_CMD_RE = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)*(?:ls|tail|head|cat|less|more|grep|egrep|fgrep|rg|find|fd|wc|stat|file|du|df|pwd|echo|printf|true|false|which|whereis|type|uname|whoami|id|date|env|printenv|ps|lsof|jq|awk|cut|sort|uniq|tr|diff|shasum|sha256sum|md5|git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|check-ignore| blame)\b|kith\s+(?:status|brief|doctor|mode|lock\s+list|task\s+list|handoff\s+list)\b|(?:node\s+)?(?:\S*\/)?stack\.mjs\s+status\b)/u;

/**
 * True when a shell command is purely observational (e.g. `ls`, `tail`, `git status`, `stack.mjs status`)
 * and contains no file-redirection or write primitives.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const stripped = command
    .replace(/\b\d*>&\d+\b/g, '')
    .replace(/\b\d*>\s*\/dev\/null\b/g, '')
    .trim();
  if (!stripped) return true;
  if (WRITE_PRIMITIVE_RE.test(stripped)) return false;
  const segments = stripped.split(/(?:&&|\|\||[;|&\n])+/u).map(s => s.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(seg => READ_ONLY_CMD_RE.test(seg));
}

/**
 * True when `command` explicitly references `relPath` (or its filename) and contains a write/mutation
 * indicator. Prevents blaming unrelated or read-only commands for concurrent edits made by the live
 * lock holder in a shared checkout.
 */
export function commandTargetsFileForWrite(command: string, relPath: string): boolean {
  if (isReadOnlyShellCommand(command)) return false;
  const stripped = command
    .replace(/\b\d*>&\d+\b/g, '')
    .replace(/\b\d*>\s*\/dev\/null\b/g, '');
  if (!WRITE_PRIMITIVE_RE.test(stripped)) return false;
  const norm = relPath.replace(/\\/g, '/');
  if (stripped.includes(norm)) return true;
  const base = path.posix.basename(norm);
  return base.length >= 4 && stripped.includes(base);
}

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
      return {
        safe: false,
        reason: 'Git operation can replace shared work or refs while peer agents are active. To commit only your own files safely while peers are active, run: kith commit -m "<message>" [files...]',
      };
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

    const snapPath = this.getSnapshotFilePath(agentId);
    let prevEntries: Record<string, FileSnapshotEntry> = {};
    if (fs.existsSync(snapPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as { rootDir?: string; entries?: Record<string, FileSnapshotEntry> };
        if (parsed.rootDir === rootDir && parsed.entries) prevEntries = parsed.entries;
      } catch { /* Ignore damaged prior snapshot cache */ }
    }

    const now = Date.now();
    const entries: Record<string, FileSnapshotEntry> = {};
    const files = this.walkWorkspaceFiles(rootDir);

    for (const absPath of files) {
      const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/');
      const stat = fs.statSync(absPath);
      if (stat.size > 5 * 1024 * 1024) continue; // Skip >5MB binaries

      const lockedByOther = activeLocks.some((l) =>
        LockEngine.patternsOverlap(relPath, l.pattern)
      );
      const cached = prevEntries[relPath];
      const unchanged = cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && stat.mtimeMs < now - 2000;
      if (unchanged && (!lockedByOther || cached.backupContentBase64 !== undefined)) {
        entries[relPath] = {
          ...cached,
          lockedByOther,
          backupContentBase64: lockedByOther ? cached.backupContentBase64 : undefined,
        };
        continue;
      }

      const buf = fs.readFileSync(absPath);
      const sha256 = unchanged ? cached.sha256 : crypto.createHash('sha256').update(buf).digest('hex');

      entries[relPath] = {
        relPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sha256,
        lockedByOther,
        backupContentBase64: lockedByOther ? buf.toString('base64') : undefined,
      };
    }

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
    const candidates: Array<{ relPath: string; buf: Buffer | null; prev: FileSnapshotEntry | null }> = [];
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

      candidates.push({ relPath, buf, prev: prev ?? null });
    }

    // Also check if any previously existing file was deleted by the bash command
    for (const [relPath, prev] of Object.entries(beforeEntries)) {
      if (!seenCurrentRelPaths.has(relPath)) {
        candidates.push({ relPath, buf: null, prev });
      }
    }

    const ignored = candidates.length
      ? ignoredPaths(rootDir, candidates.map((c) => c.relPath))
      : new Set<string>();
    const physRoot = physicalPath(rootDir);
    const livePeersInCheckout = new Set(
      this.fencing
        .listAgents(true)
        .filter((a) => a.id !== params.agentId && physicalPath(a.worktree_path ?? this.coordDb.repoRoot) === physRoot)
        .map((a) => a.id)
    );
    const myLocks = this.lockEngine.listLocks().filter((l) => l.owner_agent_id === params.agentId);
    const readOnlyCmd = isReadOnlyShellCommand(params.command);

    for (const c of candidates) {
      if (ignored.has(c.relPath)) continue;
      const access = this.lockEngine.checkFileWriteAccess({
        agentId: params.agentId,
        filePath: c.relPath,
      });
      if (!access.allowed) {
        const holderId = access.conflictingLock?.owner_agent_id;
        if (!params.restoreLockedFiles) {
          // When another live agent holds the lock in the same shared checkout, concurrent edits on disk
          // belong to that lock holder unless this command itself explicitly targeted the file for writing.
          if (readOnlyCmd || (holderId && livePeersInCheckout.has(holderId) && !commandTargetsFileForWrite(params.command, c.relPath))) {
            continue;
          }
        }
        const defaultReason = c.buf === null ? 'Deleted file locked by another agent' : 'Locked by another agent';
        quarantinedViolations.push(this.quarantineAndRevertFile({
          agentId: params.agentId,
          command: params.command,
          rootDir,
          relPath: c.relPath,
          unauthorizedBuf: c.buf,
          restoreLockedFiles: params.restoreLockedFiles ?? false,
          prevEntry: c.prev,
          reason: access.reason ?? defaultReason,
        }));
      } else {
        if (readOnlyCmd) continue;
        if (livePeersInCheckout.size > 0 && myLocks.length > 0) {
          const claimedByCaller = myLocks.some((l) => l.pattern !== '**' && LockEngine.patternsOverlap(LockEngine.literalScope(c.relPath), l.pattern));
          if (!claimedByCaller && !commandTargetsFileForWrite(params.command, c.relPath)) {
            continue;
          }
        }
        authorizedModifiedFiles.push(c.relPath);
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

  private static readonly SKIP_DIRS = new Set([
    '.git', '.coord', 'node_modules', 'dist', 'build', 'out', 'coverage',
    '.next', '.turbo', '.venv', 'venv', '.pytest_cache', '__pycache__', 'target',
  ]);

  private walkWorkspaceFiles(rootDir: string): string[] {
    return walkNonIgnoredFiles({ rootDir, skipDirNames: BashMerkleGuard.SKIP_DIRS });
  }

  public listQuarantined(): QuarantineRecord[] {
    return this.coordDb.db
      .prepare(`SELECT * FROM quarantine ORDER BY created_at DESC`)
      .all() as unknown as QuarantineRecord[];
  }
}
