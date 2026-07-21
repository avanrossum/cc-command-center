// Publish a release: build locally, then upload the artifacts + latest-mac.yml
// to the public releases repo and sync changelog.json to its main branch.
//
//   node scripts/publish.mjs
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
import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASES_REPO = 'avanrossum/claude-command-center-releases'
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

// 1. Build locally (no --publish). This produces the DMG/ZIP/blockmaps and,
//    crucially, latest-mac.yml under release/.
console.log(`\n▶ Building v${version}…`)
sh('npm run build')
sh('electron-builder')

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
console.log(`\n▶ Uploading ${assets.length} assets to ${RELEASES_REPO}…`)
assets.forEach((f) => console.log(`   • ${f.slice(OUT.length + 1)}`))

// 3. Create the release (creates the v<version> tag at main) with all assets,
//    or upload into it if a release for this tag already exists.
const tag = `v${version}`
let exists = false
try {
  cap(`gh release view ${tag} --repo ${RELEASES_REPO}`)
  exists = true
} catch {
  exists = false
}
const fileArgs = assets.map(q).join(' ')
if (exists) {
  console.log(`\n▶ Release ${tag} exists — uploading (clobber) into it…`)
  sh(`gh release upload ${tag} --repo ${RELEASES_REPO} --clobber ${fileArgs}`)
  sh(`gh release edit ${tag} --repo ${RELEASES_REPO} --draft=false --latest`)
} else {
  console.log(`\n▶ Creating release ${tag}…`)
  sh(
    `gh release create ${tag} --repo ${RELEASES_REPO} --target main --latest ` +
      `--title ${q(`v${version}`)} --notes ${q(`Release v${version}. See changelog.json for details.`)} ` +
      fileArgs,
  )
}

// 4. Sync changelog.json to the releases repo main branch via the contents API.
//    PUT needs the current blob sha when the file already exists. The body goes
//    on stdin as JSON — the commit message has a space, which -f flags split on.
console.log(`\n▶ Syncing changelog.json to ${RELEASES_REPO}…`)
const b64 = readFileSync(join(root, 'changelog.json')).toString('base64')
let sha = ''
try {
  sha = JSON.parse(cap(`gh api repos/${RELEASES_REPO}/contents/changelog.json`)).sha ?? ''
} catch {
  // First publish — no existing file, no sha.
}
const body = { message: `changelog: v${version}`, content: b64, ...(sha ? { sha } : {}) }
const bodyPath = join(tmpdir(), `ccc-changelog-${version}.json`)
writeFileSync(bodyPath, JSON.stringify(body))
try {
  sh(`gh api --method PUT repos/${RELEASES_REPO}/contents/changelog.json --input ${q(bodyPath)}`, {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
} finally {
  rmSync(bodyPath, { force: true })
}

console.log(`\n✓ Published ${tag}. The app will offer it on the next check.`)
