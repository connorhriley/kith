#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { KITH_VERSION } from '../version.js';

import { uninstallKith } from './setup-ledger.js';
import { doctorReport } from './doctor.js';
import { readCoordinationState, recoveryReport } from '../core/observation.js';
import { SessionOwnershipError } from '../core/fencing.js';
import { buildSwarmPrompts, KithEngine } from '../core/engine.js';
import { runKithMcpStdioServer } from '../mcp/server.js';
import { enforcementMode, HookHandler } from './hook-handler.js';
import { INTEGRATIONS, Integration, initializeKithRepository } from './init.js';
import { PassiveConflictWatcher } from '../core/watcher.js';
import { autoConfigureAllClients } from './setup-auto.js';
import { installedCliPath } from './runtime.js';
import { setupRuntime, verifySetupRuntime } from './setup-runtime.js';
import { startRadar } from './radar.js';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

function parseFlags(argv: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
  passthroughCmd: string[];
} {
  const dashDashIdx = argv.indexOf('--');
  const mainArgs = dashDashIdx >= 0 ? argv.slice(0, dashDashIdx) : argv;
  const passthroughCmd = dashDashIdx >= 0 ? argv.slice(dashDashIdx + 1) : [];

  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < mainArgs.length; i++) {
    const arg = mainArgs[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx >= 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = mainArgs[i + 1];
        if (!['worktree', 'wait', 'raw', 'dry-run', 'help', 'version', 'shell', 'new', 'mcp-only', 'offline', 'once', 'json', 'quiet', 'no-notify', 'no-radar'].includes(key) && next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags, passthroughCmd };
}

async function interruptible<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const controller = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  const sigint = () => { interrupted = 'SIGINT'; controller.abort(); };
  const sigterm = () => { interrupted = 'SIGTERM'; controller.abort(); };
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  try { return await run(controller.signal); }
  catch (err) {
    if (!interrupted) throw err;
    process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  } finally { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm); }
}

