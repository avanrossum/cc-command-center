// Extra flags (MIP2-1407, spec MIP2-1387 §2.1).

import { describe, expect, it } from 'vitest'
import { checkFlags, splitFlags } from '../src/shared/flags.ts'

describe('splitFlags', () => {
  it('splits like a shell, without running one', () => {
    expect(splitFlags(`--fallback-model "claude-sonnet-5-5" --disallowed-tools 'Bash(rm:*)' WebFetch --verbose`)).toEqual({
      ok: true,
      args: ['--fallback-model', 'claude-sonnet-5-5', '--disallowed-tools', 'Bash(rm:*)', 'WebFetch', '--verbose'],
    })
    expect(splitFlags(`--fallback-model "a \\"b\\" c"`)).toEqual({ ok: true, args: ['--fallback-model', 'a "b" c'] })
    expect(splitFlags('   ')).toEqual({ ok: true, args: [] })
    // Shell syntax stays text: nothing runs it, and a stray word isn't a flag.
    expect(splitFlags('--verbose $(rm -rf ~); echo')).toEqual({ ok: false, error: '"$(rm" isn\'t a flag.' })
  })

  it("refuses the app's own flags, in either form, with the spec's message", () => {
    for (const f of ['--bg', '--settings x', '--settings=x', '--plugin-dir d', '--resume id', '-r id', '-p', '--print', '--fork-session']) {
      const r = splitFlags(f)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toMatch(/is set by the app\.$/)
    }
    expect(splitFlags('-- hi')).toEqual({ ok: false, error: '-- is set by the app.' })
    expect(splitFlags('"open')).toEqual({ ok: false, error: 'A quote is not closed.' })
  })

  it('allows only flags that leave the session as the app records it (gate M-4)', () => {
    for (const f of [
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
      '--permission-mode bypassPermissions',
      '--permission-mode=auto',
      '--mcp-config x.json',
      '--strict-mcp-config',
      '--add-dir /',
      '--setting-sources user',
      '--system-prompt hi',
      '--append-system-prompt hi',
      '--session-id 0',
      '-c',
      '--continue',
      '--allowed-tools Bash',
      '--chrome',
      '--agents {}',
      '--model opus',
    ]) {
      expect(splitFlags(f).ok, f).toBe(false)
    }
    expect(splitFlags('--debug=api --max-budget-usd 2 --tools Read Grep --no-chrome').ok).toBe(true)
    expect(splitFlags('--fallback-model')).toEqual({ ok: false, error: '--fallback-model needs a value.' })
    expect(splitFlags('--verbose=1')).toEqual({ ok: false, error: '--verbose takes no value.' })
    expect(splitFlags('--debug api')).toEqual({ ok: false, error: '"api" isn\'t a flag.' })
  })

  it('refuses control characters and oversize input', () => {
    expect(checkFlags(['a\nb']).ok).toBe(false)
    expect(checkFlags(Array(33).fill('x')).ok).toBe(false)
    expect(checkFlags([42]).ok).toBe(false)
  })
})
