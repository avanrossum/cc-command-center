// Builds the signed pair for the update dry run (MIP2-1469, dry run 3): a
// 1.0.0 app to run and a 1.0.1 update to serve, both from this commit, both
// signed with the Developer ID in CSC_NAME but under their own identity
// (com.mipyip.cc-command-center-app.dryrun, "CC Command Center Dry Run"), so
// their designated requirement never matches the production app's and
// neither can install over it (pass 9, M-1). Both read a local stand-in
// for the release repository (CCC_UPDATE_TEST_FEED). Neither is a release:
// the release script refuses CCC_UPDATE_TEST_FEED, and nothing here uploads.
// Notarization is skipped; Squirrel.Mac checks the update against the running
// app's designated requirement, and a locally built app carries no
// quarantine flag. Both builds isolate themselves (src/main/test-isolation.ts):
// data and channels under /private/tmp/ccc-dry3-run and Claude Code's
// ~/.claude-ccc-qa config, even when ShipIt relaunches one with a bare
// environment.
//
//   CSC_NAME="Name (TEAMID)" node scripts/update-test.mjs <out dir> [--port <n>]
//
// It writes <out>/app/CC Command Center Dry Run.app (1.0.0) and <out>/srv, which
// `python3 -m http.server <port> --bind 127.0.0.1` serves from inside it, for
// the run only. The port defaults to 8791.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { identityRefusal, PUBLIC_REPO, teamOf } from './release-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const RUNS = '1.0.0'
const OFFERED = '1.0.1'
const TEST_APP_ID = 'com.mipyip.cc-command-center-app.dryrun'
const TEST_NAME = 'CC Command Center Dry Run'
const APP = `${TEST_NAME}.app`

const fail = why => {
  console.error(`update-test: ${why}`)
  process.exit(1)
}
const run = (file, args, env = {}) => execFileSync(file, args, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: { ...process.env, ...env } })
const signature = path => {
  try {
    return execFileSync('/bin/sh', ['-c', 'codesign -dv "$0" 2>&1', path], { encoding: 'utf8' })
  } catch (err) {
    return String(err.stdout ?? '')
  }
}

const argv = process.argv.slice(2)
const out = argv[0] && !argv[0].startsWith('--') ? resolve(argv[0]) : fail('give the output folder: node scripts/update-test.mjs <out dir> [--port <n>]')
const port = Number(argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : 8791)
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('--port must be 1024–65535')
const FEED = `http://127.0.0.1:${port}`
if (out === ROOT || out.startsWith(`${ROOT}/`)) fail('the output folder must be outside the repository')
const identity = process.env.CSC_NAME ?? fail('CSC_NAME (the Developer ID Application certificate, without its prefix) is not set')
const refused = identityRefusal(identity)
if (refused) fail(refused)

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
for (const version of [RUNS, OFFERED]) {
  run('npm', ['run', 'build'], { CCC_UPDATE_TEST_FEED: FEED })
  run('npx', [
    'electron-builder', '--mac', 'zip', '--arm64', '--publish', 'never',
    `-c.directories.output=${join(out, `build-${version}`)}`,
    `-c.extraMetadata.version=${version}`,
    `-c.appId=${TEST_APP_ID}`,
    `-c.productName=${TEST_NAME}`,
    `-c.mac.identity=${identity}`,
    '-c.mac.hardenedRuntime=true',
    '-c.mac.entitlements=build/entitlements.mac.plist',
    '-c.mac.entitlementsInherit=build/entitlements.mac.plist',
    '-c.mac.notarize=false',
    '-c.publish.provider=github', `-c.publish.owner=${PUBLIC_REPO.split('/')[0]}`, `-c.publish.repo=${PUBLIC_REPO.split('/')[1]}`, '-c.publish.channel=ccc',
  ])
}
// dist/ goes back to a release build's, with no test feed in it.
run('npm', ['run', 'build'])

const built = v => join(out, `build-${v}`)
for (const v of [RUNS, OFFERED]) {
  const id = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(built(v), 'mac-arm64', APP, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
  if (id !== TEST_APP_ID) fail(`the ${v} build's bundle identifier is ${id}, not ${TEST_APP_ID}`)
}
const teams = [RUNS, OFFERED].map(v => teamOf(signature(join(built(v), 'mac-arm64', APP))))
if (!teams[0] || teams[0] !== teams[1]) fail(`both apps must carry one Team ID, got ${teams.join(' and ')}`)

// The app to run.
mkdirSync(join(out, 'app'))
// ditto keeps the bundle's symlinks and extended attributes, so the signature still holds.
execFileSync('ditto', [join(built(RUNS), 'mac-arm64', APP), join(out, 'app', APP)])
execFileSync('codesign', ['--verify', '--deep', '--strict', join(out, 'app', APP)])

// The stand-in for the repository: a feed naming v1.0.1, and its release's files.
const dl = join(out, 'srv', 'releases', 'download', `v${OFFERED}`)
mkdirSync(dl, { recursive: true })
const files = readdirSync(built(OFFERED)).filter(f => f === 'ccc-mac.yml' || f.endsWith('.zip') || f.endsWith('.zip.blockmap'))
if (!files.includes('ccc-mac.yml')) fail('the 1.0.1 build wrote no ccc-mac.yml')
for (const f of files) cpSync(join(built(OFFERED), f), join(dl, f))
if (!readFileSync(join(dl, 'ccc-mac.yml'), 'utf8').includes(`version: ${OFFERED}`)) fail(`ccc-mac.yml doesn't name ${OFFERED}`)
writeFileSync(
  join(out, 'srv', 'releases.atom'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n<entry><id>tag:github.com,2008:Repository/1/v${OFFERED}</id><link rel="alternate" type="text/html" href="https://github.com/${PUBLIC_REPO}/releases/tag/v${OFFERED}"/><title>v${OFFERED}</title></entry>\n</feed>\n`,
)
console.log(`update-test: ${RUNS} app and ${OFFERED} update built as ${TEST_APP_ID}, signed with Team ID ${teams[0]}, feed ${FEED}, in ${out}`)
