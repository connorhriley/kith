import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
  db.exec("DROP TABLE mcp_operations; DROP TABLE agent_sessions; DROP TABLE mutex_waiters; DROP TABLE mutex_runs; UPDATE meta SET value='1' WHERE key='schema_version';");
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
    expect(recovered.coordDb.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '3' });
  } finally { recovered.close(); }
});

it.each(['locks', 'mutex_runs', 'agent_sessions', 'quarantine', 'mcp_operations'])('refuses a schema-3 database missing %s instead of recreating empty state', table => {
  const engine = new KithEngine(root);
  engine.fencing.registerAgent({ id: 'owner' });
  engine.locks.acquireLocks({ agentId: 'owner', patterns: ['work.txt'] });
  engine.close();
  const file = path.join(root, '.coord/state.db');
  const db = new DatabaseSync(file); db.exec(`DROP TABLE ${table}`); db.close();
  const before = fs.readFileSync(file);
  let reopened: KithEngine | undefined;
  try { expect(() => { reopened = new KithEngine(root); }).toThrow('Incomplete'); }
  finally { reopened?.close(); }
  expect(fs.readFileSync(file)).toEqual(before);
});

it.each(['missing', 'zero', 'empty'])('refuses %s database state when recovery files already exist', mode => {
  const coord = path.join(root, '.coord'); fs.mkdirSync(path.join(coord, 'worktrees/retained'), { recursive: true });
  const work = path.join(coord, 'worktrees/retained/unfinished.txt'); fs.writeFileSync(work, 'precious work');
  const file = path.join(coord, 'state.db');
  if (mode === 'zero') fs.writeFileSync(file, '');
  if (mode === 'empty') { const db = new DatabaseSync(file); db.exec('PRAGMA user_version=0'); db.close(); }
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  let reopened: KithEngine | undefined;
  try { expect(() => { reopened = new KithEngine(root); }).toThrow('recovery'); }
  finally { reopened?.close(); }
  expect(fs.existsSync(file) ? fs.readFileSync(file) : null).toEqual(before);
  expect(fs.readFileSync(work, 'utf8')).toBe('precious work');
});

it('preserves orphan WAL files instead of creating a replacement database', () => {
  const coord = path.join(root, '.coord'); fs.mkdirSync(coord);
  const wal = path.join(coord, 'state.db-wal'); fs.writeFileSync(wal, 'preserve orphan recovery bytes');
  let reopened: KithEngine | undefined;
  try { expect(() => { reopened = new KithEngine(root); }).toThrow('recovery'); }
  finally { reopened?.close(); }
  expect(fs.existsSync(path.join(coord, 'state.db'))).toBe(false);
  expect(fs.readFileSync(wal, 'utf8')).toBe('preserve orphan recovery bytes');
});

it.each(['missing', 'garbage', '-1', '1001.5', '9007199254740992', '1000'])('refuses a missing, invalid or regressed fencing counter (%s)', value => {
  const engine = new KithEngine(root);
  engine.fencing.registerAgent({ id: 'owner' });
  engine.locks.acquireLocks({ agentId: 'owner', patterns: ['work.txt'] });
  engine.close();
  const file = path.join(root, '.coord/state.db');
  const db = new DatabaseSync(file);
  if (value === 'missing') db.exec("DELETE FROM meta WHERE key='fencing_epoch'");
  else db.prepare("UPDATE meta SET value=? WHERE key='fencing_epoch'").run(value);
  db.close();
  const before = fs.readFileSync(file);
  let reopened: KithEngine | undefined;
  try { expect(() => { reopened = new KithEngine(root); }).toThrow('fencing'); }
  finally { reopened?.close(); }
  expect(fs.readFileSync(file)).toEqual(before);
});

it('refuses damaged pages outside the metadata tables without changing database bytes', () => {
  const engine = new KithEngine(root); engine.close();
  const file = path.join(root, '.coord/state.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE extra_data(payload TEXT); INSERT INTO extra_data VALUES('precious recovery note')");
  const page = (db.prepare("SELECT rootpage FROM sqlite_master WHERE name='extra_data'").get() as { rootpage: number }).rootpage;
  const size = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  db.close();
  const damaged = fs.readFileSync(file); damaged[(page - 1) * size] = 0xff; fs.writeFileSync(file, damaged);
  expect(() => new KithEngine(root)).toThrow();
  expect(fs.readFileSync(file)).toEqual(damaged);
});

it('fails closed at fencing exhaustion without rounding or resetting the counter', () => {
  const engine = new KithEngine(root);
  try {
    engine.coordDb.db.prepare("UPDATE meta SET value=? WHERE key='fencing_epoch'").run(String(Number.MAX_SAFE_INTEGER - 1));
    expect(engine.coordDb.nextFencingToken()).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => engine.coordDb.nextFencingToken()).toThrow('exhausted');
    expect(engine.coordDb.currentFencingEpoch()).toBe(Number.MAX_SAFE_INTEGER);
  } finally { engine.close(); }
});


