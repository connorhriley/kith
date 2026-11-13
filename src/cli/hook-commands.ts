import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { formatBrief } from '../core/brief.js';
import { KithEngine } from '../core/engine.js';
import { FencingAndAgentManager, SessionOwnershipError } from '../core/fencing.js';
import { isIgnoredPath } from '../core/git-ignore.js';
import { LockEngine } from '../core/locks.js';
import { readBrief } from '../core/observation.js';
import { discoverRepository } from '../core/repository.js';
import {
  AutoSessionConflictError,
  clearPresenceAndCapability,
  ensureMachineLocalExclude,
  extractHookSessionKey,
  getAutoCapability,
  listRepoPresence,
  promoteAutoSession,
  recordPresence,
  resolveHomeDir,
  resolveHookStartDir,
  resolvePersistentOwnerPid,
} from './auto-session.js';
import { enforcementMode, HookHandler } from './hook-handler.js';

const HOOK_SUBCOMMANDS = ['pre', 'post', 'pre-commit', 'session-start', 'stop'] as const;

/** True when the caller presented any Kith identity: an agent ID or session token by flag or environment. */
export function hasKithIdentity(flags: Record<string, string | boolean>): boolean {
  return typeof flags.agent === 'string' || typeof flags['session-token'] === 'string'
    || Boolean(process.env.KITH_AGENT_ID) || Boolean(process.env.KITH_SESSION_TOKEN);
}

/** Allow without touching shared state, in the output shape the calling client expects. */
export function passThroughHook(phase: string | undefined, client: string | boolean | undefined): void {
  if (client === 'cursor') {
    console.log(JSON.stringify(phase === 'pre' ? { permission: 'allow' } : { additional_context: '' }));
  }
  process.exitCode = 0;
}

