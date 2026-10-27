// Gate H-2 (MIP2-1429): the packaged build's fuses, and the QA-only binary override.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs build script, without types.
import { REQUIRED_FUSES, wrongFuses } from '../scripts/fuses.mjs'
import { checkClaudeBinOverride } from '../src/main/paths.ts'

type Fuse = { index: number; name: string; key: string; on: boolean }
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { build: { electronFuses: Record<string, boolean> }; scripts: Record<string, string> }

describe('fuses', () => {
  it('sets every required fuse in the build config, and checks the built app after packaging', () => {
    for (const f of REQUIRED_FUSES as Fuse[]) expect(pkg.build.electronFuses[f.key], f.name).toBe(f.on)
    expect(pkg.scripts.package).toContain('scripts/check-fuses.mjs')
  })

  it("fails on Electron's defaults and passes the flipped wire", () => {
    // The wire read from the 4399a90 build: Electron's defaults.
    const defaults = [...'101100011'].map(c => (c === '1' ? 49 : 48))
    expect(wrongFuses(defaults)).toEqual([
      'RunAsNode should be off',
      'EnableCookieEncryption should be on',
      'EnableNodeOptionsEnvironmentVariable should be off',
      'EnableNodeCliInspectArguments should be off',
      'EnableEmbeddedAsarIntegrityValidation should be on',
      'OnlyLoadAppFromAsar should be on',
      'GrantFileProtocolExtraPrivileges should be off',
    ])
    const flipped = [48, 49, 48, 48, 49, 49, 48, 48]
    expect(wrongFuses(flipped)).toEqual([])
  })
})

describe('CCC_CLAUDE_BIN (gate L-1)', () => {
  it('is refused outside an unpackaged QA run', () => {
    expect(() => checkClaudeBinOverride({ CCC_CLAUDE_BIN: '/tmp/claude' }, true)).toThrow('CCC_CLAUDE_BIN needs CCC_QA=1')
    expect(() => checkClaudeBinOverride({ CCC_CLAUDE_BIN: '/tmp/claude' }, false)).toThrow()
    expect(() => checkClaudeBinOverride({ CCC_CLAUDE_BIN: '/tmp/claude', CCC_QA: '1' }, false)).not.toThrow()
    expect(() => checkClaudeBinOverride({}, true)).not.toThrow()
  })
})

describe('instance isolation (gate run 3, L-7)', () => {
  it('refuses a separate data folder on the default channel root', async () => {
    const { resolveChannelRoot } = await import('../src/main/paths.ts')
    expect(() => resolveChannelRoot({ CCC_USER_DATA: '/tmp/x' }, '/Users/x/.ccc/ch')).toThrow('CCC_USER_DATA needs CCC_CHANNEL_ROOT')
    expect(resolveChannelRoot({ CCC_USER_DATA: '/tmp/x', CCC_CHANNEL_ROOT: '/tmp/ccc-x/ch' }, '/Users/x/.ccc/ch')).toBe('/tmp/ccc-x/ch')
    expect(resolveChannelRoot({}, '/Users/x/.ccc/ch')).toBe('/Users/x/.ccc/ch')
  })
})
