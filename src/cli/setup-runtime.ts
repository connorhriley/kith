import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {KITH_VERSION} from '../version.js';
import {physicalPath} from '../core/repository.js';
import {installedCliPath} from './runtime.js';

/** Content-addressed, atomic copy of the bundled runtime. Never replace a running installation. */
export function setupRuntime(home: string, dryRun = false): string {
  const cli = installedCliPath(), dist = path.resolve(path.dirname(cli), '..');
  const root = path.resolve(dist, '..');
  const payload = new Map<string, Buffer>([
    ['dist/cli/index.js', fs.readFileSync(cli)],
    ['dist/command-worker.js', fs.readFileSync(path.join(dist, 'command-worker.js'))],
    ['package.json', Buffer.from(JSON.stringify({name: 'kith-coord', version: KITH_VERSION, type: 'module'}))],
  ]);
  for (const name of ['bin/kith-menubar', 'LICENSE', 'dist/THIRD_PARTY_NOTICES.txt']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) payload.set(name, fs.readFileSync(file));
  }
  // Editor bundles carry their own notices outside server/.
  const editorNotices = path.join(dist, '../THIRD_PARTY_NOTICES.md');
  if (!payload.has('dist/THIRD_PARTY_NOTICES.txt') && fs.existsSync(editorNotices))
    payload.set('dist/THIRD_PARTY_NOTICES.txt', fs.readFileSync(editorNotices));
  const hash = createHash('sha256');
  for (const [name, bytes] of payload) hash.update(name).update('\0').update(bytes);
  const base = path.join(physicalPath(home), '.local/share/kith/runtimes');
  const target = path.join(base, `${KITH_VERSION}-${hash.digest('hex').slice(0, 24)}`);
  const verify = () => {
    if (physicalPath(target) !== target) throw new Error('Kith runtime directory is redirected; no client configuration was written.');
    for (const [name, bytes] of payload) {
      const file = path.join(target, name);
      if (physicalPath(file) !== file || !fs.readFileSync(file).equals(bytes))
        throw new Error('Retained Kith runtime is damaged; preserve it and rerun setup from a verified installation.');
    }
  };
  if (physicalPath(base) !== base) throw new Error('Kith installation directory is redirected; no client configuration was written.');
  if (fs.existsSync(target)) verify();
  else if (!dryRun) {
    fs.mkdirSync(base, {recursive: true, mode: 0o700});
    const stage = fs.mkdtempSync(path.join(base, '.install-'));
    // An interrupted copy is never selected by a client; old installations stay intact.
    for (const [name, bytes] of payload) {
      const file = path.join(stage, name);fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
      fs.writeFileSync(file, bytes, {mode: name === 'bin/kith-menubar' ? 0o700 : 0o600});
    }
    try { fs.renameSync(stage, target); }
    catch (error) { if (!fs.existsSync(target)) throw error; verify(); fs.rmSync(stage, {recursive: true}); }
    verify();
  }
  return path.join(target, 'dist/cli/index.js');
}

/** Verify the retained server without selecting a repository or creating project state. */
export async function verifySetupRuntime(cli: string): Promise<void> {
  const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport} = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({name:'kith-setup-check',version:KITH_VERSION});
  const env = Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined && !key.startsWith('KITH_') && !key.startsWith('GIT_') && key!=='CLAUDE_PROJECT_DIR')) as Record<string,string>;
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[cli,'mcp'],cwd:path.parse(cli).root,env,stderr:'ignore'}), {timeout:10000});
    const tools = await client.listTools(undefined, {timeout:10000});
    if (!tools.tools.some(t=>t.name==='kith_begin_work') || client.getServerVersion()?.version!==KITH_VERSION) throw new Error('Retained Kith server did not pass MCP discovery; no client configuration was written.');
  } finally { await client.close(); }
}
