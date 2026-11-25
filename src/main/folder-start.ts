// Where the folder picker opens (MIP2-2073): at the folder the sheet shows, else the last folder chosen in the picker,
// else the last one launched in, else the home folder. A folder that's gone opens at its nearest folder that still
// exists. Each look is asynchronous and bounded, only one runs at a time, and paths under /net aren't looked at, so a
// stalled network mount can't hold up the main thread or fill its thread pool (gate pass 63, L-3; pass 64, M-2). Pure but for `isFolder`, so it's tested without Electron.

import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** How long one look at a folder may take before it counts as gone. */
export const FOLDER_LOOK_MS = 500
/** How long finding the start folder may take in all, before the home folder is used. */
export const PICKER_START_MS = 1_500

/** A path the picker may start at: absolute, at most 4096 characters, with no NUL. */
const usable = (p: unknown): p is string => typeof p === 'string' && p.startsWith('/') && p.length <= 4096 && !p.includes('\0')
/** Under the /net automounts, checked on the resolved path, so `/tmp/../net/x` is too (gate pass 64, L-1). */
const underNet = (p: string) => p === '/net' || p.startsWith('/net/')

/** Looks not yet settled. A timed-out stat keeps its thread until the kernel answers, so only one is ever let run (gate pass 64, M-2). */
let looking = 0

/**
 * Whether `path` is a folder, by an asynchronous stat bounded by
 * FOLDER_LOOK_MS. While an earlier look hasn't settled, as on a stalled
 * mount, no new stat is made and the answer is no.
 */
export async function isFolderBounded(path: string, ms = FOLDER_LOOK_MS, look: (p: string) => Promise<boolean> = p => stat(p).then(s => s.isDirectory())): Promise<boolean> {
  if (looking > 0) return false
  looking++
  const settled = look(path)
    .catch(() => false)
    .finally(() => void looking--)
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<boolean>(r => (timer = setTimeout(() => r(false), ms)))
  try {
    return await Promise.race([settled, late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The folder to open the picker at: the first usable of `wanted`, at its
 * nearest folder that exists (`isFolder`), never the disk root; else `home`.
 * Past PICKER_START_MS in all, `home`.
 */
export async function pickerStart(wanted: readonly unknown[], home: string, isFolder: (path: string) => Promise<boolean> = isFolderBounded, now: () => number = Date.now): Promise<string> {
  const deadline = now() + PICKER_START_MS
  for (const w of wanted) {
    if (!usable(w)) continue
    for (let p = resolve(w); p !== '/'; p = dirname(p)) {
      if (underNet(p)) break
      if (now() > deadline) return home
      if (await isFolder(p)) return p
    }
  }
  return home
}
