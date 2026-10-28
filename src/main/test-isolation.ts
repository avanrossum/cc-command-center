// A dry-run build's isolation (MIP2-1469, dry run 3). A build made with
// CCC_UPDATE_TEST_FEED is a test app: Squirrel.Mac's ShipIt relaunches it
// after an update with a bare environment, so the isolation QA normally
// passes in (CCC_USER_DATA, CCC_CHANNEL_ROOT, CLAUDE_CONFIG_DIR) is built
// in instead, and wins over whatever the environment says. A test app never
// opens the app's own data folder, its channels, or the main Claude config.

import { join } from 'node:path'

/** Set by scripts/build.mjs for a dry-run build only: `http://127.0.0.1:<port>`. */
declare const __CCC_UPDATE_TEST_FEED__: string | null | undefined

export const UPDATE_TEST_FEED = typeof __CCC_UPDATE_TEST_FEED__ === 'string' ? __CCC_UPDATE_TEST_FEED__ : null

/** Where a test app keeps everything; private to the user (the channel root's parent must be). */
export const TEST_RUN_FOLDER = '/private/tmp/ccc-dry3-run'

export interface TestIsolation {
  userData: string
  channelRoot: string
  claudeConfigDir: string
  /** Claude Code's user settings in that config, which the first run's mailbox step edits. */
  claudeSettings: string
}

/** The isolation for a test-feed build, or null for any other build. */
export function testIsolation(testFeed: string | null, home: string): TestIsolation | null {
  if (!testFeed) return null
  const claudeConfigDir = join(home, '.claude-ccc-qa')
  return { userData: join(TEST_RUN_FOLDER, 'data'), channelRoot: join(TEST_RUN_FOLDER, 'ch'), claudeConfigDir, claudeSettings: join(claudeConfigDir, 'settings.json') }
}

/** The environment with the isolation forced in; unchanged without one. */
export function isolatedEnv(env: NodeJS.ProcessEnv, isolation: TestIsolation | null): NodeJS.ProcessEnv {
  if (!isolation) return env
  return { ...env, CCC_USER_DATA: isolation.userData, CCC_CHANNEL_ROOT: isolation.channelRoot, CLAUDE_CONFIG_DIR: isolation.claudeConfigDir }
}

/** What lstat says about the run folder. */
export interface FolderStat {
  isDirectory: boolean
  isSymbolicLink: boolean
  uid: number
  mode: number
}

/**
 * Why the run folder can't be used, or null (pass 9, L-3). It sits in the
 * shared /private/tmp, so it must be a real directory, not a symlink, owned
 * by this user. A folder of this user's with a wider mode is narrowed to
 * 0700 by the caller; anything else stops the app.
 */
export function runFolderRefusal(st: FolderStat, uid: number): string | null {
  if (st.isSymbolicLink) return `${TEST_RUN_FOLDER} is a symlink`
  if (!st.isDirectory) return `${TEST_RUN_FOLDER} is not a directory`
  if (st.uid !== uid) return `${TEST_RUN_FOLDER} belongs to another user`
  return null
}
