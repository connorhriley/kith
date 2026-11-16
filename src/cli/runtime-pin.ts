import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { physicalPath } from '../core/repository.js';
import { KITH_VERSION } from '../version.js';
import { launchAgentPath } from './autostart.js';

/** Claude Desktop's MCP config. Matches the path `kith doctor` already inspects. */
export function claudeDesktopConfigPath(home: string): string {
  if (process.platform === 'win32') {
    const appData = home === os.homedir()
      ? process.env.APPDATA ?? path.join(home, 'AppData/Roaming')
      : path.join(home, 'AppData/Roaming');
    return path.join(appData, 'Claude/claude_desktop_config.json');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
  return path.join(home, '.config/Claude/claude_desktop_config.json');
}

export interface PinnedRuntime {
  source: string;
  configPath: string;
  cliPath: string;
  /** Package version when the path is a `kith-coord` install; null when the file is missing or unreadable. */
  version: string | null;
}

/** Read `kith-coord`'s package version by walking up from a CLI, worker, or menu-bar binary. */
export function readKithPackageVersion(file: string): string | null {
  const root = kithPackageRoot(file);
  if (!root) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Directory that contains the `kith-coord` package.json for `file`, when it is one. */
export function kithPackageRoot(file: string): string | null {
  let real: string;
  try {
    if (!fs.existsSync(file)) return null;
    real = fs.realpathSync(file);
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  let dir = path.dirname(real);
  for (let hop = 0; hop < 6; hop++) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: unknown };
        if (pkg.name === 'kith-coord') return dir;
      }
    } catch { /* Keep walking; a broken manifest is not this install. */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** True when `candidate` is a newer dotted version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const own = versionParts(current);
  if (!next || !own) return false;
  for (let i = 0; i < 3; i++) {
    if (next[i] !== own[i]) return next[i] > own[i];
  }
  return false;
}

function versionParts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Split a hook command the way Kith quotes paths, including `'\\''` inside single quotes. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let i = 0;
  const source = command.trim();
  while (i < source.length) {
    while (source[i] === ' ' || source[i] === '\t') i++;
    if (i >= source.length) break;
    if (source[i] === "'") {
      i++;
      let word = '';
      while (i < source.length) {
        if (source.slice(i, i + 4) === "'\\''") { word += "'"; i += 4; continue; }
        if (source[i] === "'") { i++; break; }
        word += source[i++];
      }
      words.push(word);
      continue;
    }
    if (source[i] === '"') {
      i++;
      let word = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) { word += source[i + 1]; i += 2; continue; }
        word += source[i++];
      }
      if (source[i] === '"') i++;
      words.push(word);
      continue;
    }
    let word = '';
    while (i < source.length && source[i] !== ' ' && source[i] !== '\t') word += source[i++];
    words.push(word);
  }
  return words;
}

function walkCommands(value: unknown, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkCommands(item, out);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.command === 'string') out.push(record.command);
  for (const child of Object.values(record)) walkCommands(child, out);
}

function considerPath(source: string, configPath: string, candidate: string, out: PinnedRuntime[]): void {
  if (!candidate || candidate.length > 4096) return;
  const version = readKithPackageVersion(candidate);
  if (!version && !isRetainedRuntimePath(candidate)) return;
  if (out.some((pin) => pin.configPath === configPath && pin.cliPath === candidate)) return;
  out.push({ source, configPath, cliPath: candidate, version });
}

function isRetainedRuntimePath(file: string): boolean {
  const mark = `${path.sep}.local${path.sep}share${path.sep}kith${path.sep}runtimes${path.sep}`;
  return file.includes(mark);
}

function considerLauncher(source: string, configPath: string, command: unknown, args: unknown, out: PinnedRuntime[]): void {
  const candidates: string[] = [];
  if (typeof command === 'string') candidates.push(...shellWords(command));
  if (Array.isArray(args)) {
    for (const arg of args) if (typeof arg === 'string') candidates.push(arg);
  }
  for (const candidate of candidates) considerPath(source, configPath, candidate, out);
}

function sourceLabel(file: string): string {
  const base = path.basename(file);
  if (base === 'settings.json' && file.includes(`${path.sep}.claude${path.sep}`)) return `Claude hooks (${file})`;
  if (base === 'hooks.json') return `Cursor hooks (${file})`;
  if (base === 'config.toml') return `Codex config (${file})`;
  if (base === 'claude_desktop_config.json') return `Claude Desktop (${file})`;
  if (base === '.claude.json' || base === 'mcp.json' || base === '.mcp.json' || base === 'mcp_config.json') return `MCP config (${file})`;
  if (base.endsWith('.plist')) return `Login agent (${file})`;
  return file;
}

