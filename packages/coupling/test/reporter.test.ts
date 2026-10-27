import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FleetPoller } from '../src/fleet-poller.ts'
import { parseEnvelope, parseReporterFile, removeLegacyReporterDir, reporterFields } from '../src/reporter.ts'
import { SupervisorHost } from '../src/supervisor-host.ts'

// Written by mod/ in two scratch `claude --bg` sessions on Claude Code
// 2.1.311, 2026-10-26: A spawned an Explore subagent, wrote note.txt and ran
// echo; B sent A a peer message and A replied. Home paths replaced.
const A_TEXT = readFileSync(new URL('./fixtures/reporter-2.1.311-scratch-a.json', import.meta.url), 'utf8')
const B_TEXT = readFileSync(new URL('./fixtures/reporter-2.1.311-scratch-b.json', import.meta.url), 'utf8')
const A_ID = 'c0ffee05-0000-4000-8000-000000000005'
const B_ID = 'c0ffee06-0000-4000-8000-000000000006'

describe('reporterFields on the scratch capture', () => {
  const a = reporterFields(parseReporterFile(A_TEXT).file)
  const b = reporterFields(parseReporterFile(B_TEXT).file)

  it('reports model, effort, context, cost and rate limits', () => {
    expect(a.model?.value).toBe('claude-sonnet-5-5')
    expect(a.effort?.value).toBe('low')
    expect(a.context?.value).toEqual({ usedTokens: 69534, windowTokens: 1000000, percent: 7 })
    expect(a.costUsd?.value).toBeCloseTo(0.278, 3)
    expect(a.rateLimits?.value).toEqual({
      fiveHour: { usedPercent: 0, resetsAt: 1793089800 },
      sevenDay: { usedPercent: 29, resetsAt: 1793458800 },
    })
    expect(a.tokens?.value.output).toBeGreaterThan(0)
  })

  it('reports the subagent and no tool call in flight', () => {
    expect(a.subagents?.value).toEqual([
      { agentId: 'a27b96495a95ada95', type: 'Explore', description: 'List files in cwd', model: 'claude-sonnet-5-5', status: 'completed', parentAgentId: null },
    ])
    expect(a.toolCalls?.value).toEqual([])
  })

  it('reports contractors from child.started, once each, and none without them (MIP2-1410)', () => {
    expect(a.contractors).toBeUndefined()
    const file = parseReporterFile(A_TEXT).file!
    const last = file.events.at(-1)!
    const child = (seq: number, shortId: string, name: string | null) => ({ seq, at: last.at + seq, agentId: null, type: 'child.started' as const, shortId, name })
    const withKids = { ...file, events: [...file.events, child(9001, 'c0ffee09', 'ccc-1392-child'), child(9002, 'c0ffee09', 'ccc-1392-child'), child(9003, 'c0ffee0a', null)] }
    const parsed = parseReporterFile(JSON.stringify(withKids))
    expect(parsed.file).not.toBeNull()
    expect(reporterFields(parsed.file!).contractors?.value.map(c => [c.shortId, c.name])).toEqual([
      ['c0ffee09', 'ccc-1392-child'],
      ['c0ffee0a', null],
    ])
  })

  it('reports the file written', () => {
    expect(a.filesWritten?.value.map(w => [w.path, w.tool])).toEqual([['/Users/example/scratch/a/note.txt', 'Write']])
  })

  it('reports peer messages both ways, with the sender read from the envelope', () => {
    expect(b.peerMessages?.value.map(m => [m.direction, m.peer, m.preview])).toEqual([
      ['sent', 'ccc-scratch-a', 'hello from b'],
      ['received', 'ccc-scratch-a', 'got it'],
    ])
    expect(a.peerMessages?.value.map(m => [m.direction, m.peer, m.preview])).toEqual([
      ['received', 'ccc-scratch-b', 'hello from b'],
      // A's reply went to B's socket address; B's envelope maps it to B's name.
      ['sent', 'ccc-scratch-b', 'got it'],
    ])
  })

  it('marks every field as from the mod', () => {
    for (const f of Object.values(a)) expect(f).toMatchObject({ source: 'mod', stale: false })
  })
})

