// Where the folder picker opens (MIP2-2073; gate pass 63, L-3).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isFolderBounded, PICKER_START_MS, pickerStart } from '../src/main/folder-start.ts'

describe('pickerStart', () => {
  const folders = new Set(['/Users/a', '/Users/a/work', '/Users/a/work/site'])
  const isFolder = async (p: string) => folders.has(p)

  it('opens at the folder the sheet shows, else the last one, else home', async () => {
    expect(await pickerStart(['/Users/a/work/site', '/Users/a/work'], '/Users/a', isFolder)).toBe('/Users/a/work/site')
    expect(await pickerStart([undefined, '/Users/a/work'], '/Users/a', isFolder)).toBe('/Users/a/work')
    expect(await pickerStart([undefined, undefined], '/Users/a', isFolder)).toBe('/Users/a')
  })

  it('opens a folder that\'s gone at its nearest folder that exists, never the disk root', async () => {
    expect(await pickerStart(['/Users/a/work/old/deeper'], '/Users/a', isFolder)).toBe('/Users/a/work')
    expect(await pickerStart(['/Volumes/gone/x'], '/Users/a', isFolder)).toBe('/Users/a')
  })

  it('skips what isn\'t an absolute path, and the /net automounts', async () => {
    const asked: string[] = []
    const watching = async (p: string) => (asked.push(p), folders.has(p))
    expect(await pickerStart(['work', '', 3, '/x\0y', '/net/host/share', '/tmp/../net/host', '/Users/a/work'], '/Users/a', watching)).toBe('/Users/a/work')
    expect(asked).toEqual(['/Users/a/work'])
  })

  it('gives up for home once looking takes too long in all (gate pass 63, L-3)', async () => {
    let t = 0
    const slow = async () => ((t += PICKER_START_MS / 2 + 1), false)
    expect(await pickerStart(['/a/b/c/d/e'], '/Users/a', slow, () => t)).toBe('/Users/a')
  })
})

describe('isFolderBounded', () => {
  it('says a folder is one, and a missing path isn\'t', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccc-picker-'))
    try {
      expect(await isFolderBounded(dir)).toBe(true)
      expect(await isFolderBounded(join(dir, 'missing'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('one look at a time (gate pass 64, M-2)', () => {
  it('makes no new stat while an earlier one hasn\'t settled, and looks again once it has', async () => {
    let release: (v: boolean) => void = () => {}
    let looks = 0
    const stalled = () => (looks++, new Promise<boolean>(r => (release = r)))
    expect(await isFolderBounded('/Volumes/share/a', 10, stalled)).toBe(false)
    expect(await isFolderBounded('/Volumes/share', 10, stalled)).toBe(false)
    expect(looks).toBe(1)
    release(true)
    await new Promise(r => setTimeout(r, 0))
    expect(await isFolderBounded('/Users', 100, async () => (looks++, true))).toBe(true)
    expect(looks).toBe(2)
  })
})

