// The trust step's terminal run (MIP2-1399): the same command in a terminal
// in the folder, Alex's keys only, and the id read from the output.

import { describe, expect, it } from 'vitest'
import type { AttachProcess } from '../src/attach-view.ts'
import { TrustRuns } from '../src/trust-run.ts'

function setup() {
  const written: string[] = []
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  const spawned: { file: string; args: string[]; cwd: string }[] = []
  const done: [string | null, string | null][] = []
  const launched: unknown[] = []
  const abandoned: string[] = []
  const completed: string[] = []
  const runs = new TrustRuns(
    {
      prepareLaunch: async o => ({ args: ['--bg', '--name', o.name ?? '', '--settings', '/s.json'], cwd: o.cwd, channelId: 'ch1' }),
      completeLaunch: async (_p, shortId) => (completed.push(shortId), { sessionId: `${shortId}-0000-4000-8000-000000000000` }),
      abandonLaunch: async p => void abandoned.push(p.channelId ?? ''),
    },
    '/bin/claude',
    { data: () => {}, done: (_r, sid, err, _cwd, _resumed, launch) => (done.push([sid, err]), void launched.push(launch)) },
    (cmd, _c, _r) => {
      spawned.push(cmd)
      const p: AttachProcess = {
        write: d => void written.push(d),
        resize: () => {},
        kill: () => onExit({ exitCode: 143 }),
        onData: cb => void (onData = cb),
        onExit: cb => void (onExit = cb),
      }
      return p
    },
  )
  return { runs, written, spawned, done, launched, abandoned, completed, emit: (d: string) => onData(d), exit: (c = 0) => onExit({ exitCode: c }) }
}

describe('TrustRuns', () => {
  it('runs the same launch command in the folder and sends nothing of its own', async () => {
    const t = setup()
    await t.runs.start({ cwd: '/new/folder', name: 'n' }, 100, 30)
    expect(t.spawned).toEqual([{ file: '/bin/claude', args: ['--bg', '--name', 'n', '--settings', '/s.json'], cwd: '/new/folder' }])
    expect(t.written).toEqual([])
  })

  it('on Yes, reads the backgrounded id and completes the launch', async () => {
    const t = setup()
    const id = await t.runs.start({ cwd: '/new' }, 100, 30)
    t.runs.write(id, '\r')
    t.emit('Quick safety check: …\r\n\x1b[2mbackgrounded · c0ffee08\x1b[0m\r\n')
    t.exit(0)
    await new Promise(r => setTimeout(r, 0))
    expect(t.written).toEqual(['\r'])
    expect(t.completed).toEqual(['c0ffee08'])
    expect(t.done).toEqual([['c0ffee08-0000-4000-8000-000000000000', null]])
    // Its options go with it, so main records the launch as any launch, mod copy included (MIP2-1558).
    expect(t.launched).toEqual([{ cwd: '/new' }])
  })

  it('on No or Esc, starts nothing and discards the channel', async () => {
    const t = setup()
    await t.runs.start({ cwd: '/new' }, 100, 30)
    t.emit('❯ No, exit\r\n')
    t.exit(1)
    await new Promise(r => setTimeout(r, 0))
    expect(t.done).toEqual([[null, null]])
    expect(t.abandoned).toEqual(['ch1'])
  })

  it('cancel ends the run with no session', async () => {
    const t = setup()
    const id = await t.runs.start({ cwd: '/new' }, 100, 30)
    t.runs.cancel(id)
    await new Promise(r => setTimeout(r, 0))
    expect(t.done).toEqual([[null, null]])
  })

  it("resumes a parked session in the terminal, and takes its id only when the output says it's the same session (MIP2-1461)", async () => {
    const SID = 'c0ffee01-0000-4000-8000-000000000001'
    const t = setup()
    await t.runs.start({ cwd: '/w', resume: SID }, 100, 30)
    expect(t.spawned[0]!.args).toEqual(['--resume', SID, '--bg', '--name', '', '--settings', '/s.json'])
    t.emit('note: woke session c0ffee01 with its saved options.\r\nbackgrounded · c0ffee01\r\n')
    t.exit(0)
    await new Promise(r => setTimeout(r, 0))
    expect(t.completed).toEqual(['c0ffee01'])
    // A copy keeps its own id.
    const c = setup()
    await c.runs.start({ cwd: '/w', resume: SID }, 100, 30)
    c.emit('note: session c0ffee01 is already running in the background, so this started a copy as 4171c8f8.\r\nbackgrounded · 4171c8f8\r\n')
    c.exit(0)
    await new Promise(r => setTimeout(r, 0))
    expect(c.completed).toEqual(['4171c8f8'])
    // Output that names no session starts none.
    const u = setup()
    await u.runs.start({ cwd: '/w', resume: SID }, 100, 30)
    u.emit('something else\r\n')
    u.exit(0)
    await new Promise(r => setTimeout(r, 0))
    expect(u.completed).toEqual([])
    expect(u.abandoned).toEqual(['ch1'])
  })

  it("carries the reload switch on the terminal run only when the host confirms the supervisor (MIP2-1463)", async () => {
    const spawned: { session?: boolean }[] = []
    const mk = (ok: boolean) =>
      new TrustRuns(
        {
          prepareLaunch: async o => ({ args: ['--bg'], cwd: o.cwd, channelId: 'ch' }),
          completeLaunch: async (_p, s) => ({ sessionId: `${s}-0000-4000-8000-000000000000` }),
          abandonLaunch: async () => {},
          sessionSwitch: async () => ok,
        },
        '/bin/claude',
        { data: () => {}, done: () => {} },
        cmd => (spawned.push({ session: cmd.session }), { write: () => {}, resize: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} }),
      )
    await mk(true).start({ cwd: '/w' }, 80, 24)
    await mk(false).start({ cwd: '/w' }, 80, 24)
    expect(spawned).toEqual([{ session: true }, { session: undefined }])
  })
})
