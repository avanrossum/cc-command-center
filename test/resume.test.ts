// A resume from the app re-keys the channel, and stops a running session first (MIP2-1441 live run).

import { describe, expect, it } from 'vitest'
import { ModStuck, RESUME_REPEAT_MS, ResumeGate, resumeFromApp } from '../src/main/resume.ts'

const SID = 'c0ffee01-0000-4000-8000-000000000001'

function deps(o: { running: boolean; channel: boolean; untrusted?: string | null }) {
  const steps: string[] = []
  return {
    steps,
    d: {
      host: {
        stopIfRunning: async () => (steps.push(o.running ? 'stop' : 'not-running'), o.running),
        resume: async () => void steps.push('resume'),
      },
      hub: {
        channelOf: () => (o.channel ? 'ch' : null),
        rekey: async (_id: string, opts?: { keepMark?: boolean }) => void steps.push(opts?.keepMark ? 'rekey-keep' : 'rekey'),
        untrustedReason: () => o.untrusted ?? null,
        clearMark: async () => (steps.push('clear-mark'), true),
      },
      onRekeyed: () => void steps.push('cleared'),
    },
  }
}

describe('resumeFromApp', () => {
  it('stops a running session before the re-key, so no process keeps the old secret', async () => {
    const { steps, d } = deps({ running: true, channel: true })
    await resumeFromApp(SID, d)
    expect(steps).toEqual(['stop', 'rekey-keep', 'resume', 'clear-mark', 'cleared'])
  })

  it('re-keys and resumes a stopped session', async () => {
    const { steps, d } = deps({ running: false, channel: true })
    await resumeFromApp(SID, d)
    expect(steps).toEqual(['not-running', 'rekey-keep', 'resume', 'clear-mark', 'cleared'])
  })

  it('resumes a session with no channel as it is, and refuses an untrusted one whose channel is gone', async () => {
    const plain = deps({ running: true, channel: false })
    await resumeFromApp(SID, plain.d)
    expect(plain.steps).toEqual(['resume'])
    const gone = deps({ running: false, channel: false, untrusted: 'the socket file was moved or replaced' })
    await expect(resumeFromApp(SID, gone.d)).rejects.toThrow("can't be trusted")
    expect(gone.steps).toEqual([])
  })

  it('keeps the mark when the resume itself fails (pass 5, L-2)', async () => {
    const { steps, d } = deps({ running: false, channel: true })
    d.host.resume = async () => {
      throw new Error('trust refused')
    }
    await expect(resumeFromApp(SID, d)).rejects.toThrow('trust refused')
    expect(steps).toEqual(['not-running', 'rekey-keep'])
  })

  it("doesn't resume or clear the mark when the stop or the re-key fails", async () => {
    const { steps, d } = deps({ running: true, channel: true })
    d.hub.rekey = async () => {
      throw new Error('re-key failed')
    }
    await expect(resumeFromApp(SID, d)).rejects.toThrow('re-key failed')
    expect(steps).toEqual(['stop'])
  })

  it('refuses to resume a session on a stuck mod copy, or while launches are paused, before touching it (pass 6, H-1)', async () => {
    for (const why of ['its copy could not be moved aside', "the reporter mod's copy is changed and couldn't be replaced (EPERM)"]) {
      const { steps, d } = deps({ running: true, channel: true })
      const err = await resumeFromApp(SID, { ...d, modStuck: () => why }).catch(e => e)
      expect(err).toBeInstanceOf(ModStuck)
      expect(err.message).toContain('Start a copy')
      expect(steps).toEqual([])
    }
    const ok = deps({ running: false, channel: true })
    await resumeFromApp(SID, { ...ok.d, modStuck: () => null })
    expect(ok.steps.at(-1)).toBe('cleared')
  })

  it("keeps the store's mark when the channel changed during the resume (pass 6, M-1)", async () => {
    const { steps, d } = deps({ running: false, channel: true })
    d.hub.clearMark = async () => (steps.push('kept'), false)
    await resumeFromApp(SID, d)
    expect(steps).toEqual(['not-running', 'rekey-keep', 'resume', 'kept'])
  })
})

describe('ResumeGate (MIP2-1467)', () => {
  it('joins a resume already under way instead of running a second --resume, the race from 10:24', async () => {
    const gate = new ResumeGate()
    let runs = 0
    let finish = () => {}
    const resume = () => (runs++, new Promise<void>(r => (finish = r)))
    // Two opens of an ended session 1.6 s apart: the second arrives while the first is still resuming.
    const first = gate.run(SID, resume)
    const second = gate.run(SID, resume)
    finish()
    await Promise.all([first, second])
    expect(runs).toBe(1)
  })

  it('takes a resume within 15 s of the last as a repeat, and runs one after that', async () => {
    let t = 0
    const gate = new ResumeGate(() => t)
    let runs = 0
    const resume = async () => void runs++
    await gate.run(SID, resume)
    t = RESUME_REPEAT_MS - 1
    await gate.run(SID, resume)
    expect(runs).toBe(1)
    t = RESUME_REPEAT_MS + 1
    await gate.run(SID, resume)
    expect(runs).toBe(2)
  })

  it("lets a failed resume be tried again at once, and doesn't hold other sessions", async () => {
    const gate = new ResumeGate()
    let runs = 0
    await expect(gate.run(SID, async () => (runs++, Promise.reject(new Error('no'))))).rejects.toThrow('no')
    await gate.run(SID, async () => void runs++)
    await gate.run('other-0000-4000-8000-000000000000', async () => void runs++)
    expect(runs).toBe(3)
  })
})
