// release.mjs run as a script, with git, npm and npx stubbed (pass 10, M-3):
// a --build-only run reaches electron-builder with the public repository in
// its config, instead of crashing on the missing --repo. It runs from a copy
// of scripts/ in a temporary folder, so the repository's release/ isn't touched.

import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const REPO = join(import.meta.dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'ccc-release-script-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function stub(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}

describe('release.mjs --build-only', () => {
  it('reaches electron-builder with the public repository as the update feed, and publishes nothing', () => {
    const root = join(dir, 'root')
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    cpSync(join(REPO, 'scripts'), join(root, 'scripts'), { recursive: true })
    cpSync(join(REPO, 'package.json'), join(root, 'package.json'))
    const sha = 'a'.repeat(40)
    const log = join(dir, 'calls.log')
    stub(bin, 'git', `echo "git $*" >> ${log}
case "$*" in
  "status"*) ;;
  "fetch"*) ;;
  "rev-parse --abbrev-ref HEAD") echo main ;;
  "rev-parse"*) echo ${sha} ;;
esac`)
    stub(bin, 'npm', `echo "npm $*" >> ${log}`)
    // electron-builder's arguments are recorded, then the run stops: nothing is built or signed.
    stub(bin, 'npx', `echo "npx $*" >> ${log}; exit 7`)
    stub(bin, 'gh', `echo "gh $*" >> ${log}; exit 9`)
    // A beta version builds with --prerelease, as a beta is published (MIP2-1497).
    const { version } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'release.mjs'), '--build-only', ...(version.includes('-') ? ['--prerelease'] : [])], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, CSC_NAME: 'Someone (ABCDE12345)', APPLE_ID: 'x', APPLE_APP_SPECIFIC_PASSWORD: 'x', APPLE_TEAM_ID: 'x' },
    })
    const calls = readFileSync(log, 'utf8')
    expect(r.stderr).not.toMatch(/TypeError/)
    const builder = calls.split('\n').find(l => l.startsWith('npx electron-builder'))
    expect(builder, `${calls}\n${r.stderr}`).toBeDefined()
    expect(builder).toContain('-c.publish.owner=avanrossum')
    expect(builder).toContain('-c.publish.repo=cc-command-center')
    expect(builder).toContain('-c.mac.identity=Someone (ABCDE12345)')
    expect(builder).toContain('--publish never')
    expect(builder).toContain('-c.npmRebuild=false')
    expect(calls).not.toMatch(/^gh /m)
  })
})

