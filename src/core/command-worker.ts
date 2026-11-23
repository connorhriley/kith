// A detached process-group leader. The command cannot start until its supervisor
// has durably recorded this group and sent the start message over private IPC.
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

let started = false;
let shuttingDown = false;
let child: ChildProcess | undefined;
let hello: ReturnType<typeof setInterval> | undefined;

// Detaching into a new session can deliver SIGHUP on macOS. The supervisor
// stops this process with SIGTERM or by closing IPC, not with a hangup.
process.on('SIGHUP', () => {});

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (hello) clearInterval(hello);
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    if (!started) process.exit(1);
    return;
  }
  // Kill the direct child, not this process group. SIGKILL of the group would
  // kill us before we can reap, and macOS then reports the child as alive
  // until launchd collects the zombie. A failed kill means the child has
  // already exited; its close handler reaps it and exits this process.
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', () => {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
});

// Repeat ready until the parent sends the command. A single IPC message can be
// dropped when its length header is split across reads (Node 22.13) or when it
// arrives before the parent is listening.
hello = setInterval(() => {
  if (started || !process.connected) { clearInterval(hello); return; }
  process.send?.({ ready: true });
}, 50);

process.once('message', (message: { command: string | string[]; cwd: string; mutexName: string; env?: Record<string, string> }) => {
  clearInterval(hello);
  if (started || shuttingDown) return;
  started = true;
  let finished = false;
  const env = { ...process.env, ...message.env, ...(message.mutexName === 'package-install' ? { KITH_PACKAGE_INSTALL_GUARDED: '1' } : {}) };
  child = Array.isArray(message.command)
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
    else process.exit(code === 0 ? 0 : 1);
  });
});
process.send?.({ ready: true });