function projectConfigFiles(root: string): string[] {
  return [
    path.join(root, '.claude/settings.json'),
    path.join(root, '.mcp.json'),
    path.join(root, '.cursor/hooks.json'),
    path.join(root, '.cursor/mcp.json'),
    path.join(root, '.codex/config.toml'),
  ].filter((file) => fs.existsSync(file));
}

function configCandidates(home: string, projectRoot?: string): string[] {
  const files = [
    path.join(home, '.claude/settings.json'),
    path.join(home, '.claude.json'),
    path.join(home, '.cursor/hooks.json'),
    path.join(home, '.cursor/mcp.json'),
    path.join(home, '.codex/config.toml'),
    claudeDesktopConfigPath(home),
    path.join(home, '.gemini/config/mcp_config.json'),
    launchAgentPath(home),
  ];
  if (projectRoot) {
    files.push(
      path.join(projectRoot, '.claude/settings.json'),
      path.join(projectRoot, '.mcp.json'),
      path.join(projectRoot, '.cursor/hooks.json'),
      path.join(projectRoot, '.cursor/mcp.json'),
      path.join(projectRoot, '.codex/config.toml'),
    );
  }
  const seen = new Set<string>();
  const existing: string[] = [];
  for (const file of files) {
    let key = file;
    try { if (fs.existsSync(file)) key = fs.realpathSync(file); } catch { /* Fall back to the written path. */ }
    if (seen.has(key) || !fs.existsSync(file)) continue;
    seen.add(key);
    existing.push(file);
  }
  return existing;
}

/**
 * Kith CLI paths named by client hook and MCP configs.
 * A retained runtime whose package version cannot be read is included with `version: null`.
 */
export function findPinnedKithRuntimes(home: string, projectRoot?: string): PinnedRuntime[] {
  const pins: PinnedRuntime[] = [];
  for (const file of configCandidates(home, projectRoot)) {
    const source = sourceLabel(file);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const toml = file.endsWith('.toml');
    const plist = file.endsWith('.plist');
    if (plist) {
      for (const word of shellWords(text.replace(/<[^>]+>/g, ' '))) considerPath(source, file, word, pins);
      continue;
    }
    try {
      if (toml) {
        const config = parseToml(text) as { mcp_servers?: { kith?: { command?: unknown; args?: unknown } } };
        const server = config.mcp_servers?.kith;
        if (server) considerLauncher(source, file, server.command, server.args, pins);
        continue;
      }
      const config = JSON.parse(text) as {
        mcpServers?: { kith?: { command?: unknown; args?: unknown } };
        hooks?: unknown;
      };
      if (config.mcpServers?.kith) considerLauncher(source, file, config.mcpServers.kith.command, config.mcpServers.kith.args, pins);
      const commands: string[] = [];
      walkCommands(config.hooks, commands);
      for (const command of commands) considerLauncher(source, file, command, undefined, pins);
    } catch { /* Malformed config is reported by doctor's existing parse checks. */ }
  }
  return pins;
}

export interface RuntimeVersionCheck {
  ok: boolean;
  detail: string;
}

/** Fail when a pinned hook or MCP runtime is a different Kith than the CLI that is running. */
export function runtimeVersionCheck(home: string, projectRoot?: string, cliVersion = KITH_VERSION): RuntimeVersionCheck | null {
  const pins = findPinnedKithRuntimes(home, projectRoot).filter((pin) => pin.version !== null || isRetainedRuntimePath(pin.cliPath));
  if (!pins.length) return null;
  const mismatches = pins.filter((pin) => pin.version !== cliVersion);
  if (!mismatches.length) {
    return { ok: true, detail: `Pinned hook and MCP runtimes match this CLI (${cliVersion})` };
  }
  const listed = mismatches.map((pin) => pin.version
    ? `${pin.source} runs Kith ${pin.version} (${pin.cliPath})`
    : `${pin.source} points at an unreadable Kith runtime (${pin.cliPath})`).join('; ');
  return {
    ok: false,
    detail: `${listed}. This CLI is ${cliVersion}. Run \`kith install\` to point hooks and MCP at this version.`,
  };
}

/** Version of the `kith` on PATH when it is a newer `kith-coord` than `own`. */
export function newerGlobalKithVersion(pathEnv = process.env.PATH ?? '', own = KITH_VERSION): string | null {
  const cli = resolveOnPath(pathEnv);
  if (!cli) return null;
  const version = readKithPackageVersion(cli);
  if (!version || !isNewerVersion(version, own)) return null;
  return version;
}

function resolveOnPath(pathEnv: string): string | null {
  const names = process.platform === 'win32' ? ['kith.cmd', 'kith.exe', 'kith'] : ['kith'];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        const stat = fs.lstatSync(candidate);
        if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      } catch { continue; }
      if (readKithPackageVersion(candidate)) return candidate;
    }
  }
  return null;
}

