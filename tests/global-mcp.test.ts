import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KithEngine } from '../src/index.js';

const cli = path.resolve('dist/cli/index.js');
const clients: Client[] = [];
let temp: string;
beforeEach(() => { temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-global-'))); });
afterEach(async () => { await Promise.allSettled(clients.splice(0).map(c => c.close())); fs.rmSync(temp, { recursive: true, force: true }); });
function repo(parent: string) {
  const root = path.join(temp, parent, 'app'); fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n');
  fs.writeFileSync(path.join(root, 'src/base.mjs'), 'export const base = true;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  return root;
}
async function connect(cwd: string, pinned = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('KITH_'))) as Record<string, string>;
  env.HOME = temp; env.GIT_CONFIG_GLOBAL = path.join(temp, 'empty-gitconfig'); env.GIT_CONFIG_NOSYSTEM = '1';
  const c = new Client({ name: 'global-routing-fixture', version: '1' }); clients.push(c);
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', ...(pinned ? ['--repo', cwd] : [])], cwd, env, stderr: 'ignore' }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, JSON.stringify(r.content)).toBe(false); return r.structuredContent as any;
}

it('connects at filesystem root without a ledger and completes parallel tasks in two selected repositories', async () => {
  const roots = [repo('one'), repo('two')];
  const c = await connect(path.parse(temp).root);
  const tools = (await c.listTools()).tools;
  expect(tools).toHaveLength(14); expect(tools.every(t => t.inputSchema.properties?.repository)).toBe(true);
  expect((await c.callTool({ name: 'kith_get_status', arguments: {} })).isError).toBe(true);
  expect((await c.callTool({ name: 'kith_get_status', arguments: { repository: 'relative/path' } })).isError).toBe(true);
  expect((await c.callTool({ name: 'kith_get_status', arguments: { repository: path.parse(temp).root } })).isError).toBe(true);
  expect(fs.existsSync(path.join(temp, '.coord'))).toBe(false);
  const begun = await Promise.all(roots.map(repository => call(c, 'kith_begin_work', { repository, agentId: 'same-id', title: 'Implement change', scopeGlobs: ['src/change.mjs'], isolateWorktree: true })));
  expect(begun[0].sessionToken).not.toBe(begun[1].sessionToken);
  expect((await c.callTool({ name: 'kith_heartbeat', arguments: { repository: roots[0], agentId: 'same-id', sessionToken: begun[1].sessionToken } })).isError).toBe(true);
  for (const [index, repository] of roots.entries()) {
    const worktree = begun[index].worktree.worktreePath;
    fs.writeFileSync(path.join(worktree, 'src/change.mjs'), `export const project = ${index};\n`);
    await call(c, 'kith_heartbeat', { repository, agentId: 'same-id' });
    await call(c, 'kith_record_file_edit', { repository, agentId: 'same-id', filePath: 'src/change.mjs' });
    await call(c, 'kith_run_with_mutex', { repository, agentId: 'same-id', mutexName: 'check', command: [process.execPath, '--check', 'src/change.mjs'] });
    const result = await call(c, 'kith_complete_work', { repository, agentId: 'same-id', verificationCmd: `"${process.execPath}" --check src/change.mjs` });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(repository, 'src/change.mjs'), 'utf8')).toContain(`project = ${index}`);
  }
});

it('retains project defaults, refuses cross-project calls on pinned connections, and abandons all owned contexts on close', async () => {
  const a = repo('one'), b = repo('two');
  const pinned = await connect(a, true);
  expect((await pinned.callTool({ name: 'kith_get_status', arguments: { repository: b } })).isError).toBe(true);
  expect(fs.existsSync(path.join(b, '.coord'))).toBe(false);
  const global = await connect(a);
  await call(global, 'kith_begin_work', { agentId: 'default-owner', title: 'A', scopeGlobs: ['src/a.mjs'] });
  await call(global, 'kith_begin_work', { repository: b, agentId: 'other-owner', title: 'B', scopeGlobs: ['src/b.mjs'] });
  const alias = path.join(temp, 'alias'); fs.symlinkSync(a, alias, 'dir');
  await call(global, 'kith_heartbeat', { repository: alias, agentId: 'default-owner' });
  await global.close();
  for (const [root, id] of [[a, 'default-owner'], [b, 'other-owner']]) {
    const engine = new KithEngine(root);
    try { expect(engine.fencing.getAgent(id)?.status).toBe('dead'); expect(engine.locks.listLocks()).toEqual([]); }
    finally { engine.close(); }
  }
});
