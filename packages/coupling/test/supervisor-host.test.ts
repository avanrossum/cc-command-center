// The supervisor host's lifecycle commands (MIP2-1396), against a fake runner.

import { describe, expect, it } from 'vitest'
import { ClaudeCommandError } from '../src/claude-cli.ts'
import { ResumedAsCopy, resumedCopy, StraySessions, SupervisorHost, WorkspaceNotTrusted, type HostChannels } from '../src/supervisor-host.ts'

const SID = 'c0ffee01-0000-4000-8000-000000000001'
const LISTED = JSON.stringify([{ pid: 1, id: 'c0ffee01', cwd: '/w', kind: 'background', startedAt: 1, sessionId: SID, status: 'idle', state: 'done' }])

function fake(answers: Record<string, string | Error> = {}) {
  const calls: { args: string[]; cwd?: string }[] = []
  const bound: [string, string][] = []
  const closed: string[] = []
  const channels: HostChannels = {
    prepareLaunch: async opts => ({ channelId: `ch-${opts.isolation}`, args: ['--plugin-dir', '/mod', '--settings', '/s.json'] }),
    bind: (c, s) => void bound.push([c, s]),
    closeFor: async s => void closed.push(s),
    close: async c => void closed.push(c),
  }
  const host = new SupervisorHost({
    binary: '/bin/claude',
    channels,
    sleep: async () => {},
    run: async (args, opts) => {
      calls.push({ args, cwd: opts?.cwd })
      const key = args[0] === 'agents' ? 'agents' : args[0]!
      const a = answers[key] ?? (key === 'agents' ? LISTED : '')
      if (a instanceof Error) throw a
      return a
    },
  })
  return { host, calls, bound, closed }
}

