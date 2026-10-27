// The New Session sheet's Extra flags (spec MIP2-1387 §2.1): split like a
// shell would, without running one, then checked against an allowlist
// (gate M-4, MIP2-1431). Only flags that leave the session's permissions,
// settings, prompt, tools granted and identity alone, or narrow them, pass.
// So the mode the app records is the mode the session runs with. The sheet
// shows the refusal; main checks again (validate.ts).

/** Flags the app sets or that would break hosting, as the spec lists them. */
export const APP_FLAGS = ['--bg', '--settings', '--plugin-dir', '--resume', '-r', '-p', '--print', '--fork-session'] as const

const MAX_ARGS = 32
const MAX_ARG = 1024

export type FlagsResult = { ok: true; args: string[] } | { ok: false; error: string }

/** Splits on spaces outside quotes; single quotes are literal, double quotes allow \" and \\. */
export function splitFlags(text: string): FlagsResult {
  const args: string[] = []
  let cur = ''
  let has = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
    } else if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) cur += text[++i]
      else cur += c
    } else if (c === "'" || c === '"') {
      quote = c
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur) args.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (quote) return { ok: false, error: 'A quote is not closed.' }
  if (has || cur) args.push(cur)
  return checkFlags(args)
}

/**
 * The extra flags the app allows, with what each takes (`claude --help`,
 * 2.1.311): none, one value, or values up to the next flag. `--debug` takes
 * its filter only as `--debug=<filter>`, so a stray word can't become one.
 */
const ALLOWED: Record<string, 'none' | 'one' | 'many'> = {
  '--verbose': 'none',
  '--debug': 'none',
  '-d': 'none',
  '--brief': 'none',
  '--no-chrome': 'none',
  '--disable-slash-commands': 'none',
  '--fallback-model': 'one',
  '--max-budget-usd': 'one',
  '--autocompact': 'one',
  '--disallowed-tools': 'many',
  '--disallowedTools': 'many',
  '--tools': 'many',
}

/** Allows only the flags above, each with its values; refuses control characters and oversize input. */
export function checkFlags(args: readonly unknown[]): FlagsResult {
  if (args.length > MAX_ARGS) return { ok: false, error: `At most ${MAX_ARGS} extra flags.` }
  for (const a of args) {
    if (typeof a !== 'string' || a.length > MAX_ARG || /[\u0000-\u001f\u007f]/.test(a)) return { ok: false, error: 'A flag is too long or has control characters.' }
  }
  const list = args as string[]
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!
    if (a === '--') return { ok: false, error: '-- is set by the app.' }
    const eq = a.indexOf('=')
    const name = a.startsWith('-') && eq > 0 ? a.slice(0, eq) : a
    if ((APP_FLAGS as readonly string[]).includes(name)) return { ok: false, error: `${name} is set by the app.` }
    const takes = ALLOWED[name]
    if (!takes) return { ok: false, error: a.startsWith('-') ? `${name} isn't one of the extra flags the app allows.` : `"${a}" isn't a flag.` }
    if (eq > 0) {
      if (takes === 'none' && name !== '--debug') return { ok: false, error: `${name} takes no value.` }
      continue
    }
    const value = (j: number) => j < list.length && list[j] !== '' && !list[j]!.startsWith('-')
    if (takes === 'one') {
      if (!value(i + 1)) return { ok: false, error: `${name} needs a value.` }
      i += 1
    } else if (takes === 'many') {
      if (!value(i + 1)) return { ok: false, error: `${name} needs a value.` }
      while (value(i + 1)) i += 1
    }
  }
  return { ok: true, args: list }
}
