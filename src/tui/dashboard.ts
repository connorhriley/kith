import { readDashboardSnapshot, type DashboardSnapshot } from './snapshot.js';

// Names and paths recorded by clients must not become terminal control sequences.
function text(value: unknown): string {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).slice(0, 240);
}
function expiry(expiresAt: number, now: number): string {
  return expiresAt > now ? `expires in ${Math.ceil((expiresAt - now) / 1000)}s` : 'expired';
}
function limited<T>(rows: T[], lines: string[], render: (row: T) => void): void {
  rows.slice(0, 12).forEach(render);
  if (rows.length > 12) lines.push(`  + ${rows.length - 12} more records`);
}

export function renderDashboardFrame(snapshot: DashboardSnapshot): string {
  const now = snapshot.observedAt;
  const lines = ['KITH — PARALLEL AGENT COORDINATOR',
    `Read-only · ${new Date(now).toISOString()} · epoch #${snapshot.epoch}`,
    `Checkout: ${text(snapshot.layout.checkoutRoot)}`, `Shared state: ${text(snapshot.layout.coordDir)}`];
  if (snapshot.state !== 'ready') {
    lines.push(snapshot.state === 'missing' ? '\nNo coordination database. Preview setup with kith init --dry-run.' : `\nState unavailable: ${text(snapshot.error)}`);
    return lines.join('\n');
  }
  const active = snapshot.agents.filter(a => a.status === 'active');
  lines.push(`\nSESSIONS (${active.length} recorded active; process liveness not checked)`);
  limited(active, lines, agent => {
    const task = snapshot.tasks.find(t => t.owner_agent_id === agent.id && t.status === 'active');
    lines.push(`  ${text(agent.id)} · ${text(agent.client)} · ${expiry(agent.lease_expires_at, now)}`);
    if (task) lines.push(`    ${text(task.title)} [${text(task.scope.join(', '))}]`);
  });
  const worktrees = snapshot.agents.filter(a => a.worktree_path);
  lines.push(`\nREGISTERED WORKTREES (${worktrees.length}; Git contents not inspected)`);
  limited(worktrees, lines, agent => {
    const integration = snapshot.integrations.find(m => m.agent_id === agent.id);
    lines.push(`  ${text(agent.id)} · ${text(agent.status)} · ${text(agent.branch ?? '(branch unrecorded)')}${integration ? ` · integration ${text(integration.status)}` : ''}`);
    lines.push(`    ${text(agent.worktree_path)}`);
  });
  const names = [...new Set([...snapshot.resources.filter(r => r.type === 'mutex').map(r => r.name), ...snapshot.waiters.map(w => w.mutex_name), ...snapshot.guards.map(g => g.mutex_name)])].sort();
  lines.push(`\nMUTEXES & FIFO TICKETS (${names.length}; recorded order, stale records retained)`);
  limited(names, lines, name => {
    const lease = snapshot.resources.find(r => r.type === 'mutex' && r.name === name);
    const guard = snapshot.guards.find(g => g.mutex_name === name);
    lines.push(`  ${text(name)} · ${lease ? `${text(lease.owner_agent_id)} (${expiry(lease.expires_at, now)})` : 'no lease recorded'}`);
    if (guard) lines.push(`    Command guard: ${text(guard.owner_agent_id)} · supervisor ${guard.supervisor_pid} · worker ${guard.worker_pid ?? 'unrecorded'} (shutdown not confirmed)`);
    limited(snapshot.waiters.filter(w => w.mutex_name === name), lines, waiter => {
      lines.push(`    ticket #${waiter.ticket} · ${text(waiter.owner_agent_id)} · ${expiry(waiter.expires_at, now)}`);
    });
  });
  lines.push(`\nSCOPES (${snapshot.locks.length} records) & PORTS`);
  limited(snapshot.locks, lines, lock => lines.push(`  ${text(lock.pattern)} · ${text(lock.owner_agent_id)} · ${text(lock.mode)} · ${expiry(lock.expires_at, now)}`));
  limited(snapshot.resources.filter(r => r.type === 'port'), lines, port => lines.push(`  ${text(port.name)} · port ${text(port.value)} · ${text(port.owner_agent_id)} · ${expiry(port.expires_at, now)}`));
  lines.push(`\nRECORDED CONFLICTS (${snapshot.conflicts.length})`);
  if (!snapshot.conflicts.length) lines.push('  None recorded.');
  limited(snapshot.conflicts, lines, conflict => lines.push(`  ${text(conflict.severity)} · ${text(conflict.file_path)} · ${text(conflict.agent_a)} / ${text(conflict.agent_b)}`));
  lines.push('\nRECOVERY COPIES (latest; workspace restoration is not recorded)');
  for (const entry of snapshot.recovery) {
    lines.push(`  ${text(entry.agent_id)} · ${text(entry.file_path)} · copy: ${text(entry.patch_path)}`);
  }
  lines.push('\nRECENT COORDINATION EVENTS (newest first, UTC)');
  for (const event of snapshot.events) lines.push(`  #${event.id} ${new Date(event.timestamp).toISOString().slice(11, 19)} · ${text(event.agent_id ?? 'system')} · ${text(event.event_type)}`);
  return lines.join('\n');
}

export async function runLiveDashboard(repoRoot = process.cwd(), options?: { once?: boolean; intervalMs?: number }): Promise<void> {
  const frame = () => renderDashboardFrame(readDashboardSnapshot(repoRoot));
  if (options?.once || !process.stdout.isTTY || !process.stdin.isTTY) { console.log(frame()); return; }
  const wasRaw = process.stdin.isRaw, wasPaused = process.stdin.isPaused();
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const render = () => {
    try { process.stdout.write(`\x1b[2J\x1b[H${frame()}\n\nRead-only controls: [r] Refresh  [q] Quit\n`); }
    catch (error) { process.stdout.write(`\nObservation unavailable: ${text(error instanceof Error ? error.message : error)}\n`); }
  };
  const interrupt = () => { process.exitCode = 130; finish(); };
  const terminate = () => { process.exitCode = 143; finish(); };
  const key = (value: string) => { if (value === 'q') finish(); else if (value === '\u0003') interrupt(); else if (value === 'r') render(); };
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
  process.stdin.on('data', key); process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  process.stdout.write('\x1b[?25l');
  const timer = setInterval(render, options?.intervalMs ?? 1000);
  try { render(); await finished; }
  finally {
    clearInterval(timer); process.stdin.off('data', key); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    process.stdin.setRawMode(wasRaw); if (wasPaused) process.stdin.pause(); process.stdout.write('\x1b[?25h\n');
  }
}
