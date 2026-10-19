import fs from 'node:fs';
import path from 'node:path';
import { AstAnalyzer, ExtractedSymbol } from './ast-analyzer.js';
import { BashMerkleGuard } from './bash-guard.js';
import { ResourceBroker } from './broker.js';
import { CoordDatabase, CoordEvent } from './db.js';
import { DuplicateSymbolMatch, SemanticDeduplicator } from './dedup.js';
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
  duplicates: DuplicateSymbolMatch[];
  dirtyMergeConflicts: ConflictRecord[];
  autoMergeableFiles: string[];
  warnings: string[];
}

export class KithEngine {
  public readonly coordDb: CoordDatabase;
  public readonly fencing: FencingAndAgentManager;
  public readonly locks: LockEngine;
  public readonly intents: IntentAndTaskEngine;
  public readonly depGraph: DependencyAndContractEngine;
  public readonly dedup: SemanticDeduplicator;
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
    this.dedup = new SemanticDeduplicator(this.coordDb);
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
   * 3. Checks for semantic duplicate utilities/functions via FTS5 BM25 + AST type fingerprints
   * 4. Updates the agent's shadow Git index (`GIT_INDEX_FILE`) and runs `git merge-tree` against sibling dirty trees
   */
  public processPostFileEdit(params: {
    agentId: string;
    filePath: string;
    content?: string;
    worktreeDir?: string;
  }): PostFileEditHookResult {
    this.fencing.heartbeat(params.agentId);
    const targetRoot = params.worktreeDir ?? this.fencing.getAgent(params.agentId)?.worktree_path ?? this.coordDb.repoRoot;
    const file = LockEngine.normalizePattern(targetRoot, params.filePath);
    const access = this.locks.checkFileWriteAccess({ agentId: params.agentId, filePath: file });
    if (!access.allowed) throw new Error(access.reason);
    const content = params.content ?? (fs.existsSync(path.join(targetRoot, file)) ? fs.readFileSync(path.join(targetRoot, file), 'utf8') : '');

    const analysis = AstAnalyzer.analyzeSource(
      targetRoot,
      file,
      content
    );

    const duplicates = this.dedup.findDuplicateSymbols({
      filePath: analysis.filePath,
      symbols: analysis.exports,
    });

    const contractReport = this.depGraph.recordFileModification(
      params.agentId,
      analysis.filePath,
      content
    );

    const mergeProbe = this.shadowGit.probeAllActiveConflicts(
      params.agentId,
      [{ filePath: analysis.filePath, content }],
      targetRoot
    );

    const warnings: string[] = [];

    for (const dup of duplicates) {
      warnings.push(
        `[DUPLICATE SYMBOL WARNING] '${dup.newSymbolName}' in '${dup.newFilePath}' closely matches '${dup.existingContract.symbol_name}' (${dup.existingContract.signature}) in '${dup.existingContract.file_path}' [similarity: ${Math.round(
          dup.similarityScore * 100
        )}%, ${dup.reason}]. Import the existing symbol instead of duplicating.`
      );
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
      filePath: analysis.filePath,
      contractReport,
      duplicates,
      dirtyMergeConflicts: mergeProbe.conflicts,
      autoMergeableFiles: mergeProbe.autoMergeableFiles,
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
          (c.agent_a === agentId || c.agent_b === agentId) &&
          c.severity !== 'auto_mergeable'
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
  SemanticDeduplicator,
  DuplicateSymbolMatch,
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
