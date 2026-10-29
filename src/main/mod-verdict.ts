// Whether a session may be started again on its saved mod copy (pass 6,
// H-1; pass 7, H-1 and L-4). A resume or respawn keeps the session's saved
// `--plugin-dir`, so the app refuses a resume, and the watchdog skips a
// respawn, unless that copy was verified. Pure.

export interface ModState {
  packaged: boolean
  /** Versions whose changed copy couldn't be moved aside. */
  stuck: ReadonlySet<string>
  /** Versions the latest completed round verified, the current one included. */
  verified: ReadonlySet<string>
  /** Version folders the latest round left unchecked, past its cap. */
  unchecked: number
  /** Why launches are paused, or null. */
  launchBlocked: string | null
}

/**
 * Why the session mustn't be started again on its copy, or null. `version`
 * is the store's `launch.mod`; `appLaunched`, whether the app launched it
 * (and so gave it a `--plugin-dir`). An app-launched session with no
 * version on record is unverified: its saved `--plugin-dir` names a folder
 * the app can't vouch for (pass 8, L-3). A session started elsewhere
 * doesn't load the app's mod.
 */
export function modVerdict(version: string | undefined, s: ModState, appLaunched = false): string | null {
  // A development build passes dist/mod directly; there are no copies to check.
  if (!s.packaged) return null
  if (!version && appLaunched) return 'the app has no record of which reporter mod copy this session uses'
  if (version && s.stuck.has(version)) return 'its copy could not be moved aside'
  if (version && !s.verified.has(version)) return "its copy wasn't verified by the app's latest check"
  if (!version && (s.stuck.size > 0 || s.unchecked > 0)) return 'a reporter mod copy is stuck or unchecked, and the app has no record of which copy this session uses'
  return s.launchBlocked
}

/**
 * Whether a session may be restarted on its saved options now, for every
 * restart path (gate pass 18, H-1, L-3; restart.ts guardRestarts): the mod
 * copy's verdict, then, for a recorded app-launched session in a packaged
 * build (or QA's run of one), the saved options against the app's record.
 */
export interface RestartDeps {
  meta: (sessionId: string) => { origin?: string; launch?: { mod?: string; model?: string; effort?: string; mode?: string; extraArgs?: string[] } } | undefined
  mod: ModState
  /** Packaged, or QA's packaged-path run. */
  packaged: boolean
  savedRefusal: (sessionId: string, rec: { mod: string; launch: NonNullable<NonNullable<ReturnType<RestartDeps['meta']>>['launch']> }) => string | null
}

export function restartVerdict(sessionId: string, d: RestartDeps): string | null {
  const m = d.meta(sessionId)
  const appLaunched = m?.origin === 'app'
  const first = modVerdict(m?.launch?.mod, d.mod, appLaunched)
  if (first) return first
  if (!d.packaged || !appLaunched || !m?.launch?.mod) return null
  return d.savedRefusal(sessionId, { mod: m.launch.mod, launch: m.launch })
}
