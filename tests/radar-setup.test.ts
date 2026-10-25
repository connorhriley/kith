import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach, beforeEach, expect, it} from 'vitest';
import {startRadar} from '../src/cli/radar.js';

let temp: string;
beforeEach(() => { temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith radar setup '))); });
afterEach(() => fs.rmSync(temp, {recursive: true, force: true}));
function helper(source: string) {
  const cli = path.join(temp, 'runtime/dist/cli/index.js');
  fs.mkdirSync(path.dirname(cli), {recursive: true}); fs.writeFileSync(cli, '');
  const file = path.join(temp, 'runtime/bin/kith-menubar');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `#!${process.execPath}\n${source}`, {mode: 0o700});
  return cli;
}

it.skipIf(process.platform === 'win32')('waits for native readiness and preserves exact paths, including spaces', async () => {
  const cli = helper(`const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(path.join(temp, 'args.json'))}, JSON.stringify(process.argv.slice(2))); process.stdout.write('KITH_RADAR_STARTED\\n');`);
  expect(await startRadar(temp, cli)).toBe('started');
  expect(JSON.parse(fs.readFileSync(path.join(temp, 'args.json'), 'utf8'))).toEqual([temp, process.execPath, cli, '--ready']);
  helper("process.stdout.write('KITH_RADAR_RUNNING\\n');");
  expect(await startRadar(temp, cli)).toBe('running');
});

it.skipIf(process.platform === 'win32')('reports missing, failed and hung helpers without claiming the view opened', async () => {
  await expect(startRadar(temp, path.join(temp, 'missing/dist/cli/index.js'))).rejects.toThrow('missing');
  const cli = helper("process.stderr.write('native startup refused'); process.exit(1);");
  await expect(startRadar(temp, cli)).rejects.toThrow('native startup refused');
  helper("process.stdout.write('unexpected\\n');");
  await expect(startRadar(temp, cli)).rejects.toThrow('invalid startup');
  helper('setInterval(() => {}, 1000);');
  await expect(startRadar(temp, cli, 250)).rejects.toThrow('Timed out');
});

it.skipIf(process.platform !== 'darwin')('setup opens the retained helper, stays idempotent after cache removal, and respects opt-out/dry-run/preflight', () => {
  const transient = path.join(temp, 'transient package'), home = path.join(temp, 'home'), root = path.join(temp, 'project');
  fs.mkdirSync(root); fs.mkdirSync(path.join(home, '.claude'), {recursive: true});
  execFileSync('git', ['init', '-q'], {cwd: root});
  fs.cpSync(path.resolve('dist'), path.join(transient, 'dist'), {recursive: true});
  fs.mkdirSync(path.join(transient, 'bin'));
  fs.writeFileSync(path.join(transient, 'package.json'), '{"name":"kith-coord","type":"module"}');
  const log = path.join(temp, 'launches.jsonl');
  const binary = path.join(transient, 'bin/kith-menubar');
  fs.writeFileSync(binary, `#!${process.execPath}\nconst fs = await import('node:fs'); const log = ${JSON.stringify(log)}; const repeated = fs.existsSync(log); fs.appendFileSync(log, JSON.stringify(process.argv.slice(2))+'\\n'); process.stdout.write(repeated ? 'KITH_RADAR_RUNNING\\n' : 'KITH_RADAR_STARTED\\n');`, {mode: 0o700});
  const config = path.join(home, '.claude.json');
  fs.writeFileSync(config, '{"mcpServers":{"peer":{"command":"keep"}},"permissions":"keep"}');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Team instructions\n');
  fs.writeFileSync(path.join(root, 'unfinished.txt'), 'unfinished work');
  let cli = path.join(transient, 'dist/cli/index.js');
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, 'setup', ...args, root], {env: {...process.env, HOME: home, USERPROFILE: home}, cwd: root, encoding: 'utf8', timeout: 20000});
  expect(run('--dry-run')).toContain('would open'); expect(fs.existsSync(log)).toBe(false);
  expect(run('--no-radar')).not.toContain('Radar: opened'); expect(fs.existsSync(log)).toBe(false);
  const configured = fs.readFileSync(config);
  expect(run()).toContain('Radar: opened'); expect(fs.readFileSync(config)).toEqual(configured);
  const retained = JSON.parse(configured.toString()).mcpServers.kith.args[0];
  const launch = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  expect(launch).toEqual([root, process.execPath, retained, '--ready']);
  fs.rmSync(transient, {recursive: true}); cli = retained;
  expect(run()).toContain('already open'); expect(fs.readFileSync(config)).toEqual(configured);
  expect(JSON.parse(configured.toString()).mcpServers.peer.command).toBe('keep');
  expect(JSON.parse(configured.toString()).permissions).toBe('keep');
  expect(fs.readFileSync(path.join(root, 'unfinished.txt'), 'utf8')).toBe('unfinished work');
  const launches = fs.readFileSync(log);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '<!-- KITH:START --> incomplete');
  expect(() => run()).toThrow(); expect(fs.readFileSync(log)).toEqual(launches); expect(fs.readFileSync(config)).toEqual(configured);
});
