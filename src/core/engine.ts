import { KITH_PROTOCOL_VERSION } from '../version.js';
import { observeWorkspaces, previewIntegration } from './workspace-observation.js';
import fs from 'node:fs';
import path from 'node:path';
import { AstAnalyzer, ExtractedSymbol } from './ast-analyzer.js';
import { BashMerkleGuard } from './bash-guard.js';
import { ResourceBroker } from './broker.js';
import { CoordDatabase, CoordEvent } from './db.js';
import {
  BlastRadiusAlert,
  DependencyAndContractEngine,
  FileModificationReport,
} from './dep-graph.js';
import { FencingAndAgentManager } from './fencing.js';
import { IntentAndTaskEngine } from './intents.js';
import { LockEngine } from './locks.js';
import { SpeculativeMergeTrain } from './merge-train.js';
import { ConflictRecord, ShadowGitEngine } from './shadow-git.js';
import { CoWWorktreeManager } from './worktree-cow.js';

export interface AgentUnreadDelta {
  events: CoordEvent[];
  activeConflicts: ConflictRecord[];
  formattedFooter: string;
}

export interface PostFileEditHookResult {
  filePath: string;
  contractReport: FileModificationReport;
  dirtyMergeConflicts: ConflictRecord[];
  warnings: string[];
}

export class KithEngine {
  public readonly coordDb: CoordDatabase;
  public readonly fencing: FencingAndAgentManager;
  public readonly locks: LockEngine;
  public readonly intents: IntentAndTaskEngine;
  public readonly depGraph: DependencyAndContractEngine;
  public readonly shadowGit: ShadowGitEngine;
  public readonly worktrees: CoWWorktreeManager;
  public readonly mergeTrain: SpeculativeMergeTrain;
  public readonly bashGuard: BashMerkleGuard;
  public readonly broker: ResourceBroker;

  constructor(repoRoot = process.cwd(), customDbPath?: string) {
    this.coordDb = new CoordDatabase(repoRoot, customDbPath);
    this.fencing = new FencingAndAgentManager(this.coordDb);
    this.locks = new LockEngine(this.coordDb, this.fencing);
    this.intents = new IntentAndTaskEngine(this.coordDb, this.fencing, this.locks);
    this.depGraph = new DependencyAndContractEngine(this.coordDb, this.locks, this.fencing);
    this.shadowGit = new ShadowGitEngine(this.coordDb, this.fencing);
    this.worktrees = new CoWWorktreeManager(this.coordDb, this.fencing);
    this.mergeTrain = new SpeculativeMergeTrain(this.coordDb, this.fencing);
    this.bashGuard = new BashMerkleGuard(
      this.coordDb,
      this.fencing,
      this.locks,
      this.depGraph,
      this.shadowGit
    );
    this.broker = new ResourceBroker(this.coordDb, this.fencing);
  }

  /**
   * Executes the complete PostToolUse pipeline whenever an agent writes or edits a file:
   * 1. Extracts AST exports/imports and updates the Contract Blackboard & Import Graph
   * 2. Computes transitive breaking-change blast radius across downstream dependent files
   * 3. Updates the agent's shadow Git index (`GIT_INDEX_FILE`) and runs `git merge-tree` against sibling dirty trees
   */
  public processPostFileEdit(params: {
    agentId: string;
    filePath: string;
    content?: string;
    worktreeDir?: string;
  }): PostFileEditHookResult {
    this.fencing.heartbeat(params.agentId);
    const targetRoot = params.worktreeDir ?? this.fencing.getAgent(params.agentId)?.worktree_path ?? this.coordDb.repoRoot;
    const file = LockEngine.normalizeFile(targetRoot, params.filePath);
    const access = this.locks.checkFileWriteAccess({ agentId: params.agentId, filePath: file });
    if (!access.allowed) throw new Error(access.reason);
    const content = params.content ?? (fs.existsSync(path.join(targetRoot, file)) ? fs.readFileSync(path.join(targetRoot, file), 'utf8') : '');

    const contractReport = this.depGraph.recordFileModification(
      params.agentId,
      file,
      content
    );

    const mergeProbe = this.shadowGit.probeAllActiveConflicts(
      params.agentId,
      [{ filePath: file, content }],
      targetRoot
    );

    const warnings: string[] = [];
    // Advisory only: matching names do not establish equivalent behavior.
    const existingSymbols = this.coordDb.db.prepare(`
      SELECT peer.symbol_name, peer.kind, peer.file_path
      FROM contracts AS edited JOIN contracts AS peer
        ON peer.symbol_name = edited.symbol_name COLLATE BINARY AND peer.kind = edited.kind
      WHERE edited.file_path = ? AND peer.file_path != edited.file_path
      ORDER BY peer.symbol_name, peer.file_path
    `).all(file) as Array<{ symbol_name: string; kind: string; file_path: string }>;
    for (const symbol of existingSymbols) {
      warnings.push(`[EXISTING SYMBOL] '${symbol.symbol_name}' (${symbol.kind}) is also recorded in '${symbol.file_path}'. Consider reuse if it serves the same purpose.`);
    }

    for (const brk of contractReport.breakingChanges) {
      const targetWho = brk.affectedAgentId
        ? ` (actively locked by agent '${brk.affectedAgentId}')`
        : '';
      warnings.push(
        `[BLAST RADIUS ALERT] Breaking signature change on '${brk.symbolName}' in '${brk.modifiedFile}' impacts downstream consumer '${brk.affectedDownstreamFile}' (${brk.hopDistance} hop(s) away)${targetWho}.`
      );
    }

    for (const conf of mergeProbe.conflicts) {
      const peer = conf.agent_a === params.agentId ? conf.agent_b : conf.agent_a;
      warnings.push(
        `[LIVE DIRTY-TREE CONFLICT] Uncommitted changes in '${conf.file_path}' conflict with active agent '${peer}' (${conf.severity}: ${conf.details.reason}).`
      );
    }

    return {
      filePath: file,
      contractReport,
      dirtyMergeConflicts: mergeProbe.conflicts,
      warnings,
    };
  }

