// Categories assign themselves (spec MIP2-1370 §7). Alex: "if the conditions
// are right, prefer the category." Pure: the folder checks are passed in.

import type { Category } from './store.ts'

/**
 * The folder key: the git repository root of the session's folder, or the
 * folder itself outside a repository. A worktree under
 * `<repo>/.claude/worktrees/<name>` keys to its main repository (§5.2).
 */
export function folderKeyOf(cwd: string, isRepoRoot: (dir: string) => boolean): string {
  const wt = cwd.indexOf('/.claude/worktrees/')
  let dir = wt >= 0 ? cwd.slice(0, wt) : cwd.replace(/\/+$/, '') || '/'
  for (let d = dir; d && d !== '/'; d = d.slice(0, d.lastIndexOf('/')) || '/') {
    if (isRepoRoot(d)) return d
  }
  return dir
}

/** Folders that hold unrelated work and never match, explicitly or learned. */
export function broadFolders(home: string): string[] {
  return [home, `${home}/Developer`, `${home}/Documents`, `${home}/Downloads`, `${home}/Desktop`, '/tmp', '/private/tmp', '/']
}

const within = (path: string, folder: string) => path === folder || path.startsWith(folder.replace(/\/+$/, '') + '/')
const depth = (p: string) => p.split('/').filter(Boolean).length

export type AssignResult = { kind: 'assign'; categoryId: string } | { kind: 'ambiguous'; categoryIds: string[] } | { kind: 'none' }

export interface AssignInput {
  folderKey: string
  home: string
  categories: Category[]
  /** Sessions Alex placed by hand, imported ones included, with their folder keys. */
  placed: { folderKey: string; categoryId: string }[]
}

export function autoAssign({ folderKey, home, categories, placed }: AssignInput): AssignResult {
  const broad = new Set(broadFolders(home))
  if (broad.has(folderKey)) return { kind: 'none' }
  const allowed = (c: Category) => !c.notFolders.some(f => within(folderKey, f))

  // Explicit: the key is, or is inside, a folder listed for the category.
  const explicit: { id: string; depth: number }[] = []
  for (const c of categories) {
    if (!allowed(c)) continue
    for (const f of c.folders) {
      if (!broad.has(f) && within(folderKey, f)) explicit.push({ id: c.id, depth: depth(f) })
    }
  }
  // Learned: every hand-placed session with this key is in one category, and there is at least one.
  const learnedIds = new Set(placed.filter(p => p.folderKey === folderKey).map(p => p.categoryId))
  const learned = learnedIds.size === 1 ? [...learnedIds].filter(id => categories.some(c => c.id === id && allowed(c))) : []

  const best = Math.max(-1, ...explicit.map(e => e.depth), ...(learned.length ? [depth(folderKey)] : []))
  if (best < 0) return { kind: 'none' }
  // Explicit wins a tie at the same depth.
  const atBestExplicit = [...new Set(explicit.filter(e => e.depth === best).map(e => e.id))]
  const winners = atBestExplicit.length > 0 ? atBestExplicit : depth(folderKey) === best ? learned : []
  if (winners.length === 1) return { kind: 'assign', categoryId: winners[0]! }
  if (winners.length > 1) return { kind: 'ambiguous', categoryIds: winners }
  return { kind: 'none' }
}
