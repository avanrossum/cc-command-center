// A session the app launched with no record of its reporter mod copy, from
// an earlier build (MIP2-1504). A bare resume restarts it on its saved
// `--plugin-dir` (Research MIP2-1506), and a resume with flags starts a copy
// (QA MIP2-1505), so the app finds out which copy that is and checks it
// immediately before resuming (pass 8, L-3). Claude Code reads the folder
// a moment later, after the re-key and the resume command (gate pass 17,
// L-1).
// Pure; the file operations are passed in.

import { basename, dirname, resolve } from 'node:path'
import type { SavedOptions } from '@ccc/coupling'
import { VERSION_DIR } from './reporter-mod.ts'

export interface BackfillDeps {
  /** `<data>/reporter-mod`. */
  modRoot: string
  /** The current copy's folder, for its version's hash. */
  current: string
  /** The build's own mod, which a pruned copy of the current version is restored from (MIP2-1508). */
  source: string
  /** Version folders whose changed copy couldn't be moved aside. */
  stuck: ReadonlySet<string>
  exists: (path: string) => boolean
  /** A real folder, not a link. */
  isDir: (path: string) => boolean
  hash: (path: string) => string
  /** Copies `from` to `to` through a temporary name. */
  restore: (from: string, to: string) => void
}

export type Backfill = { version: string; restored: boolean } | { refused: string }

/**
 * The version folder a session's saved `--plugin-dir` names, once checked:
 * inside the app's mod folder, named for a hash, not stuck, and its files
 * hashing to its name now, not only at the latest round (MIP2-1508). A
 * pruned folder is restored only when its name's hash is the current
 * version's, from the build's own mod, and checked again. Anything else,
 * a failed read or copy included, is refused with the reason.
 */
export function backfillVersion(saved: Pick<Extract<SavedOptions, { dir: string }>, 'dir'> | { refused: string }, d: BackfillDeps): Backfill {
  if ('refused' in saved) return saved
  const dir = saved.dir
  const name = basename(dir)
  const m = VERSION_DIR.exec(name)
  if (resolve(dirname(dir)) !== resolve(d.modRoot) || !m) return { refused: "its saved reporter mod folder isn't one of the app's copies" }
  const hash = m[1]!
  if (d.stuck.has(name)) return { refused: 'its copy could not be moved aside' }
  if (d.exists(dir)) {
    if (!d.isDir(dir)) return { refused: "its saved reporter mod folder isn't a folder" }
    let now: string
    try {
      now = d.hash(dir)
    } catch (err) {
      return { refused: `its saved reporter mod copy couldn't be read (${message(err)})` }
    }
    return now === hash ? { version: name, restored: false } : { refused: 'its saved reporter mod copy no longer matches its name' }
  }
  if (VERSION_DIR.exec(basename(d.current))?.[1] !== hash) return { refused: "its saved reporter mod copy was removed, and it isn't the app's current version, so it can't be restored" }
  try {
    d.restore(d.source, dir)
    if (d.isDir(dir) && d.hash(dir) === hash) return { version: name, restored: true }
  } catch (err) {
    return { refused: `its saved reporter mod copy was removed and couldn't be restored (${message(err)})` }
  }
  return { refused: "its saved reporter mod copy was removed, and the restored copy didn't check out" }
}

/** The launch flags whose values the app checks against its record; `--name` may hold any name. */
const VALUED = ['--name', '--model', '--effort', '--permission-mode', '--plugin-dir', '--settings'] as const
type Launch = { model?: string; effort?: string; mode?: string; extraArgs?: string[]; name?: string }

/**
 * Why the saved flags aren't the ones the app launched the session with,
 * or null (gate pass 18, M-1; pass 19, L-1). Each of VALUED appears at most
 * once, with a value that doesn't start with "-". The name is the recorded
 * one, when the app recorded it. Model, effort and permission mode, when
 * present, are the recorded ones; Claude Code 2.1.312 can leave one out
 * (QA saw no --model after a launch with one, MIP2-1507), which falls back
 * to the default and grants nothing. What's left must be exactly the
 * recorded extra arguments. Any other flag, such as
 * --dangerously-skip-permissions or --mcp-config, refuses. Claude Code
 * saves the flags in its own order, so they're compared by name, not as a
 * sequence.
 */
export function savedFlagsRefusal(flags: readonly string[], launch: Launch): string | null {
  const values = new Map<string, string>()
  const rest: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!
    if (!(VALUED as readonly string[]).includes(f)) {
      rest.push(f)
      continue
    }
    const v = flags[i + 1]
    if (values.has(f) || v === undefined || v.startsWith('-')) return 'its saved options repeat a flag or leave out a value'
    values.set(f, v)
    i++
  }
  const wants: [string, string | undefined][] = [
    ['--model', launch.model],
    ['--effort', launch.effort],
    ['--permission-mode', launch.mode],
  ]
  for (const [flag, want] of wants) {
    const got = values.get(flag)
    if (got !== undefined && got !== want) return `its saved options change ${flag} from what the app launched it with`
  }
  if (launch.name !== undefined && values.has('--name') && values.get('--name') !== launch.name) return 'its saved options change --name from what the app launched it with'
  const extra = launch.extraArgs ?? []
  if (rest.length !== extra.length || rest.some((a, i) => a !== extra[i])) return 'its saved options hold flags the app never passed'
  return null
}

/**
 * Why a recorded app-launched session mustn't be restarted on what Claude
 * Code saved for it, or null (gate pass 17, M-1; pass 18, M-1). A bare
 * resume or respawn loads the whole saved flag list, which a session can
 * rewrite: the folder must be the recorded copy, the settings file its
 * channel's, and every other flag the recorded launch's. An unreadable file
 * refuses too.
 */
export function savedOptionsRefusal(saved: SavedOptions, rec: { modRoot: string; mod: string; settings: string | null; launch: Launch; cwd?: string | null }): string | null {
  if ('refused' in saved) return saved.refused
  // The folder it restarts in (gate pass 19, M-2): the recorded one, or refused when the app has none.
  if (!rec.cwd) return "the app has no record of its folder, so its saved options can't be checked"
  if (saved.cwd !== resolve(rec.cwd)) return 'its saved options name a folder other than the one the app launched it in'
  if (saved.dir !== resolve(rec.modRoot, rec.mod)) return 'its saved options name a reporter mod copy other than the one the app recorded'
  if (rec.settings === null) return "its channel is gone, so its saved settings file can't be checked"
  if (saved.settings !== resolve(rec.settings)) return "its saved options name a settings file other than its channel's"
  return savedFlagsRefusal(saved.flags, rec.launch)
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
