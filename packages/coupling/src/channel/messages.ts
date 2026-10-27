// Checks the mod's permission requests before the app holds them. A verified
// MAC proves the request came from the session's mod, not that the session's
// model didn't steer what it contains, so the content is still untrusted text.

import { CARD_APPROVE_LINES } from '@ccc/contract'
import { cardQuestions, type PermissionAsk } from '../../../../mod/hooks/channel-wire.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SUMMARY_CHARS = 500

export function parsePermissionAsk(data: unknown): PermissionAsk | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.requestId !== 'string' || !UUID.test(d.requestId)) return null
  if (typeof d.tool !== 'string' || d.tool === '' || d.tool.length > 200) return null
  if (!(d.toolUseId === null || typeof d.toolUseId === 'string')) return null
  if (!(d.agentId === null || typeof d.agentId === 'string')) return null
  if (typeof d.canRemember !== 'boolean') return null
  const questions = d.tool === 'AskUserQuestion' ? cardQuestions(d.input) : null
  if (d.tool === 'AskUserQuestion' && !questions) return null
  return {
    requestId: d.requestId,
    toolUseId: d.toolUseId,
    agentId: d.agentId,
    tool: d.tool,
    input: d.input,
    questions,
    canRemember: d.canRemember,
  }
}

/** One line for the card: the command, the path, or the first question. */
export function summarize(ask: PermissionAsk): string {
  const input = (typeof ask.input === 'object' && ask.input !== null ? ask.input : {}) as Record<string, unknown>
  const pick = (...keys: string[]) => keys.map(k => input[k]).find((v): v is string => typeof v === 'string')
  const text =
    ask.questions?.[0]?.question ??
    pick('command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'description') ??
    JSON.stringify(ask.input ?? null)
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1)}…` : flat
}

/**
 * Tools a card may approve, and every input field each may carry (gate H-1,
 * MIP2-1428). Each field is shown in full on the card, so what Alex approves
 * is what he sees. Anything else (Write, Edit, MCP tools, an unknown field
 * such as Bash's `run_in_background` or `dangerouslyDisableSandbox`) is
 * answered in the session: Open only.
 */
export const CARD_APPROVABLE: Record<string, readonly string[]> = {
  Bash: ['command', 'description', 'timeout'],
  Read: ['file_path', 'offset', 'limit'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path', 'glob', 'type', 'output_mode', '-i', '-n', '-A', '-B', '-C', 'head_limit', 'multiline'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query', 'allowed_domains', 'blocked_domains'],
}

/** The most input a card shows; beyond it the text is cut. */
export const CARD_INPUT_CHARS = 4_000
/** The most input a card may approve: all of it on view at once (ruling on MIP2-1428). */
export const CARD_APPROVE_CHARS = 500
// The line limit is the contract's (pass 6, L-3). `ls` plus 480 newlines is under 500 characters but runs off
// the card. An approvable box shows every line and Allow needs the whole ask on screen, so wrapping isn't counted.
export { CARD_APPROVE_LINES }

/**
 * Characters that change how text displays without showing (gate run 2,
 * M-2): format characters (Cf: bidi controls, zero-width spaces and joiners,
 * U+FEFF), line and paragraph separators, and C0 or C1 controls other than
 * newline and tab. The "Trojan Source" technique reorders what's shown
 * while the shell runs the logical order. Also every default-ignorable code
 * point (variation selectors, the combining grapheme joiner, Hangul
 * fillers) and every space but U+0020, which looks like a space but doesn't
 * split shell words (gate run 3, L-1).
 */
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]|(?! )\p{Zs}/gu
/**
 * Combining marks that can change how text reads: a run long enough to draw
 * over its neighbors (gate run 3, L-1), any mark on an ASCII character, such
 * as U+0338 striking through a slash (pass 4, L-6), and on any character an
 * enclosing mark or an overlay (pass 5, L-5): every character of
 * canonical combining class 1 in Unicode 16 (pass 6, L-1). Shell
 * commands and paths rarely need any of them; accented letters pass.
 */
const MARKS = /\p{M}{3,}|[\u0000-\u007f]\p{M}|[\p{Me}\u0334-\u0338\u1CD4\u1CE2-\u1CE8\u20D2\u20D3\u20D8-\u20DA\u20E5\u20E6\u20EA\u20EB\u{10A39}\u{16AF0}-\u{16AF4}\u{1BC9E}\u{1D167}-\u{1D169}]/u

/** The text with each hidden character shown as ⟨U+XXXX⟩, so the card never displays what the shell won't run. */
export function showHidden(text: string): string {
  return text.replace(HIDDEN, c => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`)
}

/** Lines in a value, by newline; wrapping isn't counted (MIP2-1442). */
export function logicalLines(text: string): number {
  return text.split('\n').length
}

export interface CardInput {
  /** Every field of the input, in its order, each value in full (strings as written, the rest as JSON). */
  fields: { name: string; value: string }[]
  /** The fields were cut to fit the card. */
  clipped: boolean
  /** Null when the card may approve; otherwise why it can't, for the card. */
  refusal: string | null
}

/** What the card shows of a permission request, and whether it may approve it. */
export function cardInput(ask: PermissionAsk): CardInput {
  if (ask.questions) return { fields: [], clipped: false, refusal: null }
  const input = typeof ask.input === 'object' && ask.input !== null && !Array.isArray(ask.input) ? (ask.input as Record<string, unknown>) : null
  if (!input) return { fields: [{ name: 'input', value: JSON.stringify(ask.input ?? null) }], clipped: false, refusal: 'This request has no fields the card can show.' }
  let left = CARD_INPUT_CHARS
  let clipped = false
  let total = 0
  let lines = 0
  let hidden = false
  const fields: CardInput['fields'] = []
  for (const [name, raw] of Object.entries(input)) {
    const full = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? 'undefined'
    total += name.length + full.length
    lines += logicalLines(full)
    HIDDEN.lastIndex = 0
    if (HIDDEN.test(full) || HIDDEN.test(name) || MARKS.test(full) || MARKS.test(name)) hidden = true
    HIDDEN.lastIndex = 0
    if (full.length > left) clipped = true
    const cut = full.length > left ? `${full.slice(0, Math.max(0, left))}…` : full
    left = Math.max(0, left - full.length)
    fields.push({ name: showHidden(name), value: showHidden(cut) })
  }
  const allowed = CARD_APPROVABLE[ask.tool]
  const extra = allowed ? Object.keys(input).filter(k => !allowed.includes(k)) : []
  const refusal = !allowed
    ? `${ask.tool} requests are answered in the session.`
    : extra.length
      ? `It also sets ${extra.join(', ')}; answer it in the session.`
      : hidden
        ? 'It has hidden or control characters (shown as ⟨U+…⟩); answer it in the session.'
        : clipped || total > CARD_APPROVE_CHARS || lines > CARD_APPROVE_LINES
          ? 'Too long to approve from the card; answer it in the session.'
          : null
  return { fields, clipped, refusal }
}