describe('reporterFields', () => {
  const base = JSON.parse(A_TEXT)
  const at = (events: object[]) => reporterFields(parseReporterFile(JSON.stringify({ ...base, events })).file)
  const ev = (seq: number, body: object) => ({ seq, at: seq, agentId: null, ...body })

  it('lists a started call with no end as in flight', () => {
    const f = at([ev(1, { type: 'tool.start', toolUseId: 't1', tool: 'Bash', path: null })])
    expect(f.toolCalls?.value).toEqual([{ toolUseId: 't1', tool: 'Bash', detail: null, agentId: null, startedAt: 1 }])
  })

  it('lists nothing in flight after session.end', () => {
    const f = at([ev(1, { type: 'tool.start', toolUseId: 't1', tool: 'Bash', path: null }), ev(2, { type: 'session.end', reason: 'clear' })])
    expect(f.toolCalls?.value).toEqual([])
  })

  it('carries a call detail when the mod sent one', () => {
    const f = at([ev(1, { type: 'tool.start', toolUseId: 't1', tool: 'Bash', path: null, detail: 'npm   test\n--run' })])
    expect(f.toolCalls?.value[0]?.detail).toBe('npm test --run')
  })

  it('reads the main loop turn: running, then ended with its answer', () => {
    const running = at([ev(1, { type: 'turn.start' }), ev(2, { type: 'turn.start', agentId: 'sub1' })])
    expect(running.turn?.value).toEqual({ running: true, startedAt: 1, endedAt: null, lastAnswer: null })
    const ended = at([
      ev(1, { type: 'turn.start' }),
      { ...ev(2, { type: 'turn.complete', reason: 'answer', durationMs: 5, usage: null, answer: 'All four steps are done.' }), agentId: 'sub1' },
      ev(3, { type: 'turn.complete', reason: 'answer', durationMs: 9, usage: null, answer: 'Done:  the tests pass.' }),
    ])
    expect(ended.turn?.value).toEqual({ running: false, startedAt: 1, endedAt: 3, lastAnswer: 'Done: the tests pass.' })
  })

  it('uses the last contact as observedAt', () => {
    const f = reporterFields(parseReporterFile(A_TEXT).file, 42)
    expect(f.model?.observedAt).toBe(42)
  })

  it('does not count a write whose call failed', () => {
    const f = at([
      ev(1, { type: 'tool.start', toolUseId: 't1', tool: 'Write', path: '/x' }),
      ev(2, { type: 'tool.end', toolUseId: 't1', tool: 'Write', isError: true }),
    ])
    expect(f.filesWritten?.value).toEqual([])
  })
})

describe('parseEnvelope', () => {
  it('reads from-name and the body', () => {
    expect(parseEnvelope('<cross-session-message from="uds:/s.sock" from-name="peer-a" from-mode="prompting">\nhi\n</cross-session-message>')).toEqual({
      from: 'peer-a',
      name: 'peer-a',
      address: 'uds:/s.sock',
      body: 'hi',
    })
  })
  it('falls back to the address', () => {
    expect(parseEnvelope('<cross-session-message from="uds:/s.sock">hi')?.from).toBe('uds:/s.sock')
  })
  it('is null without an envelope', () => {
    expect(parseEnvelope('plain text')).toBeNull()
  })
})

describe('validateReporterFile', () => {
  const base = JSON.parse(A_TEXT)
  const parse = (over: object) => parseReporterFile(JSON.stringify({ ...base, ...over }))

  it.each([
    [{ wire: 1 }, 'reporter wire 1'],
    [{ sessionId: '../../etc/passwd' }, 'sessionId is not a session UUID'],
    [{ latest: { ...base.latest, agents: [{ id: 3 }] } }, 'latest.agents is invalid'],
    [{ latest: { ...base.latest, measure: { context: {} } } }, 'latest.measure is invalid'],
    [{ events: 'x' }, 'events is not an array'],
  ])('rejects %o', (over, message) => {
    expect(() => parse(over)).toThrow(message)
  })

  it('drops events that do not validate and keeps the rest', () => {
    const { file, droppedEvents } = parse({
      events: [
        { seq: 1, at: 1, agentId: null, type: 'turn.start' },
        { seq: 2, at: 2, agentId: null, type: 'tool.start', toolUseId: 7 },
        { seq: 3, at: 3, agentId: null, type: 'unknown.event' },
      ],
    })
    expect(file.events.map(e => e.seq)).toEqual([1])
    expect(droppedEvents).toBe(2)
  })

  it('cuts long strings', () => {
    const { file } = parse({ events: [{ seq: 1, at: 1, agentId: null, type: 'peer.sent', to: 'x', preview: 'y'.repeat(10_000) }] })
    expect((file.events[0] as { preview: string }).preview).toHaveLength(4096)
  })
})

