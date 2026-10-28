// A question answered in the terminal stops showing as Needs you (MIP2-1492):
// the app counts an offered ask only while Claude Code says the session waits
// on Alex, or for a short grace after the offer; the newest ask shows first;
// and the mod settles an offer when its call finishes.

import { field, type PendingRequest, type SessionSnapshot } from '@ccc/contract'
import { describe, expect, it } from 'vitest'
import { ASK_GRACE_MS, livePending } from '@ccc/coupling'
import { finishedCallSettles } from '../mod/hooks/offers.ts'

const ask = (requestId: string, askedAt: number, tool = 'AskUserQuestion'): PendingRequest =>
  ({ requestId, tool, summary: '', fields: [], refusal: null, questions: null, canRemember: false, agentId: null, askedAt }) as unknown as PendingRequest
const session = (activity: string, needs: SessionSnapshot['needsYou']['value'] = null) =>
  ({ activity: field(activity, 'agents-json', 0), needsYou: field(needs, 'agents-json', 0) }) as unknown as Pick<SessionSnapshot, 'activity' | 'needsYou'>

describe('which offered asks still need Alex', () => {
  const now = 1_000_000
  it('drops an ask once Claude Code says the session is working again', () => {
    expect(livePending([ask('q', now - 9 * 60_000)], session('working'), now)).toEqual([])
  })
  it("keeps an ask while Claude Code says it's waiting or needs Alex", () => {
    expect(livePending([ask('q', now - 9 * 60_000)], session('waiting'), now)).toHaveLength(1)
    expect(livePending([ask('q', now - 9 * 60_000)], session('blocked', { kind: 'permission', detail: null } as never), now)).toHaveLength(1)
  })
  it('keeps a newly offered ask for the grace period, so a poll that lags the dialog opening loses nothing', () => {
    expect(livePending([ask('q', now - ASK_GRACE_MS + 1)], session('working'), now)).toHaveLength(1)
    expect(livePending([ask('q', now - ASK_GRACE_MS)], session('working'), now)).toEqual([])
  })
  it('puts the newest ask first, so a new prompt shows over an answered question', () => {
    const out = livePending([ask('old', now - 9 * 60_000), ask('new', now - 1_000, 'Bash')], session('waiting'), now)
    expect(out.map(p => p.requestId)).toEqual(['new', 'old'])
  })
})

describe('the mod settles an offer when its call finishes', () => {
  it('by tool_use_id, and by tool when the id was never matched', () => {
    expect(finishedCallSettles({ toolUseId: 'toolu_1', tool: 'AskUserQuestion' }, { toolUseId: 'toolu_1', tool: 'AskUserQuestion' })).toBe(true)
    expect(finishedCallSettles({ toolUseId: null, tool: 'AskUserQuestion' }, { toolUseId: 'toolu_9', tool: 'AskUserQuestion' })).toBe(true)
    expect(finishedCallSettles({ toolUseId: 'toolu_1', tool: 'AskUserQuestion' }, { toolUseId: 'toolu_2', tool: 'AskUserQuestion' })).toBe(false)
    expect(finishedCallSettles({ toolUseId: null, tool: 'Bash' }, { toolUseId: 'toolu_9', tool: 'AskUserQuestion' })).toBe(false)
  })
})
