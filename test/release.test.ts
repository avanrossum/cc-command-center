// The release script's checks (docs/release-plan.md §2–§5).

import { describe, expect, it } from 'vitest'
import { assetRefusal, branchRefusal, builderConfig, installEnv, PUBLIC_REPO, bundleIdRefusal, identityRefusal, latestFalseRefusal, remoteTagRefusal, targetRefusal, testFeedRefusal, untrackedRefusal, newerThan, releaseArgs, teamOf, teamRefusal, updateConfigRefusal, updateFileRefusal, versionRefusal, windowRefusal } from '../scripts/release-lib.mjs'

describe('the beta window (§3)', () => {
  const open = { tombstone: 'v0.24.3', closed: false }
  it('refuses any tag newer than the tombstone while the window is open, and allows it once closed by hand', () => {
    expect(windowRefusal('v0.25.0', open)).toMatch(/newer than the tombstone v0\.24\.3/)
    expect(windowRefusal('v1.0.0-beta.1', open)).toMatch(/newer/)
    expect(windowRefusal('not-semver', open)).toMatch(/newer/)
    expect(windowRefusal('v0.24.3', open)).toBeNull()
    expect(windowRefusal('v0.25.0', { ...open, closed: true })).toBeNull()
  })
  it('refuses while no tombstone is named', () => {
    expect(windowRefusal('v0.25.0', { tombstone: null, closed: false })).toMatch(/no tombstone/)
  })
  it('orders semver with prereleases below their release', () => {
    expect(newerThan('v0.25.0', 'v0.24.9')).toBe(true)
    expect(newerThan('v0.24.3', 'v0.24.3-beta.1')).toBe(true)
    expect(newerThan('v0.24.3-beta.2', 'v0.24.3-beta.1')).toBe(true)
    expect(newerThan('v0.24.2', 'v0.24.3')).toBe(false)
  })
})

describe("the app's version (MIP2-1469 ruling)", () => {
  it('is semver, at least 1.0.0, and above the tombstone once one is named', () => {
    expect(versionRefusal('v1.0.0', null)).toBeNull()
    expect(versionRefusal('v1.0.0', 'v0.24.3')).toBeNull()
    expect(versionRefusal('v0.1.0', null)).toMatch(/below 1\.0\.0/)
    expect(versionRefusal('v0.25.0', null)).toMatch(/below 1\.0\.0/)
    expect(versionRefusal('v1.0.0-beta.1', null)).toMatch(/below 1\.0\.0/)
    expect(versionRefusal('v1.0.0', 'v1.0.0')).toMatch(/not above the tombstone/)
    expect(versionRefusal('latest', null)).toMatch(/not a semver tag/)
  })
})

describe('gh release create (§3)', () => {
  it('tags the target commit when given one, and never on a dry run', () => {
    const base = { tag: 'v1.0.0', repo: 'o/r', title: 't', notesFile: 'n.md', files: ['a.dmg'] }
    const real = releaseArgs({ ...base, draft: false, target: 'a'.repeat(40) })
    expect(real.slice(real.indexOf('--target'), real.indexOf('--target') + 2)).toEqual(['--target', 'a'.repeat(40)])
    expect(releaseArgs({ ...base, draft: true })).not.toContain('--target')
  })
  it('always passes --latest=false, and a draft for a dry run', () => {
    const base = { tag: 'v0.1.0', repo: 'o/r', title: 't', notesFile: 'n.md', files: ['a.dmg', 'ccc-mac.yml'] }
    const real = releaseArgs({ ...base, draft: false })
    expect(real).toContain('--latest=false')
    expect(real).not.toContain('--draft')
    expect(latestFalseRefusal(real)).toBeNull()
    expect(releaseArgs({ ...base, draft: true })).toContain('--draft')
  })
  it('refuses arguments without --latest=false, or with --latest', () => {
    expect(latestFalseRefusal(['release', 'create', 'v1'])).toMatch(/--latest=false/)
    expect(latestFalseRefusal(['release', 'create', 'v1', '--latest=false', '--latest'])).toMatch(/--latest=false/)
  })
})

