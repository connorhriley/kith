import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kith-package-'));
const env = { ...process.env, npm_config_cache: path.join(temp, 'npm-cache') };
const run = (cmd, args, cwd) => execFileSync(cmd, args, {
  cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
});
try {
  const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root));
  const files = packed.files.map((file) => file.path);
  assert(files.includes('LICENSE'));
  assert(files.includes('dist/index.d.ts'));
  assert(files.includes('dist/command-worker.js'));
  assert(!files.some((file) => file.startsWith('.coord/') || file.startsWith('node_modules/')));
  const install = path.join(temp, 'consumer');
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packed.filename)], install);
  const cli = path.join(install, 'node_modules/kith/dist/cli/index.js');
  assert.equal(run(process.execPath, [cli, '--version'], install).trim(), '1.0.0');
  assert(run(process.execPath, [cli, 'help'], install).includes('Usage:'));
  assert.equal(run(process.execPath, [cli, 'mutex', '--agent', 'packaged-command', '--', process.execPath, '-e', 'process.stdout.write(process.argv[1])', 'literal ; argument'], install), 'literal ; argument');
  run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { AstAnalyzer, KithEngine } from 'kith';
    const merged = AstAnalyzer.checkAdditiveMergeability('module.ts', '', 'export function one() {}\\n', 'export function two() {}\\n');
    assert.equal(merged.autoMergeable, true);
    assert(merged.mergedContent.includes('function two'));
    const engine = new KithEngine(process.cwd());
    try {
      engine.fencing.registerAgent({ id: 'package-smoke' });
      assert(engine.locks.acquireLocks({ agentId: 'package-smoke', patterns: ['src/**'] }).ok);
    } finally { engine.close(); }
  `], install);
  console.log(`Package smoke passed: ${packed.filename}, ${files.length} files; clean consumer install, CLI, supervised worker, and library API.`);
} catch (err) {
  if (err.stderr) process.stderr.write(err.stderr);
  throw err;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
