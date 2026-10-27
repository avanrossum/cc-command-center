// The reporter mod's hash at build time (gate run 2, M-3): the same
// function src/main/reporter-mod.ts uses, so the two can't drift.
// Every regular file, Claude Code's .claude-plugin/types/ aside, sorted,
// each as its relative path, NUL, its bytes, NUL.
//
// That stream reads back one way only when no path or file holds a NUL, so
// a file containing one, or a symlink, gets no hash: "refused: …", which
// never matches a folder name or the built hash (pass 4, L-4). Otherwise a
// file could carry the files sorted after it inside its own bytes. The
// shipped mod has neither, and a copy with one is treated as changed.

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export function modHashOf(dir) {
  const types = join('.claude-plugin', 'types')
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() || e.isSymbolicLink())
    .map(e => join(e.parentPath, e.name))
    .filter(f => {
      const rel = relative(dir, f)
      return rel !== types && !rel.startsWith(types + sep)
    })
    .sort()
  const h = createHash('sha256')
  for (const f of files) {
    const rel = relative(dir, f)
    if (lstatSync(f).isSymbolicLink()) return `refused: ${rel} is a symlink`
    const bytes = readFileSync(f)
    if (bytes.includes(0)) return `refused: ${rel} contains a NUL byte`
    h.update(rel).update('\0').update(bytes).update('\0')
  }
  return h.digest('hex').slice(0, 16)
}
