import { KITH_VERSION } from '../version.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { KithEngine } from '../core/engine.js';

export function createKithMcpServer(repoRoot = process.cwd()): {
  server: McpServer;
  engine: KithEngine;
} {
  const engine = new KithEngine(repoRoot);
  const server = new McpServer({
    name: 'kith-coordinator',
    version: KITH_VERSION,
  }, { instructions: 'Kith coordinates work claims, isolated worktrees, local resources and verified integration for cooperating coding agents. State stays local; no hosted service or model API key is required. Recommended workflow: one isolated worktree per parallel agent. Call kith_begin_work with isolateWorktree:true and explicit scopeGlobs; edit only the returned worktreePath, call kith_record_file_edit, run literal argv with kith_run_with_mutex, and finish with kith_complete_work plus a project verificationCmd. Heartbeat before the session expires. ' + (process.env.KITH_AGENT_ID
    ? `This server shares a session with CLI/hooks. Use agentId '${process.env.KITH_AGENT_ID}'. Its inherited capability is handled internally; do not request or log it.`
    : 'Start with kith_begin_work or kith_start_session and a unique agentId. This connection retains its granted capability. Omit sessionToken on subsequent calls on this connection; only another connection needs it to resume that ID. Initial grant/resume replies contain the token and client transcripts may record it. Keep transcripts private.'
  ) });

  const tokenFor = (args: { agentId: string; sessionToken?: string }) => args.sessionToken ??
    (process.env.KITH_AGENT_ID === args.agentId ? process.env.KITH_SESSION_TOKEN : undefined);
  const owned = new Set<string>();
  const register = (args: { agentId: string; client?: string; sessionToken?: string; leaseDurationMs?: number }) => {
    const result = engine.fencing.registerAgent({ id: args.agentId, client: args.client ?? 'mcp',
      sessionToken: tokenFor(args), leaseDurationMs: args.leaseDurationMs });
    if (result.agent.pid === process.pid) owned.add(args.agentId);
    return result;
  };
  const authorize = (args: { agentId: string; sessionToken?: string }) => {
    const token = tokenFor(args);
    if (token) engine.fencing.resumeSession(args.agentId, token);
    engine.fencing.heartbeat(args.agentId);
  };
  const disconnected = new AbortController();
  const commands = new Set<Promise<unknown>>();
  const cleanup = () => {
    for (const id of owned) {
      try { engine.fencing.abandonAgentSession(id); } catch { /* Expired or already completed. */ }
    }
    engine.close();
  };
  let closing = false;
  server.server.onclose = () => {
    if (closing) return;
    closing = true;
    disconnected.abort();
    // A command must stop before its process-group guard and database are closed.
    if (commands.size) void Promise.allSettled([...commands]).then(cleanup);
    else cleanup();
  };

  const formatReply = (agentId: string | undefined, payload: unknown) => {
    const delta = agentId ? engine.consumeAgentDelta(agentId).formattedFooter : '';
    const data = payload as Record<string, unknown>;
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ...(delta ? [{ type: 'text' as const, text: delta }] : []),
      ],
      structuredContent: data,
      isError: data.ok === false,
    };
  };

  server.tool('kith_start_session', 'Create a capability-owned session or resume one with its token.', {
    agentId: z.string(), sessionToken: z.string().optional(), leaseDurationMs: z.number().optional(),
  }, async (args) => formatReply(undefined, { ok: true, ...register(args) }));
  server.tool('kith_heartbeat', 'Renew an active, owned session. Expired sessions cannot be revived.', {
    agentId: z.string(), sessionToken: z.string().optional(),
  }, async (args) => { authorize(args); return formatReply(args.agentId, { ok: true, agent: engine.fencing.getAgent(args.agentId) }); });

  server.tool(
    'kith_begin_work',
    'Register an agent session, verify no scope lock conflicts exist with sibling agents, acquire monotonic fencing-token locks, and optionally create an isolated Git worktree.',
    {
      agentId: z.string().describe('Unique identifier for this agent session (e.g. claude-1, codex-auth)'),
      sessionToken: z.string().optional(),
      client: z.string().optional().describe('Client name (claude-code, antigravity, codex, cursor)'),
      title: z.string().describe('Short title of the task or intent'),
      intentSummary: z.string().optional().describe('Detailed description of what will be built or modified'),
      scopeGlobs: z.array(z.string()).describe('File paths or glob patterns this agent will edit (e.g. ["src/auth/**"])'),
      isolateWorktree: z.boolean().optional().describe('Recommended: true, giving each parallel agent a separate Git worktree'),
    },
    async (args) => {
      const reg = register(args);

      const intentRes = engine.beginWork({
        agentId: args.agentId,
        title: args.title,
        intentSummary: args.intentSummary,
        scopeGlobs: args.scopeGlobs,
        isolateWorktree: args.isolateWorktree,
      });

      const contracts = engine.depGraph.listContracts().slice(0, 30);

      return formatReply(args.agentId, {
        ok: intentRes.ok,
        agent: engine.fencing.getAgent(args.agentId),
        sessionToken: reg.sessionToken,
        fencingToken: intentRes.fencingToken,
        task: intentRes.task,
        locks: intentRes.locks,
        worktree: intentRes.worktree,
        lockConflicts: intentRes.lockConflicts,
        activeSiblingIntents: intentRes.activeSiblingIntents,
        publishedContracts: contracts,
      });
    }
  );

  server.tool(
    'kith_claim_next_task',
    'Atomically claim the highest-priority unblocked task from the DAG task queue and lock its declared file scope.',
    {
      agentId: z.string().describe('Agent ID claiming the task'),
      sessionToken: z.string().optional(),
      client: z.string().optional(),
    },
    async (args) => {
      const session = register(args);
      const res = engine.intents.claimNextTask(args.agentId);
      return formatReply(args.agentId, { ...res, sessionToken: session.sessionToken });
    }
  );

  server.tool(
    'kith_add_task',
    'Add a task to the orchestrated DAG queue with optional task dependencies and file scope globs.',
    {
      id: z.string().optional(),
      title: z.string(),
      intentSummary: z.string().optional(),
      priority: z.number().optional(),
      dependsOn: z.array(z.string()).optional(),
      scopeGlobs: z.array(z.string()).optional(),
    },
    async (args) => {
      const task = engine.intents.addTask(args);
      return formatReply(undefined, { ok: true, task });
    }
  );

  server.tool(
    'kith_check_and_lock_files',
    'Acquire exclusive or shared fencing-token locks on file paths, globs, or symbols.',
    {
      agentId: z.string(),
      sessionToken: z.string().optional(),
      patterns: z.array(z.string()),
      mode: z.enum(['exclusive', 'shared']).optional(),
      reason: z.string().optional(),
    },
    async (args) => {
      authorize(args);
      const res = engine.locks.acquireLocks(args);
      return formatReply(args.agentId, res);
    }
  );

  server.tool(
    'kith_record_file_edit',
    'Analyze a modified file for supported contract signatures, flag exact name/kind matches in other files as non-blocking reuse hints, check transitive import blast radius, and run a live dirty-tree git merge-tree conflict check.',
    {
      agentId: z.string(),
      sessionToken: z.string().optional(),
      filePath: z.string(),
      content: z.string().optional(),
    },
    async (args) => {
      authorize(args);
      const res = engine.processPostFileEdit({
        agentId: args.agentId,
        filePath: args.filePath,
        content: args.content,
      });
      return formatReply(args.agentId, res);
    }
  );

  server.tool(
    'kith_publish_contract',
    'Explicitly publish a shared interface, function signature, API route, or schema to the Contract Blackboard.',
    {
      agentId: z.string(),
      sessionToken: z.string().optional(),
      filePath: z.string(),
      symbolName: z.string(),
      kind: z.enum(['function', 'type', 'interface', 'class', 'schema', 'route', 'const']),
      signature: z.string(),
      docComment: z.string().optional(),
    },
    async (args) => {
      authorize(args);
      const contract = engine.depGraph.publishExplicitContract(args);
      return formatReply(args.agentId, { ok: true, contract });
    }
  );

  server.tool(
    'kith_acquire_port',
    'Reserve a local TCP port among cooperating Kith clients; start the service promptly and handle unrelated bind races.',
    {
      agentId: z.string(),
      sessionToken: z.string().optional(),
      serviceName: z.string(),
      basePort: z.number().optional(),
    },
    async (args) => {
      authorize(args);
      const portRes = await engine.broker.acquirePort(args);
      return formatReply(args.agentId, portRes);
    }
  );

  server.tool(
    'kith_run_with_mutex',
    'Run an argv command under a renewable named mutex, using the MCP server process permissions. Useful when a sandboxed client shell cannot inspect process identities. Requires an owned session. Cancellation or connection loss stops the supervised command before release. This is command execution, not a filesystem sandbox.',
    {
      agentId: z.string(), sessionToken: z.string().optional(),
      mutexName: z.string().min(1).max(128),
      command: z.array(z.string()).min(1).describe('Executable followed by literal arguments; no implicit shell'),
      cwd: z.string().optional().describe('Directory under the registered worktree or repository; defaults to the worktree when present'),
      leaseDurationMs: z.number().int().min(100).max(86400000).optional(),
      waitTimeoutMs: z.number().int().min(0).max(600000).optional(),
      commandTimeoutMs: z.number().int().min(1).max(600000).optional(),
      maxOutputBytes: z.number().int().min(1).max(1048576).optional(),
    },
    async (args, extra) => {
      authorize(args);
      const root = fs.realpathSync(engine.fencing.getAgent(args.agentId)?.worktree_path ?? engine.coordDb.repoRoot);
      const cwd = fs.realpathSync(path.resolve(root, args.cwd ?? '.'));
      const relative = path.relative(root, cwd);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('Command cwd must be inside the registered worktree or repository');
      }
      const execution = engine.broker.executeWithMutex({
        agentId: args.agentId, mutexName: args.mutexName, command: args.command, cwd,
        leaseDurationMs: args.leaseDurationMs, timeoutMs: args.waitTimeoutMs,
        commandTimeoutMs: args.commandTimeoutMs ?? 60000, maxOutputBytes: args.maxOutputBytes ?? 65536,
        signal: AbortSignal.any([disconnected.signal, extra.signal]),
      });
      commands.add(execution);
      try {
        const result = await execution;
        return formatReply(args.agentId, { ok: result.exitCode === 0, ...result });
      } finally { commands.delete(execution); }
    }
  );

  server.tool(
    'kith_get_status',
    'Retrieve coordination state, FIFO waiters and guarded commands, plus worktree paths, actual branches, dirty-file overlaps, commit age and ahead/behind against the current integration target HEAD. Normal engine startup may reap expired ownership.',
    {
      agentId: z.string().optional(),
      sessionToken: z.string().optional(),
      includeContracts: z.boolean().optional().describe('Include the full contract registry. Default false keeps frequent status polls compact; contractCount always reports its size.'),
    },
    async (args) => {
      if (args.agentId) authorize({ ...args, agentId: args.agentId });
      const state = engine.getStatus();
      return formatReply(args.agentId, { ...state, contracts: args.includeContracts ? state.contracts : [],
        contractCount: state.contracts.length, contractsIncluded: args.includeContracts ?? false });
    }
  );

  server.tool(
    'kith_preview_integrate',
    'Preview exact Git conflict paths for a committed registered worktree against the current integration target. Refuses dirty inputs; never checkpoints or changes source/target files. A clean preview does not run project verification.',
    { agentId: z.string(), sessionToken: z.string().optional() },
    async args => { authorize(args); return formatReply(args.agentId, engine.previewIntegration(args.agentId)); }
  );

  server.tool(
    'kith_complete_work',
    'Complete an agent task, optionally run the Speculative Merge Train to verify and merge its worktree branch, and release all locks and resources.',
    {
      agentId: z.string(),
      sessionToken: z.string().optional(),
      taskId: z.string().optional(),
      fencingToken: z.number().optional(),
      mergeBranch: z.string().optional().describe('Source branch to integrate, not the destination. Defaults to the registered agent branch; destination is the selected repository checkout current branch. Omit for claims-only work without a registered branch.'),
      verificationCmd: z.string().optional().describe('Command to run in speculative merge tree (e.g. "npm run typecheck")'),
    },
    async (args) => {
      authorize(args);
      const result = engine.completeWork(args);
      return formatReply(result.ok ? undefined : args.agentId, result);
    }
  );

  return { server, engine };
}

export async function runKithMcpStdioServer(repoRoot = process.cwd()): Promise<void> {
  const { server } = createKithMcpServer(repoRoot);
  const transport = new StdioServerTransport();
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    process.stdin.off('end', close);
    process.stdin.off('close', close);
    process.off('SIGTERM', close);
    process.off('SIGINT', close);
    void server.close();
  };
  // The SDK transport does not translate stdin EOF into onclose. A running command
  // otherwise keeps the server alive until the client force-kills it.
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  try { await server.connect(transport); }
  catch (error) { close(); throw error; }
}
