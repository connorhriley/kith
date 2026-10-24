import type { BlastRadiusAlert, ContractRecord } from '../core/dep-graph.js';
import type { PostFileEditHookResult, KithEngine } from '../core/engine.js';
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
  affected: Array<Pick<BlastRadiusAlert, 'affectedDownstreamFile' | 'affectedAgentId' | 'hopDistance'>>;
}

/**
 * Strips internal database hashing/fingerprinting fields (`id`, `ast_hash`,
 * `params_fingerprint`, `updated_at`). Keep actionable signatures and ownership
 * unchanged; full registry records remain available through includeContracts.
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
    const key = JSON.stringify([alert.modifiedFile, alert.symbolName, alert.previousSignature, alert.newSignature]);
    let group = grouped.get(key);
    if (!group) {
      group = {
        modifiedFile: alert.modifiedFile,
        symbolName: alert.symbolName,
        previousSignature: alert.previousSignature,
        newSignature: alert.newSignature,
        affected: [],
      };
      grouped.set(key, group);
    }
    const {modifiedFile, symbolName, previousSignature, newSignature, ...consumer} = alert;
    group.affected.push(consumer);
  }
  return [...grouped.values()];
}

/** A write claim does not describe read dependencies. Keep contracts from every
 * scope, with all breaking contracts first. Cap only the ordinary preview and
 * explicitly point to the existing full registry when that preview is partial.
 */
export function compactPublishedContracts(contracts: ContractRecord[]) {
  const breaking = contracts.filter(c => c.is_breaking);
  const ordinary = contracts.filter(c => !c.is_breaking);
  const selected = [...breaking, ...ordinary.slice(0, Math.max(0, 30 - breaking.length))];
  const omitted = contracts.length - selected.length;
  return {
    publishedContracts: selected.map(compactContract),
    totalPublishedContracts: contracts.length,
    publishedContractsComplete: omitted === 0,
    publishedContractsOmitted: omitted,
    ...(omitted ? {contractDetails: 'Use kith_get_status with includeContracts: true in the same repository for all records.'} : {}),
  };
}

/**
 * Compacts cross-repo linked contracts by stripping internal `astHash` fields
 * without imposing another cap. The core already bounds these reports and
 * carries explicit completeness/availability flags.
 */
export function compactLinkedContracts(
  linkedContracts: LinkedWorkspaceContract[] | undefined
): Array<Record<string, unknown>> | undefined {
  if (!linkedContracts) return undefined;
  return linkedContracts.map((entry) => {
    const rawSymbols = entry.symbols ?? [];
    const symbols = rawSymbols.map((sym) => ({
      symbolName: sym.symbolName,
      kind: sym.kind,
      signature: sym.signature,
    }));
    return {
      alias: entry.alias,
      sourceRepo: entry.sourceRepo,
      sourceRepoName: entry.sourceRepoName,
      filePath: entry.filePath,
      symbols,
      totalSymbolsInFile: entry.exportsComplete ? rawSymbols.length : null,
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
  return {
    filePath: res.filePath,
    contractReport: {
      filePath: res.contractReport.filePath,
      upsertedCount: upserted.length,
      upsertedContracts: upserted.map(compactContract),
      removedSymbols: res.contractReport.removedSymbols,
      breakingChanges: res.contractReport.breakingChanges,
      transitiveDependents: res.contractReport.transitiveDependents,
    },
    dirtyMergeConflicts: res.dirtyMergeConflicts,
    warnings: res.warnings,
  };
}

/**
 * Compacts `kith_get_status` by omitting historical `"status": "done"` tasks
 * unless `includeHistory: true` is requested. Keep complete lock lease records
 * and the full registry when includeContracts is explicitly requested.
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
          ...parsed,
          breakingChanges: compactBreakingChanges(parsed.breakingChanges),
        };
        return `${line.slice(0, jsonStart)}${JSON.stringify(compactPayload)}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}
