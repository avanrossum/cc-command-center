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

// The models the Arbiter can run on. Each entry carries BOTH its pricing and its
// request-shape rules, because getting either wrong breaks a guarantee:
//
//  - PRICE drives the spend ledger. Wrong price → the "no surprise bills"
//    promise lies. Rates are USD per 1M tokens, the STANDARD (not promotional)
//    rate, so spend over-reports rather than under-reports.
//  - `effort` and `thinkingDisabled` are per-model API facts, not preferences.
//    `output_config.effort` is REJECTED on Haiku 4.5 (a 400), so it must be
//    omitted there. And omitting `thinking` runs ADAPTIVE on Sonnet 5 (it would
//    think, and cost, on every triage) but runs no-thinking on Haiku — so the
//    disable is sent only where it's both needed and accepted.
export interface ArbiterModelSpec {
  label: string
  price: { input: number; output: number; cacheRead: number; cacheWrite: number }
  effort: boolean // output_config.effort supported (false on Haiku 4.5)
  thinkingDisabled: boolean // send thinking:{disabled} (needed on Sonnet, a no-op default on Haiku)
}

export const ARBITER_MODELS: Record<string, ArbiterModelSpec> = {
  'claude-haiku-4-5': {
    label: 'Haiku',
    price: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
    effort: false,
    thinkingDisabled: false, // Haiku doesn't think by default; omit the param
  },
  'claude-sonnet-5': {
    label: 'Sonnet',
    price: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    effort: true,
    thinkingDisabled: true, // else Sonnet 5 runs adaptive thinking and bills for it
  },
  'claude-opus-4-8': {
    label: 'Opus',
    price: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    effort: true,
    thinkingDisabled: true,
  },
}
// Default: cheapest tier. Triage is a one-line summarisation task, and running
// it often on the priciest model is exactly the surprise this feature avoids.
export const DEFAULT_ARBITER_MODEL = 'claude-haiku-4-5'

function specFor(model: string): ArbiterModelSpec {
  return ARBITER_MODELS[model] ?? ARBITER_MODELS[DEFAULT_ARBITER_MODEL]
}

function costOf(
  spec: ArbiterModelSpec,
  u: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
  },
): number {
  const M = 1_000_000
  const p = spec.price
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
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
  // True once a request actually reached the API and could be billed. The caller
  // uses this to decide whether to mark the input as answered: retrying a
  // question that was already PAID for (a refusal, or output we failed to parse)
  // would re-bill the identical request on every scan until the cap drained.
  billed: boolean
}

const NEUTRAL = (skipped: ArbiterResult['skipped']): ArbiterResult => ({
  ok: true,
  glosses: {},
  costUsd: 0,
  skipped,
  billed: false,
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
  model: string // one of ARBITER_MODELS; falls back to the default if unknown
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
    // The NAME is substance too — sessions get named after what they are working
    // on, which is exactly the thing an un-cleared category is withholding. Send
    // a stable handle instead so the model can still key its answer correctly.
    return { ...rest, name: `session-${s.sessionId.slice(0, 8)}` }
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
  const spec = specFor(cfg.model)
  const model = ARBITER_MODELS[cfg.model] ? cfg.model : DEFAULT_ARBITER_MODEL

  const client = new Anthropic({ apiKey: cfg.apiKey })
  let costUsd = 0
  try {
    // Triage is summarisation, not reasoning — keep it cheap. Effort and the
    // thinking-disable are model-specific: effort 400s on Haiku, and omitting
    // thinking on Sonnet 5 would run adaptive. See ARBITER_MODELS.
    const outputConfig = spec.effort
      ? { effort: 'low' as const, format: { type: 'json_schema' as const, schema: SCHEMA } }
      : { format: { type: 'json_schema' as const, schema: SCHEMA } }
    const res = await client.messages.create({
      model,
      // Scales with the batch: a truncated response is unparseable JSON that was
      // still billed in full, so under-sizing this is a money bug, not a UX one.
      max_tokens: Math.min(4096, 320 + safe.length * 80),
      system: SYSTEM,
      ...(spec.thinkingDisabled ? { thinking: { type: 'disabled' as const } } : {}),
      output_config: outputConfig,
      messages: [{ role: 'user', content: JSON.stringify({ sessions: safe }) }],
    })

    costUsd = costOf(spec, res.usage ?? {})
    recordArbiterSpend({
      model,
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
      return { ok: false, glosses: {}, costUsd, error: 'refusal', billed: true }
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
    return { ok: true, glosses, costUsd, billed: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Record the attempt even on failure: a request can be billed after the
    // model has generated tokens, and an unrecorded call is a silent debit.
    recordArbiterSpend({
      model,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      ok: false,
    })
    appendArbiterLog('error', msg.slice(0, 160))
    // A thrown request may or may not have been billed. Treat it as billed only
    // when the failure came back from the API itself (a status error) rather
    // than from connecting — a connection that never landed cannot be charged.
    const billed = typeof (e as { status?: number })?.status === 'number'
    return { ok: false, glosses: {}, costUsd: 0, error: msg, billed }
  }
}
