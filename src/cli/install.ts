import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverRepository, physicalPath } from '../core/repository.js';
import { autoConfigureAllClients, type ClientDetectionResult } from './setup-auto.js';
import { installAutostart, waitForHostAutostartRunning, type AutostartResult } from './autostart.js';
import { applySetupPlan } from './setup-ledger.js';
import { kithPackageRoot, pruneUnreferencedRuntimes } from './runtime-pin.js';
import { setupRuntime, verifySetupRuntime } from './setup-runtime.js';
import { startRadar } from './radar.js';

export interface InstallOptions {
  targetDir?: string;
  home?: string;
  dryRun?: boolean;
  cliPath?: string;
  full?: boolean;
  noHooks?: boolean;
  noRadar?: boolean;
  noAutostart?: boolean;
  project?: boolean;
  strictRadar?: boolean;
}

export interface InstallReport {
  ok: boolean;
  dryRun: boolean;
  targetDir: string;
  profile: 'compact' | 'full';
  cliPath: string;
  clients: ClientDetectionResult[];
  globalHooks: {
    configured: boolean;
    configPath: string;
    events: string[];
    notes: string;
  };
  cursorHooks: {
    configured: boolean;
    configPath: string;
    events: string[];
    notes: string;
  };
  autostart: AutostartResult;
  radar: {
    attempted: boolean;
    state: 'started' | 'running' | 'skipped' | 'unavailable' | 'failed';
    notes: string;
  };
  warnings: string[];
  /** Retained runtime directories removed because no live config still names them. */
  prunedRuntimes: string[];
}

function quoteCommand(value: string): string {
  if (process.platform === 'win32') return '"' + value.replace(/"/g, '\\"') + '"';
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function isKithGlobalHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return /\bhook\s+(session-start|pre|post|stop)\b/.test(command) &&
    /(?:kith|dist[\\/]cli[\\/]index\.js)/i.test(command);
}

function assertGitVersion(): void {
  const gitVersion = execFileSync('git', ['--version'], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 4000,
  }).match(/(\d+)\.(\d+)/);
  if (!gitVersion || Number(gitVersion[1]) < 2 || (Number(gitVersion[1]) === 2 && Number(gitVersion[2]) < 38)) {
    throw new Error('Install Git 2.38 or newer before Kith setup; no configuration was written.');
  }
}

