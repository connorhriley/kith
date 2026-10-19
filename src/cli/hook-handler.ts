import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { KithEngine } from '../core/engine.js';

export interface HookInputPayload {
  session_id?: string;
  agent_id?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    path?: string;
    target_file?: string;
    command?: string;
    content?: string;
    new_string?: string;
  };
}

export class HookHandler {
  constructor(private readonly engine: KithEngine) {}

  public static resolveAgentId(payload?: HookInputPayload, explicitAgentId?: string): string {
    return (
      explicitAgentId ??
      process.env.KITH_AGENT_ID ??
      payload?.agent_id ??
      payload?.session_id ??
      `pid-${process.ppid || process.pid}`
    );
  }

  /**
   * Handles `PreToolUse` enforcement for file edits (`Edit`, `Write`, `MultiEdit`) and `Bash`.
   * Returns `{ allowed: false, exitCode: 2, message }` when a lock or safety rule is violated.
   */
  public handlePreToolUse(params: {
    agentId: string;
    toolName: string;
    filePath?: string;
    command?: string;
  }): { allowed: boolean; exitCode: number; message: string } {
    this.engine.fencing.registerAgent({
      id: params.agentId,
      client: 'hook',
    });

    const tool = params.toolName.toLowerCase();

    // 1. Pre-Edit / Pre-Write File Lock Enforcement
    if (
      params.filePath &&
      (tool.includes('edit') || tool.includes('write') || tool.includes('replace'))
    ) {
      const check = this.engine.locks.checkFileWriteAccess({
        agentId: params.agentId,
        filePath: params.filePath,
      });

      if (!check.allowed) {
        return {
          allowed: false,
          exitCode: 2,
          message: `[KITH LOCK GUARD] Blocked write to '${params.filePath}'. ${check.reason}`,
        };
      }

      // Auto-acquire an advisory/exclusive file lock if the file was unlocked so sibling agents see it immediately
      this.engine.locks.acquireLocks({
        agentId: params.agentId,
        patterns: [params.filePath],
        lockType: 'file',
        reason: `Auto-locked on ${params.toolName}`,
      });

      return { allowed: true, exitCode: 0, message: '' };
    }

    // 2. Pre-Bash Destructive Command Firewall + Merkle Snapshot Capture
    if (tool === 'bash' || tool === 'run_command' || params.command) {
      const cmd = params.command ?? '';
      const agent = this.engine.fencing.getAgent(params.agentId);
      const safety = this.engine.bashGuard.checkCommandSafety({
        agentId: params.agentId,
        command: cmd,
        inIsolatedWorktree: Boolean(agent?.worktree_path),
      });

      if (!safety.safe) {
        return {
          allowed: false,
          exitCode: 2,
          message: `[KITH BASH FIREWALL] ${safety.reason}`,
        };
      }

      this.engine.bashGuard.capturePreBashSnapshot(
        params.agentId,
        agent?.worktree_path ?? this.engine.coordDb.repoRoot
      );
      return { allowed: true, exitCode: 0, message: '' };
    }

    return { allowed: true, exitCode: 0, message: '' };
  }

  /**
   * Handles `PostToolUse` verification:
   * - For file edits: AST export/import extraction, transitive blast radius, FTS5 duplicate symbol check, and live dirty-tree `git merge-tree`.
   * - For Bash commands: Merkle snapshot diff, automatic revert + quarantine of unauthorized mutations to files locked by sibling agents.
   */
  public handlePostToolUse(params: {
    agentId: string;
    toolName: string;
    filePath?: string;
    command?: string;
  }): { allowed: boolean; exitCode: number; warnings: string[]; deltaFooter: string } {
    const tool = params.toolName.toLowerCase();
    const warnings: string[] = [];

    if (
      params.filePath &&
      (tool.includes('edit') || tool.includes('write') || tool.includes('replace'))
    ) {
      const agent = this.engine.fencing.getAgent(params.agentId);
      const postRes = this.engine.processPostFileEdit({
        agentId: params.agentId,
        filePath: params.filePath,
        worktreeDir: agent?.worktree_path ?? undefined,
      });
      warnings.push(...postRes.warnings);
    } else if (tool === 'bash' || tool === 'run_command' || params.command) {
      const agent = this.engine.fencing.getAgent(params.agentId);
      const report = this.engine.bashGuard.verifyPostBashAndQuarantine({
        agentId: params.agentId,
        command: params.command ?? 'bash',
        rootDir: agent?.worktree_path ?? this.engine.coordDb.repoRoot,
      });

      if (!report.allowed) {
        for (const v of report.quarantinedViolations) {
          warnings.push(
            `[KITH BASH QUARANTINE] Reverted unauthorized edit to '${v.file_path}' caused by command '${v.command}'. ${v.reason}. Quarantined backup saved to '${v.patch_path}'.`
          );
        }
        const deltaFooter = this.engine.consumeAgentDelta(params.agentId).formattedFooter;
        return {
          allowed: false,
          exitCode: 2,
          warnings,
          deltaFooter,
        };
      }
    }

    const deltaFooter = this.engine.consumeAgentDelta(params.agentId).formattedFooter;
    return {
      allowed: true,
      exitCode: 0,
      warnings,
      deltaFooter,
    };
  }

  /**
   * Git `pre-commit` hook handler: ensures none of the staged files are locked by another live agent.
   */
  public handleGitPreCommit(agentId: string): {
    allowed: boolean;
    exitCode: number;
    violations: string[];
  } {
    let stagedFiles: string[] = [];
    try {
      const out = execFileSync(
        'git',
        ['diff', '--cached', '--name-only'],
        { cwd: this.engine.coordDb.repoRoot, encoding: 'utf8' }
      ).trim();
      stagedFiles = out.split(/\r?\n/).filter(Boolean);
    } catch {
      return { allowed: true, exitCode: 0, violations: [] };
    }

    const violations: string[] = [];
    for (const file of stagedFiles) {
      const check = this.engine.locks.checkFileWriteAccess({
        agentId,
        filePath: file,
      });
      if (!check.allowed && check.reason) {
        violations.push(check.reason);
      }
    }

    return {
      allowed: violations.length === 0,
      exitCode: violations.length === 0 ? 0 : 1,
      violations,
    };
  }

  public static readJsonStdinSync(): HookInputPayload | undefined {
    if (process.stdin.isTTY) return undefined;
    try {
      const raw = fs.readFileSync(0, 'utf8').trim();
      if (!raw) return undefined;
      return JSON.parse(raw) as HookInputPayload;
    } catch {
      return undefined;
    }
  }
}
