import path from 'node:path';
import { FencingAndAgentManager } from '../core/fencing.js';
import type { GcReport } from '../core/gc.js';
import type { TaskRecord } from '../core/intents.js';
import { ownedByCaller } from './auto-session.js';
import type { InstallReport } from './install.js';

export function shouldUseHumanOutput(flags: Record<string, string | boolean>): boolean {
  if (flags.json || flags.raw) return false;
  return Boolean(flags.human || process.stdout.isTTY);
}

export function formatInstallHuman(report: InstallReport): string {
  const lines: string[] = [];
  lines.push(`Kith installed (${report.profile} MCP)${report.dryRun ? ' [dry run]' : ''}`);
  lines.push(`Runtime: ${report.cliPath}`);
  lines.push('');
  for (const client of report.clients) {
    const icon = client.configured ? '+' : client.found ? '!' : '-';
    lines.push(`  ${icon} ${client.clientName}: ${client.notes}`);
  }
  if (report.clients.some(c => c.clientName === 'Codex' && c.configured)) {
    lines.push('  * Codex note: Codex CLI lacks native tool hooks; Codex coordinates via --compact MCP and Radar.');
  }
  lines.push(`  ${report.globalHooks.configured ? '+' : '-'} Claude hooks (${report.globalHooks.configPath}): ${report.globalHooks.notes}`);
  if (report.cursorHooks) {
    lines.push(`  ${report.cursorHooks.configured ? '+' : '-'} Cursor hooks (${report.cursorHooks.configPath}): ${report.cursorHooks.notes}`);
  }
  if (report.autostart?.configured) {
    lines.push(`  + Autostart (${report.autostart.configPath}): ${report.autostart.notes}`);
  }
  if (report.prunedRuntimes?.length) {
    lines.push(`  * Removed ${report.prunedRuntimes.length} unreferenced runtime${report.prunedRuntimes.length === 1 ? '' : 's'}.`);
  }
  lines.push(`  * ${report.radar.notes}`);
  for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  lines.push('');
  lines.push('Restart open MCP clients once to pick up the server.');
  lines.push('Everything else runs automatically across sessions — or use: kith status | kith run -- <cmd> | kith gc');
  return lines.join('\n');
}

export function formatGcHuman(report: GcReport): string {
  if (report.nothingToClean && report.preservedWorktrees.length === 0) {
    return `Kith GC (${path.basename(report.repository)}): nothing to prune.`;
  }
  const lines: string[] = [
    `Kith GC · ${report.repository}${report.dryRun ? ' [dry run]' : ''}`,
    `  Reaped sessions:       ${report.reapedAgents}`,
    `  Pruned shadow indexes: ${report.prunedShadowIndexes}`,
    `  Removed worktrees:     ${report.removedWorktrees.length}${report.deletedBranches.length ? ` (${report.deletedBranches.length} branches)` : ''}`,
    `  Pruned expired locks:  ${report.prunedExpiredLocks}`,
    `  Pruned stale records:  ${report.prunedOperations} ops, ${report.prunedDoneTasks} tasks, ${report.prunedOldEvents} events, ${report.prunedDeadAgents} agents, ${report.prunedArtifacts} files`,
  ];
  if (report.preservedWorktrees.length) {
    lines.push(`  Preserved worktrees (${report.preservedWorktrees.length}):`);
    for (const wt of report.preservedWorktrees) {
      lines.push(`    - ${wt.path}${wt.branch ? ` [${wt.branch}]` : ''} (${wt.reason})`);
    }
  }
  return lines.join('\n');
}

export function formatDoctorHuman(report: Record<string, any>): string {
  const repoLabel = typeof report.repository === 'string'
    ? report.repository
    : report.repository?.root ?? '';
  const lines: string[] = [
    `Kith doctor · ${report.ok ? 'OK' : 'ISSUES FOUND'}${repoLabel ? ` · ${repoLabel}` : ''}`,
  ];
  const checks = Array.isArray(report.checks) ? report.checks : [];
  for (const check of checks) {
    const icon = check.ok ? '+' : '!';
    lines.push(`  ${icon} ${check.name}: ${check.detail ?? (check.ok ? 'ok' : 'failed')}`);
  }
  return lines.join('\n');
}

