import path from 'node:path';
import { KithEngine } from '../core/engine.js';
import { SessionOwnershipError } from '../core/fencing.js';
import { AGENT_HANDOFF_KINDS, handoffBlock, type WriteHandoffParams } from '../core/handoffs.js';
import { parseWorkflowMode, WORKFLOW_MODES } from '../core/mode.js';
import { listRepoPresence, resolveHomeDir } from './auto-session.js';
import { interruptible } from './flags.js';
import { formatStatusHuman, formatTasksHuman, shouldUseHumanOutput } from './format.js';

const ENGINE_COMMANDS = [
  'session', 'status', 'begin', 'complete', 'heartbeat', 'task',
  'lock', 'contract', 'worktree', 'port', 'dev', 'mutex', 'handoff', 'mode', 'commit',
] as const;

const SUBCOMMANDS: Record<string, string[]> = {
  session: ['start', 'end', 'clear'],
  task: ['add', 'claim', 'list'],
  lock: ['acquire', 'release', 'list'],
  contract: ['publish', 'list'],
  worktree: ['spawn', 'remove', 'list', 'preview'],
  handoff: ['write', 'list'],
};

export async function runEngineCommand(params: {
  cmd: string;
  subCmd: string | undefined;
  positional?: string[];
  flags: Record<string, string | boolean>;
  passthroughCmd: string[];
  repoRoot: string;
}): Promise<void> {
  const { cmd, subCmd, positional = [], flags, passthroughCmd, repoRoot } = params;
  if (!(ENGINE_COMMANDS as readonly string[]).includes(cmd)) {
    throw new Error(`Unknown command '${cmd}'. Run kith help.`);
  }
  if (SUBCOMMANDS[cmd] && (!subCmd || !SUBCOMMANDS[cmd].includes(subCmd))) {
    throw new Error(`Expected kith ${cmd} ${SUBCOMMANDS[cmd].join('|')}`);
  }

  const claimWaitTimeout = () => {
    const value = flags['wait-ms'];
    if (value !== undefined && typeof value !== 'string') throw new Error('--wait-ms requires a millisecond value');
    return value === undefined ? 60000 : Number(value);
  };

  const engine = new KithEngine(repoRoot);
  const agentId = String(flags.agent ?? process.env.KITH_AGENT_ID ?? `cli-${process.pid}`);
  const sessionToken = cmd === 'session' && subCmd === 'start' && flags.new
    ? undefined
    : typeof flags['session-token'] === 'string'
      ? flags['session-token']
      : (!process.env.KITH_AGENT_ID || process.env.KITH_AGENT_ID === agentId) ? process.env.KITH_SESSION_TOKEN : undefined;

  const authorize = () => {
    if (!sessionToken) throw new SessionOwnershipError(agentId);
    engine.fencing.resumeSession(agentId, sessionToken);
  };
  const register = () => engine.fencing.registerAgent({
    id: agentId,
    client: String(flags.client ?? 'cli'),
    pid: typeof flags['owner-pid'] === 'string'
      ? Number(flags['owner-pid'])
      : ['mutex', 'dev'].includes(cmd) && !sessionToken ? process.pid : process.ppid,
    sessionToken,
    leaseDurationMs: typeof flags['lease-ms'] === 'string' ? Number(flags['lease-ms']) : undefined,
  });

  try {
    if (cmd === 'session') {
      if (subCmd === 'end') {
        authorize();
        engine.fencing.abandonAgentSession(agentId);
        console.log(JSON.stringify({ ok: true }));
        return;
      }
      if (flags.shell && typeof flags['owner-pid'] !== 'string') {
        throw new Error('Shell exports require --owner-pid "$$" so command substitution cannot anchor the session to a transient subshell.');
      }
      const session = register();
      if (flags.shell) {
        const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
        console.log(`export KITH_AGENT_ID=${quote(agentId)}\nexport KITH_SESSION_TOKEN=${quote(session.sessionToken)}`);
      } else {
        console.log(JSON.stringify(session, null, 2));
      }
      return;
    }

    if (cmd === 'heartbeat') {
      authorize();
      if (!engine.fencing.heartbeat(agentId)) throw new Error('Active --agent <id> required');
      console.log(JSON.stringify({ ok: true, agent: engine.fencing.getAgent(agentId) }, null, 2));
      return;
    }

    if (cmd === 'mode') {
      if (subCmd === undefined) {
        console.log(JSON.stringify({
          ok: true,
          mode: engine.workflowMode(),
          configured: engine.workflowModeConfigured(),
          modes: WORKFLOW_MODES,
        }, null, 2));
        return;
      }
      console.log(JSON.stringify({
        ok: true,
        mode: engine.setWorkflowMode(parseWorkflowMode(subCmd)),
        configured: true,
      }, null, 2));
      return;
    }

    if (cmd === 'commit') {
      const message = typeof flags.message === 'string'
        ? flags.message
        : typeof flags.m === 'string'
          ? flags.m
          : '';
      const fromFlag = typeof flags.files === 'string'
        ? flags.files.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const files = [...fromFlag, ...positional.slice(1), ...passthroughCmd];
      const explicitAgent = typeof flags.agent === 'string' ? flags.agent : process.env.KITH_AGENT_ID;
      const res = engine.commit({
        agentId: explicitAgent,
        sessionToken,
        message,
        files: files.length > 0 ? files : undefined,
        callerPid: process.ppid || process.pid,
      });
      if (shouldUseHumanOutput(flags)) {
        if (res.ok) {
          console.log(`Committed ${res.commit?.slice(0, 7)} on ${res.branch ?? 'HEAD'} (${res.files.length} file(s): ${res.files.join(', ')})`);
        } else {
          console.error(res.error ?? 'Commit failed');
        }
      } else {
        (res.ok ? console.log : console.error)(JSON.stringify(res, null, 2));
      }
      process.exitCode = res.ok ? 0 : 1;
      return;
    }

    if (cmd === 'handoff') {
      const text = (value: string | boolean | undefined) => typeof value === 'string' ? value : undefined;
      if (subCmd === 'list') {
        const limit = text(flags.limit) === undefined ? undefined : Number(flags.limit);
        const records = engine.handoffs.list({
          taskId: text(flags.task),
          agentId: text(flags.from),
          includeResolved: Boolean(flags.all),
          limit,
        });
        console.log(JSON.stringify(handoffBlock(records, { summaryMax: 4000, filesMax: 100 }), null, 2));
        return;
      }
      authorize();
      // List values are separated with semicolons so a sentence can contain commas.
      const items = (value: string | boolean | undefined) => (text(value) ?? '').split(';').map(item => item.trim()).filter(Boolean);
      const kind = (text(flags.kind) ?? 'progress') as WriteHandoffParams['kind'];
      if (!AGENT_HANDOFF_KINDS.includes(kind)) throw new Error(`--kind must be one of ${AGENT_HANDOFF_KINDS.join(', ')}.`);
      const written = engine.handoffs.write({
        agentId,
        taskId: text(flags.task),
        kind,
        summary: text(flags.summary) ?? '',
        done: items(flags.done),
        remaining: items(flags.remaining),
        learned: items(flags.learned),
        failed: items(flags.failed),
        files: items(flags.files),
        transcriptRef: text(flags['transcript-ref']),
        releaseTask: Boolean(flags.release),
      });
      console.log(JSON.stringify({
        ok: true,
        released: written.released,
        handoffId: written.handoff.id,
        taskId: written.handoff.task_id,
        filesRecorded: written.handoff.files.length,
      }, null, 2));
      return;
    }

    if (cmd === 'status') {
      const state = engine.getStatus();
      const presencePeers = engine.coordDb.commonGitDir
        ? listRepoPresence(resolveHomeDir(), engine.coordDb.commonGitDir)
        : [];
      const enriched = presencePeers.length ? { ...state, presencePeers } : state;
      console.log(shouldUseHumanOutput(flags) ? formatStatusHuman(enriched) : JSON.stringify(enriched, null, 2));
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
        ? await interruptible((signal) => engine.beginWorkWhenAvailable({ ...options, signal, waitTimeoutMs: claimWaitTimeout() }))
        : engine.beginWork(options);
      if (!res) { if (!sessionToken) engine.fencing.abandonAgentSession(agentId); return; }
      console.log(JSON.stringify({ ...res, sessionToken: session.sessionToken }, null, 2));
      process.exitCode = res.ok ? 0 : 1;
      return;
    }

    if (cmd === 'complete') {
      authorize();
      const result = engine.completeWork({
        agentId,
        mergeBranch: typeof flags.merge === 'string' ? flags.merge : undefined,
        verificationCmd: typeof flags.verify === 'string' ? flags.verify : undefined,
      });
      (result.ok ? console.log : console.error)(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    if (cmd === 'task') {
      if (subCmd === 'add') {
        const title = String(flags.title ?? 'Task');
        const dependsOn = typeof flags['depends-on'] === 'string' ? flags['depends-on'].split(',').map((s) => s.trim()) : [];
        const scopeGlobs = typeof flags.scope === 'string' ? flags.scope.split(',').map((s) => s.trim()) : [];
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
          ? await interruptible((signal) => engine.claimNextTaskWhenAvailable({ ...options, signal, waitTimeoutMs: claimWaitTimeout() }))
          : engine.claimNextTask(options);
        if (!res) { if (!sessionToken) engine.fencing.abandonAgentSession(agentId); return; }
        console.log(JSON.stringify({ ...res, sessionToken: session.sessionToken }, null, 2));
        process.exitCode = res.claimed ? 0 : 1;
        return;
      }
      const tasks = engine.intents.listTasks();
      console.log(shouldUseHumanOutput(flags) ? formatTasksHuman(tasks) : JSON.stringify(tasks, null, 2));
      return;
    }

    if (cmd === 'lock') {
      if (subCmd === 'acquire') {
        const patterns = String(flags.patterns ?? flags.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const session = register();
        const res = flags.wait || flags['wait-ms'] !== undefined
          ? await interruptible((signal) => engine.acquireLocksWhenAvailable({ agentId, patterns, signal, waitTimeoutMs: claimWaitTimeout() }))
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
      if (subCmd === 'preview') {
        authorize();
        const result = engine.previewIntegration(agentId);
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.ok && result.clean ? 0 : 1;
        return;
      }
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
      if (flags.raw) console.log(res.port);
      else console.log(JSON.stringify({ ...res, sessionToken: session.sessionToken }, null, 2));
      return;
    }

    if (cmd === 'mutex' || cmd === 'dev') {
      const mutexName = String(flags.name ?? 'default-mutex');
      const commandToRun = passthroughCmd.length ? passthroughCmd : String(flags.cmd ?? '');
      if (cmd === 'dev' && (!passthroughCmd.length || !passthroughCmd[0])) {
        throw new Error('Provide a literal command after `--` for kith dev');
      }
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
      process.on('SIGINT', sigint);
      process.on('SIGTERM', sigterm);
      try {
        const shared = {
          agentId,
          signal: controller.signal,
          leaseDurationMs: typeof flags['lease-ms'] === 'string' ? Number(flags['lease-ms']) : undefined,
          timeoutMs: typeof flags['wait-ms'] === 'string' ? Number(flags['wait-ms']) : undefined,
          commandTimeoutMs: typeof flags['timeout-ms'] === 'string' ? Number(flags['timeout-ms']) : undefined,
          onStdout: (chunk: Buffer) => process.stdout.write(chunk),
          onStderr: (chunk: Buffer) => process.stderr.write(chunk),
        };
        const res = cmd === 'dev'
          ? await engine.broker.executeWithPort({
            ...shared,
            command: passthroughCmd,
            serviceName: String(flags.service ?? 'web'),
            basePort: flags.base === undefined ? 3000 : Number(flags.base),
            cwd: path.resolve(engine.fencing.getAgent(agentId)?.worktree_path ?? engine.coordDb.repoRoot, typeof flags.cwd === 'string' ? flags.cwd : '.'),
            onPort: (port) => process.stderr.write(`Kith: ${String(flags.service ?? 'web')} allocated port ${port} (PORT, KITH_PORT, {port})\n`),
          })
          : await engine.broker.executeWithMutex({ ...shared, mutexName, command: commandToRun });
        process.exitCode = res.exitCode;
      } catch (err) {
        if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
        else throw err;
      } finally {
        process.off('SIGINT', sigint);
        process.off('SIGTERM', sigterm);
        if (!sessionToken) {
          try { engine.fencing.completeAgentSession(agentId); }
          catch (err) { if (!(err instanceof SessionOwnershipError)) throw err; }
        }
      }
    }
  } finally {
    engine.close();
  }
}