function configureClaudeGlobalHooks(
  home: string,
  cliPath: string,
  dryRun: boolean,
  warnings: string[]
): InstallReport['globalHooks'] {
  const realHome = physicalPath(home);
  const claudeDir = path.join(realHome, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const hasClaude = fs.existsSync(claudeDir) || fs.existsSync(path.join(realHome, '.claude.json'));
  if (!hasClaude) {
    return {
      configured: false,
      configPath: settingsPath,
      events: [],
      notes: 'Claude Code directory not detected; skipped hooks.',
    };
  }

  if (physicalPath(settingsPath) !== settingsPath) {
    throw new Error(`Global Claude settings path is redirected: ${settingsPath}`);
  }

  let parsed: Record<string, any> = {};
  const original = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '';
  if (original.trim()) {
    const raw = JSON.parse(original);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${settingsPath} must be a JSON object; no configuration was written.`);
    }
    parsed = raw as Record<string, any>;
  }

  if (parsed.hooks !== undefined && (!parsed.hooks || typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks))) {
    throw new Error(`${settingsPath} hooks must be an object; no configuration was written.`);
  }

  const hooks: Record<string, any[]> = parsed.hooks ? { ...parsed.hooks } : {};
  const nodeExec = physicalPath(process.execPath);
  const cli = physicalPath(cliPath);
  const prefix = `${quoteCommand(nodeExec)} ${quoteCommand(cli)}`;

  const specs: Array<{ event: string; matcher?: string; command: string }> = [
    { event: 'SessionStart', command: `${prefix} hook session-start --client claude` },
    { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|Bash', command: `${prefix} hook pre --client claude --auto` },
    { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit|Bash', command: `${prefix} hook post --client claude --auto` },
    { event: 'Stop', command: `${prefix} hook stop --client claude --auto` },
  ];

  for (const spec of specs) {
    const existing = hooks[spec.event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`${settingsPath} hooks.${spec.event} must be an array; no configuration was written.`);
    }
    const preserved = (existing ?? []).filter((entry) => {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return true;
      const nonKith = entry.hooks.filter((h: any) => !isKithGlobalHookCommand(h?.command));
      return nonKith.length === entry.hooks.length;
    });
    const nextEntry: Record<string, unknown> = {
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [{ type: 'command', command: spec.command }],
    };
    hooks[spec.event] = [...preserved, nextEntry];
  }

  const nextObj = { ...parsed, hooks };
  const nextJson = JSON.stringify(nextObj, null, 2) + '\n';
  if (!dryRun && nextJson !== original) {
    const homeCoord = path.join(realHome, '.coord');
    fs.mkdirSync(homeCoord, { recursive: true, mode: 0o700 });
    applySetupPlan(realHome, homeCoord, new Map([['.claude/settings.json', { content: nextJson }]]), warnings);
  }

  return {
    configured: true,
    configPath: settingsPath,
    events: specs.map(s => s.event),
    notes: dryRun
      ? 'Would wire SessionStart, PreToolUse, PostToolUse, and Stop hooks.'
      : 'Wired SessionStart, PreToolUse, PostToolUse, and Stop hooks.',
  };
}

function executableOnPath(name: string): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some(dir =>
    dir && [name, ...(process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [])].some(f => fs.existsSync(path.join(dir, f)))
  );
}

function configureCursorGlobalHooks(
  home: string,
  cliPath: string,
  dryRun: boolean,
  warnings: string[]
): InstallReport['cursorHooks'] {
  const realHome = physicalPath(home);
  const cursorDir = path.join(realHome, '.cursor');
  const hooksPath = path.join(cursorDir, 'hooks.json');
  const hasCursor =
    fs.existsSync(cursorDir) ||
    executableOnPath('cursor') ||
    (process.platform === 'darwin' && ['/Applications/Cursor.app', path.join(realHome, 'Applications/Cursor.app')].some(p => fs.existsSync(p)));
  if (!hasCursor) {
    return {
      configured: false,
      configPath: hooksPath,
      events: [],
      notes: 'Cursor not detected; skipped hooks.',
    };
  }

  if (physicalPath(hooksPath) !== hooksPath) {
    throw new Error(`Global Cursor hooks path is redirected: ${hooksPath}`);
  }

  let parsed: Record<string, any> = {};
  const original = fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath, 'utf8') : '';
  if (original.trim()) {
    const raw = JSON.parse(original);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${hooksPath} must be a JSON object; no configuration was written.`);
    }
    if (raw.version !== undefined && raw.version !== 1) {
      throw new Error(`Unsupported ${hooksPath} version; no configuration was written.`);
    }
    parsed = raw as Record<string, any>;
  }

  if (parsed.hooks !== undefined && (!parsed.hooks || typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks))) {
    throw new Error(`${hooksPath} hooks must be an object; no configuration was written.`);
  }

  const hooks: Record<string, any[]> = parsed.hooks ? { ...parsed.hooks } : {};
  const nodeExec = physicalPath(process.execPath);
  const cli = physicalPath(cliPath);
  const prefix = `${quoteCommand(nodeExec)} ${quoteCommand(cli)}`;

  const specs: Array<{ event: string; matcher?: string; failClosed?: boolean; command: string }> = [
    { event: 'sessionStart', command: `${prefix} hook session-start --client cursor` },
    { event: 'preToolUse', matcher: 'Shell|Write|Delete', failClosed: true, command: `${prefix} hook pre --client cursor --auto` },
    { event: 'postToolUse', matcher: 'Shell|Write|Delete', command: `${prefix} hook post --client cursor --auto` },
    { event: 'stop', command: `${prefix} hook stop --client cursor --auto` },
  ];

  for (const spec of specs) {
    const existing = hooks[spec.event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`${hooksPath} hooks.${spec.event} must be an array; no configuration was written.`);
    }
    const preserved = (existing ?? []).filter((entry) => !isKithGlobalHookCommand(entry?.command));
    const nextEntry: Record<string, unknown> = {
      command: spec.command,
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      ...(spec.failClosed ? { failClosed: true } : {}),
    };
    hooks[spec.event] = [...preserved, nextEntry];
  }

  const nextJson = JSON.stringify({ ...parsed, version: 1, hooks }, null, 2) + '\n';
  if (!dryRun && nextJson !== original) {
    const homeCoord = path.join(realHome, '.coord');
    fs.mkdirSync(homeCoord, { recursive: true, mode: 0o700 });
    applySetupPlan(realHome, homeCoord, new Map([['.cursor/hooks.json', { content: nextJson }]]), warnings);
  }

  return {
    configured: true,
    configPath: hooksPath,
    events: specs.map(s => s.event),
    notes: dryRun
      ? 'Would wire sessionStart, preToolUse, postToolUse, and stop hooks.'
      : 'Wired sessionStart, preToolUse, postToolUse, and stop hooks.',
  };
}

