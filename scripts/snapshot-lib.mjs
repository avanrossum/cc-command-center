// The public snapshot's tree (release plan §4; MIP2-1472, M-2): a commit's
// tree minus scripts/snapshot-exclude.txt. scripts/snapshot.mjs commits it to
// the public repository, and scripts/release.mjs tags only a public commit
// whose tree is exactly it, so the tag names the source that was built.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The excluded paths, one per line; `#` comments and blank lines skipped. */
export function parseExcludes(text) {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
}

export function readExcludes(root) {
  return parseExcludes(readFileSync(join(root, 'scripts', 'snapshot-exclude.txt'), 'utf8'))
}

export function readPublished(root) {
  return parseExcludes(readFileSync(join(root, 'scripts', 'snapshot-publish.txt'), 'utf8'))
}

/**
 * The entries of `rev` in neither list: every top-level entry, and every
 * entry under tools/, scripts/, docs/, docs/release-notes/ and test/fixtures/
 * (pass 10, M-4; pass 11, M-2). A new file there has to be named in one list
 * before a snapshot is made.
 */
export function unclassified(root, rev, excludes, published) {
  const ls = path => execFileSync('git', ['ls-tree', '--name-only', rev, ...(path ? [path] : [])], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  const known = new Set([...excludes, ...published])
  return [...ls(''), ...['tools/', 'scripts/', 'docs/', 'docs/release-notes/', 'test/fixtures/'].flatMap(d => ls(d))].filter(e => !known.has(e))
}

/**
 * The tree id of `rev` with `excludes` removed, written into the repository
 * at `root` through a scratch index, so the working tree and the real index
 * are untouched.
 */
export function snapshotTree(root, rev, excludes) {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-snapshot-index-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
  const git = args => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim()
  try {
    git(['read-tree', rev])
    if (excludes.length) git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...excludes])
    return git(['write-tree'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The paths a snapshot adds that need a name-by-name confirmation (pass 11,
 * M-2): `git diff --name-status` lines with status A, outside src/ and test/,
 * plus any new file under test/fixtures/. A rename or copy (R or C, should
 * rename detection be on) counts as adding its new path (pass 12, M-1).
 */
export function addedToConfirm(nameStatus) {
  return nameStatus
    .split('\n')
    .map(l => l.split('\t'))
    .flatMap(([status, ...paths]) => (status === 'A' ? [paths[0]] : /^[RC]/.test(status ?? '') ? [paths.at(-1)] : []))
    .filter(path => path && (!/^(src|test)\//.test(path) || path.startsWith('test/fixtures/')))
}
