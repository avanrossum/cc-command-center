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

/**
 * The permission modes Shift+Tab reaches in any session, with no launch flag
 * (code.claude.com/docs/en/permission-modes, read 2026-10-30). Auto is in the
 * cycle where the account has it. bypassPermissions joins the cycle only
 * after a launch that enables it, and dontAsk only comes from a launch flag,
 * so either is accepted only when the app launched with it (MIP2-1572).
 */
const CYCLE_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'auto']

/** The launch flags that take a value, each at most once; `--name`, `--model`, `--effort` and `--proactivity` may hold any value. */
const VALUED = ['--name', '--model', '--effort', '--permission-mode', '--plugin-dir', '--settings', '--proactivity'] as const
/** The longest `--add-dir` path accepted. */
const ADD_DIR_MAX = 4096
/** The longest `--watch-artifact` link accepted, and the links it may hold: a claude.ai artifact (MIP2-1576). */
const WATCH_MAX = 2048
const ARTIFACT_LINK = ['https://claude.ai/artifact/', 'https://claude.ai/code/artifact/']
/** The repeatable flags a session saves for itself, each with one value, not compared with the launch (MIP2-1576). */
const REPEATED = ['--add-dir', '--watch-artifact']
type Launch = { model?: string; effort?: string; mode?: string; extraArgs?: string[]; name?: string }

/**
 * Why the saved flags aren't the ones the app launched the session with,
 * or null (gate pass 18, M-1; pass 19, L-1). Each of VALUED appears at most
 * once, with a value that doesn't start with "-". Name, model, effort and
 * proactivity may hold any value, or be left out: they grant nothing, and
 * Claude Code saves the session's current ones, which a rename, /model and
 * /effort change, and fills them in when the launch had none (MIP2-1572,
 * MIP2-1576). The permission mode, when present, is the recorded one or one
 * Shift+Tab reaches in any session (CYCLE_MODES), which Claude Code also
 * saves; Claude Code 2.1.312 can leave it out (QA saw no --model after a
 * launch with one, MIP2-1507), which falls back to the default and grants
 * nothing. `--add-dir` may repeat, each with one absolute path other than
 * the root, since /add-dir saves it; `--watch-artifact` may repeat, each with
 * one claude.ai artifact link (Research MIP2-1573; MIP2-1576). Neither is
 * compared with the launch. What's left must be exactly the recorded extra
 * arguments, less their own `--add-dir`, `--watch-artifact` and
 * `--proactivity`. Any other flag, such as
 * --dangerously-skip-permissions or --mcp-config, refuses. Claude Code
 * saves the flags in its own order, so they're compared by name, not as a
 * sequence.
 */
export function savedFlagsRefusal(flags: readonly string[], launch: Launch): string | null {
  const values = new Map<string, string>()
  const rest: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!
    if (REPEATED.includes(f)) {
      const v = flags[i + 1]
      if (v === undefined || v.startsWith('-')) return 'its saved options repeat a flag or leave out a value'
      if (f === '--add-dir' && (!v.startsWith('/') || v.includes('\0') || v.length > ADD_DIR_MAX)) return "its saved options add a folder that isn't a plain absolute path"
      if (f === '--add-dir' && resolve(v) === '/') return 'its saved options add the whole disk as a folder'
      if (f === '--watch-artifact' && (!ARTIFACT_LINK.some(p => v.startsWith(p) && v.length > p.length) || v.includes('\0') || v.length > WATCH_MAX)) return "its saved options watch something that isn't a claude.ai artifact link"
      i++
      continue
    }
    if (!(VALUED as readonly string[]).includes(f)) {
      rest.push(f)
      continue
    }
    const v = flags[i + 1]
    if (values.has(f) || v === undefined || v.startsWith('-')) return 'its saved options repeat a flag or leave out a value'
    values.set(f, v)
    i++
  }
  const mode = values.get('--permission-mode')
  if (mode !== undefined && mode !== launch.mode && !CYCLE_MODES.includes(mode)) return 'its saved options change --permission-mode to one the app never launched it with'
  const extra = withoutAccepted(launch.extraArgs ?? [])
  if (rest.length !== extra.length || rest.some((a, i) => a !== extra[i])) return 'its saved options hold flags the app never passed'
  return null
}

/** The extra arguments less `--add-dir`, `--watch-artifact` and `--proactivity` and their values, which the saved flags may change. */
function withoutAccepted(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if ((REPEATED.includes(args[i]!) || args[i] === '--proactivity') && args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) i++
    else out.push(args[i]!)
  }
  return out
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
