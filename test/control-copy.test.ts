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

const { onWholeDisk, registerControl } = await import('../src/main/control.ts')
const { IPC } = await import('../src/shared/ipc.ts')
type Deps = Parameters<typeof registerControl>[0]

const SRC = 'c0ffee01-0000-4000-8000-000000000001'
const COPY = 'c0ffee0a-0000-4000-8000-00000000000a'

function setup() {
  handlers.clear()
  const launched: [string, unknown, unknown][] = []
  const asked: unknown[] = []
  const host = {
    startCopy: async (_id: string, opts: unknown) => (asked.push(opts), { sessionId: COPY, cwd: '/w' }),
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
    snapshotOf: () => ({ sessionId: SRC, name: { value: 'source' }, awaitingFirstPrompt: { value: false }, activity: { value: 'idle' } }),
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
  it('is refused, by its path or through a link to it, before anything starts', async () => {
    const { asked, launch } = setup()
    expect(await launch({ cwd: '/' })).toEqual({ ok: false, error: 'bad launch request' })
    expect(await launch({ cwd: '/./' })).toEqual({ ok: false, error: 'bad launch request' })
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

  it('onWholeDisk reads the real path', () => {
    expect(onWholeDisk('/w/root', p => (p === '/w/root' ? '/' : p))).toBe(true)
    expect(onWholeDisk('/w/app', p => p)).toBe(false)
  })
})
