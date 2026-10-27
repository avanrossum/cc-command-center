// The read-only import from Electron CCCC's registry (MIP2-1409). The
// fixture is made read-only, file and folder, and its hash and mtime are
// checked before and after: the import never writes it.

import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importRegistry, REGISTRY_FILE } from '../src/main/registry-import.ts'
import { A, B, C, makeRegistry } from './registry-fixture.ts'

let dir: string

function fingerprint(folder: string): string[] {
  return ['', '-wal', '-shm'].map(s => {
    try {
      const p = join(folder, REGISTRY_FILE + s)
      return `${s}:${createHash('sha256').update(readFileSync(p)).digest('hex')}:${statSync(p).mtimeMs}`
    } catch {
      return `${s}:absent`
    }
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-reg-'))
  makeRegistry(dir)
})
afterEach(() => {
  chmodSync(dir, 0o700)
  rmSync(dir, { recursive: true, force: true })
})

describe('importRegistry', () => {
  it('reads a read-only registry and leaves every file byte for byte and mtime unchanged', () => {
    for (const s of ['', '-wal', '-shm']) {
      try {
        chmodSync(join(dir, REGISTRY_FILE + s), 0o444)
      } catch {
        // A file SQLite didn't leave behind.
      }
    }
    chmodSync(dir, 0o555)
    const before = fingerprint(dir)
    const r = importRegistry(dir)
    expect(fingerprint(dir)).toEqual(before)
    expect(r.counts).toEqual({ categories: 3, sessions: 3, named: 3, categorized: 2 })
  })

  it('maps categories in sort order, with labels, colors and the Arbiter flag (D-016)', () => {
    const { categories } = importRegistry(dir)
    expect(categories.map(c => [c.id, c.name, c.label, c.color, c.emoji, c.sort])).toEqual([
      ['c12', 'Acme - Platform v2', 'PLAT V2', '#9bbf4a', '👥', 0],
      ['c3', 'Acme General', 'AC-gen', '#4ac0e2', '', 1],
      // An invalid stored color falls back to the palette by position.
      ['c21', 'Acme Governance', 'ACMg', '#e2724a', '🔥', 2],
    ])
    // D-016 "Import as they are": each keeps its own Arbiter setting.
    expect(categories.map(c => c.arbiterReadsText)).toEqual([true, true, false])
    // 0.24's notify columns (MIP2-1387 §3.1): permission, else question, sets Needs you;
    // Your turn starts auto and notify_done is dropped.
    expect(categories.map(c => [c.notifyNeeds, c.notifyTurn])).toEqual([
      ['off', 'auto'], // permission NULL, question 0
      ['on', 'auto'], // permission 1 wins over question 0
      ['off', 'auto'], // permission 0 wins over question 1
    ])
    expect(categories.every(c => c.isolation === 'none')).toBe(true)
  })

  it('maps sessions: names, aliases, category, launch flags, and names from sessionNames', () => {
    const { sessions } = importRegistry(dir)
    expect(sessions[A]).toMatchObject({ name: 'production-log', categoryId: 'c3', placedBy: 'import' })
    expect(sessions[B]).toMatchObject({ alias: 'platform-investigation', categoryId: 'c12', resumeFlags: { model: 'opus', effort: 'ultracode' } })
    expect(sessions[C]).toMatchObject({ name: 'bbrl-6b', categoryId: null, placedBy: null })
    expect(sessions['not-a-uuid']).toBeUndefined()
  })

  it('maps the settings the import maps list (MIP2-1387 §2.4)', () => {
    expect(importRegistry(dir).settings).toEqual({
      recentFolders: ['/Users/x/a', '/Users/x/b'],
      lastModel: 'opus',
      lastEffort: 'xhigh',
      lastMode: 'auto',
      terminalFont: 'Fira Mono',
      terminalFontSize: 18,
      importedHideUnmanaged: true,
      notifyEnabled: true,
    })
  })

  it('refuses a schema it does not read', () => {
    const other = mkdtempSync(join(tmpdir(), 'ccc-reg-'))
    makeRegistry(other, 19)
    expect(() => importRegistry(other)).toThrow('registry schema 19')
    rmSync(other, { recursive: true, force: true })
  })
})