describe('what the build may publish (§2–§3)', () => {
  it('needs ccc-mac.yml and refuses latest-mac.yml, which 0.24 reads', () => {
    expect(updateFileRefusal(['x.dmg', 'ccc-mac.yml'])).toBeNull()
    expect(updateFileRefusal(['x.dmg', 'ccc-mac.yml', 'latest-mac.yml'])).toMatch(/latest-mac\.yml/)
    expect(updateFileRefusal(['x.dmg'])).toMatch(/no ccc-mac\.yml/)
  })
  it("requires the app's app-update.yml, on the ccc channel, which Download reads", () => {
    const yml = 'owner: avanrossum\nrepo: cc-command-center\nprovider: github\nchannel: ccc\nupdaterCacheDirName: cc-command-center-app-updater\n'
    expect(updateConfigRefusal(yml)).toBeNull()
    expect(updateConfigRefusal(null)).toMatch(/Download would fail/)
    expect(updateConfigRefusal(yml.replace(/updaterCacheDirName.*\n/, ''))).toMatch(/updaterCacheDirName/)
    expect(updateConfigRefusal(yml.replace('channel: ccc', 'channel: latest'))).toMatch(/ccc channel/)
  })
  it('refuses a CSC_NAME with a certificate-type prefix, and says what to use', () => {
    expect(identityRefusal('Alexander vanRossum (5L3YKN3A25)')).toBeNull()
    expect(identityRefusal('Developer ID Application: Alexander vanRossum (5L3YKN3A25)')).toBe(
      'CSC_NAME must not start with "Developer ID Application:"; electron-builder refuses it. Use CSC_NAME="Alexander vanRossum (5L3YKN3A25)"',
    )
    expect(identityRefusal('  3rd Party Mac Developer Application: X (Y)')).toMatch(/Use CSC_NAME="X \(Y\)"/)
  })
  it("uploads only this version's files", () => {
    const now = ['cc-command-center-app-1.0.0-arm64.dmg', 'cc-command-center-app-1.0.0-arm64.zip', 'cc-command-center-app-1.0.0-arm64.zip.blockmap', 'ccc-mac.yml']
    expect(assetRefusal(now, '1.0.0')).toBeNull()
    expect(assetRefusal([...now, 'cc-command-center-app-0.1.0-arm64.dmg'], '1.0.0')).toMatch(/not from this 1\.0\.0 build: cc-command-center-app-0\.1\.0-arm64\.dmg/)
    expect(assetRefusal(['ccc-mac.yml', 'cc-command-center-app-1.0.0-arm64.zip'], '1.0.0')).toMatch(/no dmg/)
  })
  it("requires the app's Team ID on every native binary, except in an ad hoc dry run", () => {
    expect(teamOf('Identifier=x\nTeamIdentifier=ABCDE12345\n')).toBe('ABCDE12345')
    expect(teamOf('TeamIdentifier=not set\n')).toBeNull()
    const ok = [{ path: 'pty.node', team: 'ABCDE12345' }, { path: 'spawn-helper', team: 'ABCDE12345' }]
    expect(teamRefusal('ABCDE12345', [{ path: 'spawn-helper', team: 'ABCDE12345' }], false)).toMatch(/no pty\.node/)
    expect(teamRefusal('ABCDE12345', ok, false)).toBeNull()
    expect(teamRefusal('ABCDE12345', [...ok, { path: 'x.node', team: null }], false)).toMatch(/x\.node \(none\)/)
    expect(teamRefusal(null, ok, false)).toMatch(/not signed with a Developer ID/)
    expect(teamRefusal(null, [], true)).toBeNull()
  })
})

