import { discoverRepository } from '../core/repository.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { LockEngine } from '../core/locks.js';
import { KithEngine } from '../core/engine.js';

export interface HookInputPayload {
  session_id?: string;
  agent_id?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    path?: string;
    target_file?: string;
    command?: string;
    content?: string;
    new_string?: string;
  };
}

export type EnforcementMode = 'block' | 'warn' | 'off';
export function enforcementMode(value: unknown = 'block'): EnforcementMode {
  if (value !== 'block' && value !== 'warn' && value !== 'off') throw new Error('Enforcement must be block, warn or off');
  return value;
}

export class HookHandler {
  constructor(private readonly engine: KithEngine, private readonly mode: EnforcementMode = 'block') {
    enforcementMode(mode);
  }

  private conflict(message: string): { allowed: boolean; exitCode: number; message: string } {
    return this.mode === 'block' ? { allowed: false, exitCode: 2, message }
      : { allowed: true, exitCode: 0, message: this.mode === 'warn' ? `[KITH WARNING] ${message}` : '' };
  }

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
    this.engine.fencing.assertSession(params.agentId);

    const agent = this.engine.fencing.getAgent(params.agentId);
    if (params.filePath) {
      params = { ...params, filePath: LockEngine.normalizeFile(agent?.worktree_path ?? this.engine.coordDb.repoRoot, params.filePath) };
    }
    const tool = params.toolName.toLowerCase();

    if ((tool.includes('edit') || tool.includes('write') || tool.includes('replace') || tool.includes('delete')) && !params.filePath) {
      return { allowed: false, exitCode: 2, message: '[KITH LOCK GUARD] Missing file path in edit hook payload.' };
    }

    if (this.mode === 'off') return { allowed: true, exitCode: 0, message: '' };

    // 1. Pre-Edit / Pre-Write File Lock Enforcement
    if (
      params.filePath &&
      (tool.includes('edit') || tool.includes('write') || tool.includes('replace') || tool.includes('delete'))
    ) {
      const check = this.engine.locks.checkFileWriteAccess({
        agentId: params.agentId,
        filePath: params.filePath,
      });

      if (!check.allowed) {
        return this.conflict(`[KITH LOCK GUARD] Write to '${params.filePath}' conflicts with a claim. ${check.reason}`);
      }

      // Auto-acquire an advisory/exclusive file lock if the file was unlocked so sibling agents see it immediately
      const acquired = this.engine.locks.acquireLocks({
        agentId: params.agentId,
        patterns: [params.filePath],
        lockType: 'file',
        reason: `Auto-locked on ${params.toolName}`,
      });

      if (!acquired.ok) {
        return this.conflict('[KITH LOCK GUARD] Another agent acquired the file lock. Retry after resolving the conflict.');
      }
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

      const conflict = !safety.safe ? this.conflict(`[KITH BASH FIREWALL] ${safety.reason}`) : null;
      if (conflict && !conflict.allowed) return conflict;

      this.engine.bashGuard.capturePreBashSnapshot(
        params.agentId,
        agent?.worktree_path ?? this.engine.coordDb.repoRoot
      );
      return conflict ?? { allowed: true, exitCode: 0, message: '' };
    }

