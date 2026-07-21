// Publish a release: build + upload artifacts to the releases repo, then sync
// changelog.json to that repo's main branch (where the app fetches it from).
//
//   node scripts/publish.mjs
//
// Two moving parts land in the SEPARATE PUBLIC releases repo
// (avanrossum/claude-command-center-releases):
//   1. electron-builder --publish always uploads the DMG / ZIP / blockmap and,
//      critically, latest-mac.yml to a GitHub Release. electron-updater reads
//      latest-mac.yml from the latest release to decide whether an update exists.
//   2. changelog.json is PUT to the repo's main branch via the GitHub API. The
//      app fetches it from raw.githubusercontent.com for the release-notes UI.
//
// Requirements:
//   - GH_TOKEN (or gh auth) with write access to the releases repo — used by
//     BOTH electron-builder and the gh api call. Never printed.
//   - Signing + notarization env (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
//     APPLE_TEAM_ID). The updater refuses unsigned builds, so this is required.
//   - A clean tree on a release tag (run npm run bump first).
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASES_REPO = 'avanrossum/claude-command-center-releases'

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version

const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: root, stdio: 'inherit', env: process.env, ...opts })
const cap = (cmd) =>
  execSync(cmd, { cwd: root, env: process.env }).toString().trim()

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  // gh may still be authed via keychain; electron-builder needs the env var.
  try {
    const t = cap('gh auth token')
    if (t) process.env.GH_TOKEN = t
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

console.log(`\n▶ Building + publishing v${version} artifacts to ${RELEASES_REPO}…`)
sh('npm run build')
sh('electron-builder --publish always')

// Sync changelog.json to the releases repo main branch via the contents API.
// PUT needs the current blob sha when the file already exists.
console.log(`\n▶ Syncing changelog.json to ${RELEASES_REPO}…`)
const content = readFileSync(join(root, 'changelog.json'))
const b64 = content.toString('base64')
let sha = ''
try {
  const cur = JSON.parse(cap(`gh api repos/${RELEASES_REPO}/contents/changelog.json`))
  sha = cur.sha ?? ''
} catch {
  // File doesn't exist yet — first publish. No sha needed.
}
const fields = [
  `-f message=changelog: v${version}`,
  `-f content=${b64}`,
  ...(sha ? [`-f sha=${sha}`] : []),
]
sh(`gh api --method PUT repos/${RELEASES_REPO}/contents/changelog.json ${fields.join(' ')}`, {
  stdio: ['ignore', 'ignore', 'inherit'],
})

console.log(`\n✓ Published v${version}. The app will offer it on the next check.`)
