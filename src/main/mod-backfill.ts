// A session the app launched with no record of its reporter mod copy, from
// an earlier build (MIP2-1504). A bare resume restarts it on its saved
// `--plugin-dir` (Research MIP2-1506), and a resume with flags starts a copy
// (QA MIP2-1505), so the app finds out which copy that is and checks it
// immediately before resuming (pass 8, L-3). Claude Code reads the folder
// a moment later, after the re-key and the resume command (gate pass 17,
// L-1).
// Pure; the file operations are passed in.

import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { SavedOptions } from '@ccc/coupling'
import { isLaunchOnly, isMode, passesUnder } from './permission-modes.ts'
import { VERSION_DIR } from './reporter-mod.ts'
import { DATA_VOLUME, isAliasPath, isWholeDisk, wholeDiskReason, type DiskIo } from '@ccc/coupling'

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


/** The launch flags that take a value, each at most once; `--name`, `--model`, `--effort` and `--proactivity` may hold any value. */
const VALUED = ['--name', '--model', '--effort', '--permission-mode', '--plugin-dir', '--settings', '--proactivity'] as const
/** The longest `--add-dir` path accepted. */
const ADD_DIR_MAX = 4096
/**
 * Characters that could make a confirmation's text misdescribe a folder
 * (gate pass 21, L-2; pass 22, L-1; pass 23, L-2), tested on the NFC form so
 * an accented name in decomposed form passes: control, format (bidi,
 * zero-width, soft hyphen, BOM), combining marks left after NFC (variation
 * selectors, the grapheme joiner), spaces other than the plain one, line and
 * paragraph separators, private-use, unassigned and lone surrogates, and
 * the blank fillers (Hangul U+115F, U+1160, U+3164, U+FFA0; braille
 * U+2800). Written with escapes only. Combining marks that NFC can't fold
 * into a letter are refused too, so names in scripts that keep them, such
 * as Devanagari, Thai, or Hebrew and Arabic with vowel points, are refused:
 * that fails closed (gate pass 24, L-5).
 */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Mn}\p{Me}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\p{Co}\p{Cn}\p{Cs}\u115f\u1160\u3164\uffa0\u2800]/u
/** The longest `--watch-artifact` link accepted, and the links it may hold: a claude.ai artifact (MIP2-1576). */
const WATCH_MAX = 2048
const ARTIFACT_LINK = ['https://claude.ai/artifact/', 'https://claude.ai/code/artifact/']
/** The repeatable flags a session saves for itself, each with one value (MIP2-1576). */
const REPEATED = ['--add-dir', '--watch-artifact']
/** What the app launched the session with. */
export type Launch = { model?: string; effort?: string; mode?: string; extraArgs?: string[]; name?: string }
/** What Alex confirmed beyond the launch, kept apart from it (gate pass 21, L-3): a mode, and folders as real paths. */
export type Confirmed = { mode?: string; addDirs?: string[] }


/**
 * Where an added folder may be. `real` resolves links and, with
 * realpathSync.native, gives the name on disk; `fold` makes two names of one
 * folder compare equal (NFC, and lower case on a case-insensitive volume;
 * gate pass 21, H-2), and is used only for the refusals, where matching too
 * much fails closed (pass 22, M-2). The session's own folder and anything in it pass; the
 * disk root, the home folder and any folder above it, Claude Code's own
 * folder and anything in it, and a folder that holds, is, or is inside one
 * the app keeps sessions out of, refuse (D-040).
 */
export interface DirRules {
  cwd: string | null
  home: string
  claudeDir: string
  denied: readonly string[]
  real: (path: string) => string
  fold?: (path: string) => string
  /** For tests: the whole-disk check's file system. By default it reads the disk, with the throwing realpath (gate pass 56, L-1). */
  disk?: Partial<DiskIo>
}

/** What a session's saved options would add over its launch and confirmations, for Alex to confirm (D-040). */
export interface Escalation {
  mode: { saved: string; allowed: string; confirmed: boolean } | null
  dirs: string[]
}

