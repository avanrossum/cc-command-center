// Checks the new app's disk image before the farewell release attaches it
// (MIP2-61; MIP2-1478, M-2). The farewell notice sends every legacy install
// to this file, permanently, so: mounted read-only, the app inside must pass
// the strict signature check, Gatekeeper's notarization verdict and the
// stapler, carry this team's Team ID (APPLE_TEAM_ID), and be
// com.mipyip.cc-command-center-app 1.0.0. Its SHA-256 is printed, to compare
// with the public v1.0.0's disk image on October 28. Every command takes an
// argument list; no path goes through a shell's parsing.
//
//   APPLE_TEAM_ID=<team> node scripts/verify-new-app-dmg.mjs <path to cc-command-center-app-1.0.0-arm64.dmg>
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim()
const quiet = (file, args) => execFileSync(file, args, { stdio: 'ignore' })

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
  const mount = mkdtempSync(join(tmpdir(), 'ccc-new-app-dmg-'))
  let attached = false
  try {
    try {
      quiet('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg])
      attached = true
    } catch {
      fail(`hdiutil can't mount ${dmg}`)
    }
    const apps = readdirSync(mount).filter((f) => f.endsWith('.app'))
    if (apps.length !== 1) fail(`expected one app in it, found ${apps.length}`)
    const app = join(mount, apps[0])
    try {
      quiet('codesign', ['--verify', '--deep', '--strict', app])
    } catch {
      fail('codesign --verify --deep --strict failed')
    }
    // spctl writes its verdict on stderr and exits non-zero when it refuses; the path is $0, never parsed.
    let verdict = ''
    try {
      verdict = execFileSync('/bin/sh', ['-c', 'spctl -a -vv -t exec "$0" 2>&1', app], { encoding: 'utf8' })
    } catch (e) {
      fail(`Gatekeeper refused it: ${String(e.stdout ?? e).trim()}`)
    }
    if (!/source=Notarized Developer ID/.test(verdict)) fail(`not notarized: ${verdict.trim()}`)
    try {
      quiet('xcrun', ['stapler', 'validate', app])
    } catch {
      fail('no stapled notarization ticket (xcrun stapler validate)')
    }
    const signature = execFileSync('/bin/sh', ['-c', 'codesign -dv "$0" 2>&1', app], { encoding: 'utf8' })
    const appTeam = /^TeamIdentifier=(.+)$/m.exec(signature)?.[1]?.trim()
    if (appTeam !== team) fail(`Team ID ${appTeam ?? 'none'}, not ${team}`)
    const plist = (key) => out('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Contents', 'Info.plist')])
    const id = plist('CFBundleIdentifier')
    if (id !== 'com.mipyip.cc-command-center-app') fail(`bundle identifier ${id}`)
    const v = plist('CFBundleShortVersionString')
    if (v !== '1.0.0') fail(`version ${v}`)
  } finally {
    if (attached) {
      try {
        quiet('hdiutil', ['detach', mount])
      } catch {
        quiet('hdiutil', ['detach', '-force', mount])
      }
    }
    rmSync(mount, { recursive: true, force: true })
  }
  const sha256 = out('shasum', ['-a', '256', dmg]).split(/\s+/)[0]
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
