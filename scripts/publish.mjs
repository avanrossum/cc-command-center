// Publish a release: build locally, then upload the artifacts + latest-mac.yml
// to the public releases repo and sync changelog.json to its main branch.
//
//   node scripts/publish.mjs --extra-asset <path to cc-command-center-app-1.0.0-arm64.dmg>
//
// Everything lands in the SEPARATE PUBLIC releases repo
// (avanrossum/claude-command-center-releases):
//   - A GitHub Release holds the signed/notarized DMG + ZIP (and their
//     blockmaps) plus latest-mac.yml. electron-updater reads latest-mac.yml
//     from the latest release to decide whether an update exists.
//   - changelog.json is PUT to the repo's main branch; the app fetches it from
//     raw.githubusercontent.com for the release-notes UI.
//
// We deliberately do NOT use electron-builder's own GitHub publisher: its
// parallel upload workers race on a freshly-created release and can leave a
// release with only some assets. Instead we build locally (electron-builder
// with no --publish still writes latest-mac.yml), then create the release and
// upload every artifact through gh in one deterministic step. gh release create
// also creates the v<version> tag at main, so the release is a real published
// (non-draft) release the updater can read without a token.
//
// Requirements:
//   - GH_TOKEN (or gh auth) with write access to the releases repo. Never printed.
//   - Signing + notarization env (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
//     APPLE_TEAM_ID). The updater refuses unsigned builds, so this is required.
//   - A clean tree on a release tag (run npm run bump first).
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Transition: builds up to v0.23.2 have the OLD repo baked into their app-update.yml,
// so it must keep receiving releases or those installs silently never update again.
// Builds from v0.24.0 check the main repo. Publishing to BOTH bridges the gap; the old
// entry can be dropped once nobody is running a build older than v0.24.0.
const RELEASES_REPOS = ['avanrossum/claude-command-center-releases', 'avanrossum/cc-command-center']
// Old builds fetch changelog.json from the OLD repo, so it still has to be synced
// there. New builds read it from the main repo, where it is simply committed.
const CHANGELOG_REPO = RELEASES_REPOS[0]
const OUT = join(root, 'release')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version

const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: root, stdio: 'inherit', env: process.env, ...opts })
const cap = (cmd) => execSync(cmd, { cwd: root, env: process.env }).toString().trim()
const q = (p) => `"${p}"` // quote a path for the shell

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  try {
    process.env.GH_TOKEN = cap('gh auth token')
  } catch {
    console.error('No GH_TOKEN / GITHUB_TOKEN and `gh auth token` failed.')
    console.error('Auth with `gh auth login` or export GH_TOKEN, then retry.')
    process.exit(1)
  }
}

if (cap('git status --porcelain')) {
  console.error('working tree not clean — commit before publishing.')
  process.exit(1)
}

// 0.25.0, the farewell release (MIP2-61). cc-command-center's main is the new app now, so
// this version's tag goes on the electron-0.24 branch there, and gh tags the branch as it is
// on GitHub: it has to be checked out and pushed. The cc-command-center release also carries
// the new app's disk image, which the farewell notice opens.
const BRANCH = 'electron-0.24'
const TARGETS = { 'avanrossum/cc-command-center': BRANCH, 'avanrossum/claude-command-center-releases': 'main' }
const NEW_APP_DMG = 'cc-command-center-app-1.0.0-arm64.dmg'
const extraArg = process.argv.indexOf('--extra-asset')
const extra = extraArg > 0 ? process.argv[extraArg + 1] : null
if (cap('git rev-parse --abbrev-ref HEAD') !== BRANCH) {
  console.error(`check out ${BRANCH} before publishing.`)
  process.exit(1)
}
cap('git fetch -q origin')
if (cap('git rev-parse HEAD') !== cap(`git rev-parse origin/${BRANCH}`)) {
  console.error(`push ${BRANCH} first: gh tags the branch as it is on GitHub.`)
  process.exit(1)
}
if (!extra || !extra.endsWith(`/${NEW_APP_DMG}`)) {
  console.error(`the farewell release needs --extra-asset <path to ${NEW_APP_DMG}>, from the new app's --build-only run.`)
  process.exit(1)
}
if (!existsSync(extra)) {
  console.error(`no file at ${extra}`)
  process.exit(1)
}

