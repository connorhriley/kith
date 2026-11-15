/**
 * How a repository's agents share files. `worktrees` gives each agent an isolated Git worktree and integrates through
 * a merge train. `main` keeps every agent in the one checkout, coordinating through scope claims; it is the model for
 * teams that work on the main branch and treat worktrees as overhead. The mode is repository-wide shared state.
 */
export const WORKFLOW_MODES = ['worktrees', 'main'] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

export const MAIN_MODE_NOTE = 'isolateWorktree was ignored: this repository works in the main checkout. Change the mode with `kith mode worktrees`.';

/** Lenient: anything unrecognised, including absence, is the original behaviour. */
export const workflowModeFrom = (value: unknown): WorkflowMode => (value === 'main' ? 'main' : 'worktrees');

/** Strict: for user input. */
export function parseWorkflowMode(value: unknown): WorkflowMode {
  if (!WORKFLOW_MODES.includes(value as WorkflowMode)) throw new Error(`Mode must be one of: ${WORKFLOW_MODES.join(', ')}.`);
  return value as WorkflowMode;
}