export type FlagsCheck = { refused: string } | { confirm: Escalation } | null

/**
 * The path with every link resolved, through its nearest existing parent
 * when the path itself doesn't exist yet, so a folder made later under a link
 * is placed where it will really be (D-040). realpathSync.native gives the
 * name as the disk has it, so a different letter case of a folder resolves
 * to the same path (gate pass 21, H-2).
 */
export function realPath(path: string, real: (p: string) => string = realpathSync.native): string {
  let head = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return join(real(head), ...[...tail].reverse())
    } catch {
      const parent = dirname(head)
      if (parent === head) return resolve(path)
      tail.push(basename(head))
      head = parent
    }
  }
}

const nfc = (p: string) => p.normalize('NFC')

/**
 * How to compare folder names on the volume `home` is on (gate pass 21,
 * H-2): NFC always, since APFS treats both forms as one name, and lower case
 * too when the volume ignores case, as macOS's default does. Told from
 * whether the upper-cased home resolves to the same folder.
 */
export function pathFold(home: string, real: (p: string) => string = realpathSync.native): (path: string) => string {
  let ignoresCase = false
  try {
    ignoresCase = real(home.toUpperCase()) === real(home)
  } catch {
    ignoresCase = false
  }
  return ignoresCase ? p => nfc(p).toLowerCase() : nfc
}
const inside = (path: string, folder: string, fold: (p: string) => string = nfc) => {
  const p = fold(path)
  const f = fold(folder)
  return p === f || p.startsWith(f.endsWith('/') ? f : `${f}/`)
}

/** An `--add-dir` under a macOS alias prefix, which names a folder by another path (gate pass 55, M-2). */
const ALIAS_REFUSAL = 'its saved options add a folder by a special path (/.vol, /.nofollow or /.resolve)'

/** A path under the data volume's root at its plain path (`/System/Volumes/Data/x` is `/x`); others as they are. */
export function onDataVolume(path: string, fold: (p: string) => string = nfc): string {
  const prefix = `${DATA_VOLUME}/`
  return fold(path).startsWith(fold(prefix)) ? path.slice(DATA_VOLUME.length) : path
}

/**
 * The one place an added folder is refused (gate pass 56, L-5): an alias
 * path, typed or real, and the whole disk, with or without rules; then,
 * with rules, the home folder and above, Claude Code's folder and the
 * denied folders. The whole-disk check reads the disk itself, not through
 * `rules.real`, which never throws (pass 56, L-1).
 */
function dirRefusal(typed: string, path: string, rules?: DirRules): string | null {
  if (isAliasPath(typed) || isAliasPath(path)) return ALIAS_REFUSAL
  const disk = wholeDiskReason(path, rules?.disk)
  if (disk === 'unreadable') return "its saved options add a folder whose real path can't be read"
  if (disk) return 'its saved options add the whole disk as a folder'
  if (!rules) return null
  const fold = rules.fold
  // The folders that hold the data volume, and so the home folder through it (gate pass 55, M-2).
  const folded = fold ?? nfc
  if (['/System', '/System/Volumes'].some(f => folded(path.replace(/\/+$/, '')) === folded(f))) return 'its saved options add your home folder or a folder above it'
  // A folder through the data volume is the same folder at its plain path: `/System/Volumes/Data/Users/a/.claude` is
  // `~/.claude` (gate pass 54, M-2).
  const real = onDataVolume(path, fold)
  if (inside(rules.real(rules.home), real, fold)) return 'its saved options add your home folder or a folder above it'
  const claude = rules.real(rules.claudeDir)
  if (inside(claude, real, fold) || inside(real, claude, fold)) return "its saved options add Claude Code's own folder"
  for (const d of rules.denied) {
    const root = rules.real(d)
    if (inside(root, real, fold) || inside(real, root, fold)) return 'its saved options add a folder the app keeps sessions out of'
  }
  return null
}

