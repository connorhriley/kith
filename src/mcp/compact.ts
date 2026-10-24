import path from 'node:path';
import type { BlastRadiusAlert, ContractRecord } from '../core/dep-graph.js';
import type { PostFileEditHookResult, KithEngine } from '../core/engine.js';
import type { LockRecord } from '../core/locks.js';
import { LockEngine } from '../core/locks.js';
import type { LinkedWorkspaceContract } from '../core/workspace-contracts.js';

export interface CompactContract {
  file_path: string;
  symbol_name: string;
  kind: string;
  signature: string;
  version: number;
  is_breaking: boolean;
  owner_agent_id?: string | null;
  doc_comment?: string;
}

export interface CompactBreakingChangeGroup {
  modifiedFile: string;
  symbolName: string;
  previousSignature: string;
  newSignature: string | null;
  affectedDownstreamFiles: string[];
  affectedAgents: string[];
}

/**
 * Strips internal database hashing/fingerprinting fields (`id`, `ast_hash`,
 * `params_fingerprint`, `updated_at`) that add ~60% token overhead without
 * providing actionable signal to an LLM agent.
 */
export function compactContract(contract: ContractRecord): CompactContract {
  const result: CompactContract = {
    file_path: contract.file_path,
    symbol_name: contract.symbol_name,
    kind: contract.kind,
    signature: contract.signature,
    version: contract.version,
    is_breaking: contract.is_breaking,
  };
  if (contract.owner_agent_id) result.owner_agent_id = contract.owner_agent_id;
  if (contract.doc_comment) result.doc_comment = contract.doc_comment;
  return result;
}

/**
 * Deduplicates `BlastRadiusAlert[]` so a breaking change on a shared symbol
 * imported by N downstream files does not repeat `previousSignature` and
 * `newSignature` N times.
 */
export function compactBreakingChanges(alerts: BlastRadiusAlert[]): CompactBreakingChangeGroup[] {
  const grouped = new Map<string, CompactBreakingChangeGroup>();
  for (const alert of alerts) {
    const key = `${alert.modifiedFile}#${alert.symbolName}`;
    let group = grouped.get(key);
    if (!group) {
      group = {
        modifiedFile: alert.modifiedFile,
        symbolName: alert.symbolName,
        previousSignature: alert.previousSignature,
        newSignature: alert.newSignature,
        affectedDownstreamFiles: [],
        affectedAgents: [],
      };
      grouped.set(key, group);
    }
    if (!group.affectedDownstreamFiles.includes(alert.affectedDownstreamFile)) {
      group.affectedDownstreamFiles.push(alert.affectedDownstreamFile);
    }
    if (alert.affectedAgentId && !group.affectedAgents.includes(alert.affectedAgentId)) {
      group.affectedAgents.push(alert.affectedAgentId);
    }
  }
  return [...grouped.values()];
}

/**
 * Filters repository contracts to those relevant to the agent's declared
 * `scopeGlobs`, sibling active locks, or breaking changes, and compacts each
 * entry. Prevents dumping dozens of unrelated contracts on every session start.
 */
export function compactContractsForScope(
  contracts: ContractRecord[],
  scopeGlobs: string[],
  activeLocks: LockRecord[] = [],
  maxItems = 12
): { publishedContracts: CompactContract[]; totalPublishedContracts: number } {
  const scopeDirs = new Set(
    scopeGlobs
      .filter((g) => !g.includes('*'))
      .map((g) => path.posix.dirname(g.replace(/\\/g, '/')))
      .filter((d) => d && d !== '.')
  );

  const relevant = contracts.filter((c) => {
    if (c.is_breaking) return true;
    if (scopeGlobs.some((glob) => LockEngine.patternsOverlap(c.file_path, glob))) return true;
    const dir = path.posix.dirname(c.file_path.replace(/\\/g, '/'));
    if (scopeDirs.has(dir)) return true;
    if (activeLocks.some((lock) => LockEngine.patternsOverlap(c.file_path, lock.pattern))) return true;
    return false;
  });

  relevant.sort((a, b) => {
    if (a.is_breaking !== b.is_breaking) return a.is_breaking ? -1 : 1;
    return b.updated_at - a.updated_at;
  });

  return {
    publishedContracts: relevant.slice(0, maxItems).map(compactContract),
    totalPublishedContracts: contracts.length,
  };
}

/**
 * Compacts cross-repo linked contracts by stripping internal `astHash` fields
 * and capping per-file symbol lists when a sibling file is clean and unlocked.
 */