describe('SupervisorHost lifecycle', () => {
  it('launches with the channel arguments in the folder, reads the new id back, and binds the channel', async () => {
    const { host, calls, bound } = fake({ '--bg': 'backgrounded · c0ffee01\n  claude attach c0ffee01    open in this terminal\n' })
    const { sessionId } = await host.launch({ cwd: '/w', name: 'n', model: 'sonnet', effort: 'low', permissionMode: 'default', prompt: '-starts with a dash', isolation: 'worktree' })
    expect(sessionId).toBe(SID)
    expect(calls.find(c => c.args[0] === '--bg')).toEqual({
      args: ['--bg', '--name', 'n', '--model', 'sonnet', '--effort', 'low', '--permission-mode', 'default', '--plugin-dir', '/mod', '--settings', '/s.json', '--', '-starts with a dash'],
      cwd: '/w',
    })
    expect(bound).toEqual([['ch-worktree', SID]])
  })

  it('puts extra flags after the app\'s own and before the prompt, and asks the channel for Ultracode (MIP2-1407)', async () => {
    const seen: unknown[] = []
    const { host, calls } = fake({ '--bg': 'backgrounded · c0ffee01\n' })
    const prepare = (host as unknown as { channels: HostChannels }).channels.prepareLaunch
    ;(host as unknown as { channels: HostChannels }).channels.prepareLaunch = async opts => (seen.push(opts), prepare(opts))
    await host.launch({ cwd: '/w', prompt: 'go', ultracode: true, extraArgs: ['--add-dir', '/x'] })
    expect(calls.find(c => c.args[0] === '--bg')!.args).toEqual(['--bg', '--plugin-dir', '/mod', '--settings', '/s.json', '--add-dir', '/x', '--', 'go'])
    expect(seen).toEqual([{ isolation: 'none', ultracode: true }])
  })

  it('reports an untrusted folder as its own error, and discards the channel', async () => {
    const refusal = new ClaudeCommandError('claude --bg: refused', 1, '', 'Workspace not trusted. Run `claude` in /w once and accept the trust prompt, then retry.')
    const { host, closed, bound } = fake({ '--bg': refusal })
    await expect(host.launch({ cwd: '/w' })).rejects.toBeInstanceOf(WorkspaceNotTrusted)
    expect(closed).toEqual(['ch-none'])
    expect(bound).toEqual([])
  })

  it('refuses a relative folder', async () => {
    await expect(fake().host.launch({ cwd: 'w' })).rejects.toThrow('absolute folder')
  })

  it('stops a running session and waits until it has no process, and leaves a stopped one alone (MIP2-1441)', async () => {
    const stopped = JSON.stringify([{ ...JSON.parse(LISTED)[0], pid: null, status: 'stopped' }])
    let lists = 0
    const { host, calls } = fake()
    ;(host as unknown as { run: (a: string[]) => Promise<string> }).run = async args => {
      calls.push({ args })
      if (args[0] !== 'agents') return ''
      lists += 1
      // Running for the first check and one more after the stop, then gone.
      return lists <= 2 ? LISTED : stopped
    }
    expect(await host.stopIfRunning(SID)).toBe(true)
    expect(calls.filter(c => c.args[0] === 'stop')).toEqual([{ args: ['stop', 'c0ffee01'] }])
    expect(lists).toBe(3)
    const idle = fake({ agents: stopped })
    expect(await idle.host.stopIfRunning(SID)).toBe(false)
    expect(idle.calls.some(c => c.args[0] === 'stop')).toBe(false)
  })

  it('fails a resume that started another session, and stops and removes it, whatever the output says (MIP2-1443)', async () => {
    const STRAY = '53a2ab5b-0000-4000-8000-000000000000'
    const withStray = JSON.stringify([...JSON.parse(LISTED), { pid: 3, id: '53a2ab5b', cwd: '/w', kind: 'background', startedAt: 3, sessionId: STRAY, status: 'idle', state: 'done' }])
    // The stray shows up once the resume has run.
    let resumed = false
    const { host, calls } = fake()
    ;(host as unknown as { run: (a: string[]) => Promise<string> }).run = async args => {
      calls.push({ args })
      if (args[0] === 'agents') return resumed ? withStray : LISTED
      if (args[0] === '--resume') resumed = true
      return args[0] === '--resume' ? 'backgrounded · c0ffee01' : ''
    }
    const err = await host.resume(SID).catch(e => e)
    expect(err).toBeInstanceOf(StraySessions)
    expect(err).toMatchObject({ ids: [STRAY], removed: true })
    expect(calls.filter(c => c.args[0] === 'stop' || c.args[0] === 'rm').map(c => c.args)).toEqual([
      ['stop', '53a2ab5b'],
      ['rm', '53a2ab5b'],
    ])
  })

  it('leaves a new session in another folder alone (MIP2-1443)', async () => {
    const OTHER = '11111111-0000-4000-8000-000000000000'
    const elsewhere = JSON.stringify([...JSON.parse(LISTED), { pid: 3, id: '11111111', cwd: '/elsewhere', kind: 'background', startedAt: 3, sessionId: OTHER, status: 'idle', state: 'done' }])
    let resumed = false
    const { host, calls } = fake()
    ;(host as unknown as { run: (a: string[]) => Promise<string> }).run = async args => {
      calls.push({ args })
      if (args[0] === 'agents') return resumed ? elsewhere : LISTED
      resumed = true
      return 'backgrounded · c0ffee01'
    }
    await host.resume(SID)
    expect(calls.some(c => c.args[0] === 'stop')).toBe(false)
  })

  /** A fake supervisor: `--bg` adds a session after a delay; `agents` lists them all. */
  function supervisor(delays: number[], strays: { cwd: string; afterBg: number }[] = []) {
    const entries: object[] = []
    const removed: string[] = []
    const reported: string[][] = []
    let n = 0
    let bgCount = 0
    const host = new SupervisorHost({
      channels: { prepareLaunch: async () => ({ channelId: 'ch', args: [] }), bind: () => {}, closeFor: async () => {}, close: async () => {} },
      sleep: async ms => void (await new Promise(r => setTimeout(r, Math.min(ms, 5)))),
      onStrays: ids => void reported.push(ids),
      run: async args => {
        if (args[0] === 'agents') return JSON.stringify(entries)
        if (args[0] === 'stop' || args[0] === 'rm') return void removed.push(`${args[0]} ${args[1]}`), ''
        if (args[0] === '--bg' || args[0] === '--resume') {
          const i = n++
          await new Promise(r => setTimeout(r, delays[i] ?? 0))
          const short = `aaaaaa${i.toString(16).padStart(2, '0')}`
          if (args[0] === '--bg') {
            entries.push({ pid: 10 + i, id: short, cwd: '/w', kind: 'background', startedAt: i, sessionId: `${short}-0000-4000-8000-000000000000`, status: 'idle', state: 'done' })
            bgCount++
            for (const s of strays.filter(x => x.afterBg === bgCount)) entries.push({ pid: 99, id: 'bbbbbbbb', cwd: s.cwd, kind: 'background', startedAt: 99, sessionId: 'bbbbbbbb-0000-4000-8000-000000000000', status: 'idle', state: 'done' })
            return `backgrounded · ${short}`
          }
          return 'backgrounded · c0ffee01'
        }
        return ''
      },
    })
    return { host, entries, removed, reported }
  }

  it('lets two overlapping launches in one folder both succeed, the second finishing first, and removes neither (pass 6, H-2)', async () => {
    const { host, removed, reported } = supervisor([60, 5])
    const [a, b] = await Promise.all([host.launch({ cwd: '/w', prompt: 'a' }), host.launch({ cwd: '/w', prompt: 'b' })])
    expect(a.sessionId).not.toBe(b.sessionId)
    expect(removed).toEqual([])
    expect(reported).toEqual([])
  })

  it('reports and leaves a stray when another operation overlapped, or the folder is unknown (pass 6, H-2)', async () => {
    const { host, removed, reported } = supervisor([60, 5], [{ cwd: '/w', afterBg: 1 }])
    await Promise.all([host.launch({ cwd: '/w', prompt: 'a' }), host.launch({ cwd: '/w', prompt: 'b' })])
    expect(removed).toEqual([])
    expect(reported.flat()).toContain('bbbbbbbb-0000-4000-8000-000000000000')
  })

  it("reports and never removes when the resumed session's folder is unknown (pass 6, H-2)", async () => {
    const { host, entries, removed, reported } = supervisor([5])
    // The session isn't listed yet, so its folder is unknown; a launch elsewhere adds a session meanwhile.
    ;(host as unknown as { run: (a: string[]) => Promise<string> }).run = (orig => async (a: string[]) => {
      if (a[0] === '--resume') {
        entries.push({ pid: 5, id: 'c0ffee01', cwd: '/w', kind: 'background', startedAt: 1, sessionId: SID, status: 'idle', state: 'done' })
        entries.push({ pid: 6, id: 'cccccccc', cwd: '/elsewhere', kind: 'background', startedAt: 2, sessionId: 'cccccccc-0000-4000-8000-000000000000', status: 'idle', state: 'done' })
        return 'backgrounded · c0ffee01'
      }
      return orig(a)
    })((host as unknown as { run: (a: string[]) => Promise<string> }).run)
    await host.resume(SID)
    expect(removed).toEqual([])
    expect(reported).toEqual([['cccccccc-0000-4000-8000-000000000000']])
  })

  it('removes a stray only when the launch ran alone in a known folder (pass 6, H-2)', async () => {
    const { host, removed } = supervisor([5], [{ cwd: '/w', afterBg: 1 }])
    await expect(host.launch({ cwd: '/w', prompt: 'a' })).rejects.toBeInstanceOf(StraySessions)
    expect(removed).toEqual(['stop bbbbbbbb', 'rm bbbbbbbb'])
  })

  it("reports an entry it can't classify once per change, with its raw values (MIP2-1447)", async () => {
    const seen: unknown[] = []
    let listing = JSON.stringify([{ pid: 1, id: 'c0ffee01', cwd: '/w', kind: 'background', startedAt: 1, sessionId: SID }])
    const host = new SupervisorHost({ run: async () => listing, onUnknown: raw => void seen.push(raw) })
    await host.list()
    await host.list()
    listing = JSON.stringify([{ pid: 1, id: 'c0ffee01', cwd: '/w', kind: 'background', startedAt: 1, sessionId: SID, status: 'waiting', waitingFor: 'goal proposal' }])
    await host.list()
    listing = LISTED
    await host.list()
    expect(seen).toEqual([{ sessionId: SID, pid: 1 }, { sessionId: SID, pid: 1, status: 'waiting', waitingFor: 'goal proposal' }])
  })

  it('counts a session as changing while the app stops or resumes it, and for 10 s after (MIP2-1447)', async () => {
    let t = 0
    const host = new SupervisorHost({ now: () => t, sleep: async () => {}, run: async args => (args[0] === 'agents' ? LISTED : 'backgrounded · c0ffee01') })
    await host.list()
    await host.stop(SID)
    expect(host.changing().has(SID)).toBe(true)
    t = 9_000
    expect(host.changing().has(SID)).toBe(true)
    t = 10_001
    expect(host.changing().has(SID)).toBe(false)
  })

  it('reads a resume that woke the same session, and any other note or id as a copy (MIP2-1453, Research MIP2-1445)', () => {
    const woke = 'note: woke session c0ffee01 with its saved options (--name, --settings, --model).\nbackgrounded · c0ffee01 · app\n'
    expect(resumedCopy(woke, SID)).toBeNull()
    // Older output with no note, and the session's own id.
    expect(resumedCopy('backgrounded · c0ffee01 · app\n', SID)).toBeNull()
    // Verbatim stdout of the MIP2-1449 live run's resume of 8a4d00ce (2.1.311): no note line on stdout.
    const live =
      'backgrounded · 8a4d00ce · ccc-1449-a (idle — send a prompt to start)\n  claude agents             list sessions\n  claude attach 8a4d00ce    open in this terminal\n  claude logs 8a4d00ce      show recent output\n  claude stop 8a4d00ce      stop this session\n'
    expect(resumedCopy(live, '8a4d00ce-9153-4bdd-a937-3d938a76dc66')).toBeNull()
    // The eight copy reasons the 2.1.311 binary holds. The first is observed verbatim; the rest follow the memo's
    // description, so the check can't depend on their wording beyond "note:".
    const copies = [
      'note: session c0ffee01 is already running in the background, so this started a copy as 4171c8f8.',
      'note: session c0ffee01 is open in another Claude Code process, so this started a copy as 4171c8f8.',
      'note: another background session already uses id c0ffee01, so this started a copy as 4171c8f8.',
      'note: c0ffee01 is not the full session id, so this started a copy as 4171c8f8.',
      'note: could not check whether session c0ffee01 is running, so this started a copy as 4171c8f8.',
      "note: could not read background session c0ffee01's saved state, so this started a copy as 4171c8f8.",
      'note: session c0ffee01 keeps its own saved options, so the flags you passed started a copy as 4171c8f8.',
      'note: this shell is restricted, so this started a restricted copy as 4171c8f8.',
    ]
    for (const note of copies) expect(resumedCopy(`${note}\nbackgrounded · 4171c8f8\n`, SID), note).toBe('4171c8f8')
    // A note in words not seen before, with the id elsewhere or nowhere.
    expect(resumedCopy('note: something new happened.\nbackgrounded · 4171c8f8\n', SID)).toBe('4171c8f8')
    expect(resumedCopy('note: something new happened.\n', SID)).toBe('unknown')
    // No note, but another session's id.
    expect(resumedCopy('backgrounded · 4171c8f8\n', SID)).toBe('4171c8f8')
  })

  it("reads the resume's note from stderr, and an id it can't read is a copy, never the same session (MIP2-1453)", async () => {
    // Claude Code prints the note on stderr and the backgrounded line on stdout.
    const resumeWith = async (stdout: string, stderr: string) => {
      const run = Object.assign(async (args: string[]) => (args[0] === 'agents' ? LISTED : stdout), {
        full: async (args: string[]) => (args[0] === 'agents' ? { stdout: LISTED, stderr: '' } : { stdout, stderr }),
      })
      return new SupervisorHost({ run, sleep: async () => {} }).resume(SID).then(
        () => 'same',
        (e: unknown) => (e instanceof ResumedAsCopy ? `copy ${e.copyId}` : String(e)),
      )
    }
    expect(await resumeWith('backgrounded · c0ffee01 · app\n', 'note: woke session c0ffee01 with its saved options (--name, --settings).\n')).toBe('same')
    expect(await resumeWith('backgrounded · 4171c8f8\n', 'note: session c0ffee01 is already running in the background, so this started a copy as 4171c8f8.\n')).toBe('copy 4171c8f8')
    // The note says copy, but stdout shows the session's own id: the note wins.
    expect(await resumeWith('backgrounded · c0ffee01\n', 'note: could not check whether session c0ffee01 is running.\n')).toBe('copy unknown')
    // Nothing on either stream names an id.
    expect(await resumeWith('', '')).toBe('copy unknown')
    expect(resumedCopy('', SID, 'note: woke session c0ffee01 with its saved options.')).toBeNull()
  })

  it('moves a session in by reading both streams: a stderr copy note is a different session, never the same (MIP2-1461)', async () => {
    const COPY = 'c0ffee0a-0000-4000-8000-000000000000'
    // After a resume that started a copy, the copy is listed; the parked original isn't.
    const listedBoth = JSON.stringify([{ pid: 2, id: 'c0ffee0a', cwd: '/w', kind: 'background', startedAt: 2, sessionId: COPY, status: 'idle', state: 'done' }])
    // `listing` is what agents --json shows once the resume has run; before it, nothing is listed.
    const mk = (stdout: string, stderr: string, listing: string) => {
      let resumed = false
      const agents = () => (resumed ? listing : '[]')
      const run = Object.assign(async (a: string[]) => (a[0] === 'agents' ? agents() : stdout), {
        full: async (a: string[]) => (a[0] === 'agents' ? { stdout: agents(), stderr: '' } : ((resumed = true), { stdout, stderr })),
      })
      return new SupervisorHost({ run, sleep: async () => {}, channels: { prepareLaunch: async () => ({ channelId: 'ch', args: ['--plugin-dir', '/mod'] }), bind: () => {}, closeFor: async () => {}, close: async () => {} } })
    }
    const notListed = JSON.stringify([])
    // Parked: not listed before; same id after, with the woke note on stderr.
    let n = 0
    const same = Object.assign(async (a: string[]) => (a[0] === 'agents' ? (n++ < 2 ? notListed : LISTED) : 'backgrounded · c0ffee01\n'), {
      full: async (a: string[]) => (a[0] === 'agents' ? { stdout: n++ < 2 ? notListed : LISTED, stderr: '' } : { stdout: 'backgrounded · c0ffee01\n', stderr: 'note: woke session c0ffee01 with its saved options.\n' }),
    })
    const host = new SupervisorHost({ run: same, sleep: async () => {}, channels: { prepareLaunch: async () => ({ channelId: 'ch', args: ['--plugin-dir', '/mod'] }), bind: () => {}, closeFor: async () => {}, close: async () => {} } })
    expect(await host.moveIn(SID, { cwd: '/w' })).toEqual({ sessionId: SID, sameId: true })
    // A copy note on stderr: the copy's id, reported as a different session.
    expect(await mk('backgrounded · c0ffee0a\n', 'note: session c0ffee01 is open in another Claude Code process, so this started a copy as c0ffee0a.\n', listedBoth).moveIn(SID, { cwd: '/w' }).catch(e => e)).toEqual({ sessionId: COPY, sameId: false })
    // Output that names no session: a copy of unknown id, not the same session.
    expect(await mk('', '', notListed).moveIn(SID, { cwd: '/w' }).catch(e => e)).toBeInstanceOf(ResumedAsCopy)
  })

  it("resumes with no flags at all, from the session's own folder", async () => {
    const { host, calls } = fake({ '--resume': 'backgrounded · c0ffee01 · app' })
    await host.resume(SID)
    expect(calls.filter(c => c.args[0] === '--resume')).toEqual([{ args: ['--resume', SID, '--bg'], cwd: '/w' }])
  })

  it('reads the three refusal variants and the backgrounded id', async () => {
    const { trustRefusal, backgroundedId } = await import('../src/supervisor-host.ts')
    expect(trustRefusal('Workspace not trusted. Run `claude` in /w once and accept the trust prompt, then retry.', '/w')?.variant).toBe('trust')
    expect(trustRefusal('Workspace not trusted. The home directory is trusted one session at a time.', '/Users/a')?.variant).toBe('home')
    expect(trustRefusal('Workspace not trusted. /gone could not be resolved on disk.', '/gone')?.variant).toBe('missing')
    expect(trustRefusal('some other error', '/w')).toBeNull()
    expect(backgroundedId('\x1b[2mbackgrounded · c0ffee08\x1b[0m')).toBe('c0ffee08')
    expect(backgroundedId('nothing here')).toBeNull()
  })

  it('returns from resume only once the session has a process again (MIP2-1415)', async () => {
    const stopped = JSON.stringify([{ id: 'c0ffee01', cwd: '/w', kind: 'background', startedAt: 1, sessionId: SID, status: 'idle', state: 'done' }])
    // The first listing is the one taken before the resume, to find strays (MIP2-1443).
    const listings = [stopped, stopped, stopped, stopped, LISTED]
    let t = 0
    const host = new SupervisorHost({
      now: () => t,
      sleep: async ms => void (t += ms),
      run: async args => (args[0] === 'agents' ? (listings.length > 1 ? listings.shift()! : listings[0]!) : 'backgrounded · c0ffee01'),
    })
    await host.resume(SID)
    expect(listings).toEqual([LISTED])
    expect(t).toBe(500)
  })

  it('fails a resume whose session never comes back', async () => {
    const stopped = JSON.stringify([{ id: 'c0ffee01', cwd: '/w', kind: 'background', startedAt: 1, sessionId: SID, status: 'idle', state: 'done' }])
    let t = 0
    const host = new SupervisorHost({
      now: () => t,
      sleep: async ms => void (t += ms),
      appearTimeoutMs: 2000,
      run: async args => (args[0] === 'agents' ? stopped : 'backgrounded · c0ffee01'),
    })
    await expect(host.resume(SID)).rejects.toThrow("didn't come back within 2 s")
  })

  it('starts a copy with new settings, from the session\'s folder, on its own channel (MIP2-1407)', async () => {
    const COPY = 'c0ffee0a-0000-4000-8000-000000000000'
    const listed = JSON.stringify([
      { pid: 1, id: 'c0ffee01', cwd: '/w', kind: 'background', startedAt: 1, sessionId: SID, status: 'idle', state: 'done' },
      { pid: 2, id: 'c0ffee0a', cwd: '/w', kind: 'background', startedAt: 2, sessionId: COPY, status: 'idle', state: 'done' },
    ])
    const { host, calls, bound } = fake({ agents: listed, '--resume': 'background session c0ffee01 keeps its own saved options, so the flags you passed started a copy as c0ffee0a.' })
    expect(await host.startCopy(SID, { model: 'opus', effort: 'high' })).toEqual({ sessionId: COPY })
    const run = calls.find(c => c.args[0] === '--resume')!
    expect(run).toEqual({ args: ['--resume', SID, '--bg', '--model', 'opus', '--effort', 'high', '--plugin-dir', '/mod', '--settings', '/s.json'], cwd: '/w' })
    expect(bound).toEqual([['ch-none', COPY]])
  })

  it('moves an exited 0.24 session in place with the app\'s flags, and checks the id (MIP2-1425)', async () => {
    // Before: not listed (its interactive process exited). After: listed as background, same id.
    let resumed = false
    const after = JSON.stringify([{ pid: 9, id: 'c0ffee01', cwd: '/w', kind: 'background', startedAt: 2, sessionId: SID, status: 'idle', state: 'done' }])
    const { host, calls, bound } = fake({ '--resume': 'backgrounded · c0ffee01\n' })
    const run = (host as unknown as { run: (a: string[], o?: { cwd?: string }) => Promise<string> }).run
    ;(host as unknown as { run: typeof run }).run = async (args, o) => (args[0] === 'agents' ? (resumed ? after : '[]') : ((resumed = args[0] === '--resume'), run(args, o)))
    expect(await host.moveIn(SID, { cwd: '/w', name: 'site', model: 'sonnet', permissionMode: 'auto' })).toEqual({ sessionId: SID, sameId: true })
    expect(calls.find(c => c.args[0] === '--resume')).toEqual({
      args: ['--resume', SID, '--bg', '--name', 'site', '--model', 'sonnet', '--permission-mode', 'auto', '--plugin-dir', '/mod', '--settings', '/s.json'],
      cwd: '/w',
    })
    expect(bound).toEqual([['ch-none', SID]])
  })

  it('refuses to move a session whose 0.24 process is still running, and starts nothing (MIP2-1425)', async () => {
    const open = JSON.stringify([{ pid: 7, id: 'c0ffee01', cwd: '/w', kind: 'interactive', startedAt: 1, sessionId: SID, status: 'idle', state: 'done' }])
    const { host, calls, closed } = fake({ agents: open })
    await expect(host.moveIn(SID, { cwd: '/w' })).rejects.toThrow('still open in CC Command Center 0.24')
    expect(calls.some(c => c.args[0] === '--resume')).toBe(false)
    expect(closed).toEqual([])
  })

  it('reports a move that came back under a different id (MIP2-1425)', async () => {
    const OTHER = 'c0ffee0a-0000-4000-8000-000000000000'
    const listedOther = JSON.stringify([{ pid: 2, id: 'c0ffee0a', cwd: '/w', kind: 'background', startedAt: 2, sessionId: OTHER, status: 'idle', state: 'done' }])
    const { host } = fake({ agents: listedOther, '--resume': 'started a copy as c0ffee0a.' })
    expect(await host.moveIn(SID, { cwd: '/w' })).toEqual({ sessionId: OTHER, sameId: false })
  })

  it('reports a resume that became a copy', async () => {
    const { host } = fake({ '--resume': 'background session c0ffee01 keeps its own saved options, so the flags you passed started a copy as c0ffee0a.' })
    await expect(host.resume(SID)).rejects.toBeInstanceOf(ResumedAsCopy)
  })

  it('stops, respawns and removes by short id, and closes the channel on rm', async () => {
    const { host, calls, closed } = fake()
    await host.stop(SID)
    await host.respawn(SID)
    await host.rm(SID)
    expect(calls.filter(c => c.args[0] !== 'agents' && c.args[0] !== 'daemon').map(c => c.args)).toEqual([
      ['stop', 'c0ffee01'],
      ['respawn', 'c0ffee01'],
      ['rm', 'c0ffee01'],
    ])
    expect(closed).toEqual([SID])
  })

  it('puts the reload switch on a session command only once the supervisor is confirmed running (MIP2-1463)', async () => {
    const seen: { args: string[]; session?: boolean }[] = []
    let running = false
    let started = 0
    let unconfirmed = 0
    const host = new SupervisorHost({
      sleep: async () => {},
      appearTimeoutMs: 1_000,
      startSupervisor: () => void (started++, (running = true)),
      onSwitchUnconfirmed: () => void unconfirmed++,
      run: async (args, opts) => {
        seen.push({ args, session: opts?.session })
        if (args[0] === 'daemon') return running ? 'pid:     4242\n' : 'not running\n'
        return args[0] === 'agents' ? LISTED : 'respawned c0ffee01'
      },
    })
    await host.list()
    // Not running: started the watchdog's way (no switch), then the respawn carries it.
    await host.respawn(SID)
    expect(started).toBe(1)
    expect(seen.find(c => c.args[0] === 'respawn')?.session).toBe(true)
    expect(seen.filter(c => c.args[0] === 'daemon').every(c => !c.session)).toBe(true)
    // Already running: not started again.
    await host.respawn(SID)
    expect(started).toBe(1)
    expect(unconfirmed).toBe(0)
  })

  it("runs a session command without the switch, and says so, when the supervisor can't be confirmed (MIP2-1463)", async () => {
    let t = 0
    const seen: { args: string[]; session?: boolean }[] = []
    let unconfirmed = 0
    const host = new SupervisorHost({
      now: () => t,
      sleep: async ms => void (t += ms),
      appearTimeoutMs: 1_000,
      startSupervisor: () => {},
      onSwitchUnconfirmed: () => void unconfirmed++,
      run: async (args, opts) => {
        seen.push({ args, session: opts?.session })
        if (args[0] === 'daemon') return 'not running\n'
        return args[0] === 'agents' ? LISTED : 'respawned c0ffee01'
      },
    })
    await host.list()
    await host.respawn(SID)
    expect(seen.find(c => c.args[0] === 'respawn')?.session).toBe(false)
    expect(unconfirmed).toBe(1)
  })

  it("starts nothing when daemon status fails without saying it isn't running (pass 9, L-5)", async () => {
    let started = 0
    let unconfirmed = 0
    const host = new SupervisorHost({
      sleep: async () => {},
      startSupervisor: () => void started++,
      onSwitchUnconfirmed: () => void unconfirmed++,
      run: async args => {
        if (args[0] === 'daemon') throw new Error('timed out after 10000 ms')
        return args[0] === 'agents' ? LISTED : 'respawned c0ffee01'
      },
    })
    expect(await host.ensureSupervisor()).toBe(false)
    expect(started).toBe(0)
    // The exit-1 answer that says so does count as down.
    const down = new SupervisorHost({ sleep: async () => {}, appearTimeoutMs: 0, startSupervisor: () => void started++, run: async () => { throw new ClaudeCommandError('claude daemon status', 1, 'Supervisor not running\n', '') } })
    await down.ensureSupervisor()
    expect(started).toBe(1)
    expect(unconfirmed).toBe(0)
  })

  it('shares one check and one start among commands at the same moment (pass 9, L-5)', async () => {
    let running = false
    let started = 0
    let statuses = 0
    const host = new SupervisorHost({
      sleep: async () => {},
      appearTimeoutMs: 1_000,
      startSupervisor: () => void (started++, (running = true)),
      run: async args => {
        if (args[0] === 'daemon') return (statuses++, running ? 'pid:     4242\n' : 'not running\n')
        return args[0] === 'agents' ? LISTED : 'ok'
      },
    })
    const all = await Promise.all([host.ensureSupervisor(), host.ensureSupervisor(), host.ensureSupervisor()])
    expect(all).toEqual([true, true, true])
    expect(started).toBe(1)
    expect(statuses).toBe(2)
  })

  it("gives the attach command, run in the session's own folder", async () => {
    const { host } = fake()
    await host.list()
    expect(await host.attach(SID)).toEqual({ file: '/bin/claude', args: ['attach', 'c0ffee01'], cwd: '/w' })
  })

  it('refuses anything that is not a session id', async () => {
    const { host } = fake()
    await expect(host.stop('c0ffee01; rm -rf ~')).rejects.toThrow('not a session id')
    await expect(host.resume('--help')).rejects.toThrow('not a session id')
  })
})

