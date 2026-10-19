import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { KithEngine } from '../src/core/engine.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-recovery-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it.each(['garbage', '', '0', '1.5', '02', '999'])('refuses schema version %j without changing the database', value => {
  fs.mkdirSync(path.join(root, '.coord'));
  const file = path.join(root, '.coord/state.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE precious(value TEXT); INSERT INTO precious VALUES(\'keep\');');
  db.prepare('INSERT INTO meta VALUES(?,?)').run('schema_version', value);
  db.close();
  const before = fs.readFileSync(file);
  expect(() => new KithEngine(root)).toThrow('schema');
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.readdirSync(path.join(root, '.coord'))).toEqual(['state.db']);
});

it.each([false, true])('refuses missing schema metadata (meta table exists: %s) without initialization', hasMeta => {
  fs.mkdirSync(path.join(root, '.coord'));
  const file = path.join(root, '.coord/state.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE precious(value TEXT); INSERT INTO precious VALUES(\'keep\');');
  if (hasMeta) db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  db.close();
  const before = fs.readFileSync(file);
  expect(() => new KithEngine(root)).toThrow('schema');
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.readdirSync(path.join(root, '.coord'))).toEqual(['state.db']);
});

it('rolls back a failed legacy upgrade, preserves recovery files, and can retry after repair', () => {
  const original = new KithEngine(root);
  original.fencing.registerAgent({ id: 'legacy' });
  original.intents.addTask({ id: 'job', title: 'Preserve task', scopeGlobs: ['file.ts'] });
  original.intents.claimNextTask('legacy');
  const coord = original.coordDb.coordDir;
  fs.writeFileSync(path.join(root, 'file.ts'), 'unfinished work');
  fs.writeFileSync(path.join(coord, 'quarantine/recovery.before'), 'original bytes');
  original.close();
  const file = path.join(coord, 'state.db');
  const db = new DatabaseSync(file);
  // The legacy layout has no session capabilities, queue tickets or command guards.
  db.exec("DROP TABLE agent_sessions; DROP TABLE mutex_waiters; DROP TABLE mutex_runs; UPDATE meta SET value='1' WHERE key='schema_version';");
  db.exec("CREATE TRIGGER fail_upgrade BEFORE UPDATE ON agents BEGIN SELECT RAISE(ABORT,'interrupted upgrade'); END;");
  const tables = ['meta','agents','tasks','locks'];
  const dump = () => JSON.stringify(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all()));
  const before = dump();
  expect(() => new KithEngine(root)).toThrow('interrupted upgrade');
  expect(dump()).toBe(before);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('agent_sessions','mutex_waiters','mutex_runs')").all()).toEqual([]);
  expect(fs.readFileSync(path.join(root, 'file.ts'), 'utf8')).toBe('unfinished work');
  expect(fs.readFileSync(path.join(coord, 'quarantine/recovery.before'), 'utf8')).toBe('original bytes');
  db.exec('DROP TRIGGER fail_upgrade'); db.close();
  const recovered = new KithEngine(root);
  try {
    expect(recovered.intents.getTask('job')?.status).toBe('queued');
    expect(recovered.fencing.getAgent('legacy')?.status).toBe('dead');
    expect(recovered.locks.listLocks()).toEqual([]);
    expect(recovered.coordDb.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '2' });
  } finally { recovered.close(); }
});