/** The wording a confirmation shows: 'Saved settings: auto, + "/a", + "/b". Launched as default.' Folders are quoted. */
export function escalationText(e: Escalation): string {
  const saved = [...(e.mode ? [e.mode.saved] : []), ...e.dirs.map(d => `+ ${JSON.stringify(d)}`)].join(', ')
  return `Saved settings: ${saved}.${e.mode ? ` ${e.mode.confirmed ? 'Confirmed' : 'Launched'} as ${e.mode.allowed}.` : ''}`
}

/**
 * The saved flags against the app's record of the launch and of what Alex
 * confirmed (gate pass 18, M-1; pass 19, L-1; pass 20, H-1; pass 21): null
 * when they pass; a refusal; or what they'd add, which Alex confirms once
 * (D-040). Each of VALUED appears at most once, with a value that doesn't
 * start with "-". Name, model, effort and proactivity may hold any value, or
 * be left out: they grant nothing, and Claude Code saves the session's
 * current ones (MIP2-1572, MIP2-1576). The permission mode goes by
 * passesUnder (permission-modes.ts). Each `--add-dir` holds one absolute path with no control or
 * bidi characters, placed by `rules` after resolving links; one inside the
 * session's folder, or one Alex confirmed, passes. `--watch-artifact` may
 * repeat, each with one claude.ai artifact link. What's left must be exactly
 * the recorded extra arguments, less their own `--add-dir`,
 * `--watch-artifact` and `--proactivity`. Any other flag, such as
 * --dangerously-skip-permissions or --mcp-config, refuses. Claude Code saves
 * the flags in its own order, so they're compared by name, not as a
 * sequence.
 */
export function savedFlagsCheck(flags: readonly string[], launch: Launch, rules?: DirRules, confirmed: Confirmed = {}): FlagsCheck {
  // By its real path too: a recorded folder that links to the disk root counts every folder as its own (gate pass 41, M-1).
  if (rules?.cwd && (isWholeDisk(rules.cwd, rules.disk) || isWholeDisk(rules.real(rules.cwd), rules.disk))) return { refused: "the app's record of its folder is the whole disk, so its saved options can't be checked" }
  const values = new Map<string, string>()
  const rest: string[] = []
  const dirs: string[] = []
  const real = rules?.real ?? resolve
  // The pass checks compare NFC only: a case fold taken from the home volume would make two folders on a
  // case-sensitive volume one. realpathSync.native already gives an existing folder its name on disk (pass 22, M-2).
  const confirmedDirs = new Set((confirmed.addDirs ?? []).map(nfc))
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!
    if (REPEATED.includes(f)) {
      const v = flags[i + 1]
      if (v === undefined || v.startsWith('-')) return { refused: 'its saved options repeat a flag or leave out a value' }
      if (f === '--add-dir') {
        if (!v.startsWith('/') || UNPRINTABLE.test(v.normalize('NFC')) || v.length > ADD_DIR_MAX) return { refused: "its saved options add a folder that isn't a plain absolute path" }
        // Already normal, or refused: the checks below resolve `link/..` as text, where Claude Code may follow the link
        // first, so `<cwd>/link-to-root/..` would pass as the session's own folder (gate pass 57, H-1).
        if ((v.replace(/\/+$/, '') || '/') !== resolve(v)) return { refused: 'its saved options add a folder written with `.` or `..`' }
        const path = real(v)
        // The confirmation shows the real path, so it's checked too: a link can lead to a name the typed one hides (gate pass 24, M-4).
        if (UNPRINTABLE.test(path.normalize('NFC'))) return { refused: "its saved options add a folder whose real name can't be shown plainly" }
        const why = dirRefusal(v, path, rules)
        if (why) return { refused: why }
        const own = rules?.cwd ? inside(path, rules.real(rules.cwd)) : false
        if (!own && !confirmedDirs.has(nfc(path)) && !dirs.some(d => nfc(d) === nfc(path))) dirs.push(path)
      }
      if (f === '--watch-artifact' && (!ARTIFACT_LINK.some(p => v.startsWith(p) && v.length > p.length) || v.includes('\0') || v.length > WATCH_MAX)) return { refused: "its saved options watch something that isn't a claude.ai artifact link" }
      i++
      continue
    }
    if (!(VALUED as readonly string[]).includes(f)) {
      rest.push(f)
      continue
    }
    const v = flags[i + 1]
    if (values.has(f) || v === undefined || v.startsWith('-')) return { refused: 'its saved options repeat a flag or leave out a value' }
    values.set(f, v)
    i++
  }
  const extra = withoutAccepted(launch.extraArgs ?? [])
  if (rest.length !== extra.length || rest.some((a, i) => a !== extra[i])) return { refused: 'its saved options hold flags the app never passed' }
  const launched = launch.mode ?? 'default'
  const saved = values.get('--permission-mode')
  let mode: Escalation['mode'] = null
  // A launch-only mode passes only as the launch's own, whatever the confirmed record says (pass 22, L-2).
  if (saved !== undefined && saved !== launched && (isLaunchOnly(saved) || !isMode(saved))) return { refused: 'its saved options change --permission-mode to one the app never launched it with' }
  if (saved !== undefined && saved !== launched && saved !== confirmed.mode) {
    if (!passesUnder(launched, saved) && !passesUnder(confirmed.mode, saved)) mode = { saved, allowed: confirmed.mode ?? launched, confirmed: confirmed.mode !== undefined }
  }
  return mode || dirs.length ? { confirm: { mode, dirs } } : null
}

