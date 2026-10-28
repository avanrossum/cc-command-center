// The Arbiter's call to the Anthropic API (MIP2-1411): claude-haiku-5-5 at
// low effort, with the answer constrained to the ranking's shape
// (structured outputs). The key comes from the app's own encrypted store
// (arbiter-key.ts).

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { ARBITER_MODEL, type Ask } from './arbiter.ts'
import type { Summarize } from './summaries.ts'
import type { TipsCall } from './usage-tips.ts'

/** The API's own host. Every client pins it, so ANTHROPIC_BASE_URL in the app's environment is never used (gate pass 16, M-3). */
export const API_BASE_URL = 'https://api.anthropic.com'

/** The one place an Anthropic client is made: the key, the pinned host, and a short timeout, since every answer is small. */
export function anthropicClient(key: string): Anthropic {
  return new Anthropic({ apiKey: key, baseURL: API_BASE_URL, timeout: 30_000 })
}

const SummarySchema = z.object({ summary: z.string() })
const TipsSchema = z.object({ tips: z.array(z.object({ text: z.string(), evidence: z.string() })) })

const RankingSchema = z.object({
  order: z.array(z.object({ key: z.string(), reason: z.string() })),
  start: z.object({ key: z.string() }).nullable(),
})

/** The key is read on each call, so one saved after start is used; the Arbiter stays off until there is one. */
export function createAsk(apiKey: () => string | null): Ask {
  return async (system, user) => {
    const key = apiKey()
    if (!key) throw new Error('no Arbiter key')
    // Two retries for 429 and 5xx, the SDK's default; a short timeout, since the answer is small.
    const client = anthropicClient(key)
    const response = await client.messages.parse({
      model: ARBITER_MODEL,
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low', format: zodOutputFormat(RankingSchema) },
    })
    if (response.stop_reason === 'refusal') throw new Error('the model declined to rank')
    return { ranking: response.parsed_output ?? null, usage: response.usage }
  }
}

/** A turn summary (MIP2-1422): the same model, key and settings as the ranking, with a one-field answer. */
export function createSummarize(apiKey: () => string | null): Summarize {
  return async (system, user) => {
    const key = apiKey()
    if (!key) throw new Error('no Arbiter key')
    const client = anthropicClient(key)
    const response = await client.messages.parse({
      model: ARBITER_MODEL,
      max_tokens: 256,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low', format: zodOutputFormat(SummarySchema) },
    })
    if (response.stop_reason === 'refusal') throw new Error('the model declined to summarize')
    return { summary: response.parsed_output?.summary ?? null, usage: response.usage }
  }
}

/** The usage help panel's tips (MIP2-1498 §4.5): the same model, key and settings, with a list of tips and their evidence. */
export function createTips(apiKey: () => string | null): TipsCall {
  return async (system, user) => {
    const key = apiKey()
    if (!key) throw new Error('no Arbiter key')
    const client = anthropicClient(key)
    const response = await client.messages.parse({
      model: ARBITER_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low', format: zodOutputFormat(TipsSchema) },
    })
    if (response.stop_reason === 'refusal') throw new Error('the model declined to give tips')
    return { tips: response.parsed_output?.tips ?? null, usage: response.usage }
  }
}
