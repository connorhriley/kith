import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { KithEngine } from '../src/index.js';
import { HookHandler, type EnforcementMode } from '../src/cli/hook-handler.js';
import { initializeKithRepository } from '../src/cli/init.js';
const cli = path.resolve('dist/cli/index.js');
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
let root: string, engine: KithEngine;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kith enforcement ' "));
  fs.writeFileSync(path.join(root, 'protected.ts'), 'export const original = 1;\n');
  engine = new KithEngine(root);
  engine.fencing.registerAgent({ id: 'owner' }); engine.fencing.registerAgent({ id: 'worker' });
  engine.locks.acquireLocks({ agentId: 'owner', patterns: ['protected.ts'] });
});
afterEach(() => { engine.close(); fs.rmSync(root, { recursive: true, force: true }); });

it.each(['block','warn','off'] as EnforcementMode[])('%s only changes conflict policy, preserving ownership and path validation', mode => {
  const hook = new HookHandler(engine, mode);
  const result = hook.handlePreToolUse({ agentId: 'worker', toolName: 'Write', filePath: 'protected.ts' });
  expect(result.allowed).toBe(mode !== 'block');
  expect(Boolean(result.message)).toBe(mode !== 'off');
  expect(engine.locks.listLocks()).toHaveLength(1);
  expect(engine.locks.listLocks()[0].owner_agent_id).toBe('owner');
  expect(() => hook.handlePreToolUse({ agentId: 'worker', toolName: 'Write', filePath: path.join(root, '../outside.ts') })).toThrow('outside');
  const stranger = new KithEngine(root);
  try { expect(() => new HookHandler(stranger, mode).handlePreToolUse({ agentId: 'worker', toolName: 'Write', filePath: 'protected.ts' })).toThrow('session capability'); }
  finally { stranger.close(); }
});

it('preserves warn-mode file edits without publishing them as authorized peer work', () => {
  const hook = new HookHandler(engine, 'warn');
  expect(hook.handlePreToolUse({ agentId: 'worker', toolName: 'Edit', filePath: 'protected.ts' }).allowed).toBe(true);
  fs.writeFileSync(path.join(root, 'protected.ts'), 'changed by explicit warn mode');
  const post = hook.handlePostToolUse({ agentId: 'worker', toolName: 'Edit', filePath: 'protected.ts' });
  expect(post.allowed).toBe(true); expect(post.warnings.join()).toContain('not indexed');
  expect(fs.readFileSync(path.join(root, 'protected.ts'), 'utf8')).toBe('changed by explicit warn mode');
  expect(engine.depGraph.listContracts()).toEqual([]);
});

it('guards Git mutations in the same registered checkout and shared ref deletion across worktrees', () => {
  for (const command of ['git checkout -- protected.ts', 'git -C "some path" reset --hard', 'git --no-pager restore protected.ts', 'git branch -D peer', 'git worktree remove peer']) {
    expect(new HookHandler(engine).handlePreToolUse({ agentId: 'worker', toolName: 'Shell', command }).allowed, command).toBe(false);
  }
  engine.coordDb.db.prepare('UPDATE agents SET worktree_path=? WHERE id IN (?,?)').run(root, 'owner', 'worker');
  expect(engine.bashGuard.checkCommandSafety({ agentId: 'worker', command: 'git reset --hard', inIsolatedWorktree: true }).safe).toBe(false);
  expect(engine.bashGuard.checkCommandSafety({ agentId: 'worker', command: 'git status --short' }).safe).toBe(true);
});

it('generates Cursor permission JSON and switches modes without duplicate guards or lost user hooks', () => {
  const foreign = { command: 'my-audit', matcher: 'Read' };
  fs.mkdirSync(path.join(root, '.cursor'));
  fs.writeFileSync(path.join(root, '.cursor/hooks.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [foreign] } }));
  const binary = `${quote(process.execPath)} ${quote(cli)}`;
  const session = engine.fencing.sessionEnvironment('worker');
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(root, 'protected.ts') }, conversation_id: 'cursor-session' });
  for (const mode of ['block','warn','off','block'] as EnforcementMode[]) {
    initializeKithRepository(root, binary, { integrations: ['cursor'], enforcement: mode });
    const config = JSON.parse(fs.readFileSync(path.join(root, '.cursor/hooks.json'), 'utf8'));
    expect(config.hooks.preToolUse).toHaveLength(2); expect(config.hooks.preToolUse[0]).toEqual(foreign);
    const guard = config.hooks.preToolUse[1]; expect(guard.failClosed).toBe(true);
    const run = (token: string | undefined) => spawnSync('sh', ['-c', guard.command], { cwd: root, env: { ...session, KITH_SESSION_TOKEN: token }, input: payload, encoding: 'utf8' });
    const result = run(session.KITH_SESSION_TOKEN);
    expect(result.status, result.stderr).toBe(mode === 'block' ? 2 : 0);
    expect(JSON.parse(result.stdout).permission).toBe(mode === 'block' ? 'deny' : 'allow');
    expect(run(undefined).status).toBe(2); expect(run('forged').status).toBe(2);
  }
});
