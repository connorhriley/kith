// A detached process-group leader. The command cannot start until its supervisor
// has durably recorded this group and sent the start message over private IPC.
import os from 'node:os';
import { spawn } from 'node:child_process';

let started = false;
process.on('disconnect', () => {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
});
process.once('message', (message: { command: string | string[]; cwd: string; mutexName: string; env?: Record<string, string> }) => {
  if (started) return;
  started = true;
  let finished = false;
  const env = { ...process.env, ...message.env, ...(message.mutexName === 'package-install' ? { KITH_PACKAGE_INSTALL_GUARDED: '1' } : {}) };
  const child = Array.isArray(message.command)
    ? spawn(message.command[0], message.command.slice(1), { cwd: message.cwd, env, stdio: ['ignore', 'inherit', 'inherit'] })
    : spawn(message.command, { cwd: message.cwd, env, stdio: ['ignore', 'inherit', 'inherit'], shell: true });
  child.once('error', (err) => {
    if (finished) return;
    finished = true;
    process.send?.({ error: err.message }, () => process.exit(1));
  });
  child.once('close', (code, signal) => {
    if (finished) return;
    finished = true;
    if (process.connected) process.send?.({ exitCode: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1), signal }, () => process.exit(0));
  });
});
process.send?.({ ready: true });