export function runHookPhase(params: {
  engine: KithEngine;
  subCmd: string;
  flags: Record<string, string | boolean>;
  stdinPayload: Record<string, any> | undefined;
  agentId: string;
  promotedNotice?: string;
}): void {
  const { engine, subCmd, flags, stdinPayload, agentId, promotedNotice } = params;
  const handler = new HookHandler(engine, enforcementMode(flags.enforcement));
  const toolName = String(flags.tool ?? stdinPayload?.tool_name ?? 'Edit');
  const filePath =
    typeof flags.file === 'string'
      ? flags.file
      : stdinPayload?.tool_input?.file_path ??
        stdinPayload?.tool_input?.notebook_path ??
        stdinPayload?.tool_input?.target_file ??
        stdinPayload?.tool_input?.path;
  const command =
    typeof flags.cmd === 'string'
      ? flags.cmd
      : stdinPayload?.tool_input?.command;

  if (subCmd === 'pre') {
    const res = handler.handlePreToolUse({ agentId, toolName, filePath, command });
    const msg = [res.message, res.allowed ? promotedNotice : undefined].filter(Boolean).join('\n');
    if (flags.client === 'cursor') {
      console.log(JSON.stringify({ permission: res.allowed ? 'allow' : 'deny', ...(msg ? { user_message: msg, agent_message: msg } : {}) }));
    } else if (!res.allowed) {
      console.error(msg);
    } else if (msg) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } }));
    }
    process.exitCode = res.exitCode;
    return;
  }

  if (subCmd === 'post') {
    const res = handler.handlePostToolUse({ agentId, toolName, filePath, command });
    const msg = [promotedNotice, ...res.warnings, res.deltaFooter].filter(Boolean).join('\n');
    if (flags.client === 'cursor') {
      console.log(JSON.stringify({ additional_context: msg }));
      process.exitCode = res.exitCode;
      return;
    }
    if (msg) {
      if (!res.allowed) {
        console.error(msg);
      } else {
        console.log(JSON.stringify({
          systemMessage: msg,
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
        }));
      }
    }
    process.exitCode = res.exitCode;
    return;
  }

  if (subCmd === 'pre-commit') {
    const res = handler.handleGitPreCommit(agentId, process.cwd());
    if (res.violations.length) {
      console.error(
        `[KITH GIT PRE-COMMIT ${res.allowed ? 'WARNING' : 'GUARD'}] Files claimed by sibling agents:\n` +
          res.violations.map((v) => `  - ${v}`).join('\n')
      );
    }
    process.exitCode = res.exitCode;
    return;
  }

  if (subCmd === 'stop') {
    const agent = engine.fencing.getAgent(agentId);
    const dir = agent?.worktree_path ?? engine.coordDb.repoRoot;
    let dirty = false;
    try {
      dirty = execFileSync('git', ['status', '--porcelain'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim().length > 0;
    } catch { /* Non-git or unavailable checkout. */ }
    if (dirty) {
      try {
        engine.handoffs.write({
          agentId,
          kind: 'progress',
          summary: 'Session stopped with uncommitted changes.',
        });
      } catch { /* No active task or handoff unnecessary. */ }
    }
    engine.fencing.abandonAgentSession(agentId);
    process.exitCode = 0;
  }
}

function handleSessionStartHook(flags: Record<string, string | boolean>): void {
  let payload: Record<string, any> | undefined;
  try {
    payload = HookHandler.readJsonStdinSync() as Record<string, any> | undefined;
  } catch { /* ignore invalid or empty stdin */ }
  const startDir = resolveHookStartDir(flags.repo, payload, process.cwd());
  if (startDir === path.parse(startDir).root) {
    if (flags.client === 'cursor') console.log(JSON.stringify({ additional_context: '' }));
    return;
  }
  try {
    const layout = discoverRepository(startDir);
    const home = resolveHomeDir();
    const sessionKey = extractHookSessionKey(flags.client, payload);
    const clientName = typeof flags.client === 'string' ? flags.client : 'claude';
    const peers = layout.commonGitDir && sessionKey
      ? recordPresence(home, {
        sessionKey,
        repoCommonDir: layout.commonGitDir,
        checkoutRoot: layout.checkoutRoot,
        client: clientName,
        pid: resolvePersistentOwnerPid(),
      })
      : (layout.commonGitDir ? listRepoPresence(home, layout.commonGitDir) : []);

    const hasState = fs.existsSync(path.join(layout.coordDir, 'state.db'));
    let text = '';
    if (hasState) {
      const brief = readBrief(layout.checkoutRoot);
      text = formatBrief(brief, { quiet: true });
    }
    const otherPeers = sessionKey ? peers.filter(p => p.sessionKey !== sessionKey) : peers;
    if (!text && otherPeers.length > 0) {
      const recentFiles = [...new Set(otherPeers.flatMap(p => p.touchedFiles))].slice(0, 5);
      text = `[kith] ${peers.length} active sessions in ${path.basename(layout.checkoutRoot)}${recentFiles.length ? ` (editing: ${recentFiles.join(', ')})` : ''}. Shared file locks & interface checks will engage automatically on edits; call kith_work to isolate in a worktree.`;
    }
    if (!text) {
      if (flags.client === 'cursor') console.log(JSON.stringify({ additional_context: '' }));
      return;
    }
    if (flags.client === 'cursor') console.log(JSON.stringify({ additional_context: text }));
    else console.log(text);
  } catch {
    if (flags.client === 'cursor') console.log(JSON.stringify({ additional_context: '' }));
  }
}

function handleAutoHook(subCmd: string, flags: Record<string, string | boolean>): void {
  if (!flags.auto || !['pre', 'post', 'stop'].includes(subCmd)) {
    passThroughHook(subCmd, flags.client);
    return;
  }
  let stdinPayload: Record<string, any> | undefined;
  try {
    stdinPayload = HookHandler.readJsonStdinSync() as Record<string, any> | undefined;
  } catch {
    passThroughHook(subCmd, flags.client);
    return;
  }
  const sessionKey = extractHookSessionKey(flags.client, stdinPayload);
  if (!sessionKey) {
    passThroughHook(subCmd, flags.client);
    return;
  }
  const startDir = resolveHookStartDir(flags.repo, stdinPayload, process.cwd());
  const layout = startDir === path.parse(startDir).root ? null : discoverRepository(startDir);
  if (!layout?.commonGitDir) {
    passThroughHook(subCmd, flags.client);
    return;
  }
  const home = resolveHomeDir();
  const clientName = typeof flags.client === 'string' ? flags.client : 'auto';
  const ownerPid = resolvePersistentOwnerPid();

  if (subCmd === 'stop') {
    const cap = getAutoCapability(home, layout.commonGitDir, sessionKey);
    clearPresenceAndCapability(home, sessionKey, layout.commonGitDir);
    if (!cap || !fs.existsSync(path.join(layout.coordDir, 'state.db'))) {
      passThroughHook('stop', flags.client);
      return;
    }
    const autoEngine = new KithEngine(layout.checkoutRoot);
    try {
      try {
        autoEngine.fencing.resumeSession(cap.agentId, cap.sessionToken);
        runHookPhase({ engine: autoEngine, subCmd: 'stop', flags, stdinPayload, agentId: cap.agentId });
      } catch {
        passThroughHook('stop', flags.client);
      }
    } finally {
      autoEngine.close();
    }
    return;
  }

  const toolName = String(flags.tool ?? stdinPayload?.tool_name ?? 'Edit');
  const rawFile =
    typeof flags.file === 'string'
      ? flags.file
      : stdinPayload?.tool_input?.file_path ??
        stdinPayload?.tool_input?.notebook_path ??
        stdinPayload?.tool_input?.target_file ??
        stdinPayload?.tool_input?.path;
  const isEditTool = Boolean(rawFile && /(edit|write|replace|delete)/i.test(toolName));
  let relFile: string | undefined;
  if (isEditTool && rawFile) {
    try { relFile = LockEngine.normalizeFile(layout.checkoutRoot, rawFile); } catch { /* validated in HookHandler once promoted */ }
  }
  const presenceFile = subCmd === 'pre' && relFile && !isIgnoredPath(layout.checkoutRoot, relFile) ? relFile : undefined;
  const peers = recordPresence(home, {
    sessionKey,
    repoCommonDir: layout.commonGitDir,
    checkoutRoot: layout.checkoutRoot,
    client: clientName,
    pid: ownerPid,
    filePath: presenceFile,
  });
  const stateExists = fs.existsSync(path.join(layout.coordDir, 'state.db'));
  if (!stateExists && peers.length < 2) {
    passThroughHook(subCmd, flags.client);
    return;
  }

  ensureMachineLocalExclude(layout);
  const autoEngine = new KithEngine(layout.checkoutRoot);
  try {
    let promoted: { agentId: string; sessionToken: string; newlyJoined: boolean };
    try {
      promoted = promoteAutoSession(home, autoEngine, {
        repoCommonDir: layout.commonGitDir,
        sessionKey,
        client: clientName,
        pid: ownerPid,
        peers,
        pendingFile: presenceFile,
      });
    } catch (err) {
      if (!(err instanceof AutoSessionConflictError)) throw err;
      if (subCmd === 'pre' && isEditTool && relFile && !isIgnoredPath(layout.checkoutRoot, relFile)) {
        const now = Date.now();
        const requested = LockEngine.literalScope(relFile);
        const locks = autoEngine.coordDb.db.prepare(
          `SELECT l.pattern, l.owner_agent_id, a.pid, a.pid_start_time FROM locks l
           JOIN agents a ON a.id = l.owner_agent_id
           WHERE l.expires_at > ? AND a.status = 'active' AND a.lease_expires_at > ?`
        ).all(now, now) as Array<{ pattern: string; owner_agent_id: string; pid: number; pid_start_time: string }>;
        const conflict = locks.find((l) =>
          FencingAndAgentManager.isProcessAlive(l.pid, l.pid_start_time) &&
          LockEngine.patternsOverlap(requested, l.pattern)
        );
        if (conflict) {
          const denyMsg = `[KITH LOCK GUARD] Write to '${relFile}' conflicts with a claim by '${conflict.owner_agent_id}' (${conflict.pattern}).`;
          if (flags.client === 'cursor') {
            console.log(JSON.stringify({ permission: 'deny', user_message: denyMsg, agent_message: denyMsg }));
          } else {
            console.error(denyMsg);
          }
          process.exitCode = 2;
          return;
        }
      }
      const hint = `[kith] ${err.message}. Clear with: kith session clear ${sessionKey}`;
      if (flags.client === 'cursor') {
        console.log(JSON.stringify(subCmd === 'pre' ? { permission: 'allow', user_message: hint, agent_message: hint } : { additional_context: hint }));
      } else {
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: subCmd === 'pre' ? 'PreToolUse' : 'PostToolUse', additionalContext: hint } }));
      }
      process.exitCode = 0;
      return;
    }
    runHookPhase({
      engine: autoEngine,
      subCmd,
      flags,
      stdinPayload,
      agentId: promoted.agentId,
      promotedNotice: promoted.newlyJoined
        ? `[kith] ${Math.max(peers.length, 2)} sessions active in ${path.basename(layout.checkoutRoot)}; auto-enforcing file locks and contract alerts.`
        : undefined,
    });
  } finally {
    autoEngine.close();
  }
}