describe('SessionControl.sendPrompt', async () => {
  const { field } = await import('@ccc/contract')
  const { SessionControl } = await import('../src/session-control.ts')
  const NOW = 1_000_000
  const snapshot = (pid: number | null, waiting = false) => ({
    contractVersion: 1 as const,
    at: NOW,
    usage: null,
    selfCheck: null,
    sources: [],
    sessions: [
      {
        contractVersion: 1 as const,
        sessionId: SID,
        kind: field('background' as const, 'agents-json', NOW),
        cwd: field('/w', 'agents-json', NOW),
        startedAt: field(1, 'agents-json', NOW),
        name: field('n', 'agents-json', NOW),
        shortId: field('c0ffee01', 'agents-json', NOW),
        pid: field(pid, 'agents-json', NOW),
        activity: field(waiting ? ('waiting' as const) : ('idle' as const), 'agents-json', NOW),
        needsYou: field(waiting ? { kind: 'permission' as const, detail: 'permission prompt' } : null, 'agents-json', NOW),
      },
    ],
  })

  function control(pid: number | null, waiting = false, contactAfterRespawn = true) {
    let t = NOW
    const respawned: string[] = []
    let contactAt = 0
    const relayed: string[] = []
    const c = new SessionControl({
      host: { respawn: async (id: string) => { respawned.push(id); if (contactAfterRespawn) contactAt = t + 1 } } as never,
      hub: {
        relayPrompt: (_s: string, text: string) => (relayed.push(text), 'p1'),
        health: () => [{ sessionId: SID, createdAt: 0, contactAt, launched: true, offered: 0, prompts: [] }],
      },
      current: () => snapshot(pid, waiting),
      now: () => t,
      sleep: async ms => void (t += ms),
      contactTimeoutMs: 2000,
    })
    return { c, respawned, relayed }
  }

  it('relays straight to a live session', async () => {
    const { c, respawned, relayed } = control(10)
    expect(await c.sendPrompt(SID, 'hi')).toBe('p1')
    expect([respawned, relayed]).toEqual([[], ['hi']])
  })

  it('respawns a stopped session and waits for its mod first', async () => {
    const { c, respawned, relayed } = control(null)
    await c.sendPrompt(SID, 'hi')
    expect([respawned, relayed]).toEqual([[SID], ['hi']])
  })

  it('never respawns a session waiting on Alex', async () => {
    const { c, respawned } = control(null, true)
    await expect(c.sendPrompt(SID, 'hi')).rejects.toThrow('waiting on you')
    expect(respawned).toEqual([])
  })

  it('gives up when the respawned mod never makes contact', async () => {
    const { c, relayed } = control(null, false, false)
    await expect(c.sendPrompt(SID, 'hi')).rejects.toThrow("didn't reach the app")
    expect(relayed).toEqual([])
  })
})
