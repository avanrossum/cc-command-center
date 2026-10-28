// Builds, signs, notarizes, checks and publishes a release (docs/release-plan.md §2–§5).
//
//   Dry run, to a private repository, always a draft; ad hoc signing allowed:
//     node scripts/release.mjs --dry-run --repo <owner>/<private repo> --notes <file> [--adhoc]
//   The signed, notarized build only, checked as a release and published nowhere, from main (for
//   the farewell release's copy of the new app's disk image, MIP2-61):
//     node scripts/release.mjs --build-only
//   A beta (MIP2-1497): the same as a real release, for an X.Y.Z-beta.N version, published as a
//   GitHub prerelease and never "latest"; add --prerelease to the real-release command.
//   A real release, only with the maintainer's go, from main, after this commit's snapshot is pushed to the
//   public main (scripts/snapshot.mjs):
//     node scripts/release.mjs --repo avanrossum/cc-command-center --notes <file> --target <public sha> --go
//
// A real release needs CSC_NAME, the Developer ID Application certificate's name in the Keychain
// without its "Developer ID Application:" prefix ("Name (TEAMID)"; electron-builder refuses the prefix), and one
// of electron-builder's notarization credential sets in the environment: APPLE_API_KEY,
// APPLE_API_KEY_ID and APPLE_API_ISSUER; or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID;
// or APPLE_KEYCHAIN and APPLE_KEYCHAIN_PROFILE. None of them is ever stored in this repository.
//
// Like 0.24's scripts/publish.mjs, electron-builder builds with --publish never and a single
// `gh release create` uploads every asset, since electron-builder's own uploader raced on new
// releases. Every release is created with --latest=false, so GitHub's "latest" stays on 0.24's
// tombstone (§3).
//
// The app always updates from the public repository (src/main/update-feed.ts, UPDATE_REPO); the
// owner and repository in app-update.yml aren't read. A dry run is never promoted to a real
// release because each run builds afresh, and a dry-run draft carries no tag.

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  assetRefusal,
  branchRefusal,
  builderConfig,
  bundleIdRefusal,
  identityRefusal,
  prereleaseRefusal,
  installEnv,
  latestFalseRefusal,
  PUBLIC_REPO,
  releaseArgs,
  remoteTagRefusal,
  targetRefusal,
  teamOf,
  teamRefusal,
  testFeedRefusal,
  untrackedRefusal,
  updateConfigRefusal,
  updateFileRefusal,
  versionRefusal,
  windowRefusal,
} from './release-lib.mjs'
import { readExcludes, snapshotTree } from './snapshot-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const value = name => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : undefined)

