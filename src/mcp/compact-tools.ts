import fs from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { KithEngine } from '../core/engine.js';
import { AGENT_HANDOFF_KINDS, handoffBlock } from '../core/handoffs.js';

export interface McpToolContext {
  engine: KithEngine;
  register: (args: {
    agentId: string;
    client?: string;
    sessionToken?: string;
    leaseDurationMs?: number;
  }) => ReturnType<KithEngine['fencing']['registerAgent']>;
  authorize: (args: { agentId: string; sessionToken?: string }) => void;
  formatReply: (agentId: string | undefined, payload: unknown) => CallToolResult;
}

export interface McpCompactHost {
  disconnected: AbortController;
  commands: Set<Promise<unknown>>;
  tool: <T extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: T,
    handler: (
      args: z.infer<z.ZodObject<T>>,
      extra: { signal: AbortSignal },
      context: McpToolContext
    ) => Promise<CallToolResult>
  ) => void;
}

function insideWorkspace(root: string, sub?: string): string {
  const realRoot = fs.realpathSync(root);
  const cwd = fs.realpathSync(path.resolve(realRoot, sub ?? '.'));
  const rel = path.relative(realRoot, cwd);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error('Command cwd must be inside the registered worktree or repository');
  }
  return cwd;
}

export function registerCompactTools({ tool, disconnected, commands }: McpCompactHost): void {
  tool(
    'kith_brief',
    'Read-only repository summary: active agents, overlapping claims, queued tasks, open handoffs, and conflicts.',
    {
      agentId: z.string().optional(),
      sessionToken: z.string().optional(),
      scopeGlobs: z.array(z.string()).max(20).optional(),
    },
    async (args, _extra, { engine, authorize, formatReply }) => {
      if (args.agentId) authorize({ agentId: args.agentId, sessionToken: args.sessionToken });
      return formatReply(args.agentId, { ok: true, brief: engine.brief({ scopeGlobs: args.scopeGlobs }) });
    }
  );

  tool(
    'kith_work',
    'Start or claim coordinated work (action: begin | claim | heartbeat | add_task) and manage the agent session.',
    {
      action: z.enum(['begin', 'claim', 'adopt', 'heartbeat', 'add_task']).optional(),
      agentId: z.string().optional(),
      sessionToken: z.string().optional(),
      title: z.string().optional(),
      scopeGlobs: z.array(z.string()).optional(),
      isolateWorktree: z.boolean().optional(),
      adoptWorktree: z.boolean().optional(),
      worktreePath: z.string().optional(),
      waitTimeoutMs: z.number().int().min(0).max(600000).optional(),
      dependsOn: z.array(z.string()).optional(),
      priority: z.number().optional(),
    },
    async (args, extra, { engine, register, authorize, formatReply }) => {
      const action = args.action ?? 'begin';
      const agentId = args.agentId ?? `agent-${process.pid}`;
      if (action === 'heartbeat') {
        authorize({ agentId, sessionToken: args.sessionToken });
        const ok = engine.fencing.heartbeat(agentId);
        return formatReply(agentId, { ok, agent: engine.fencing.getAgent(agentId) });
      }
      if (action === 'adopt') {
        const session = register({ agentId, sessionToken: args.sessionToken });
        const worktree = engine.worktrees.adoptWorktree({ agentId, path: args.worktreePath, explicit: true });
        return formatReply(agentId, { ok: true, worktree, workflowMode: engine.workflowMode(), sessionToken: session.sessionToken });
      }
      if (action === 'add_task') {
        const task = engine.intents.addTask({
          title: args.title ?? 'Task',
          dependsOn: args.dependsOn,
          scopeGlobs: args.scopeGlobs,
          priority: args.priority,
        });
        return formatReply(undefined, { ok: true, task });
      }

      const session = register({ agentId, sessionToken: args.sessionToken });
      const signal = AbortSignal.any([disconnected.signal, extra.signal]);
      if (action === 'claim') {
        const exec = args.waitTimeoutMs === undefined
          ? undefined
          : engine.claimNextTaskWhenAvailable({
            agentId,
            isolateWorktree: args.isolateWorktree,
            adoptWorktree: args.adoptWorktree,
            worktreePath: args.worktreePath,
            waitTimeoutMs: args.waitTimeoutMs,
            signal,
          });
        if (exec) commands.add(exec);
        try {
          const res = exec ? await exec : engine.claimNextTask({
            agentId, isolateWorktree: args.isolateWorktree, adoptWorktree: args.adoptWorktree, worktreePath: args.worktreePath,
          });
          const { publishedContracts, ...rest } = res;
          return formatReply(agentId, {
            ...rest,
            ok: res.claimed,
            sessionToken: session.sessionToken,
            publishedContractCount: publishedContracts.length,
          });
        } finally {
          if (exec) commands.delete(exec);
        }
      }

      const title = args.title ?? 'Active work';
      const opts = {
        agentId,
        title,
        intentSummary: title,
        scopeGlobs: args.scopeGlobs ?? ['**'],
        isolateWorktree: args.isolateWorktree,
        adoptWorktree: args.adoptWorktree,
        worktreePath: args.worktreePath,
      };
      const exec = args.waitTimeoutMs === undefined
        ? undefined
        : engine.beginWorkWhenAvailable({ ...opts, waitTimeoutMs: args.waitTimeoutMs, signal });
      if (exec) commands.add(exec);
      try {
        const res = exec ? await exec : engine.beginWork(opts);
        return formatReply(agentId, {
          ...res,
          sessionToken: session.sessionToken,
        });
      } finally {
        if (exec) commands.delete(exec);
      }
    }
  );

  tool(
    'kith_claim',
    'Acquire/release file locks, record edits for breaking-change and conflict checks, or publish a contract.',
    {
      action: z.enum(['lock', 'release', 'edit', 'publish']).optional(),
      agentId: z.string(),
      sessionToken: z.string().optional(),
      patterns: z.array(z.string()).optional(),
      filePath: z.string().optional(),
      content: z.string().optional(),
      symbolName: z.string().optional(),
      kind: z.enum(['function', 'type', 'interface', 'class', 'schema', 'route', 'const']).optional(),
      signature: z.string().optional(),
      waitTimeoutMs: z.number().int().min(0).max(600000).optional(),
    },
    async (args, extra, { engine, authorize, formatReply }) => {
      authorize(args);
      const action = args.action ?? (args.filePath ? 'edit' : 'lock');
      if (action === 'release') {
        return formatReply(args.agentId, {
          ok: true,
          released: engine.locks.releaseLocks({ agentId: args.agentId, patterns: args.patterns }),
        });
      }
      if (action === 'edit') {
        if (!args.filePath) throw new Error('filePath is required for action=edit');
        const res = engine.processPostFileEdit({ agentId: args.agentId, filePath: args.filePath, content: args.content });
        return formatReply(args.agentId, {
          ok: true,
          filePath: res.filePath,
          upsertedCount: res.contractReport.upsertedContracts.length,
          removedSymbols: res.contractReport.removedSymbols,
          breakingChanges: res.contractReport.breakingChanges,
          dirtyMergeConflicts: res.dirtyMergeConflicts,
          warnings: res.warnings,
        });
      }
      if (action === 'publish') {
        if (!args.filePath || !args.symbolName || !args.kind || !args.signature) {
          throw new Error('filePath, symbolName, kind, and signature are required for action=publish');
        }
        const contract = engine.depGraph.publishExplicitContract({
          agentId: args.agentId,
          filePath: args.filePath,
          symbolName: args.symbolName,
          kind: args.kind,
          signature: args.signature,
        });
        return formatReply(args.agentId, { ok: true, contract });
      }
      const patterns = args.patterns ?? [];
      const exec = args.waitTimeoutMs === undefined
        ? undefined
        : engine.acquireLocksWhenAvailable({
          agentId: args.agentId,
          patterns,
          waitTimeoutMs: args.waitTimeoutMs,
          signal: AbortSignal.any([disconnected.signal, extra.signal]),
        });
      if (exec) commands.add(exec);
      try {
        const res = exec ? await exec : engine.locks.acquireLocks({ agentId: args.agentId, patterns });
        return formatReply(args.agentId, res);
      } finally {
        if (exec) commands.delete(exec);
      }
    }
  );

  tool(
    'kith_handoff',
    'Write or read agent handoff notes.',
    {
      action: z.enum(['write', 'read']).optional(),
      agentId: z.string().optional(),
      sessionToken: z.string().optional(),
      taskId: z.string().optional(),
      kind: z.enum(AGENT_HANDOFF_KINDS).optional(),
      summary: z.string().max(4000).optional(),
      done: z.array(z.string().max(500)).max(20).optional(),
      remaining: z.array(z.string().max(500)).max(20).optional(),
      learned: z.array(z.string().max(500)).max(20).optional(),
      failed: z.array(z.string().max(500)).max(20).optional(),
      files: z.array(z.string().max(300)).max(100).optional(),
      releaseTask: z.boolean().optional(),
      fromAgentId: z.string().optional(),
      scopeGlobs: z.array(z.string()).max(20).optional(),
      includeResolved: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args, _extra, { engine, authorize, formatReply }) => {
      const action = args.action ?? (args.summary ? 'write' : 'read');
      if (action === 'read') {
        if (args.agentId) authorize({ agentId: args.agentId, sessionToken: args.sessionToken });
        const rows = engine.handoffs.list({
          taskId: args.taskId,
          agentId: args.fromAgentId,
          scopeGlobs: args.scopeGlobs,
          includeResolved: args.includeResolved,
          limit: args.limit,
        });
        return formatReply(args.agentId, { ok: true, handoffs: handoffBlock(rows, { summaryMax: 4000, filesMax: 100 }) });
      }
      if (!args.agentId) throw new Error('agentId is required for action=write');
      authorize({ agentId: args.agentId, sessionToken: args.sessionToken });
      const { handoff, released } = engine.handoffs.write({
        agentId: args.agentId,
        taskId: args.taskId,
        kind: args.kind ?? 'progress',
        summary: args.summary ?? '',
        done: args.done,
        remaining: args.remaining,
        learned: args.learned,
        failed: args.failed,
        files: args.files,
        releaseTask: args.releaseTask,
      });
      return formatReply(args.agentId, {
        ok: true,
        released,
        handoffId: handoff.id,
        kind: handoff.kind,
        taskId: handoff.task_id,
        filesRecorded: handoff.files.length,
      });
    }
  );

  tool(
    'kith_finish',
    'Preview conflicts, commit scoped files, verify and merge work, or abandon an active session.',
    {
      agentId: z.string(),
      sessionToken: z.string().optional(),
      previewOnly: z.boolean().optional(),
      abandon: z.boolean().optional(),
      taskId: z.string().optional(),
      fencingToken: z.number().optional(),
      mergeBranch: z.string().optional(),
      verificationCmd: z.string().optional(),
      commitMessage: z.string().optional(),
      commitFiles: z.array(z.string()).optional(),
    },
    async (args, _extra, { engine, authorize, formatReply }) => {
      authorize(args);
      if (args.abandon) {
        engine.fencing.abandonAgentSession(args.agentId);
        return formatReply(undefined, { ok: true, abandoned: true });
      }
      if (args.previewOnly) {
        return formatReply(args.agentId, engine.previewIntegration(args.agentId));
      }
      let commitResult;
      if (args.commitMessage) {
        commitResult = engine.commit({
          agentId: args.agentId,
          sessionToken: args.sessionToken,
          message: args.commitMessage,
          files: args.commitFiles,
          callerPid: process.pid,
        });
        if (!commitResult.ok) {
          return formatReply(args.agentId, commitResult);
        }
      }
      const res = engine.completeWork({
        agentId: args.agentId,
        taskId: args.taskId,
        fencingToken: args.fencingToken,
        mergeBranch: args.mergeBranch,
        verificationCmd: args.verificationCmd,
      });
      return formatReply(res.ok ? undefined : args.agentId, commitResult ? { ...res, commit: commitResult } : res);
    }
  );

  tool(
    'kith_resource',
    'Coordinate ports, named mutex commands, or port-injected dev servers.',
    {
      action: z.enum(['port', 'mutex', 'dev']),
      agentId: z.string(),
      sessionToken: z.string().optional(),
      name: z.string().min(1).max(128),
      command: z.array(z.string()).min(1).optional(),
      basePort: z.number().int().min(1).max(65535).optional(),
      cwd: z.string().optional(),
      waitTimeoutMs: z.number().int().min(0).max(600000).optional(),
      commandTimeoutMs: z.number().int().min(1).max(600000).optional(),
    },
    async (args, extra, { engine, authorize, formatReply }) => {
      authorize(args);
      if (args.action === 'port') {
        const res = await engine.broker.acquirePort({
          agentId: args.agentId,
          serviceName: args.name,
          basePort: args.basePort,
        });
        return formatReply(args.agentId, res);
      }
      if (!args.command?.length) throw new Error('command is required for mutex/dev actions');
      const root = engine.fencing.getAgent(args.agentId)?.worktree_path ?? engine.coordDb.repoRoot;
      const cwd = insideWorkspace(root, args.cwd);
      const signal = AbortSignal.any([disconnected.signal, extra.signal]);
      const exec = args.action === 'mutex'
        ? engine.broker.executeWithMutex({
          agentId: args.agentId,
          mutexName: args.name,
          command: args.command,
          cwd,
          timeoutMs: args.waitTimeoutMs,
          commandTimeoutMs: args.commandTimeoutMs ?? 60000,
          signal,
        })
        : engine.broker.executeWithPort({
          agentId: args.agentId,
          serviceName: args.name,
          command: args.command,
          cwd,
          basePort: args.basePort ?? 3000,
          commandTimeoutMs: args.commandTimeoutMs ?? 60000,
          signal,
        });
      commands.add(exec);
      try {
        const result = await exec;
        return formatReply(args.agentId, { ok: result.exitCode === 0, ...result });
      } finally {
        commands.delete(exec);
      }
    }
  );
}
