// Where the app keeps its own data, and the overrides QA uses to run an
// isolated second instance (MIP2-1408).
//
// Electron CCCC is also named "CC Command Center", so Electron's default
// userData folder for this app would be Electron CCCC's own profile (D-008).
// This app uses a folder of its own, and an override may never point at the
// defaults or at any Electron CCCC folder.

import { isAbsolute, join, normalize } from 'node:path'

export const APP_DATA_FOLDER = 'CC Command Center App'

/** The old Electron app's data folders, which this app never writes. */
export const ELECTRON_CCCC_FOLDERS = ['CC Command Center', 'CC Command Center Dev', 'Claude Command Center', 'claude-command-center']

/** A channel root must leave room for `/<8 hex>/s.sock` under the socket path limit (MIP2-1376). */
const SOCKET_PATH_LIMIT = 100
const CHANNEL_SUFFIX = '/xxxxxxxx/s.sock'

export function userDataPath(appData: string): string {
  return join(appData, APP_DATA_FOLDER)
}

function same(a: string, b: string): boolean {
  return normalize(a).replace(/\/+$/, '') === normalize(b).replace(/\/+$/, '')
}

function inside(path: string, folder: string): boolean {
  return same(path, folder) || normalize(path).startsWith(normalize(folder).replace(/\/+$/, '') + '/')
}

/** The data folder: `CCC_USER_DATA` when set and allowed, else the app's own. */
export function resolveUserData(env: NodeJS.ProcessEnv, appData: string): string {
  const own = userDataPath(appData)
  const override = env.CCC_USER_DATA
  if (!override) return own
  if (!isAbsolute(override)) throw new Error('CCC_USER_DATA must be an absolute path')
  if (same(override, own)) throw new Error("CCC_USER_DATA can't be the app's own data folder")
  for (const f of ELECTRON_CCCC_FOLDERS) {
    if (inside(override, join(appData, f))) throw new Error(`CCC_USER_DATA can't be in Electron CCCC's folder ${f}`)
  }
  return override
}

/** The channel root: `CCC_CHANNEL_ROOT` when set and allowed, else the default. */
export function resolveChannelRoot(env: NodeJS.ProcessEnv, defaultRoot: string): string {
  const override = env.CCC_CHANNEL_ROOT
  // An instance with its own data folder has its own single-instance lock; on the default root it would
  // recover, mark and stop the first instance's channels (gate run 3, L-7).
  if (!override && env.CCC_USER_DATA) throw new Error('CCC_USER_DATA needs CCC_CHANNEL_ROOT too, so this instance keeps off the other one\'s channels')
  if (!override) return defaultRoot
  if (!isAbsolute(override)) throw new Error('CCC_CHANNEL_ROOT must be an absolute path')
  if (inside(override, defaultRoot) || inside(defaultRoot, override)) throw new Error("CCC_CHANNEL_ROOT can't overlap the app's own channel folder")
  if (Buffer.byteLength(override.replace(/\/+$/, '') + CHANNEL_SUFFIX) > SOCKET_PATH_LIMIT) {
    throw new Error(`CCC_CHANNEL_ROOT is too long: socket paths must stay under ${SOCKET_PATH_LIMIT} bytes`)
  }
  return override
}

/**
 * Whether Chromium's remote debugging port may open (MIP2-1408). Only for
 * QA's test runs, never in a packaged build: the port can drive the window,
 * and the window can approve tool calls.
 */
export function debugPortAllowed(env: NodeJS.ProcessEnv, isPackaged: boolean): boolean {
  return !isPackaged && env.CCC_QA === '1'
}

/**
 * QA's stand-in for the ⌘O open panel, which a test can't drive (MIP2-1413):
 * `CCC_QA_PICK_PATHS="/abs/a:/abs/b"`. Only where the debugging port is
 * allowed (CCC_QA=1, unpackaged); refused otherwise.
 */
export function qaPickPaths(env: NodeJS.ProcessEnv, isPackaged: boolean): string[] | null {
  const raw = env.CCC_QA_PICK_PATHS
  if (!raw) return null
  if (!debugPortAllowed(env, isPackaged)) throw new Error('CCC_QA_PICK_PATHS needs CCC_QA=1 and an unpackaged build')
  const paths = raw.split(':')
  if (!paths.every(p => isAbsolute(p) && !p.includes('\0'))) throw new Error('CCC_QA_PICK_PATHS must hold absolute paths separated by ":"')
  return paths
}

/**
 * The folder whose `registry.db` the import reads: `CCC_IMPORT_FROM` when
 * set (QA points it at a copy), else Electron CCCC's own folder. Either is
 * only ever read, through a private copy (src/main/registry-import.ts).
 */
export function resolveImportFolder(env: NodeJS.ProcessEnv, appData: string): string {
  const override = env.CCC_IMPORT_FROM
  if (!override) return join(appData, ELECTRON_CCCC_FOLDERS[0]!)
  if (!isAbsolute(override)) throw new Error('CCC_IMPORT_FROM must be an absolute path')
  return override
}

/**
 * `CCC_CLAUDE_BIN` picks the binary the app runs with every session's
 * channel and approval power, so it's a QA override like the rest: refused
 * outside an unpackaged CCC_QA=1 run (gate L-1, MIP2-1429).
 */
export function checkClaudeBinOverride(env: NodeJS.ProcessEnv, isPackaged: boolean): void {
  if (env.CCC_CLAUDE_BIN && !debugPortAllowed(env, isPackaged)) throw new Error('CCC_CLAUDE_BIN needs CCC_QA=1 and an unpackaged build')
}