export function handleHookCommand(params: {
  subCmd: string | undefined;
  flags: Record<string, string | boolean>;
  repoRoot: string;
}): void {
  const { subCmd, flags, repoRoot } = params;
  if (!subCmd || !(HOOK_SUBCOMMANDS as readonly string[]).includes(subCmd)) {
    throw new Error(`Expected kith hook ${HOOK_SUBCOMMANDS.join('|')}`);
  }
  if (subCmd === 'session-start') {
    handleSessionStartHook(flags);
    return;
  }
  // Hooks govern sessions that joined; they remain silent to unrelated callers unless --require-session or --auto applies.
  if (!flags['require-session'] && !process.env.KITH_REQUIRE_SESSION && !hasKithIdentity(flags)) {
    handleAutoHook(subCmd, flags);
    return;
  }

  const engine = new KithEngine(repoRoot);
  try {
    const agentId = String(flags.agent ?? process.env.KITH_AGENT_ID ?? `cli-${process.pid}`);
    const sessionToken = typeof flags['session-token'] === 'string' ? flags['session-token']
      : (!process.env.KITH_AGENT_ID || process.env.KITH_AGENT_ID === agentId) ? process.env.KITH_SESSION_TOKEN : undefined;
    const stdinPayload = HookHandler.readJsonStdinSync() as Record<string, any> | undefined;
    const hookAgentId = HookHandler.resolveAgentId(
      stdinPayload,
      typeof flags.agent === 'string' ? flags.agent : undefined
    );
    if (!sessionToken) throw new SessionOwnershipError(hookAgentId);
    engine.fencing.resumeSession(hookAgentId, sessionToken);
    runHookPhase({ engine, subCmd, flags, stdinPayload, agentId: hookAgentId });
  } finally {
    engine.close();
  }
}
