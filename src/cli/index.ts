#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { KITH_VERSION } from '../version.js';

import { formatBrief } from '../core/brief.js';
import { buildSwarmPrompts, KithEngine } from '../core/engine.js';
import { gcCoordination } from '../core/gc.js';
import { parseWorkflowMode } from '../core/mode.js';
import { readBrief, readCoordinationState, recoveryReport } from '../core/observation.js';
import { discoverRepository, physicalPath } from '../core/repository.js';
import { runKithMcpStdioServer } from '../mcp/server.js';
import { clearAutoSession, listRepoPresence, resolveHomeDir } from './auto-session.js';
import { bootoutHostAutostart } from './autostart.js';
import { runEngineCommand } from './coord-commands.js';
import { doctorReport } from './doctor.js';
import { parseFlags, printHelp } from './flags.js';
import { formatDoctorHuman, formatGcHuman, formatInstallHuman, formatStatusHuman, shouldUseHumanOutput } from './format.js';
import { handleHookCommand } from './hook-commands.js';
import { enforcementMode } from './hook-handler.js';
import { INTEGRATIONS, Integration, initializeKithRepository } from './init.js';
import { installKith } from './install.js';
import { startRadar } from './radar.js';
import { runWithKith } from './run.js';
import { installedCliPath } from './runtime.js';
import { uninstallKith } from './setup-ledger.js';
import { runWatchCommand } from './watch-command.js';

function suppressSqliteExperimentalWarning(): void {
  // Node's experimental SQLite warning adds noise to short-lived CLI and hook invocations.
  const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    const text = typeof warning === 'string' ? warning : (warning as Error | undefined)?.message ?? '';
    if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
    return emitWarning(warning, ...rest);
  }) as typeof process.emitWarning;
}

async function runLegacySetupCommand(
  targetDir: string,
  flags: Record<string, string | boolean>
): Promise<void> {
  const report = await installKith({
    targetDir,
    dryRun: Boolean(flags['dry-run']),
    full: !flags.compact,
    noHooks: !flags.hooks,
    noRadar: Boolean(flags['no-radar']),
    project: true,
    strictRadar: true,
  });
  console.log(`\n✨ Kith Auto-Detect & Setup for ${report.targetDir}\n`);
  for (const r of report.clients) {
    const statusIcon = r.configured ? '✓' : r.found ? '!' : '✗';
    console.log(`  ${statusIcon} ${r.clientName.padEnd(24)} -> ${r.notes}`);
  }
  if (!report.ok && report.radar.state !== 'failed') process.exitCode = 1;
  console.log(`\n${report.dryRun ? 'Would retain' : 'Runtime retained at'}: ${report.cliPath}`);
  if (!report.dryRun) console.log('Retained server: MCP discovery passed. Client connection is checked in your client.');
  if (!report.clients.some(r => r.clientName === 'Project instructions')) console.log('For project guidance, run setup with the Git checkout path.');
  if (process.platform === 'darwin' && !flags['no-radar']) {
    if (report.radar.state === 'failed') {
      console.error(report.radar.notes);
      process.exitCode = 1;
    } else {
      console.log(report.radar.notes);
    }
  }
  console.log('Restart/reconnect configured clients and approve Kith in their MCP controls.');
  console.log('Then ask your agent: Use Kith for this task; claim its files, use an isolated worktree and verify before integrating.');
  console.log('Setup does not claim work. The coordination view shows a task only after the agent begins it.');
  console.log('Existing hooks, permissions and custom launchers are preserved. Review skipped entries.\n');
}

