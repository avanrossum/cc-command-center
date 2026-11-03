// The one rule for a folder no session may run in, and its message (MIP2-1603, MIP2-1626, MIP2-1627; gate passes 53
// and 54): the disk root, `/`, and the data volume's root, `/System/Volumes/Data`. Every launch, copy, move and
// restart check uses isWholeDisk; the store's migration uses the lexical wholeDiskPath, so a store load never
// touches the file system.
//
// They're compared by identity, the device and inode of the path as written and of its real path
// (`realpathSync.native`), so a case variant (`/system/volumes/data`), a link (`/Volumes/Macintosh HD`) or a trailing
// slash that changes the folder (`/.nofollow/` is `/`) can't pass by its spelling. A path stat can reach and realpath
// can't, as under `/.vol/<dev>/<inode>`, is refused, and so are the macOS alias folders `/.vol`, `/.nofollow` and
// `/.resolve` and everything under them, which no person picks as a folder (gate pass 55, M-1; pass 56, M-1). Observed on macOS 27
// with `stat -f '%d %i'`, 2026-11-02: `/` is 16777234/2 and the data volume 16777234/1152921500311879682, an inode
// above 2^53, so the stats are read as bigints. Other mount points, such as an external drive's root, a disk image or
// a network share, are places to work and pass (gate pass 54, M-3).

import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/** What a launch, a resume, a move or a copy at the whole disk is told. */
export const WHOLE_DISK_MESSAGE = 'Choose a folder other than the whole disk.'

/** The data volume's root, which macOS links into `/` folder by folder. */
export const DATA_VOLUME = '/System/Volumes/Data'

export interface DiskIo {
  /** The real path, with its name on disk: realpathSync.native. */
  real: (path: string) => string
  /** The folder's identity, device and inode, or null when it can't be read. */
  id: (path: string) => string | null
}

const idOf = (path: string): string | null => {
  try {
    const s = statSync(path, { bigint: true })
    return `${s.dev}:${s.ino}`
  } catch {
    return null
  }
}

const fsIo: DiskIo = { real: p => realpathSync.native(p), id: idOf }

/** The macOS folders that reach other folders by another name: volfs and the no-follow and resolve forms. */
const ALIAS_FOLDERS = ['/.vol', '/.nofollow', '/.resolve']

/** Whether a path, as written or resolved, is an alias folder or under one (gate pass 55, M-1, M-2; pass 56, M-1). */
export function isAliasPath(path: string): boolean {
  return [path, resolve(path)].some(p => {
    const lower = p.toLowerCase()
    return ALIAS_FOLDERS.some(a => lower === a || lower.startsWith(`${a}/`))
  })
}

/** Whether a path, as written, names the disk root or the data volume's root: no file system access. */
export function wholeDiskPath(path: string): boolean {
  const lexical = resolve(path)
  return lexical === '/' || lexical.toLowerCase() === DATA_VOLUME.toLowerCase()
}

/**
 * Whether a folder is the disk root or the data volume's root: by its path
 * as written, an alias prefix, or the identity of the path as written or of
 * its real path. A path stat reaches and realpath can't is refused. A
 * folder that doesn't exist yet is judged by its path as written.
 */
export function isWholeDisk(path: string, io: Partial<DiskIo> = {}): boolean {
  return wholeDiskReason(path, io) !== null
}

/**
 * Why isWholeDisk refuses a folder: 'whole-disk', or 'unreadable' when stat
 * reaches it and realpath can't, so a caller can say which (gate pass 57,
 * L-1). Null when it passes.
 */
export function wholeDiskReason(path: string, io: Partial<DiskIo> = {}): 'whole-disk' | 'unreadable' | null {
  if (wholeDiskPath(path) || isAliasPath(path)) return 'whole-disk'
  // Each falls back on its own, so an override given as undefined can't drop one (gate pass 57, L-2).
  const real = io.real ?? fsIo.real
  const id = io.id ?? fsIo.id
  const roots = [id('/'), id(DATA_VOLUME)].filter((r): r is string => r !== null)
  // As written, without resolve, so a trailing slash keeps its meaning.
  const asWritten = id(path)
  if (asWritten !== null && roots.includes(asWritten)) return 'whole-disk'
  let target: string | null
  try {
    target = id(real(resolve(path)))
  } catch {
    return asWritten !== null ? 'unreadable' : null
  }
  return target !== null && roots.includes(target) ? 'whole-disk' : null
}
