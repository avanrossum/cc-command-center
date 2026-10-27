// The Arbiter's call to the Anthropic API (MIP2-1411): claude-haiku-5-5 at
// low effort, with the answer constrained to the ranking's shape
// (structured outputs). The key comes from the app's own encrypted store
// (arbiter-key.ts).

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { ARBITER_MODEL, type Ask } from './arbiter.ts'
import type { Summarize } from './summaries.ts'

const SummarySchema = z.object({ summary: z.string() })

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
    const client = new Anthropic({ apiKey: key, timeout: 30_000 })
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
    const client = new Anthropic({ apiKey: key, timeout: 30_000 })
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
