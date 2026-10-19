// Opt-in: invokes installed authenticated clients and consumes model usage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { KithEngine } from '../dist/index.js';
const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const flags = process.argv.slice(2);
const option = (name, fallback) => { const i = flags.indexOf(name); return i < 0 ? fallback : flags[i + 1]; };
const client = option('--client', 'codex'), scenario = option('--scenario', 'all');
assert.ok(['codex', 'claude'].includes(client) && ['all', 'isolated', 'shared', ...(client === 'claude' ? ['hook-failure'] : [])].includes(scenario), 'Use --client codex|claude [--scenario all|isolated|shared|hook-failure] [--output report.json]');
const report = { client, version: '', platform: process.platform, node: process.version, scenarios: [], passed: false };
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-native-'))), bin = path.join(base, 'bin'); fs.mkdirSync(bin);
const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
fs.writeFileSync(path.join(bin, 'kith'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o755 });
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
for (const name of Object.keys(env)) if (name.startsWith('KITH_')) delete env[name];
async function run(args, cwd, childEnv) {
  const child = spawn(client, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = '', bytes = 0, timedOut = false, overflow = false;
  const signal = (s) => { try { process.kill(-child.pid, s); } catch {} };
  const timer = setTimeout(() => { timedOut = true; signal('SIGTERM'); }, 180000);
  const force = setTimeout(() => signal('SIGKILL'), 185000);
  const capture = (chunk, keep) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) { overflow = true; signal('SIGTERM'); } else if (keep) stdout += chunk; };
  child.stdout.on('data', (x) => capture(x, true)); child.stderr.on('data', (x) => capture(x, false));
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(timedOut, false, 'Client exceeded 180 seconds'); assert.equal(overflow, false, 'Client exceeded output limit');
    assert.equal(code, 0, 'Client exited unsuccessfully; check login, permissions and service access');
    return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } finally { clearTimeout(timer); clearTimeout(force); signal('SIGTERM'); }
}
try {
  report.version = execFileSync(client, ['--version'], { env, encoding: 'utf8', timeout: 10000 }).trim();
  for (const mode of scenario === 'all' ? ['isolated', 'shared', ...(client === 'claude' ? ['hook-failure'] : [])] : [scenario]) {
    const root = path.join(base, `${mode} repository ' spaces`); fs.mkdirSync(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q'); git('config', 'user.name', 'Kith Compatibility'); git('config', 'user.email', 'test@example.test');
    fs.mkdirSync(path.join(root, 'src')); const protectedBytes = 'export const unchanged = true;\n';
    fs.writeFileSync(path.join(root, 'src/blocked.mjs'), protectedBytes);
    fs.writeFileSync(path.join(root, '.gitignore'), '.coord/\n.codex/\n.claude/\n.mcp.json\n');
    git('add', '.'); git('commit', '-qm', 'Native fixture');
    execFileSync(process.execPath, [cli, '--repo', root, 'init', '--only', client], { env, stdio: 'pipe' });
    const initialHead = git('rev-parse', 'HEAD'), engine = new KithEngine(root);
    const result = { scenario: mode, passed: false }; report.scenarios.push(result);
    try {
      engine.fencing.registerAgent({ id: 'peer' });
      assert.equal(engine.intents.declareIntent({ agentId: 'peer', title: 'Preserve shared API', scopeGlobs: ['src/blocked.mjs'] }).ok, true);
      const agentId = `native-${client}`, childEnv = { ...env }, borrowed = mode === 'shared' || client === 'claude';
      if (borrowed) { const session = engine.fencing.registerAgent({ id: agentId }); childEnv.KITH_AGENT_ID = agentId; childEnv.KITH_SESSION_TOKEN = session.sessionToken; }
      if (mode === 'hook-failure') {
        const settingsFile = path.join(root, '.claude/settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        settings.hooks.PreToolUse[0].hooks[0].command = quote(path.join(base, 'intentionally-missing-guard'));
        fs.writeFileSync(settingsFile, JSON.stringify(settings));
        const marker = path.join(root, 'marker.txt');
        const prompt = `Bounded hook failure test. Use native Write exactly once to create ${marker} containing test. A deliberately unavailable Kith guard must block it. Do not retry, repair hooks, use shell, MCP or subagents. Report the denial and stop.`;
        const events = await run(['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'project',
          '--strict-mcp-config', '--mcp-config', path.join(root, '.mcp.json'), '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
          '--allowedTools', 'Write', '--max-budget-usd', '1', prompt], root, childEnv);
        const writes = events.flatMap((e) => e.type === 'assistant' ? e.message?.content ?? [] : []).filter((b) => b.type === 'tool_use' && b.name === 'Write');
        assert.equal(writes.length, 1, 'Expected exactly one native Write probe');
        const denied = events.flatMap((e) => e.type === 'user' ? e.message?.content ?? [] : []).find((b) => b.type === 'tool_result' && b.tool_use_id === writes[0].id);
        assert.equal(denied?.is_error, true, 'Missing pre-hook did not deny native Write');
        assert.equal(fs.existsSync(marker), false, 'Missing guard allowed a write');
        result.passed = true; result.checks = ['native Write attempted once', 'tool denied', 'marker absent'];
        console.log(`${client} ${mode}: passed`);
        continue;
      }
      const hookProbe = client === 'claude' ? ` After the expected MCP conflict, also test native hook enforcement: Read ${path.join(root, 'src/blocked.mjs')}, then attempt exactly one native Edit of that file replacing true with false. Its PreToolUse hook must deny the edit. Continue only after that denial; never retry or bypass it.` : '';
      const prompt = `Run this bounded compatibility test in this disposable Git repository. Do not use subagents or unrelated tools. Never print session tokens. Call the kith MCP tools directly. First call kith_begin_work with agentId ${agentId}, title Native conflict probe, scopeGlobs [src/blocked.mjs]. Expect a lock conflict.${hookProbe} Never change that file successfully. Then call kith_begin_work with the SAME agentId, title Add native compatibility module, scopeGlobs [src/native.mjs], isolateWorktree true. Use your native editing tool to create src/native.mjs IN THE RETURNED WORKTREE with exactly: export const nativeCompatibility = 42; followed by a newline. Call kith_record_file_edit with that absolute file path. Then call kith_complete_work with verificationCmd node --check src/native.mjs. Finally call kith_get_status without agentId. Stop on unexpected failure; never bypass coordination or substitute shell calls for MCP. End with a brief result.`;
      const generated = client === 'codex' ? parseToml(fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8')).mcp_servers.kith : undefined;
      // Project trust is persisted by the client outside this fixture. Pass generated values
      // explicitly for this invocation so the runner never edits global trust/configuration.
      const configArgs = generated ? Object.entries(generated).flatMap(([key, value]) => ['-c', `mcp_servers.kith.${key}=${JSON.stringify(value)}`]) : [];
      const args = client === 'codex'
        ? ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json', '--color', 'never', '-s', 'workspace-write', '-C', root,
            ...configArgs, '-c', 'mcp_servers.kith.required=true', '-c', 'mcp_servers.kith.default_tools_approval_mode="approve"', prompt]
        : ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--no-session-persistence', '--setting-sources', 'project',
            '--strict-mcp-config', '--mcp-config', path.join(root, '.mcp.json'), '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
            '--allowedTools', 'mcp__kith,Read,Write,Edit', '--max-budget-usd', '2', prompt];
      const events = await run(args, root, childEnv);
      const calls = client === 'codex'
        ? events.filter((e) => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call' && e.item.server === 'kith').map((e) => e.item.tool)
        : events.flatMap((e) => e.type === 'assistant' ? e.message?.content ?? [] : []).filter((b) => b.type === 'tool_use' && b.name.startsWith('mcp__kith__')).map((b) => b.name.slice('mcp__kith__'.length));
      result.tools = calls;
      if (client === 'claude') {
        const native = events.flatMap((e) => e.type === 'assistant' ? e.message?.content ?? [] : []).filter((b) => b.type === 'tool_use');
        const attempt = native.find((b) => b.name === 'Edit' && b.input?.file_path === path.join(root, 'src/blocked.mjs'));
        assert.ok(attempt, 'Missing native denied-edit probe');
        const denied = events.flatMap((e) => e.type === 'user' ? e.message?.content ?? [] : []).find((b) => b.type === 'tool_result' && b.tool_use_id === attempt.id);
        assert.equal(denied?.is_error, true, 'Hook did not deny the native peer-file edit');
        assert.ok(native.some((b) => ['Write', 'Edit'].includes(b.name) && b.input?.file_path?.endsWith('/src/native.mjs')), 'Missing native editor event');
        result.hookDenialVerified = true;
      }
      for (const name of ['kith_record_file_edit', 'kith_complete_work', 'kith_get_status']) assert.ok(calls.includes(name), `Missing ${name}; client exit zero is insufficient`);
      assert.ok(calls.filter((n) => n === 'kith_begin_work').length >= 2, 'Missing conflict probe and subsequent begin');
      if (client === 'codex') {
        const begin = events.find((e) => e.type === 'item.completed' && e.item?.tool === 'kith_begin_work');
        assert.equal(begin.item.result?.structured_content?.ok, false, 'Missing real lock conflict');
        assert.ok(events.some((e) => e.type === 'item.completed' && e.item?.type === 'file_change' && e.item.status === 'completed'), 'Missing native edit');
      }
      assert.equal(fs.readFileSync(path.join(root, 'src/blocked.mjs'), 'utf8'), protectedBytes, 'Peer file changed');
      assert.equal(fs.readFileSync(path.join(root, 'src/native.mjs'), 'utf8'), 'export const nativeCompatibility = 42;\n', 'Incorrect integrated bytes');
      assert.notEqual(git('rev-parse', 'HEAD'), initialHead, 'Worktree not integrated');
      assert.ok(engine.intents.listTasks().some((t) => t.owner_agent_id === agentId && t.status === 'done'), 'Task not completed');
      assert.ok(engine.depGraph.listContracts().some((c) => c.symbol_name === 'nativeCompatibility'), 'Contract missing');
      assert.ok(engine.mergeTrain.listQueue().some((m) => m.agent_id === agentId && m.status === 'merged' && m.verification_cmd === 'node --check src/native.mjs' && m.diagnostics_output.includes('Verification passed')), 'Verified integration missing');
      assert.ok(engine.locks.listLocks().every((l) => l.owner_agent_id === 'peer'), 'Client left locks behind');
      if (borrowed) assert.equal(engine.fencing.getAgent(agentId).pid, process.pid, 'Inherited owner changed');
      result.passed = true; result.checks = ['protected bytes unchanged', 'native edit', 'contract recorded', 'verified integration', 'task completed', 'locks released', ...(borrowed ? ['inherited owner preserved'] : [])];
      console.log(`${client} ${mode}: passed`);
    } catch (error) {
      // Only authored assertion messages; raw MCP transcripts contain bearer capabilities.
      result.error = error?.code === 'ERR_ASSERTION' ? String(error.message).split('\n')[0] : 'Client failed or expected state missing; check login and client configuration.';
      throw error;
    } finally { engine.close(); }
  }
  report.passed = true;
} catch { process.exitCode = 1; }
finally {
  const output = option('--output');
  if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2)); fs.rmSync(base, { recursive: true, force: true });
}
