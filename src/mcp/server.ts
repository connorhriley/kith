import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { KithEngine } from '../core/engine.js';

export function createKithMcpServer(repoRoot = process.cwd()): {
  server: McpServer;
  engine: KithEngine;
} {
  const engine = new KithEngine(repoRoot);
  const server = new McpServer({
    name: 'kith-coordinator',
    version: '1.0.0',
  }, { instructions: process.env.KITH_AGENT_ID
    ? `This server shares a session with CLI/hooks. Use agentId '${process.env.KITH_AGENT_ID}'. Its inherited capability is handled internally; do not request or log it.`
    : 'Start with kith_begin_work or kith_start_session and a unique agentId. This connection retains its granted capability. Another connection needs the session token to resume that ID. Keep tokens private.'
  });

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
  server.server.onclose = () => {
    for (const id of owned) {
      try { engine.fencing.abandonAgentSession(id); } catch { /* Expired or already completed. */ }
    }
    engine.close();
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
    'Register an agent session, verify no scope lock or semantic duplicate intent conflicts exist with sibling agents, acquire monotonic fencing-token locks, and optionally spawn an instant Copy-on-Write git worktree.',
    {
      agentId: z.string().describe('Unique identifier for this agent session (e.g. claude-1, codex-auth)'),
      sessionToken: z.string().optional(),
      client: z.string().optional().describe('Client name (claude-code, antigravity, codex, cursor)'),
      title: z.string().describe('Short title of the task or intent'),
      intentSummary: z.string().optional().describe('Detailed description of what will be built or modified'),
      scopeGlobs: z.array(z.string()).describe('File paths or glob patterns this agent will edit (e.g. ["src/auth/**"])'),
      isolateWorktree: z.boolean().optional().describe('Set true to spawn an isolated Copy-on-Write git worktree'),
      force: z.boolean().optional().describe('Bypass semantic overlap warning if intentional'),
    },
    async (args) => {
      const reg = register(args);

      const intentRes = engine.intents.declareIntent({
        agentId: args.agentId,
        title: args.title,
        intentSummary: args.intentSummary,
        scopeGlobs: args.scopeGlobs,
        force: args.force,
      });

      let worktree = null;
      if (intentRes.ok && args.isolateWorktree) {
        worktree = engine.worktrees.spawnWorktree({ agentId: args.agentId });
      }

      const contracts = engine.depGraph.listContracts().slice(0, 30);

      return formatReply(args.agentId, {
        ok: intentRes.ok,
        agent: reg.agent,
        sessionToken: reg.sessionToken,
        fencingToken: intentRes.fencingToken,
        task: intentRes.task,
        locks: intentRes.locks,
        worktree,
        lockConflicts: intentRes.lockConflicts,
        semanticOverlaps: intentRes.semanticOverlaps,
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
    'Analyze a modified file to extract AST contracts, check transitive import blast radius, detect semantic duplicate utilities, and run a live dirty-tree git merge-tree conflict check.',
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
    'Lease a collision-free local TCP port for running dev servers or test suites in parallel.',
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
    'kith_get_status',
    'Retrieve live coordination state: active agents, file locks, tasks, contracts, dirty-tree conflicts, and leased ports/mutexes.',
    {
      agentId: z.string().optional(),
      sessionToken: z.string().optional(),
    },
    async (args) => {
      if (args.agentId) authorize({ ...args, agentId: args.agentId });
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
      return formatReply(args.agentId, state);
    }
  );

  server.tool(
    'kith_complete_work',
    'Complete an agent task, optionally run the Speculative Merge Train to verify and merge its worktree branch, and release all locks and resources.',
    {
      agentId: z.string(),
      sessionToken: z.string().optional(),
      taskId: z.string().optional(),
      fencingToken: z.number().optional(),
      mergeBranch: z.string().optional().describe('If work was done on a worktree/branch, run Speculative Merge Train to integrate it'),
      verificationCmd: z.string().optional().describe('Command to run in speculative merge tree (e.g. "npm run typecheck")'),
    },
    async (args) => {
      authorize(args);
      const agent = engine.fencing.getAgent(args.agentId);
      let mergeResult = null;

      if (args.mergeBranch || agent?.branch) {
        mergeResult = engine.mergeTrain.enqueueAndMerge({
          agentId: args.agentId,
          branch: (args.mergeBranch ?? agent?.branch)!,
          worktreePath: agent?.worktree_path,
          verificationCmd: args.verificationCmd,
        });

        if (!mergeResult.merged) {
          return formatReply(args.agentId, {
            ok: false,
            error: 'Speculative merge train failed. Fix the reported issues before completing work.',
            mergeResult,
          });
        }

        // Preserve the worktree for inspection, consistent with CLI completion.
      }

      const completedTasks = engine.intents.completeTask({
        agentId: args.agentId,
        taskId: args.taskId,
        fencingToken: args.fencingToken,
        releaseLocks: true,
      });

      engine.fencing.completeAgentSession(args.agentId);

      return formatReply(undefined, {
        ok: true,
        completedTasks,
        mergeResult,
      });
    }
  );

  return { server, engine };
}

export async function runKithMcpStdioServer(repoRoot = process.cwd()): Promise<void> {
  const { server } = createKithMcpServer(repoRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
