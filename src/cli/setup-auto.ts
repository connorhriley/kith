import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { discoverRepository, physicalPath, isWithin } from '../core/repository.js';
import { KithEngine } from '../core/engine.js';
import { applySetupPlan } from './setup-ledger.js';
import { installedCliPath } from './runtime.js';

export interface ClientDetectionResult {
  clientName: string;
  found: boolean;
  configPath: string;
  configured: boolean;
  notes: string;
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object; no configuration was written.`);
  return value as Record<string, any>;
}

/** Recognize only Kith's installed stdio launcher; leave custom transports and wrappers alone. */
function ownedLauncher(value: Record<string, any>): boolean {
  if (value.type !== undefined && value.type !== 'stdio') return false;
  if (typeof value.command !== 'string' || !/^node(?:\.exe)?$/i.test(path.basename(value.command)) ||
      !Array.isArray(value.args) || value.args[1] !== 'mcp' ||
      ![2, 4].includes(value.args.length) || value.args.length === 4 && value.args[2] !== '--repo') return false;
  try {
    const entry = fs.realpathSync(value.args[0]);
    return path.basename(entry) === 'index.js' && path.basename(path.dirname(entry)) === 'cli' &&
      JSON.parse(fs.readFileSync(path.resolve(entry, '../../../package.json'), 'utf8')).name === 'kith-coord';
  } catch { return false; }
}

/** Preflight all clients first. Reuse private setup ledgers; never change hooks or permissions. */
export function autoConfigureAllClients(targetWorkspace = process.cwd(), home = os.homedir(), options: { dryRun?: boolean } = {}): ClientDetectionResult[] {
  const target = physicalPath(targetWorkspace);
  const layout = target === path.parse(target).root ? undefined : discoverRepository(target);
  const workspace = layout?.checkoutRoot ?? target;
  home = physicalPath(home);
  const server = { command: process.execPath, args: [installedCliPath(), 'mcp'] };
  const projectServer = { ...server, args: [...server.args, '--repo', workspace] };
  const results: ClientDetectionResult[] = [];
  const groups = new Map<string, { coordDir: string; plan: Map<string, { content: string; mode?: number }> }>();
  const warnings: string[] = [];
  const queue = (root: string, file: string, content: string) => {
    if (!isWithin(root, file)) throw new Error(`Configuration is outside its setup root: ${file}`);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
    const group = groups.get(root) ?? { coordDir: root === workspace && layout ? layout.coordDir : path.join(root, '.coord'), plan: new Map() };
    if (physicalPath(group.coordDir) !== group.coordDir) throw new Error('Setup backup directory must not be redirected.');
    group.plan.set(path.relative(root, file), { content, mode: 0o600 });
    groups.set(root, group);
  };
  const safePath = (file: string) => {
    if (physicalPath(file) !== file) throw new Error(`Configuration path is redirected: ${file}; no configuration was written.`);
  };
  const jsonClient = (clientName: string, file: string, root: string, found: boolean, projectScoped = false) => {
    const selectedServer = projectScoped ? projectServer : server;
    if (!found) { results.push({ clientName, configPath: file, found: false, configured: false, notes: 'No existing client configuration found' }); return; }
    safePath(file);
    const cfg = fs.existsSync(file) ? object(JSON.parse(fs.readFileSync(file, 'utf8')), file) : {};
    const servers = object(cfg.mcpServers ?? {}, `${file} mcpServers`);
    const previous = servers.kith === undefined ? undefined : object(servers.kith, `${file} kith`);
    const exact = previous?.command === selectedServer.command && JSON.stringify(previous.args) === JSON.stringify(selectedServer.args);
    if (previous && !exact && !ownedLauncher(previous)) {
      results.push({ clientName, configPath: file, found: true, configured: false, notes: 'Custom Kith server preserved; review its repository and launcher manually' }); return;
    }
    cfg.mcpServers = { ...servers, kith: { ...previous, ...selectedServer } };
    queue(root, file, JSON.stringify(cfg, null, 2) + '\n');
    results.push({ clientName, configPath: file, found: true, configured: true, notes: `${options.dryRun ? 'Would configure' : 'Configured'} Kith ${projectScoped ? `for ${workspace}` : 'for per-task repository selection'}; existing settings preserved` });
  };

  const desktop = process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? path.join(home, 'AppData/Roaming'), 'Claude/claude_desktop_config.json')
    : process.platform === 'darwin' ? path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json')
    : path.join(home, '.config/Claude/claude_desktop_config.json');
  jsonClient('Claude Desktop App', desktop, home, fs.existsSync(desktop));
  jsonClient('Claude Code CLI', path.join(home, '.claude.json'), home,
    fs.existsSync(path.join(home, '.claude.json')) || fs.existsSync(path.join(home, '.claude')));

  const codex = path.join(home, '.codex/config.toml');
  if (fs.existsSync(path.dirname(codex))) {
    safePath(codex);
    const original = fs.existsSync(codex) ? fs.readFileSync(codex, 'utf8') : '';
    const cfg = parseToml(original), servers = object(cfg.mcp_servers ?? {}, 'Codex MCP servers');
    const previous = servers.kith === undefined ? undefined : object(servers.kith, 'Codex Kith server');
    let content = original;
    let configured = true;
    const exact = previous?.command === server.command && JSON.stringify(previous.args) === JSON.stringify(server.args);
    if (!previous) {
      content += (content && !content.endsWith('\n') ? '\n' : '') + '\n' + stringifyToml({ mcp_servers: { kith: { ...server, env_vars: ['KITH_AGENT_ID', 'KITH_SESSION_TOKEN'] } } });
    } else if (!exact) {
      // Update only the simple block emitted by auto-setup. Preserve comments, nested tables,
      // custom transports and multiline user configuration rather than reserializing the file.
      const block = /(^\[mcp_servers\.kith\][^\S\r\n]*\r?\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m;
      const match = original.match(block);
      if (ownedLauncher(previous) && match && /^command\s*=\s*"(?:[^"\\\r\n]|\\.)*"\s*$/m.test(match[2]) && /^args\s*=\s*\[[^\r\n]*\]\s*$/m.test(match[2])) {
        const fields = [`command = ${JSON.stringify(server.command)}`, `args = ${JSON.stringify(server.args)}`];
        const updated = match[2].replace(/^command\s*=.*$/m, fields[0]).replace(/^args\s*=.*$/m, fields[1]);
        content = original.replace(block, () => match[1] + updated);
      } else configured = false;
    }
    parseToml(content);
    if (configured) queue(home, codex, content);
    results.push({ clientName: 'Codex', found: true, configPath: codex, configured,
      notes: configured ? `${options.dryRun ? 'Would configure' : 'Configured'} Kith for per-task repository selection; other TOML preserved` : 'Custom Kith server preserved; review its repository and launcher manually' });
  }
  jsonClient('Cursor', path.join(workspace, '.cursor/mcp.json'), workspace, Boolean(layout?.commonGitDir), true);
  const antigravity = path.join(home, '.gemini/config/mcp_config.json');
  jsonClient('Antigravity', antigravity, home, fs.existsSync(path.dirname(antigravity)));

  // Keep private backup material out of Git, using the same retained ignore rule as init.
  for (const [root] of groups) {
    if (!fs.existsSync(path.join(root, '.git'))) continue;
    const file = path.join(root, '.gitignore'); safePath(file);
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!original.split(/\r?\n/).some(line => ['.coord/', '/.coord/'].includes(line.trim()))) {
      queue(root, file, original + (original && !original.endsWith('\n') ? '\n' : '') + '\n# Kith private setup backups\n.coord/\n');
    }
  }

  // Every parse and path check above completes before any client writes. Backups precede
  // writes under each root's setup lock. An interrupted setup retains exact original bytes.
  if (!options.dryRun && groups.size) {
    const engine = layout?.commonGitDir ? new KithEngine(workspace) : undefined; // Refuse damaged state before touching any client.
    try {
      for (const [root, group] of groups) {
        fs.mkdirSync(group.coordDir, { recursive: true, mode: 0o700 });
        applySetupPlan(root, group.coordDir, group.plan, warnings);
      }
    } finally { engine?.close(); }
  }
  for (const warning of warnings) results.push({ clientName: 'Setup backup', found: true, configured: false, configPath: '', notes: warning });
  return results;
}
