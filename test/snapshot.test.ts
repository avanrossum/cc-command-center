// The public snapshot's tree (release plan §4; pass 9, M-2): HEAD minus
// scripts/snapshot-exclude.txt, computed without touching the working tree
// or the index.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { addedToConfirm, parseExcludes, readExcludes, readPublished, snapshotTree, unclassified } from '../scripts/snapshot-lib.mjs'

const dirs: string[] = []
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })))

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-snapshot-test-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'x')
  return dir
}

describe('the snapshot tree', () => {
  it('is the commit without the excluded paths, byte for byte', () => {
    const shared = { 'README.md': 'r', 'src/a.ts': 'a', 'tools/check-claude-env.ts': 'c' }
    const full = repo({ ...shared, 'CLAUDE.md': 'private', 'tools/hooks/guard.sh': 'h', '.adversary/R.md': 'r' })
    const published = repo(shared)
    const tree = snapshotTree(full, 'HEAD', ['CLAUDE.md', 'tools/hooks', '.adversary', 'not-there.md'])
    expect(tree).toBe(execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: published, encoding: 'utf8' }).trim())
    // The working tree and the index are left as they were.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: full, encoding: 'utf8' })).toBe('')
  })
  it("reads the repository's list, which keeps the private records and hooks out and the code in", () => {
    const list = readExcludes(join(import.meta.dirname, '..'))
    expect(list).toEqual(expect.arrayContaining(['CLAUDE.md', 'BRIEF.md', 'DECISIONS.md', '.adversary', 'tools/hooks']))
    // Code stays in; of scripts/, only the hand-edited release state is left out.
    expect(list.some(p => p.startsWith('src') || p.startsWith('packages') || (p.startsWith('scripts') && p !== 'scripts/release-window.json'))).toBe(false)
    expect(parseExcludes('# c\n\n a \nb\n')).toEqual(['a', 'b'])
    expect(readFileSync(join(import.meta.dirname, '..', 'scripts', 'snapshot-exclude.txt'), 'utf8')).toMatch(/42340178/)
  })
})

describe('what a snapshot publishes (pass 10, M-4)', () => {
  const root = join(import.meta.dirname, '..')
  it("names every top-level entry, and every entry under tools/ and scripts/, in one of the two lists", () => {
    expect(unclassified(root, 'HEAD', readExcludes(root), readPublished(root))).toEqual([])
    const both = readExcludes(root).filter(e => readPublished(root).includes(e))
    expect(both).toEqual([])
  })
  it('catches a new file named in neither list', () => {
    const r = repo({ 'README.md': 'r', 'tasks/plan.md': 'private', 'scripts/new.mjs': 'x', 'tools/hooks/h.sh': 'h' })
    expect(unclassified(r, 'HEAD', ['tools/hooks'], ['README.md', 'scripts', 'tools'])).toEqual(['tasks', 'scripts/new.mjs'])
  })
})

describe("0.24's changelog.json at the root, which installed 0.24 builds read from the public main (MIP2-61)", () => {
  const log = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'changelog.json'), 'utf8')) as { versions: { version: string; date?: string; critical?: boolean; features: string[] }[] }
  it('has the farewell release on top, critical, so 0.24 offers no Skip', () => {
    const top = log.versions[0]
    expect(top?.version).toBe('0.25.0')
    expect(top?.critical).toBe(true)
    expect(top?.features.length).toBeGreaterThan(0)
  })
  it("keeps the shape 0.24's reader takes: versions, each with a version and a list of features", () => {
    for (const v of log.versions) {
      expect(v.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/)
      expect(Array.isArray(v.features)).toBe(true)
      expect(v.features.every(f => typeof f === 'string')).toBe(true)
    }
  })
})

describe('the new paths a snapshot asks about (pass 11, M-2)', () => {
  it('catches a new file under docs/ or test/fixtures/ named in neither list', () => {
    const r = repo({ 'README.md': 'r', 'docs/notes-with-a-client.md': 'private', 'test/fixtures/dump.json': '{}', 'test/a.test.ts': 'x', 'src/a.ts': 'x' })
    expect(unclassified(r, 'HEAD', [], ['README.md', 'docs', 'test', 'src'])).toEqual(['docs/notes-with-a-client.md', 'test/fixtures/dump.json'])
  })
  it('asks for each added path outside src/ and test/, and each new fixture, by name', () => {
    const diff = ['A\tdocs/new.md', 'A\tsrc/main/x.ts', 'A\ttest/x.test.ts', 'A\ttest/fixtures/f.json', 'M\tREADME.md', 'A\tresources/icon2.png', 'D\tdocs/old.md'].join('\n')
    expect(addedToConfirm(diff)).toEqual(['docs/new.md', 'test/fixtures/f.json', 'resources/icon2.png'])
  })
  it('asks about a renamed or copied file at its new path (pass 12, M-1)', () => {
    expect(addedToConfirm('R071\tbuild/old.txt\tdocs/secret.md\nC080\tsrc/a.ts\tresources/b.txt\nR100\tdocs/a.md\tsrc/a.md\nA\tdocs/new.md')).toEqual(['docs/secret.md', 'resources/b.txt', 'docs/new.md'])
  })
})
