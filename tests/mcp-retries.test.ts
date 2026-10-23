import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KithEngine } from '../src/core/engine.js';
import { OperationJournal, toolReply } from '../src/mcp/retries.js';
import { readCoordinationState } from '../src/core/observation.js';

const cli = path.resolve('dist/cli/index.js');
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('KITH_')));
const clients: Client[] = [];
let root: string, engine: KithEngine;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture did not reach its barrier'); await delay(25); }
}
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-retries-'))); engine = new KithEngine(root); });
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(c => c.close())); engine.close(); fs.rmSync(root, { recursive: true, force: true });
});
async function connect(script?: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: script
    ? ['--input-type=module', '-e', script, root, cli] : [cli, 'mcp', '--repo', root], cwd: root, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'retry-recovery-fixture', version: '1.0.0' }); clients.push(client);
  await client.connect(transport); return { client, transport };
}
function call(client: Client, name: string, args: Record<string, unknown>, timeout?: number) {
  return client.callTool({ name, arguments: args }, undefined, timeout === undefined ? undefined : { timeout });
}
function data(result: any): any {
  const value = result.structuredContent;
  expect(JSON.parse(result.content[0].text)).toEqual(value); return value;
}
function owner(id = 'owner') { const s = engine.fencing.registerAgent({ id }); return { agentId: id, sessionToken: s.sessionToken }; }
function pending(key: string) { return engine.coordDb.db.prepare('SELECT * FROM mcp_operations WHERE operation_key=?').get(key) as { result_json: string | null } | undefined; }

it('deduplicates begin, lock, edit, contract, port and task mutations without storing capabilities', async () => {
  const { client } = await connect();
  const args = { agentId: 'worker', operationKey: 'begin', title: 'One task', scopeGlobs: ['src/**'] };
  const first = data(await call(client, 'kith_begin_work', args));
  expect(first.ok).toBe(true);
  const repeated = data(await call(client, 'kith_begin_work', { ...args, scopeGlobs: [...args.scopeGlobs] }));
  expect(repeated.task.id).toBe(first.task.id); expect(repeated.sessionToken).toBe(first.sessionToken);
  expect(repeated.operation).toEqual({ key: 'begin', state: 'completed', replayed: true });
  expect(engine.intents.listTasks()).toHaveLength(1);
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const answer = 42;\n');
  const mutations: [string, Record<string, unknown>][] = [
    ['kith_check_and_lock_files', { patterns: ['src/a.ts'] }],
    ['kith_record_file_edit', { filePath: 'src/a.ts' }],
    ['kith_publish_contract', { filePath: 'src/a.ts', symbolName: 'answer', kind: 'const', signature: 'const answer: 42' }],
    ['kith_acquire_port', { serviceName: 'web', basePort: 25000 }],
    ['kith_add_task', { title: 'Queued once', scopeGlobs: ['docs/**'] }],
  ];
  for (const [name, input] of mutations) {
    const args = { agentId: 'worker', operationKey: name, ...input };
    const first = data(await call(client, name, args)); expect(first.operation.replayed).toBe(false); expect(first.ok).not.toBe(false);
    const replay = data(await call(client, name, args)); expect(replay).toEqual({ ...first, operation: { ...first.operation, replayed: true } });
  }
  const rows = engine.coordDb.db.prepare('SELECT result_json FROM mcp_operations').all();
  expect(JSON.stringify(rows)).not.toContain(first.sessionToken);
  expect(engine.intents.listTasks()).toHaveLength(2);
});