// 1. Build locally (no --publish). This produces the DMG/ZIP/blockmaps and,
//    crucially, latest-mac.yml under release/.
console.log(`\n▶ Building v${version}…`)
sh('npm run build')
// The Apple speech helper is an extraResource, so electron-builder copies whatever
// is on disk. Building it here rather than relying on a leftover from a previous
// `pack` keeps a release deterministic — a clean checkout would otherwise ship
// without the helper and report the engine as unavailable for no visible reason.
sh('npm run build:speech')
// --publish never: electron-builder auto-publishes when GH_TOKEN is present,
// and its parallel uploaders race into duplicate draft releases. We only want
// the local build + latest-mac.yml; gh (below) does all the uploading.
sh('electron-builder --publish never')

// 2. Collect this version's artifacts + latest-mac.yml. Names are deterministic
//    from artifactName (${name}-${version}-${arch}.${ext}), but we glob so a
//    naming tweak doesn't silently drop a file.
const assets = readdirSync(OUT)
  .filter((f) => f.includes(`-${version}-`) && /\.(dmg|zip|blockmap)$/.test(f))
  .concat('latest-mac.yml')
  .map((f) => join(OUT, f))
if (!assets.some((f) => f.endsWith('latest-mac.yml'))) {
  console.error('latest-mac.yml missing from release/ — the updater needs it. Aborting.')
  process.exit(1)
}
assets.forEach((f) => console.log(`   • ${f.slice(OUT.length + 1)}`))

// 3. Create the release (creates the v<version> tag at main) with all assets, or
//    upload into it if a release for this tag already exists. Done for EVERY target in
//    RELEASES_REPOS: an install only ever checks the one repo baked into its own
//    app-update.yml, so during the transition the release has to exist in both or the
//    older builds go quiet.
const tag = `v${version}`
// A prerelease is marked as such on GitHub and NEVER as `latest`. That single flag is
// what keeps betas invisible to stable installs: electron-updater resolves a stable
// app's update through /releases/latest, which excludes prereleases by definition. Mark
// a beta latest and every stable user is offered it immediately.
const isBeta = /-beta\./.test(version)
const releaseFlags = isBeta ? '--prerelease' : '--latest'
const fileArgs = assets.map(q).join(' ')
if (isBeta) console.log(`\n  ${tag} is a PRERELEASE — published as beta, not marked latest.`)
for (const repo of RELEASES_REPOS) {
  console.log(`\n▶ Publishing ${tag} to ${repo}…`)
  // The new app's disk image goes on cc-command-center only, where the notice links.
  const repoFiles = repo === 'avanrossum/cc-command-center' ? `${fileArgs} ${q(extra)}` : fileArgs
  let exists = false
  try {
    cap(`gh release view ${tag} --repo ${repo}`)
    exists = true
  } catch {
    exists = false
  }
  if (exists) {
    console.log(`   release exists — uploading (clobber) into it`)
    sh(`gh release upload ${tag} --repo ${repo} --clobber ${repoFiles}`)
    sh(`gh release edit ${tag} --repo ${repo} --draft=false ${releaseFlags}`)
  } else {
    sh(
      `gh release create ${tag} --repo ${repo} --target ${TARGETS[repo]} ${releaseFlags} ` +
        `--title ${q(`v${version}`)} --notes ${q(`Release v${version}. See changelog.json for details.`)} ` +
        repoFiles,
    )
  }
}

// 4. Sync changelog.json to the releases repo main branch via the contents API.
//    PUT needs the current blob sha when the file already exists. The body goes
//    on stdin as JSON — the commit message has a space, which -f flags split on.
console.log(`\n▶ Syncing changelog.json to ${CHANGELOG_REPO} (for builds older than v0.24.0)…`)
const b64 = readFileSync(join(root, 'changelog.json')).toString('base64')
let sha = ''
try {
  sha = JSON.parse(cap(`gh api repos/${CHANGELOG_REPO}/contents/changelog.json`)).sha ?? ''
} catch {
  // First publish — no existing file, no sha.
}
const body = { message: `changelog: v${version}`, content: b64, ...(sha ? { sha } : {}) }
const bodyPath = join(tmpdir(), `ccc-changelog-${version}.json`)
writeFileSync(bodyPath, JSON.stringify(body))
try {
  sh(`gh api --method PUT repos/${CHANGELOG_REPO}/contents/changelog.json --input ${q(bodyPath)}`, {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
} finally {
  rmSync(bodyPath, { force: true })
}

console.log(`\n✓ Published ${tag}. The app will offer it on the next check.`)
