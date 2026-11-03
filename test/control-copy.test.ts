// "Start a copy" records the copy's launch with the folder the host started it in (MIP2-1602 gate pass 39, M-1, M-2).

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => void handlers.set(ch, fn), on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  clipboard: {},
  dialog: {},
  shell: {},
}))
vi.mock('../src/main/security.ts', () => ({ isTrustedSender: () => true }))

const { registerControl } = await import('../src/main/control.ts')
const { IPC } = await import('../src/shared/ipc.ts')
const { isWholeDisk, NoFolderKnown, WHOLE_DISK_MESSAGE } = await import('@ccc/coupling')
type Deps = Parameters<typeof registerControl>[0]

const SRC = 'c0ffee01-0000-4000-8000-000000000001'
const COPY = 'c0ffee0a-0000-4000-8000-00000000000a'

function setup(folder = '/w') {
  handlers.clear()
  const launched: [string, unknown, unknown][] = []
  const asked: unknown[] = []
  const host = {
    // As the host does: no known folder, or the whole disk, is refused before anything starts.
    startCopy: async (_id: string, opts: unknown) => {
      if (!folder) throw new NoFolderKnown()
      if (isWholeDisk(folder)) throw new Error(WHOLE_DISK_MESSAGE)
      asked.push(opts)
      return { sessionId: COPY, cwd: folder }
    },
    launch: async (opts: unknown) => (asked.push(opts), { sessionId: COPY }),
  }
  registerControl({
    host,
    hub: {},
    control: {},
    pool: {},
    trust: {},
    readOnly: () => null,
    onLaunched: (id: string, req: unknown, source: unknown) => void launched.push([id, req, source]),
    snapshotOf: () => ({ sessionId: SRC, name: { value: 'source' }, awaitingFirstPrompt: { value: false }, activity: { value: 'idle' }, cwd: { value: folder } }),
    launchedHere: () => true,
  } as unknown as Deps)
  const startCopy = (id: unknown, req: unknown) => handlers.get(IPC.startCopy)!({}, id, req)
  const launch = (req: unknown) => handlers.get(IPC.launch)!({}, req)
  return { launched, asked, startCopy, launch }
}

describe('Start a copy (MIP2-1602)', () => {
  beforeEach(() => handlers.clear())

  it('records the copy with the folder the host started it in, never one the request sent', async () => {
    const { launched, asked, startCopy } = setup()
    const r = await startCopy(SRC, { cwd: '/elsewhere', name: 'copy', model: 'haiku', effort: 'low', permissionMode: 'default' })
    expect(r).toEqual({ ok: true, sessionId: COPY })
    expect(asked).toEqual([{ name: 'copy', model: 'haiku', effort: 'low', permissionMode: 'default' }])
    expect(launched).toEqual([[COPY, { name: 'copy', model: 'haiku', effort: 'low', permissionMode: 'default', cwd: '/w' }, { copyOf: SRC }]])
  })

  it('takes a request with no folder, and refuses a malformed one', async () => {
    const { launched, startCopy } = setup()
    expect(await startCopy(SRC, { model: 'haiku' })).toEqual({ ok: true, sessionId: COPY })
    expect(launched[0]?.[1]).toEqual({ model: 'haiku', cwd: '/w' })
    expect(await startCopy(SRC, { model: 'bad model!' })).toEqual({ ok: false, error: 'bad request' })
    expect(await startCopy('not-an-id', {})).toEqual({ ok: false, error: 'bad request' })
  })

  it('refuses a copy that carries a prompt, a resume or a source session (MIP2-1603 L-2)', async () => {
    const { launched, startCopy } = setup()
    for (const extra of [{ prompt: 'hi' }, { resume: SRC }, { fromSession: SRC }]) expect(await startCopy(SRC, { model: 'haiku', ...extra })).toEqual({ ok: false, error: 'bad request' })
    expect(launched).toEqual([])
  })
})

describe('a launch at the whole disk (MIP2-1603 M-1)', () => {
  it('refuses a copy of a session whose folder is the whole disk, before it starts (gate pass 43, L-3)', async () => {
    const { asked, launched, startCopy } = setup('/')
    expect(await startCopy(SRC, { model: 'haiku' })).toEqual({ ok: false, error: 'Choose a folder other than the whole disk.' })
    expect([asked, launched]).toEqual([[], []])
  })

  it('refuses a copy whose folder is a link to the whole disk (gate pass 53, L-5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccc-copy-link-'))
    try {
      symlinkSync('/', join(dir, 'root'))
      const { asked, launched, startCopy } = setup(join(dir, 'root'))
      expect(await startCopy(SRC, { model: 'haiku' })).toEqual({ ok: false, error: 'Choose a folder other than the whole disk.' })
      expect([asked, launched]).toEqual([[], []])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a copy while its session's folder isn't known yet (gate pass 48, I-2)", async () => {
    const { asked, startCopy } = setup('')
    expect(await startCopy(SRC, { model: 'haiku' })).toEqual({ ok: false, error: 'Wait a moment for the session to report its folder, then try again.' })
    expect(asked).toEqual([])
  })

  it('refuses a copy carrying a malformed extraArgs, without a throw (gate pass 44, L-2)', async () => {
    const { asked, startCopy } = setup()
    for (const extraArgs of [null, {}, 3, true]) expect(await startCopy(SRC, { model: 'haiku', extraArgs })).toEqual({ ok: false, error: 'bad request' })
    expect(asked).toEqual([])
  })

  it('is refused, by its path or through a link to it, before anything starts', async () => {
    const { asked, launch } = setup()
    expect(await launch({ cwd: '/' })).toEqual({ ok: false, error: 'Choose a folder other than the whole disk.' })
    expect(await launch({ cwd: '/./' })).toEqual({ ok: false, error: 'Choose a folder other than the whole disk.' })
    const dir = mkdtempSync(join(tmpdir(), 'ccc-root-link-'))
    try {
      symlinkSync('/', join(dir, 'root'))
      expect(await launch({ cwd: join(dir, 'root') })).toEqual({ ok: false, error: 'Choose a folder other than the whole disk.' })
      expect(asked).toEqual([])
      expect(await launch({ cwd: dir })).toMatchObject({ ok: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a launch at the data volume or a mounted disk too (gate pass 53, L-1)', async () => {
    const { asked, launch } = setup()
    expect(await launch({ cwd: '/System/Volumes/Data' })).toEqual({ ok: false, error: 'Choose a folder other than the whole disk.' })
    expect(asked).toEqual([])
  })
})
