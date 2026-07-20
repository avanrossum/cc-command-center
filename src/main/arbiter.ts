// The Arbiter — an OPTIONAL control agent that writes a plain-English gloss for
// each session waiting on the human.
//
// Three properties this file exists to guarantee:
//
//  1. OPTIONAL. Nothing here runs unless the user enables it AND selects a stored
//     API key. Every entry point returns a neutral result when it is off, so the
//     app behaves exactly as before with no key present.
//
//  2. METERED, NOT ARBITRAGED. This is a direct, paid Anthropic API call — not a
//     spawned `claude` CLI session. An app-driven agent looping on a flat-rate
//     subscription would be metering arbitrage; paying API rates for app-driven
//     inference is not.
//
//  3. NO SURPRISE BILLS. Spend is recorded for every billable call, checked
//     against a hard cap BEFORE each request, and surfaced in the UI as it
//     accrues. The cap stops the agent rather than warning about it.
//
// It is READ-ONLY: it reads fleet state and returns text. It takes no action on
// any session, and asks the human nothing.
import Anthropic from '@anthropic-ai/sdk'
import {
  appendArbiterLog,
  arbiterContextCategoryIds,
  getArbiterSpend,
  recordArbiterSpend,
} from './registry'

// Sonnet: steady enough for triage, cheap enough to run often. Haiku tested as
// jumpy on this task; Opus is not worth the rate for one-line summaries.
export const ARBITER_MODEL = 'claude-sonnet-5'

// USD per million tokens. Deliberately the STANDARD rate, not the promotional
// one — over-reporting spend is safe, under-reporting is the failure that
// produces a surprise bill.
const PRICE = {
  input: 3.0,
  output: 15.0,
  cacheRead: 0.3, // ~0.1x input
  cacheWrite: 3.75, // ~1.25x input
}

function costOf(u: {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}): number {
  const M = 1_000_000
  return (
    ((u.input_tokens ?? 0) * PRICE.input +
      (u.output_tokens ?? 0) * PRICE.output +
      (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite) /
    M
  )
}

// What the Arbiter is told about one session. `detail` is present only when the
// session's category is cleared for substance; otherwise the model sees state
// and shape alone and writes a vaguer — but honest — line.
export interface ArbiterSessionInput {
  sessionId: string
  name: string
  category: string
  categoryId: number | null
  state: string // permission | question | blocked | working | idle
  kind?: string // gate kind, e.g. 'permission' | 'question'
  detail?: string // the substance: pending command / the question asked
}

export interface ArbiterResult {
  ok: boolean
  glosses: Record<string, string>
  costUsd: number
  error?: string
  skipped?: 'disabled' | 'no-key' | 'capped' | 'nothing-to-do' | 'unchanged'
}

const NEUTRAL = (skipped: ArbiterResult['skipped']): ArbiterResult => ({
  ok: true,
  glosses: {},
  costUsd: 0,
  skipped,
})

const SYSTEM = `You triage a fleet of autonomous coding sessions for one developer.

For each session you are given, write ONE line explaining why it is waiting on the human.

Rules:
- Plain language. A tired person scanning at 2am should get it instantly.
- 90 characters maximum. No trailing period.
- Say what it wants, not what it is. "wants to delete the migrations folder" beats "awaiting approval".
- When you are given only metadata and no detail, say what is known and DO NOT invent specifics.
- Never rank, prioritise, or tell the human what to do. They decide what is urgent.
- No preamble, no pleasantries, no emoji.

Return one entry per session you were given, keyed by its exact sessionId.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    glosses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          gloss: { type: 'string' },
        },
        required: ['sessionId', 'gloss'],
      },
    },
  },
  required: ['glosses'],
}

export interface ArbiterConfig {
  enabled: boolean
  apiKey: string | null
  capUsd: number
}

// A stable digest of what we are about to ask. Identical input → identical
// answer, so the previous result is reused instead of paying for it twice.
export function arbiterInputFingerprint(sessions: ArbiterSessionInput[]): string {
  return sessions
    .map((s) => `${s.sessionId}|${s.state}|${s.kind ?? ''}|${s.detail ?? ''}`)
    .sort()
    .join('\n')
}

// Strip anything the user has not cleared for the API. Runs immediately before
// the request is built, so a category revoked mid-session takes effect at once.
export function redactForApi(sessions: ArbiterSessionInput[]): ArbiterSessionInput[] {
  const allowed = arbiterContextCategoryIds()
  return sessions.map((s) => {
    if (s.categoryId !== null && allowed.has(s.categoryId)) return s
    const { detail: _drop, ...rest } = s
    return rest
  })
}

export async function runArbiter(
  cfg: ArbiterConfig,
  sessions: ArbiterSessionInput[],
): Promise<ArbiterResult> {
  if (!cfg.enabled) return NEUTRAL('disabled')
  if (!cfg.apiKey) return NEUTRAL('no-key')
  if (sessions.length === 0) return NEUTRAL('nothing-to-do')

  // Cap check BEFORE spending. A cap that only warns is not a cap.
  const spend = getArbiterSpend()
  if (cfg.capUsd > 0 && spend.todayUsd >= cfg.capUsd) {
    appendArbiterLog('capped', `daily cap reached ($${cfg.capUsd.toFixed(2)}) — paused`)
    return NEUTRAL('capped')
  }

  const safe = redactForApi(sessions)
  const withDetail = safe.filter((s) => s.detail).length

  const client = new Anthropic({ apiKey: cfg.apiKey })
  let costUsd = 0
  try {
    const res = await client.messages.create({
      model: ARBITER_MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      // Triage is a summarisation task, not a reasoning one. Thinking off plus
      // low effort keeps a frequently-run agent cheap.
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: JSON.stringify({ sessions: safe }) }],
    })

    costUsd = costOf(res.usage ?? {})
    recordArbiterSpend({
      model: ARBITER_MODEL,
      input_tokens: res.usage?.input_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
      cache_read_tokens: res.usage?.cache_read_input_tokens ?? 0,
      cache_write_tokens: res.usage?.cache_creation_input_tokens ?? 0,
      cost_usd: costUsd,
      ok: true,
    })

    // A refusal is a successful HTTP response with no usable content.
    if (res.stop_reason === 'refusal') {
      appendArbiterLog('error', 'model declined this batch')
      return { ok: false, glosses: {}, costUsd, error: 'refusal' }
    }

    const text = res.content.find((b) => b.type === 'text')
    const parsed = text && 'text' in text ? JSON.parse(text.text) : { glosses: [] }
    const glosses: Record<string, string> = {}
    for (const g of parsed.glosses ?? []) {
      if (g?.sessionId && typeof g.gloss === 'string') glosses[g.sessionId] = g.gloss.trim()
    }

    // Counts only — never the substance. This log persists; session content
    // must not end up in it just because it was sent to the API once.
    appendArbiterLog(
      'run',
      `${Object.keys(glosses).length}/${safe.length} glossed` +
        `${withDetail < safe.length ? ` · ${safe.length - withDetail} metadata-only` : ''}` +
        ` · $${costUsd.toFixed(4)}`,
    )
    return { ok: true, glosses, costUsd }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Record the attempt even on failure: a request can be billed after the
    // model has generated tokens, and an unrecorded call is a silent debit.
    recordArbiterSpend({
      model: ARBITER_MODEL,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      ok: false,
    })
    appendArbiterLog('error', msg.slice(0, 160))
    return { ok: false, glosses: {}, costUsd: 0, error: msg }
  }
}
