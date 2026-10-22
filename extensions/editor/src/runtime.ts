import fs from 'node:fs';
import {parse, type ParseError} from 'jsonc-parser';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute = promisify(execFile);
export function supportedNode(version: string): boolean {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major >= 24 || major === 22 && minor >= 13;
}
export function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KITH_') && !['CLAUDE_PROJECT_DIR','GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE'].includes(key)));
}
export async function resolveNode(configured: string, cwd: string): Promise<string> {
  if (configured && !path.isAbsolute(configured)) throw new Error('kith.nodePath must be an absolute path.');
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = configured ? [configured] : [
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name)),
    path.join(os.homedir(), '.volta/bin', name),
    ...(process.platform === 'win32' ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs/node.exe')]
      : ['/opt/homebrew/bin/node','/usr/local/bin/node','/usr/bin/node']),
  ];
  for (const candidate of new Set(candidates)) {
    if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) continue;
    try {
      const {stdout} = await execute(candidate, ['-e', "require('node:sqlite');process.stdout.write(process.versions.node)"], {cwd, env: cleanEnvironment(), timeout: 5000, maxBuffer: 65536, windowsHide: true});
      if (supportedNode(stdout.trim())) return fs.realpathSync.native(candidate);
    } catch { /* Try the next installed runtime; do not download one. */ }
  }
  throw new Error('Kith needs Node.js 22.13+ on 22.x or Node.js 24+. Install Node or set Kith: Node Path in user settings.');
}
export async function runJson(node: string, launcher: string, args: string[], signal: AbortSignal): Promise<Record<string, any>> {
  try {
    const {stdout} = await execute(node, [launcher, ...args], {env: {...cleanEnvironment(), GIT_OPTIONAL_LOCKS:'0'}, cwd: path.dirname(launcher), timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal});
    return JSON.parse(stdout);
  } catch (error) {
    // An incomplete read-only scan deliberately returns nonzero with usable health details.
    const stdout = (error as {stdout?: string}).stdout;
    if (stdout) { try { const value = JSON.parse(stdout); if (value.complete === false || value.state === 'unavailable') return value; } catch {} }
    throw new Error(signal.aborted ? 'Observation stopped.' : 'Kith observation failed or timed out. Run Kith: Refresh to retry.');
  }
}
export function existingKith(files: string[]): string | undefined {
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const errors: ParseError[]=[];
      const value = parse(fs.readFileSync(file, 'utf8'), errors, {allowTrailingComma:true});
      if(errors.length) throw new Error('Invalid JSONC');
      if ([value?.mcpServers,value?.servers,value?.mcp?.servers].some(entries=>entries&&typeof entries==='object'&&Object.keys(entries).some(key=>['kith','kith-editor'].includes(key.toLowerCase())))) return file;
    }
    catch { throw new Error(`MCP configuration cannot be read: ${file}. It was left unchanged.`); }
  }
  return undefined;
}
