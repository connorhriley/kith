import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { KithEngine } from '../src/index.js';

let root: string;
const engines: KithEngine[] = [];
const open = () => { const engine = new KithEngine(root); engines.push(engine); return engine; };
const source = (name: string) => `export function ${name}(value: number): string { return String(value); }\n`;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-sqlite-')); });
afterEach(() => { for (const engine of engines.splice(0)) engine.close(); fs.rmSync(root, { recursive: true, force: true }); });

it('indexes, updates and removes contracts using only canonical coordination tables', () => {
  const engine = open();
  engine.fencing.registerAgent({ id: 'owner' });
  expect(engine.locks.acquireLocks({ agentId: 'owner', patterns: ['one.ts'] }).ok).toBe(true);
  engine.depGraph.recordFileModification('owner', 'one.ts', source('formatCurrency'));
  expect(engine.depGraph.listContracts().map(c => c.symbol_name)).toEqual(['formatCurrency']);
  engine.depGraph.recordFileModification('owner', 'one.ts', source('formatMoney'));
  expect(engine.depGraph.listContracts().map(c => c.symbol_name)).toEqual(['formatMoney']);
  engine.depGraph.recordFileModification('owner', 'one.ts', '');
  expect(engine.depGraph.listContracts()).toEqual([]);
  expect(engine.coordDb.db.prepare("SELECT name FROM sqlite_master WHERE name='contracts_fts'").get()).toBeUndefined();
});

it('opens older state without deleting derived search rows, contracts, capabilities or retained work', () => {
  const old = open();
  const session = old.fencing.registerAgent({ id: 'owner' });
  old.locks.acquireLocks({ agentId: 'owner', patterns: ['one.ts'] });
  old.depGraph.recordFileModification('owner', 'one.ts', source('oldHelper'));
  // Use the real legacy virtual table where available; the floor runtime has no FTS module.
  const fts = old.coordDb.db.prepare("SELECT 1 FROM pragma_module_list WHERE name='fts5'").get();
  old.coordDb.db.exec(fts
    ? 'CREATE VIRTUAL TABLE contracts_fts USING fts5(contract_id UNINDEXED,file_path,symbol_name,tokenized_name,signature,doc_comment)'
    : 'CREATE TABLE contracts_fts(contract_id,file_path,symbol_name,tokenized_name,signature,doc_comment)');
  old.coordDb.db.prepare('INSERT INTO contracts_fts VALUES(?,?,?,?,?,?)').run('legacy', 'one.ts', 'oldHelper', 'old helper', 'signature', 'doc');
  old.coordDb.db.prepare("INSERT INTO meta(key,value) VALUES('contracts_fts_dirty','0')").run();
  const recovery = path.join(old.coordDb.coordDir, 'quarantine', 'preserved.txt');
  fs.writeFileSync(recovery, 'unfinished work');
  old.close(); engines.pop();
  const reopened = open();
  reopened.fencing.resumeSession('owner', session.sessionToken);
  expect(reopened.locks.listLocks()[0].owner_agent_id).toBe('owner');
  expect(reopened.depGraph.listContracts()[0].symbol_name).toBe('oldHelper');
  reopened.depGraph.recordFileModification('owner', 'one.ts', source('newHelper'));
  expect(reopened.depGraph.listContracts()[0].symbol_name).toBe('newHelper');
  expect(reopened.coordDb.db.prepare('SELECT symbol_name FROM contracts_fts').all()).toEqual([{ symbol_name: 'oldHelper' }]);
  expect(fs.readFileSync(recovery, 'utf8')).toBe('unfinished work');
});
