// A resume from the app re-keys the channel, and stops a running session first (MIP2-1441 live run).

import { describe, expect, it } from 'vitest'
import { LiftedRefusals, ModStuck, rekeyedFor, RESUME_REPEAT_MS, ResumeGate, resumeFromApp } from '../src/main/resume.ts'

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
      onRekeying: (): (() => void) | void => void steps.push('rekeyed'),
    },
  }
}

describe('a session with no record of its mod copy (MIP2-1504)', () => {
  it('records the copy its saved options name first, then resumes it bare, as any other', async () => {
    const { steps, d } = deps({ running: false, channel: true })
    let recorded = false
    await resumeFromApp(SID, { ...d, unrecorded: () => true, backfill: () => ((recorded = true), null), modStuck: () => (recorded ? null : 'unrecorded') })
    expect(steps).toEqual(['not-running', 'rekey-keep', 'rekeyed', 'resume', 'clear-mark', 'cleared'])
  })

  it('refuses with the reason, before anything else, when the copy can\'t be found or checked', async () => {
    const { steps, d } = deps({ running: true, channel: true })
    await expect(resumeFromApp(SID, { ...d, unrecorded: () => true, backfill: () => "its saved reporter mod copy no longer matches its name" })).rejects.toThrow(
      /no longer matches its name\. Start a copy/,
    )
    expect(steps).toEqual([])
    await expect(resumeFromApp(SID, { ...d, unrecorded: () => true })).rejects.toBeInstanceOf(ModStuck)
  })
})

describe('resumeFromApp', () => {
  it('stops a running session before the re-key, so no process keeps the old secret', async () => {
    const { steps, d } = deps({ running: true, channel: true })
    await resumeFromApp(SID, d)
    expect(steps).toEqual(['stop', 'rekey-keep', 'rekeyed', 'resume', 'clear-mark', 'cleared'])
  })

  it('re-keys and resumes a stopped session', async () => {
    const { steps, d } = deps({ running: false, channel: true })
    await resumeFromApp(SID, d)
    expect(steps).toEqual(['not-running', 'rekey-keep', 'rekeyed', 'resume', 'clear-mark', 'cleared'])
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
    expect(steps).toEqual(['not-running', 'rekey-keep', 'rekeyed'])
  })

  it('puts back the refusal of the next process when the resume fails (gate pass 33, L-3)', async () => {
    const { steps, d } = deps({ running: false, channel: true })
    d.onRekeying = () => (steps.push('lifted'), () => void steps.push('rearmed'))
    d.host.resume = async () => {
      throw new Error('trust refused')
    }
    await expect(resumeFromApp(SID, d)).rejects.toThrow('trust refused')
    expect(steps).toEqual(['not-running', 'rekey-keep', 'lifted', 'rearmed'])
    const ok = deps({ running: false, channel: true })
    ok.d.onRekeying = () => (ok.steps.push('lifted'), () => void ok.steps.push('rearmed'))
    await resumeFromApp(SID, ok.d)
    expect(ok.steps).not.toContain('rearmed')
  })

  it('puts back the lift when clearing the mark throws (gate pass 36, L-1)', async () => {
    const { steps, d } = deps({ running: false, channel: true })
    d.onRekeying = () => (steps.push('lifted'), () => void steps.push('rearmed'))
    d.hub.clearMark = async () => {
      throw new Error('rm failed')
    }
    await expect(resumeFromApp(SID, d)).rejects.toThrow('rm failed')
    expect(steps).toEqual(['not-running', 'rekey-keep', 'lifted', 'resume', 'rearmed'])
  })

  it('puts back the refusal of the next process when the mark stays after the resume (gate pass 34, L-1)', async () => {
    const { steps, d } = deps({ running: false, channel: true })
    d.onRekeying = () => (steps.push('lifted'), () => void steps.push('rearmed'))
    d.hub.clearMark = async () => (steps.push('mark-kept'), false)
    await resumeFromApp(SID, d)
    expect(steps).toEqual(['not-running', 'rekey-keep', 'lifted', 'resume', 'mark-kept', 'rearmed'])
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
    expect(steps).toEqual(['not-running', 'rekey-keep', 'rekeyed', 'resume', 'kept'])
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

describe('rekeyedFor (gate pass 43, INFO-3; pass 44, L-2, INFO-2)', () => {
  it('drops the lift first, and reports a store that fails to save instead of throwing', () => {
    const lifted = new LiftedRefusals()
    lifted.lift(SID)
    const notices: string[] = []
    const rekeyed = rekeyedFor({ lifted, clearUntrusted: () => { throw new Error('disk full') }, notice: t => void notices.push(t) })
    expect(() => rekeyed(SID)).not.toThrow()
    expect(lifted.has(SID)).toBe(false)
    expect(notices).toEqual([expect.stringMatching(/couldn't save that its alert is cleared.*disk full$/)])
  })

  it('clears the mark with no notice when the store saves', () => {
    const cleared: string[] = []
    const notices: string[] = []
    rekeyedFor({ lifted: new LiftedRefusals(), clearUntrusted: id => void cleared.push(id), notice: t => void notices.push(t) })(SID)
    expect([cleared, notices]).toEqual([[SID], []])
  })
})