/** savedFlagsCheck as one reason: a refusal, or the confirmation's wording. */
export function savedFlagsRefusal(flags: readonly string[], launch: Launch, rules?: DirRules, confirmed?: Confirmed): string | null {
  const r = savedFlagsCheck(flags, launch, rules, confirmed)
  return r === null ? null : 'refused' in r ? r.refused : escalationText(r.confirm)
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
 * Whether a recorded app-launched session may be restarted on what Claude
 * Code saved for it (gate pass 17, M-1; pass 18, M-1). A bare resume or
 * respawn loads the whole saved flag list, which a session can rewrite: the
 * folder must be the recorded copy, the settings file its channel's, and
 * every other flag the recorded launch's, or something Alex confirmed
 * (D-040; `rec.confirmed`). An unreadable file refuses too.
 */
export function savedOptionsCheck(saved: SavedOptions, rec: { modRoot: string; mod: string; settings: string | null; launch: Launch; cwd?: string | null; confirmed?: Confirmed }, rules?: Omit<DirRules, 'cwd'>): FlagsCheck {
  if ('refused' in saved) return { refused: saved.refused }
  // The folder it restarts in (gate pass 19, M-2): the recorded one, or refused when the app has none.
  if (!rec.cwd) return { refused: "the app has no record of its folder, so its saved options can't be checked" }
  // Every folder would count as inside a recorded "/" (MIP2-1602 gate pass 39, M-2).
  if (isWholeDisk(rec.cwd, rules?.disk)) return { refused: "the app's record of its folder is the whole disk, so its saved options can't be checked" }
  if (saved.cwd !== resolve(rec.cwd)) return { refused: 'its saved options name a folder other than the one the app launched it in' }
  if (saved.dir !== resolve(rec.modRoot, rec.mod)) return { refused: 'its saved options name a reporter mod copy other than the one the app recorded' }
  if (rec.settings === null) return { refused: "its channel is gone, so its saved settings file can't be checked" }
  if (saved.settings !== resolve(rec.settings)) return { refused: "its saved options name a settings file other than its channel's" }
  return savedFlagsCheck(saved.flags, rec.launch, rules ? { ...rules, cwd: rec.cwd } : undefined, rec.confirmed)
}

/** savedOptionsCheck as one reason: a refusal, or the confirmation's wording. */
export function savedOptionsRefusal(saved: SavedOptions, rec: Parameters<typeof savedOptionsCheck>[1], rules?: Omit<DirRules, 'cwd'>): string | null {
  const r = savedOptionsCheck(saved, rec, rules)
  return r === null ? null : 'refused' in r ? r.refused : escalationText(r.confirm)
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
