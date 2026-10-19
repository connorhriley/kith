import { KithEngine } from '../core/engine.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  clearScreen: '\x1b[2J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

export function renderDashboardFrame(engine: KithEngine): string {
  const epoch = engine.coordDb.currentFencingEpoch();
  const agents = engine.fencing.listAgents(true);
  const locks = engine.locks.listLocks();
  const tasks = engine.intents.listTasks();
  const conflicts = engine.shadowGit.listConflicts();
  const contracts = engine.depGraph.listContracts();
  const resources = engine.broker.listResources();
  const quarantined = engine.bashGuard.listQuarantined();
  const events = engine.coordDb.getEventsSince(0, 12).reverse();

  const lines: string[] = [];

  lines.push(
    `${ANSI.bold}${ANSI.cyan}╔══════════════════════════════════════════════════════════════════════════════════════╗${ANSI.reset}`
  );
  lines.push(
    `${ANSI.bold}${ANSI.cyan}║  KITH — ZERO-TRUST PARALLEL AGENT COORDINATOR${ANSI.reset}     ${ANSI.dim}Fencing Epoch: #${epoch} | Agents: ${agents.length}${ANSI.reset}  ${ANSI.bold}${ANSI.cyan}║${ANSI.reset}`
  );
  lines.push(
    `${ANSI.bold}${ANSI.cyan}╚══════════════════════════════════════════════════════════════════════════════════════╝${ANSI.reset}`
  );

  // 1. Active Agents & Intents
  lines.push(`\n${ANSI.bold}▶ ACTIVE AGENTS (${agents.length})${ANSI.reset}`);
  if (agents.length === 0) {
    lines.push(`  ${ANSI.dim}No active agents currently registered.${ANSI.reset}`);
  } else {
    for (const a of agents) {
      const ageSec = Math.max(0, Math.round((Date.now() - a.last_heartbeat_at) / 1000));
      const modeBadge = a.worktree_path
        ? `${ANSI.magenta}[WORKTREE:${a.branch ?? 'isolated'}]${ANSI.reset}`
        : `${ANSI.blue}[SHARED-TREE]${ANSI.reset}`;
      const activeTask = tasks.find(
        (t) => t.owner_agent_id === a.id && t.status === 'active'
      );
      lines.push(
        `  ${ANSI.green}●${ANSI.reset} ${ANSI.bold}${a.id.padEnd(16)}${ANSI.reset} ${a.client.padEnd(12)} PID:${String(a.pid).padEnd(7)} ${modeBadge} ${ANSI.dim}(hb ${ageSec}s ago)${ANSI.reset}`
      );
      if (activeTask) {
        lines.push(
          `    └─ Intent: ${ANSI.yellow}${activeTask.title}${ANSI.reset} ${ANSI.dim}[scope: ${activeTask.scope_globs.join(', ')}]${ANSI.reset}`
        );
      }
    }
  }

  // 2. Live Dirty-Tree & Blast-Radius Conflict Radar
  const hardConflicts = conflicts.filter((c) => c.severity !== 'auto_mergeable');
  const autoMerges = conflicts.filter((c) => c.severity === 'auto_mergeable');
  lines.push(
    `\n${ANSI.bold}▶ LIVE DIRTY-TREE & BLAST-RADIUS RADAR (${
      hardConflicts.length === 0
        ? `${ANSI.green}CLEAN${ANSI.reset}`
        : `${ANSI.red}${hardConflicts.length} CONFLICT(S)${ANSI.reset}`
    })${ANSI.reset}`
  );
  if (hardConflicts.length === 0 && autoMerges.length === 0) {
    lines.push(
      `  ${ANSI.green}✓ Zero dirty-tree or transitive contract conflicts across active agents.${ANSI.reset}`
    );
  } else {
    for (const c of hardConflicts) {
      lines.push(
        `  ${ANSI.red}✗ [${c.severity.toUpperCase()}]${ANSI.reset} ${ANSI.bold}${c.file_path}${ANSI.reset} between ${ANSI.yellow}${c.agent_a}${ANSI.reset} ↔ ${ANSI.yellow}${c.agent_b}${ANSI.reset}: ${c.details.reason}`
      );
    }
    for (const c of autoMerges) {
      lines.push(
        `  ${ANSI.cyan}⊕ [AST AUTO-MERGEABLE]${ANSI.reset} ${c.file_path} (${c.agent_a} + ${c.agent_b}): ${c.details.reason}`
      );
    }
  }

  // 3. Active File/Glob Locks & Port/Mutex Leases
  lines.push(
    `\n${ANSI.bold}▶ FENCING LOCKS (${locks.length}) & BROKER LEASES (${resources.length})${ANSI.reset}`
  );
  if (locks.length === 0 && resources.length === 0) {
    lines.push(`  ${ANSI.dim}No active locks or port/mutex leases.${ANSI.reset}`);
  } else {
    for (const l of locks.slice(0, 8)) {
      lines.push(
        `  🔒 ${ANSI.bold}${l.pattern.padEnd(28)}${ANSI.reset} owner=${ANSI.cyan}${l.owner_agent_id.padEnd(14)}${ANSI.reset} token=#${l.fencing_token} (${l.mode})`
      );
    }
    for (const r of resources) {
      const icon = r.type === 'port' ? '🔌' : '⚙️';
      const qInfo = r.queue.length > 0 ? ` [FIFO queue: ${r.queue.join(', ')}]` : '';
      lines.push(
        `  ${icon} ${r.type.toUpperCase().padEnd(6)} ${ANSI.bold}${r.name.padEnd(21)}${ANSI.reset} value=${ANSI.green}${r.value}${ANSI.reset} owner=${ANSI.cyan}${r.owner_agent_id}${ANSI.reset}${qInfo}`
      );
    }
  }

  // 4. Contract Blackboard & Quarantined Bash Mutations
  lines.push(
    `\n${ANSI.bold}▶ CONTRACT BLACKBOARD (${contracts.length}) & BASH QUARANTINE (${quarantined.length})${ANSI.reset}`
  );
  for (const ctr of contracts.slice(0, 6)) {
    const brk = ctr.is_breaking ? ` ${ANSI.red}[BREAKING v${ctr.version}]${ANSI.reset}` : ` ${ANSI.dim}v${ctr.version}${ANSI.reset}`;
    lines.push(
      `  📜 ${ANSI.bold}${ctr.symbol_name}${ANSI.reset} (${ctr.file_path}): ${ANSI.cyan}${ctr.signature}${ANSI.reset}${brk}`
    );
  }
  for (const q of quarantined.slice(0, 3)) {
    lines.push(
      `  🛡️ ${ANSI.red}[QUARANTINED]${ANSI.reset} Agent '${q.agent_id}' unauthorized bash edit to '${q.file_path}' reverted & saved.`
    );
  }

  // 5. Recent Event Stream
  lines.push(`\n${ANSI.bold}▶ RECENT COORDINATION EVENTS${ANSI.reset}`);
  for (const ev of events.slice(0, 6)) {
    const timeStr = new Date(ev.timestamp).toISOString().slice(11, 19);
    lines.push(
      `  ${ANSI.gray}${timeStr}${ANSI.reset} [${ANSI.cyan}${(ev.agent_id ?? 'sys').padEnd(10)}${ANSI.reset}] ${ev.event_type}`
    );
  }

  return lines.join('\n');
}

export async function runLiveDashboard(
  repoRoot = process.cwd(),
  options?: { once?: boolean; intervalMs?: number }
): Promise<void> {
  const engine = new KithEngine(repoRoot);
  if (options?.once || !process.stdout.isTTY) {
    console.log(renderDashboardFrame(engine));
    engine.close();
    return;
  }

  const intervalMs = options?.intervalMs ?? 600;
  process.stdout.write(ANSI.hideCursor);

  const render = () => {
    const frame = renderDashboardFrame(engine);
    process.stdout.write(
      `${ANSI.clearScreen}${frame}\n\n${ANSI.dim}Controls: [r] Reap dead agents  [q] Quit${ANSI.reset}\n`
    );
  };

  render();
  const timer = setInterval(render, intervalMs);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key: string) => {
      if (key === 'q' || key === '\u0003') {
        clearInterval(timer);
        process.stdout.write(ANSI.showCursor + '\n');
        engine.close();
        process.exit(0);
      } else if (key === 'r') {
        engine.fencing.reapDeadAgents();
        render();
      }
    });
  }
}
