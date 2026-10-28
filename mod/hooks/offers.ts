// When a card offer is over without the app (MIP2-1492). Kept apart from
// register.ts so it's tested without the engine's types.

/**
 * Whether a finished call settles an offer: its own call by tool_use_id, or,
 * for an offer whose id couldn't be matched to its call, the first call of its
 * tool to finish. A question answered in the terminal then stops being offered
 * when it completes, not at the end of the turn.
 */
export function finishedCallSettles(o: { toolUseId: string | null; tool: string }, call: { toolUseId: string; tool: string }): boolean {
  return o.toolUseId === call.toolUseId || (o.toolUseId === null && o.tool === call.tool)
}
