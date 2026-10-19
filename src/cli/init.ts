import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { KithEngine } from '../core/engine.js';

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
  options: { dryRun?: boolean; integrations?: Integration[] } = {}
): InitReport {
  const absRoot = path.resolve(repoRoot);
  const selected = new Set(options.integrations ?? INTEGRATIONS);
  for (const integration of selected) {
    if (!INTEGRATIONS.includes(integration)) throw new Error(`Unknown integration: ${integration}`);
  }
  if (!fs.statSync(absRoot).isDirectory()) throw new Error(`Not a directory: ${absRoot}`);
  const plan = new Map<string, { content: string; mode?: number }>();
  const warnings: string[] = [];
  const add = (name: string, content: string, mode?: number) => {
    const target = path.isAbsolute(name) ? name : path.join(absRoot, name);
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
      plan.set(name, { content, mode });
    }
  };
  const json = (name: string, value: unknown) => add(name, JSON.stringify(value, null, 2) + '\n');
  const hookCommand = `${cliBinaryCommand} --repo ${shellQuote(absRoot)} hook`;
  const server = { command: 'kith', args: ['mcp', '--repo', absRoot] };

  const ignorePath = path.join(absRoot, '.gitignore');
  const ignore = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  if (!ignore.split(/\r?\n/).some((line) => ['.coord/', '/.coord/'].includes(line.trim()))) {
    add('.gitignore', ignore + (ignore && !ignore.endsWith('\n') ? '\n' : '') + '\n# Kith local state and worktrees\n.coord/\n');
  }

  if (selected.has('claude')) {
    const settings = readConfig(path.join(absRoot, '.claude/settings.json'));
    const hooks = object(settings.hooks ?? {}, 'Claude hooks');
    for (const [event, phase] of [['PreToolUse', 'pre'], ['PostToolUse', 'post']] as const) {
      const entries = hooks[event] ?? [];
      if (!Array.isArray(entries)) throw new Error(`Claude hooks.${event} must be an array.`);
      const command = `${hookCommand} ${phase}`;
      const exists = entries.some((entry) => {
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return false;
        return entry.hooks.some((hook: { command?: string } | null) => hook?.command === command);
      });
      hooks[event] = exists ? entries.map((entry) => {
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return entry;
        return { ...entry, hooks: entry.hooks.map((hook: { command?: string } | null) =>
          hook?.command === command && event === 'PreToolUse' ? { ...hook, onFailure: 'block' } : hook) };
      }) : [...entries, {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
        hooks: [{ type: 'command', command, ...(event === 'PreToolUse' ? { onFailure: 'block' } : {}) }],
      }];
    }
    settings.hooks = hooks;
    json('.claude/settings.json', settings);
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
  }
  if (selected.has('agents')) {
    const file = path.join(absRoot, 'AGENTS.md');
    let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Repository Agent Instructions\n';
    const block = `<!-- KITH:START -->
## Parallel Agent Coordination (kith)

Start a capability-owned session before launching a hook client: \`eval "$(kith session start --agent <id> --owner-pid "$$" --shell)"\`. Share KITH_AGENT_ID and KITH_SESSION_TOKEN with CLI and hooks. Keep the token private.
For sandboxed MCP clients, use \`kith_begin_work\` and \`kith_run_with_mutex\` with literal command arrays; the connection retains ownership internally. Commands run with server permissions and require client approval.
- Begin: \`kith begin --agent <id> --title "<intent>" --scope "src/**"\`
- Claim a queued task: \`kith task claim --agent <id>\`
- Inspect coordination: \`kith status\` or \`kith top\`
- Serialize installs: \`kith mutex --agent <id> --name package-install -- pnpm install\`
- Complete: \`kith complete --agent <id>\`

Locks and hooks coordinate cooperating clients; they are not an OS security sandbox.
Refresh leases with \`kith heartbeat --agent <id>\` during long sessions.
<!-- KITH:END -->`;
    if (content.includes('<!-- KITH:START -->') !== content.includes('<!-- KITH:END -->')) {
      throw new Error('AGENTS.md has an incomplete Kith block. Repair it before running init.');
    }
    content = content.includes('<!-- KITH:START -->')
      ? content.replace(/<!-- KITH:START -->[\s\S]*?<!-- KITH:END -->/, () => block)
      : content.trimEnd() + '\n\n' + block + '\n';
    add('AGENTS.md', content);
    add('.agent/skills/kith/SKILL.md', '---\nname: kith\ndescription: Coordinate parallel coding work through Kith.\n---\n\nStart with `kith session start --agent <id> --owner-pid "$$" --shell` and export its KITH_AGENT_ID/KITH_SESSION_TOKEN before launching hooks. Keep capabilities private. Begin with `kith begin --agent <id> --title <intent> --scope <glob>`, inspect `kith status`, refresh with `kith heartbeat --agent <id>`, and finish with `kith complete --agent <id>`. Use MCP tools for file-edit reports when tool hooks are unavailable. Locks require cooperating clients.\n');
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
      } else if (fs.existsSync(hook)) {
        warnings.push('Existing pre-commit hook preserved; add `kith hook pre-commit` to your hook manager if needed.');
      } else {
        add(hook, `#!/usr/bin/env sh\n# Kith coordination guard\nexec ${hookCommand} pre-commit\n`, 0o755);
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
  for (const [name, { content, mode }] of plan) {
    const target = path.isAbsolute(name) ? name : path.join(absRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { encoding: 'utf8', mode });
  }
  const engine = new KithEngine(absRoot);
  try {
    report.indexedFiles = engine.depGraph.indexRepositoryFiles(absRoot);
  } finally {
    engine.close();
  }
  return report;
}