it.each([['agents', 'pid_start_time'], ['locks', 'expires_at']])('refuses missing ownership column %s.%s before migration', (table, column) => {
  const original = new KithEngine(root); original.close();
  const file = path.join(root, '.coord/state.db');
  const db = new DatabaseSync(file); db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`); db.close();
  const before = fs.readFileSync(file);
  expect(() => new KithEngine(root)).toThrow('Incomplete');
  expect(fs.readFileSync(file)).toEqual(before);
});

it.each([1, 2])('rolls back a schema-%s upgrade killed before commit without losing ownership or unfinished work', async legacyVersion => {
  const original = new KithEngine(root);
  const session = original.fencing.registerAgent({ id: 'legacy' });
  original.intents.addTask({ id: 'job', title: 'Interrupted upgrade', scopeGlobs: ['unfinished.txt'] });
  original.intents.claimNextTask('legacy');
  const coord = original.coordDb.coordDir; original.close();
  fs.writeFileSync(path.join(root, 'unfinished.txt'), 'unfinished source bytes');
  fs.writeFileSync(path.join(coord, 'quarantine/before-copy'), 'recovery bytes');
  const file = path.join(coord, 'state.db');
  let db = new DatabaseSync(file);
  db.exec(legacyVersion === 1
    ? "DROP TABLE mcp_operations; DROP TABLE agent_sessions; DROP TABLE mutex_waiters; DROP TABLE mutex_runs; UPDATE meta SET value='1' WHERE key='schema_version'"
    : "DROP TABLE mcp_operations; UPDATE meta SET value='2' WHERE key='schema_version'");
  const tables = ['meta', 'agents', 'tasks', 'locks', ...(legacyVersion === 2 ? ['agent_sessions', 'mutex_runs'] : [])];
  const dump = () => JSON.stringify(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all()));
  const before = dump(); db.close();
  // Instrument only the child fixture: pause at SQLite COMMIT, after all migration writes.
  // Small cache forces uncommitted pages into the WAL before SIGKILL. No production hook is needed.
  const script = `import {DatabaseSync} from 'node:sqlite'; import {pathToFileURL} from 'node:url';
    const exec=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(sql){
      if(sql==='BEGIN IMMEDIATE') exec.call(this,'PRAGMA cache_size=1');
      if(sql==='COMMIT'){process.send('before-commit');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
      return exec.call(this,sql);
    };
    const {KithEngine}=await import(pathToFileURL(process.argv[2]).href);new KithEngine(process.argv[1]);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, path.resolve('dist/index.js')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.once('exit', () => reject(new Error('Upgrade exited before the commit barrier')));
      timer = setTimeout(() => reject(new Error('Upgrade did not reach the commit barrier')), 10000);
    });
    expect(ready).toBe('before-commit');
    expect(fs.statSync(file + '-wal').size).toBeGreaterThan(0);
  } finally { clearTimeout(timer); child.kill('SIGKILL'); await exited; }
  db = new DatabaseSync(file);
  expect(dump()).toBe(before);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='mcp_operations'").all()).toEqual([]);
  db.close();
  const recovered = new KithEngine(root);
  try {
    if (legacyVersion === 1) {
      expect(() => recovered.fencing.resumeSession('legacy', session.sessionToken)).toThrow('capability');
      recovered.fencing.registerAgent({ id: 'new-owner' });
      expect(recovered.intents.claimNextTask('new-owner').task?.id).toBe('job');
    } else {
      expect(recovered.fencing.resumeSession('legacy', session.sessionToken)).toBe(session.sessionEpoch);
      expect(recovered.intents.getTask('job')).toMatchObject({ status: 'active', owner_agent_id: 'legacy' });
      expect(recovered.locks.listLocks()).toHaveLength(1);
    }
    expect(fs.readFileSync(path.join(root, 'unfinished.txt'), 'utf8')).toBe('unfinished source bytes');
    expect(fs.readFileSync(path.join(coord, 'quarantine/before-copy'), 'utf8')).toBe('recovery bytes');
  } finally { recovered.close(); }
});

it.each(['zero', 'empty'])('can retry an interrupted first initialization (%s) with no recovery data', mode => {
  const coord = path.join(root, '.coord'); fs.mkdirSync(path.join(coord, 'worktrees'), { recursive: true });
  const file = path.join(coord, 'state.db');
  if (mode === 'zero') fs.writeFileSync(file, '');
  else { const db = new DatabaseSync(file); db.exec('PRAGMA user_version=0'); db.close(); }
  fs.writeFileSync(path.join(root, 'source.txt'), 'existing project work');
  const engine = new KithEngine(root);
  try {
    expect(engine.coordDb.currentFencingEpoch()).toBe(1000);
    expect(engine.coordDb.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '3' });
    expect(fs.readFileSync(path.join(root, 'source.txt'), 'utf8')).toBe('existing project work');
  } finally { engine.close(); }
});


it('refuses a binary counter that numeric coercion would mistake for a valid value', () => {
  const engine = new KithEngine(root);
  engine.coordDb.db.prepare("UPDATE meta SET value=? WHERE key='fencing_epoch'").run(Buffer.from([49]));
  engine.close();
  const file = path.join(root, '.coord/state.db'); const before = fs.readFileSync(file);
  expect(() => new KithEngine(root)).toThrow('fencing');
  expect(fs.readFileSync(file)).toEqual(before);
});
