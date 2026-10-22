import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-package-'));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KITH_'))), npm_config_cache: path.join(temp, 'npm-cache') };
const run = (cmd, args, cwd) => execFileSync(cmd, args, {
  cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
});
try {
  const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root));
  const files = packed.files.map((file) => file.path);
  assert(files.includes('LICENSE'));
  assert(files.includes('server.json'));
  const listing = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8'));
  assert.equal(listing.name, manifest.mcpName);
  assert.equal(listing.version, manifest.version);
  assert.equal(listing.packages[0].identifier, manifest.name);
  assert.equal(listing.packages[0].version, manifest.version);
  assert(files.includes('dist/index.d.ts'));
  assert(files.includes('dist/command-worker.js'));
  assert(files.includes('bin/kith-menubar'));
  const helper = fs.readFileSync(path.join(root, 'bin/kith-menubar'));
  assert.equal(helper.readUInt32BE(0), 0xcafebabe, 'Ship a universal macOS executable');
  assert(!files.some((file) => file.startsWith('.coord/') || file.startsWith('node_modules/')));
  const install = path.join(temp, 'consumer');
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packed.filename)], install);
  const cli = path.join(install, 'node_modules', manifest.name, 'dist/cli/index.js');
  assert.equal(run(process.execPath, [cli, '--version'], install).trim(), manifest.version);
  assert.equal(run(path.join(install, 'node_modules/.bin/kith'), ['--version'], install).trim(), manifest.version);
  assert(run(process.execPath, [cli, 'help'], install).includes('Usage:'));
  assert(fs.existsSync(path.join(install, 'node_modules', manifest.name, 'bin/kith-menubar')));
  run('git', ['init', '-q'], install);
  const setupHome = path.join(temp, 'synthetic home');
  fs.mkdirSync(path.join(setupHome, '.claude'), {recursive: true});
  const setupEnv = { ...env, HOME: setupHome };
  execFileSync(process.execPath, [cli, 'setup', install], {cwd: install, env: setupEnv, timeout: 15000});
  const globalConfig = JSON.parse(fs.readFileSync(path.join(setupHome, '.claude.json'), 'utf8')).mcpServers.kith;
  assert.deepEqual(globalConfig.args, [fs.realpathSync(cli), 'mcp']);
  const configured = JSON.parse(fs.readFileSync(path.join(install, '.cursor/mcp.json'), 'utf8')).mcpServers.kith;
  assert.equal(configured.command, process.execPath);
  assert.equal(configured.args[0], fs.realpathSync(cli));
  assert.equal(configured.args[configured.args.length - 1], fs.realpathSync(install));
  assert.equal(run(process.execPath, [cli, 'mutex', '--agent', 'packaged-command', '--', process.execPath, '-e', 'process.stdout.write(process.argv[1])', 'literal ; argument'], install), 'literal ; argument');
  run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { KithEngine, KITH_PROTOCOL_VERSION } from ${JSON.stringify(manifest.name)};
    import { createRequire } from 'node:module';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
    const require = createRequire(import.meta.url);
    assert.throws(() => require.resolve('typescript'), { code: 'MODULE_NOT_FOUND' });
    const engine = new KithEngine(process.cwd());
    try {
      engine.fencing.registerAgent({ id: 'package-smoke' });
      assert(engine.locks.acquireLocks({ agentId: 'package-smoke', patterns: ['src/**'] }).ok);
      engine.fencing.registerAgent({ id: 'package-peer' });
      assert(engine.locks.acquireLocks({ agentId: 'package-peer', patterns: ['shared.json'] }).ok);
      assert.equal((await engine.acquireLocksWhenAvailable({ agentId: 'package-smoke', patterns: ['shared.json'], waitTimeoutMs: 20 })).waitTimedOut, true);
      engine.locks.releaseLocks({ agentId: 'package-peer' });
      assert((await engine.acquireLocksWhenAvailable({ agentId: 'package-smoke', patterns: ['shared.json'], waitTimeoutMs: 100 })).ok);
      const dev = await engine.broker.executeWithPort({ agentId: 'package-smoke', serviceName: 'consumer',
        command: [process.execPath, '-e', 'process.stdout.write(process.env.PORT+":"+process.argv[1])', '{port}'] });
      assert.equal(dev.exitCode, 0); assert.equal(dev.stdout, dev.port+':'+dev.port);
      assert.equal(engine.broker.getResource('port', 'package-smoke:consumer'), null);
    } finally { engine.close(); }
    const client = new Client({ name: 'clean-package-consumer', version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [${JSON.stringify(cli)}, 'mcp', '--repo', process.cwd()], cwd: path.parse(process.cwd()).root, stderr: 'ignore' }));
      const tools = (await client.listTools()).tools;
      assert(tools.some(tool => tool.name === 'kith_preview_integrate'));
      assert(tools.some(tool => tool.name === 'kith_run_dev_server'));
      assert(tools.find(tool => tool.name === 'kith_begin_work').inputSchema.properties.waitTimeoutMs);
      const status = await client.callTool({ name: 'kith_get_status', arguments: {} });
      assert.equal(status.isError, false);
      assert.equal(status.structuredContent.protocolVersion, KITH_PROTOCOL_VERSION);
      assert.equal(status.structuredContent.contractsIncluded, false);
      assert.equal(typeof status.structuredContent.contractCount, 'number');
    } finally { await client.close(); }
  `], install);
  console.log(`Package smoke passed: ${packed.filename}, ${files.length} files; clean consumer install, CLI, supervised worker, library API, and actual MCP discovery/status.`);
} catch (err) {
  if (err.stderr) process.stderr.write(err.stderr);
  throw err;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
