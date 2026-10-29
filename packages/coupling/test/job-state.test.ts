// A background session's saved launch options (Research MIP2-1506): read only, safely, and refused on any shape but
// the one observed (MIP2-1504; gate pass 17, M-1, M-2).

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeConfigDir, readSavedOptions, readStateFile, STATE_MAX_BYTES } from '../src/job-state.ts'

const SID = 'c0ffee01-0000-4000-8000-000000000001'
const at = (state: unknown) => (path: string) => {
  expect(path).toBe('/cfg/jobs/c0ffee01/state.json')
  return typeof state === 'string' ? state : JSON.stringify(state)
}
const flags = (...f: string[]) => ['--name', 'r1504', ...f, '--model', 'haiku']
const both = (dir = '/data/reporter-mod/abcdef0123456789', settings = '/ch/1/settings.json') => flags('--settings', settings, '--plugin-dir', dir)

describe('readSavedOptions (MIP2-1504; gate pass 17, M-1)', () => {
  it('reads --plugin-dir and --settings, resolving a relative one against the cwd, as Claude Code saves it as given', () => {
    expect(readSavedOptions('/cfg', 'c0ffee01', SID, at({ sessionId: SID, cwd: '/w', respawnFlags: both() }))).toEqual({
      dir: '/data/reporter-mod/abcdef0123456789',
      settings: '/ch/1/settings.json',
      flags: both(),
      cwd: '/w',
    })
    expect(readSavedOptions('/cfg', 'c0ffee01', SID, at({ sessionId: SID, cwd: '/w/a', respawnFlags: both('../mod', 's.json') }))).toEqual({ dir: '/w/mod', settings: '/w/a/s.json', flags: both('../mod', 's.json'), cwd: '/w/a' })
    // The folder it restarts in is required (gate pass 19, M-2).
    expect(readSavedOptions('/cfg', 'c0ffee01', SID, at({ sessionId: SID, respawnFlags: both() }))).toMatchObject({ refused: expect.stringMatching(/unexpected shape/) })
  })

  it('refuses a missing file, bad JSON, another session, or any other shape, and never guesses', () => {
    const missing = () => {
      throw new Error('ENOENT')
    }
    const cases: [unknown, RegExp][] = [
      ['{not json', /aren't readable JSON/],
      [[], /unexpected shape/],
      [{ sessionId: 'c0ffee02-0000-4000-8000-000000000002', cwd: '/w', respawnFlags: both() }, /another session/],
      [{ sessionId: SID, cwd: '/w' }, /unexpected shape/],
      [{ sessionId: SID, cwd: '/w', respawnFlags: [1, 2] }, /unexpected shape/],
      [{ sessionId: SID, cwd: '/w', respawnFlags: flags('--settings', '/s') }, /unexpected shape/],
      [{ sessionId: SID, cwd: '/w', respawnFlags: flags('--plugin-dir', '/m') }, /unexpected shape/],
      [{ sessionId: SID, cwd: '/w', respawnFlags: [...both(), '--plugin-dir', '/b'] }, /unexpected shape/],
      [{ sessionId: SID, cwd: '/w', respawnFlags: flags('--plugin-dir=/a', '--settings', '/s') }, /unexpected shape/],
      [{ sessionId: SID, cwd: '/w', respawnFlags: ['--settings', '/s', '--plugin-dir'] }, /unexpected shape/],
      [{ sessionId: SID, cwd: '/w', respawnFlags: ['--settings', '/s', '--plugin-dir', '--model'] }, /unexpected shape/],
      [{ sessionId: SID, respawnFlags: both('rel/mod') }, /unexpected shape/],
    ]
    for (const [state, why] of cases) expect(readSavedOptions('/cfg', 'c0ffee01', SID, at(state))).toMatchObject({ refused: expect.stringMatching(why) })
    expect(readSavedOptions('/cfg', 'c0ffee01', SID, missing)).toEqual({ refused: "Claude Code's saved options for it can't be read" })
    expect(readSavedOptions('/cfg', '../etc', SID, missing)).toMatchObject({ refused: expect.stringMatching(/short id/) })
  })

  it("uses $CLAUDE_CONFIG_DIR when set, as the app's own claude commands do", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/Users/x/.claude-ccc-qa' })).toBe('/Users/x/.claude-ccc-qa')
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'relative' })).toMatch(/\.claude$/)
  })
})

describe('readStateFile (gate pass 17, M-2)', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ccc-state-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads a small regular file', () => {
    writeFileSync(join(dir, 'state.json'), '{"a":1}')
    expect(readStateFile(join(dir, 'state.json'))).toBe('{"a":1}')
  })

  it('refuses a FIFO without blocking, a link, and a file over the cap in bytes', () => {
    execFileSync('mkfifo', [join(dir, 'fifo')])
    const t0 = Date.now()
    expect(() => readStateFile(join(dir, 'fifo'))).toThrow('not a regular file')
    expect(Date.now() - t0).toBeLessThan(1_000)
    writeFileSync(join(dir, 'real.json'), '{}')
    symlinkSync(join(dir, 'real.json'), join(dir, 'link.json'))
    expect(() => readStateFile(join(dir, 'link.json'))).toThrow()
    // Multi-byte characters: the cap is bytes, not string length.
    writeFileSync(join(dir, 'big.json'), 'é'.repeat(STATE_MAX_BYTES / 2 + 1))
    expect(() => readStateFile(join(dir, 'big.json'))).toThrow('too large')
  })
})
