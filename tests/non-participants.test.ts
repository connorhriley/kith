import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeKithRepository } from '../src/cli/init.js';

// Hooks govern sessions that joined. Everything else (an editor, a plain terminal, CI, another agent client)
// must pass straight through: no failed tool call, no failed commit, and no coordination database created.

const cli = path.resolve('dist/cli/index.js');
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-non-participant-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** An environment with no Kith identity at all, like an editor or a terminal that never ran `kith session start`. */
function plainEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('KITH_')) delete env[key];
  return { ...env, ...extra };
}
const git = (...args: string[]) => spawnSync('git', ['-c', `core.hooksPath=${path.join(root, '.git/hooks')}`, ...args], { cwd: root, encoding: 'utf8', env: plainEnv() });
const hook = (args: string[], env: NodeJS.ProcessEnv = plainEnv(), input = '') =>
  spawnSync(process.execPath, [cli, '--repo', root, 'hook', ...args], { cwd: root, env, input, encoding: 'utf8' });
const payload = () => JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(root, 'a.ts') } });

describe('hooks without a Kith identity', () => {
  it.each([['pre'], ['post'], ['pre-commit']])('`hook %s` allows and does not open coordination state', (phase) => {
    const result = hook([phase], plainEnv(), payload());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(fs.existsSync(path.join(root, '.coord'))).toBe(false);
  });

  it('is not failed by malformed input or an unusable repository path', () => {
    expect(hook(['pre'], plainEnv(), '{').status).toBe(0);
    const unusable = path.join(root, 'not-a-directory'); fs.writeFileSync(unusable, 'file');
    const result = spawnSync(process.execPath, [cli, '--repo', unusable, 'hook', 'pre'], { cwd: root, env: plainEnv(), encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('answers Cursor in its own permission shape', () => {
    const pre = hook(['pre', '--client', 'cursor'], plainEnv(), payload());
    expect(pre.status).toBe(0);
    expect(JSON.parse(pre.stdout)).toEqual({ permission: 'allow' });
    const post = hook(['post', '--client', 'cursor'], plainEnv(), payload());
    expect(post.status).toBe(0);
    expect(JSON.parse(post.stdout)).toEqual({ additional_context: '' });
  });

  it('lets a plain `git commit` through the generated pre-commit guard', () => {
    git('init'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
    const binary = `${quote(process.execPath)} ${quote(cli)}`;
    initializeKithRepository(root, binary, { integrations: ['git'], mcpOnly: false });
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    git('add', 'a.ts');
    const commit = git('commit', '-m', 'plain commit');
    expect(commit.status, commit.stderr).toBe(0);
    expect(git('log', '--format=%s').stdout.trim()).toBe('plain commit');

    // The same commit under strict mode is what used to happen to everyone.
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 2;\n');
    git('add', 'a.ts');
    const strict = spawnSync('git', ['-c', `core.hooksPath=${path.join(root, '.git/hooks')}`, 'commit', '-m', 'strict'], {
      cwd: root, encoding: 'utf8', env: plainEnv({ KITH_REQUIRE_SESSION: '1' }),
    });
    expect(strict.status).not.toBe(0);
    expect(strict.stderr).toContain('session capability');
  });
});

describe('strict mode and participants are unchanged', () => {
  it('--require-session and KITH_REQUIRE_SESSION restore fail-closed hooks', () => {
    const flag = hook(['pre', '--require-session'], plainEnv(), payload());
    expect(flag.status).toBe(2);
    expect(flag.stderr).toContain('session capability');
    const env = hook(['pre'], plainEnv({ KITH_REQUIRE_SESSION: '1' }), payload());
    expect(env.status).toBe(2);
  });

  it('a named agent without its capability still fails closed', () => {
    const byEnv = hook(['pre'], plainEnv({ KITH_AGENT_ID: 'worker' }), payload());
    expect(byEnv.status).toBe(2);
    const byFlag = hook(['pre', '--agent', 'worker'], plainEnv(), payload());
    expect(byFlag.status).toBe(2);
    const forged = hook(['pre'], plainEnv({ KITH_AGENT_ID: 'worker', KITH_SESSION_TOKEN: 'forged' }), payload());
    expect(forged.status).toBe(2);
  });
});
