// Deliberate version bump: node scripts/bump.mjs <major|minor|patch>
//
// Bumps package.json, regenerates src/shared/version.ts, commits the release,
// and tags it vX.Y.Z. The per-commit build hash changes on its own with every
// commit; this script is only for the semver part, which is a human decision.
//
// Requires a clean working tree so the tag points at a reproducible commit.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const kind = process.argv[2]

if (!['major', 'minor', 'patch'].includes(kind)) {
  console.error('usage: node scripts/bump.mjs <major|minor|patch>')
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
const [maj, min, pat] = pkg.version.split('.').map((n) => parseInt(n, 10))
const next =
  kind === 'major'
    ? `${maj + 1}.0.0`
    : kind === 'minor'
      ? `${maj}.${min + 1}.0`
      : `${maj}.${min}.${pat + 1}`

pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
execSync('node scripts/gen-version.mjs', { cwd: root, stdio: 'inherit' })
execSync('git add package.json', { cwd: root, stdio: 'inherit' })
execSync(
  `git commit -m "chore(release): v${next}" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"`,
  { cwd: root, stdio: 'inherit' },
)
execSync(`git tag v${next}`, { cwd: root, stdio: 'inherit' })
console.log(`\nbumped ${pkg.name} to v${next} and tagged v${next}`)
console.log(`push with: git push && git push --tags`)