    return { allowed: true, exitCode: 0, message: '' };
  }

  /**
   * Handles `PostToolUse` verification:
   * - For file edits: AST export/import extraction, transitive blast radius, live dirty-tree `git merge-tree`.
   * - For Bash commands: snapshot diff and preserved recovery copies of unauthorized changes.
   */
  public handlePostToolUse(params: {
    agentId: string;
    toolName: string;
    filePath?: string;
    command?: string;
  }): { allowed: boolean; exitCode: number; warnings: string[]; deltaFooter: string } {
    const agent = this.engine.fencing.getAgent(params.agentId);
    if (params.filePath) {
      params = { ...params, filePath: LockEngine.normalizeFile(agent?.worktree_path ?? this.engine.coordDb.repoRoot, params.filePath) };
    }
    const tool = params.toolName.toLowerCase();
    this.engine.fencing.assertSession(params.agentId);
    const warnings: string[] = [];

    if (
      params.filePath &&
      (tool.includes('edit') || tool.includes('write') || tool.includes('replace') || tool.includes('delete'))
    ) {
      const agent = this.engine.fencing.getAgent(params.agentId);
      const access = this.engine.locks.checkFileWriteAccess({ agentId: params.agentId, filePath: params.filePath });
      if (!access.allowed && this.mode !== 'block') {
        if (this.mode === 'warn') warnings.push(`[KITH WARNING] ${access.reason}. Edit was not indexed as authorized work.`);
        return { allowed: true, exitCode: 0, warnings, deltaFooter: this.engine.consumeAgentDelta(params.agentId).formattedFooter };
      }
      const postRes = this.engine.processPostFileEdit({
        agentId: params.agentId,
        filePath: params.filePath,
        worktreeDir: agent?.worktree_path ?? undefined,
      });
      warnings.push(...postRes.warnings);
    } else if (tool === 'bash' || tool === 'run_command' || params.command) {
      if (this.mode === 'off') return { allowed: true, exitCode: 0, warnings, deltaFooter: this.engine.consumeAgentDelta(params.agentId).formattedFooter };
      const agent = this.engine.fencing.getAgent(params.agentId);
      const report = this.engine.bashGuard.verifyPostBashAndQuarantine({
        agentId: params.agentId,
        command: params.command ?? 'bash',
        rootDir: agent?.worktree_path ?? this.engine.coordDb.repoRoot,
      });

      if (!report.allowed) {
        for (const v of report.quarantinedViolations) {
          warnings.push(
            `[KITH BASH QUARANTINE] Detected a change to locked file '${v.file_path}' during command '${v.command}'. Current workspace bytes were preserved. ${v.reason}. Recovery copies saved to '${v.patch_path}' (and .before when available).`
          );
        }
        const deltaFooter = this.engine.consumeAgentDelta(params.agentId).formattedFooter;
        return {
          allowed: this.mode !== 'block',
          exitCode: this.mode === 'block' ? 2 : 0,
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
  public handleGitPreCommit(agentId: string, indexCwd = this.engine.fencing.getAgent(agentId)?.worktree_path ?? this.engine.coordDb.repoRoot): {
    allowed: boolean;
    exitCode: number;
    violations: string[];
  } {
    this.engine.fencing.assertSession(agentId);
    let stagedFiles: string[] = [];
    try {
      const layout = discoverRepository(indexCwd);
      if (!layout.commonGitDir || layout.commonGitDir !== this.engine.coordDb.commonGitDir) throw new Error('Git index belongs to a different repository');
      const out = execFileSync(
        'git',
        ['diff', '--cached', '--name-only', '-z'],
        { cwd: layout.checkoutRoot, encoding: 'utf8' }
      );
      stagedFiles = out.split('\0').filter(Boolean);
    } catch {
      return { allowed: false, exitCode: 1, violations: ['Unable to read the Git index.'] };
    }

    const violations: string[] = [];
    for (const file of this.mode === 'off' ? [] : stagedFiles) {
      const check = this.engine.locks.checkFileWriteAccess({
        agentId,
        filePath: file,
      });
      if (!check.allowed && check.reason) {
        violations.push(check.reason);
      }
    }

    return {
      allowed: violations.length === 0 || this.mode !== 'block',
      exitCode: violations.length === 0 || this.mode !== 'block' ? 0 : 1,
      violations,
    };
  }

  public static readJsonStdinSync(): HookInputPayload | undefined {
    if (process.stdin.isTTY) return undefined;
    try {
      const raw = fs.readFileSync(0, 'utf8').trim();
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
      return parsed as HookInputPayload;
    } catch (err) {
      throw new Error(`Cannot read hook input: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