it('never treats a key as authorization, and rejects changed inputs or a new session generation', async () => {
  const one = await connect(), two = await connect();
  const args = { agentId: 'worker', operationKey: 'session', leaseDurationMs: 600000 };
  const session = data(await call(one.client, 'kith_start_session', args));
  expect(data(await call(two.client, 'kith_start_session', args)).failure).toMatchObject({ code: 'SESSION_OWNERSHIP', retryable: false });
  expect(data(await call(two.client, 'kith_start_session', { ...args, sessionToken: 'forged' })).failure.code).toBe('SESSION_OWNERSHIP');
  const altered = data(await call(one.client, 'kith_start_session', { ...args, leaseDurationMs: 900000 }));
  expect(altered.failure.code).toBe('OPERATION_KEY_REUSED');
  data(await call(one.client, 'kith_complete_work', { agentId: 'worker' }));
  const replacement = data(await call(two.client, 'kith_start_session', { agentId: 'worker' }));
  expect(replacement.sessionToken).not.toBe(session.sessionToken);
  expect(data(await call(two.client, 'kith_start_session', args)).failure.code).toBe('SESSION_OWNERSHIP');
  const historical = data(await call(two.client, 'kith_start_session', { ...args, sessionToken: session.sessionToken }));
  expect(historical.operation.replayed).toBe(true);
  expect(data(await call(two.client, 'kith_heartbeat', { agentId: 'worker', sessionToken: session.sessionToken })).failure.code).toBe('SESSION_OWNERSHIP');
  expect(engine.fencing.getAgent('worker')?.status).toBe('active');
  expect(data(await call(two.client, 'kith_heartbeat', { agentId: 'worker', sessionToken: replacement.sessionToken })).ok).toBe(true);
});
it('recovers a lost wire response after a real client timeout and server restart without adding the task twice', async () => {
  const session = owner(); const one = await connect();
  const receive = one.transport.onmessage!;
  one.transport.onmessage = message => {
    if ('result' in message && (message.result as any).structuredContent?.task?.title === 'Lost response') return;
    receive(message);
  };
  const args = { ...session, operationKey: 'lost-reply', title: 'Lost response' };
  await expect(call(one.client, 'kith_add_task', args, 500)).rejects.toThrow(/timed out/i);
  expect(engine.intents.listTasks()).toHaveLength(1); expect(pending('lost-reply')?.result_json).toBeTruthy();
  await one.client.close(); const two = await connect();
  const replay = data(await call(two.client, 'kith_add_task', args));
  expect(replay.operation.replayed).toBe(true); expect(replay.task.id).toBe(engine.intents.listTasks()[0].id);
  expect(engine.intents.listTasks()).toHaveLength(1);
});

it('classifies conflicts and wait timeouts, caches the refusal, and requires a new key for a new claim attempt', async () => {
  const session = owner(); const peer = owner('peer'); const { client } = await connect();
  engine.locks.acquireLocks({ agentId: peer.agentId, patterns: ['shared.txt'] });
  const args = { ...session, operationKey: 'claim', patterns: ['shared.txt', 'free.txt'], waitTimeoutMs: 100 };
  const timed = data(await call(client, 'kith_check_and_lock_files', args));
  expect(timed.failure).toMatchObject({ code: 'CLAIM_WAIT_TIMEOUT', retryable: true });
  expect(engine.locks.listLocks().filter(l => l.owner_agent_id === session.agentId)).toEqual([]);
  engine.locks.releaseLocks({ agentId: peer.agentId });
  expect(data(await call(client, 'kith_check_and_lock_files', args)).failure.code).toBe('CLAIM_WAIT_TIMEOUT');
  expect(data(await call(client, 'kith_check_and_lock_files', { ...args, operationKey: 'claim-again' })).ok).toBe(true);
  const invalid = data(await call(client, 'kith_run_with_mutex', { ...session, mutexName: 'test', cwd: '..', command: [process.execPath, '-v'] }));
  expect(invalid.failure).toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
});

