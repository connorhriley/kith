import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-two-clients-'));
const clients = [];
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('KITH_')));
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
try {
  git('init'); git('config', 'user.email', 'example@kith.local'); git('config', 'user.name', 'Kith example');
  fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n');
  git('add', '.'); git('commit', '-m', 'Example repository');
  const work = [];
  for (const name of ['auth', 'billing']) {
    const client = new Client({ name: `example-${name}`, version: '1.0.0' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--repo', root], env, stderr: 'ignore' }));
    const started = await call(client, 'kith_begin_work', { agentId: name, title: `Add ${name} module`, scopeGlobs: [`src/${name}.mjs`], isolateWorktree: true });
    const directory = path.join(started.worktree.worktreePath, 'src'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${name}.mjs`), `export const ${name} = true;\n`);
    await call(client, 'kith_record_file_edit', { agentId: name, filePath: `src/${name}.mjs` });
    work.push({ client, name });
  }
  for (const { client, name } of work) {
    await call(client, 'kith_complete_work', { agentId: name, verificationCmd: `node --check src/${name}.mjs` });
    console.log(`${name}: isolated edit reported, verified, and integrated`);
  }
  for (const { name } of work) {
    if (!fs.existsSync(path.join(root, `src/${name}.mjs`))) throw new Error(`Missing integrated module ${name}`);
  }
  console.log('Two real MCP clients completed work in separate worktrees. Disposable example passed.');
} finally {
  await Promise.all(clients.map((client) => client.close()));
  fs.rmSync(root, { recursive: true, force: true });
}
