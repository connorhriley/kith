import { ExtractedSymbol } from './ast-analyzer.js';
import { CoordDatabase } from './db.js';
import { ContractRecord, DependencyAndContractEngine } from './dep-graph.js';
import { LockEngine } from './locks.js';

export interface DuplicateSymbolMatch {
  existingContract: ContractRecord;
  newSymbolName: string;
  newFilePath: string;
  similarityScore: number;
  reason: string;
}

const SYNONYM_GROUPS: string[][] = [
  ['money', 'currency', 'price', 'cents', 'amount', 'cost', 'usd'],
  ['date', 'time', 'timestamp', 'iso', 'datetime', 'duration'],
  ['auth', 'token', 'jwt', 'session', 'credentials', 'login'],
  ['format', 'stringify', 'serialize', 'render', 'pretty', 'display'],
  ['parse', 'deserialize', 'decode', 'extract'],
  ['validate', 'verify', 'check', 'assert', 'ensure', 'sanitize'],
  ['fetch', 'get', 'load', 'retrieve', 'query', 'find'],
  ['user', 'account', 'profile', 'member'],
  ['hash', 'digest', 'checksum', 'fingerprint', 'sha'],
];

export class SemanticDeduplicator {
  constructor(private readonly coordDb: CoordDatabase) {}

  public static normalizeWithSynonyms(name: string): string[] {
    const rawTokens = DependencyAndContractEngine.tokenizeIdentifier(name)
      .split(/\s+/)
      .filter((t) => t.length >= 2);

    return rawTokens.map((token) => {
      for (const group of SYNONYM_GROUPS) {
        if (group.includes(token)) {
          return group[0]; // canonical representative
        }
      }
      return token;
    });
  }

  /**
   * Checks newly extracted symbols from a file against all existing contracts in the repo
   * and sibling agents (excluding the same file itself) using FTS5 BM25 + AST type fingerprints.
   */
  public findDuplicateSymbols(params: {
    filePath: string;
    symbols: ExtractedSymbol[];
    threshold?: number;
  }): DuplicateSymbolMatch[] {
    const relPath = LockEngine.normalizePattern(this.coordDb.repoRoot, params.filePath);
    const threshold = params.threshold ?? 0.65;
    const duplicates: DuplicateSymbolMatch[] = [];

    // Fetch candidate contracts from other files
    const otherContracts = this.coordDb.db
      .prepare(`SELECT * FROM contracts WHERE file_path != ?`)
      .all(relPath) as Array<Record<string, unknown>>;

    if (otherContracts.length === 0) return [];

    for (const sym of params.symbols) {
      // Also run FTS5 query to get BM25-ranked candidates
      const ftsTokens = DependencyAndContractEngine.tokenizeIdentifier(sym.symbolName)
        .split(/\s+/)
        .map((t) => t.replace(/[^a-z0-9]/g, ''))
        .filter((t) => t.length >= 2);

      const ftsBoostIds = new Set<string>();
      if (ftsTokens.length > 0) {
        const matchExpr = ftsTokens.map((t) => `"${t}"*`).join(' OR ');
        try {
          const ftsRows = this.coordDb.db
            .prepare(
              `SELECT contract_id FROM contracts_fts WHERE contracts_fts MATCH ? AND file_path != ? LIMIT 25`
            )
            .all(matchExpr, relPath) as Array<{ contract_id: string }>;
          for (const r of ftsRows) {
            ftsBoostIds.add(r.contract_id);
          }
        } catch {
          // Ignore FTS syntax edge cases
        }
      }

      const canonicalNewTokens = new Set(
        SemanticDeduplicator.normalizeWithSynonyms(sym.symbolName)
      );

      for (const row of otherContracts) {
        const existingId = String(row.id);
        const existingName = String(row.symbol_name);
        const existingKind = String(row.kind);
        const existingFp = String(row.params_fingerprint);

        if (existingKind !== sym.kind) continue;

        let score = 0;
        const reasons: string[] = [];

        // 1. Exact symbol name in a different file
        if (existingName.toLowerCase() === sym.symbolName.toLowerCase()) {
          score += 0.75;
          reasons.push(`identical symbol name '${existingName}'`);
        } else {
          // 2. Canonical synonym token overlap
          const canonicalExisting = new Set(
            SemanticDeduplicator.normalizeWithSynonyms(existingName)
          );
          let overlap = 0;
          for (const t of canonicalNewTokens) {
            if (canonicalExisting.has(t)) overlap++;
          }
          const union = canonicalNewTokens.size + canonicalExisting.size - overlap;
          const tokenSim = union > 0 ? overlap / union : 0;
          if (tokenSim > 0) {
            score += tokenSim * 0.55;
            if (tokenSim >= 0.5) {
              reasons.push(`semantic identifier match (${Math.round(tokenSim * 100)}%)`);
            }
          }
        }

        // 3. Structural parameter & return-type fingerprint match
        if (
          sym.paramsFingerprint &&
          sym.paramsFingerprint === existingFp &&
          !sym.paramsFingerprint.includes('()->unknown') &&
          !sym.paramsFingerprint.startsWith('const:')
        ) {
          score += 0.35;
          reasons.push(`matching type signature ${existingFp}`);
        }

        // 4. FTS5 BM25 hit boost
        if (ftsBoostIds.has(existingId)) {
          score += 0.1;
        }

        const clampedScore = Math.min(1, Number(score.toFixed(2)));
        if (clampedScore >= threshold) {
          duplicates.push({
            existingContract: {
              id: existingId,
              file_path: String(row.file_path),
              symbol_name: existingName,
              kind: existingKind as ContractRecord['kind'],
              signature: String(row.signature),
              ast_hash: String(row.ast_hash),
              params_fingerprint: existingFp,
              doc_comment: String(row.doc_comment ?? ''),
              owner_agent_id: (row.owner_agent_id as string | null) ?? null,
              version: Number(row.version),
              is_breaking: Boolean(row.is_breaking),
              updated_at: Number(row.updated_at),
            },
            newSymbolName: sym.symbolName,
            newFilePath: relPath,
            similarityScore: clampedScore,
            reason: reasons.join(' + ') || 'high FTS5 + signature similarity',
          });
        }
      }
    }

    return duplicates.sort((a, b) => b.similarityScore - a.similarityScore);
  }
}
