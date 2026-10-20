import { execFileSync, spawnSync } from 'node:child_process';
import type { AgentRecord } from './fencing.js';
import { discoverRepository, physicalPath } from './repository.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore','pipe','pipe'], timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  });
}
export interface WorktreeChange { status: string; path: string; originalPath?: string }
export function worktreeChanges(cwd: string): WorktreeChange[] {
  const records = git(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0');
  const changes: WorktreeChange[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (!record) continue;
    const change: WorktreeChange = { status: record.slice(0,2), path: record.slice(3) };
    if (/[RC]/.test(change.status)) change.originalPath = records[++i];
    changes.push(change);
  }
  return changes;
}
export interface WorkspaceObservation {
  agentId: string; path: string; recordedBranch: string | null; status: AgentRecord['status'];
  leaseExpired: boolean; lastHeartbeatAt: number; available: boolean; error?: string;
  branch: string | null; head: string | null; comparisonBase: string | null;
  dirtyFiles: WorktreeChange[]; lastCommitAt: number | null; hoursSinceLastCommit: number | null;
  ahead: number | null; behind: number | null; overlaps: Array<{ path: string; agentIds: string[] }>;
}
/** Git observation never stages files, checks out branches, fetches, or refreshes the index. */
export function observeWorkspaces(repoRoot: string, agents: AgentRecord[], now = Date.now()): WorkspaceObservation[] {
  let base: string | null = null;
  try { base = git(repoRoot, 'rev-parse', '--verify', 'HEAD').trim(); } catch { /* Non-Git or unborn checkout. */ }
  const workspaces = agents.filter(a => a.worktree_path || a.status === 'active').map(a => {
    const result: WorkspaceObservation = { agentId: a.id, path: a.worktree_path ?? repoRoot, recordedBranch: a.branch, status: a.status,
      leaseExpired: a.lease_expires_at <= now, lastHeartbeatAt: a.last_heartbeat_at, available: false,
      branch: null, head: null, comparisonBase: base, dirtyFiles: [], lastCommitAt: null, hoursSinceLastCommit: null, ahead: null, behind: null, overlaps: [] };
    try {
      if (discoverRepository(result.path).commonGitDir !== discoverRepository(repoRoot).commonGitDir) throw new Error('Workspace belongs to another repository');
      result.dirtyFiles = worktreeChanges(result.path);
      result.head = git(result.path, 'rev-parse', '--verify', 'HEAD').trim();
      result.branch = git(result.path, 'branch', '--show-current').trim() || null;
      result.lastCommitAt = Number(git(result.path, 'show', '-s', '--format=%ct', 'HEAD').trim()) * 1000;
      result.hoursSinceLastCommit = Math.max(0, now - result.lastCommitAt) / 3_600_000;
      if (base) {
        const [behind, ahead] = git(result.path, 'rev-list', '--left-right', '--count', `${base}...${result.head}`).trim().split(/\s+/).map(Number);
        result.ahead = ahead; result.behind = behind;
      }
      result.available = true;
    } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
    return result;
  });
  for (const workspace of workspaces) {
    if (!workspace.available) continue;
    const files = new Set(workspace.dirtyFiles.flatMap(c => [c.path, ...(c.originalPath ? [c.originalPath] : [])]));
    for (const file of files) {
      const peers = workspaces.filter(peer => peer.agentId !== workspace.agentId && peer.status === 'active' && peer.available
        && peer.dirtyFiles.some(c => c.path === file || c.originalPath === file)).map(peer => peer.agentId);
      if (peers.length) workspace.overlaps.push({ path: file, agentIds: peers });
    }
  }
  return workspaces;
}

/** Preview committed inputs only. merge-tree may write unreachable Git objects, never worktree/index/database contents. */
export function previewIntegration(repoRoot: string, agent: AgentRecord) {
  if (!agent.worktree_path || !agent.branch) throw new Error('Integration preview requires a registered worktree and branch');
  const source = discoverRepository(agent.worktree_path), target = discoverRepository(repoRoot);
  if (source.checkoutRoot !== physicalPath(agent.worktree_path) || source.commonGitDir !== target.commonGitDir
    || git(agent.worktree_path, 'branch', '--show-current').trim() !== agent.branch.replace(/^refs\/heads\//,'')) {
    throw new Error('Registered source checkout repository or branch does not match');
  }
  const sourceHead = git(agent.worktree_path, 'rev-parse', '--verify', 'HEAD').trim();
  const targetHead = git(repoRoot, 'rev-parse', '--verify', 'HEAD').trim();
  const dirtyFiles = worktreeChanges(agent.worktree_path);
  const targetDirtyFiles = worktreeChanges(repoRoot).filter(change => !(change.status === '??' && target.coordDir === target.checkoutRoot + '/.coord' && change.path.startsWith('.coord/')));
  const sourceBranch=git(agent.worktree_path,'branch','--show-current').trim(), targetBranch=git(repoRoot,'branch','--show-current').trim();
  if(!targetBranch) throw new Error('Integration target must be on a branch');
  if(targetDirtyFiles.length) return {ok:false,clean:null,sourceHead,targetHead,sourceBranch,targetBranch,conflicts:[],dirtyFiles,targetDirtyFiles,reason:'Integration target has local changes. Preserve or commit them before preview.'};
  if (dirtyFiles.length) return { ok: false, clean: null, sourceHead, targetHead, sourceBranch, targetBranch, conflicts: [], dirtyFiles, targetDirtyFiles,
    reason: 'Commit or preserve source changes before preview. Uncommitted edits are not included in a committed-tree preview.' };
  const drivers = spawnSync('git', ['config', '--get-regexp', '^merge\\..*\\.driver$'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  });
  if (drivers.error || drivers.status !== 0 && drivers.status !== 1) throw new Error('Cannot inspect merge-driver configuration safely');
  if (drivers.status === 0) throw new Error('Integration preview is unavailable with configured custom merge drivers; they can execute commands');
  const probe = spawnSync('git', ['merge-tree', '--write-tree', '-z', targetHead, sourceHead], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (probe.error || probe.status !== 0 && probe.status !== 1) throw new Error(`Git integration preview failed: ${probe.error?.message ?? probe.stderr}`);
  // Conflict stages precede the empty record separating informational messages.
  const stages = probe.stdout.split('\0').slice(1);
  const boundary = stages.indexOf('');
  const conflicts = [...new Set(stages.slice(0, boundary < 0 ? stages.length : boundary).flatMap(record => {
    const match = /^\d{6} [0-9a-f]+ [123]\t([\s\S]+)$/.exec(record); return match ? [match[1]] : [];
  }))];
  if (probe.status === 1 && !conflicts.length) throw new Error('Git returned a conflict without identifiable paths; preview is unavailable');
  if (git(repoRoot,'rev-parse','HEAD').trim() !== targetHead || git(agent.worktree_path,'rev-parse','HEAD').trim() !== sourceHead
    || git(repoRoot,'branch','--show-current').trim() !== targetBranch
    || git(agent.worktree_path,'branch','--show-current').trim() !== sourceBranch
    || worktreeChanges(repoRoot).some(change => !(change.status === '??' && target.coordDir === target.checkoutRoot + '/.coord' && change.path.startsWith('.coord/')))
    || worktreeChanges(agent.worktree_path).length) throw new Error('Source or target changed during preview; retry');
  return { ok: true, clean: probe.status === 0, sourceHead, targetHead, sourceBranch, targetBranch, conflicts, dirtyFiles, targetDirtyFiles, verified: false };
}

