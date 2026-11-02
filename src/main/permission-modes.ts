// Claude Code's permission modes as the restart check ranks them (gate pass
// 20, H-1; pass 21, H-1; pass 23, L-4). Kept apart from the check, since the
// store's schema reads them too.

/**
 * The saved permission modes that pass without asking, for each mode the
 * session was launched or confirmed in (gate pass 20, H-1; pass 21, H-1;
 * D-040, D-041). Any other needs Alex's confirmation, since the check can't
 * tell his Shift+Tab from an edit to the saved options. plan isn't below
 * default: where auto mode is available, plan runs classifier-approved shell
 * commands without a prompt (Claude Code's permission-modes doc), so a saved
 * plan passes only after plan, auto or bypassPermissions. dontAsk and
 * bypassPermissions pass only as the launch's own mode. A launch with no
 * recorded mode ran in default.
 */
const TABLE: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, readonly string[]>, {
    dontAsk: Object.freeze([]),
    default: Object.freeze([]),
    acceptEdits: Object.freeze(['default']),
    plan: Object.freeze(['default']),
    auto: Object.freeze(['default', 'acceptEdits', 'plan']),
    bypassPermissions: Object.freeze(['default', 'acceptEdits', 'plan', 'auto']),
  }),
)
/** Modes only a launch can enable: they pass only as the launch's own. */
const LAUNCH_ONLY: readonly string[] = Object.freeze(['dontAsk', 'bypassPermissions'])

/**
 * A permission mode the table lists, by its own entry: a name like
 * "constructor" or "__proto__" isn't one (gate pass 24, M-1). The table is a
 * frozen object with no prototype, read only through these functions (L-6).
 */
export function isMode(mode: string): boolean {
  return Object.hasOwn(TABLE, mode)
}

export function isLaunchOnly(mode: string): boolean {
  return LAUNCH_ONLY.includes(mode)
}

/** Whether a saved mode passes without asking under the mode the session was launched or confirmed in. */
export function passesUnder(allowed: string | undefined, saved: string): boolean {
  return allowed !== undefined && isMode(allowed) && TABLE[allowed]!.includes(saved)
}

/** The modes a confirmation may hold: any but a launch-only one (gate pass 22, L-2). */
export const CONFIRMABLE_MODES: readonly string[] = Object.freeze(Object.keys(TABLE).filter(m => !isLaunchOnly(m)))
