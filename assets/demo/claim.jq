if .ok then
  "✓ claimed: \(.locks[0].pattern) (\(.locks[0].mode), \(.locks[0].owner_agent_id))"
else
  "✗ refused: \(.lockConflicts[0].requestedPattern) is held by \(.lockConflicts[0].ownerAgentName) (\"\(.lockConflicts[0].ownerIntent)\")"
end
