{
  ok,
  scope: .task.scope_globs,
  locks: [.locks[] | {pattern, mode, owner: .owner_agent_id}],
  conflicts: [.lockConflicts[] | {requested: .requestedPattern, heldBy: .ownerAgentName, task: .ownerIntent}]
}
