#!/usr/bin/env node
import { KithEngine } from '../core/engine.js';
import { runKithMcpStdioServer } from '../mcp/server.js';
import { runLiveDashboard } from '../tui/dashboard.js';
import { HookHandler } from './hook-handler.js';
import { initializeKithRepository } from './init.js';

function parseFlags(argv: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
  passthroughCmd: string;
} {
  const dashDashIdx = argv.indexOf('--');
  const mainArgs = dashDashIdx >= 0 ? argv.slice(0, dashDashIdx) : argv;
  const passthroughCmd = dashDashIdx >= 0 ? argv.slice(dashDashIdx + 1).join(' ') : '';

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
        if (next && !next.startsWith('--')) {
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

async function main(): Promise<void> {
  const { positional, flags, passthroughCmd } = parseFlags(process.argv.slice(2));
  const cmd = positional[0] ?? 'help';
  const subCmd = positional[1];
  const repoRoot = typeof flags.repo === 'string' ? flags.repo : process.cwd();

  if (cmd === 'init') {
    const report = initializeKithRepository(repoRoot);
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
    return;
  }

  if (cmd === 'mcp') {
    await runKithMcpStdioServer(repoRoot);
    return;
  }

  if (cmd === 'top' || cmd === 'ui') {
    await runLiveDashboard(repoRoot, { once: Boolean(flags.once) });
    return;
  }

  const engine = new KithEngine(repoRoot);
  try {
    if (cmd === 'status') {
      const state = {
        fencingEpoch: engine.coordDb.currentFencingEpoch(),
        agents: engine.fencing.listAgents(true),
        locks: engine.locks.listLocks(),
        tasks: engine.intents.listTasks(),
        conflicts: engine.shadowGit.listConflicts(),
        contracts: engine.depGraph.listContracts(),
        resources: engine.broker.listResources(),
        mergeQueue: engine.mergeTrain.listQueue(),
        quarantined: engine.bashGuard.listQuarantined(),
      };
      console.log(JSON.stringify(state, null, 2));
      return;
    }

    if (cmd === 'begin') {
      const agentId = String(flags.agent ?? process.env.KITH_AGENT_ID ?? `cli-${process.pid}`);
      const title = String(flags.title ?? flags.intent ?? 'Active work');
      const scopeRaw = typeof flags.scope === 'string' ? flags.scope : '';
      const scopeGlobs = scopeRaw ? scopeRaw.split(',').map((s) => s.trim()) : ['**'];

      engine.fencing.registerAgent({
        id: agentId,
        client: String(flags.client ?? 'cli'),
      });

      const res = engine.intents.declareIntent({
        agentId,
        title,
        intentSummary: typeof flags.summary === 'string' ? flags.summary : title,
        scopeGlobs,
        force: Boolean(flags.force),
      });

      let worktree = null;
      if (res.ok && flags.worktree) {
        worktree = engine.worktrees.spawnWorktree({ agentId });
      }

      console.log(JSON.stringify({ ...res, worktree }, null, 2));
      process.exitCode = res.ok ? 0 : 1;
      return;
    }

    if (cmd === 'complete') {
      const agentId = String(flags.agent ?? process.env.KITH_AGENT_ID ?? '');
      if (!agentId) {
        console.error('Error: --agent <id> is required for `kith complete`');
        process.exitCode = 1;
        return;
      }

      const agent = engine.fencing.getAgent(agentId);
      let mergeResult = null;
      const mergeBranch =
        typeof flags.merge === 'string' ? flags.merge : agent?.branch ?? undefined;

      if (mergeBranch) {
        mergeResult = engine.mergeTrain.enqueueAndMerge({
          agentId,
          branch: mergeBranch,
          worktreePath: agent?.worktree_path,
          verificationCmd: typeof flags.verify === 'string' ? flags.verify : null,
        });
        if (!mergeResult.merged) {
          console.error(JSON.stringify({ ok: false, mergeResult }, null, 2));
          process.exitCode = 1;
          return;
        }
        if (agent?.worktree_path) {
          engine.worktrees.removeWorktree(agentId);
        }
      }

      const completedTasks = engine.intents.completeTask({ agentId });
      engine.fencing.completeAgentSession(agentId);
      console.log(JSON.stringify({ ok: true, completedTasks, mergeResult }, null, 2));
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
        const agentId = String(flags.agent ?? process.env.KITH_AGENT_ID ?? `cli-${process.pid}`);
        engine.fencing.registerAgent({ id: agentId, client: 'cli' });
        const res = engine.intents.claimNextTask(agentId);
        console.log(JSON.stringify(res, null, 2));
        process.exitCode = res.claimed ? 0 : 1;
        return;
      }
      console.log(JSON.stringify(engine.intents.listTasks(), null, 2));
      return;
    }

    if (cmd === 'lock') {
      const agentId = String(flags.agent ?? process.env.KITH_AGENT_ID ?? `cli-${process.pid}`);
      if (subCmd === 'acquire') {
        const patterns = String(flags.patterns ?? flags.scope ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        engine.fencing.registerAgent({ id: agentId, client: 'cli' });
        const res = engine.locks.acquireLocks({ agentId, patterns });
        console.log(JSON.stringify(res, null, 2));
        process.exitCode = res.ok ? 0 : 1;
        return;
      }
      if (subCmd === 'release') {
        const released = engine.locks.releaseLocks({ agentId });
        console.log(JSON.stringify({ ok: true, released }, null, 2));
        return;
      }
      console.log(JSON.stringify(engine.locks.listLocks(), null, 2));
      return;
    }

    if (cmd === 'contract') {
      if (subCmd === 'publish') {
        const agentId = String(flags.agent ?? process.env.KITH_AGENT_ID ?? `cli-${process.pid}`);
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
      const agentId = String(flags.agent ?? process.env.KITH_AGENT_ID ?? `cli-${process.pid}`);
      if (subCmd === 'spawn') {
        engine.fencing.registerAgent({ id: agentId, client: 'cli' });
        const wt = engine.worktrees.spawnWorktree({
          agentId,
          branch: typeof flags.branch === 'string' ? flags.branch : undefined,
        });
        console.log(JSON.stringify({ ok: true, worktree: wt }, null, 2));
        return;
      }
      if (subCmd === 'remove') {
        engine.worktrees.removeWorktree(agentId);
        console.log(JSON.stringify({ ok: true }, null, 2));
        return;
      }
      console.log(JSON.stringify(engine.worktrees.listWorktrees(), null, 2));
      return;
    }

    if (cmd === 'port') {
      const agentId = String(flags.agent ?? process.env.KITH_AGENT_ID ?? `cli-${process.pid}`);
      const serviceName = String(flags.service ?? flags.name ?? 'web');
      const basePort = typeof flags.base === 'string' ? Number(flags.base) : 3100;
      engine.fencing.registerAgent({ id: agentId, client: 'cli' });
      const res = await engine.broker.acquirePort({ agentId, serviceName, basePort });
      if (flags.raw) {
        console.log(res.port);
      } else {
        console.log(JSON.stringify(res, null, 2));
      }
      return;
    }

    if (cmd === 'mutex') {
      const agentId = String(flags.agent ?? process.env.KITH_AGENT_ID ?? `cli-${process.pid}`);
      const mutexName = String(flags.name ?? 'default-mutex');
      const commandToRun = passthroughCmd || String(flags.cmd ?? '');
      if (!commandToRun) {
        console.error('Error: provide a command after `--` for `kith mutex`');
        process.exitCode = 1;
        return;
      }
      engine.fencing.registerAgent({ id: agentId, client: 'cli' });
      const res = engine.broker.executeWithMutex({
        agentId,
        mutexName,
        command: commandToRun,
      });
      if (res.stdout) process.stdout.write(res.stdout);
      return;
    }

    if (cmd === 'hook') {
      const handler = new HookHandler(engine);
      const stdinPayload = HookHandler.readJsonStdinSync();
      const agentId = HookHandler.resolveAgentId(
        stdinPayload,
        typeof flags.agent === 'string' ? flags.agent : undefined
      );
      const toolName = String(
        flags.tool ?? stdinPayload?.tool_name ?? 'Edit'
      );
      const filePath =
        typeof flags.file === 'string'
          ? flags.file
          : stdinPayload?.tool_input?.file_path ??
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
        if (!res.allowed) {
          console.error(res.message);
        }
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
        if (res.warnings.length > 0 || res.deltaFooter) {
          const msg = [...res.warnings, res.deltaFooter].filter(Boolean).join('\n');
          if (!res.allowed) {
            console.error(msg);
          } else {
            console.log(
              JSON.stringify({
                systemMessage: msg,
                additionalContext: msg,
              })
            );
          }
        }
        process.exitCode = res.exitCode;
        return;
      }

      if (subCmd === 'pre-commit') {
        const res = handler.handleGitPreCommit(agentId);
        if (!res.allowed) {
          console.error(
            `[KITH GIT PRE-COMMIT GUARD] Cannot commit files locked by sibling agents:\n` +
              res.violations.map((v) => `  - ${v}`).join('\n')
          );
        }
        process.exitCode = res.exitCode;
        return;
      }
    }

    console.log(`Kith (v1.0.0) — Zero-Trust Parallel Agent Coordination Engine

Usage:
  kith init                                       Auto-configure repo (Claude, Cursor, Antigravity, Codex, Git hooks)
  kith top [--once]                               Launch live TUI dashboard
  kith status                                     Output JSON coordination state
  kith mcp                                        Start stdio MCP server
  kith begin --agent <id> --title <t> --scope <g> Declare intent, check overlaps, lock scope
  kith complete --agent <id> [--merge <branch>]   Run Speculative Merge Train & release locks
  kith task add|claim|list                        Manage orchestrated DAG task queue
  kith lock acquire|release|list                  Manage fencing-token file/glob locks
  kith contract publish|list                      Manage Contract Blackboard
  kith worktree spawn|remove|list                 Manage instant CoW git worktrees
  kith port --agent <id> --service <name>         Lease collision-free TCP port
  kith mutex --agent <id> --name <m> -- <cmd>     Serialize commands via FIFO mutex
  kith hook pre|post|pre-commit                   Zero-trust tool & git hook handlers
`);
  } finally {
    engine.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
