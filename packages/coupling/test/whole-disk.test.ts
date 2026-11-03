// The one rule for a folder no session may run in (MIP2-1603, MIP2-1626, MIP2-1627; gate passes 53 and 54): the disk
// root and the data volume's root, by identity. On this Mac's real paths as observed with `stat`, 2026-11-02.

import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAliasPath, isWholeDisk, WHOLE_DISK_MESSAGE, wholeDiskPath } from '../src/whole-disk.ts'

const onMac = existsSync('/System/Volumes/Data')

describe('isWholeDisk', () => {
  it('refuses the root and the data volume, by path, in any letter case, or through a link', () => {
    expect(isWholeDisk('/')).toBe(true)
    expect(isWholeDisk('/./')).toBe(true)
    expect(isWholeDisk('/System/Volumes/Data')).toBe(true)
    expect(isWholeDisk('/System/Volumes/Data/')).toBe(true)
    if (onMac) {
      // The case variants gate pass 54 found passing (M-1), and a path that only reaches the volume through `..`.
      for (const p of ['/system/volumes/data', '/SYSTEM/VOLUMES/DATA', '/System/Volumes/data', '/System/Volumes/Data/Users/..']) expect(isWholeDisk(p), p).toBe(true)
      if (existsSync('/Volumes/Macintosh HD')) expect(isWholeDisk('/Volumes/Macintosh HD')).toBe(true)
    }
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-disk-')))
    try {
      symlinkSync('/', join(dir, 'root'))
      expect(isWholeDisk(join(dir, 'root'))).toBe(true)
      if (onMac) {
        symlinkSync('/System/Volumes/Data', join(dir, 'data'))
        expect(isWholeDisk(join(dir, 'data'))).toBe(true)
      }
      expect(isWholeDisk(dir)).toBe(false)
      // Not made yet: judged by its path as written.
      expect(isWholeDisk(join(dir, 'later'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes the folders under the root, and another volume\'s root (gate pass 54, M-3)', () => {
    for (const p of ['/Users', '/Applications', '/private/tmp']) if (existsSync(p)) expect(isWholeDisk(p), p).toBe(false)
    // An external drive's root: its own device, a place to work.
    // Distinct identities, so the second case can pass only through its real path (gate pass 56, L-4).
    const io = { real: (p: string) => p, id: (p: string) => ({ '/Volumes/Code': '9:2', '/': '1:2', '/System/Volumes/Data': '1:7' })[p] ?? '1:99' }
    expect(isWholeDisk('/Volumes/Code', io)).toBe(false)
    expect(isWholeDisk('/Volumes/Root', { real: () => '/', id: io.id })).toBe(true)
    expect(isWholeDisk('/Volumes/Data2', { real: () => '/System/Volumes/Data', id: io.id })).toBe(true)
    expect(isWholeDisk('/Volumes/Root', io)).toBe(false)
  })

  // Through the DiskIo stub, so they run on any host (gate pass 55, L-4). The root is 7:2 and the data volume
  // 7:1152921500311879682, as on this Mac; everything else is 7:9.
  const ids: Record<string, string> = { '/': '7:2', '/System/Volumes/Data': '7:1152921500311879682' }
  const stub = (written: Record<string, string>, real: (p: string) => string = p => p) => ({ real, id: (p: string) => written[p] ?? ids[p] ?? '7:9' })
  const noReal = () => {
    throw new Error('ENOENT')
  }

  it('refuses the alias prefixes outright, whatever they reach (gate pass 55, M-1)', () => {
    const io = stub({})
    for (const p of ['/.vol', '/.vol/', '/.resolve', '/.resolve/', '/.vol/7/2', '/.vol/7/1152921500311879682', '/.vol/7/12345', '/.nofollow/', '/.nofollow', '/.nofollow/Users', '/.resolve/1/2', '//.vol/7/2', '/.VOL/7/2'])
      expect(isWholeDisk(p, io), p).toBe(true)
    // Only the folders and what's under them (gate pass 56, M-1, L-3).
    expect(['/.volume', '/.resolved', '/.nofollowx', '/.nofollow-data', '/w/.vol/7/2'].map(isAliasPath)).toEqual([false, false, false, false, false])
  })

  it('refuses a path whose identity as written is the root or the data volume, though its resolved form differs', () => {
    // A trailing slash that changes the folder, as `/.nofollow/` does: refused by the identity as written.
    expect(isWholeDisk('/odd/', stub({ '/odd/': '7:2' }))).toBe(true)
    expect(isWholeDisk('/odd/', stub({ '/odd/': '7:1152921500311879682' }))).toBe(true)
    expect(isWholeDisk('/odd', stub({}))).toBe(false)
  })

  it('refuses a path stat reaches and realpath can\'t, and judges a missing one by its spelling', () => {
    expect(isWholeDisk('/volfs/7/12345', stub({ '/volfs/7/12345': '7:12345' }, noReal))).toBe(true)
    expect(isWholeDisk('/w/later', { real: noReal, id: p => ids[p] ?? null })).toBe(false)
  })

  it('judges a path as written without the file system, for the store', () => {
    expect(['/', '/System/Volumes/Data', '/system/volumes/data/', '/w/..'].map(wholeDiskPath)).toEqual([true, true, true, true])
    expect(['/w', '/Volumes/Macintosh HD', '/System/Volumes/Data/Users'].map(wholeDiskPath)).toEqual([false, false, false])
  })

  it('has one message', () => {
    expect(WHOLE_DISK_MESSAGE).toBe('Choose a folder other than the whole disk.')
  })
})
