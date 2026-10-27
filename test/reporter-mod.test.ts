// Where a packaged app runs the reporter mod from (MIP2-1404).

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { modVerdict } from '../src/main/mod-verdict.ts'
import { checkModFolders, installMod, MOD_FOLDERS_MAX, modDir, modHash, unpackedPath } from '../src/main/reporter-mod.ts'

let dir: string
const mod = (root: string, hook = 'v1') => {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  mkdirSync(join(root, 'hooks'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{"name":"ccc-reporter"}')
  writeFileSync(join(root, 'hooks', 'register.ts'), hook)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-mod-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('reporter mod', () => {
  it('maps a path inside app.asar to the unpacked copy', async () => {
    expect(unpackedPath('/A.app/Contents/Resources/app.asar/dist')).toBe('/A.app/Contents/Resources/app.asar.unpacked/dist')
    expect(unpackedPath('/repo/dist')).toBe('/repo/dist')
  })

  it('copies the mod into the data folder once per version, and keeps an earlier version for sessions still using it', async () => {
    const src = join(dir, 'src')
    const data = join(dir, 'data')
    mod(src)
    const first = await installMod(src, data)
    expect(first).toBe(join(data, 'reporter-mod', modHash(src)))
    expect(readFileSync(join(first, 'hooks', 'register.ts'), 'utf8')).toBe('v1')
    // Claude Code lays its types in the folder; the same version isn't copied again.
    mkdirSync(join(first, '.claude-plugin', 'types'))
    expect(await installMod(src, data)).toBe(first)
    mod(src, 'v2')
    const second = await installMod(src, data)
    expect(second).not.toBe(first)
    expect(readFileSync(join(first, 'hooks', 'register.ts'), 'utf8')).toBe('v1')
    expect(readFileSync(join(second, 'hooks', 'register.ts'), 'utf8')).toBe('v2')
  })

  it('puts the shipped mod back when the installed copy was changed, and keeps the changed one aside (gate M-2)', async () => {
    const src = join(dir, 'src')
    const data = join(dir, 'data')
    mod(src)
    const dest = await installMod(src, data)
    // Claude Code's own types don't count as a change.
    mkdirSync(join(dest, '.claude-plugin', 'types'), { recursive: true })
    writeFileSync(join(dest, '.claude-plugin', 'types', 'x.d.ts'), 'declare const x: 1')
    const healed: { movedTo: string | null }[] = []
    expect(await installMod(src, data, h => healed.push(h))).toBe(dest)
    expect(healed).toEqual([])
    // A session rewrites a hook to approve everything.
    writeFileSync(join(dest, 'hooks', 'register.ts'), 'allow everything')
    expect(await installMod(src, data, h => healed.push(h), () => 7)).toBe(dest)
    expect(readFileSync(join(dest, 'hooks', 'register.ts'), 'utf8')).toBe('v1')
    expect(healed).toEqual([{ dir: dest, movedTo: `${dest}.changed-7` }])
    expect(readFileSync(join(`${dest}.changed-7`, 'hooks', 'register.ts'), 'utf8')).toBe('allow everything')
  })

  it('treats a file swapped for a symlink, or a file added, as a change (gate M-2)', async () => {
    const src = join(dir, 'src')
    const data = join(dir, 'data')
    mod(src)
    const dest = await installMod(src, data)
    rmSync(join(dest, 'hooks', 'register.ts'))
    symlinkSync(join(src, 'hooks', 'register.ts'), join(dest, 'hooks', 'register.ts'))
    let n = 0
    await installMod(src, data, () => n++, () => 1)
    writeFileSync(join(dest, 'hooks', 'extra.ts'), 'x')
    await installMod(src, data, () => n++, () => 2)
    expect(n).toBe(2)
    expect(existsSync(join(dest, 'hooks', 'extra.ts'))).toBe(false)
  })

  it("unpacks the whole mod from the asar, its .claude-plugin folder included (a ** glob skips dot folders)", async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { build: { asarUnpack: string[] } }
    expect(pkg.build.asarUnpack).toEqual(expect.arrayContaining(['dist/mod/**', 'dist/mod/.claude-plugin/**']))
  })

  it("refuses a source that doesn't match the hash built into the app (gate run 2, M-3)", async () => {
    const src = join(dir, 'src')
    mod(src)
    const { modHashOf } = await import('../scripts/mod-hash.mjs')
    // The build's algorithm and the app's agree.
    expect(modHashOf(src)).toBe(modHash(src))
    expect(await installMod(src, join(dir, 'data'), () => {}, Date.now, modHash(src))).toContain(modHash(src))
    mod(src, 'tampered')
    await expect(installMod(src, join(dir, 'data2'), () => {}, Date.now, modHashOf(join(dir, 'data', 'reporter-mod', readdirSync(join(dir, 'data', 'reporter-mod'))[0]!)))).rejects.toThrow('changed after it was built')
  })

  it('sets aside an older version whose files no longer match its name, and leaves good ones and the current one (gate run 2, L-1)', async () => {
    const src = join(dir, 'src')
    const data = join(dir, 'data')
    mod(src, 'v1')
    const old = await installMod(src, data)
    mod(src, 'v2')
    const old2 = await installMod(src, data)
    mod(src, 'v3')
    const current = await installMod(src, data)
    writeFileSync(join(old, 'hooks', 'register.ts'), 'allow everything')
    const healed: { dir: string; movedTo: string | null }[] = []
    await checkModFolders(data, current, h => healed.push(h), () => 9)
    expect(healed).toEqual([{ dir: old, movedTo: `${old}.changed-9` }])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(old2)).toBe(true)
    // The current folder is installMod's to heal, not this check's.
    writeFileSync(join(current, 'hooks', 'register.ts'), 'x')
    await checkModFolders(data, current, h => healed.push(h))
    expect(healed).toHaveLength(1)
  })

  it("hashes nested folders and symlinks, and leaves Claude Code's types out (gate run 3, L-8, I-2)", async () => {
    const src = join(dir, 'src')
    mod(src)
    mkdirSync(join(src, 'hooks', 'nested', 'deep'), { recursive: true })
    writeFileSync(join(src, 'hooks', 'nested', 'deep', 'x.ts'), 'x')
    const base = modHash(src)
    // The engine's types don't count.
    mkdirSync(join(src, '.claude-plugin', 'types', 'claude-code'), { recursive: true })
    writeFileSync(join(src, '.claude-plugin', 'types', 'claude-code', 'index.d.ts'), 'declare const y: 1')
    expect(modHash(src)).toBe(base)
    // A nested change and a symlink do.
    writeFileSync(join(src, 'hooks', 'nested', 'deep', 'x.ts'), 'y')
    const changed = modHash(src)
    expect(changed).not.toBe(base)
    symlinkSync('/etc/hosts', join(src, 'hooks', 'link.ts'))
    expect(modHash(src)).not.toBe(changed)
  })

  it("no hook imports from Claude Code's types folder, and 'claude-code' only as types (I-2)", async () => {
    const hooks = readdirSync(new URL('../mod/hooks/', import.meta.url)).filter(f => f.endsWith('.ts'))
    for (const f of hooks) {
      const text = readFileSync(new URL(`../mod/hooks/${f}`, import.meta.url), 'utf8')
      expect(text, f).not.toMatch(/from ['"][^'"]*\.claude-plugin/)
      for (const m of text.matchAll(/^import (.*) from ['"]claude-code['"]/gm)) expect(m[1]!.startsWith('type '), f).toBe(true)
    }
  })

  it('sets aside an odd entry in the versions folder instead of failing (gate run 3, L-4)', async () => {
    const data = join(dir, 'data')
    mkdirSync(join(data, 'reporter-mod'), { recursive: true })
    writeFileSync(join(data, 'reporter-mod', '0123456789abcdef'), 'not a folder')
    const healed: string[] = []
    await expect(checkModFolders(data, null, h => healed.push(h.dir), () => 3)).resolves.toMatchObject({ unchecked: [] })
    expect(healed).toEqual([join(data, 'reporter-mod', '0123456789abcdef')])
  })

  it("reports a changed copy it can't move aside, instead of passing over it (pass 4, M-3)", async () => {
    const src = join(dir, 'src')
    const data = join(dir, 'data')
    mod(src, 'v1')
    const old = await installMod(src, data)
    mod(src, 'v2')
    const current = await installMod(src, data)
    writeFileSync(join(old, 'hooks', 'register.ts'), 'allow everything')
    writeFileSync(join(current, 'hooks', 'register.ts'), 'allow everything')
    // A folder that can't be renamed: the owner can do this with `chflags uchg` too (EPERM).
    chmodSync(join(data, 'reporter-mod'), 0o500)
    try {
      const healed: { dir: string; movedTo: string | null; why?: string }[] = []
      await checkModFolders(data, current, h => healed.push(h), () => 4)
      expect(healed).toEqual([{ dir: old, movedTo: null, why: 'EACCES' }])
      await expect(installMod(src, data, h => healed.push(h), () => 5)).rejects.toThrow()
      expect(healed[1]).toEqual({ dir: current, movedTo: null, why: 'EACCES' })
    } finally {
      chmodSync(join(data, 'reporter-mod'), 0o700)
    }
  })

  it.runIf(process.platform === 'darwin')('clears an immutable flag before setting a changed copy aside (pass 5, H-1)', async () => {
    const { execFileSync } = await import('node:child_process')
    const src = join(dir, 'src')
    const data = join(dir, 'data')
    mod(src)
    const dest = await installMod(src, data)
    writeFileSync(join(dest, 'hooks', 'register.ts'), 'allow everything')
    execFileSync('/usr/bin/chflags', ['uchg', dest])
    const healed: { movedTo: string | null }[] = []
    expect(await installMod(src, data, h => healed.push(h), () => 8)).toBe(dest)
    expect(healed).toEqual([{ dir: dest, movedTo: `${dest}.changed-8` }])
    expect(readFileSync(join(dest, 'hooks', 'register.ts'), 'utf8')).toBe('v1')
  })

  it('installs a fresh copy under another name when a changed one can\'t be moved, and reuses it (pass 5, H-1)', async () => {
    const src = join(dir, 'src')
    const data = join(dir, 'data')
    mod(src)
    const dest = await installMod(src, data)
    writeFileSync(join(dest, 'hooks', 'register.ts'), 'allow everything')
    const stuck = {
      rename: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
      unflag: async () => {},
    }
    const healed: { movedTo: string | null; why?: string }[] = []
    const fresh = await installMod(src, data, h => healed.push(h), () => 9, null, stuck)
    expect(fresh).toBe(`${dest}-r9`)
    expect(readFileSync(join(fresh, 'hooks', 'register.ts'), 'utf8')).toBe('v1')
    expect(healed).toEqual([{ dir: dest, movedTo: null, why: 'EPERM' }])
    // The next check reuses it rather than making another.
    expect(await installMod(src, data, () => {}, () => 10, null, stuck)).toBe(fresh)
    // The older-versions check knows a fresh copy's name, and checks it like any version.
    writeFileSync(join(fresh, 'hooks', 'register.ts'), 'x')
    const set: string[] = []
    await checkModFolders(data, null, h => set.push(h.dir), () => 11)
    expect(set).toContain(fresh)
  })

  it('gives no hash to a copy with a NUL byte or a symlink, so a file can\'t carry the files after it (pass 4, L-4)', async () => {
    const { modHashOf } = await import('../scripts/mod-hash.mjs')
    const a = join(dir, 'a')
    mod(a)
    writeFileSync(join(a, 'README.md'), 'x')
    writeFileSync(join(a, 'z.md'), 'y')
    const b = join(dir, 'b')
    mod(b)
    // Under a plain path-NUL-bytes-NUL stream, README.md absorbing z.md would hash the same.
    writeFileSync(join(b, 'README.md'), 'x\0z.md\0y')
    expect(modHashOf(a)).toMatch(/^[0-9a-f]{16}$/)
    expect(modHashOf(b)).toBe('refused: README.md contains a NUL byte')
    symlinkSync('/etc/hosts', join(a, 'link.md'))
    expect(modHashOf(a)).toBe('refused: link.md is a symlink')
    // A copy that gets no hash never matches its folder's name, so it's set aside.
    const data = join(dir, 'data')
    const src = join(dir, 'src')
    mod(src, 'v1')
    const v1 = await installMod(src, data)
    mod(src, 'v2')
    const v2 = await installMod(src, data)
    writeFileSync(join(v1, 'hooks', 'register.ts'), 'v1\0')
    const healed: string[] = []
    await checkModFolders(data, v2, h => healed.push(h.dir), () => 6)
    expect(healed).toEqual([v1])
  })

  it("doesn't hold the main thread while flags are cleared, and tries a stuck folder once per start (pass 6, M-3)", async () => {
    const src = join(dir, 'src')
    const data = join(dir, 'data')
    mod(src)
    const dest = await installMod(src, data)
    writeFileSync(join(dest, 'hooks', 'register.ts'), 'allow everything')
    let unflags = 0
    const ops = {
      rename: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
      // A chflags that takes 200 ms, as a deep tree would.
      unflag: () => (unflags++, new Promise<void>(r => setTimeout(r, 200))),
      stuck: new Set<string>(),
    }
    let ticked = 0
    const timer = setInterval(() => ticked++, 10)
    const started = Date.now()
    await installMod(src, data, () => {}, () => 1, null, ops)
    clearInterval(timer)
    // Other work, an IPC answer say, ran while it waited.
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    expect(ticked).toBeGreaterThan(5)
    expect(ops.stuck.has(dest)).toBe(true)
    // The next minute's check doesn't try again.
    await installMod(src, data, () => {}, () => 2, null, ops)
    expect(unflags).toBe(1)
  })

  it('returns the folders past its cap unchecked (pass 6, M-3)', async () => {
    const data = join(dir, 'data')
    for (let i = 0; i <= MOD_FOLDERS_MAX; i++) mkdirSync(join(data, 'reporter-mod', i.toString(16).padStart(16, '0')), { recursive: true })
    expect((await checkModFolders(data, null, () => {})).unchecked).toHaveLength(1)
  })

  it('checks the versions sessions use first, removes the rest, and a tampered one is refused for resume and respawn (pass 7, H-1)', async () => {
    const src = join(dir, 'src')
    const data = join(dir, 'data')
    mod(src, 'used')
    const used = await installMod(src, data)
    mod(src, 'current')
    const current = await installMod(src, data)
    writeFileSync(join(used, 'hooks', 'register.ts'), 'allow everything')
    // 33 folders nothing uses, made to push the used one past the cap.
    for (let i = 0; i <= MOD_FOLDERS_MAX; i++) mkdirSync(join(data, 'reporter-mod', i.toString(16).padStart(16, '0')), { recursive: true })
    const name = (p: string) => p.slice(p.lastIndexOf('/') + 1)
    const referenced = new Set([name(used), name(current)])
    const healed: string[] = []
    const r = await checkModFolders(data, current, h => healed.push(h.dir), () => 5, {}, referenced)
    // The unused folders are gone, the tampered used one was checked and set aside, nothing is left unchecked.
    expect(r.unchecked).toEqual([])
    expect(healed).toEqual([used])
    expect(r.verified.has(name(used))).toBe(false)
    const state = { packaged: true, stuck: new Set<string>(), verified: new Set([...r.verified, name(current)]), unchecked: r.unchecked.length, launchBlocked: null }
    // A session on it is refused for resume and skipped by the watchdog; one on the current copy isn't.
    expect(modVerdict(name(used), state)).toMatch(/wasn't verified/)
    expect(modVerdict(name(current), state)).toBeNull()
  })

  it('refuses a session with no version on record while any copy is stuck or unchecked (pass 7, L-4)', () => {
    const base = { packaged: true, stuck: new Set<string>(), verified: new Set<string>(), unchecked: 0, launchBlocked: null }
    expect(modVerdict(undefined, base)).toBeNull()
    expect(modVerdict(undefined, { ...base, unchecked: 2 })).toMatch(/no record/)
    expect(modVerdict(undefined, { ...base, stuck: new Set(['abc']) })).toMatch(/no record/)
    expect(modVerdict('abc', { ...base, packaged: false })).toBeNull()
    expect(modVerdict(undefined, { ...base, launchBlocked: 'paused' })).toBe('paused')
    // An app-launched session with no version on record is unverified; one started elsewhere isn't the app's to check (pass 8, L-3).
    expect(modVerdict(undefined, base, true)).toMatch(/no record of which reporter mod copy/)
    expect(modVerdict(undefined, base, false)).toBeNull()
  })

  it('refuses a missing mod, and uses dist/mod directly in development', async () => {
    await expect(installMod(join(dir, 'none'), dir)).rejects.toThrow(/missing/)
    mod(join(dir, 'dist', 'mod'))
    expect(await modDir(join(dir, 'dist'), false, join(dir, 'data'))).toBe(join(dir, 'dist', 'mod'))
  })
})
