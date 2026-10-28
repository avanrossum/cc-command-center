// Every Anthropic client the app makes talks to Anthropic's own host (gate pass 16, M-3).

import { afterEach, describe, expect, it } from 'vitest'
import { anthropicClient, API_BASE_URL } from '../src/main/arbiter-client.ts'

const saved = process.env.ANTHROPIC_BASE_URL
afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = saved
})

describe('anthropicClient', () => {
  it('pins api.anthropic.com, whatever ANTHROPIC_BASE_URL says', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://elsewhere.example'
    const client = anthropicClient('sk-ant-api03-test')
    expect(API_BASE_URL).toBe('https://api.anthropic.com')
    expect(client.baseURL).toBe('https://api.anthropic.com')
  })
})
