import { KITH_VERSION } from '../version.js';

const BOOLEAN_FLAGS = new Set([
  'worktree', 'wait', 'raw', 'dry-run', 'help', 'version', 'shell', 'new', 'mcp-only',
  'offline', 'once', 'json', 'quiet', 'no-notify', 'no-radar', 'require-session',
  'release', 'all', 'refresh-guidance', 'compact', 'full', 'human', 'no-hooks', 'force',
  'project', 'main', 'keep', 'auto', 'no-autostart', 'live', 'global', 'include-presence', 'conflicts', 'watch',
  'delete-adopted',
]);

export function parseFlags(argv: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
  passthroughCmd: string[];
} {
  const dashDashIdx = argv.indexOf('--');
  const mainArgs = dashDashIdx >= 0 ? argv.slice(0, dashDashIdx) : argv;
  const passthroughCmd = dashDashIdx >= 0 ? argv.slice(dashDashIdx + 1) : [];

  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < mainArgs.length; i++) {
    const arg = mainArgs[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx >= 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = mainArgs[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg === '-m') {
      const next = mainArgs[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags.m = next;
        flags.message = next;
        i++;
      } else {
        flags.m = true;
      }
    } else if (arg.startsWith('-m=')) {
      const val = arg.slice(3);
      flags.m = val;
      flags.message = val;
    } else if (arg === '-w') {
      flags.watch = true;
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags, passthroughCmd };
}

export async function interruptible<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const controller = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  const sigint = () => { interrupted = 'SIGINT'; controller.abort(); };
  const sigterm = () => { interrupted = 'SIGTERM'; controller.abort(); };
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (!interrupted) throw err;
    process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
}

export function printHelp(all = false): void {
  console.log(`Kith (v${KITH_VERSION}) — Local coordination for coding agents

Zero-config safety net for parallel coding agents. Runs locally via MCP and passive hooks.

Usage:
  kith                                        Show status in a terminal (or help when piped)
  kith install [dir]                          Install --compact MCP, global hooks, and macOS autostart
  kith status [-w|--watch]                    Show active agents, locks, conflicts, and tasks
  kith brief [--scope <globs>]                Quick summary for a new session or subagent
  kith commit -m <msg> [files...]             Commit only your recorded/specified files via a temp index
  kith run [--scope <g>] [--worktree] -- <cmd> Launch an agent/command inside a managed worktree session
  kith session clear [<agent-id|session-key>]  Release a stuck auto-session and its conflicts (--conflicts: conflicts only)
  kith gc [--dry-run] [--force]               Clean up merged worktrees, expired locks, and stale data
  kith doctor                                 Check runtime, MCP clients, hooks, and autostart health
  kith uninstall [--dry-run]                  Restore original client configs, hooks, and LaunchAgent

Other setup & diagnostics:
  kith mcp [--compact] [--repo <checkout>]    Start stdio MCP server
  kith init [--only <clients>] [--mode main]  Configure repo-local client files (opt-in)
  kith mode [main|worktrees]                  Show or set whether agents share main or isolate worktrees
  kith recover                                Inspect retained worktrees and handoffs offline
  kith help --all                             Show all low-level coordination & plumbing commands`);

  if (!all) return;
  console.log(`
Low-level coordination & plumbing commands:
  kith setup [checkout] [--no-radar] [--dry-run]         Legacy alias for install with project guidance
  kith watch [checkout] [--once --json]                  Observe worktree file overlaps without locks
  kith menubar [checkout]                                Open read-only macOS menu-bar radar
  kith session start|end --agent <id> --owner-pid <pid>  Manage capability-owned session
  kith heartbeat --agent <id>                            Renew session lease
  kith begin --agent <id> --title <t> --scope <g>        Declare task intent & acquire scope locks
  kith complete --agent <id> [--merge] [--verify <cmd>]  Integrate branch & run verification
  kith task add|claim|done|clear|list                    Manage task queue
  kith lock acquire|release|list                         Manage file/glob locks
  kith contract publish|list                             Manage shared contract signatures
  kith adopt [path]                                      Register an existing linked worktree (Claude Code or any git worktree)
  kith worktree spawn|adopt|forget|remove|list|preview  Manage isolated Git worktrees; remove refuses adopted trees unless --delete-adopted
  kith port --agent <id> --service <name>                Reserve an available local TCP port
  kith dev --agent <id> -- <cmd>                         Run dev command with allocated PORT
  kith mutex --agent <id> --name <m> -- <cmd>            Serialize command execution via mutex
  kith hook session-start|pre|post|pre-commit|stop       Claude/Cursor/Git hook entrypoints
  kith handoff write|list                                Read or write cross-session handoff notes
`);
}