  /**
   * Consumes unread coordination events and active conflicts for `agentId` since its last tool call
   * and formats a concise context-delta footer to append to MCP/CLI responses.
   */
  public consumeAgentDelta(agentId: string): AgentUnreadDelta {
    this.fencing.assertSession(agentId);
    const agent = this.fencing.getAgent(agentId);
    const sinceId = agent?.last_seen_event_id ?? 0;
    const page = this.coordDb.getEventsSince(sinceId, 50);
    const allNewEvents = page.filter((e) => e.agent_id !== agentId);

    const deliveredId = page.at(-1)?.id ?? sinceId;
    if (agent && deliveredId > sinceId) {
      this.coordDb.withTransaction(() => {
        this.fencing.assertSession(agentId);
        this.coordDb.db.prepare(`UPDATE agents SET last_seen_event_id = ? WHERE id = ?`).run(deliveredId, agentId);
      });
    }

    const activeConflicts = this.shadowGit
      .listConflicts()
      .filter(
        (c) =>
          c.agent_a === agentId || c.agent_b === agentId
      );

    const lines: string[] = [];
    for (const ev of allNewEvents) {
      if (
        ev.event_type === 'contracts_updated' ||
        ev.event_type === 'contract_published' ||
        ev.event_type === 'contract_breaking_change' ||
        ev.event_type === 'intent_declared'
      ) {
        lines.push(`• [${ev.event_type}] by ${ev.agent_id ?? 'system'}: ${JSON.stringify(ev.payload)}`);
      }
    }

    for (const c of activeConflicts) {
      const peer = c.agent_a === agentId ? c.agent_b : c.agent_a;
      lines.push(
        `• [ACTIVE CONFLICT] ${c.file_path} with agent '${peer}' (${c.severity}: ${c.details.reason})`
      );
    }

    const formattedFooter =
      lines.length > 0
        ? `\n\n--- KITH LIVE SIBLING DELTA ---\n${lines.join('\n')}`
        : '';

    return {
      events: allNewEvents,
      activeConflicts,
      formattedFooter,
    };
  }

  public getStatus() {
    const agents = this.fencing.listAgents(true);
    return {
      protocolVersion: KITH_PROTOCOL_VERSION,
      repository: { root: this.coordDb.repoRoot, commonGitDir: this.coordDb.commonGitDir, coordDir: this.coordDb.coordDir },
      runtime: { node: process.version }, fencingEpoch: this.coordDb.currentFencingEpoch(),
      agents, locks: this.locks.listLocks(), tasks: this.intents.listTasks(),
      conflicts: this.shadowGit.listConflicts(), contracts: this.depGraph.listContracts(), resources: this.broker.listResources(),
      mergeQueue: this.mergeTrain.listQueue(), quarantined: this.bashGuard.listQuarantined(),
      mutexWaiters: this.coordDb.db.prepare('SELECT ticket,mutex_name,owner_agent_id,session_epoch,expires_at FROM mutex_waiters ORDER BY ticket').all(),
      commandGuards: this.coordDb.db.prepare('SELECT mutex_name,owner_agent_id,worker_pid,supervisor_pid FROM mutex_runs ORDER BY mutex_name').all(),
      workspaces: observeWorkspaces(this.coordDb.repoRoot, agents),
    };
  }

  public previewIntegration(agentId: string) {
    this.fencing.assertSession(agentId);
    return previewIntegration(this.coordDb.repoRoot, this.fencing.getAgent(agentId)!);
  }

  public beginWork(params: Parameters<IntentAndTaskEngine['declareIntent']>[0] & { isolateWorktree?: boolean }) {
    const intent = this.intents.declareIntent(params);
    const worktree = intent.ok && params.isolateWorktree
      ? this.worktrees.spawnWorktree({ agentId: params.agentId }) : null;
    return { ...intent, worktree };
  }

  public completeWork(params: {
    agentId: string; taskId?: string; fencingToken?: number;
    mergeBranch?: string; verificationCmd?: string;
  }) {
    this.fencing.assertSession(params.agentId);
    const agent = this.fencing.getAgent(params.agentId);
    const branch = params.mergeBranch ?? agent?.branch;
    const mergeResult = branch ? this.mergeTrain.enqueueAndMerge({
      agentId: params.agentId, branch, worktreePath: agent?.worktree_path,
      verificationCmd: params.verificationCmd,
    }) : null;
    if (mergeResult && !mergeResult.merged) return {
      ok: false, mergeResult,
      error: 'Speculative merge train failed. Fix the reported issues before completing work.',
    };
    // Retain worktrees for inspection; release ownership only after integration succeeds.
    const completedTasks = this.intents.completeTask(params);
    this.fencing.completeAgentSession(params.agentId);
    return { ok: true, completedTasks, mergeResult };
  }

  public close(): void {
    if (this.broker.hasActiveCommands()) throw new Error('Await or cancel active mutex commands before closing Kith');
    this.coordDb.close();
  }
}

export {
  AstAnalyzer,
  ExtractedSymbol,
  BashMerkleGuard,
  ResourceBroker,
  CoordDatabase,
  CoordEvent,
  DependencyAndContractEngine,
  BlastRadiusAlert,
  FileModificationReport,
  FencingAndAgentManager,
  IntentAndTaskEngine,
  LockEngine,
  SpeculativeMergeTrain,
  ShadowGitEngine,
  ConflictRecord,
  CoWWorktreeManager,
};
