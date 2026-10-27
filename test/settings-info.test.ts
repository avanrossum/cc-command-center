// The settings window's Copy build info text (MIP2-1424).

import { describe, expect, it } from 'vitest'
import { buildInfo } from '../src/renderer/components/Settings.tsx'

const status = {
  version: '0.1.0',
  commit: 'abc1234',
  builtAt: '2026-10-27T08:00:00.000Z',
  electron: '44.9.3',
  chrome: '146.0.0.0',
  node: '24.1.0',
  floor: '2.1.311',
  supervisor: 'up',
  restartsToday: 0,
  arbiterKey: null,
}

describe('buildInfo', () => {
  it('copies the version, build, runtimes and Claude Code version as plain lines', () => {
    expect(buildInfo(status, '2.1.311')).toBe(
      'CC Command Center 0.1.0 (build abc1234 · 2026-10-27)\nElectron 44.9.3 · Chromium 146.0.0.0 · Node 24.1.0\nClaude Code 2.1.311 (supports 2.1.311 or later)',
    )
    expect(buildInfo({ ...status, builtAt: '' }, null)).toContain('(build abc1234)\n')
    expect(buildInfo(status, null)).toContain('Claude Code not found')
  })
})
