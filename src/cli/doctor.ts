import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse as parseToml } from 'smol-toml';
import { isWithin, physicalPath } from '../core/repository.js';
import { readCoordinationState } from '../core/observation.js';

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
  const desktop = process.platform === 'win32'
    ? path.join(home === os.homedir() ? process.env.APPDATA ?? path.join(home, 'AppData/Roaming') : path.join(home, 'AppData/Roaming'), 'Claude/claude_desktop_config.json')
    : process.platform === 'darwin' ? path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json')
    : path.join(home, '.config/Claude/claude_desktop_config.json');
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
  check('mcp-configuration',configured>0,'Use global kith setup or project kith init for your client; configuration alone does not establish a connection');
  check('coordination-state',state.state!=='unavailable',state.state==='ready'?'Schema and counters validated on a private snapshot':state.error??'No project state yet; the first owned task initializes it. No state was created by doctor');
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
    check('session-environment',Boolean(id&&token&&agent?.status==='active'&&agent.lease_expires_at>Date.now()),'Native hooks need a persistent owning shell with both inherited session variables and a current recorded lease. MCP-only workflows do not need these exports. Capability validity is checked on use');
  }
  for(const workspace of state.workspaces) check(`workspace:${workspace.agentId}`,workspace.available && (!workspace.recordedBranch||workspace.recordedBranch===workspace.branch),workspace.error??`${workspace.path}; dirty files: ${workspace.dirtyFiles.length}`);
  return {ok:checks.every(c=>c.ok),repository:state.repository,checks};
}
