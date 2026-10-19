import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AstAnalyzer, ExtractedSymbol, SymbolKind } from './ast-analyzer.js';
import { CoordDatabase } from './db.js';
import { LockEngine } from './locks.js';

export interface ContractRecord {
  id: string;
  file_path: string;
  symbol_name: string;
  kind: SymbolKind;
  signature: string;
  ast_hash: string;
  params_fingerprint: string;
  doc_comment: string;
  owner_agent_id: string | null;
  version: number;
  is_breaking: boolean;
  updated_at: number;
}

export interface BlastRadiusAlert {
  modifiedFile: string;
  symbolName: string;
  previousSignature: string;
  newSignature: string | null; // null if deleted
  affectedDownstreamFile: string;
  hopDistance: number;
  affectedAgentId: string | null;
}

export interface FileModificationReport {
  filePath: string;
  upsertedContracts: ContractRecord[];
  removedSymbols: string[];
  breakingChanges: BlastRadiusAlert[];
  transitiveDependents: Array<{ filePath: string; hopDistance: number }>;
}

export class DependencyAndContractEngine {
  constructor(
    private readonly coordDb: CoordDatabase,
    private readonly lockEngine: LockEngine
  ) {}

  public static tokenizeIdentifier(name: string): string {
    return name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-.]+/g, ' ')
      .toLowerCase()
      .trim();
  }

  /**
   * Scans a repository directory to index initial file dependencies and exported contracts.
   */
  public indexRepositoryFiles(dirPath = this.coordDb.repoRoot): number {
    const files = this.walkSourceFiles(dirPath);
    let indexedCount = 0;
    for (const file of files) {
      this.recordFileModification(null, file);
      indexedCount++;
    }
    return indexedCount;
  }

  private walkSourceFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'build' ||
        entry.name === 'target' ||
        entry.name === 'coverage'
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkSourceFiles(fullPath, acc);
      } else if (/\.(ts|tsx|js|jsx|mjs|py)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        acc.push(fullPath);
      }
    }
    return acc;
  }

  /**
   * Automatically parses a modified file's imports and exports, updates the dependency graph
   * and Contract Blackboard (including FTS5 index), and calculates the transitive blast radius
   * if any exported signature changed or was removed.
   */
  public recordFileModification(
    agentId: string | null,
    rawFilePath: string,
    sourceContent?: string
  ): FileModificationReport {
    const analysis = AstAnalyzer.analyzeSource(
      this.coordDb.repoRoot,
      rawFilePath,
      sourceContent
    );
    const relPath = analysis.filePath;
    const now = Date.now();

    return this.coordDb.withTransaction(() => {
      // 1. Update outgoing import edges in `file_deps`
      this.coordDb.db
        .prepare(`DELETE FROM file_deps WHERE source_file = ?`)
        .run(relPath);

      for (const imp of analysis.imports) {
        if (!imp.resolvedPath) continue;
        this.coordDb.db
          .prepare(`
            INSERT OR REPLACE INTO file_deps (
              source_file, target_file, imported_symbols_json, file_hash, updated_at
            )
            VALUES (?, ?, ?, ?, ?)
          `)
          .run(
            relPath,
            imp.resolvedPath,
            JSON.stringify(imp.importedSymbols),
            analysis.fileHash,
            now
          );
      }

      // 2. Compare new exports against existing contracts for this file
      const existingRows = this.coordDb.db
        .prepare(`SELECT * FROM contracts WHERE file_path = ?`)
        .all(relPath) as Array<Record<string, unknown>>;

      const existingBySymbol = new Map<string, ContractRecord>(
        existingRows.map((r) => [String(r.symbol_name), this.mapRowToContract(r)])
      );

      const newSymbolNames = new Set(analysis.exports.map((e) => e.symbolName));
      const upsertedContracts: ContractRecord[] = [];
      const removedSymbols: string[] = [];
      const changedSymbols: Array<{
        symbolName: string;
        previousSignature: string;
        newSignature: string | null;
      }> = [];

      // Check for removed exports
      for (const [oldName, oldContract] of existingBySymbol.entries()) {
        if (!newSymbolNames.has(oldName)) {
          removedSymbols.push(oldName);
          changedSymbols.push({
            symbolName: oldName,
            previousSignature: oldContract.signature,
            newSignature: null,
          });
          this.coordDb.db
            .prepare(`DELETE FROM contracts WHERE id = ?`)
            .run(oldContract.id);
          this.coordDb.db
            .prepare(`DELETE FROM contracts_fts WHERE contract_id = ?`)
            .run(oldContract.id);
        }
      }

      // Upsert current exports
      for (const exp of analysis.exports) {
        const prev = existingBySymbol.get(exp.symbolName);
        const isBreaking = prev !== undefined && prev.ast_hash !== exp.astHash;
        if (isBreaking && prev) {
          changedSymbols.push({
            symbolName: exp.symbolName,
            previousSignature: prev.signature,
            newSignature: exp.signature,
          });
        }

        const contract = this.upsertContractInternal({
          filePath: relPath,
          symbol: exp,
          agentId,
          prev,
          isBreaking,
          now,
        });
        upsertedContracts.push(contract);
      }

      // 3. Calculate transitive blast radius if exports were modified or removed
      const transitiveDependents = this.getTransitiveDependents(relPath, 4);
      const breakingChanges: BlastRadiusAlert[] = [];

      if (changedSymbols.length > 0 && transitiveDependents.length > 0) {
        const activeLocks = this.lockEngine.listLocks();

        for (const change of changedSymbols) {
          for (const dep of transitiveDependents) {
            // Check if this direct/transitive dependent imports the changed symbol (for hop=1)
            if (dep.hopDistance === 1 && dep.importedSymbols.length > 0) {
              if (
                !dep.importedSymbols.includes('*') &&
                !dep.importedSymbols.includes(change.symbolName)
              ) {
                continue;
              }
            }

            // Find if another active agent holds a lock covering `dep.filePath`
            const affectedLock = activeLocks.find(
              (l) =>
                l.owner_agent_id !== agentId &&
                LockEngine.patternsOverlap(dep.filePath, l.pattern)
            );

            const alert: BlastRadiusAlert = {
              modifiedFile: relPath,
              symbolName: change.symbolName,
              previousSignature: change.previousSignature,
              newSignature: change.newSignature,
              affectedDownstreamFile: dep.filePath,
              hopDistance: dep.hopDistance,
              affectedAgentId: affectedLock?.owner_agent_id ?? null,
            };
            breakingChanges.push(alert);

            if (agentId && affectedLock) {
              const conflictId = `conf_${crypto.randomBytes(6).toString('hex')}`;
              this.coordDb.db
                .prepare(`
                  INSERT OR REPLACE INTO conflicts (
                    id, agent_a, agent_b, file_path, severity, details_json, detected_at
                  )
                  VALUES (?, ?, ?, ?, 'transitive_contract_break', ?, ?)
                `)
                .run(
                  conflictId,
                  agentId,
                  affectedLock.owner_agent_id,
                  dep.filePath,
                  JSON.stringify(alert),
                  now
                );
            }
          }
        }

        this.coordDb.logEvent(agentId, 'contract_breaking_change', {
          filePath: relPath,
          breakingChanges,
        });
      } else if (upsertedContracts.length > 0 && agentId) {
        this.coordDb.logEvent(agentId, 'contracts_updated', {
          filePath: relPath,
          symbols: upsertedContracts.map((c) => ({
            name: c.symbol_name,
            signature: c.signature,
            version: c.version,
          })),
        });
      }

      return {
        filePath: relPath,
        upsertedContracts,
        removedSymbols,
        breakingChanges,
        transitiveDependents: transitiveDependents.map((d) => ({
          filePath: d.filePath,
          hopDistance: d.hopDistance,
        })),
      };
    });
  }

  /**
   * Explicitly publishes a contract to the shared blackboard (e.g. REST route, env var, or type).
   */
  public publishExplicitContract(params: {
    agentId: string;
    filePath: string;
    symbolName: string;
    kind: SymbolKind;
    signature: string;
    docComment?: string;
  }): ContractRecord {
    const relPath = LockEngine.normalizePattern(this.coordDb.repoRoot, params.filePath);
    const now = Date.now();
    const astHash = crypto
      .createHash('sha256')
      .update(params.signature)
      .digest('hex')
      .slice(0, 16);

    return this.coordDb.withTransaction(() => {
      const prevRow = this.coordDb.db
        .prepare(`SELECT * FROM contracts WHERE file_path = ? AND symbol_name = ?`)
        .get(relPath, params.symbolName) as Record<string, unknown> | undefined;
      const prev = prevRow ? this.mapRowToContract(prevRow) : undefined;
      const isBreaking = prev !== undefined && prev.ast_hash !== astHash;

      const contract = this.upsertContractInternal({
        filePath: relPath,
        symbol: {
          symbolName: params.symbolName,
          kind: params.kind,
          signature: params.signature,
          astHash,
          paramsFingerprint: `${params.kind}:${params.symbolName}`,
          docComment: params.docComment ?? '',
        },
        agentId: params.agentId,
        prev,
        isBreaking,
        now,
      });

      this.coordDb.logEvent(params.agentId, 'contract_published', {
        filePath: relPath,
        symbolName: params.symbolName,
        signature: params.signature,
        isBreaking,
      });

      return contract;
    });
  }

  private upsertContractInternal(params: {
    filePath: string;
    symbol: ExtractedSymbol;
    agentId: string | null;
    prev?: ContractRecord;
    isBreaking: boolean;
    now: number;
  }): ContractRecord {
    const id = params.prev?.id ?? `ctr_${crypto.randomBytes(6).toString('hex')}`;
    const version = params.prev
      ? params.prev.ast_hash !== params.symbol.astHash
        ? params.prev.version + 1
        : params.prev.version
      : 1;

    this.coordDb.db
      .prepare(`
        INSERT OR REPLACE INTO contracts (
          id, file_path, symbol_name, kind, signature,
          ast_hash, params_fingerprint, doc_comment,
          owner_agent_id, version, is_breaking, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        params.filePath,
        params.symbol.symbolName,
        params.symbol.kind,
        params.symbol.signature,
        params.symbol.astHash,
        params.symbol.paramsFingerprint,
        params.symbol.docComment,
        params.agentId ?? params.prev?.owner_agent_id ?? null,
        version,
        params.isBreaking ? 1 : 0,
        params.now
      );

    // Sync FTS5 table
    this.coordDb.db
      .prepare(`DELETE FROM contracts_fts WHERE contract_id = ?`)
      .run(id);

    this.coordDb.db
      .prepare(`
        INSERT INTO contracts_fts (
          contract_id, file_path, symbol_name, tokenized_name, signature, doc_comment
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        params.filePath,
        params.symbol.symbolName,
        DependencyAndContractEngine.tokenizeIdentifier(params.symbol.symbolName),
        params.symbol.signature,
        params.symbol.docComment
      );

    return {
      id,
      file_path: params.filePath,
      symbol_name: params.symbol.symbolName,
      kind: params.symbol.kind,
      signature: params.symbol.signature,
      ast_hash: params.symbol.astHash,
      params_fingerprint: params.symbol.paramsFingerprint,
      doc_comment: params.symbol.docComment,
      owner_agent_id: params.agentId ?? params.prev?.owner_agent_id ?? null,
      version,
      is_breaking: params.isBreaking,
      updated_at: params.now,
    };
  }

  /**
   * Computes all files that directly or transitively import `targetFile` up to `maxHops` away.
   */
  public getTransitiveDependents(
    targetFile: string,
    maxHops = 4
  ): Array<{ filePath: string; hopDistance: number; importedSymbols: string[] }> {
    const normTarget = LockEngine.normalizePattern(this.coordDb.repoRoot, targetFile);
    const visited = new Map<string, { hopDistance: number; importedSymbols: string[] }>();
    let frontier: string[] = [normTarget];

    for (let hop = 1; hop <= maxHops; hop++) {
      const nextFrontier: string[] = [];
      for (const curr of frontier) {
        const rows = this.coordDb.db
          .prepare(`SELECT source_file, imported_symbols_json FROM file_deps WHERE target_file = ?`)
          .all(curr) as Array<{ source_file: string; imported_symbols_json: string }>;

        for (const r of rows) {
          if (r.source_file === normTarget || visited.has(r.source_file)) continue;
          visited.set(r.source_file, {
            hopDistance: hop,
            importedSymbols: JSON.parse(r.imported_symbols_json) as string[],
          });
          nextFrontier.push(r.source_file);
        }
      }
      if (nextFrontier.length === 0) break;
      frontier = nextFrontier;
    }

    return Array.from(visited.entries()).map(([filePath, meta]) => ({
      filePath,
      hopDistance: meta.hopDistance,
      importedSymbols: meta.importedSymbols,
    }));
  }

  public listContracts(filePathFilter?: string): ContractRecord[] {
    const rows = filePathFilter
      ? (this.coordDb.db
          .prepare(`SELECT * FROM contracts WHERE file_path = ? ORDER BY updated_at DESC`)
          .all(LockEngine.normalizePattern(this.coordDb.repoRoot, filePathFilter)) as Array<
          Record<string, unknown>
        >)
      : (this.coordDb.db
          .prepare(`SELECT * FROM contracts ORDER BY updated_at DESC`)
          .all() as Array<Record<string, unknown>>);

    return rows.map((r) => this.mapRowToContract(r));
  }

  private mapRowToContract(row: Record<string, unknown>): ContractRecord {
    return {
      id: String(row.id),
      file_path: String(row.file_path),
      symbol_name: String(row.symbol_name),
      kind: row.kind as SymbolKind,
      signature: String(row.signature),
      ast_hash: String(row.ast_hash),
      params_fingerprint: String(row.params_fingerprint),
      doc_comment: String(row.doc_comment ?? ''),
      owner_agent_id: (row.owner_agent_id as string | null) ?? null,
      version: Number(row.version),
      is_breaking: Boolean(row.is_breaking),
      updated_at: Number(row.updated_at),
    };
  }
}