export interface StaleRuntimeNoticeOptions {
  home: string;
  pid: number;
  pidStart?: string | null;
  ownVersion?: string;
  pathEnv?: string;
  /** Skip PATH lookup and read this CLI's package version instead. */
  globalCli?: string;
  /** Already-resolved global version. Avoids a second PATH walk when the caller checked. */
  globalVersion?: string;
}

/**
 * One line when this process's Kith is older than the `kith` on PATH.
 * The marker is per owner pid and process start, so subagents of one session share it
 * and a later hook in that session stays quiet. A missing pid does not warn on every call.
 */
export function staleRuntimeNotice(options: StaleRuntimeNoticeOptions): string | null {
  const own = options.ownVersion ?? KITH_VERSION;
  let globalVersion = options.globalVersion ?? null;
  if (!globalVersion) {
    const globalCli = options.globalCli ?? resolveOnPath(options.pathEnv ?? process.env.PATH ?? '');
    if (!globalCli) return null;
    globalVersion = readKithPackageVersion(globalCli);
  }
  if (!globalVersion || !isNewerVersion(globalVersion, own)) return null;
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0) return null;
  let home = options.home;
  try { home = physicalPath(home); } catch { return null; }
  const startKey = options.pidStart && options.pidStart.trim()
    ? createHash('sha256').update(options.pidStart).digest('hex').slice(0, 16)
    : 'nostart';
  const marker = path.join(home, '.local/share/kith/notices', `stale-cli-${options.pid}-${startKey}`);
  try {
    if (physicalPath(path.dirname(marker)) !== path.dirname(marker) && fs.existsSync(path.dirname(marker))) return null;
    if (fs.existsSync(marker)) return null;
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    if (physicalPath(path.dirname(marker)) !== path.dirname(marker)) return null;
    fs.writeFileSync(marker, `${own} ${globalVersion}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    return null;
  }
  return `[kith] This hook is Kith ${own}, older than the installed CLI ${globalVersion}. Run \`kith install\` to update it.`;
}

export interface PruneRuntimesOptions {
  dryRun?: boolean;
  extraRoots?: string[];
  /** Runtime directories to keep even when no config text contains them. */
  keepDirs?: string[];
}

/**
 * Remove `~/.local/share/kith/runtimes/<version>-<hash>` directories that no live
 * client config, hook command, or login agent still names. Setup backups are not
 * references: they keep the previous file bytes, which would otherwise pin every
 * old runtime forever. Unreadable or redirected config keeps every runtime.
 */
export function pruneUnreferencedRuntimes(home: string, options: PruneRuntimesOptions = {}): string[] {
  let base: string;
  try { base = path.join(physicalPath(home), '.local/share/kith/runtimes'); }
  catch { return []; }
  if (!fs.existsSync(base)) return [];
  try { if (physicalPath(base) !== base) return []; }
  catch { return []; }

  const files = configCandidates(home, undefined);
  for (const root of options.extraRoots ?? []) {
    for (const file of projectConfigFiles(root)) {
      if (!files.includes(file)) files.push(file);
    }
  }
  const uniqueFiles = [...new Set(files)];
  let corpus = '';
  for (const file of uniqueFiles) {
    try {
      if (fs.existsSync(file) && physicalPath(file) !== file) return [];
      corpus += `\n${fs.readFileSync(file, 'utf8')}`;
    } catch {
      return [];
    }
  }
  const keep = new Set<string>();
  for (const dir of options.keepDirs ?? []) {
    try { keep.add(fs.realpathSync(dir)); } catch { keep.add(dir); }
    keep.add(dir);
  }
  const removed: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  for (const name of names) {
    if (!name || name.startsWith('.')) continue;
    const dir = path.join(base, name);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(dir); } catch { continue; }
    if (stat.isSymbolicLink()) {
      const real = (() => { try { return fs.realpathSync(dir); } catch { return dir; } })();
      if (keep.has(dir) || keep.has(real) || corpus.includes(dir) || corpus.includes(real) || corpus.includes(`runtimes/${name}`) || corpus.includes(`runtimes\\${name}`)) continue;
      if (!options.dryRun) {
        try { fs.unlinkSync(dir); } catch { continue; }
      }
      removed.push(dir);
      continue;
    }
    if (!stat.isDirectory()) continue;
    const real = (() => { try { return fs.realpathSync(dir); } catch { return dir; } })();
    if (keep.has(dir) || keep.has(real)) continue;
    if (corpus.includes(dir) || corpus.includes(real) || corpus.includes(`runtimes/${name}`) || corpus.includes(`runtimes\\${name}`)) continue;
    if (!options.dryRun) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { continue; }
    }
    removed.push(dir);
  }
  return removed;
}
