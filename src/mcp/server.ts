import { KITH_VERSION } from '../version.js';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { KithEngine } from '../core/engine.js';
import {
  compactContractsForScope,
  compactDeltaFooter,
  compactFileEditResult,
  compactLinkedContracts,
  compactStatusResult,
} from './compact.js';
import { OperationJournal, RetryError, failureData, toolReply } from './retries.js';
import { discoverRepository } from '../core/repository.js';

function buildKithMcpServer(repoRoot: string | undefined, pinned: boolean) {
  const pinnedRoot = pinned ? discoverRepository(repoRoot!).checkoutRoot : undefined;
  const server = new McpServer({
    name: 'kith-coordinator',
    version: KITH_VERSION,
  }, { instructions: 'Kith coordinates work claims, isolated worktrees, local resources and verified integration for cooperating coding agents. State stays local; no hosted service or model API key is required. The optional repository argument selects an absolute Git checkout for each call on a global connection. Keep passing the original checkout, even while editing its returned worktree. If no project context is available, ask for a repository path; never substitute HOME or a filesystem root. Each call is routed independently; there is no shared current project. Recommended workflow: one isolated worktree per parallel agent. Call kith_begin_work with isolateWorktree:true and explicit scopeGlobs; edit only the returned worktreePath, call kith_record_file_edit, run literal argv with kith_run_with_mutex, and finish with kith_complete_work plus a project verificationCmd. Heartbeat before the session expires. For mutations, generate a unique operationKey and reuse it only to recover that exact attempt after a timeout. Replay is a historical result, never a renewed claim. Inspect failure.code and failure.retryable; an unknown command outcome requires inspection, not automatic re-execution. ' + (repoRoot && process.env.KITH_AGENT_ID
    ? `This server shares a session with CLI/hooks. Use agentId '${process.env.KITH_AGENT_ID}'. Its inherited capability is handled internally; do not request or log it.`
    : 'Start with kith_begin_work or kith_start_session and a unique agentId. This connection retains its granted capability. Omit sessionToken on subsequent calls on this connection; only another connection needs it to resume that ID. Initial grant/resume replies contain the token and client transcripts may record it. Keep transcripts private.'
  ) });

  const disconnected = new AbortController();
  const commands = new Set<Promise<unknown>>();
  const createContext = (root: string, inheritCapability: boolean) => {
    const engine = new KithEngine(root);
    const owned = new Set<string>();
    const capabilities = new Map<string, string>();
    const journal = new OperationJournal(engine.coordDb);
    const tokenFor = (args: { agentId: string; sessionToken?: string }) => args.sessionToken ??
      (inheritCapability && process.env.KITH_AGENT_ID === args.agentId ? process.env.KITH_SESSION_TOKEN : capabilities.get(args.agentId));
    const register = (args: { agentId: string; client?: string; sessionToken?: string; leaseDurationMs?: number }) => {
      const result = engine.fencing.registerAgent({ id: args.agentId, client: args.client ?? 'mcp',
        sessionToken: args.sessionToken ?? (inheritCapability && process.env.KITH_AGENT_ID === args.agentId ? process.env.KITH_SESSION_TOKEN : undefined), leaseDurationMs: args.leaseDurationMs });
      capabilities.set(args.agentId, result.sessionToken);
      if (result.agent.pid === process.pid) owned.add(args.agentId);
      return result;
    };
    const authorize = (args: { agentId: string; sessionToken?: string }) => {
      const token = tokenFor(args);
      if (token) engine.fencing.resumeSession(args.agentId, token);
      engine.fencing.heartbeat(args.agentId);
    };
    const formatReply = (agentId: string | undefined, payload: unknown) => {
      const delta = agentId ? compactDeltaFooter(engine.consumeAgentDelta(agentId).formattedFooter) : '';
      const data = payload as Record<string, unknown>;
      return toolReply(data, delta ? [{ type: 'text', text: delta }] : []);
    };
    const close = () => {
      for (const id of owned) {
        try { engine.fencing.abandonAgentSession(id); } catch { /* Expired or already completed. */ }
      }
      engine.close();
    };
    return { engine, register, authorize, formatReply, close, journal, tokenFor };
  };
  type Context = ReturnType<typeof createContext>;
  const contexts = new Map<string, Context>();
  const contextFor = (repository?: string): Context => {
    if (repository !== undefined && !path.isAbsolute(repository)) throw new Error('repository must be an absolute Git checkout path.');
    const target = repository ?? repoRoot;
    if (!target) throw new Error('No project selected. Pass repository with the absolute Git checkout path for this task.');
    const layout = discoverRepository(target);
    if (pinnedRoot && layout.checkoutRoot !== pinnedRoot) throw new Error('This connection is pinned with --repo. Use a global connection to select another repository.');
    if (!pinned && !layout.commonGitDir) throw new Error('Global connections require a Git checkout; do not use HOME or a parent directory as a project.');
    let context = contexts.get(layout.checkoutRoot);
    if (!context) {
      context = createContext(layout.checkoutRoot, layout.checkoutRoot === (pinnedRoot ?? repoRoot));
      contexts.set(layout.checkoutRoot, context);
    }
    return context;
  };
  const engine = pinned ? contextFor().engine : undefined;
  const tool = <T extends z.ZodRawShape>(name: string, description: string, schema: T,
    handler: (args: z.infer<z.ZodObject<T>>, extra: Parameters<ToolCallback<z.ZodRawShape>>[1], context: Context) => Promise<CallToolResult>) => {
    const keyed = !['kith_get_status', 'kith_preview_integrate', 'kith_heartbeat'].includes(name);
    const inputSchema: z.ZodRawShape = { ...schema, ...(keyed ? { operationKey: z.string().min(1).max(128).optional().describe('Unique client-generated key for this exact mutation. Reuse only to recover its result; never an ownership credential. Retried failures are snapshots; use a new key after repair or backoff.') } : {}), repository: z.string().optional().describe('Absolute Git checkout path. Required on global connections without project context. Always use the same original checkout for a task.') };
    server.tool(name, description, inputSchema,
      async (args, extra): Promise<CallToolResult> => {
        const { repository, ...input } = args as { repository?: string } & Record<string, unknown>;
        const execution = (async () => {
          try {
            const context = contextFor(repository);
            const run = async () => { extra.signal.throwIfAborted(); return handler(input as z.infer<z.ZodObject<T>>, extra, context); };
            if (!keyed || input.operationKey === undefined) return await run();
            const identity = input as { agentId?: string; sessionToken?: string };
            return await context.journal.execute({ key: input.operationKey as string, tool: name, input,
              agentId: identity.agentId, token: () => identity.agentId ? context.tokenFor({ ...identity, agentId: identity.agentId }) : undefined,
              authorize: () => {
                if (!identity.agentId) throw new RetryError('INVALID_REQUEST', 'Keyed mutations require agentId and an owned session. Start a session first.');
                const args = { ...identity, agentId: identity.agentId };
                if (['kith_start_session', 'kith_begin_work', 'kith_claim_next_task'].includes(name)) context.register(args);
                else context.authorize(args);
                return { agentId: identity.agentId, sessionEpoch: context.engine.fencing.assertSession(identity.agentId), token: context.tokenFor(args)! };
              }, run });
          } catch (error) { return toolReply(failureData(error)); }
        })();
        commands.add(execution);
        try { return await execution; } finally { commands.delete(execution); }
      });
  };
  let closing = false;
  server.server.onclose = () => {
    if (closing) return;
    closing = true;
    disconnected.abort();
    const cleanup = () => { for (const context of contexts.values()) context.close(); contexts.clear(); };
    // Commands across all selected projects must stop before their guards/databases close.
    if (commands.size) void Promise.allSettled([...commands]).then(cleanup);
    else cleanup();
  };

  tool('kith_start_session', 'Create a capability-owned session or resume one with its token.', {
    agentId: z.string(), sessionToken: z.string().optional(), leaseDurationMs: z.number().optional(),
  }, async (args, extra, { engine, register, authorize, formatReply }) => formatReply(undefined, { ok: true, ...register(args) }));
  tool('kith_heartbeat', 'Renew an active, owned session. Expired sessions cannot be revived.', {
    agentId: z.string(), sessionToken: z.string().optional(),
  }, async (args, extra, { engine, register, authorize, formatReply }) => { authorize(args); return formatReply(args.agentId, { ok: true, agent: engine.fencing.getAgent(args.agentId) }); });

  tool(
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
      waitTimeoutMs: z.number().int().min(0).max(600000).optional().describe('Wait up to this many milliseconds for the whole scope; default fail-fast, not a FIFO file queue'),
    },
    async (args, extra, { engine, register, authorize, formatReply }) => {
      const reg = register(args);

      const options = {
        agentId: args.agentId, title: args.title, intentSummary: args.intentSummary,
        scopeGlobs: args.scopeGlobs, isolateWorktree: args.isolateWorktree,
      };
      const execution = args.waitTimeoutMs === undefined ? undefined
        : engine.beginWorkWhenAvailable({ ...options, waitTimeoutMs: args.waitTimeoutMs,
          signal: AbortSignal.any([disconnected.signal, extra.signal]) });
      if (execution) commands.add(execution);
      let intentRes;
      try { intentRes = execution ? await execution : engine.beginWork(options); }
      finally { if (execution) commands.delete(execution); }


      const siblingLocks = engine.locks.listLocks().filter((l) => l.owner_agent_id !== args.agentId);
      const { publishedContracts, totalPublishedContracts } = compactContractsForScope(
        engine.depGraph.listContracts(),
        args.scopeGlobs,
        siblingLocks
      );

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
        ...('waitedMs' in intentRes && 'waitTimedOut' in intentRes ? { waitedMs: intentRes.waitedMs, waitTimedOut: intentRes.waitTimedOut } : {}),
        publishedContracts,
        totalPublishedContracts,
        linkedContracts: compactLinkedContracts(intentRes.linkedContracts),
        crossRepoWarnings: intentRes.crossRepoWarnings,
        crossRepoComplete: intentRes.crossRepoComplete,
      });
    }
  );

  tool(
    'kith_claim_next_task',
    'Atomically claim the highest-priority unblocked task from the DAG task queue and lock its declared file scope.',
    {
      agentId: z.string().describe('Agent ID claiming the task'),
      sessionToken: z.string().optional(),
      client: z.string().optional(),
      isolateWorktree: z.boolean().optional().describe('Recommended: true, giving the claiming agent an isolated Git worktree'),
      waitTimeoutMs: z.number().int().min(0).max(600000).optional().describe('Wait up to this many milliseconds for a queued task to become unblocked and claimable'),
    },
    async (args, extra, { engine, register, authorize, formatReply }) => {
      const session = register(args);
      const options = { agentId: args.agentId, isolateWorktree: args.isolateWorktree };
      const execution = args.waitTimeoutMs === undefined ? undefined
        : engine.claimNextTaskWhenAvailable({ ...options, waitTimeoutMs: args.waitTimeoutMs,
          signal: AbortSignal.any([disconnected.signal, extra.signal]) });
      if (execution) commands.add(execution);
      let res;
      try { res = execution ? await execution : engine.claimNextTask(options); }
      finally { if (execution) commands.delete(execution); }
      const siblingLocks = engine.locks.listLocks().filter((l) => l.owner_agent_id !== args.agentId);
      const { publishedContracts, totalPublishedContracts } = compactContractsForScope(
        engine.depGraph.listContracts(),
        res.task?.scope_globs ?? [],
        siblingLocks
      );
      return formatReply(args.agentId, {
        ...res,
        publishedContracts,
        totalPublishedContracts,
        linkedContracts: compactLinkedContracts(res.linkedContracts),
        agent: engine.fencing.getAgent(args.agentId),
        sessionToken: session.sessionToken,
      });
    }
  );

  tool(
    'kith_add_task',
    'Add a task to the orchestrated DAG queue with optional task dependencies and file scope globs.',
    {
      id: z.string().optional(),
      agentId: z.string().optional().describe('Required for operationKey; identifies an already owned session.'),
      sessionToken: z.string().optional(),
      title: z.string(),
      intentSummary: z.string().optional(),
      priority: z.number().optional(),
      dependsOn: z.array(z.string()).optional(),
      scopeGlobs: z.array(z.string()).optional(),
    },
    async (args, extra, { engine, register, authorize, formatReply }) => {
      if (args.agentId) authorize({ ...args, agentId: args.agentId });
      const task = engine.intents.addTask(args);
      return formatReply(undefined, { ok: true, task });
    }
  );

  tool(
    'kith_check_and_lock_files',
    'Acquire exclusive or shared fencing-token locks on file paths, globs, or symbols.',
    {
      agentId: z.string(),
      sessionToken: z.string().optional(),
      patterns: z.array(z.string()),
      mode: z.enum(['exclusive', 'shared']).optional(),
      reason: z.string().optional(),
      waitTimeoutMs: z.number().int().min(0).max(600000).optional(),
    },
    async (args, extra, { engine, register, authorize, formatReply }) => {
      authorize(args);
      const execution = args.waitTimeoutMs === undefined ? undefined
        : engine.acquireLocksWhenAvailable({ ...args, waitTimeoutMs: args.waitTimeoutMs,
          signal: AbortSignal.any([disconnected.signal, extra.signal]) });
      if (execution) commands.add(execution);
      try { return formatReply(args.agentId, execution ? await execution : engine.locks.acquireLocks(args)); }
      finally { if (execution) commands.delete(execution); }
    }
  );

  tool(
    'kith_record_file_edit',
    'Analyze a modified file for supported contract signatures, flag exact name/kind matches in other files as non-blocking reuse hints, check transitive import blast radius, and run a live dirty-tree git merge-tree conflict check.',
    {
      agentId: z.string(),
      sessionToken: z.string().optional(),
      filePath: z.string(),
      content: z.string().optional(),
    },
    async (args, extra, { engine, register, authorize, formatReply }) => {
      authorize(args);
      const res = engine.processPostFileEdit({
        agentId: args.agentId,
        filePath: args.filePath,
        content: args.content,
      });
      return formatReply(args.agentId, compactFileEditResult(res));
    }
  );

  tool(
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
    async (args, extra, { engine, register, authorize, formatReply }) => {
      authorize(args);
      const contract = engine.depGraph.publishExplicitContract(args);
      return formatReply(args.agentId, { ok: true, contract });
    }
  );

  tool(
    'kith_acquire_port',
    'Reserve a local TCP port among cooperating Kith clients; start the service promptly and handle unrelated bind races.',
    {
      agentId: z.string(),
      sessionToken: z.string().optional(),
      serviceName: z.string(),
      basePort: z.number().optional(),
    },
    async (args, extra, { engine, register, authorize, formatReply }) => {
      authorize(args);
      const portRes = await engine.broker.acquirePort(args);
      return formatReply(args.agentId, portRes);
    }
  );

  tool(
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
    async (args, extra, { engine, register, authorize, formatReply }) => {
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

  tool(
    'kith_run_dev_server',
    'Run a literal argv command with an allocated port in PORT/KITH_PORT and substituted {port} arguments. Renews the lease while running; cancellation/disconnect stops the process group before release. Uses coordinator permissions. Requires macOS/Linux; no implicit shell or readiness guarantee.',
    {
      agentId: z.string(), sessionToken: z.string().optional(), serviceName: z.string().min(1).max(128),
      command: z.array(z.string()).min(1), basePort: z.number().int().min(1).max(65535).optional(),
      cwd: z.string().optional(), leaseDurationMs: z.number().int().min(100).max(86400000).optional(),
      commandTimeoutMs: z.number().int().min(1).max(600000).optional(),
      maxOutputBytes: z.number().int().min(1).max(1048576).optional(),
    },
    async (args, extra, { engine, authorize, formatReply }) => {
      authorize(args);
      const root = fs.realpathSync(engine.fencing.getAgent(args.agentId)?.worktree_path ?? engine.coordDb.repoRoot);
      const cwd = fs.realpathSync(path.resolve(root, args.cwd ?? '.'));
      const relative = path.relative(root, cwd);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('Command cwd must be inside the registered worktree or repository');
      }
      const execution = engine.broker.executeWithPort({ ...args, cwd, basePort: args.basePort ?? 3000,
        commandTimeoutMs: args.commandTimeoutMs ?? 60000, maxOutputBytes: args.maxOutputBytes ?? 65536,
        signal: AbortSignal.any([disconnected.signal, extra.signal]),
      });
      commands.add(execution);
      try { const result = await execution; return formatReply(args.agentId, { ok: result.exitCode === 0, ...result }); }
      finally { commands.delete(execution); }
    }
  );

  tool(
    'kith_get_status',
    'Retrieve coordination state, FIFO waiters and guarded commands, plus worktree paths, actual branches, dirty-file overlaps, commit age and ahead/behind against the current integration target HEAD. Normal engine startup may reap expired ownership.',
    {
      agentId: z.string().optional(),
      sessionToken: z.string().optional(),
      includeContracts: z.boolean().optional().describe('Include the full contract registry. Default false keeps frequent status polls compact; contractCount always reports its size.'),
    },
    async (args, extra, { engine, register, authorize, formatReply }) => {
      if (args.agentId) authorize({ ...args, agentId: args.agentId });
      const state = engine.getStatus();
      return formatReply(args.agentId, compactStatusResult(state, { includeContracts: args.includeContracts }));
    }
  );

  tool(
    'kith_preview_integrate',
    'Preview exact Git conflict paths for a committed registered worktree against the current integration target. Refuses dirty inputs; never checkpoints or changes source/target files. A clean preview does not run project verification.',
    { agentId: z.string(), sessionToken: z.string().optional() },
    async (args, extra, { engine, register, authorize, formatReply }) => { authorize(args); return formatReply(args.agentId, engine.previewIntegration(args.agentId)); }
  );

  tool(
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
    async (args, extra, { engine, register, authorize, formatReply }) => {
      authorize(args);
      const result = engine.completeWork(args);
      return formatReply(result.ok ? undefined : args.agentId, result);
    }
  );

  return { server, engine };
}

export function createKithMcpServer(repoRoot = process.cwd()) {
  const { server, engine } = buildKithMcpServer(repoRoot, true);
  return { server, engine: engine! };
}

export async function runKithMcpStdioServer(repoRoot = process.cwd(), pinned = true): Promise<void> {
  let defaultRoot: string | undefined = repoRoot;
  if (!pinned) {
    // Desktop clients often start at / or HOME. Connect without creating state
    // there, and let each tool call select a project explicitly instead.
    try { const layout = discoverRepository(repoRoot); defaultRoot = layout.commonGitDir ? layout.checkoutRoot : undefined; }
    catch { defaultRoot = undefined; }
  }
  const { server } = buildKithMcpServer(defaultRoot, pinned);
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