export async function installKith(options: InstallOptions = {}): Promise<InstallReport> {
  assertGitVersion();
  const targetDir = physicalPath(options.targetDir ?? process.cwd());
  const home = physicalPath(options.home ?? os.homedir());
  const dryRun = Boolean(options.dryRun);
  const compact = !options.full;
  const warnings: string[] = [];

  if (targetDir !== path.parse(targetDir).root) {
    discoverRepository(targetDir);
  }

  // Preflight client configs and hook targets before copying runtime or mutating files.
  autoConfigureAllClients(targetDir, home, {
    dryRun: true,
    cliPath: options.cliPath,
    guidance: Boolean(options.project),
    compact,
    globalOnly: !options.project,
  });
  if (!options.noHooks) {
    configureClaudeGlobalHooks(home, options.cliPath ?? process.execPath, true, warnings);
    configureCursorGlobalHooks(home, options.cliPath ?? process.execPath, true, warnings);
  }

  const cliPath = options.cliPath ?? setupRuntime(home, dryRun);
  if (!dryRun && !options.cliPath) {
    await verifySetupRuntime(cliPath, { compact });
  }

  const clients = autoConfigureAllClients(targetDir, home, {
    dryRun,
    cliPath,
    guidance: Boolean(options.project),
    compact,
    globalOnly: !options.project,
  });

  const globalHooks = options.noHooks
    ? {
      configured: false,
      configPath: path.join(home, '.claude/settings.json'),
      events: [],
      notes: 'Skipped (--no-hooks).',
    }
    : configureClaudeGlobalHooks(home, cliPath, dryRun, warnings);

  const cursorHooks = options.noHooks
    ? {
      configured: false,
      configPath: path.join(home, '.cursor/hooks.json'),
      events: [],
      notes: 'Skipped (--no-hooks).',
    }
    : configureCursorGlobalHooks(home, cliPath, dryRun, warnings);

  const autostart = installAutostart({
    home,
    targetDir,
    cliPath,
    dryRun,
    warnings,
    noAutostart: options.noAutostart || options.noRadar,
  });

  const clientIssues = clients.some(r => r.found && !r.configured && r.clientName !== 'Setup backup');
  let ok = !clientIssues;

  let radar: InstallReport['radar'] = {
    attempted: false,
    state: 'skipped',
    notes: options.noRadar ? 'Skipped (--no-radar).' : 'Radar is only available on macOS.',
  };

  let prunedRuntimes: string[] = [];
  if (!dryRun) {
    try {
      const keep = kithPackageRoot(cliPath);
      const runtimeDir = keep && path.basename(path.dirname(keep)) === 'runtimes' ? keep : null;
      prunedRuntimes = pruneUnreferencedRuntimes(home, {
        extraRoots: [targetDir],
        keepDirs: runtimeDir ? [runtimeDir] : [],
      });
    } catch (err) {
      warnings.push(`Could not remove unreferenced Kith runtimes: ${(err as Error).message}`);
    }
  }

  if (!options.noRadar && process.platform === 'darwin') {
    const helper = path.resolve(path.dirname(cliPath), '../../bin/kith-menubar');
    if (dryRun) {
      radar = {
        attempted: false,
        state: fs.existsSync(helper) || options.strictRadar ? 'skipped' : 'unavailable',
        notes: 'Radar: would open the read-only menu-bar view.',
      };
    } else if (clientIssues) {
      radar = {
        attempted: false,
        state: 'skipped',
        notes: 'Radar: not opened; resolve setup issues first.',
      };
    } else if (fs.existsSync(helper) || options.strictRadar) {
      try {
        const launchdStarted = autostart.bootstrapped ? await waitForHostAutostartRunning() : false;
        const state = launchdStarted ? 'started' : await startRadar(targetDir, cliPath);
        radar = {
          attempted: true,
          state,
          notes: state === 'started'
            ? `Radar: opened for ${targetDir} (read-only; no model calls).`
            : 'Radar: already open; existing workspace kept. Use Switch Workspace in its menu if needed.',
        };
      } catch (err) {
        ok = false;
        radar = {
          attempted: true,
          state: 'failed',
          notes: `Radar did not open: ${(err as Error).message} Client configuration is retained. Retry setup, or use --no-radar for MCP-only setup.`,
        };
      }
    }
  }

  return {
    ok,
    dryRun,
    targetDir,
    profile: compact ? 'compact' : 'full',
    cliPath,
    clients,
    globalHooks,
    cursorHooks,
    autostart,
    radar,
    warnings,
    prunedRuntimes,
  };
}