function formatRelativeAge(ts: number | undefined, now: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function summarizeStatus(state: Record<string, any>) {
  const agents = Array.isArray(state.agents) ? state.agents : [];
  const activeAgents = agents.filter((a: any) => {
    if (a.status !== 'active') return false;
    if (typeof a.id === 'string' && a.id.startsWith('auto-') && a.pid && a.pid_start_time) {
      return FencingAndAgentManager.isProcessAlive(a.pid, a.pid_start_time);
    }
    return true;
  });
  const locks = Array.isArray(state.locks) ? state.locks : [];
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const now = typeof state.observedAt === 'number' ? state.observedAt : Date.now();
  const staleTaskCutoff = now - 14 * 24 * 60 * 60 * 1000;
  const openTasks = tasks.filter(
    (t: any) => t.status !== 'done' && !(t.status === 'queued' && typeof t.updated_at === 'number' && t.updated_at < staleTaskCutoff)
  );
  const conflicts = Array.isArray(state.conflicts) ? state.conflicts : [];
  const handoffs = Array.isArray(state.handoffs) ? state.handoffs : [];
  const presencePeers = Array.isArray(state.presencePeers) ? state.presencePeers : [];
  const activePids = new Set(activeAgents.map((a: any) => a.pid));
  const activeAgentIds = new Set(activeAgents.map((a: any) => a.id));
  const extraPresence = presencePeers.filter(
    (p: any) =>
      !activePids.has(p.pid) &&
      (!p.agentId || !activeAgentIds.has(p.agentId)) &&
      !activeAgents.some((a: any) => typeof a.pid === 'number' && typeof p.pid === 'number' && ownedByCaller(a.pid, p.pid))
  );
  return { activeAgents, extraPresence, locks, openTasks, conflicts, handoffs, presencePeers, now };
}

export function isStatusIdle(state: Record<string, any>): boolean {
  const s = summarizeStatus(state);
  return (
    s.activeAgents.length === 0 &&
    s.extraPresence.length === 0 &&
    s.locks.length === 0 &&
    s.openTasks.length === 0 &&
    s.conflicts.length === 0
  );
}

export function formatWorkspaceStatusHuman(
  workspaceRoot: string,
  children: Array<{ state: Record<string, any> }>
): string {
  const blocks: string[] = [`Kith workspace · ${workspaceRoot} (${children.length} repositories)`];
  const idleNames: string[] = [];
  for (const child of children) {
    const hasPresence = Array.isArray(child.state.presencePeers) && child.state.presencePeers.length > 0;
    if (child.state.state !== 'ready' && !hasPresence) continue;
    if (isStatusIdle(child.state)) {
      const rootPath = String(child.state.repository?.root ?? child.state.repository ?? '');
      idleNames.push(path.basename(rootPath) || rootPath);
    } else {
      blocks.push(formatStatusHuman(child.state));
    }
  }
  if (idleNames.length > 0) {
    blocks.push(`Idle repos (${idleNames.length}): ${idleNames.join(', ')}`);
  }
  if (blocks.length === 1 || (blocks.length === 2 && idleNames.length > 0 && blocks.length - 1 === 1 && !children.some(c => (c.state.state === 'ready' || (Array.isArray(c.state.presencePeers) && c.state.presencePeers.length > 0)) && !isStatusIdle(c.state)))) {
    blocks.push('Active agents: none across all repositories');
  }
  return blocks.join('\n\n');
}

export function formatStatusHuman(state: Record<string, any>): string {
  const repoRoot = state.repository?.root ?? state.repository ?? process.cwd();
  const mode = state.workflowMode ?? 'worktrees';
  const modeLabel = state.workflowModeConfigured === false && state.state === 'ready' ? `${mode} mode (default, unset)` : `${mode} mode`;
  const { activeAgents, extraPresence, locks, openTasks, conflicts, handoffs, presencePeers, now } = summarizeStatus(state);
  const recentAgentFiles = (state.recentAgentFiles ?? {}) as Record<string, string[]>;

  const lines: string[] = [
    `Kith · ${repoRoot} · ${modeLabel}${state.state ? ` · ${state.state}` : ''}`,
  ];
  if (activeAgents.length || extraPresence.length) {
    lines.push(`Active sessions (${activeAgents.length + extraPresence.length}):`);
    for (const a of activeAgents) {
      const wt = a.worktree_path ? ` · ${path.basename(a.worktree_path)}` : '';
      const peer = presencePeers.find(
        (p: any) =>
          p.pid === a.pid ||
          (p.agentId && p.agentId === a.id) ||
          (typeof a.pid === 'number' && typeof p.pid === 'number' && ownedByCaller(a.pid, p.pid))
      );
      const activeList = peer?.touchedFiles?.length
        ? { label: 'touched', list: peer.touchedFiles }
        : peer?.recentFiles?.length
          ? { label: 'recent', list: peer.recentFiles }
          : Array.isArray(recentAgentFiles[a.id]) && recentAgentFiles[a.id].length
            ? { label: 'recent', list: recentAgentFiles[a.id] }
            : null;
      const files = activeList ? ` · ${activeList.label}: ${activeList.list.slice(0, 4).join(', ')}` : '';
      const age = formatRelativeAge(peer?.lastSeenAt ?? a.last_heartbeat_at, now);
      lines.push(`  - ${a.id} [${a.client ?? 'unknown'}, pid ${a.pid}${age ? ` · ${age}` : ''}]${wt}${a.branch ? ` (${a.branch})` : ''}${files}`);
    }
    for (const p of extraPresence) {
      const activeList = Array.isArray(p.touchedFiles) && p.touchedFiles.length
        ? { label: 'touched', list: p.touchedFiles }
        : Array.isArray(p.recentFiles) && p.recentFiles.length
          ? { label: 'recent', list: p.recentFiles }
          : null;
      const files = activeList ? ` · ${activeList.label}: ${activeList.list.slice(0, 4).join(', ')}` : '';
      const age = formatRelativeAge(p.lastSeenAt, now);
      lines.push(`  - ${p.sessionKey} [${p.client ?? 'auto'}, pid ${p.pid}${age ? ` · ${age}` : ''}]${files}`);
    }
  } else {
    lines.push('Active agents: none (passive hooks will auto-engage when 2+ sessions overlap)');
  }
  if (locks.length) {
    lines.push(`Locks (${locks.length}):`);
    for (const l of locks.slice(0, 15)) {
      lines.push(`  - ${l.owner_agent_id}: ${l.pattern} (${l.mode})`);
    }
    if (locks.length > 15) lines.push(`  ... +${locks.length - 15} more`);
  }
  if (openTasks.length) {
    lines.push(`Tasks (${openTasks.length} open):`);
    for (const t of openTasks.slice(0, 10)) {
      lines.push(`  - [${t.status}] ${t.title} (${t.id})${t.owner_agent_id ? ` -> ${t.owner_agent_id}` : ''}`);
    }
  }
  if (conflicts.length) {
    lines.push(`Conflicts (${conflicts.length}):`);
    for (const c of conflicts.slice(0, 10)) {
      lines.push(`  ! ${c.file_path}: ${c.agent_a} vs ${c.agent_b} (${c.severity})`);
    }
  }
  if (handoffs.length) {
    lines.push(`Recent handoffs (${handoffs.length}): ${handoffs[0].kind} by ${handoffs[0].agent_id}`);
  }
  return lines.join('\n');
}

export function formatTasksHuman(tasks: TaskRecord[]): string {
  if (!tasks.length) return 'No tasks.';
  return tasks
    .map(t => `[${t.status}] p${t.priority} ${t.id} · ${t.title}${t.owner_agent_id ? ` (${t.owner_agent_id})` : ''}${t.scope_globs.length ? ` · ${t.scope_globs.join(',')}` : ''}`)
    .join('\n');
}
