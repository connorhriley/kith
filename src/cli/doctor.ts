import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse as parseToml } from 'smol-toml';
import { branchIsCheckedOutElsewhere, listGitWorktrees } from '../core/worktree-adopt.js';
import { isWithin, physicalPath } from '../core/repository.js';
import { readCoordinationState } from '../core/observation.js';
import { launchAgentPath } from './autostart.js';
import { claudeKithPluginStatus } from './claude-plugin.js';
import { claudeDesktopConfigPath, runtimeVersionCheck } from './runtime-pin.js';

/** Diagnostics read files and inspect a snapshot; they never initialize state, trust projects, install packages or run configured hooks. */
export function doctorReport(directory=process.cwd(), home=os.homedir()) {
  const state=readCoordinationState(directory), root=state.repository.root;
  const checks: Array<{name:string;ok:boolean;detail:string}>=[];
  const check=(name:string,ok:boolean,detail:string)=>checks.push({name,ok,detail});
  const [major,minor]=process.versions.node.split('.').map(Number);
  check('node',major===22 && minor>=13 || major>=24,process.version);
  check('platform',process.platform==='darwin'||process.platform==='linux',process.platform==='win32'?'Native Windows is limited to MCP coordination; supervised mutex commands and shell hooks require macOS/Linux or WSL':process.platform);
  try {
    const version=execFileSync('git',['--version'],{encoding:'utf8',timeout:2000}).trim();
    const parts=/\b(\d+)\.(\d+)/.exec(version);
    check('git',Boolean(parts && (Number(parts[1])>2 || Number(parts[1])===2 && Number(parts[2])>=38)),version);
  } catch {check('git',false,'Git 2.38+ must be available on PATH');}
  const executable = (command: string) => {
    const candidates = path.isAbsolute(command) ? [command]
      : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
    return candidates.some(file => {
      try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
      catch { return false; }
    });
  };
  const desktop = claudeDesktopConfigPath(home);
  const files = [
    ['claude',path.join(root,'.mcp.json'),false,root], ['cursor',path.join(root,'.cursor/mcp.json'),false,root],
    ['codex',path.join(root,'.codex/config.toml'),true,root], ['claude-global',path.join(home,'.claude.json'),false,home],
    ['claude-desktop',desktop,false,path.dirname(desktop)], ['codex-global',path.join(home,'.codex/config.toml'),true,home],
    ['antigravity',path.join(home,'.gemini/config/mcp_config.json'),false,home],
  ] as const;
  let configured=0;
  const inspected = new Set<string>();
  for(const [client,target,toml,base] of files) {
    if(inspected.has(target) || !fs.existsSync(target)) continue;
    inspected.add(target);
    try {
      if(!isWithin(physicalPath(base),physicalPath(target)))throw new Error('Configuration is redirected outside its setup root');
      const text=fs.readFileSync(target,'utf8');
      const config=toml?parseToml(text):JSON.parse(text);
      const server=toml?config.mcp_servers?.kith:config.mcpServers?.kith;
      if(!server) continue; configured++;
      if(typeof server.command!=='string' || !Array.isArray(server.args) || !server.args.every((a:unknown)=>typeof a==='string') || !executable(server.command))
        throw new Error('Kith launcher is missing or not executable; rerun setup from the installed version');
      if(/^node(?:\.exe)?$/i.test(path.basename(server.command)) && (!server.args[0] || !fs.existsSync(server.args[0]) || !fs.statSync(server.args[0]).isFile()))
        throw new Error('Kith CLI entry is missing; rerun setup after moving or reinstalling Node/Kith');
      const pin=server.args.indexOf('--repo');
      if(pin>=0 && (typeof server.args[pin+1]!=='string' || !path.isAbsolute(server.args[pin+1]) || physicalPath(server.args[pin+1])!==root))
        throw new Error('Kith launcher is pinned to a different checkout; use that checkout or review its setup');
      check(`${client}-mcp`,true,'Launcher files are present; native connection, project trust and tool approval are not verified by doctor');
    } catch(error) {check(`${client}-mcp`,false,`${target}: ${error instanceof Error ? error.message : String(error)}; configuration preserved`);}
  }
  const realHome = physicalPath(home);
  const claudePlugin = claudeKithPluginStatus(realHome, root);
  if (configured > 0) check('mcp-configuration', true, 'Use global kith install or project kith init for your client; configuration alone does not establish a connection');
  else if (claudePlugin.active) check('mcp-configuration', true, `The Claude Code plugin provides the Kith MCP server${claudePlugin.id ? ` (${claudePlugin.id})` : ''}. It runs npx -y kith-coord mcp --compact. kith install still configures Cursor, Codex, and other clients.`);
  else check('mcp-configuration', false, 'Use global kith install, the Claude Code plugin, or project kith init for your client; configuration alone does not establish a connection');
  if(state.state==='ready') check('workflow-mode',true,state.workflowMode==='main'?'main-checkout mode: agents share the main checkout and no worktrees are created (change with kith mode worktrees)':state.workflowModeConfigured?'worktree mode: each agent can work in an isolated worktree (change with kith mode main)':'worktree mode (default, not explicitly set — run kith mode main or kith mode worktrees to pin)');
  check('coordination-state',state.state!=='unavailable',state.state==='ready'?'Schema and counters validated on a private snapshot':state.error??'No project state yet; the first owned task initializes it. No state was created by doctor');
  const globalClaudeHooks = path.join(realHome, '.claude/settings.json');
  const pluginHookDetail = 'Claude Code plugin hooks are configured and run npx -y kith-coord. Use kith install when you also want Cursor, Codex, and the macOS menu bar.';
  if (fs.existsSync(globalClaudeHooks)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(globalClaudeHooks, 'utf8'));
      const pre = Array.isArray(cfg?.hooks?.PreToolUse) ? cfg.hooks.PreToolUse : [];
      const kithEntries = pre.filter((e: any) => Array.isArray(e?.hooks) && e.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(' hook pre')));
      if (kithEntries.length) {
        const notes = ['Passive Claude Code global hooks configured.'];
        if (kithEntries.length > 1) notes.push(`${kithEntries.length} Kith PreToolUse entries share one ledger. This is not a failure; kith install keeps a single entry.`);
        if (claudePlugin.active) notes.push('The Claude Code plugin is also enabled. Its hooks defer to these, so a tool call is checked once.');
        check('global-claude-hooks', true, notes.join(' '));
      } else if (claudePlugin.active) check('global-claude-hooks', true, pluginHookDetail);
    } catch {
      check('global-claude-hooks', false, `Cannot parse ${globalClaudeHooks}`);
    }
  } else if (claudePlugin.active) check('global-claude-hooks', true, pluginHookDetail);
  const globalCursorHooks = path.join(realHome, '.cursor/hooks.json');
  if (fs.existsSync(globalCursorHooks)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(globalCursorHooks, 'utf8'));
      const pre = Array.isArray(cfg?.hooks?.preToolUse) ? cfg.hooks.preToolUse : [];
      const hasKith = pre.some((e: any) => typeof e?.command === 'string' && e.command.includes(' hook pre'));
      if (hasKith) check('global-cursor-hooks', true, 'Passive Cursor global hooks configured');
    } catch {
      check('global-cursor-hooks', false, `Cannot parse ${globalCursorHooks}`);
    }
  }
  const runtime = runtimeVersionCheck(realHome, root);
  if (runtime) check('runtime-version', runtime.ok, runtime.detail);
  if (checks.some(c => c.name === 'codex-global-mcp' && c.ok)) {
    check('codex-hooks', true, 'Codex CLI does not expose pre/post tool hooks; protection uses --compact MCP and passive watcher/Radar alerts');
  }
  if (process.platform === 'darwin') {
    const plist = launchAgentPath(realHome);
    if (fs.existsSync(plist)) {
      const text = fs.readFileSync(plist, 'utf8');
      check('autostart', text.includes('bin/kith-menubar'), `Login LaunchAgent present (${plist})`);
    }
  } else {
    check('autostart', true, 'Login autostart targets macOS LaunchAgents; run kith watch manually on this platform');
  }
  let nativeGuards=false;
  for(const [file,event] of [['.claude/settings.json','PreToolUse'],['.cursor/hooks.json','preToolUse']] as const) {
    const target=path.join(root,file);if(!fs.existsSync(target))continue;
    try {
      if(!isWithin(root,physicalPath(target)))throw new Error('Hook configuration leaves checkout');
      const config=JSON.parse(fs.readFileSync(target,'utf8')),entries=config.hooks?.[event]??[];
      if(!Array.isArray(entries))throw new Error('Hook entries must be an array');
      const hooks=event==='PreToolUse'?entries.flatMap(e=>e?.hooks??[]):entries;
      const guards=hooks.filter(h=>typeof h?.command==='string'&&h.command.includes('--repo')&&h.command.includes(' hook pre'));
      if(guards.length){nativeGuards=true;check(`${event}-failure-policy`,guards.every(h=>event==='PreToolUse'?h.onFailure==='block':h.failClosed===true),'Kith native pre-hooks must block on launch errors and timeouts');}
    }catch{check(`${event}-configuration`,false,`Cannot validate ${file}; configuration preserved`);}
  }
  const id=process.env.KITH_AGENT_ID, token=process.env.KITH_SESSION_TOKEN;
  if(id||token||nativeGuards) {
    const agent=state.agents.find(a=>a.id===id);
    // A shell that names a session must hold a live one. A shell that names none is simply not participating.
    if(id||token) check('session-environment',Boolean(id&&token&&agent?.status==='active'&&agent.lease_expires_at>Date.now()),'This shell names a Kith session, so hooks enforce it: it needs both inherited session variables and a current recorded lease. Capability validity is checked on use');
    else check('session-environment',true,'No Kith session in this shell, so Kith hooks allow everything. Start one (kith session start) only if you want claims enforced for this client; MCP-only workflows need none.');
  }
  let linked: ReturnType<typeof listGitWorktrees> = [];
  if (state.state === 'ready') {
    try { linked = listGitWorktrees(state.repository.root); } catch { linked = []; }
  }
  const registrations = state.worktreeRegistrations ?? [];
  for(const workspace of state.workspaces) {
    const name=`workspace:${workspace.agentId}`, gone=!workspace.available && !fs.existsSync(workspace.path);
    const registration = registrations.find(row => row.agentId === workspace.agentId);
    const adopted = registration?.provenance === 'adopted';
    const detachedLive = Boolean(adopted && workspace.available && !workspace.branch);
    const elsewhereLive = Boolean(adopted && workspace.branch && branchIsCheckedOutElsewhere(linked, workspace.path, workspace.branch));
    const adoptedLabel = adopted ? `Adopted ${registration?.source ?? 'external'} worktree` : 'Worktree';
    const adoptedDetail = adopted
      ? `${detachedLive ? '; detached HEAD' : ''}${elsewhereLive || registration?.branchCheckedOutElsewhere ? '; branch checked out elsewhere' : ''}${registration?.dirty ? '; dirty when adopted' : ''}`
      : '';
    // An ended session whose worktree was moved or removed is history, not a fault. Only a live session needs its worktree.
    if(gone && workspace.status!=='active') check(name,true,`Retired: this ${workspace.status} session's worktree no longer exists (${workspace.path}). Nothing to do; Kith keeps the record for history.`);
    else if(gone) check(name,false,`${adoptedLabel} is missing: ${workspace.path}. The session is still active; restore the directory or end the session. Kith does not delete an adopted worktree.`);
    else {
      const identityOk = detachedLive || (workspace.available && (!workspace.recordedBranch || workspace.recordedBranch === workspace.branch));
      check(name, identityOk, workspace.error ?? `${adoptedLabel}: ${workspace.path}; branch ${workspace.branch ?? 'detached'}; dirty files: ${workspace.dirtyFiles.length}${adoptedDetail}`);
    }
  }
  const adoptedRows = registrations.filter(row => row.provenance === 'adopted');
  if (adoptedRows.length) {
    const missing = adoptedRows.filter(row => {
      const agent = state.agents.find(agent => agent.id === row.agentId);
      return agent?.status === 'active' && !fs.existsSync(row.worktreePath);
    });
    const detail = adoptedRows.map(row => {
      const workspace = state.workspaces.find(item => item.agentId === row.agentId);
      const detached = workspace ? workspace.available && !workspace.branch : row.detached;
      const elsewhere = workspace?.branch ? branchIsCheckedOutElsewhere(linked, row.worktreePath, workspace.branch) : row.branchCheckedOutElsewhere;
      return `${row.agentId}: adopted ${row.source} ${row.worktreePath}${row.branch ? ` (${row.branch})` : ''}${detached ? ', detached HEAD' : ''}${elsewhere ? ', branch checked out elsewhere' : ''}${row.dirty ? ', dirty when adopted' : ''}`;
    }).join('; ');
    check('adopted-worktrees', missing.length === 0, missing.length
      ? `Adopted worktree missing for a live session. Kith will not recreate or delete it. ${detail}`
      : `Adopted worktrees Kith did not create, and will not remove unless you pass --delete-adopted: ${detail}`);
  }
  return {ok:checks.every(c=>c.ok),repository:state.repository,checks};
}
