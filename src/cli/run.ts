import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { KithEngine } from '../core/engine.js';
import { formatBrief } from '../core/brief.js';
import { discoverRepository } from '../core/repository.js';

export interface RunWithKithOptions {
  repoRoot?: string;
  agentId?: string;
  title?: string;
  scopeGlobs?: string[];
  worktree?: boolean;
  main?: boolean;
  keepWorktree?: boolean;
  verificationCmd?: string;
  quiet?: boolean;
  command: string[];
}

function isDirty(dir: string): boolean {
  try {
    return execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().length > 0;
  } catch {
    return false;
  }
}

function aheadCount(repoRoot: string, branch: string | null): number {
  if (!branch) return 0;
  try {
    const out = execFileSync('git', ['rev-list', '--count', `HEAD..${branch}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

export async function runWithKith(options: RunWithKithOptions): Promise<number> {
  if (!options.command.length) {
    throw new Error('Expected command after `--`, e.g. kith run -- claude');
  }

  const layout = discoverRepository(options.repoRoot ?? process.cwd());
  const engine = new KithEngine(layout.checkoutRoot);
  const clientName = path.basename(options.command[0]);
  const agentId = options.agentId ?? `run-${clientName.replace(/[^a-zA-Z0-9_-]/g, '-')}-${process.pid}`;
  const scopeGlobs = options.scopeGlobs?.filter(Boolean) ?? [];

  let worktreePath: string | null = null;
  let branch: string | null = null;
  let sessionToken = '';
  let useWorktree = false;

  try {
    const activePeers = engine.fencing.listAgents(false).filter(a => a.id !== agentId);
    useWorktree = Boolean(
      options.worktree ||
      (!options.main && engine.workflowMode() === 'worktrees' && activePeers.length > 0)
    );

    const leaseDurationMs = 120_000;
    const session = engine.fencing.registerAgent({
      id: agentId,
      client: clientName,
      pid: process.pid,
      leaseDurationMs,
    });
    sessionToken = session.sessionToken;

    if (useWorktree || scopeGlobs.length > 0 || options.title) {
      const begun = engine.beginWork({
        agentId,
        title: options.title ?? `${clientName} session`,
        intentSummary: options.title ?? `kith run ${clientName}`,
        scopeGlobs,
        isolateWorktree: useWorktree,
      });
      if (!begun.ok) {
        const msg = begun.notes.join('; ') || 'Scope overlaps another live agent';
        throw new Error(`Could not start Kith session: ${msg}`);
      }
      worktreePath = begun.worktree?.worktreePath ?? null;
      branch = begun.worktree?.branch ?? null;
    }

    if (!options.quiet) {
      const summary = formatBrief(engine.brief({ scopeGlobs }), { quiet: true });
      if (summary) process.stderr.write(`${summary}\n\n`);
      if (worktreePath) {
        process.stderr.write(`[kith] Isolated worktree: ${worktreePath}${branch ? ` (${branch})` : ''}\n`);
      }
    }

    const workDir = worktreePath ?? layout.checkoutRoot;
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      KITH_AGENT_ID: agentId,
      KITH_SESSION_TOKEN: sessionToken,
      ...(worktreePath ? { KITH_WORKTREE: worktreePath } : {}),
    };

    const heartbeatTimer = setInterval(() => {
      try { engine.fencing.heartbeat(agentId); } catch { /* ignore transient loss */ }
    }, 30_000);
    heartbeatTimer.unref();

    const child = spawn(options.command[0], options.command.slice(1), {
      cwd: workDir,
      env: childEnv,
      stdio: 'inherit',
    });

    const onSigInt = () => child.kill('SIGINT');
    const onSigTerm = () => child.kill('SIGTERM');
    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (typeof code === 'number') resolve(code);
        else resolve(signal ? 1 : 0);
      });
    }).finally(() => {
      clearInterval(heartbeatTimer);
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
    });

    // Clean teardown based on actual workspace state
    try {
      engine.fencing.resumeSession(agentId, sessionToken);
      if (worktreePath && fs.existsSync(worktreePath)) {
        const dirty = isDirty(worktreePath);
        const commitsAhead = aheadCount(layout.checkoutRoot, branch);

        if (!dirty && commitsAhead === 0 && !options.keepWorktree) {
          try {
            engine.worktrees.removeWorktree(agentId);
            if (branch && branch.startsWith('kith/')) {
              try {
                execFileSync('git', ['branch', '-D', branch], {
                  cwd: layout.checkoutRoot,
                  stdio: ['ignore', 'ignore', 'ignore'],
                });
              } catch { /* ignore */ }
            }
          } catch { /* Preserves worktree if ignored/untracked files exist inside it. */ }
          engine.completeWork({ agentId });
        } else if (!dirty && commitsAhead > 0 && exitCode === 0 && options.verificationCmd) {
          const merged = engine.completeWork({
            agentId,
            verificationCmd: options.verificationCmd,
          });
          if (!options.quiet) {
            const detail = merged.ok ? '' : ('error' in merged && merged.error ? merged.error : 'verification failed');
            process.stderr.write(
              merged.ok
                ? `[kith] Verified and merged ${branch ?? agentId}.\n`
                : `[kith] Merge halted (${detail}); worktree preserved at ${worktreePath}\n`
            );
          }
          if (!merged.ok) return 1;
        } else {
          engine.handoffs.write({
            agentId,
            kind: exitCode === 0 ? 'progress' : 'blocked',
            summary: `${clientName} exited (${exitCode}) with ${dirty ? 'uncommitted changes' : `${commitsAhead} unmerged commit(s)`} in worktree.`,
            remaining: [
              commitsAhead > 0 && !dirty
                ? `Review or integrate via kith complete --agent ${agentId}`
                : `Commit or inspect changes in ${worktreePath}`,
            ],
          });
          engine.fencing.abandonAgentSession(agentId);
          if (!options.quiet) {
            process.stderr.write(`[kith] Preserved worktree ${worktreePath} and recorded handoff; locks released.\n`);
          }
        }
      } else {
        if (exitCode === 0) {
          engine.completeWork({ agentId });
        } else {
          if (isDirty(layout.checkoutRoot)) {
            engine.handoffs.write({
              agentId,
              kind: 'blocked',
              summary: `${clientName} exited with code ${exitCode} leaving workspace edits.`,
            });
          }
          engine.fencing.abandonAgentSession(agentId);
        }
      }
    } catch { /* Best-effort session cleanup if already closed/abandoned by child. */ }

    return exitCode;
  } finally {
    engine.close();
  }
}
