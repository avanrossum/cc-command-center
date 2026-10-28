// What the window knows about app updates (MIP2-1469).

export type UpdatePhase =
  /** Not a release build (unpackaged, or no app-update.yml): updates aren't checked. */
  | 'off'
  | 'idle'
  | 'checking'
  /** Checked; this is the newest version. */
  | 'none'
  | 'available'
  | 'downloading'
  /** Downloaded and checked; Restart to update installs it. */
  | 'downloaded'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  /** The version offered, downloading or downloaded. */
  version: string | null
  /** Download progress, 0–100. */
  percent: number | null
  /** When the last check finished, ms since the epoch. */
  checkedAt: number | null
  error: string | null
  /** Later was pressed for `version`: the notice stays hidden until a newer one, or a check by hand. */
  dismissed: boolean
  /** A dry-run build's local update source; null in a release build. */
  testOrigin: string | null
}

export const INITIAL_UPDATE_STATE: UpdateState = { phase: 'idle', version: null, percent: null, checkedAt: null, error: null, dismissed: false, testOrigin: null }

/** Whether a version is a prerelease (`1.0.1-beta.2`). */
export function isPrerelease(version: string): boolean {
  return /^v?\d+\.\d+\.\d+-/.test(version)
}

/** Get beta updates (MIP2-1497): the setting when set; unset, on in a beta build, so a beta keeps getting betas and then the final. */
export function betaUpdatesOn(setting: boolean | undefined, version: string): boolean {
  return setting ?? isPrerelease(version)
}
