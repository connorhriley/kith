import { KITH_PROTOCOL_VERSION } from '../version.js';
import { applySetupPlan } from './setup-ledger.js';
import { discoverRepository, isWithin, physicalPath } from '../core/repository.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { KithEngine } from '../core/engine.js';
import { enforcementMode, type EnforcementMode } from './hook-handler.js';

export const INTEGRATIONS = ['claude', 'codex', 'cursor', 'agents', 'git', 'shims'] as const;
export type Integration = (typeof INTEGRATIONS)[number];
export interface InitReport {
  repoRoot: string;
  indexedFiles: number;
  configuredFiles: string[];
  dryRun: boolean;
  warnings: string[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object. No configuration was written.`);
  }
  return value as Record<string, unknown>;
}

function readConfig(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  try {
    return object(JSON.parse(fs.readFileSync(file, 'utf8')), file);
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Preflight every selected configuration before writing; preserve unrelated settings. */
export function initializeKithRepository(
  repoRoot = process.cwd(),
  cliBinaryCommand = 'kith',
  options: { dryRun?: boolean; integrations?: Integration[]; mcpOnly?: boolean; enforcement?: EnforcementMode } = {}
): InitReport {
  const mode = enforcementMode(options.enforcement);
  const modeArg = mode === 'block' ? '' : ` --enforcement ${mode}`;
  const absRoot = discoverRepository(repoRoot).checkoutRoot;
  const mcpOnly = options.mcpOnly ?? options.integrations === undefined;
  const selected = new Set(options.integrations ?? ['claude', 'codex', 'cursor', 'agents'] as Integration[]);
  if (mcpOnly && (selected.has('git') || selected.has('shims'))) {
    throw new Error('--mcp-only supports client MCP configurations and agent instructions; omit git and shims.');
  }
  for (const integration of selected) {
    if (!INTEGRATIONS.includes(integration)) throw new Error(`Unknown integration: ${integration}`);
  }
  if (process.platform === 'win32' && !mcpOnly && ['claude', 'cursor', 'git', 'shims'].some(name => selected.has(name as Integration))) {
    throw new Error('Native Windows setup supports MCP-only configuration; use --mcp-only or WSL for shell hooks and shims.');
  }
  if (!fs.statSync(absRoot).isDirectory()) throw new Error(`Not a directory: ${absRoot}`);
  const plan = new Map<string, { content: string; mode?: number }>();
  const warnings: string[] = [];
  const add = (name: string, content: string, mode?: number) => {
    const target = path.isAbsolute(name) ? name : path.join(absRoot, name);
    if (!isWithin(absRoot, physicalPath(target))) throw new Error(`Configuration path leaves repository: ${name}`);
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
      plan.set(name, { content, mode });
    }
  };
  const json = (name: string, value: unknown) => add(name, JSON.stringify(value, null, 2) + '\n');
  const hookCommand = `${cliBinaryCommand} --repo ${shellQuote(absRoot)} hook`;
  // Native clients cannot spawn npm's .cmd launcher directly. Avoid cmd.exe quoting entirely.
  const windowsCli = process.platform === 'win32' ? ['./cli/index.js', './index.js', '../../dist/cli/index.js']
    .map(relative => fileURLToPath(new URL(relative, import.meta.url))).find(file => fs.existsSync(file)) : undefined;
  if (process.platform === 'win32' && !windowsCli) throw new Error('Build Kith before generating native Windows MCP configuration');
  const server = windowsCli
    ? { command: process.execPath, args: [windowsCli, 'mcp', '--repo', absRoot] }
    : { command: 'kith', args: ['mcp', '--repo', absRoot] };

  const ignorePath = path.join(absRoot, '.gitignore');
  const ignore = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  if (!ignore.split(/\r?\n/).some((line) => ['.coord/', '/.coord/'].includes(line.trim()))) {
    add('.gitignore', ignore + (ignore && !ignore.endsWith('\n') ? '\n' : '') + '\n# Kith local state and worktrees\n.coord/\n');
  }

  if (selected.has('claude')) {
    const settings = readConfig(path.join(absRoot, '.claude/settings.json'));
    const hooks = object(settings.hooks ?? {}, 'Claude hooks');
    if (mcpOnly && ['PreToolUse', 'PostToolUse'].some(event => Array.isArray(hooks[event]) && hooks[event].length)) {
      warnings.push('Existing Claude tool hooks preserved. Review whether they require inherited KITH credentials; --mcp-only does not disable guards.');
    }
    for (const [event, phase] of (mcpOnly ? [] : [['PreToolUse', 'pre'], ['PostToolUse', 'post']]) as Array<['PreToolUse' | 'PostToolUse', 'pre' | 'post']>) {
      const entries = hooks[event] ?? [];
      if (!Array.isArray(entries)) throw new Error(`Claude hooks.${event} must be an array.`);
      const baseCommand = `${hookCommand} ${phase}`;
      const command = baseCommand + modeArg;
      const owned = (value: unknown) => typeof value === 'string' && [baseCommand, ...['block', 'warn', 'off'].map(m => `${baseCommand} --enforcement ${m}`)].includes(value);
      const exists = entries.some((entry) => {
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return false;
        return entry.hooks.some((hook: { command?: string } | null) => owned(hook?.command));
      });
      hooks[event] = exists ? entries.map((entry) => {
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return entry;
        return { ...entry, hooks: entry.hooks.map((hook: { command?: string } | null) =>
          owned(hook?.command) ? { ...hook, command, ...(event === 'PreToolUse' ? { onFailure: 'block' } : {}) } : hook) };
      }) : [...entries, {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
        hooks: [{ type: 'command', command, ...(event === 'PreToolUse' ? { onFailure: 'block' } : {}) }],
      }];
    }
    if (!mcpOnly) { settings.hooks = hooks; json('.claude/settings.json', settings); }
    const mcp = readConfig(path.join(absRoot, '.mcp.json'));
    mcp.mcpServers = { ...object(mcp.mcpServers ?? {}, 'Claude MCP servers'), kith: server };
    json('.mcp.json', mcp);
  }
  if (selected.has('codex')) {
    const file = path.join(absRoot, '.codex/config.toml');
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    let config: Record<string, unknown>;
    try { config = parseToml(original); }
    catch { throw new Error(`Cannot read ${file}: invalid TOML. No configuration was written.`); }
    const servers = object(config.mcp_servers ?? {}, 'Codex MCP servers');
    if (Object.hasOwn(servers, 'kith')) {
      // Preserve custom transports, approvals and environment settings byte for byte.
      const existing = object(servers.kith, 'Codex Kith MCP server');
      if (existing.command !== server.command || JSON.stringify(existing.args) !== JSON.stringify(server.args) ||
          !['KITH_AGENT_ID', 'KITH_SESSION_TOKEN'].every((name) => Array.isArray(existing.env_vars) && existing.env_vars.includes(name))) {
        warnings.push('Existing Codex kith server preserved. Review its command/args and forward KITH_AGENT_ID and KITH_SESSION_TOKEN using env_vars.');
      }
    } else {
      const addition = stringifyToml({ mcp_servers: { kith: {
        ...server, env_vars: ['KITH_AGENT_ID', 'KITH_SESSION_TOKEN'],
      } } });
      const content = original + (original && !original.endsWith('\n') ? '\n' : '') + '\n# Kith local coordination\n' + addition;
      parseToml(content); // Validate the complete append before any configuration is written.
      add('.codex/config.toml', content);
    }
  }
  if (selected.has('cursor')) {
    const mcp = readConfig(path.join(absRoot, '.cursor/mcp.json'));
    mcp.mcpServers = { ...object(mcp.mcpServers ?? {}, 'Cursor MCP servers'), kith: server };
    json('.cursor/mcp.json', mcp);
    const existingCursorHooks = readConfig(path.join(absRoot, '.cursor/hooks.json'));
    if(mcpOnly && ['preToolUse','postToolUse'].some(event=>Array.isArray((existingCursorHooks.hooks as Record<string,unknown>)?.[event])&&((existingCursorHooks.hooks as Record<string,unknown>)[event] as unknown[]).length)) warnings.push('Existing Cursor hooks preserved; review their inherited session requirements.');
    if (!mcpOnly) {
      const config = existingCursorHooks;
      if (config.version !== undefined && config.version !== 1) throw new Error('Unsupported Cursor hooks version; no configuration was written.');
      const hooks = object(config.hooks ?? {}, 'Cursor hooks');
      for (const [event, phase] of [['preToolUse', 'pre'], ['postToolUse', 'post']] as const) {
        const entries = hooks[event] ?? [];
        if (!Array.isArray(entries)) throw new Error(`Cursor hooks.${event} must be an array.`);
        const baseCommand = `${hookCommand} ${phase} --client cursor`;
        const owned = (value: unknown) => typeof value === 'string' && [baseCommand, ...['block', 'warn', 'off'].map(m => `${baseCommand} --enforcement ${m}`)].includes(value);
        const entry = { command: baseCommand + modeArg, matcher: 'Shell|Write|Delete', ...(phase === 'pre' ? { failClosed: true } : {}) };
        const exists = entries.some(e => e && typeof e === 'object' && owned(e.command));
        hooks[event] = exists ? entries.map(e => e && typeof e === 'object' && owned(e.command) ? { ...e, ...entry } : e) : [...entries, entry];
      }
      json('.cursor/hooks.json', { ...config, version: 1, hooks });
    }
  }
  if (selected.has('agents')) {
    const file = path.join(absRoot, 'AGENTS.md');
    let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Repository Agent Instructions\n';
    const block = `<!-- KITH:START -->
## Parallel Agent Coordination (kith)

Instruction protocol: ${KITH_PROTOCOL_VERSION}.

Use Kith MCP to claim work, isolate changes in worktrees, share local resources and verify integration. Keep one isolated worktree per parallel agent and keep the owning MCP connection open.

1. Call \`kith_begin_work\` with a unique \`agentId\`, an explicit \`scopeGlobs\` array and \`isolateWorktree: true\`.
2. Edit only the returned \`worktree.worktreePath\`. Report changed files through \`kith_record_file_edit\` on that connection.
3. Run serialized commands with \`kith_run_with_mutex\`: pass a literal executable/argument array. Its cwd defaults to the registered worktree. Commands run with server permissions and require client approval.
4. Renew idle sessions with \`kith_heartbeat\` before their lease expires (every two minutes for the default five-minute lease; sooner for a shorter lease). Inspect \`kith_get_status\`.
5. Complete with \`kith_complete_work\` and a project-specific \`verificationCmd\`. Failed verification keeps the integration target unchanged. Successful worktrees are retained for inspection.

The MCP connection retains its capability; omit \`sessionToken\` on subsequent calls on that connection. Initial grant/resume replies contain the token, so keep client transcripts private. Do not copy tokens into shell commands or public reports. A new connection needs a valid capability to resume an existing ID. Locks coordinate cooperating writers; hooks are not an OS security sandbox.

If Claude/Cursor edit hooks or CLI commands are also enabled, launch the client from a persistent shell after \`eval "$(kith session start --agent <id> --owner-pid "$$" --shell)"\`. CLI, hooks and MCP must inherit the same KITH_AGENT_ID/KITH_SESSION_TOKEN and use the same agent ID. Separate stateless shell calls do not preserve these exports or the owning shell. MCP-only setup skips new native edit hooks and preserves existing ones.
<!-- KITH:END -->`;
    if (content.includes('<!-- KITH:START -->') !== content.includes('<!-- KITH:END -->')) {
      throw new Error('AGENTS.md has an incomplete Kith block. Repair it before running init.');
    }
    content = content.includes('<!-- KITH:START -->')
      ? content.replace(/<!-- KITH:START -->[\s\S]*?<!-- KITH:END -->/, () => block)
      : content.trimEnd() + '\n\n' + block + '\n';
    add('AGENTS.md', content);
    add('.agent/skills/kith/SKILL.md', '---\nname: kith\ndescription: Coordinate parallel coding work through Kith MCP and isolated worktrees.\n---\n\nPrefer the Kith MCP tools on one persistent connection. Begin with kith_begin_work using a unique agentId, explicit scopeGlobs and isolateWorktree:true. Edit the returned worktreePath, report files with kith_record_file_edit, run literal command arrays with kith_run_with_mutex, heartbeat before expiry and finish with kith_complete_work plus a project verificationCmd. Inspect kith_get_status. Keep capabilities private. If CLI or native hooks are enabled, first launch the client from a persistent shell with the same KITH_AGENT_ID/KITH_SESSION_TOKEN and --owner-pid "$$". Stateless shell calls cannot retain that setup. Locks require cooperating clients.\n');
  }
  if (selected.has('git')) {
    try {
      const hooksDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], {
        cwd: absRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const hook = path.join(hooksDir, 'pre-commit');
      const physicalHooks = fs.existsSync(hooksDir) ? fs.realpathSync(hooksDir) : hooksDir;
      const relativeHooks = path.relative(fs.realpathSync(absRoot), physicalHooks);
      if (relativeHooks === '..' || relativeHooks.startsWith('..' + path.sep) || path.isAbsolute(relativeHooks)) {
        warnings.push('Git hook skipped: hooks directory is outside this repository. Integrate the guard manually.');
      } else {
        const script = (arg: string) => `#!/usr/bin/env sh\n# Kith coordination guard\nexec ${hookCommand} pre-commit${arg}\n`;
        const existing = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8') : null;
        if (existing === null || ['', ...['block', 'warn', 'off'].map(m => ` --enforcement ${m}`)].some(arg => existing === script(arg))) {
          add(hook, script(modeArg), 0o755);
        } else warnings.push('Existing pre-commit hook preserved; add `kith hook pre-commit` to your hook manager if needed.');
      }
    } catch {
      warnings.push('Git hook skipped: this directory is not a Git worktree.');
    }
  }
  if (selected.has('shims')) {
    for (const manager of ['npm', 'pnpm', 'yarn']) {
      // Remove this shim directory before resolving either kith or the real package manager.
      add(`.coord/bin/${manager}`, `#!/usr/bin/env sh
shim_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
kith_path=
old_ifs=$IFS
IFS=:
for entry in $PATH; do
  [ "$entry" = "$shim_dir" ] && continue
  if [ -z "$kith_path" ]; then kith_path=$entry; else kith_path="$kith_path:$entry"; fi
done
IFS=$old_ifs
PATH=$kith_path
export PATH
case "$1" in
  install|i|add|remove|ci)
    if [ "\${KITH_PACKAGE_INSTALL_GUARDED:-}" = 1 ]; then exec ${manager} "$@"; fi
    exec ${cliBinaryCommand} --repo ${shellQuote(absRoot)} mutex --agent "\${KITH_AGENT_ID:-shim-$$}" --name package-install -- ${manager} "$@"
    ;;
  *) exec ${manager} "$@" ;;
esac
`, 0o755);
    }
  }
  const report: InitReport = {
    repoRoot: absRoot, indexedFiles: 0, configuredFiles: [...plan.keys()],
    dryRun: options.dryRun ?? false, warnings,
  };
  if (report.dryRun) return report;
  const engine = new KithEngine(absRoot);
  try {
    if(plan.size) applySetupPlan(absRoot, engine.coordDb.coordDir, plan, warnings);
    report.indexedFiles = engine.depGraph.indexRepositoryFiles(absRoot);
  } finally {
    engine.close();
  }
  return report;
}
