import type {readCoordinationState} from './observation.js';

type State = ReturnType<typeof readCoordinationState>;
export interface CoordinationView {
  available: boolean;
  working: {agentId: string; client: string; title: string; taskId: string; checkout: string; scopes: string[]}[];
  queued?: {taskId: string; title: string; priority: number; dependsOn: string[]; scopes: string[]}[];
  sessions: number;
  sessionKeys: string[];
  waiting: {agentId: string; resource: string; holder: string | null; position: number}[];
  using: {agentId: string; resource: string; detail: string}[];
  attention: {message: string; nextStep: string}[];
}

/** A presentation of current recorded coordination, never inferred file writers or a safety verdict. */
export function coordinationView(state: State): CoordinationView {
  const result: CoordinationView = {available: state.state !== 'unavailable' && !state.truncated,
    working: [], queued: [], sessions: 0, sessionKeys: [], waiting: [], using: [], attention: []};
  if (!result.available) {
    result.attention.push({message: 'Coordination status unavailable', nextStep: 'Inspect kith status --offline; preserve saved work before recovery.'});
    return result;
  }
  const active = state.agents.filter(a => a.status === 'active' && a.lease_expires_at > state.observedAt);
  const current = (id: unknown, token: unknown) => {
    const a = active.find(a => a.id === id), epoch = state.sessionEpochs[String(id)];
    return a && epoch !== undefined && Number(token) >= epoch ? a : undefined;
  };
  result.sessions = active.length;
  result.sessionKeys = active.map(a=>JSON.stringify([state.repository.commonGitDir,a.id]));
  for (const task of state.tasks as Record<string, unknown>[]) {
    if (task.status === 'queued') {
      result.queued!.push({
        taskId: String(task.id),
        title: String(task.title),
        priority: Number(task.priority ?? 10),
        dependsOn: Array.isArray(task.depends_on) ? task.depends_on.map(String) : [],
        scopes: Array.isArray(task.scope_globs) ? task.scope_globs.map(String) : [],
      });
      continue;
    }
    const a = current(task.owner_agent_id, task.fencing_token);
    if (!a || task.status !== 'active') continue;
    const locks = state.locks.filter(l => (l.task_id === task.id || l.task_id === null) && l.owner_agent_id === a.id &&
      Number(l.expires_at) > state.observedAt && Number(l.fencing_token) >= state.sessionEpochs[a.id]);
    result.working.push({agentId: a.id, client: a.client, title: String(task.title), taskId: String(task.id),
      checkout: a.worktree_path ?? state.repository.root, scopes: locks.map(l => String(l.pattern))});
  }
  const resources = state.resources.filter(r => Number(r.expires_at) > state.observedAt && current(r.owner_agent_id, r.fencing_token));
  for (const r of resources) result.using.push({agentId: String(r.owner_agent_id), resource: String(r.name),
    detail: r.type === 'port' ? `Port ${r.value} reserved` : state.commandGuards.some(g=>g.mutex_name===r.name && g.fencing_token===r.fencing_token) ? 'Supervised command running' : 'Shared command resource reserved'});
  const positions = new Map<string, number>();
  for (const w of state.mutexWaiters) {
    // Session epochs are exact on queue tickets; stale/replaced tickets cannot be current waits.
    if (!active.some(a => a.id === w.owner_agent_id) || state.sessionEpochs[String(w.owner_agent_id)] !== w.session_epoch || Number(w.expires_at) <= state.observedAt) continue;
    const name = String(w.mutex_name), position = (positions.get(name) ?? 0) + 1; positions.set(name, position);
    const guard = state.commandGuards.find(g => g.mutex_name === name);
    result.waiting.push({agentId: String(w.owner_agent_id), resource: name, position,
      holder: guard ? String(guard.owner_agent_id) : String(resources.find(r => r.type === 'mutex' && r.name === name)?.owner_agent_id ?? '') || null});
  }
  for (const g of state.commandGuards) if (!active.some(a=>a.id===g.owner_agent_id) || state.sessionEpochs[String(g.owner_agent_id)] !== g.session_epoch || !resources.some(r=>r.type==='mutex' && r.name===g.mutex_name && r.fencing_token===g.fencing_token))
    result.attention.push({message: `Command recovery needs review: ${g.mutex_name}`, nextStep: 'Run kith recover; do not release its resource until shutdown is established.'});
  for (const m of state.mergeQueue) {
    const a = state.agents.find(a => a.id === m.agent_id);
    if (!a || a.status === 'completed' || Number(m.fencing_token) < state.sessionEpochs[a.id] ||
      a.branch !== m.branch || a.worktree_path !== m.worktree_path) continue;
    if (m.status === 'failed') result.attention.push({message: `Integration did not pass: ${a.id}`,
      nextStep: 'Open its saved worktree, inspect the check failure and repair before retrying.'});
  }
  return result;
}
