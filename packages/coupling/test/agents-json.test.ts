import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { activityOf, needsYouOf, parseAgentsJson, toSnapshot, type AgentsJsonEntry } from '../src/agents-json.ts'

// Shapes captured from Claude Code 2.1.311 on 2026-10-26, names and folders
// replaced. The two `waiting` entries are Research's P3 probe sessions.
const FIXTURE = readFileSync(new URL('./fixtures/agents-json-2.1.311.json', import.meta.url), 'utf8')

const base: AgentsJsonEntry = { cwd: '/x', kind: 'background', startedAt: 1, sessionId: 's' }

describe('parseAgentsJson', () => {
  it('reads every entry of the 2.1.311 capture', () => {
    const { entries, rejected } = parseAgentsJson(FIXTURE)
    expect(entries).toHaveLength(6)
    expect(rejected).toEqual([])
  })

  it('rejects an entry without a sessionId and keeps the rest', () => {
    const text = JSON.stringify([{ cwd: '/a', kind: 'interactive', startedAt: 1 }, { ...base }])
    const { entries, rejected } = parseAgentsJson(text)
    expect(entries).toHaveLength(1)
    expect(rejected).toEqual([{ index: 0, reason: 'no sessionId' }])
  })

  it('rejects an entry whose field has the wrong type', () => {
    const { rejected } = parseAgentsJson(JSON.stringify([{ ...base, pid: '12' }]))
    expect(rejected[0]?.reason).toBe('pid is not a number')
  })

  it('ignores fields it does not know', () => {
    const { entries } = parseAgentsJson(JSON.stringify([{ ...base, futureField: { a: 1 } }]))
    expect(entries).toHaveLength(1)
  })

  it('throws when the output is not an array', () => {
    expect(() => parseAgentsJson('{}')).toThrow('did not print an array')
  })
})

describe('activityOf', () => {
  it.each([
    [{ pid: 1, status: 'busy' }, 'working'],
    [{ pid: 1, status: 'idle' }, 'idle'],
    [{ pid: 1, status: 'waiting', waitingFor: 'permission prompt' }, 'waiting'],
    [{ pid: 1, status: 'idle', state: 'blocked' }, 'waiting'],
    [{ state: 'blocked' }, 'stale'],
    [{ state: 'working' }, 'working'],
    [{ state: 'done' }, 'idle'],
    [{ state: 'failed' }, 'failed'],
    [{ state: 'stopped' }, 'stopped'],
    [{ pid: 1, status: 'pondering' }, 'unknown'],
    [{ state: 'pondering' }, 'unknown'],
    // A pid and no status yet, for one poll after a respawn, a wake or a copy: read by state (Research MIP2-1448).
    [{ pid: 1, state: 'done' }, 'idle'],
    [{ pid: 1, state: 'working' }, 'working'],
    [{ pid: 1 }, 'unknown'],
  ] as const)('%o is %s', (fields, expected) => {
    expect(activityOf({ ...base, ...fields })).toBe(expected)
  })
})

describe('needsYouOf', () => {
  it.each([
    ['permission prompt', 'permission'],
    ['input needed', 'question'],
    ['sandbox request', 'sandbox'],
    ['worker request', 'worker'],
    ['dialog open', 'dialog'],
    ['a new kind of wait', 'other'],
    ['goal proposal', 'other'],
  ] as const)('maps waitingFor %s to %s', (waitingFor, kind) => {
    expect(needsYouOf({ ...base, pid: 1, status: 'waiting', waitingFor }, 'waiting')).toEqual({
      kind,
      detail: waitingFor,
    })
  })

  it('names a blocked session with no open prompt', () => {
    expect(needsYouOf({ ...base, pid: 1, state: 'blocked' }, 'waiting')).toEqual({ kind: 'blocked', detail: null })
  })

  it('is null unless the session is waiting', () => {
    expect(needsYouOf({ ...base, state: 'blocked' }, 'stale')).toBeNull()
  })
})

describe('toSnapshot', () => {
  it('carries source and observedAt on every field', () => {
    const [entry] = parseAgentsJson(FIXTURE).entries
    const snap = toSnapshot(entry!, 1234)
    expect(snap.contractVersion).toBe(1)
    expect(snap.sessionId).toBe('c0ffee02-0000-4000-8000-000000000002')
    for (const key of ['kind', 'cwd', 'startedAt', 'name', 'shortId', 'pid', 'activity', 'needsYou'] as const) {
      expect(snap[key]).toMatchObject({ source: 'agents-json', observedAt: 1234, stale: false })
    }
  })

  it('maps the capture to the expected activity and needs-you kind', () => {
    const rows = parseAgentsJson(FIXTURE).entries.map(e => toSnapshot(e, 0))
    expect(rows.map(r => [r.name.value, r.activity.value, r.needsYou.value?.kind ?? null])).toEqual([
      ['repo-a-1d', 'working', null],
      ['repo-b-2e', 'idle', null],
      ['probe-question', 'waiting', 'question'],
      ['probe-permission', 'waiting', 'permission'],
      ['exited while blocked', 'stale', null],
      ['finished', 'idle', null],
    ])
  })

  it('treats an undocumented kind as interactive', () => {
    expect(toSnapshot({ ...base, kind: 'remote' }, 0).kind.value).toBe('interactive')
  })
})
