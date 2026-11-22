import { execFileSync, spawnSync } from 'node:child_process';
import { runHook } from '../plugins/kith/hooks/run.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bindMcpSessionToAutoPresence, listRepoPresence } from '../src/cli/auto-session.js';
import { doctorReport } from '../src/cli/doctor.js';
import { formatStatusHuman } from '../src/cli/format.js';
import { gcCoordination, KithEngine, parseWorktreePorcelain, physicalPath } from '../src/index.js';

const cli = path.resolve('dist/cli/index.js');
const cleanups: string[] = [];
let root = '';
let engine: KithEngine | undefined;
const clients: Client[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function seed() {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kith adopt ' ")));
  cleanups.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.test');
  git(root, 'config', 'user.name', 'Adopt');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/base.mjs'), 'export const base = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'seed');
  engine = new KithEngine(root);
}
function outside(name: string) {
  const dir = path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}`);
  cleanups.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined)));
  engine?.close();
  engine = undefined;
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('parses porcelain for detached, locked and branched worktrees', () => {
  const listed = parseWorktreePorcelain([
    'worktree /repo',
    'HEAD aaa',
    'branch refs/heads/main',
    '',
    'worktree /repo/.claude/worktrees/feature auth',
    'HEAD bbb',
    'detached',
    'locked claude code session',
    '',
    'worktree /elsewhere',
    'HEAD ccc',
    'branch refs/heads/feature',
  ].join('\n'));
  expect(listed.map(entry => entry.branch)).toEqual([ 'main', null, 'feature' ]);
  expect(listed[1]).toMatchObject({ detached: true, locked: true, lockReason: 'claude code session', path: '/repo/.claude/worktrees/feature auth' });
});

it('adopts a Claude Code worktree without changing a dirty tree, and reuses it for a claim', () => {
  seed();
  const claude = path.join(root, '.claude', 'worktrees', 'feature-auth');
  git(root, 'worktree', 'add', '-b', 'worktree-feature-auth', claude, 'HEAD');
  const edited = 'export const base = 2;\n';
  fs.writeFileSync(path.join(claude, 'src/base.mjs'), edited);
  engine!.fencing.registerAgent({ id: 'claude', client: 'claude-code' });
  const adopted = engine!.worktrees.adoptWorktree({ agentId: 'claude', path: claude, explicit: true });
  expect(adopted).toMatchObject({
    provenance: 'adopted', source: 'claude-code', dirty: true, detached: false,
    branch: 'worktree-feature-auth', branchCheckedOutElsewhere: false, alreadyRegistered: false,
  });
  expect(adopted.worktreePath).toBe(physicalPath(claude));
  expect(fs.readFileSync(path.join(claude, 'src/base.mjs'), 'utf8')).toBe(edited);
  expect(engine!.worktrees.adoptWorktree({ agentId: 'claude', path: path.join(claude, 'src'), explicit: true }).alreadyRegistered).toBe(true);
  const begun = engine!.beginWork({ agentId: 'claude', title: 'edit base', scopeGlobs: ['src/base.mjs'], isolateWorktree: true });
  expect(begun.ok).toBe(true);
  expect(begun.worktree?.worktreePath).toBe(physicalPath(claude));
  expect(fs.existsSync(path.join(root, '.coord', 'worktrees', 'claude'))).toBe(false);
  expect(fs.readFileSync(path.join(claude, 'src/base.mjs'), 'utf8')).toBe(edited);
  const human = formatStatusHuman(engine!.getStatus() as Record<string, any>);
  expect(human).toContain('adopted claude-code feature-auth');
  const doctor = doctorReport(root, root);
  const summary = doctor.checks.find(check => check.name === 'adopted-worktrees');
  expect(summary?.detail).toContain('claude-code');
  expect(summary?.detail).toContain('dirty when adopted');
  expect(doctor.checks.find(check => check.name === 'workspace:claude')?.detail).toContain('Adopted claude-code worktree');
});

it('adopts any other linked worktree, refuses the primary checkout, and refuses a second owner', () => {
  seed();
  const external = outside('kith-ext');
  git(root, 'worktree', 'add', '-b', 'feature-ext', external, 'HEAD');
  engine!.fencing.registerAgent({ id: 'one', client: 'orca' });
  engine!.fencing.registerAgent({ id: 'two', client: 'orca' });
  const adopted = engine!.worktrees.adoptWorktree({ agentId: 'one', path: external, explicit: true });
  expect(adopted.source).toBe('external');
  expect(adopted.provenance).toBe('adopted');
  expect(() => engine!.worktrees.adoptWorktree({ agentId: 'one', path: root, explicit: true })).toThrow(/primary checkout/);
  expect(() => engine!.worktrees.adoptWorktree({ agentId: 'two', path: external, explicit: true })).toThrow(/already registered to active agent 'one'/);
  const marked = outside('kith-marked');
  git(root, 'worktree', 'add', '-b', 'feature-marked', marked, 'HEAD');
  git(root, 'worktree', 'lock', marked, '--reason', 'claude code session');
  engine!.fencing.registerAgent({ id: 'marked', client: 'claude-code' });
  expect(engine!.worktrees.adoptWorktree({ agentId: 'marked', path: marked, explicit: true }).source).toBe('claude-code');
});

it('keeps a detached HEAD committable and refuses integration until a branch exists', () => {
  seed();
  const detached = path.join(root, '.claude', 'worktrees', 'detached-fix');
  git(root, 'worktree', 'add', '--detach', detached, 'HEAD');
  fs.writeFileSync(path.join(detached, 'src/detached.mjs'), 'export const detached = true;\n');
  engine!.fencing.registerAgent({ id: 'detached', client: 'claude-code' });
  const adopted = engine!.worktrees.adoptWorktree({ agentId: 'detached', path: detached, explicit: true });
  expect(adopted.detached).toBe(true);
  expect(adopted.branch).toBeNull();
  const main = git(root, 'rev-parse', 'HEAD');
  const committed = engine!.commit({ agentId: 'detached', message: 'detached note', files: ['src/detached.mjs'] });
  expect(committed.ok, committed.error).toBe(true);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(main);
  expect(git(detached, 'rev-parse', 'HEAD')).toBe(committed.commit);
  const completed = engine!.completeWork({ agentId: 'detached', verificationCmd: 'node --check src/detached.mjs' });
  expect(completed.ok).toBe(false);
  expect(completed.error).toMatch(/detached/);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(main);
  expect(fs.readFileSync(path.join(detached, 'src/detached.mjs'), 'utf8')).toBe('export const detached = true;\n');
  expect(fs.existsSync(detached)).toBe(true);
});

it('refuses commit and integration when the branch is checked out in another worktree', () => {
  seed();
  const shared = path.join(root, '.claude', 'worktrees', 'shared');
  const elsewhere = outside('kith-elsewhere');
  git(root, 'worktree', 'add', '-b', 'feature-shared', shared, 'HEAD');
  git(root, 'worktree', 'add', '--detach', elsewhere, 'HEAD');
  const gitdir = fs.readFileSync(path.join(elsewhere, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim();
  const admin = path.isAbsolute(gitdir) ? gitdir : path.resolve(elsewhere, gitdir);
  fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/feature-shared\n');
  fs.writeFileSync(path.join(elsewhere, 'src/shared.mjs'), 'export const shared = true;\n');
  engine!.fencing.registerAgent({ id: 'shared', client: 'external' });
  const adopted = engine!.worktrees.adoptWorktree({ agentId: 'shared', path: elsewhere, explicit: true });
  expect(adopted.branch).toBe('feature-shared');
  expect(adopted.branchCheckedOutElsewhere).toBe(true);
  const committed = engine!.commit({ agentId: 'shared', message: 'nope', files: ['src/shared.mjs'] });
  expect(committed.ok).toBe(false);
  expect(committed.error).toMatch(/checked out in another worktree/);
  const main = git(root, 'rev-parse', 'HEAD');
  const completed = engine!.completeWork({ agentId: 'shared', verificationCmd: 'node --check src/shared.mjs' });
  expect(completed.ok).toBe(false);
  expect(completed.error).toMatch(/checked out in another worktree/);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(main);
  expect(fs.readFileSync(path.join(elsewhere, 'src/shared.mjs'), 'utf8')).toBe('export const shared = true;\n');
});

it('integrates an adopted branch only through the existing verification gate and never garbage-collects it', () => {
  seed();
  const claude = path.join(root, '.claude', 'worktrees', 'feature-auth');
  git(root, 'worktree', 'add', '-b', 'worktree-feature-auth', claude, 'HEAD');
  fs.writeFileSync(path.join(claude, 'src/adopted.mjs'), 'export const adopted = true;\n');
  engine!.fencing.registerAgent({ id: 'claude', client: 'claude-code' });
  engine!.worktrees.adoptWorktree({ agentId: 'claude', path: claude, explicit: true });
  engine!.beginWork({ agentId: 'claude', title: 'ship', scopeGlobs: ['src/adopted.mjs'] });
  const main = git(root, 'rev-parse', 'HEAD');
  const failed = engine!.completeWork({ agentId: 'claude', verificationCmd: 'node -e "process.exit(17)"' });
  expect(failed.ok).toBe(false);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(main);
  expect(fs.existsSync(claude)).toBe(true);
  const passed = engine!.completeWork({ agentId: 'claude', verificationCmd: 'node --check src/adopted.mjs' });
  expect(passed.ok, JSON.stringify(passed)).toBe(true);
  expect(fs.readFileSync(path.join(root, 'src/adopted.mjs'), 'utf8')).toBe('export const adopted = true;\n');
  engine!.close(); engine = undefined;
  const report = gcCoordination(root);
  expect(report.removedWorktrees.some(item => item.includes('feature-auth'))).toBe(false);
  expect(fs.existsSync(path.join(claude, 'src/adopted.mjs'))).toBe(true);
  expect(git(root, 'worktree', 'list')).toContain('feature-auth');
});

it('does not delete an adopted worktree unless removal is explicit, and main mode does not integrate it', () => {
  seed();
  const external = outside('kith-keep');
  git(root, 'worktree', 'add', '-b', 'feature-keep', external, 'HEAD');
  engine!.fencing.registerAgent({ id: 'keeper', client: 'squad' });
  engine!.worktrees.adoptWorktree({ agentId: 'keeper', path: external, explicit: true });
  expect(() => engine!.worktrees.removeWorktree('keeper')).toThrow(/did not create/);
  expect(fs.existsSync(external)).toBe(true);
  expect(engine!.worktrees.forgetWorktree('keeper')).toBe(true);
  expect(fs.existsSync(external)).toBe(true);
  expect(engine!.fencing.getAgent('keeper')?.worktree_path).toBeNull();
  engine!.worktrees.adoptWorktree({ agentId: 'keeper', path: external, explicit: true });
  expect(engine!.worktrees.removeWorktree('keeper', { deleteAdopted: true })).toBe(true);
  expect(fs.existsSync(external)).toBe(false);

  const mainWt = path.join(root, '.claude', 'worktrees', 'main-mode');
  git(root, 'worktree', 'add', '-b', 'worktree-main-mode', mainWt, 'HEAD');
  fs.writeFileSync(path.join(mainWt, 'src/main-mode.mjs'), 'export const mode = 1;\n');
  engine!.setWorkflowMode('main');
  engine!.fencing.registerAgent({ id: 'main', client: 'claude-code' });
  const begun = engine!.beginWork({
    agentId: 'main', title: 'stay', scopeGlobs: ['src/main-mode.mjs'], adoptWorktree: true, worktreePath: mainWt,
  });
  expect(begun.notes.join('\n')).toMatch(/does not integrate/);
  expect(begun.worktree?.worktreePath).toBe(physicalPath(mainWt));
  const head = git(root, 'rev-parse', 'HEAD');
  const completed = engine!.completeWork({ agentId: 'main', verificationCmd: 'node --check src/main-mode.mjs' });
  expect(completed.ok, JSON.stringify(completed)).toBe(true);
  expect(completed.mergeResult).toBeNull();
  expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  expect(fs.existsSync(mainWt)).toBe(true);
});

it('adopts from a hook cwd and from CLI/MCP without creating a second worktree', async () => {
  seed();
  const claude = path.join(root, '.claude', 'worktrees', 'feature-auth');
  git(root, 'worktree', 'add', '-b', 'worktree-feature-auth', claude, 'HEAD');
  fs.writeFileSync(path.join(claude, 'src/hook.mjs'), 'export const hook = 1;\n');
  const session = engine!.fencing.registerAgent({ id: 'claude-1', client: 'claude-code' });
  engine!.close(); engine = undefined;
  const env = { ...process.env, KITH_AGENT_ID: 'claude-1', KITH_SESSION_TOKEN: session.sessionToken };
  const ignored = spawnSync(process.execPath, [cli, 'hook', 'pre', '--repo', root, '--agent', 'claude-1', '--session-token', session.sessionToken, '--tool', 'Read'], {
    cwd: root, encoding: 'utf8', input: JSON.stringify({ cwd: root, tool_name: 'Read', tool_input: {} }),
  });
  expect(ignored.status, ignored.stderr).toBe(0);
  engine = new KithEngine(root);
  expect(engine.fencing.getAgent('claude-1')?.worktree_path).toBeNull();
  engine.close(); engine = undefined;
  const hooked = spawnSync(process.execPath, [cli, 'hook', 'pre', '--repo', root, '--agent', 'claude-1', '--session-token', session.sessionToken, '--tool', 'Read'], {
    cwd: root, encoding: 'utf8', input: JSON.stringify({ cwd: claude, tool_name: 'Read', tool_input: {} }),
  });
  expect(hooked.status, hooked.stderr).toBe(0);
  expect(hooked.stdout).toContain('Adopted the existing claude-code worktree');
  engine = new KithEngine(root);
  expect(physicalPath(engine.fencing.getAgent('claude-1')!.worktree_path!)).toBe(physicalPath(claude));
  expect(engine.worktrees.registrationFor('claude-1')?.source).toBe('claude-code');
  engine.close(); engine = undefined;

  const repeat = spawnSync(process.execPath, [cli, 'hook', 'pre', '--repo', root, '--agent', 'claude-1', '--session-token', session.sessionToken, '--tool', 'Read'], {
    cwd: root, encoding: 'utf8', input: JSON.stringify({ cwd: claude, tool_name: 'Read', tool_input: {} }),
  });
  expect(repeat.stdout).not.toContain('Adopted the existing');
  engine = new KithEngine(root);
  engine.fencing.resumeSession('claude-1', session.sessionToken);
  engine.fencing.abandonAgentSession('claude-1');
  engine.close(); engine = undefined;

  const started = spawnSync(process.execPath, [cli, 'session', 'start', '--agent', 'cli-agent'], { cwd: claude, encoding: 'utf8', env });
  expect(started.status, started.stderr).toBe(0);
  const cliSession = JSON.parse(started.stdout) as { sessionToken: string };
  const adopted = spawnSync(process.execPath, [cli, 'adopt'], {
    cwd: claude, encoding: 'utf8', env: { ...env, KITH_AGENT_ID: 'cli-agent', KITH_SESSION_TOKEN: cliSession.sessionToken },
  });
  expect(adopted.status, adopted.stderr).toBe(0);
  const body = JSON.parse(adopted.stdout);
  expect(body.worktree.source).toBe('claude-code');
  expect(physicalPath(body.worktree.worktreePath)).toBe(physicalPath(claude));
  const committed = spawnSync(process.execPath, [cli, '--repo', root, 'commit', '-m', 'from cli', 'src/hook.mjs'], {
    cwd: claude, encoding: 'utf8', env: { ...env, KITH_AGENT_ID: 'cli-agent', KITH_SESSION_TOKEN: cliSession.sessionToken },
  });
  expect(committed.status, committed.stderr).toBe(0);
  expect(JSON.parse(committed.stdout).ok).toBe(true);
  const completed = spawnSync(process.execPath, [cli, '--repo', root, 'complete', '--agent', 'cli-agent', '--verify', 'node --check src/hook.mjs'], {
    cwd: root, encoding: 'utf8', env: { ...env, KITH_AGENT_ID: 'cli-agent', KITH_SESSION_TOKEN: cliSession.sessionToken },
  });
  expect(completed.status, `${completed.stdout}\n${completed.stderr}`).toBe(0);
  expect(fs.readFileSync(path.join(root, 'src/hook.mjs'), 'utf8')).toBe('export const hook = 1;\n');
  expect(fs.existsSync(claude)).toBe(true);

  const transport = new StdioClientTransport({
    command: process.execPath, args: [cli, 'mcp', '--repo', root], cwd: root,
    env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('KITH_'))) as Record<string, string>,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => undefined);
  const client = new Client({ name: 'adopt', version: '1.0.0' });
  clients.push(client);
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  expect(names).toContain('kith_adopt_worktree');
  const other = path.join(root, '.claude', 'worktrees', 'mcp-feature');
  git(root, 'worktree', 'add', '-b', 'worktree-mcp-feature', other, 'HEAD');
  fs.writeFileSync(path.join(other, 'src/mcp.mjs'), 'export const mcp = 1;\n');
  const call = await client.callTool({ name: 'kith_adopt_worktree', arguments: { agentId: 'mcp-agent', worktreePath: other } });
  expect(call.isError, JSON.stringify(call)).not.toBe(true);
  const data = call.structuredContent as { worktree: { source: string; provenance: string; worktreePath: string } };
  expect(data.worktree).toMatchObject({ source: 'claude-code', provenance: 'adopted' });
  const begun = await client.callTool({
    name: 'kith_begin_work',
    arguments: { agentId: 'mcp-agent', title: 'mcp', scopeGlobs: ['src/mcp.mjs'], adoptWorktree: true, worktreePath: other },
  });
  expect(begun.isError, JSON.stringify(begun)).not.toBe(true);
  const begunData = begun.structuredContent as { worktree: { worktreePath: string } };
  expect(physicalPath(begunData.worktree.worktreePath)).toBe(physicalPath(other));
  expect(fs.existsSync(path.join(root, '.coord', 'worktrees', 'mcp-agent'))).toBe(false);
});

it('adopts when the Claude Code plugin runner forwards the hook cwd', async () => {
  seed();
  const claude = path.join(root, '.claude', 'worktrees', 'feature-auth');
  git(root, 'worktree', 'add', '-b', 'worktree-feature-auth', claude, 'HEAD');
  engine!.close(); engine = undefined;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-plugin-run-')));
  cleanups.push(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, KITH_HOME: home };
  delete env.KITH_AGENT_ID;
  delete env.KITH_SESSION_TOKEN;
  const stdin = Buffer.from(JSON.stringify({
    session_id: 'plugin-run',
    cwd: claude,
    tool_name: 'Read',
    tool_input: {},
  }));
  const result = await runHook({
    phase: 'pre',
    env,
    stdin,
    spawnImpl: (args, input) => new Promise((resolve) => {
      const child = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, input, encoding: 'utf8' });
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
      expect(child.stdout).toContain('Adopted the existing claude-code worktree');
      resolve({ code: child.status ?? 1, deferred: false });
    }),
  });
  expect(result).toEqual({ code: 0, deferred: false });
  engine = new KithEngine(root);
  const auto = engine.fencing.listAgents(true).find(agent => agent.id.startsWith('auto-'));
  expect(auto?.worktree_path && physicalPath(auto.worktree_path)).toBe(physicalPath(claude));
  expect(engine.worktrees.registrationFor(auto!.id)?.source).toBe('claude-code');
});

it('adopts from the Claude Code plugin hook command and keeps that workspace when MCP binds the session', () => {
  seed();
  const claude = path.join(root, '.claude', 'worktrees', 'feature-auth');
  git(root, 'worktree', 'add', '-b', 'worktree-feature-auth', claude, 'HEAD');
  fs.writeFileSync(path.join(claude, 'src/plugin.mjs'), 'export const plugin = 1;\n');
  const common = engine!.coordDb.commonGitDir!;
  engine!.close(); engine = undefined;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-plugin-home-')));
  cleanups.push(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, KITH_HOME: home };
  delete env.KITH_AGENT_ID;
  delete env.KITH_SESSION_TOKEN;
  const hooked = spawnSync(process.execPath, [cli, 'hook', 'pre', '--client', 'claude', '--auto'], {
    cwd: root,
    encoding: 'utf8',
    env,
    input: JSON.stringify({
      session_id: 'plugin-session',
      cwd: claude,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(claude, 'src/plugin.mjs') },
    }),
  });
  expect(hooked.status, `${hooked.stdout}\n${hooked.stderr}`).toBe(0);
  expect(hooked.stdout).toContain('Adopted the existing claude-code worktree');
  engine = new KithEngine(root);
  const auto = engine.fencing.listAgents(true).find(agent => agent.id.startsWith('auto-'));
  expect(auto?.worktree_path && physicalPath(auto.worktree_path)).toBe(physicalPath(claude));
  expect(engine.worktrees.registrationFor(auto!.id)?.source).toBe('claude-code');
  const peers = listRepoPresence(home, common);
  expect(peers.map(peer => peer.pid)).toContain(process.pid);
  const mcp = engine.fencing.registerAgent({ id: 'mcp-agent', client: 'mcp', pid: process.pid });
  bindMcpSessionToAutoPresence(home, engine, {
    repoCommonDir: common, mcpPid: process.pid, agentId: 'mcp-agent', sessionToken: mcp.sessionToken,
  });
  expect(physicalPath(engine.fencing.getAgent('mcp-agent')!.worktree_path!)).toBe(physicalPath(claude));
  expect(engine.worktrees.registrationFor('mcp-agent')?.provenance).toBe('adopted');
  expect(engine.fencing.getAgent(auto!.id)?.status).not.toBe('active');
  expect(engine.fencing.getAgent(auto!.id)?.worktree_path ?? null).toBeNull();
  const head = git(root, 'rev-parse', 'HEAD');
  engine.beginWork({ agentId: 'mcp-agent', title: 'plugin file', scopeGlobs: ['src/plugin.mjs'] });
  const committed = engine.commit({ agentId: 'mcp-agent', sessionToken: mcp.sessionToken, message: 'plugin edit', files: ['src/plugin.mjs'] });
  expect(committed.ok, committed.error).toBe(true);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  const done = engine.completeWork({ agentId: 'mcp-agent', verificationCmd: 'node --check src/plugin.mjs' });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  expect(fs.readFileSync(path.join(root, 'src/plugin.mjs'), 'utf8')).toBe('export const plugin = 1;\n');
  expect(fs.existsSync(claude)).toBe(true);
});
