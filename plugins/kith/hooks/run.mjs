/**
 * Claude Code plugin hook entry. Runs `npx -y kith-coord` unless Claude
 * settings already register the same Kith hook (`kith install` or `kith init`).
 * In that case this process exits 0 and the settings hook does the check once.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOOK_PHASES = {
  'session-start': ['hook', 'session-start', '--client', 'claude'],
  pre: ['hook', 'pre', '--client', 'claude', '--auto'],
  post: ['hook', 'post', '--client', 'claude', '--auto'],
  stop: ['hook', 'stop', '--client', 'claude', '--auto'],
};

const PHASE_PATTERN = {
  'session-start': /\bhook\s+session-start\b/,
  pre: /\bhook\s+pre\b/,
  post: /\bhook\s+post\b/,
  stop: /\bhook\s+stop\b/,
};

const KITH_COMMAND = /(?:\bkith(?:-coord)?\b|dist[\\/]cli[\\/]index\.js)/i;
const MAX_SETTINGS_BYTES = 1_000_000;

export function kithHookAlreadyInstalled(text, phase) {
  const pattern = PHASE_PATTERN[phase];
  if (!pattern || typeof text !== 'string') return false;
  return pattern.test(text) && KITH_COMMAND.test(text);
}

export function settingsPaths(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const files = [];
  if (env.CLAUDE_CONFIG_DIR) {
    files.push(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'));
    files.push(path.join(env.CLAUDE_CONFIG_DIR, '.claude', 'settings.json'));
  }
  files.push(path.join(home, '.claude', 'settings.json'));
  if (env.CLAUDE_PROJECT_DIR) {
    files.push(path.join(env.CLAUDE_PROJECT_DIR, '.claude', 'settings.json'));
    files.push(path.join(env.CLAUDE_PROJECT_DIR, '.claude', 'settings.local.json'));
  }
  return [...new Set(files)];
}

export function shouldDefer(phase, env, readFile = fs.readFileSync) {
  if (!PHASE_PATTERN[phase]) return false;
  for (const file of settingsPaths(env)) {
    let text = '';
    try {
      text = readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (typeof text !== 'string') continue;
    if (text.length > MAX_SETTINGS_BYTES) text = text.slice(0, MAX_SETTINGS_BYTES);
    if (kithHookAlreadyInstalled(text, phase)) return true;
  }
  return false;
}

function defaultSpawn(args, stdin) {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(command, ['-y', 'kith-coord', ...args], {
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
    });
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, deferred: false });
    };
    child.on('error', () => finish(1));
    child.on('exit', (code) => finish(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

export async function runHook(options) {
  const phase = options.phase;
  const args = HOOK_PHASES[phase];
  if (!args) return { code: 1, deferred: false };
  const env = options.env ?? process.env;
  if (shouldDefer(phase, env, options.readFile)) return { code: 0, deferred: true };
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  return spawnImpl(args, options.stdin ?? Buffer.alloc(0));
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  const result = await runHook({ phase: process.argv[2], stdin: await readStdin() });
  process.exit(result.code);
}

if (invokedDirectly()) {
  main().catch(() => process.exit(1));
}
