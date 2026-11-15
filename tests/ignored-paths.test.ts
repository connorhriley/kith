import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindMcpSessionToAutoPresence, clearAutoSession, recordPresence } from '../src/cli/auto-session.js';
import { ignoredPaths } from '../src/core/git-ignore.js';
import { KithEngine } from '../src/index.js';

const LOG = 'scripts/stack/.state/logs/web.log';
const NEXT_JS = 'apps/web/.next-v2/dev/server.js';
const cli = path.resolve('dist/cli/index.js');

describe('Git-ignored paths are not shared source', () => {
  let dir: string;
  let engine: KithEngine;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-ignored-'));
    git('init');
    git('config', 'user.email', 't@kith.dev');
    git('config', 'user.name', 'T');
    fs.mkdirSync(path.join(dir, 'scripts/stack/.state/logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'));
    // The ignore rule lives in a nested .gitignore, as in the reported repository.
    fs.writeFileSync(path.join(dir, 'scripts/stack/.gitignore'), '.state/\n');
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-m', 'init');
    engine = new KithEngine(dir);
  });
  afterEach(() => { engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('reports ignored paths from the ignore rules of the repository they belong to', () => {
    const nested = path.join(dir, 'vendor/inner');
    fs.mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init'], { cwd: nested, stdio: 'ignore' });
    fs.writeFileSync(path.join(nested, '.gitignore'), 'out.log\n');
    expect(ignoredPaths(dir, [LOG, 'src/a.ts', 'vendor/inner/out.log', 'vendor/inner/keep.ts']))
      .toEqual(new Set([LOG, 'vendor/inner/out.log']));
  });

  it('never records a conflict on an ignored file, but still on source', () => {
    engine.fencing.registerAgent({ id: 'a1' });
    engine.fencing.registerAgent({ id: 'a2' });
    for (const [id, text] of [['a1', 'one\n'], ['a2', 'two\n']]) {
      fs.writeFileSync(path.join(dir, LOG), text);
      engine.processPostFileEdit({ agentId: id, filePath: LOG, content: text });
    }
    expect(engine.shadowGit.listConflicts()).toEqual([]);

    engine.processPostFileEdit({ agentId: 'a1', filePath: 'src/b.ts', content: 'export const b = 1;\n' });
    const res = engine.processPostFileEdit({ agentId: 'a2', filePath: 'src/b.ts', content: 'export const b = 2;\n' });
    expect(JSON.stringify(res)).toContain('src/b.ts');
    expect(engine.shadowGit.listConflicts().map(c => c.file_path)).toEqual(['src/b.ts']);
  });

  it('lets two agents write an ignored file and holds no lock on it', () => {
    engine.fencing.registerAgent({ id: 'a1' });
    engine.fencing.registerAgent({ id: 'a2' });
    const got = engine.locks.acquireLocks({ agentId: 'a1', patterns: [LOG, 'src/a.ts'], lockType: 'file' });
    expect(got.ok).toBe(true);
    expect(got.locks.map(l => l.pattern)).toEqual(['src/a.ts']);
    expect(engine.locks.checkFileWriteAccess({ agentId: 'a2', filePath: LOG }).allowed).toBe(true);
    expect(engine.locks.checkFileWriteAccess({ agentId: 'a2', filePath: 'src/a.ts' }).allowed).toBe(false);
    expect(engine.locks.acquireLocks({ agentId: 'a2', patterns: [LOG], lockType: 'file' }).ok).toBe(true);
  });

  it('clears conflicts and locks already recorded on ignored paths at the next reap', () => {
    engine.fencing.registerAgent({ id: 'a1' });
    engine.fencing.registerAgent({ id: 'a2' });
    const insert = (file: string) => engine.coordDb.db.prepare(
      `INSERT INTO conflicts (id, agent_a, agent_b, file_path, severity, details_json, detected_at) VALUES (?, 'a1', 'a2', ?, 'text_conflict', '{}', ?)`
    ).run(`c-${file}`, file, Date.now());
    insert(LOG);
    insert('src/a.ts');
    engine.coordDb.db.prepare(
      `INSERT INTO locks (id, pattern, lock_type, mode, owner_agent_id, fencing_token, reason, acquired_at, expires_at) VALUES ('l1', ?, 'file', 'exclusive', 'a1', 1, '', ?, ?)`
    ).run(LOG, Date.now(), Date.now() + 60_000);

    const fresh = new KithEngine(dir);
    try {
      expect(fresh.shadowGit.listConflicts().map(c => c.file_path)).toEqual(['src/a.ts']);
      expect(fresh.coordDb.db.prepare('SELECT id FROM locks').all()).toEqual([]);
    } finally { fresh.close(); }
  });

  it('skips ignored dev logs and build artifacts in BashMerkleGuard snapshots, quarantine, and AST contracts', () => {
    fs.mkdirSync(path.join(dir, 'apps/web/.next-v2/dev'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'apps/web/.gitignore'), '.next-v2/\n');
    engine.fencing.registerAgent({ id: 'a1' });
    engine.fencing.registerAgent({ id: 'a2' });
    engine.locks.acquireLocks({ agentId: 'a1', patterns: ['apps/**'], lockType: 'glob' });

    engine.bashGuard.capturePreBashSnapshot('a2', dir);
    fs.writeFileSync(path.join(dir, LOG), 'dev server line\n');
    fs.writeFileSync(path.join(dir, NEXT_JS), 'export function generatedChunk() { return 1; }\n');

    const report = engine.bashGuard.verifyPostBashAndQuarantine({
      agentId: 'a2',
      command: 'echo ok',
      rootDir: dir,
    });
    expect(report.allowed).toBe(true);
    expect(report.quarantinedViolations).toEqual([]);
    expect(report.authorizedModifiedFiles).toEqual([]);
    expect(engine.depGraph.listContracts()).toEqual([]);
    expect(engine.shadowGit.listConflicts()).toEqual([]);
  });

  it('recovers descendant wrapper hooks automatically, never blocks echo ok on capability conflict, and clears via CLI', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-home-auto-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, KITH_HOME: home };
    delete (env as Record<string, string | undefined>).KITH_AGENT_ID;
    delete (env as Record<string, string | undefined>).KITH_SESSION_TOKEN;
    delete (env as Record<string, string | undefined>).KITH_REQUIRE_SESSION;

    // Seed an active auto-session owned by this Vitest process PID without saving its capability in presence.db,
    // so a child hook spawned from this process tree exercises ancestor recovery cleanly.
    const sameTreeKey = 'claude:same-tree-sess';
    const crypto = await import('node:crypto');
    const sameTreeAgent = `auto-claude-${crypto.createHash('sha1').update(sameTreeKey).digest('hex').slice(0, 8)}`;
    engine.fencing.registerAgent({ id: sameTreeAgent, client: 'claude', pid: process.pid });
    const recoveredPre = spawnSync(process.execPath, [cli, 'hook', 'pre', '--client', 'claude', '--auto'], {
      cwd: dir,
      env,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'same-tree-sess', cwd: dir, tool_name: 'Bash', tool_input: { command: 'echo ok' } }),
    });
    expect(recoveredPre.status, recoveredPre.stderr).toBe(0);

    // Hold another auto-session with an unrelated live sibling process PID to trigger AutoSessionConflictError.
    const sibling = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' });
    try {
      const conflictKey = 'claude:foreign-live-sess';
      const conflictAgent = `auto-claude-${crypto.createHash('sha1').update(conflictKey).digest('hex').slice(0, 8)}`;
      engine.fencing.registerAgent({ id: conflictAgent, client: 'claude', pid: sibling.pid! });
      engine.fencing.registerAgent({ id: 'locker' });
      engine.locks.acquireLocks({ agentId: 'locker', patterns: ['src/a.ts'], lockType: 'file' });

      // Invoke hooks from a separate sibling wrapper process (S2) so callerPid is S2, not Vitest.
      const runFromSibling = (inputObj: unknown) => spawnSync(
        process.execPath,
        [
          '-e',
          `const { spawnSync } = require('node:child_process');
           const r = spawnSync(process.execPath, [${JSON.stringify(cli)}, 'hook', 'pre', '--client', 'claude', '--auto'], {
             cwd: ${JSON.stringify(dir)}, encoding: 'utf8', input: process.env.HOOK_INPUT
           });
           process.stdout.write(r.stdout || '');
           process.stderr.write(r.stderr || '');
           process.exit(r.status ?? 1);`,
        ],
        { cwd: dir, env: { ...env, HOOK_INPUT: JSON.stringify(inputObj) }, encoding: 'utf8' }
      );

      // Benign Bash (`echo ok`) is never bricked; it returns exit 0 with recovery guidance.
      const bashPre = runFromSibling({ session_id: 'foreign-live-sess', cwd: dir, tool_name: 'Bash', tool_input: { command: 'echo ok' } });
      expect(bashPre.status, bashPre.stderr).toBe(0);
      expect(bashPre.stdout).toContain('kith session clear claude:foreign-live-sess');

      // Conflicting Edit on another agent's locked file still blocks (exit 2).
      const editBlocked = runFromSibling({ session_id: 'foreign-live-sess', cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.ts') } });
      expect(editBlocked.status).toBe(2);
      expect(editBlocked.stderr).toContain('KITH LOCK GUARD');

      // `--conflicts` as boolean flag before target does not swallow the target argument.
      const cleared = spawnSync(process.execPath, [cli, 'session', 'clear', '--conflicts', conflictKey], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
      expect(cleared.status, cleared.stderr).toBe(0);
    } finally {
      sibling.kill('SIGTERM');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('clears an auto-session and its conflicts by hand', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-home-'));
    try {
      const key = 'claude:session-1';
      engine.fencing.registerAgent({ id: 'auto-claude-aaaaaaaa' });
      engine.fencing.registerAgent({ id: 'a2' });
      engine.coordDb.db.prepare(
        `INSERT INTO conflicts (id, agent_a, agent_b, file_path, severity, details_json, detected_at) VALUES ('c1', 'auto-claude-aaaaaaaa', 'a2', 'src/a.ts', 'text_conflict', '{}', ?)`
      ).run(Date.now());
      const out = clearAutoSession(home, engine, { repoCommonDir: path.join(dir, '.git'), target: 'auto-claude-aaaaaaaa' });
      expect(out).toMatchObject({ agentId: 'auto-claude-aaaaaaaa', reclaimed: true, conflictsCleared: 1 });
      expect(engine.fencing.getAgent('auto-claude-aaaaaaaa')?.status).toBe('dead');
      expect(engine.shadowGit.listConflicts()).toEqual([]);
      expect(key).toBeTruthy();
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('binds MCP session registration to auto-session presence, clearing capability conflicts and transferring locks', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-home-mcp-bridge-'));
    const sibling = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' });
    try {
      const crypto = await import('node:crypto');
      const sessionKey = 'claude:mcp-bridge-sess';
      const autoAgentId = `auto-claude-${crypto.createHash('sha1').update(sessionKey).digest('hex').slice(0, 8)}`;
      const commonGitDir = engine.coordDb.commonGitDir!;

      // Record auto-session presence for this process tree, while autoAgentId is held by an unresumable foreign PID
      recordPresence(home, {
        sessionKey,
        client: 'claude',
        checkoutRoot: dir,
        repoCommonDir: commonGitDir,
        pid: process.pid,
        filePath: 'src/a.ts',
      });
      engine.fencing.registerAgent({ id: autoAgentId, client: 'claude', pid: sibling.pid! });
      engine.locks.acquireLocks({ agentId: autoAgentId, patterns: ['src/a.ts'], lockType: 'file' });

      // MCP session registers for the same client process tree (`kith_begin_work` / `kith_work`)
      const mcpReg = engine.fencing.registerAgent({ id: 'claude-mcp-worker', client: 'mcp', pid: process.pid });
      bindMcpSessionToAutoPresence(home, engine, {
        repoCommonDir: commonGitDir,
        mcpPid: process.pid,
        agentId: 'claude-mcp-worker',
        sessionToken: mcpReg.sessionToken,
      });

      // Stale auto-* agent is reclaimed and its lock on src/a.ts is now owned by claude-mcp-worker
      expect(engine.fencing.getAgent(autoAgentId)?.status).toBe('dead');
      expect(engine.locks.listLocks().map(l => [l.pattern, l.owner_agent_id])).toEqual([['src/a.ts', 'claude-mcp-worker']]);

      // Subsequent `--auto` Edit and Bash hooks for `mcp-bridge-sess` resume `claude-mcp-worker` cleanly
      const env = { ...process.env, HOME: home, USERPROFILE: home, KITH_HOME: home };
      delete (env as Record<string, string | undefined>).KITH_AGENT_ID;
      delete (env as Record<string, string | undefined>).KITH_SESSION_TOKEN;
      const editPre = spawnSync(process.execPath, [cli, 'hook', 'pre', '--client', 'claude', '--auto'], {
        cwd: dir,
        env,
        encoding: 'utf8',
        input: JSON.stringify({
          session_id: 'mcp-bridge-sess',
          cwd: dir,
          tool_name: 'Edit',
          tool_input: { file_path: path.join(dir, 'src/a.ts') },
        }),
      });
      expect(editPre.status, editPre.stderr).toBe(0);
    } finally {
      sibling.kill('SIGTERM');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not misattribute concurrent peer edits during read-only commands or shared-checkout locks, while still quarantining direct writes', () => {
    const lockedTestPath = 'research/worker/test/terminal-agent-access-refused.test.ts';
    fs.mkdirSync(path.join(dir, path.dirname(lockedTestPath)), { recursive: true });
    fs.writeFileSync(path.join(dir, lockedTestPath), 'export const testCase = 1;\n');
    git('add', lockedTestPath);
    git('commit', '-m', 'add test file');

    engine.setWorkflowMode('main');
    engine.fencing.registerAgent({ id: 'live-owner', pid: process.pid });
    engine.fencing.registerAgent({ id: 'reader-peer', pid: process.pid });
    engine.locks.acquireLocks({ agentId: 'live-owner', patterns: [lockedTestPath], lockType: 'file' });

    // 1. Reader runs read-only commands (`ls`, `tail`, `stack.mjs status`) while live-owner edits lockedTestPath
    for (const cmd of ['ls -la', 'tail -n 5 src/a.ts', 'node scripts/local-stack/stack.mjs status']) {
      engine.bashGuard.capturePreBashSnapshot('reader-peer', dir);
      fs.writeFileSync(path.join(dir, lockedTestPath), `export const testCase = "${cmd}";\n`);
      const res = engine.bashGuard.verifyPostBashAndQuarantine({
        agentId: 'reader-peer',
        command: cmd,
        rootDir: dir,
      });
      expect(res.allowed).toBe(true);
      expect(res.quarantinedViolations).toEqual([]);
      expect(res.authorizedModifiedFiles).toEqual([]);
    }
    expect(engine.shadowGit.listConflicts()).toEqual([]);

    // 2. Reader runs a non-read-only command that does NOT target lockedTestPath while live-owner edits lockedTestPath
    engine.bashGuard.capturePreBashSnapshot('reader-peer', dir);
    fs.writeFileSync(path.join(dir, lockedTestPath), 'export const testCase = 99;\n');
    const unrelatedCmd = engine.bashGuard.verifyPostBashAndQuarantine({
      agentId: 'reader-peer',
      command: 'node -e "process.exit(0)"',
      rootDir: dir,
    });
    expect(unrelatedCmd.allowed).toBe(true);
    expect(unrelatedCmd.quarantinedViolations).toEqual([]);

    // 3. Reader runs a command that explicitly writes to lockedTestPath -> quarantined!
    engine.bashGuard.capturePreBashSnapshot('reader-peer', dir);
    fs.writeFileSync(path.join(dir, lockedTestPath), 'export const hijacked = true;\n');
    const directWrite = engine.bashGuard.verifyPostBashAndQuarantine({
      agentId: 'reader-peer',
      command: `sh -c "echo hijacked > ${lockedTestPath}"`,
      rootDir: dir,
    });
    expect(directWrite.allowed).toBe(false);
    expect(directWrite.quarantinedViolations).toHaveLength(1);
    expect(directWrite.quarantinedViolations[0]?.file_path).toBe(lockedTestPath);
  });

  it('commits only the caller agent recorded/specified files via kith commit while peers are active and keeps .git/index synced', () => {
    fs.writeFileSync(path.join(dir, 'src/peer.ts'), 'export const peer = 1;\n');
    git('add', 'src/peer.ts');
    git('commit', '-m', 'add peer file');

    engine.setWorkflowMode('main');
    const callerSession = engine.fencing.registerAgent({ id: 'caller-agent', pid: process.pid });
    engine.fencing.registerAgent({ id: 'peer-agent', pid: process.pid });
    engine.locks.acquireLocks({ agentId: 'caller-agent', patterns: ['src/a.ts'], lockType: 'file' });
    engine.locks.acquireLocks({ agentId: 'peer-agent', patterns: ['src/peer.ts'], lockType: 'file' });

    // Both agents edit their respective files in the shared main checkout
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(dir, 'src/peer.ts'), 'export const peer = 2;\n');

    // Raw git update-ref is blocked by the Bash firewall while peers are active, and points to `kith commit`
    const safety = engine.bashGuard.checkCommandSafety({ agentId: 'caller-agent', command: 'git update-ref HEAD deadbeef' });
    expect(safety.safe).toBe(false);
    expect(safety.reason).toContain('kith commit -m');

    // Refuses if caller-agent tries to commit peer-agent's locked file
    const forbidden = engine.commit({
      agentId: 'caller-agent',
      sessionToken: callerSession.sessionToken,
      message: 'try peer file',
      files: ['src/peer.ts'],
    });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error).toContain('peer-agent');

    // Auto-discovers caller-agent's locked file `src/a.ts` when `files` is omitted and commits via CLI
    const commitCli = spawnSync(
      process.execPath,
      [cli, '--repo', dir, 'commit', '--agent', 'caller-agent', '--session-token', callerSession.sessionToken, '-m', 'feat: commit only caller file'],
      { cwd: dir, encoding: 'utf8' }
    );
    expect(commitCli.status, commitCli.stderr).toBe(0);
    const parsed = JSON.parse(commitCli.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual(['src/a.ts']);

    // Verify HEAD contains src/a.ts update, src/peer.ts remains dirty in working tree, and .git/index has no stale staged state
    expect(git('log', '-1', '--pretty=%s').trim()).toBe('feat: commit only caller file');
    expect(git('show', 'HEAD:src/a.ts')).toBe('export const a = 2;\n');
    expect(git('show', 'HEAD:src/peer.ts')).toBe('export const peer = 1;\n');
    expect(git('status', '--porcelain', '-uno').trim()).toBe('M src/peer.ts');
  });

  it('tracks whether workflowMode was explicitly configured vs defaulted', () => {
    expect(engine.workflowMode()).toBe('worktrees');
    expect(engine.workflowModeConfigured()).toBe(false);

    const beforeCli = spawnSync(process.execPath, [cli, '--repo', dir, 'mode'], { cwd: dir, encoding: 'utf8' });
    expect(JSON.parse(beforeCli.stdout)).toMatchObject({ ok: true, mode: 'worktrees', configured: false });

    const setMain = spawnSync(process.execPath, [cli, '--repo', dir, 'mode', 'main'], { cwd: dir, encoding: 'utf8' });
    expect(JSON.parse(setMain.stdout)).toMatchObject({ ok: true, mode: 'main', configured: true });

    const afterCli = spawnSync(process.execPath, [cli, '--repo', dir, 'mode'], { cwd: dir, encoding: 'utf8' });
    expect(JSON.parse(afterCli.stdout)).toMatchObject({ ok: true, mode: 'main', configured: true });
  });
});
