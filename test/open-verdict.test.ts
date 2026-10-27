// "Open in its app" on a file a session wrote (gate M-3, MIP2-1431).

import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openVerdict } from '../src/main/artifact-preview.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-open-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const file = (name: string, mode = 0o644) => {
  const p = join(dir, name)
  writeFileSync(p, 'x', { mode })
  return openVerdict(p, lstatSync(p))
}

describe('openVerdict', () => {
  it('opens documents and images straight away', () => {
    for (const n of ['notes.md', 'report.pdf', 'chart.png', 'data.csv', 'deck.pptx']) expect(file(n).kind, n).toBe('open')
  })

  it('never opens a launcher, a web page or a script type, only reveals it', () => {
    for (const n of ['release-notes.command', 'x.terminal', 'x.tool', 'x.workflow', 'x.webloc', 'x.fileloc', 'page.html', 'pic.svg', 'x.scpt']) {
      expect(file(n), n).toMatchObject({ kind: 'refuse' })
    }
  })

  it('refuses any file with the execute bit, whatever its name', () => {
    expect(file('notes.md', 0o755)).toMatchObject({ kind: 'refuse', why: expect.stringContaining('run as a program') })
  })

  it('refuses a symlink and a folder or bundle', () => {
    writeFileSync(join(dir, 'real.md'), 'x')
    symlinkSync(join(dir, 'real.md'), join(dir, 'link.md'))
    expect(openVerdict(join(dir, 'link.md'), lstatSync(join(dir, 'link.md')))).toMatchObject({ kind: 'refuse' })
    mkdirSync(join(dir, 'Thing.app'))
    expect(openVerdict(join(dir, 'Thing.app'), lstatSync(join(dir, 'Thing.app')))).toMatchObject({ kind: 'refuse' })
  })

  it('asks first, naming the type, for anything else', () => {
    expect(file('build.zip')).toEqual({ kind: 'confirm', type: '.zip file' })
    expect(file('Makefile')).toEqual({ kind: 'confirm', type: 'file with no extension' })
    expect(file('run.sh')).toEqual({ kind: 'confirm', type: '.sh file' })
  })
})

describe('droppedPaths (gate L-5)', () => {
  it('keeps absolute paths and drops any with control characters', async () => {
    const { droppedPaths } = await import('../src/main/validate.ts')
    expect(droppedPaths(['/a/b c.txt', '/x\r/y', '/esc\u001b[31m', 'relative', 42, '/del\u007f'])).toEqual(['/a/b c.txt'])
  })
})

describe('macro-capable Office formats (gate run 2, L-2)', () => {
  it('asks before opening .doc, .xls and .ppt', () => {
    for (const n of ['a.doc', 'b.xls', 'c.ppt']) expect(file(n).kind, n).toBe('confirm')
    expect(file('d.docx').kind).toBe('open')
  })
})

describe('recheckBeforeOpen (gate run 3, L-3)', () => {
  it('opens a file under a symlinked folder, and refuses a swap', async () => {
    const { recheckBeforeOpen } = await import('../src/main/artifact-preview.ts')
    const real = join(dir, 'real')
    mkdirSync(real)
    writeFileSync(join(real, 'notes.md'), 'x')
    symlinkSync(real, join(dir, 'linked'))
    const viaLink = join(dir, 'linked', 'notes.md')
    const st = lstatSync(viaLink)
    // The folder is a link, the file isn't: it opens, by its real path.
    expect(recheckBeforeOpen(viaLink, st)).toBe(join(realpathSync(real), 'notes.md'))
    // Swapped for another file after the first check: refused.
    rmSync(join(real, 'notes.md'))
    writeFileSync(join(real, 'notes.md'), 'y')
    expect(recheckBeforeOpen(viaLink, st)).toEqual({ error: 'The file changed while opening it, so it opens only from Finder.' })
    // Swapped for a link: refused.
    rmSync(join(real, 'notes.md'))
    writeFileSync(join(dir, 'evil.command'), 'x')
    symlinkSync(join(dir, 'evil.command'), join(real, 'notes.md'))
    expect(recheckBeforeOpen(viaLink, st)).toMatchObject({ error: expect.any(String) })
  })
})
