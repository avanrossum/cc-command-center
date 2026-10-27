// Auto-assign (spec MIP2-1370 §7, MIP2-1409).

import { describe, expect, it } from 'vitest'
import { autoAssign, folderKeyOf } from '../src/shared/auto-assign.ts'
import type { Category } from '../src/shared/store.ts'

const HOME = '/Users/x'
const cat = (id: string, over: Partial<Category> = {}): Category => ({
  id, name: id, color: '#4ac0e2', label: '', emoji: '', sort: 0, folders: [], notFolders: [], isolation: 'none', arbiterReadsText: false, collapsed: false, ...over,
})

describe('folderKeyOf', () => {
  const repos = new Set(['/Users/x/Developer/app', '/Users/x/Developer/app/vendor/nested'])
  const isRoot = (d: string) => repos.has(d)
  it.each([
    ['/Users/x/Developer/app/src/lib', '/Users/x/Developer/app'],
    ['/Users/x/Developer/app', '/Users/x/Developer/app'],
    ['/Users/x/Developer/app/.claude/worktrees/fix-1', '/Users/x/Developer/app'],
    ['/Users/x/Developer/app/vendor/nested/x', '/Users/x/Developer/app/vendor/nested'],
    ['/Users/x/notes', '/Users/x/notes'],
  ])('%s → %s', (cwd, key) => expect(folderKeyOf(cwd, isRoot)).toBe(key))
})

describe('autoAssign', () => {
  const app = '/Users/x/Developer/app'

  it('assigns from a listed folder, the key being it or inside it', () => {
    const categories = [cat('a', { folders: ['/Users/x/Developer'] }), cat('b', { folders: [app] })]
    // ~/Developer is broad, so only b's folder counts.
    expect(autoAssign({ folderKey: app, home: HOME, categories, placed: [] })).toEqual({ kind: 'assign', categoryId: 'b' })
    expect(autoAssign({ folderKey: `${app}/pkg`, home: HOME, categories, placed: [] })).toEqual({ kind: 'assign', categoryId: 'b' })
  })

  it('learns from hand-placed sessions, only when they all agree', () => {
    const categories = [cat('a'), cat('b')]
    expect(autoAssign({ folderKey: app, home: HOME, categories, placed: [{ folderKey: app, categoryId: 'a' }, { folderKey: app, categoryId: 'a' }] })).toEqual({ kind: 'assign', categoryId: 'a' })
    expect(autoAssign({ folderKey: app, home: HOME, categories, placed: [{ folderKey: app, categoryId: 'a' }, { folderKey: app, categoryId: 'b' }] })).toEqual({ kind: 'none' })
    expect(autoAssign({ folderKey: app, home: HOME, categories, placed: [] })).toEqual({ kind: 'none' })
  })

  it('prefers the most specific folder, and explicit over learned at the same depth', () => {
    const categories = [cat('outer', { folders: ['/Users/x/Developer/work'] }), cat('inner', { folders: ['/Users/x/Developer/work/app'] }), cat('learned')]
    const key = '/Users/x/Developer/work/app'
    expect(autoAssign({ folderKey: key, home: HOME, categories, placed: [{ folderKey: key, categoryId: 'learned' }] })).toEqual({ kind: 'assign', categoryId: 'inner' })
  })

  it('assigns nothing when two categories match equally', () => {
    const categories = [cat('a', { folders: [app] }), cat('b', { folders: [app] })]
    expect(autoAssign({ folderKey: app, home: HOME, categories, placed: [] })).toEqual({ kind: 'ambiguous', categoryIds: ['a', 'b'] })
  })

  it('never matches a broad folder, explicitly or learned', () => {
    const categories = [cat('a', { folders: [HOME] })]
    for (const key of [HOME, `${HOME}/Developer`, `${HOME}/Downloads`, '/tmp', '/']) {
      expect(autoAssign({ folderKey: key, home: HOME, categories, placed: [{ folderKey: key, categoryId: 'a' }] })).toEqual({ kind: 'none' })
    }
  })

  it('respects "Not <category>"', () => {
    const categories = [cat('a', { folders: [app], notFolders: [app] })]
    expect(autoAssign({ folderKey: app, home: HOME, categories, placed: [] })).toEqual({ kind: 'none' })
  })
})
