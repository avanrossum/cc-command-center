// Deliberate version bump:
//   node scripts/bump.mjs <major|minor|patch> [--beta]
//   node scripts/bump.mjs beta        next beta (starts one on the next patch if stable)
//   node scripts/bump.mjs promote     drop the -beta suffix, shipping what you tested
//
// Bumps package.json, regenerates src/shared/version.ts, commits the release,
// and tags it vX.Y.Z. The per-commit build hash changes on its own with every
// commit; this script is only for the semver part, which is a human decision.
//
// BETA TRACK. A prerelease version is the whole opt-in mechanism: electron-updater
// derives allowPrerelease from the running app's OWN version (AppUpdater.js), and a
// stable install resolves updates through GitHub's /releases/latest, which excludes
// prereleases by definition. So a stable user cannot see a beta even in principle —
// provided publish.mjs never marks a prerelease as `latest`, which is the one line
// holding the whole separation up.
//
// A beta install still accepts a HIGHER stable version, so promote is the exit: run
// 0.25.0-beta.3, promote to 0.25.0, and the beta installs update onto it normally.
//
// Requires a clean working tree so the tag points at a reproducible commit.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const kind = process.argv[2]
const wantBeta = process.argv.includes('--beta')

if (!['major', 'minor', 'patch', 'beta', 'promote'].includes(kind)) {
  console.error('usage: node scripts/bump.mjs <major|minor|patch> [--beta] | beta | promote')
  process.exit(1)
}

const run = (cmd) => execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()

// The generated version.ts is git-ignored, so a dirty tree here means real
// uncommitted source — refuse, so the release tag is reproducible.
if (run('git status --porcelain')) {
  console.error('working tree not clean — commit or stash before bumping.')
  process.exit(1)
}

const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
// Split X.Y.Z[-beta.N]. The old parse ran parseInt over the raw parts, which turns
// "2-beta" into 2 and silently loses the suffix.
const m = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(pkg.version)
if (!m) {
  console.error(`cannot parse current version "${pkg.version}" — expected X.Y.Z or X.Y.Z-beta.N`)
  process.exit(1)
}
const [maj, min, pat] = [m[1], m[2], m[3]].map((n) => parseInt(n, 10))
const betaNum = m[4] ? parseInt(m[4], 10) : null

let next
if (kind === 'promote') {
  if (betaNum === null) {
    console.error(`${pkg.version} is not a beta — nothing to promote`)
    process.exit(1)
  }
  next = `${maj}.${min}.${pat}` // ship exactly what was tested, minus the suffix
} else if (kind === 'beta') {
  // Another round on the same base if already testing one; otherwise open a beta on
  // the next patch. A beta on a minor/major base is `bump minor --beta`.
  next = betaNum === null ? `${maj}.${min}.${pat + 1}-beta.1` : `${maj}.${min}.${pat}-beta.${betaNum + 1}`
} else {
  const base =
    kind === 'major'
      ? `${maj + 1}.0.0`
      : kind === 'minor'
        ? `${maj}.${min + 1}.0`
        : `${maj}.${min}.${pat + 1}`
  next = wantBeta ? `${base}-beta.1` : base
}

pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
execSync('node scripts/gen-version.mjs', { cwd: root, stdio: 'inherit' })

// Ensure changelog.json has an entry for the new version. This file is the
// source of truth for the release notes the auto-updater shows; publishing
// pushes it to the releases repo. If the entry is missing we scaffold an empty
// one at the top (newest first) so the notes are never silently blank.
const clPath = join(root, 'changelog.json')
let scaffolded = false
try {
  const cl = JSON.parse(readFileSync(clPath, 'utf8'))
  if (!Array.isArray(cl.versions)) cl.versions = []
  if (!cl.versions.some((v) => v.version === next)) {
    const today = new Date().toISOString().slice(0, 10)
    cl.versions.unshift({ version: next, date: today, critical: false, features: [] })
    writeFileSync(clPath, JSON.stringify(cl, null, 2) + '\n')
    scaffolded = true
  }
} catch {
  // No changelog.json (or unreadable) — skip; publish will degrade gracefully.
}

execSync('git add package.json changelog.json', { cwd: root, stdio: 'inherit' })
execSync(
  `git commit -m "chore(release): v${next}" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"`,
  { cwd: root, stdio: 'inherit' },
)
execSync(`git tag v${next}`, { cwd: root, stdio: 'inherit' })
console.log(`\nbumped ${pkg.name} to v${next} and tagged v${next}`)
if (scaffolded) {
  console.log(`\n⚠  changelog.json got an EMPTY entry for v${next}.`)
  console.log(`   Fill in "features" before you publish, or the release notes will be blank.`)
}
console.log(`push with: git push && git push --tags`)