describe('what a release is built from and tagged on (pass 9, M-1, M-2)', () => {
  it('refuses a dry-run test build: another bundle identifier, or the local test feed in app.asar', () => {
    expect(bundleIdRefusal('com.mipyip.cc-command-center-app')).toBeNull()
    expect(bundleIdRefusal('com.mipyip.cc-command-center-app.dryrun')).toMatch(/not com\.mipyip\.cc-command-center-app$/)
    expect(testFeedRefusal('…UPDATE_TEST_FEED = true ? "http://127.0.0.1:8791" : null…')).toMatch(/test feed "http:\/\/127\.0\.0\.1:8791"/)
    // A release build has the bare origin string elsewhere, never a quoted feed with a port.
    expect(testFeedRefusal('UPDATE_TEST_FEED = false ? null : null; x = "http://127.0.0.1:"')).toBeNull()
  })
  it('refuses any untracked file, and ignored files other than build output and editor records (pass 10, L-1)', () => {
    expect(untrackedRefusal(' M README.md\n!! node_modules/\n!! dist/\n!! release/\n!! src/.DS_Store\n!! src/main/.claude/.cc-writes/\n!! mod/.claude-plugin/types/\n')).toBeNull()
    expect(untrackedRefusal('?? src/main/extra.ts\n?? .npmrc\n')).toBe("files in the checkout that aren't in the commit: src/main/extra.ts, .npmrc")
    expect(untrackedRefusal('!! .env\n!! resources/extra.png\n')).toBe("files in the checkout that aren't in the commit: .env, resources/extra.png")
  })
  it('makes a real release from main only', () => {
    expect(branchRefusal('main')).toBeNull()
    expect(branchRefusal('mip2-1471')).toMatch(/from main, not mip2-1471/)
  })
  it("tags only the pushed public main, and only when its tree is this commit's snapshot tree", () => {
    const sha = 'b'.repeat(40)
    const ok = { target: sha, mainSha: sha, targetTree: 't1', expectedTree: 't1' }
    expect(targetRefusal(ok)).toBeNull()
    expect(targetRefusal({ ...ok, target: null })).toMatch(/needs --target/)
    expect(targetRefusal({ ...ok, mainSha: 'c'.repeat(40) })).toMatch(/is not the public main/)
    expect(targetRefusal({ ...ok, targetTree: 't2' })).toMatch(/isn't this commit's snapshot tree/)
  })
  it('refuses a tag that already exists elsewhere on the remote', () => {
    const sha = 'b'.repeat(40)
    expect(remoteTagRefusal([], 'v1.0.0', sha)).toBeNull()
    expect(remoteTagRefusal([{ ref: 'refs/tags/v1.0.0', object: { sha, type: 'commit' } }], 'v1.0.0', sha)).toBeNull()
    expect(remoteTagRefusal([{ ref: 'refs/tags/v1.0.0', object: { sha: 'c'.repeat(40), type: 'commit' } }], 'v1.0.0', sha)).toMatch(/already exists on the remote at ccccccc/)
    expect(remoteTagRefusal([{ ref: 'refs/tags/v1.0.0', object: { sha, type: 'tag' } }], 'v1.0.0', sha)).toMatch(/\(tag\)/)
    // matching-refs is a prefix match: v1.0.0-beta.1 isn't v1.0.0.
    expect(remoteTagRefusal([{ ref: 'refs/tags/v1.0.0-beta.1', object: { sha: 'c'.repeat(40), type: 'commit' } }], 'v1.0.0', sha)).toBeNull()
  })
})

describe('the dependency install (pass 11, L-2)', () => {
  it('keeps only an allowlist: no signing, notarization or GitHub credentials, and nothing unknown (pass 12, M-2)', () => {
    const env = installEnv({
      PATH: '/usr/bin', HOME: '/h', TMPDIR: '/t', LANG: 'en_US.UTF-8', LC_ALL: 'C', npm_config_cache: '/c', NODE_ENV: 'production', ELECTRON_MIRROR: 'm', DEVELOPER_DIR: '/x',
      CSC_NAME: 'x', CSC_LINK: 'x', APPLE_ID: 'x', APPLE_APP_SPECIFIC_PASSWORD: 'x', APPLE_TEAM_ID: 'x', APPLE_KEYCHAIN_PROFILE: 'x',
      GH_TOKEN: 'x', GITHUB_TOKEN: 'x', GH_ENTERPRISE_TOKEN: 'x', GITHUB_ENTERPRISE_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x', CCC_UPDATE_TEST_FEED: 'x',
      // Token-shaped names the NODE_ and npm_config_ prefixes would admit (pass 13, L-1).
      NODE_AUTH_TOKEN: 'x', npm_config__authToken: 'x', npm_config__auth: 'x', 'npm_config_//npm.example/:_authToken': 'x', npm_config_password: 'x',
    })
    expect(Object.keys(env).sort()).toEqual(['DEVELOPER_DIR', 'ELECTRON_MIRROR', 'HOME', 'LANG', 'LC_ALL', 'NODE_ENV', 'PATH', 'TMPDIR', 'npm_config_cache'])
  })
  it('names the public repository once', () => {
    expect(PUBLIC_REPO).toBe('avanrossum/cc-command-center')
  })
})

describe("electron-builder's part (pass 13, M-1)", () => {
  it('packages and signs without rebuilding native modules, which npm run setup did under the allowlist', () => {
    expect(builderConfig({ identity: 'Someone (ABCDE12345)', adhoc: false, repo: null })).toContain('-c.npmRebuild=false')
    expect(builderConfig({ identity: null, adhoc: true, repo: 'o/r' })).toContain('-c.npmRebuild=false')
  })
})