async function main(): Promise<void> {
  const { positional, flags, passthroughCmd } = parseFlags(process.argv.slice(2));
  const cmd = positional[0] ?? 'help';
  const subCmd = positional[1];
  const claimWaitTimeout = () => {
    const value = flags['wait-ms'];
    if (value !== undefined && typeof value !== 'string') throw new Error('--wait-ms requires a millisecond value');
    return value === undefined ? 60000 : Number(value);
  };
  const targetFromPositional = (['init', 'setup', 'watch', 'menubar', 'bar', 'tray', 'doctor', 'recover'].includes(cmd) && positional[1]) ? path.resolve(positional[1]) : undefined;
  const repoRoot = typeof flags.repo === 'string' ? path.resolve(flags.repo) : (targetFromPositional ?? (cmd === 'mcp' ? process.env.CLAUDE_PROJECT_DIR : undefined) ?? process.cwd());

  if (flags.version || cmd === 'version') { console.log(KITH_VERSION); return; }
  if (flags.help || cmd === 'help') { printHelp(); return; }

  if (cmd === 'init') {
    const integrations = typeof flags.only === 'string' ? flags.only.split(',') : undefined;
    if (integrations?.some((name) => !INTEGRATIONS.includes(name as Integration))) {
      throw new Error(`--only accepts: ${INTEGRATIONS.join(', ')}`);
    }
    const report = initializeKithRepository(repoRoot, 'kith', {
      enforcement: enforcementMode(flags.enforcement), dryRun: Boolean(flags['dry-run']), mcpOnly: flags['mcp-only'] ? true : undefined, integrations: integrations as Integration[] | undefined,
    });
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
    return;
  }

  if (cmd === 'mcp') {
    await runKithMcpStdioServer(repoRoot, typeof flags.repo === 'string');
    return;
  }

  if (cmd === 'uninstall') { const report=uninstallKith(repoRoot,Boolean(flags['dry-run'])); console.log(JSON.stringify(report,null,2)); process.exitCode=report.ok?0:1; return; }

  if (cmd === 'doctor') { const report=doctorReport(repoRoot); console.log(JSON.stringify(report,null,2)); process.exitCode=report.ok?0:1; return; }

  if (cmd === 'prompt') {
    const prompts = buildSwarmPrompts(repoRoot);
    const role = subCmd === 'architect' || subCmd === 'worker' ? subCmd : undefined;
    if (flags.raw && role) { console.log(prompts[role]); return; }
    console.log(JSON.stringify({ ok: true, repository: repoRoot, ...(role ? { role, prompt: prompts[role] } : prompts) }, null, 2));
    return;
  }

  if (cmd === 'recover' || cmd === 'status' && flags.offline) {
    const state = cmd === 'recover' ? recoveryReport(repoRoot) : readCoordinationState(repoRoot);
    console.log(JSON.stringify(state,null,2)); process.exitCode = state.state === 'unavailable' ? 1 : 0; return;
  }

  if (cmd === 'setup' || cmd === 'auto-detect') {
    const targetDir = positional[1] ? path.resolve(positional[1]) : repoRoot;
    const gitVersion = execFileSync('git', ['--version'], {encoding:'utf8',stdio:'pipe',timeout:4000}).match(/(\d+)\.(\d+)/);
    if (!gitVersion || Number(gitVersion[1]) < 2 || Number(gitVersion[1]) === 2 && Number(gitVersion[2]) < 38) throw new Error('Install Git 2.38 or newer before Kith setup; no configuration was written.');
    const home = os.homedir(), dryRun = Boolean(flags['dry-run']);
    // Preflight every config and guidance file before retaining runtime or changing clients.
    autoConfigureAllClients(targetDir, home, {dryRun: true, guidance: true});
    const cliPath = setupRuntime(home, dryRun);
    if (!dryRun) await verifySetupRuntime(cliPath);
    const results = autoConfigureAllClients(targetDir, home, {dryRun, guidance: true, cliPath});
    console.log(`\n✨ Kith Auto-Detect & Setup for ${targetDir}\n`);
    for (const r of results) {
      const statusIcon = r.configured ? '✓' : r.found ? '!' : '✗';
      console.log(`  ${statusIcon} ${r.clientName.padEnd(24)} -> ${r.notes}`);
    }
    if (results.some(r => r.found && !r.configured)) process.exitCode = 1;
    console.log(`\n${dryRun ? 'Would retain' : 'Runtime retained at'}: ${cliPath}`);
    if (!dryRun) console.log('Retained server: MCP discovery passed. Client connection is checked in your client.');
    if (!results.some(r=>r.clientName==='Project instructions')) console.log('For project guidance, run setup with the Git checkout path.');
    if (process.platform === 'darwin' && !flags['no-radar']) {
      if (dryRun) console.log('Radar: would open the read-only menu-bar view.');
      else if (!process.exitCode) {
        try {
          const state = await startRadar(targetDir, cliPath);
          console.log(state === 'started' ? `Radar: opened for ${targetDir} (read-only; no model calls).` : 'Radar: already open; existing workspace kept. Use Switch Workspace in its menu if needed.');
        } catch (error) {
          console.error(`Radar did not open: ${(error as Error).message} Client configuration is retained. Retry setup, or use --no-radar for MCP-only setup.`);
          process.exitCode = 1;
        }
      } else console.log('Radar: not opened; resolve the setup entries above first.');
    }
    console.log('Restart/reconnect configured clients and approve Kith in their MCP controls.');
    console.log('Then ask your agent: Use Kith for this task; claim its files, use an isolated worktree and verify before integrating.');
    console.log('Setup does not claim work. The coordination view shows a task only after the agent begins it.');
    console.log('Existing hooks, permissions and custom launchers are preserved. Review skipped entries.\n');
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
    const targetDir = positional[1] ? path.resolve(positional[1]) : repoRoot;
    const notify = flags.notify !== 'false' && !flags['no-notify'];
    const intervalMs = typeof flags.interval === 'string' ? Number(flags.interval) : 2500;
    const isRaw = Boolean(flags.raw || flags.json);
    let lastScanError = '';
    const watcher = new PassiveConflictWatcher(targetDir, {
      intervalMs,
      notify: !isRaw && notify,
      onScanError: (errors) => {
        const message = errors.map(error => `${error.repository}: ${error.message}`).join('\n');
        if (!flags.once && message !== lastScanError) console.error(`Scan unavailable; retained overlaps may be stale:\n${message}`);
        lastScanError = message;
      },
      onCollision: (alert) => {
        if (!isRaw && !flags.once) {
          console.log(`\n⚠️ [WORKTREE OVERLAP] ${alert.message}`);
        }
      },
      onFileChange: (e) => {
        if (!flags.quiet && !isRaw && !flags.once) {
          console.log(`📝 [FILE MTIME] ${path.basename(e.repoPath)}/${e.filePath}`);
        }
      }
    });

    if (flags.once) {
      const alerts = await watcher.scanOnce();
      const state = watcher.getScanState();
      const repos = state.repos;
      const edits = watcher.getRecentEdits();
      if (!state.complete) process.exitCode = 1;

      if (flags.raw || flags.json) {
        console.log(JSON.stringify({ ...state, recentEdits: edits, collisions: alerts }, null, 2));
        return;
      }

      console.log(`\n📡 Kith Passive Radar: ${targetDir}`);
      console.log(`   Repositories (${repos.length}): ${repos.map(r => path.basename(r)).join(', ')}`);
      console.log(`   Recent Modified Files: ${edits.length}`);
      for (const row of state.worktrees) {
        const activity = { active: 'Active Kith lease', retained: 'Retained', unregistered: 'No Kith session', unknown: 'Ownership unavailable' }[row.activity];
        console.log(`   ${row.label} — ${activity}; ${row.dirtyFiles ?? 'unknown'} Git changes; ${row.sharedDirtyPaths} shared dirty paths`);
        console.log(`      ${row.path}${row.agentIds.length ? ` (${row.agentIds.join(', ')})` : ''}\n      ${row.detail}`);
      }

      if (!state.complete) {
        console.error(`Scan unavailable:\n${state.errors.map(error => error.message).join('\n')}`);
      } else if (alerts.length === 0) {
        console.log('\nNo differing or unverified shared dirty paths observed. Identical copies are excluded; compatibility is not verified.\n');
      } else {
        console.log(`\n  ⚠️  Review before integration: ${alerts.length} shared dirty paths:`);
        for (const a of alerts) {
          console.log(`   ⚠️ ${a.message}`);
        }
        console.log('');
      }
      return;
    }

    console.log(`\n👀 Kith Passive Conflict Radar watching: ${targetDir}`);

    console.log(`   Read-only overlap observations; this does not identify agents or verify compatibility. Press Ctrl+C to stop.\n`);
    watcher.start();
    await new Promise(() => {});
    return;
  }

  const commands = ['session', 'status', 'begin', 'complete', 'heartbeat', 'task', 'lock', 'contract', 'worktree', 'port', 'dev', 'mutex', 'hook'];
  if (!commands.includes(cmd)) throw new Error(`Unknown command '${cmd}'. Run kith help.`);
  const subcommands: Record<string, string[]> = {
    session: ['start', 'end'],
    task: ['add', 'claim', 'list'], lock: ['acquire', 'release', 'list'],
    contract: ['publish', 'list'], worktree: ['spawn', 'remove', 'list', 'preview'],
    hook: ['pre', 'post', 'pre-commit'],
  };
  if (subcommands[cmd] && (!subCmd || !subcommands[cmd].includes(subCmd))) {
    throw new Error(`Expected kith ${cmd} ${subcommands[cmd].join('|')}`);
  }
  const engine = new KithEngine(repoRoot);
  const agentId = String(flags.agent ?? process.env.KITH_AGENT_ID ?? `cli-${process.pid}`);
  const sessionToken = cmd === 'session' && subCmd === 'start' && flags.new ? undefined : typeof flags['session-token'] === 'string' ? flags['session-token']
    : (!process.env.KITH_AGENT_ID || process.env.KITH_AGENT_ID === agentId) ? process.env.KITH_SESSION_TOKEN : undefined;
  const authorize = () => {
    if (!sessionToken) throw new SessionOwnershipError(agentId);
    engine.fencing.resumeSession(agentId, sessionToken);
  };
  const register = () => engine.fencing.registerAgent({ id: agentId,
    client: String(flags.client ?? 'cli'), pid: typeof flags['owner-pid'] === 'string' ? Number(flags['owner-pid'])
      : ['mutex', 'dev'].includes(cmd) && !sessionToken ? process.pid : process.ppid,
    sessionToken, leaseDurationMs: typeof flags['lease-ms'] === 'string' ? Number(flags['lease-ms']) : undefined,
  });
  try {
    if (cmd === 'session') {
      if (subCmd === 'end') {
        authorize(); engine.fencing.abandonAgentSession(agentId);
        console.log(JSON.stringify({ ok: true })); return;
      }
      if (flags.shell && typeof flags['owner-pid'] !== 'string') {
        throw new Error('Shell exports require --owner-pid "$$" so command substitution cannot anchor the session to a transient subshell.');
      }
      const session = register();
      if (flags.shell) {
        const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
        console.log(`export KITH_AGENT_ID=${quote(agentId)}\nexport KITH_SESSION_TOKEN=${quote(session.sessionToken)}`);
      } else console.log(JSON.stringify(session, null, 2));
      return;
    }
    if (cmd === 'heartbeat') {
      authorize();
      if (!engine.fencing.heartbeat(agentId)) throw new Error('Active --agent <id> required');
      console.log(JSON.stringify({ ok: true, agent: engine.fencing.getAgent(agentId) }, null, 2));
      return;
    }

    if (cmd === 'status') {
      const state = engine.getStatus();
      console.log(JSON.stringify(state, null, 2));
      return;
    }

    if (cmd === 'begin') {
      const title = String(flags.title ?? flags.intent ?? 'Active work');
      const scopeRaw = typeof flags.scope === 'string' ? flags.scope : '';
      const scopeGlobs = scopeRaw ? scopeRaw.split(',').map((s) => s.trim()) : ['**'];

      const session = register();

      const options = {
        agentId,
        title,
        intentSummary: typeof flags.summary === 'string' ? flags.summary : title,
        scopeGlobs,
        isolateWorktree: Boolean(flags.worktree),
      };
      const res = flags.wait || flags['wait-ms'] !== undefined
        ? await interruptible((signal) => engine.beginWorkWhenAvailable({ ...options, signal,
          waitTimeoutMs: claimWaitTimeout() }))
        : engine.beginWork(options);
      if (!res) { if (!sessionToken) engine.fencing.abandonAgentSession(agentId); return; }

      console.log(JSON.stringify({ ...res, sessionToken: session.sessionToken }, null, 2));
      process.exitCode = res.ok ? 0 : 1;
      return;
    }

    if (cmd === 'complete') {
      authorize();
      const result = engine.completeWork({
        agentId, mergeBranch: typeof flags.merge === 'string' ? flags.merge : undefined,
        verificationCmd: typeof flags.verify === 'string' ? flags.verify : undefined,
      });
      (result.ok ? console.log : console.error)(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    if (cmd === 'task') {
      if (subCmd === 'add') {
        const title = String(flags.title ?? 'Task');
        const dependsOn =
          typeof flags['depends-on'] === 'string'
            ? flags['depends-on'].split(',').map((s) => s.trim())
            : [];
        const scopeGlobs =
          typeof flags.scope === 'string'
            ? flags.scope.split(',').map((s) => s.trim())
            : [];
        const priority = typeof flags.priority === 'string' ? Number(flags.priority) : 10;
        const task = engine.intents.addTask({
          id: typeof flags.id === 'string' ? flags.id : undefined,
          title,
          dependsOn,
          scopeGlobs,
          priority,
        });
        console.log(JSON.stringify({ ok: true, task }, null, 2));
        return;
      }
      if (subCmd === 'claim') {
        const session = register();
        const options = { agentId, isolateWorktree: Boolean(flags.worktree) };
        const res = flags.wait || flags['wait-ms'] !== undefined
          ? await interruptible((signal) => engine.claimNextTaskWhenAvailable({ ...options, signal,
            waitTimeoutMs: claimWaitTimeout() }))
          : engine.claimNextTask(options);
        if (!res) { if (!sessionToken) engine.fencing.abandonAgentSession(agentId); return; }
        console.log(JSON.stringify({ ...res, sessionToken: session.sessionToken }, null, 2));
        process.exitCode = res.claimed ? 0 : 1;
        return;
      }
      console.log(JSON.stringify(engine.intents.listTasks(), null, 2));
      return;
    }

    if (cmd === 'lock') {
      if (subCmd === 'acquire') {
        const patterns = String(flags.patterns ?? flags.scope ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const session = register();
        const res = flags.wait || flags['wait-ms'] !== undefined
          ? await interruptible((signal) => engine.acquireLocksWhenAvailable({ agentId, patterns, signal,
            waitTimeoutMs: claimWaitTimeout() }))
          : engine.locks.acquireLocks({ agentId, patterns });
        if (!res) { if (!sessionToken) engine.fencing.abandonAgentSession(agentId); return; }
        console.log(JSON.stringify({ ...res, sessionToken: session.sessionToken }, null, 2));
        process.exitCode = res.ok ? 0 : 1;
        return;
      }
      if (subCmd === 'release') {
        authorize();
        const released = engine.locks.releaseLocks({ agentId });
        console.log(JSON.stringify({ ok: true, released }, null, 2));
        return;
      }
      console.log(JSON.stringify(engine.locks.listLocks(), null, 2));
      return;
    }

    if (cmd === 'contract') {
      if (subCmd === 'publish') {
        authorize();
        const contract = engine.depGraph.publishExplicitContract({
          agentId,
          filePath: String(flags.file ?? 'unknown'),
          symbolName: String(flags.symbol ?? 'unknown'),
          kind: (flags.kind as 'function') ?? 'function',
          signature: String(flags.signature ?? ''),
        });
        console.log(JSON.stringify({ ok: true, contract }, null, 2));
        return;
      }
      console.log(JSON.stringify(engine.depGraph.listContracts(), null, 2));
      return;
    }

    if (cmd === 'worktree') {
      if (subCmd === 'preview') { authorize(); const result=engine.previewIntegration(agentId); console.log(JSON.stringify(result,null,2)); process.exitCode=result.ok && result.clean ? 0 : 1; return; }
      if (subCmd === 'spawn') {
        const session = register();
        const wt = engine.worktrees.spawnWorktree({
          agentId,
          branch: typeof flags.branch === 'string' ? flags.branch : undefined,
        });
        console.log(JSON.stringify({ ok: true, worktree: wt, sessionToken: session.sessionToken }, null, 2));
        return;
      }
      if (subCmd === 'remove') {
        authorize();
        engine.worktrees.removeWorktree(agentId);
        console.log(JSON.stringify({ ok: true }, null, 2));
        return;
      }
      console.log(JSON.stringify(engine.worktrees.listWorktrees(), null, 2));
      return;
    }

    if (cmd === 'port') {
      const serviceName = String(flags.service ?? flags.name ?? 'web');
      const basePort = typeof flags.base === 'string' ? Number(flags.base) : 3100;
      const session = register();
      const res = await engine.broker.acquirePort({ agentId, serviceName, basePort });
      if (flags.raw) {
        console.log(res.port);
      } else {
        console.log(JSON.stringify({ ...res, sessionToken: session.sessionToken }, null, 2));
      }
      return;
    }

    if (cmd === 'mutex' || cmd === 'dev') {
      const mutexName = String(flags.name ?? 'default-mutex');
      const commandToRun = passthroughCmd.length ? passthroughCmd : String(flags.cmd ?? '');
      if (cmd === 'dev' && (!passthroughCmd.length || !passthroughCmd[0])) throw new Error('Provide a literal command after `--` for kith dev');
      if (!commandToRun) {
        console.error('Error: provide a command after `--` for `kith mutex`');
        process.exitCode = 1;
        return;
      }
      register();
      const controller = new AbortController();
      let interrupted: NodeJS.Signals | undefined;
      const interrupt = (signal: NodeJS.Signals) => { interrupted = signal; controller.abort(); };
      const sigint = () => interrupt('SIGINT');
      const sigterm = () => interrupt('SIGTERM');
      process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
      try {
        const shared = {
          agentId, signal: controller.signal,
          leaseDurationMs: typeof flags['lease-ms'] === 'string' ? Number(flags['lease-ms']) : undefined,
          timeoutMs: typeof flags['wait-ms'] === 'string' ? Number(flags['wait-ms']) : undefined,
          commandTimeoutMs: typeof flags['timeout-ms'] === 'string' ? Number(flags['timeout-ms']) : undefined,
          onStdout: (chunk: Buffer) => process.stdout.write(chunk), onStderr: (chunk: Buffer) => process.stderr.write(chunk),
        };
        const res = cmd === 'dev'
          ? await engine.broker.executeWithPort({ ...shared, command: passthroughCmd,
            serviceName: String(flags.service ?? 'web'), basePort: flags.base === undefined ? 3000 : Number(flags.base),
            cwd: path.resolve(engine.fencing.getAgent(agentId)?.worktree_path ?? engine.coordDb.repoRoot, typeof flags.cwd === 'string' ? flags.cwd : '.'),
            onPort: (port) => process.stderr.write(`Kith: ${String(flags.service ?? 'web')} allocated port ${port} (PORT, KITH_PORT, {port})\n`),
          })
          : await engine.broker.executeWithMutex({ ...shared, mutexName, command: commandToRun });
        process.exitCode = res.exitCode;
      } catch (err) {
        if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
        else throw err;
      } finally {
        process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
        if (!sessionToken) {
          try { engine.fencing.completeAgentSession(agentId); }
          catch (err) { if (!(err instanceof SessionOwnershipError)) throw err; }
        }
      }
      return;
    }

    if (cmd === 'hook') {
      const handler = new HookHandler(engine, enforcementMode(flags.enforcement));
      const stdinPayload = HookHandler.readJsonStdinSync();
      const agentId = HookHandler.resolveAgentId(
        stdinPayload,
        typeof flags.agent === 'string' ? flags.agent : undefined
      );
      if (!sessionToken) throw new SessionOwnershipError(agentId);
      engine.fencing.resumeSession(agentId, sessionToken);
      const toolName = String(
        flags.tool ?? stdinPayload?.tool_name ?? 'Edit'
      );
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
        const res = handler.handlePreToolUse({
          agentId,
          toolName,
          filePath,
          command,
        });
        if (flags.client === 'cursor') {
          console.log(JSON.stringify({ permission: res.allowed ? 'allow' : 'deny', ...(res.message ? { user_message: res.message, agent_message: res.message } : {}) }));
        } else if (!res.allowed) console.error(res.message);
        else if (res.message) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: res.message } }));
        process.exitCode = res.exitCode;
        return;
      }

      if (subCmd === 'post') {
        const res = handler.handlePostToolUse({
          agentId,
          toolName,
          filePath,
          command,
        });
        if (flags.client === 'cursor') {
          console.log(JSON.stringify({ additional_context: [...res.warnings, res.deltaFooter].filter(Boolean).join('\n') }));
          process.exitCode = res.exitCode;
          return;
        }
        if (res.warnings.length > 0 || res.deltaFooter) {
          const msg = [...res.warnings, res.deltaFooter].filter(Boolean).join('\n');
          if (!res.allowed) {
            console.error(msg);
          } else {
            console.log(
              JSON.stringify({
                systemMessage: msg,
                hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
              })
            );
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
    }
  } finally {
    engine.close();
  }
}

function printHelp(): void {
  console.log(`Kith (v${KITH_VERSION}) — Local coordination for coding agents

Claim work, isolate changes with worktrees, share local resources, and verify integration.
No hosted service required.

Usage:
  kith session start --agent <id> --owner-pid <pid> [--shell]    Create or resume a capability-owned session\n  kith init                                       Configure MCP clients (--dry-run, --only, --mcp-only)
  kith heartbeat --agent <id>                   Refresh the owned session lease
  kith status [--offline]                         Output JSON state and workspaces; offline never migrates or reaps\n  kith uninstall [--dry-run]                      Restore unchanged tracked setup files; retain work and recovery state\n  kith doctor                                     Check runtime, PATH, configuration, sessions and worktree health without writes\n  kith recover                                    Inspect retained work, expired claims and recovery records offline
  kith setup [checkout] [--no-radar] [--dry-run]    Configure clients and open macOS Radar; preserve custom settings
  kith watch [checkout] [--once --json]            Observe linked-worktree path overlaps without enforcement
  kith menubar [checkout]                         Optional read-only macOS view
  kith mcp --repo <checkout>                      Start stdio MCP server bound to a project
  kith begin --agent <id> --title <t> --scope <g> Declare intent, check overlaps, lock scope
  kith complete --agent <id> [--merge <branch>]   Run Speculative Merge Train & release locks
  kith task add|claim|list                        Manage orchestrated DAG task queue
  kith lock acquire|release|list                  Manage fencing-token file/glob locks
  kith contract publish|list                      Manage Contract Blackboard
  kith worktree spawn|remove|list|preview                 Manage isolated Git worktrees
  kith port --agent <id> --service <name>         Reserve an available TCP port
  kith dev --agent <id> -- <cmd>                Run with PORT and {port} argument substitution
  kith begin/lock acquire ... --wait --wait-ms 60000  Wait for a scope claim (bounded, cancellable)
  kith mutex --agent <id> --name <m> -- <cmd>     Serialize commands via mutex
  kith hook pre|post|pre-commit                   Tool & git hook handlers
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  const args = process.argv.slice(2);
  process.exitCode = args.includes('hook') && args.includes('pre') ? 2 : 1;
});