it.skipIf(process.platform === 'win32')('does not duplicate a running command when the client times out, and preserves cancellation output', async () => {
  const session = owner(); const one = await connect(), two = await connect();
  const count = path.join(root, 'effects');
  const script = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(count)},'once\\n');console.log('partial output');setInterval(()=>{},1000);`;
  const args = { ...session, operationKey: 'running', mutexName: 'install', command: [process.execPath, '-e', script], commandTimeoutMs: 20000 };
  const waiting = call(one.client, 'kith_run_with_mutex', args, 5000); void waiting.catch(() => {});
  await until(() => fs.existsSync(count));
  const duplicate = data(await call(two.client, 'kith_run_with_mutex', args));
  expect(duplicate.failure).toMatchObject({ code: 'OPERATION_IN_PROGRESS', retryable: true });
  await expect(waiting).rejects.toThrow(/timed out/i);
  await until(() => pending('running')?.result_json != null);
  const replay = data(await call(two.client, 'kith_run_with_mutex', args));
  expect(replay.failure).toMatchObject({ code: 'CANCELLED', retryable: false });
  expect(replay.stdout).toContain('partial output'); expect(fs.readFileSync(count, 'utf8')).toBe('once\n');
  expect(engine.coordDb.db.prepare('SELECT * FROM mutex_runs').all()).toHaveLength(0);
});

it.skipIf(process.platform === 'win32')('records command execution deadlines as non-retryable partial outcomes and mutex wait deadlines as retryable', async () => {
  const session = owner(); const peer = owner('peer'); const { client } = await connect();
  engine.broker.tryAcquireMutex({ agentId: peer.agentId, mutexName: 'install' });
  const count = path.join(root, 'effects');
  const args = { ...session, operationKey: 'wait', mutexName: 'install', waitTimeoutMs: 100,
    command: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(count)},'once');console.log('started');setInterval(()=>{},1000);`], commandTimeoutMs: 1500 };
  const refused = data(await call(client, 'kith_run_with_mutex', args));
  expect(refused.failure).toMatchObject({ code: 'MUTEX_WAIT_TIMEOUT', retryable: true }); expect(fs.existsSync(count)).toBe(false);
  const lease = engine.broker.getResource('mutex', 'install')!;
  engine.broker.releaseMutex({ agentId: peer.agentId, mutexName: 'install', fencingToken: lease.fencing_token });
  const running = { ...args, operationKey: 'deadline' };
  const deadline = data(await call(client, 'kith_run_with_mutex', running));
  expect(deadline.failure).toMatchObject({ code: 'COMMAND_TIMEOUT', retryable: false }); expect(deadline.stdout).toContain('started');
  expect(data(await call(client, 'kith_run_with_mutex', running)).operation.replayed).toBe(true);
  expect(fs.readFileSync(count, 'utf8')).toBe('once');
});

