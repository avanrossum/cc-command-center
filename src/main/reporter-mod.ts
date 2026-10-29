// Where sessions load the reporter mod from (MIP2-1404). In development it's
// dist/mod beside the build, or the repo's mod/. A packaged app can't hand
// Claude Code a folder inside its bundle: the build unpacks dist/mod from
// the asar, but Claude Code writes `.claude-plugin/types/` into the plugin
// folder on load, and the bundle is signed. So the packaged app copies the
// mod into its data folder, one folder per version of the mod's contents.
// Sessions still running from an earlier version keep their folder.
//
// That folder is writable by anything running as Alex, a session's Bash or
// Edit included, so it's checked against the shipped mod on every start and
// every minute after (gate M-2, MIP2-1430). A changed copy is moved aside
// and the shipped one put back at the same path, so a respawn loads it.
// Claude Code's own `.claude-plugin/types/` is left out of the check.

import { cpSync, existsSync, lstatSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { clearUserFlags } from '@ccc/coupling'
import { modHashOf } from '../../scripts/mod-hash.mjs'
import { join, sep } from 'node:path'

/** dist/ inside app.asar, as the unpacked copy's path (electron-builder's asarUnpack). */
export function unpackedPath(path: string): string {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

/**
 * A hash of the mod's file names and contents: the same function the build
 * uses (scripts/mod-hash.mjs), so the two can't drift (gate run 3, L-8).
 * Claude Code's `.claude-plugin/types/` is left out: the engine writes its
 * type definitions there when it loads the mod, and nothing executes from it.
 * The hooks import only `import type` from 'claude-code', which is erased,
 * and a test checks that no hook imports from that folder (gate run 3, I-2).
 */
export function modHash(dir: string): string {
  return modHashOf(dir)
}

/** A mod copy whose files no longer match what shipped, and where it was moved: null, with why, when it couldn't be (pass 4, M-3). */
export interface ModHealed {
  dir: string
  movedTo: string | null
  why?: string
}

/** The file operations setting a copy aside uses, and what's already known stuck. Tests replace the operations. */
export interface ModOps {
  rename?: (from: string, to: string) => void
  unflag?: (dir: string) => Promise<void>
  /**
   * Folders that couldn't be moved aside in this run. Each is tried once per
   * start, not every minute, and stays stuck from its first failure
   * (pass 6, M-3).
   */
  stuck?: Set<string>
}

/** More version folders than this is itself an integrity failure; the check never walks an unbounded tree (pass 6, M-3). */
export const MOD_FOLDERS_MAX = 32


/**
 * Moves a changed copy aside and reports it. A folder already gone is
 * nothing to report. A rename that fails is tried again after clearing the
 * folder's flags. If it still fails, the changed copy keeps its name, so
 * it's reported with why and rethrown: the alert shows, and the caller
 * doesn't go on as if it moved.
 */
async function setAside(dir: string, movedTo: string, onHeal: (h: ModHealed) => void, ops: ModOps = {}): Promise<void> {
  if (ops.stuck?.has(dir)) throw new Error(`${dir} couldn't be moved aside earlier in this run`)
  const rename = ops.rename ?? renameSync
  const gone = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT'
  try {
    rename(dir, movedTo)
  } catch (first) {
    if (gone(first)) return
    // Same-user code can make the folder immutable; the app, as the same user, clears it (pass 5, H-1).
    // Asynchronously, so a deep tree can't hold the main thread (pass 6, M-3).
    await (ops.unflag ?? clearUserFlags)(dir)
    try {
      rename(dir, movedTo)
    } catch (err) {
      if (gone(err)) return
      ops.stuck?.add(dir)
      onHeal({ dir, movedTo: null, why: (err as NodeJS.ErrnoException).code ?? String(err) })
      throw err
    }
  }
  onHeal({ dir, movedTo })
}

/** A version folder's name: the hash, and for a fresh copy beside a stuck one, `-r<time>` (pass 5, H-1). */
export const VERSION_DIR = /^([0-9a-f]{16})(?:-r\d{1,16})?$/

/** Copies the mod to `dest` through a temporary name, so a folder with the final name is always complete. */
export function copyTo(source: string, dest: string): string {
  const tmp = `${dest}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  cpSync(source, tmp, { recursive: true })
  renameSync(tmp, dest)
  return dest
}

/**
 * Copies the mod into `<dataDir>/reporter-mod/<hash>` and returns it. A copy
 * already there is used only if its files still hash to the shipped mod's;
 * otherwise it's moved aside and replaced, and `onHeal` is told. The copy
 * goes to a temporary name first, so a folder with the final name is always
 * complete.
 */
export async function installMod(source: string, dataDir: string, onHeal: (h: ModHealed) => void = () => {}, now: () => number = Date.now, built: string | null = null, ops: ModOps = {}): Promise<string> {
  if (!existsSync(join(source, '.claude-plugin', 'plugin.json'))) throw new Error(`the reporter mod is missing from ${source}`)
  const hash = modHash(source)
  if (!/^[0-9a-f]{16}$/.test(hash)) throw new Error(`the app's reporter mod can't be checked (${hash}). Reinstall CC Command Center.`)
  // The unpacked source sits outside asar integrity, so it's checked against the hash built into main.cjs (gate run 2, M-3).
  if (built !== null && hash !== built) throw new Error("the app's reporter mod was changed after it was built. Reinstall CC Command Center.")
  const dest = join(dataDir, 'reporter-mod', hash)
  if (existsSync(dest)) {
    if (modHash(dest) === hash) return dest
    try {
      await setAside(dest, `${dest}.changed-${now()}`, onHeal, ops)
    } catch {
      // The changed copy is stuck under the version's name, and reported. New launches use a fresh copy under
      // another name, so the stuck folder is never passed to a session (pass 5, H-1).
      return freshCopy(source, dest, hash, now)
    }
  }
  return copyTo(source, dest)
}

/** A good `<hash>-r<time>` copy beside a stuck one, the newest that still checks out, or a new one. */
function freshCopy(source: string, dest: string, hash: string, now: () => number): string {
  const root = join(dest, '..')
  const fresh = readdirSync(root)
    .filter(n => n.startsWith(`${hash}-r`) && VERSION_DIR.test(n))
    .sort()
    .reverse()
    .map(n => join(root, n))
    .find(d => {
      try {
        return lstatSync(d).isDirectory() && modHash(d) === hash
      } catch {
        return false
      }
    })
  return fresh ?? copyTo(source, `${dest}-r${now()}`)
}

/** What a round of the older-version check verified, and the folders past the cap it didn't check (pass 7, H-1). */
export interface FolderCheck {
  verified: Set<string>
  unchecked: string[]
}

/**
 * Checks every installed mod version, not only the current one (gate run 2,
 * L-1). Sessions started on an older version respawn from its folder. Each
 * folder is named for the hash of what was installed in it, so a folder
 * whose files no longer hash to its name was changed. There's no shipped
 * copy of an old version to restore, so a changed one is moved aside: a
 * session respawned from it then runs without the mod, and the app gets no
 * answers or reports from it. `current` is healed by installMod instead.
 *
 * With `referenced`, the versions unarchived sessions use, folders no
 * session uses are removed first, so ordinary upgrades never reach the cap,
 * and the referenced ones are checked first. Past MOD_FOLDERS_MAX the rest
 * are returned unchecked; the caller treats a session on an unchecked
 * version as unverified (pass 7, H-1).
 */
export async function checkModFolders(
  dataDir: string,
  current: string | null,
  onHeal: (h: ModHealed) => void,
  now: () => number = Date.now,
  ops: ModOps = {},
  referenced?: ReadonlySet<string>,
): Promise<FolderCheck> {
  const root = join(dataDir, 'reporter-mod')
  const verified = new Set<string>()
  if (!existsSync(root)) return { verified, unchecked: [] }
  const list = () => readdirSync(root).filter(n => VERSION_DIR.test(n))
  let names = list()
  if (referenced) {
    for (const name of names) {
      if (referenced.has(name) || join(root, name) === current) continue
      try {
        rmSync(join(root, name), { recursive: true, force: true })
      } catch {
        // A folder that can't be removed stays and is checked below.
      }
    }
    names = list().sort((a, b) => Number(referenced.has(b)) - Number(referenced.has(a)))
  }
  const unchecked = names.slice(MOD_FOLDERS_MAX)
  for (const name of names.slice(0, MOD_FOLDERS_MAX)) {
    const version = VERSION_DIR.exec(name)![1]!
    // Let the main thread run between folders.
    await new Promise(r => setImmediate(r))
    const dir = join(root, name)
    if (dir === current) continue
    // Each folder on its own: one odd entry (a file, a link, an unreadable folder) is set aside and
    // doesn't stop the check, or the app's start (gate run 3, L-4).
    try {
      const st = lstatSync(dir)
      if (st.isDirectory() && modHash(dir) === version) {
        verified.add(name)
        continue
      }
    } catch {
      // Unreadable: set aside below.
    }
    try {
      await setAside(dir, `${dir}.changed-${now()}`, onHeal, ops)
    } catch {
      // Reported by setAside; the other folders are still checked.
    }
  }
  return { verified, unchecked }
}

/** The folder to pass to `--plugin-dir`. */
/** The mod's hash from scripts/build.mjs, inside the integrity-checked asar; absent outside a build. */
declare const __CCC_MOD_HASH__: string | undefined
export const BUILT_MOD_HASH: string | null = typeof __CCC_MOD_HASH__ === 'string' ? __CCC_MOD_HASH__ : null

/**
 * `qaInstall` is QA's packaged-path run in an unpackaged build (MIP2-1507,
 * paths.ts qaPackagedPaths): the build's own mod is installed under
 * `<dataDir>/reporter-mod/<hash>` and checked, as a packaged build's is.
 */
export async function modDir(dist: string, packaged: boolean, dataDir: string, onHeal?: (h: ModHealed) => void, ops: ModOps = {}, qaInstall = false): Promise<string> {
  const source = modSource(dist, packaged)
  return packaged || qaInstall ? installMod(source, dataDir, onHeal, Date.now, BUILT_MOD_HASH, ops) : source
}

/** The build's own mod, the source every copy is made from: in the app bundle when packaged, else dist/mod. */
export function modSource(dist: string, packaged: boolean): string {
  if (packaged) return join(unpackedPath(dist), 'mod')
  const beside = join(dist, 'mod')
  return existsSync(join(beside, '.claude-plugin', 'plugin.json')) ? beside : join(dist, '..', 'mod')
}