const fail = why => {
  console.error(`release: ${why}`)
  process.exit(1)
}
const run = (file, args, opts = {}) => execFileSync(file, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

const dryRun = flag('--dry-run')
const buildOnly = flag('--build-only')
const prerelease = flag('--prerelease')
const adhoc = flag('--adhoc')
if (buildOnly && (dryRun || flag('--go'))) fail('--build-only publishes nothing; it takes neither --dry-run nor --go')
const repo = buildOnly ? null : (value('--repo') ?? fail('--repo <owner>/<name> is required'))
const notes = buildOnly ? null : (value('--notes') ?? fail('--notes <file> is required'))
if (notes !== null && !existsSync(notes)) fail(`no notes file at ${notes}`)
if (adhoc && !dryRun) fail('--adhoc is for a dry run only')
if (process.env.CCC_UPDATE_TEST_FEED) fail('CCC_UPDATE_TEST_FEED is set: that builds a test app that updates from a local server')

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const tag = `v${version}`
const window = JSON.parse(readFileSync(join(ROOT, 'scripts', 'release-window.json'), 'utf8'))
// Dry runs too: a draft is the release that would be made.
const versionRefused = versionRefusal(tag, window.tombstone)
if (versionRefused) fail(versionRefused)
const prereleaseRefused = prereleaseRefusal(version, prerelease)
if (prereleaseRefused) fail(prereleaseRefused)

// 1. The tree is committed and pushed, so the release is a known commit.
if (run('git', ['status', '--porcelain', '--untracked-files=no']).trim()) fail('the working tree has uncommitted changes')
const untrackedRefused = untrackedRefusal(run('git', ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']))
if (untrackedRefused) fail(untrackedRefused)
run('git', ['fetch', '-q', 'origin'])
const head = run('git', ['rev-parse', 'HEAD']).trim()
if (run('git', ['rev-parse', '@{u}']).trim() !== head) fail('HEAD is not pushed')

// 2. Where it goes.
if (buildOnly) {
  const branchRefused = branchRefusal(run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim())
  if (branchRefused) fail(branchRefused)
} else if (dryRun) {
  if (repo === PUBLIC_REPO) fail('a dry run never goes to the public repository')
  const isPrivate = run('gh', ['repo', 'view', repo, '--json', 'isPrivate', '-q', '.isPrivate']).trim()
  if (isPrivate !== 'true') fail(`${repo} is not private`)
} else {
  if (!flag('--go')) fail("a real release needs --go, given only with the maintainer's go")
  if (repo !== PUBLIC_REPO) fail(`a real release goes to ${PUBLIC_REPO}`)
  const refused = windowRefusal(tag, window)
  if (refused) fail(refused)
  const branchRefused = branchRefusal(run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim())
  if (branchRefused) fail(branchRefused)
}

// The commit the public tag names: a real release's public snapshot of this commit (pass 9, M-2).
// A draft carries no tag, so a dry run has none.
const target = dryRun || buildOnly ? null : (value('--target') ?? null)
const ghText = args => {
  try {
    return run('gh', args).trim()
  } catch {
    return null
  }
}
// The remote's tags matching this one; a failed call refuses rather than reading as "none" (pass 10, L-2).
const remoteTags = () => {
  const text = ghText(['api', `repos/${repo}/git/matching-refs/tags/${tag}`])
  if (text === null) fail(`couldn't read ${repo}'s tags; not tagging blind`)
  const refs = JSON.parse(text)
  // An error object or {} isn't a list of tags (pass 14, L-4).
  if (!Array.isArray(refs)) fail(`${repo}'s tags didn't read as a list; not tagging blind`)
  return refs
}
if (!dryRun && !buildOnly) {
  const mainSha = ghText(['api', `repos/${repo}/branches/main`, '-q', '.commit.sha'])
  const targetTree = target ? ghText(['api', `repos/${repo}/commits/${target}`, '-q', '.commit.tree.sha']) : null
  const targetRefused = targetRefusal({ target, mainSha, targetTree, expectedTree: snapshotTree(ROOT, 'HEAD', readExcludes(ROOT)) })
  if (targetRefused) fail(targetRefused)
  const tagRefused = remoteTagRefusal(remoteTags(), tag, target)
  if (tagRefused) fail(tagRefused)
}

// 3. Signing and notarization.
const notarizeEnv =
  (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
  (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) ||
  (process.env.APPLE_KEYCHAIN && process.env.APPLE_KEYCHAIN_PROFILE)
if (!adhoc) {
  if (!process.env.CSC_NAME) fail('CSC_NAME (the Developer ID Application certificate) is not set')
  const identityRefused = identityRefusal(process.env.CSC_NAME)
  if (identityRefused) fail(identityRefused)
  if (!notarizeEnv) fail('no notarization credentials in the environment')
}

// 4. Build. The local `npm run package` config is overridden for a release only.
// electron-builder adds to release/ without clearing it, so an earlier build's files would be uploaded too.
rmSync(join(ROOT, 'release'), { recursive: true, force: true })
// A distributed build installs its dependencies from package-lock.json, so what's signed is what the
// commit names, not whatever node_modules holds (pass 10, L-1). npm run setup rebuilds node-pty for Electron.
if (!dryRun) {
  // Dependency code runs with an allowlisted environment: no signing, notarization or GitHub credentials in
  // it. Keychain-held ones stay reachable (release plan §2; pass 11, L-2; pass 12, M-2).
  run('npm', ['ci'], { stdio: 'inherit', env: installEnv(process.env) })
  run('npm', ['run', 'setup'], { stdio: 'inherit', env: installEnv(process.env) })
}
run('npm', ['run', 'build'], { stdio: 'inherit', env: installEnv(process.env) })
const config = builderConfig({ identity: process.env.CSC_NAME ?? null, adhoc, repo })
run('npx', ['electron-builder', '--mac', 'dmg', 'zip', '--arm64', '--publish', 'never', ...config], { stdio: 'inherit' })

const out = join(ROOT, 'release')
const app = join(out, 'mac-arm64', 'CC Command Center App.app')
const files = readdirSync(out)

// 5. Checks on what was built.
run('node', ['scripts/check-fuses.mjs', app], { stdio: 'inherit' })
// Never a dry-run test build (pass 9, M-1): the production identity, and no local test feed.
const idRefused = bundleIdRefusal(run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents', 'Info.plist')]).trim())
if (idRefused) fail(idRefused)
const feedRefused = testFeedRefusal(readFileSync(join(app, 'Contents', 'Resources', 'app.asar'), 'latin1'))
if (feedRefused) fail(feedRefused)
const updateRefused = updateFileRefusal(files)
if (updateRefused) fail(updateRefused)
const updateConfig = join(app, 'Contents', 'Resources', 'app-update.yml')
const configRefused = updateConfigRefusal(existsSync(updateConfig) ? readFileSync(updateConfig, 'utf8') : null)
if (configRefused) fail(configRefused)
// `codesign -dv` writes its description to stderr; it exits non-zero for an unsigned file.
const signature = path => {
  try {
    return execFileSync('/bin/sh', ['-c', 'codesign -dv "$0" 2>&1', path], { encoding: 'utf8' })
  } catch (err) {
    return String(err.stdout ?? '')
  }
}
const machO = []
const walk = dir => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    // lstat: a symlink is neither followed nor checked (pass 9, L-4).
    const st = lstatSync(p)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) walk(p)
    else if (/Mach-O/.test(run('file', ['-b', p]))) machO.push(p)
  }
}
walk(join(app, 'Contents', 'Resources', 'app.asar.unpacked'))
const appTeam = teamOf(signature(app))
const teamRefused = teamRefusal(
  appTeam,
  machO.map(p => ({ path: relative(app, p), team: teamOf(signature(p)) })),
  adhoc,
)
if (teamRefused) fail(teamRefused)
if (!adhoc) {
  const assess = run('/bin/sh', ['-c', 'spctl -a -vvv -t exec "$0" 2>&1', app])
  if (!/accepted/.test(assess) || !/Notarized Developer ID/.test(assess)) fail(`Gatekeeper doesn't accept the app as notarized:\n${assess}`)
}
console.log(`release: checks passed for ${tag} (${adhoc ? 'ad hoc' : `Team ID ${appTeam}`}, ${machO.length} native binaries)`)

if (buildOnly) {
  console.log(`release: ${tag} built and checked from ${head.slice(0, 7)}; published nowhere. The disk image: ${join(out, `cc-command-center-app-${version}-arm64.dmg`)}`)
  process.exit(0)
}

// 6. Publish: one `gh release create`, --latest=false always; a dry run as a draft.
const assets = files.filter(f => /\.(dmg|zip|blockmap)$/.test(f) || f === 'ccc-mac.yml').map(f => join(out, f))
const assetRefused = assetRefusal(assets.map(a => a.slice(out.length + 1)), version)
if (assetRefused) fail(assetRefused)
const args = releaseArgs({ tag, repo, title: `CC Command Center ${version}`, notesFile: notes, files: assets, draft: dryRun, target, prerelease })
const latestRefused = latestFalseRefusal(args)
if (latestRefused) fail(latestRefused)
// Once more right before the tag is made: the build took minutes, and gh reuses a tag that
// appeared meanwhile whatever --target says (pass 10, L-2).
if (target) {
  const lateRefused = remoteTagRefusal(remoteTags(), tag, target)
  if (lateRefused) fail(lateRefused)
}
run('gh', args, { stdio: 'inherit' })
// And after: the tag must be on the target, or the release names other source than was built (pass 11, L-6).
if (target) {
  // One read, and a failure that says the release already exists (pass 12, L-1).
  const text = ghText(['api', `repos/${repo}/git/matching-refs/tags/${tag}`])
  let refs = null
  try {
    const parsed = text === null ? null : JSON.parse(text)
    // An error object or {} reads as unreadable too, not a TypeError after the release is made (pass 14, L-4).
    refs = Array.isArray(parsed) ? parsed : null
  } catch {
    // Not JSON: the same as unreadable, so the message below still prints (pass 13, L-4).
  }
  const after = refs === null ? "its tags couldn't be read" : (remoteTagRefusal(refs, tag, target) ?? (refs.some(r => r.ref === `refs/tags/${tag}`) ? null : 'the tag is missing'))
  if (after) fail(`the release ${tag} was made on ${repo}, but its tag couldn't be confirmed on ${target.slice(0, 7)}: ${after}. Check it on GitHub before anything else.`)
}
console.log(`release: ${dryRun ? 'draft' : 'release'} ${tag} created on ${repo} from ${head.slice(0, 7)}${target ? `, tagged on ${target.slice(0, 7)}` : ''}`)
