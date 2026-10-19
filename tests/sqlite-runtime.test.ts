import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AstAnalyzer, CoordDatabase, KithEngine } from '../src/index.js';

const probe = new DatabaseSync(':memory:');
const nativeFts = CoordDatabase.hasFts5(probe); probe.close();
let root: string;
const engines: KithEngine[] = [];
const open = () => { const engine = new KithEngine(root); engines.push(engine); return engine; };
const source = (name: string) => `export function ${name}(value: number): string { return String(value); }\n`;
const hint = (engine: KithEngine, name: string) => engine.dedup.findDuplicateSymbols({ filePath: 'other.ts', symbols: AstAnalyzer.analyzeSource(root, 'other.ts', source(name)).exports });
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-sqlite-')); });
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.close(); fs.rmSync(root, { recursive: true, force: true }); });

it('preserves contract indexing, duplicate hints and coordination without FTS5', () => {
  vi.spyOn(CoordDatabase, 'hasFts5').mockReturnValue(false);
  const engine = open();
  expect(engine.coordDb.supportsFts5).toBe(false);
  engine.fencing.registerAgent({ id: 'owner' });
  expect(engine.locks.acquireLocks({ agentId: 'owner', patterns: ['one.ts'] }).ok).toBe(true);
  engine.depGraph.recordFileModification('owner', 'one.ts', source('formatCurrency'));
  expect(hint(engine, 'formatCurrency')[0].existingContract.symbol_name).toBe('formatCurrency');
  engine.depGraph.recordFileModification('owner', 'one.ts', source('formatMoney'));
  expect(engine.depGraph.listContracts().map((c) => c.symbol_name)).toEqual(['formatMoney']);
  engine.depGraph.recordFileModification('owner', 'one.ts', '');
  expect(engine.depGraph.listContracts()).toEqual([]);
  expect(hint(engine, 'formatMoney')).toEqual([]);
  expect(engine.coordDb.db.prepare("SELECT name FROM sqlite_master WHERE name='contracts_fts'").get()).toBeUndefined();
});

it.skipIf(!nativeFts)('builds an optional index from authoritative contracts after a no-FTS runtime created state', () => {
  const capability = vi.spyOn(CoordDatabase, 'hasFts5').mockReturnValue(false);
  const fallback = open();
  fallback.depGraph.recordFileModification(null, 'one.ts', source('getAccount'));
  capability.mockRestore();
  const full = open();
  expect(full.coordDb.supportsFts5).toBe(true);
  expect(full.coordDb.db.prepare("SELECT symbol_name FROM contracts_fts WHERE contracts_fts MATCH 'account'").all()).toEqual([{ symbol_name: 'getAccount' }]);
  // A still-open older runtime edits after the newer runtime has rebuilt the index.
  fallback.depGraph.recordFileModification(null, 'one.ts', source('fetchProfile'));
  full.coordDb.refreshContractSearch();
  expect(full.coordDb.db.prepare("SELECT symbol_name FROM contracts_fts WHERE contracts_fts MATCH 'account'").all()).toEqual([]);
  expect(full.coordDb.db.prepare("SELECT symbol_name FROM contracts_fts WHERE contracts_fts MATCH 'profile'").all()).toEqual([{ symbol_name: 'fetchProfile' }]);
});

it.skipIf(!nativeFts)('repairs a retained legacy FTS index after fallback updates and deletions without losing contracts', () => {
  const full = open();
  full.depGraph.recordFileModification(null, 'one.ts', source('oldHelper'));
  full.depGraph.recordFileModification(null, 'two.ts', source('deletedHelper'));
  const capability = vi.spyOn(CoordDatabase, 'hasFts5').mockReturnValue(false);
  const fallback = open();
  fallback.depGraph.recordFileModification(null, 'one.ts', source('newHelper'));
  fallback.depGraph.recordFileModification(null, 'two.ts', '');
  capability.mockRestore();
  const reopened = open();
  expect(reopened.depGraph.listContracts().map((c) => c.symbol_name)).toEqual(['newHelper']);
  expect(reopened.coordDb.db.prepare('SELECT symbol_name FROM contracts_fts').all()).toEqual([{ symbol_name: 'newHelper' }]);
  expect(hint(reopened, 'newHelper')).toHaveLength(1);
});
