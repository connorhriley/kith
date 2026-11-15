import path from 'node:path';
import { PassiveConflictWatcher } from '../core/watcher.js';

export async function runWatchCommand(params: {
  targetDir: string;
  flags: Record<string, string | boolean>;
}): Promise<void> {
  const { targetDir, flags } = params;
  const notify = flags.notify !== 'false' && !flags['no-notify'];
  const intervalMs = typeof flags.interval === 'string' ? Number(flags.interval) : 2500;
  const isRaw = Boolean(flags.raw || flags.json);
  let lastScanError = '';
  const watcher = new PassiveConflictWatcher(targetDir, {
    intervalMs,
    notify: !isRaw && notify,
    includeExternalPresence: Boolean(flags['include-presence']),
    onScanError: (errors) => {
      const message = errors.map(error => `${error.repository}: ${error.message}`).join('\n');
      if (!flags.once && message !== lastScanError) {
        console.error(`Scan unavailable; retained overlaps may be stale:\n${message}`);
      }
      lastScanError = message;
    },
    onCollision: (alert) => {
      if (!isRaw && !flags.once) {
        console.log(`\n⚠️ [WORKTREE OVERLAP] ${alert.message}`);
      }
    },
    onFileChange: (e) => {
      if (!flags.quiet && !isRaw && !flags.once) {
        console.log(`📝 [FILE MTIME] ${path.basename(e.repoPath)}/${e.filePath}`);
      }
    },
  });

  if (flags.once) {
    const alerts = await watcher.scanOnce();
    const state = watcher.getScanState();
    const repos = state.repos;
    const edits = watcher.getRecentEdits();
    if (!state.complete) process.exitCode = 1;

    if (flags.raw || flags.json) {
      console.log(JSON.stringify({ ...state, recentEdits: edits, collisions: alerts }, null, 2));
      return;
    }

    console.log(`\n📡 Kith Passive Radar: ${targetDir}`);
    console.log(`   Repositories (${repos.length}): ${repos.map(r => path.basename(r)).join(', ')}`);
    console.log(`   Recent Modified Files: ${edits.length}`);
    for (const row of state.worktrees) {
      const activity = {
        active: 'Active Kith lease',
        retained: 'Retained',
        unregistered: 'No Kith session',
        unknown: 'Ownership unavailable',
      }[row.activity];
      console.log(`   ${row.label} — ${activity}; ${row.dirtyFiles ?? 'unknown'} Git changes; ${row.sharedDirtyPaths} shared dirty paths`);
      console.log(`      ${row.path}${row.agentIds.length ? ` (${row.agentIds.join(', ')})` : ''}\n      ${row.detail}`);
    }

    if (!state.complete) {
      console.error(`Scan unavailable:\n${state.errors.map(error => error.message).join('\n')}`);
    } else if (alerts.length === 0) {
      console.log('\nNo differing or unverified shared dirty paths observed. Identical copies are excluded; compatibility is not verified.\n');
    } else {
      console.log(`\n  ⚠️  Review before integration: ${alerts.length} shared dirty paths:`);
      for (const a of alerts) {
        console.log(`   ⚠️ ${a.message}`);
      }
      console.log('');
    }
    return;
  }

  console.log(`\n👀 Kith Passive Conflict Radar watching: ${targetDir}`);
  console.log(`   Read-only overlap observations; this does not identify agents or verify compatibility. Press Ctrl+C to stop.\n`);
  watcher.start();
  await new Promise(() => {});
}