async function main(): Promise<void> {
  suppressSqliteExperimentalWarning();
  const { positional, flags, passthroughCmd } = parseFlags(process.argv.slice(2));
  const cmd = positional[0] ?? (!flags.help && !flags.version && !flags.json && process.stdout.isTTY ? 'overview' : 'help');
  const subCmd = positional[1];
  const targetFromPositional = (['init', 'setup', 'install', 'gc', 'watch', 'menubar', 'bar', 'tray', 'doctor', 'recover'].includes(cmd) && positional[1])
    ? path.resolve(positional[1])
    : undefined;
  const repoRoot = typeof flags.repo === 'string'
    ? path.resolve(flags.repo)
    : (targetFromPositional ?? (cmd === 'mcp' ? process.env.CLAUDE_PROJECT_DIR : undefined) ?? process.cwd());

  if (flags.version || cmd === 'version') { console.log(KITH_VERSION); return; }
  if (flags.help || cmd === 'help') { printHelp(Boolean(flags.all)); return; }

  if (cmd === 'init') {
    const integrations = typeof flags.only === 'string' ? flags.only.split(',') : undefined;
    if (integrations?.some((name) => !INTEGRATIONS.includes(name as Integration))) {
      throw new Error(`--only accepts: ${INTEGRATIONS.join(', ')}`);
    }
    let selectedMode = typeof flags.mode === 'string' ? parseWorkflowMode(flags.mode) : undefined;
    if (!selectedMode && !flags['dry-run'] && !flags.json && process.stdin.isTTY && process.stdout.isTTY) {
      const existing = readCoordinationState(repoRoot, { coordinationOnly: true });
      if (!existing.workflowModeConfigured) {
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const answer = (await rl.question('Workflow mode [worktrees/main] (default: worktrees): ')).trim();
          selectedMode = answer ? parseWorkflowMode(answer) : 'worktrees';
        } finally {
          rl.close();
        }
      }
    }
    const report = initializeKithRepository(repoRoot, 'kith', {
      enforcement: enforcementMode(flags.enforcement),
      dryRun: Boolean(flags['dry-run']),
      refreshGuidance: Boolean(flags['refresh-guidance']),
      mode: selectedMode,
      mcpOnly: flags['mcp-only'] ? true : undefined,
      integrations: integrations as Integration[] | undefined,
    });
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
    return;
  }

  if (cmd === 'mcp') {
    const compact = flags.compact ? true : flags.full ? false : undefined;
    await runKithMcpStdioServer(repoRoot, typeof flags.repo === 'string', { compact });
    return;
  }

  if (cmd === 'uninstall') {
    const dryRun = Boolean(flags['dry-run']);
    const home = resolveHomeDir();
    const scopeGlobal = Boolean(flags.global) || (!flags.repo && !positional[1] && physicalPath(repoRoot) !== home && fs.existsSync(path.join(home, '.coord/setup')));
    const target = flags.global ? home : repoRoot;
    if (physicalPath(target) === home) bootoutHostAutostart(home, dryRun);
    const report = uninstallKith(target, dryRun);
    if (scopeGlobal && physicalPath(target) !== home) {
      bootoutHostAutostart(home, dryRun);
      const globalReport = uninstallKith(home, dryRun);
      report.restored.push(...globalReport.restored);
      report.removed.push(...globalReport.removed);
      report.needsReview.push(...globalReport.needsReview);
      report.retained.push(...globalReport.retained);
      report.ok = report.ok && globalReport.ok;
    }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  // Read-only and session-free: runs for any shell, hook or agent, never creates or changes state, and never fails the caller.
  if (cmd === 'brief') {
    const scope = typeof flags.scope === 'string' ? flags.scope.split(',').map(glob => glob.trim()).filter(Boolean) : undefined;
    let brief;
    try { brief = readBrief(repoRoot, { scopeGlobs: scope }); }
    catch (error) {
      brief = {
        repository: repoRoot, mode: 'worktrees' as const, state: 'unavailable' as const,
        error: error instanceof Error ? error.message : String(error), observedAt: Date.now(),
        active: [], blockers: [], queued: { count: 0, stale: 0, next: [] }, handoffs: [], conflicts: [], empty: true, notice: '',
      };
    }
    if (flags.json) console.log(JSON.stringify(brief, null, 2));
    else { const text = formatBrief(brief, { quiet: Boolean(flags.quiet) }); if (text) console.log(text); }
    return;
  }

  if (cmd === 'install') {
    const targetDir = positional[1] ? path.resolve(positional[1]) : (typeof flags.repo === 'string' ? path.resolve(flags.repo) : process.cwd());
    const report = await installKith({
      targetDir,
      dryRun: Boolean(flags['dry-run']),
      full: Boolean(flags.full),
      noHooks: Boolean(flags['no-hooks']),
      noRadar: Boolean(flags['no-radar']),
      noAutostart: Boolean(flags['no-autostart']),
      project: Boolean(flags.project),
    });
    console.log(shouldUseHumanOutput(flags) ? formatInstallHuman(report) : JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'gc') {
    const staleDays = typeof flags['stale-days'] === 'string' ? Number(flags['stale-days']) : undefined;
    const report = gcCoordination(repoRoot, {
      dryRun: Boolean(flags['dry-run']),
      staleDays,
      force: Boolean(flags.force),
    });
    console.log(shouldUseHumanOutput(flags) ? formatGcHuman(report) : JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === 'run') {
    const scopeGlobs = typeof flags.scope === 'string' ? flags.scope.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const command = passthroughCmd.length ? passthroughCmd : positional.slice(1);
    process.exitCode = await runWithKith({
      repoRoot,
      agentId: typeof flags.agent === 'string' ? flags.agent : undefined,
      title: typeof flags.title === 'string' ? flags.title : undefined,
      scopeGlobs,
      worktree: Boolean(flags.worktree),
      main: Boolean(flags.main),
      keepWorktree: Boolean(flags.keep),
      verificationCmd: typeof flags.verify === 'string' ? flags.verify : undefined,
      quiet: Boolean(flags.quiet),
      command,
    });
    return;
  }

  if (cmd === 'overview') {
    const state = readCoordinationState(repoRoot);
    const presencePeers = state.repository.commonGitDir ? listRepoPresence(undefined, state.repository.commonGitDir) : [];
    console.log(formatStatusHuman({ ...state, ...(presencePeers.length ? { presencePeers } : {}) }));
    console.log("\nRun 'kith help' for commands.");
    return;
  }

  if (cmd === 'doctor') {
    const report = doctorReport(repoRoot, resolveHomeDir());
    console.log(shouldUseHumanOutput(flags) ? formatDoctorHuman(report) : JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (cmd === 'recover' || (cmd === 'status' && (flags.offline || (!flags.live && !fs.existsSync(path.join(discoverRepository(repoRoot).coordDir, 'state.db')))))) {
    const state = cmd === 'recover' ? recoveryReport(repoRoot) : readCoordinationState(repoRoot);
    if (cmd === 'status' && shouldUseHumanOutput(flags)) {
      const presencePeers = state.repository.commonGitDir ? listRepoPresence(undefined, state.repository.commonGitDir) : [];
      console.log(formatStatusHuman({ ...state, ...(presencePeers.length ? { presencePeers } : {}) }));
    } else {
      console.log(JSON.stringify(state, null, 2));
    }
    process.exitCode = state.state === 'unavailable' ? 1 : 0;
    return;
  }

  if (cmd === 'prompt') {
    const prompts = buildSwarmPrompts(repoRoot);
    const role = subCmd === 'architect' || subCmd === 'worker' ? subCmd : undefined;
    if (flags.raw && role) { console.log(prompts[role]); return; }
    console.log(JSON.stringify({ ok: true, repository: repoRoot, ...(role ? { role, prompt: prompts[role] } : prompts) }, null, 2));
    return;
  }

  if (cmd === 'setup' || cmd === 'auto-detect') {
    await runLegacySetupCommand(positional[1] ? path.resolve(positional[1]) : repoRoot, flags);
    return;
  }

  if (cmd === 'menubar' || cmd === 'bar' || cmd === 'tray') {
    const targetDir = positional[1] ? path.resolve(positional[1]) : repoRoot;
    if (process.platform !== 'darwin') throw new Error('The menu-bar view requires macOS. Use kith watch on this platform.');
    const state = await startRadar(targetDir, installedCliPath());
    console.log(state === 'started' ? `Kith Radar opened for ${targetDir}.` : 'Kith Radar is already open; existing workspace kept. Use Switch Workspace in its menu if needed.');
    return;
  }

  if (cmd === 'watch' || cmd === 'monitor') {
    await runWatchCommand({ targetDir: positional[1] ? path.resolve(positional[1]) : repoRoot, flags });
    return;
  }

  if (cmd === 'session' && subCmd === 'clear') {
    const layout = discoverRepository(repoRoot);
    if (!layout.commonGitDir || !fs.existsSync(path.join(layout.coordDir, 'state.db'))) throw new Error('No Kith state in this repository');
    const engine = new KithEngine(layout.checkoutRoot);
    try {
      const target = positional[2];
      const result = clearAutoSession(resolveHomeDir(), engine, { repoCommonDir: layout.commonGitDir, target, conflictsOnly: Boolean(flags.conflicts) });
      console.log(`Cleared ${result.conflictsCleared} conflict(s)${result.agentId ? `; session ${result.agentId} ${result.reclaimed ? 'released' : 'was not active'}` : ''}.`);
    } finally { engine.close(); }
    return;
  }

  if (cmd === 'hook') {
    handleHookCommand({ subCmd, flags, repoRoot });
    return;
  }

  await runEngineCommand({ cmd, subCmd, positional, flags, passthroughCmd, repoRoot });
}

main().catch((err) => {
  const args = process.argv.slice(2);
  const isPre = args.includes('hook') && args.includes('pre');
  const isStrictHook =
    args.includes('--require-session') ||
    Boolean(process.env.KITH_REQUIRE_SESSION) ||
    args.includes('--agent') ||
    Boolean(process.env.KITH_AGENT_ID) ||
    Boolean(process.env.KITH_SESSION_TOKEN);
  const message = err instanceof Error ? err.message : String(err);
  if (isPre && args.includes('--auto') && !isStrictHook) {
    const cursorIdx = args.indexOf('--client');
    if (cursorIdx >= 0 && args[cursorIdx + 1] === 'cursor') {
      console.log(JSON.stringify({ permission: 'allow', user_message: `[kith] ${message}`, agent_message: `[kith] ${message}` }));
    } else {
      console.error(`[kith] passive hook skipped: ${message}`);
    }
    process.exitCode = 0;
    return;
  }
  console.error(message);
  process.exitCode = isPre ? 2 : 1;
});
