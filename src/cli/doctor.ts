import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseToml } from 'smol-toml';
import { isWithin, physicalPath } from '../core/repository.js';
import { readCoordinationState } from '../core/observation.js';

/** Diagnostics read files and inspect a snapshot; they never initialize state, trust projects, install packages or run configured hooks. */
export function doctorReport(directory=process.cwd()) {
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
  let configured=0;
  for(const [client,file] of [['claude','.mcp.json'],['cursor','.cursor/mcp.json'],['codex','.codex/config.toml']] as const) {
    const target=path.join(root,file); if(!fs.existsSync(target)) continue;
    try {
      if(!isWithin(root,physicalPath(target)))throw new Error('Configuration is redirected outside the checkout');
      const text=fs.readFileSync(target,'utf8');
      const config=client==='codex'?parseToml(text):JSON.parse(text);
      const server=client==='codex'?config.mcp_servers?.kith:config.mcpServers?.kith;
      if(!server) continue;configured++;
      check(`${client}-mcp`,typeof server.command==='string' && Array.isArray(server.args) && executable(server.command),'Kith stdio launcher must be executable by absolute path or PATH; native client trust and MCP discovery require client validation');
    } catch {check(`${client}-mcp`,false,`Cannot parse ${file}; existing configuration was preserved`);}
  }
  check('mcp-configuration',configured>0,'Configure the clients you use with kith init; diagnostics do not change client settings');
  check('coordination-state',state.state==='ready',state.state==='ready'?'Schema and counters validated on a private snapshot':state.error??'No coordination state; run kith init before starting agents');
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