describe('removeLegacyReporterDir', () => {
  it('removes the interim session files and the empty folder, and nothing else', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ccc-legacy-'))
    const dir = join(base, 'reporter')
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, `${A_ID}.json`), A_TEXT)
    writeFileSync(join(dir, 'notes.txt'), 'keep')
    expect(await removeLegacyReporterDir(dir)).toBe(1)
    expect(readdirSync(dir)).toEqual(['notes.txt'])
    rmSync(join(dir, 'notes.txt'))
    writeFileSync(join(dir, `${B_ID}.json`), B_TEXT)
    expect(await removeLegacyReporterDir(dir)).toBe(1)
    expect(existsSync(dir)).toBe(false)
    expect(await removeLegacyReporterDir(dir)).toBe(0)
    rmSync(base, { recursive: true, force: true })
  })
})

describe('FleetPoller with the reporter', () => {
  const PENDING = {
    requestId: 'r1',
    tool: 'Bash',
    summary: 'ls',
    questions: null,
    canRemember: false,
    agentId: null,
    askedAt: 1,
    fields: [],
    refusal: null,
  }
  const listing = JSON.stringify([
    { pid: 1, cwd: '/a', kind: 'background', startedAt: 1, sessionId: A_ID, name: 'a', status: 'idle', state: 'done' },
    { cwd: '/b', kind: 'background', startedAt: 1, sessionId: B_ID, name: 'b', state: 'done' },
  ])
  const read = async () => ({
    files: new Map([
      [A_ID, { file: parseReporterFile(A_TEXT).file, mtimeMs: Date.now() }],
      [B_ID, { file: parseReporterFile(B_TEXT).file, mtimeMs: Date.now() }],
    ]),
    rejected: [{ name: 'x.json', reason: 'is a symlink' }],
  })

  it('merges mod fields and pending prompts, marks them stale when the process is gone, and logs once', async () => {
    const log: string[] = []
    const poller = new FleetPoller({
      host: new SupervisorHost({ run: async () => listing }),
      readReporter: read,
      readPending: () => new Map([[A_ID, [PENDING]], [B_ID, [PENDING]]]),
      log: line => log.push(line),
    })
    await poller.pollOnce()
    const snap = await poller.pollOnce()
    const [a, b] = snap.sessions
    expect(a?.model).toMatchObject({ value: 'claude-sonnet-5-5', source: 'mod', stale: false })
    expect(b?.model).toMatchObject({ source: 'mod', stale: true })
    expect(a?.pendingRequests?.value).toEqual([PENDING])
    // A session whose process is gone has nothing a card could answer.
    expect(b?.pendingRequests?.value).toEqual([])
    expect(snap.sources.map(s => s.source)).toEqual(['agents-json', 'mod'])
    expect(log).toEqual(['reporter: ignored x.json: is a symlink'])
  })


})

describe('a session awaiting its first message (MIP2-1426)', () => {
  // A trimmed to its start: the app launched or resumed it with no prompt.
  const fresh = (): ReturnType<typeof parseReporterFile>['file'] => {
    const file = parseReporterFile(A_TEXT).file
    const start = file.events.find(e => e.type === 'session.start')!
    return { ...file, events: [start] }
  }
  const listing = (state: string) => JSON.stringify([{ pid: 1, cwd: '/a', kind: 'background', startedAt: 1, sessionId: A_ID, name: 'a', status: 'idle', state }])
  const poll = async (file: ReturnType<typeof parseReporterFile>['file'], state: string) => {
    const poller = new FleetPoller({
      host: new SupervisorHost({ run: async () => listing(state) }),
      readReporter: async () => ({ files: new Map([[A_ID, { file, mtimeMs: Date.now() }]]), rejected: [] }),
    })
    await poller.pollOnce()
    return (await poller.pollOnce()).sessions[0]!
  }

  it('reads it from session.start with no main-loop turn since', () => {
    expect(reporterFields(fresh()).awaitingFirstPrompt?.value).toBe(true)
    expect(reporterFields(parseReporterFile(A_TEXT).file).awaitingFirstPrompt?.value).toBe(false)
  })

  it("turns Claude Code's blocked with no waitingFor into idle only then; otherwise it stays Needs you", async () => {
    const waiting = await poll(fresh(), 'blocked')
    expect([waiting.activity.value, waiting.needsYou.value]).toEqual(['idle', null])
    const had = await poll(parseReporterFile(A_TEXT).file, 'blocked')
    expect([had.activity.value, had.needsYou.value]).toEqual(['waiting', { kind: 'blocked', detail: null }])
  })
})

