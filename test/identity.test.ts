// The app's identity stays distinct from Electron CCCC's (MIP2-1404), so
// both run side by side through the trial (FRAGO-001 constraint 1).
// - Keychain: on macOS, safeStorage names its item "<app name> Safe Storage",
//   from app.getName(), which prefers productName (Electron,
//   shell/browser/electron_browser_main_parts.cc). A shared name would
//   encrypt the Arbiter key with Electron CCCC's Keychain secret.
// - Bundle id: macOS keys notifications, TCC grants and login items to it.
// - The single-instance lock lives in the data folder (Electron's
//   ProcessSingleton on userData), so a distinct folder is a distinct lock.
// Electron CCCC registers no URL scheme and no login item
// (claude-command-center electron-builder.yml and src/main/index.ts); this
// app registers neither.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_DATA_FOLDER, ELECTRON_CCCC_FOLDERS } from '../src/main/paths.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  productName: string
  build: { appId: string; productName: string; artifactName: string; mac: { extendInfo?: Record<string, unknown> } }
}

/** Electron CCCC's own identity (claude-command-center: package.json and electron-builder.yml). */
const ELECTRON_CCCC = { appId: 'com.mipyip.cc-command-center', name: 'cc-command-center', productName: 'CC Command Center' }

describe('identity', () => {
  it("names the app apart from every Electron CCCC name, so its Keychain item is its own", () => {
    expect(ELECTRON_CCCC_FOLDERS).not.toContain(pkg.productName)
    expect(ELECTRON_CCCC_FOLDERS).not.toContain(pkg.build.productName)
    expect(`${pkg.productName} Safe Storage`).not.toBe(`${ELECTRON_CCCC.productName} Safe Storage`)
  })

  it("has its own bundle id, package name and artifact names", () => {
    expect(pkg.build.appId).not.toBe(ELECTRON_CCCC.appId)
    expect(pkg.name).not.toBe(ELECTRON_CCCC.name)
    expect([...ELECTRON_CCCC_FOLDERS.map(n => n.toLowerCase()), ELECTRON_CCCC.name]).not.toContain(pkg.name.toLowerCase())
    // Electron CCCC's artifacts are `${name}-${version}-${arch}.${ext}` with its package name.
    expect(pkg.build.artifactName.startsWith('${name}')).toBe(false)
    expect(pkg.build.artifactName.startsWith(`${ELECTRON_CCCC.name}-\${version}`)).toBe(false)
  })

  it('registers no URL scheme', () => {
    expect(pkg.build.mac.extendInfo?.CFBundleURLTypes).toBeUndefined()
  })

  it('uses the same name as its own data folder', () => {
    expect(pkg.productName).toBe(APP_DATA_FOLDER)
    expect(pkg.build.productName).toBe(APP_DATA_FOLDER)
  })
})
