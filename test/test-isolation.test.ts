// A dry-run test build never resolves to the app's own data folder, its
// channels or the main Claude config, whatever its environment says
// (MIP2-1469, dry run 3).

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CHANNEL_ROOT } from '@ccc/coupling'
import { resolveChannelRoot, resolveUserData, userDataPath } from '../src/main/paths.ts'
import { isolatedEnv, runFolderRefusal, TEST_RUN_FOLDER, testIsolation } from '../src/main/test-isolation.ts'

const HOME = '/Users/someone'
const APP_DATA = join(HOME, 'Library', 'Application Support')
const FEED = 'http://127.0.0.1:8791'

describe('a test-feed build', () => {
  const isolation = testIsolation(FEED, HOME)

  it('resolves to its own data folder, channel root and Claude config, from a bare environment', () => {
    const env = isolatedEnv({}, isolation)
    const userData = resolveUserData(env, APP_DATA)
    expect(userData).toBe(join(TEST_RUN_FOLDER, 'data'))
    expect(userData).not.toBe(userDataPath(APP_DATA))
    expect(resolveChannelRoot(env, DEFAULT_CHANNEL_ROOT)).toBe(join(TEST_RUN_FOLDER, 'ch'))
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(HOME, '.claude-ccc-qa'))
    expect(isolation?.claudeSettings).toBe(join(HOME, '.claude-ccc-qa', 'settings.json'))
  })
  it('wins over an environment pointing at the real folders or the main config', () => {
    const env = isolatedEnv({ CCC_USER_DATA: userDataPath(APP_DATA), CCC_CHANNEL_ROOT: DEFAULT_CHANNEL_ROOT, CLAUDE_CONFIG_DIR: join(HOME, '.claude') }, isolation)
    expect(resolveUserData(env, APP_DATA)).not.toBe(userDataPath(APP_DATA))
    expect(resolveChannelRoot(env, DEFAULT_CHANNEL_ROOT)).not.toBe(DEFAULT_CHANNEL_ROOT)
    expect(env.CLAUDE_CONFIG_DIR).not.toBe(join(HOME, '.claude'))
    expect(isolation?.claudeSettings).not.toBe(join(HOME, '.claude', 'settings.json'))
  })
})

describe('any other build', () => {
  it('is left as its environment says', () => {
    expect(testIsolation(null, HOME)).toBeNull()
    const env = { CLAUDE_CONFIG_DIR: join(HOME, '.claude') }
    expect(isolatedEnv(env, testIsolation(null, HOME))).toBe(env)
  })
})

describe("the test build's run folder (pass 9, L-3)", () => {
  const mine = { isDirectory: true, isSymbolicLink: false, uid: 501, mode: 0o40700 }
  it('is used only when it is a real directory of this user', () => {
    expect(runFolderRefusal(mine, 501)).toBeNull()
    expect(runFolderRefusal({ ...mine, mode: 0o40755 }, 501)).toBeNull()
    expect(runFolderRefusal({ ...mine, isSymbolicLink: true, isDirectory: false }, 501)).toMatch(/is a symlink/)
    expect(runFolderRefusal({ ...mine, isDirectory: false }, 501)).toMatch(/not a directory/)
    expect(runFolderRefusal({ ...mine, uid: 502 }, 501)).toMatch(/another user/)
  })
})
