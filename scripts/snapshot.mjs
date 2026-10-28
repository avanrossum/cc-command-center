// Makes the public snapshot of this commit (release plan §4; MIP2-1472):
// one normal commit on the public main, parented on the public
// main's tip, whose tree is HEAD minus scripts/snapshot-exclude.txt. Never a
// force push. It commits in a local clone of the public repository and pushes
// nothing; both scans run on the clone, then the maintainer pushes.
//
//   node scripts/snapshot.mjs <clone of avanrossum/cc-command-center> [--message <text>]
//
// The release script then tags that commit (--target), and refuses one whose
// tree isn't exactly this snapshot's.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PUBLIC_REPO } from './release-lib.mjs'
import { addedToConfirm, readExcludes, readPublished, snapshotTree, unclassified } from './snapshot-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const PUBLIC = new RegExp(`^(?:https://github\\.com/|git@github\\.com:)${PUBLIC_REPO.replace('/', '\\/')}(?:\\.git)?$`)

const fail = why => {
  console.error(`snapshot: ${why}`)
  process.exit(1)
}
const argv = process.argv.slice(2)
const value = name => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : undefined)
const clone = argv[0] && !argv[0].startsWith('--') ? resolve(argv[0]) : fail('give the clone of the public repository: node scripts/snapshot.mjs <clone>')
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

// This repository: committed and pushed, so the snapshot is of a known commit.
if (git(ROOT, ['status', '--porcelain', '--untracked-files=no'])) fail('this repository has uncommitted changes')
git(ROOT, ['fetch', '-q', 'origin'])
const head = git(ROOT, ['rev-parse', 'HEAD'])
if (git(ROOT, ['rev-parse', '@{u}']) !== head) fail('HEAD is not pushed')
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
// Nothing is published by default: every entry is in the publish list or the exclude list (pass 10, M-4).
const loose = unclassified(ROOT, 'HEAD', readExcludes(ROOT), readPublished(ROOT))
if (loose.length) fail(`not in scripts/snapshot-publish.txt or scripts/snapshot-exclude.txt: ${loose.join(', ')}`)

// The clone: the public repository, on main, clean, at the remote's tip.
if (!existsSync(join(clone, '.git'))) fail(`${clone} is not a git clone`)
if (!PUBLIC.test(git(clone, ['remote', 'get-url', 'origin']))) fail(`${clone}'s origin is not avanrossum/cc-command-center`)
if (git(clone, ['status', '--porcelain'])) fail(`${clone} has changes`)
git(clone, ['fetch', '-q', 'origin'])
if (git(clone, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail(`${clone} is not on main`)
const parent = git(clone, ['rev-parse', 'origin/main'])
if (git(clone, ['rev-parse', 'HEAD']) !== parent) fail(`${clone}'s main is not origin/main; reset it to origin/main first`)

// The tree, built in the clone from this commit alone: --depth=1 brings its tree and blobs and
// none of this repository's history (pass 10, L-4).
git(clone, ['fetch', '-q', '--depth=1', '--no-tags', `file://${ROOT}`, 'HEAD'])
if (git(clone, ['rev-parse', 'FETCH_HEAD']) !== head) fail('fetched a different commit than HEAD')
const tree = snapshotTree(clone, 'FETCH_HEAD', readExcludes(ROOT))
if (tree !== snapshotTree(ROOT, 'HEAD', readExcludes(ROOT))) fail('the tree built in the clone differs from this repository\'s')
if (git(clone, ['rev-parse', 'origin/main^{tree}']) === tree) fail('the public main already has this tree; nothing to snapshot')

// Each added path outside src/ and test/, and each new fixture, is confirmed by name before anything is
// committed (pass 11, M-2): --confirm <path>, once per path.
// --no-renames: a moved or copied file shows as added, so it's confirmed too (pass 12, M-1).
const changes = git(clone, ['diff', '--no-renames', '--name-status', parent, tree])
const confirmed = argv.flatMap((a, i) => (a === '--confirm' ? [argv[i + 1]] : []))
const unconfirmed = addedToConfirm(changes).filter(p => !confirmed.includes(p))
if (unconfirmed.length) {
  console.log('snapshot: changes since the last public commit:')
  console.log(changes.replace(/^/gm, '  '))
  fail(`new public paths to read and confirm first: ${unconfirmed.map(p => `--confirm ${p}`).join(' ')}`)
}

const message = value('--message') ?? `CC Command Center ${version}`
// The same author as the public history (D-025), whoever's git config the clone has.
const [name, email] = git(clone, ['log', '-1', '--format=%an%n%ae', parent]).split('\n')
const env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
const commit = execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', message], { cwd: clone, encoding: 'utf8', env }).trim()
git(clone, ['merge', '-q', '--ff-only', commit])

console.log(`snapshot: ${commit} on ${clone}'s main (tree ${tree.slice(0, 7)}, parent ${parent.slice(0, 7)}), from ${head.slice(0, 7)}`)
// What this snapshot changes in public, file by file, to read before it goes out (pass 10, M-4).
console.log('snapshot: changes since the last public commit:')
console.log(git(clone, ['diff', '--no-renames', '--name-status', parent, commit]).replace(/^/gm, '  '))
console.log('snapshot: run both scans on the clone, then the maintainer pushes, without --force:')
console.log(`  git -C ${clone} push origin main`)
console.log(`snapshot: the release then takes --target ${commit}`)
