// The card's Allow appears only for what it shows in full (gate H-1, MIP2-1428).

import { field, type PendingRequest, type SessionSnapshot } from '@ccc/contract'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { approveState, AskBlock, nextSeen, NowLine, seenWhole, withinLines } from '../src/renderer/components/Card.tsx'
import { cardView } from '../src/renderer/model/card-state.ts'
import { UNCAT_REF, type Entry } from '../src/renderer/model/fleet.ts'

const NOW = 1_800_000_000_000

function entry(req: PendingRequest): Entry {
  const f = <T,>(v: T) => field(v, 'agents-json', NOW)
  const session: SessionSnapshot = {
    contractVersion: 1,
    sessionId: 's1',
    kind: f('background'),
    cwd: f('/Users/example/app'),
    startedAt: f(NOW),
    name: f('app'),
    shortId: f('s1'),
    pid: f(1),
    activity: f('waiting'),
    needsYou: f({ kind: 'permission', detail: 'permission prompt' }),
    model: field('m', 'mod', NOW),
    pendingRequests: field([req], 'mod', NOW),
  }
  return { session, view: cardView(session, NOW), since: null, cat: UNCAT_REF, name: 'app', contractor: null, life: { stage: 'live', deadAt: null }, neverRollOff: false, children: [], parentName: null }
}

const req = (over: Partial<PendingRequest>): PendingRequest => ({
  requestId: 'r',
  tool: 'Bash',
  summary: 'ls',
  fields: [{ name: 'command', value: 'ls' }],
  refusal: null,
  questions: null,
  canRemember: false,
  agentId: null,
  askedAt: NOW,
  ...over,
})

const html = (r: PendingRequest) => renderToStaticMarkup(<AskBlock e={entry(r)} onOpen={() => {}} armed={false} />)

describe('AskBlock', () => {
  it('offers Allow for a request shown in full, and shows every field', () => {
    const out = html(req({ fields: [{ name: 'command', value: 'ls -la\n| wc' }, { name: 'description', value: 'count' }] }))
    expect(out).toContain('>Allow<')
    expect(out).toContain('ls -la\n| wc')
    expect(out).toContain('>description<')
  })

  it('has no Allow button when the card refuses, only Deny and Open, with the reason', () => {
    const out = html(req({ refusal: 'Too long to approve from the card; answer it in the session.' }))
    expect(out).not.toContain('>Allow<')
    expect(out).toContain('>Deny<')
    expect(out).toContain('Open ↗')
    expect(out).toContain('Too long to approve from the card')
  })
})

describe('approveState (gate run 2, M-2)', () => {
  it('approves only with no refusal, the box within 8 lines, and the whole ask on screen', () => {
    expect(approveState(null, true, true)).toBe('ready')
    // Y and Allow wait while any of the ask is out of view.
    expect(approveState(null, true, false)).toBe('off-screen')
    expect(approveState(null, false, true)).toBe('too-tall')
    expect(approveState('Too long', true, true)).toBe('refused')
    expect(approveState('none', true, true)).toBe('refused')
  })

  it('renders Allow disabled until the ask has been seen whole', () => {
    // Server rendering has no viewport: the first paint is "off screen".
    expect(html(req({}))).toMatch(/<button class="ab pri" disabled="" title="Scroll the whole request into view to approve it.">Allow<\/button>/)
  })
})

describe('visibility belongs to its request (pass 4, L-3)', () => {
  it("doesn't carry the last ask's visibility to a new one, even in its first render", () => {
    const seen = nextSeen(null, 'r1', 1)
    expect(seenWhole(seen, 'r1')).toBe(true)
    // r2 arrives: the state still says r1 until an observer reading for r2.
    expect(seenWhole(seen, 'r2')).toBe(false)
    expect(seenWhole(nextSeen(seen, 'r2', 0.5), 'r2')).toBe(false)
    expect(seenWhole(nextSeen(seen, 'r2', 1), 'r2')).toBe(true)
    expect(nextSeen('r1', 'r1', 0.4)).toBeNull()
    expect(seenWhole(seen, undefined)).toBe(false)
  })
})

describe('the line limit counts newlines, not wrapping (MIP2-1442)', () => {
  it('offers Allow for a long one-path command and its description, and not for nine lines', () => {
    const command = `touch /Users/example/Developer/acme-tools/acme-tools-checks-and-tests/check/focus/runs-local/2026-10-27T090/qa-long-ran`
    const typical = html(req({ fields: [{ name: 'command', value: command }, { name: 'description', value: 'Create a marker file to show the long-path command ran ok' }] }))
    expect(typical).toContain('>Allow<')
    expect(typical).not.toContain('Too long')
    expect(withinLines([{ value: 'a\nb\nc\nd\ne\nf\ng' }, { value: 'x' }])).toBe(true)
    expect(withinLines([{ value: 'a\nb\nc\nd\ne\nf\ng\nh' }, { value: 'x' }])).toBe(false)
    expect(html(req({ fields: [{ name: 'command', value: 'a\nb\nc\nd\ne\nf\ng\nh\ni' }] }))).not.toContain('>Allow<')
  })
})

describe("a blocked card's line (MIP2-1485)", () => {
  const blocked = (waitingOn?: string): Entry => {
    const e = entry(req({}))
    const session: SessionSnapshot = { ...e.session, needsYou: field({ kind: 'blocked', detail: null }, 'agents-json', NOW), pendingRequests: field([], 'mod', NOW) }
    return { ...e, session, view: cardView(session, NOW), ...(waitingOn !== undefined ? { waitingOn } : {}) }
  }

  it("shows the Arbiter's line as plain text, and the old line where the category doesn't allow it", () => {
    expect(renderToStaticMarkup(<NowLine e={blocked('Asks <b>which</b> branch to merge.')} />)).toBe('<p class="c-now">Asks &lt;b&gt;which&lt;/b&gt; branch to merge.</p>')
    expect(renderToStaticMarkup(<NowLine e={blocked()} />)).toContain('Open the session to see what it needs.')
    // The turn's own line, for a category not opted in, is labeled so it isn't taken for the Arbiter's.
    expect(renderToStaticMarkup(<NowLine e={{ ...blocked('Run it <now>?'), waitingLastLine: true }} />)).toBe('<p class="c-now">Last line: &quot;Run it &lt;now&gt;?&quot;</p>')
  })
})
