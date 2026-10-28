// Checks the new app's disk image before the farewell release attaches it
// (MIP2-61; MIP2-1478, M-2). The farewell notice sends every legacy install
// to this file, permanently, so: mounted read-only, the app inside must pass
// the strict signature check, Gatekeeper's notarization verdict and the
// stapler, carry this team's Team ID (APPLE_TEAM_ID), and be
// com.mipyip.cc-command-center-app 1.0.0, built for arm64. The image may hold
// only that app (a real directory, not a symlink), the Applications link and
// the Finder layout files. Its SHA-256 is taken before mounting and again
// after, and must not change; it's printed, to compare with the public
// v1.0.0's disk image on October 28, and returned, so the caller uploads the
// bytes that were checked. Every tool is called by absolute path with an
// argument list; no path goes through a shell's parsing.
//
//   APPLE_TEAM_ID=<team> node scripts/verify-new-app-dmg.mjs <path to cc-command-center-app-1.0.0-arm64.dmg>
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Absolute paths: `npm run` puts node_modules/.bin first on PATH, and nothing there may answer for these (L-2).
const HDIUTIL = '/usr/bin/hdiutil'
const CODESIGN = '/usr/bin/codesign'
const XCRUN = '/usr/bin/xcrun'
const SHASUM = '/usr/bin/shasum'
const LIPO = '/usr/bin/lipo'
const PLISTBUDDY = '/usr/libexec/PlistBuddy'
/** What an image may hold beside the app: the Applications link and Finder's layout files. */
const LAYOUT = new Set(['.background', '.DS_Store', '.VolumeIcon.icns', '.fseventsd', '.Trashes'])

const out = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim()
const quiet = (file, args) => execFileSync(file, args, { stdio: 'ignore' })
const sha256Of = (file) => out(SHASUM, ['-a', '256', file]).split(/\s+/)[0]

class Refused extends Error {}

/** Exits the process with the reason when the image doesn't pass, after detaching it. */
export function verifyNewAppDmg(dmg, team = process.env.APPLE_TEAM_ID) {
  try {
    return check(dmg, team)
  } catch (e) {
    if (!(e instanceof Refused)) throw e
    console.error(`the new app's disk image doesn't pass: ${e.message}`)
    process.exit(1)
  }
}

function check(dmg, team) {
  // Thrown, not exited, so the finally below always detaches the image.
  const fail = (why) => {
    throw new Refused(why)
  }
  if (!team) fail("APPLE_TEAM_ID is not set, so the Team ID can't be compared")
  // Hashed before mounting and again after: the bytes checked are the bytes returned (M-1).
  const before = sha256Of(dmg)
  const mount = mkdtempSync(join(tmpdir(), 'ccc-new-app-dmg-'))
  let attached = false
  try {
    try {
      quiet(HDIUTIL, ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg])
      attached = true
    } catch {
      fail(`hdiutil can't mount ${dmg}`)
    }
    // Only the app, a real directory, beside the Applications link and the layout files (L-1).
    const entries = readdirSync(mount)
    const apps = entries.filter((f) => f.endsWith('.app'))
    if (apps.length !== 1) fail(`expected one app in it, found ${apps.length}`)
    const app = join(mount, apps[0])
    const st = lstatSync(app)
    if (st.isSymbolicLink() || !st.isDirectory()) fail(`${apps[0]} is not a real app folder`)
    for (const e of entries) {
      if (e === apps[0] || LAYOUT.has(e)) continue
      const p = join(mount, e)
      if (e === 'Applications' && lstatSync(p).isSymbolicLink() && readlinkSync(p) === '/Applications') continue
      fail(`unexpected ${e} in the image`)
    }
    try {
      quiet(CODESIGN, ['--verify', '--deep', '--strict', app])
    } catch {
      fail('codesign --verify --deep --strict failed')
    }
    // spctl writes its verdict on stderr and exits non-zero when it refuses; the path is $0, never parsed.
    let verdict = ''
    try {
      verdict = execFileSync('/bin/sh', ['-c', '/usr/sbin/spctl -a -vv -t exec "$0" 2>&1', app], { encoding: 'utf8' })
    } catch (e) {
      fail(`Gatekeeper refused it: ${String(e.stdout ?? e).trim()}`)
    }
    if (!/source=Notarized Developer ID/.test(verdict)) fail(`not notarized: ${verdict.trim()}`)
    try {
      quiet(XCRUN, ['stapler', 'validate', app])
    } catch {
      fail('no stapled notarization ticket (xcrun stapler validate)')
    }
    const signature = execFileSync('/bin/sh', ['-c', '/usr/bin/codesign -dv "$0" 2>&1', app], { encoding: 'utf8' })
    const appTeam = /^TeamIdentifier=(.+)$/m.exec(signature)?.[1]?.trim()
    if (appTeam !== team) fail(`Team ID ${appTeam ?? 'none'}, not ${team}`)
    const plist = (key) => out(PLISTBUDDY, ['-c', `Print :${key}`, join(app, 'Contents', 'Info.plist')])
    const id = plist('CFBundleIdentifier')
    if (id !== 'com.mipyip.cc-command-center-app') fail(`bundle identifier ${id}`)
    const v = plist('CFBundleShortVersionString')
    if (v !== '1.0.0') fail(`version ${v}`)
    // 1.0 needs Apple Silicon, as the notice says: the main executable is arm64 only (L-3).
    const archs = out(LIPO, ['-archs', join(app, 'Contents', 'MacOS', plist('CFBundleExecutable'))])
    if (archs !== 'arm64') fail(`the app is built for ${archs}, not arm64 alone`)
  } finally {
    if (attached) {
      try {
        quiet(HDIUTIL, ['detach', mount])
      } catch {
        quiet(HDIUTIL, ['detach', '-force', mount])
      }
    }
    rmSync(mount, { recursive: true, force: true })
  }
  const sha256 = sha256Of(dmg)
  if (sha256 !== before) fail(`the image changed while it was checked (${before.slice(0, 12)} → ${sha256.slice(0, 12)})`)
  console.log(`   new app's disk image: signed by ${team}, notarized and stapled, 1.0.0; SHA-256 ${sha256}`)
  return sha256
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!process.argv[2]) {
    console.error('give the disk image: node scripts/verify-new-app-dmg.mjs <path>')
    process.exit(1)
  }
  verifyNewAppDmg(process.argv[2])
}
