// A contract field: one value plus where it came from and when. Every field
// in SessionSnapshot is one of these, so each degrades on its own: when its
// source stops answering, the field keeps its last value, is marked stale,
// and the UI says which field is stale (D-004, DECISION item 3).

/** Where a field's value came from, in the order the coupling prefers them. */
export type FieldSource =
  /** `claude agents --json`, polled by the coupling package. */
  | 'agents-json'
  /** The reporter mod running inside the session. */
  | 'mod'
  /** A settings hook passed to the session in its `--settings` file. */
  | 'hook'
  /**
   * A statusLine payload another program saved: today, Electron CCCC's
   * per-session usage files. Used for the usage meter until app-launched
   * sessions report through the mod.
   */
  | 'statusline'
  /** A labeled fallback read of the transcript. None is planned. */
  | 'fallback-transcript'
  /** A labeled fallback read of the terminal screen. None is planned. */
  | 'fallback-screen'

export const FIELD_SOURCES: readonly FieldSource[] = [
  'agents-json',
  'mod',
  'hook',
  'statusline',
  'fallback-transcript',
  'fallback-screen',
]

export interface Field<T> {
  value: T
  source: FieldSource
  /** When the source last reported this value, Unix milliseconds. */
  observedAt: number
  /**
   * True when the source has stopped confirming the value: the session left
   * the last poll, the mod went quiet, or a self-check failed for this field.
   */
  stale: boolean
}

export function field<T>(value: T, source: FieldSource, observedAt: number): Field<T> {
  return { value, source, observedAt, stale: false }
}

export function markStale<T>(f: Field<T>): Field<T> {
  return f.stale ? f : { ...f, stale: true }
}