export function compactLinkedContracts(
  linkedContracts: LinkedWorkspaceContract[] | undefined,
  maxSymbolsPerCleanFile = 8
): Array<Record<string, unknown>> | undefined {
  if (!linkedContracts) return undefined;
  return linkedContracts.map((entry) => {
    const isHot = Boolean(entry.dirtyInCheckout) || Boolean(entry.lockedByAgent) || entry.activeWorktreeDrifts.length > 0;
    const rawSymbols = entry.symbols ?? [];
    const limit = isHot ? rawSymbols.length : maxSymbolsPerCleanFile;
    const sliced = rawSymbols.slice(0, limit).map((sym) => ({
      symbolName: sym.symbolName,
      kind: sym.kind,
      signature: sym.signature,
    }));
    return {
      alias: entry.alias,
      sourceRepo: entry.sourceRepo,
      sourceRepoName: entry.sourceRepoName,
      filePath: entry.filePath,
      symbols: sliced,
      totalSymbolsInFile: rawSymbols.length,
      dirtyInCheckout: entry.dirtyInCheckout,
      exportsComplete: entry.exportsComplete,
      ownershipAvailable: entry.ownershipAvailable,
      lockedByAgent: entry.lockedByAgent,
      activeWorktreeDrifts: entry.activeWorktreeDrifts,
    };
  });
}

/**
 * Compacts `kith_record_file_edit` output so clean edits do not echo back
 * massive `params_fingerprint` and `ast_hash` payloads for every exported symbol
 * in the file, while keeping 100% of breaking-change and conflict diagnostics.
 */
export function compactFileEditResult(res: PostFileEditHookResult): Record<string, unknown> {
  const upserted = res.contractReport.upsertedContracts;
  const hasIssues =
    res.contractReport.breakingChanges.length > 0 ||
    res.contractReport.removedSymbols.length > 0 ||
    res.dirtyMergeConflicts.length > 0 ||
    res.warnings.length > 0;

  const limit = hasIssues ? 25 : 10;
  return {
    filePath: res.filePath,
    contractReport: {
      filePath: res.contractReport.filePath,
      upsertedCount: upserted.length,
      upsertedContracts: upserted.slice(0, limit).map(compactContract),
      removedSymbols: res.contractReport.removedSymbols,
      breakingChanges: compactBreakingChanges(res.contractReport.breakingChanges),
      transitiveDependents: res.contractReport.transitiveDependents,
    },
    dirtyMergeConflicts: res.dirtyMergeConflicts,
    warnings: res.warnings,
  };
}

export function compactLock(lock: LockRecord): Record<string, unknown> {
  return {
    pattern: lock.pattern,
    mode: lock.mode,
    owner_agent_id: lock.owner_agent_id,
    task_id: lock.task_id,
    fencing_token: lock.fencing_token,
  };
}

/**
 * Compacts `kith_get_status` by omitting historical `"status": "done"` tasks
 * unless `includeHistory: true` is requested, compacting lock records, and
 * stripping internal contract fingerprints when `includeContracts: true`.
 */
export function compactStatusResult(
  state: ReturnType<KithEngine['getStatus']>,
  options: { includeContracts?: boolean; includeHistory?: boolean } = {}
): Record<string, unknown> {
  const includeHistory = options.includeHistory ?? false;
  const includeContracts = options.includeContracts ?? false;
  const activeOrPendingTasks = includeHistory
    ? state.tasks
    : state.tasks.filter((t) => t.status !== 'done');
  const completedTaskCount = state.tasks.filter((t) => t.status === 'done').length;

  return {
    ...state,
    locks: includeHistory ? state.locks : state.locks.map(compactLock),
    tasks: activeOrPendingTasks,
    completedTaskCount,
    historyIncluded: includeHistory,
    contracts: includeContracts ? state.contracts : [],
    contractCount: state.contracts.length,
    contractsIncluded: includeContracts,
  };
}

/**
 * Compacts the live sibling delta footer so `contract_breaking_change` events
 * with many downstream dependents do not repeat `previousSignature` and
 * `newSignature` dozens of times in the tool response footer.
 */
export function compactDeltaFooter(footer: string): string {
  if (!footer) return footer;
  return footer
    .split('\n')
    .map((line) => {
      const marker = '[contract_breaking_change]';
      const idx = line.indexOf(marker);
      if (idx === -1) return line;
      const jsonStart = line.indexOf('{', idx);
      if (jsonStart === -1) return line;
      try {
        const parsed = JSON.parse(line.slice(jsonStart)) as {
          filePath?: string;
          breakingChanges?: BlastRadiusAlert[];
        };
        if (!Array.isArray(parsed.breakingChanges)) return line;
        const compactPayload = {
          filePath: parsed.filePath,
          breakingChanges: compactBreakingChanges(parsed.breakingChanges),
        };
        return `${line.slice(0, jsonStart)}${JSON.stringify(compactPayload)}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}