it.skipIf(process.platform === 'win32')('never re-executes after the coordinator dies between an external effect and its result commit', async () => {
  const session = owner(); const barrier = path.join(root, '.coord/at-result'); const count = path.join(root, 'effects');
  const script = `import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {pathToFileURL} from 'node:url';
    const [root,cli]=process.argv.slice(1);const prepare=DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);
      if(sql.startsWith('UPDATE mcp_operations SET result_json=')){statement.run=function(){fs.writeFileSync(${JSON.stringify(barrier)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};}return statement;};
    process.argv=[process.execPath,cli,'mcp','--repo',root];await import(pathToFileURL(cli).href);`;
  const one = await connect(script);
  const args = { ...session, operationKey: 'crash', mutexName: 'install', command: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(count)},'once');`] };
  const waiting = call(one.client, 'kith_run_with_mutex', args); void waiting.catch(() => {});
  try { await until(() => fs.existsSync(barrier)); }
  finally { if (one.transport.pid) process.kill(one.transport.pid, 'SIGKILL'); }
  await expect(waiting).rejects.toThrow(); await one.client.close();
  expect(pending('crash')?.result_json).toBeNull();
  const two = await connect(); const result = data(await call(two.client, 'kith_run_with_mutex', args));
  expect(result.failure).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN', retryable: false });
  expect(result.operation.state).toBe('unknown'); expect(fs.readFileSync(count, 'utf8')).toBe('once');
});

it('replays completion after verification failure and success without another merge or ownership resurrection', async () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n'); fs.writeFileSync(path.join(root, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const session = owner(); const { client } = await connect();
  const begun = data(await call(client, 'kith_begin_work', { ...session, operationKey: 'begin', title: 'Feature', scopeGlobs: ['feature.txt'], isolateWorktree: true }));
  fs.writeFileSync(path.join(begun.worktree.worktreePath, 'feature.txt'), 'feature\n');
  const before = git('rev-parse', 'HEAD');
  const args = { ...session, operationKey: 'verify-fail', verificationCmd: 'node -e "console.error(\'repair fixture\');process.exit(2)"' };
  const failed = data(await call(client, 'kith_complete_work', args));
  expect(failed.failure).toMatchObject({ code: 'INTEGRATION_FAILED', retryable: false }); expect(failed.mergeResult.diagnostics).toContain('repair fixture');
  expect(git('rev-parse', 'HEAD')).toBe(before); expect(engine.locks.listLocks()).not.toHaveLength(0);
  expect(data(await call(client, 'kith_complete_work', args)).operation.replayed).toBe(true);
  const complete = { ...session, operationKey: 'verify-pass', verificationCmd: 'node -e "process.exit(0)"' };
  expect(data(await call(client, 'kith_complete_work', complete)).ok).toBe(true); const after = git('rev-parse', 'HEAD');
  const later = await connect(); const replay = data(await call(later.client, 'kith_complete_work', complete));
  expect(replay.ok).toBe(true); expect(replay.operation.replayed).toBe(true); expect(git('rev-parse', 'HEAD')).toBe(after);
  expect(engine.fencing.getAgent(session.agentId)?.status).toBe('completed'); expect(engine.locks.listLocks()).toHaveLength(0);
  expect(engine.mergeTrain.listQueue()).toHaveLength(2); expect(readCoordinationState(root).state).toBe('ready');
  expect(fs.readFileSync(path.join(root, 'feature.txt'), 'utf8')).toBe('feature\n');
});

it.each(['ABORT', 'IGNORE'])('never reruns when a result write is %s after an effect, even when the owner remains alive', async mode => {
  const session = engine.fencing.registerAgent({ id: 'storage-owner' });
  const journal = new OperationJournal(engine.coordDb); let effects = 0;
  const params = { key: 'write-failure', tool: 'fixture', input: {}, agentId: session.agent.id,
    token: () => session.sessionToken,
    authorize: () => ({ agentId: session.agent.id, sessionEpoch: engine.fencing.assertSession(session.agent.id), token: session.sessionToken }),
    run: async () => { effects++; return toolReply({ ok: true }); } };
  engine.coordDb.db.exec(`CREATE TRIGGER refuse_result BEFORE UPDATE ON mcp_operations BEGIN SELECT RAISE(${mode === 'ABORT' ? "ABORT,'result persistence failed'" : 'IGNORE'}); END`);
  expect(data(await journal.execute(params)).failure).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN', retryable: false });
  engine.coordDb.db.exec('DROP TRIGGER refuse_result');
  expect(data(await journal.execute(params)).failure).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN', retryable: false });
  expect(effects).toBe(1); expect(pending('write-failure')?.result_json).toBeNull();
});

it('can read an expired generation result without renewing it, and refuses damaged result history without re-execution', async () => {
  const session = owner(); const { client } = await connect();
  const args = { ...session, operationKey: 'expired-result', title: 'Keep once' };
  expect(data(await call(client, 'kith_add_task', args)).ok).toBe(true);
  engine.coordDb.db.prepare("UPDATE agents SET lease_expires_at=? WHERE id=?").run(Date.now() - 1, session.agentId);
  const before = engine.fencing.getAgent(session.agentId)!;
  expect(data(await call(client, 'kith_add_task', args)).operation.replayed).toBe(true);
  expect(engine.fencing.getAgent(session.agentId)).toEqual(before);
  expect(data(await call(client, 'kith_add_task', { ...args, operationKey: 'new-after-expiry' })).failure.code).toBe('SESSION_OWNERSHIP');
  engine.coordDb.db.prepare("UPDATE mcp_operations SET result_json='{' WHERE operation_key=?").run(args.operationKey);
  expect(data(await call(client, 'kith_add_task', args)).failure).toMatchObject({ code: 'STATE_UNAVAILABLE', retryable: false });
  expect(engine.intents.listTasks()).toHaveLength(1);
});

it('atomically reserves one mutation when independent MCP processes race on the same key', async () => {
  const session = owner(); const one = await connect(), two = await connect();
  const args = { ...session, operationKey: 'simultaneous', title: 'One queued task' };
  const results = await Promise.all([one, two].map(({ client }) => call(client, 'kith_add_task', args)));
  expect(engine.intents.listTasks()).toHaveLength(1);
  const id = engine.intents.listTasks()[0].id;
  for (let i = 0; i < results.length; i++) {
    let result = data(results[i]);
    if (result.failure) {
      expect(result.failure.code).toBe('OPERATION_IN_PROGRESS');
      result = data(await call([one, two][i].client, 'kith_add_task', args));
    }
    expect(result.task.id).toBe(id);
  }
  expect(engine.intents.listTasks()).toHaveLength(1);
});
