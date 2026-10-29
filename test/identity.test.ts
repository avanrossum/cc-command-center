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
import { APP_NAME, DISPLAY_NAME, nameToPin } from '../src/main/app-name.ts'
import { appMenuTemplate } from '../src/main/app-menu.ts'
import { APP_DATA_FOLDER, ELECTRON_CCCC_FOLDERS } from '../src/main/paths.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  productName: string
  build: { appId: string; productName: string; artifactName: string; mac: { extendInfo?: Record<string, unknown> }; extraResources: { from: string; to: string }[]; dmg?: { title?: string; artifactName?: string } }
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

describe('the shown name (MIP2-1532, Research MIP2-1531)', () => {
  it('keeps the bundle, data folder and Keychain names as they were, and shows "CC Command Center" through the localized name', () => {
    expect(pkg.build.appId).toBe('com.mipyip.cc-command-center-app')
    expect(pkg.productName).toBe(APP_NAME)
    expect(pkg.build.productName).toBe(APP_NAME)
    expect(APP_DATA_FOLDER).toBe(APP_NAME)
    expect(pkg.build.mac.extendInfo?.LSHasLocalizedDisplayName).toBe(true)
    expect(pkg.build.extraResources).toContainEqual({ from: 'resources/en.lproj/InfoPlist.strings', to: 'en.lproj/InfoPlist.strings' })
    const strings = readFileSync(new URL('../resources/en.lproj/InfoPlist.strings', import.meta.url), 'utf8')
    expect(strings).toContain(`"CFBundleDisplayName" = "${DISPLAY_NAME}";`)
    expect(strings).toContain(`"CFBundleName" = "${DISPLAY_NAME}";`)
    expect(pkg.build.dmg?.title).toBe(DISPLAY_NAME)
    expect(pkg.build.dmg?.artifactName).toMatch(/^CC-Command-Center-\$\{version\}/)
  })

  it("pins the production name, also after a productName edit to the shown name, and never takes 0.24's Keychain item or folder", () => {
    expect(nameToPin(APP_NAME)).toBe(APP_NAME)
    expect(nameToPin(DISPLAY_NAME)).toBe(APP_NAME)
    // 0.24's productName is the shown name: its Keychain item and folder are never this app's.
    expect(DISPLAY_NAME).toBe(ELECTRON_CCCC.productName)
    expect(ELECTRON_CCCC_FOLDERS).not.toContain(APP_NAME)
    // Test builds keep their own names, and their own Keychain items (MIP2-1404).
    expect(nameToPin('CC Command Center Dry Run')).toBeNull()
    expect(nameToPin('cc-command-center-build')).toBeNull()
  })

  it('pins the name at the top level of main, before the data folder is set and before ready', () => {
    const src = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    const pin = src.indexOf('const pin = nameToPin(app.getName())')
    expect(pin).toBeGreaterThan(-1)
    expect(pin).toBeLessThan(src.indexOf("app.setPath('userData'"))
    expect(pin).toBeLessThan(src.indexOf('app.whenReady()'))
    // In a bare block at the top level, not inside a function that might run later.
    expect(src.slice(src.lastIndexOf('\n{\n', pin), pin)).toMatch(/^\n\{\n\s*$/)
  })

  it('labels About, Hide and Quit with the shown name', () => {
    const items = appMenuTemplate(DISPLAY_NAME, () => {}, null, () => {})[0]!.submenu as { label?: string; role?: string }[]
    expect(items.find(i => i.role === 'about')?.label).toBe('About CC Command Center')
    expect(items.find(i => i.role === 'hide')?.label).toBe('Hide CC Command Center')
    expect(items.some(i => i.label === 'Quit CC Command Center')).toBe(true)
  })
})
