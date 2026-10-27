// The mod-to-app channel's wire rules (D-011 item 7, MIP2-1390). Pure code
// with no engine or Node API, so the mod and the coupling package share it
// and tests run it directly.
//
// Every request and every reply is signed with HMAC-SHA256 under the
// session's secret (Research MIP2-1376 §2):
//   request  "req\n" + method + "\n" + path + "\n" + nonce + "\n" + ts + "\n" + body
//   reply    "rep\n" + nonce + "\n" + status + "\n" + body
// The reply is bound to the request's nonce, so an old reply can't answer a
// new request.

export const CHANNEL_PATHS = {
  /** The app proves it holds the secret before the mod sends anything sensitive. */
  hello: '/v1/hello',
  /** Telemetry: the ReporterFile in wire.ts. */
  report: '/v1/report',
  /** A permission or question prompt; long-polled until answered. */
  permission: '/v1/permission',
  /** The mod tells the app a prompt ended without the app's answer. */
  permissionDone: '/v1/permission/done',
  /** Prompts the app relays as Alex's input; long-polled. */
  prompt: '/v1/prompt',
  /** The mod confirms a relayed prompt was submitted. */
  promptAck: '/v1/prompt/ack',
  /** The main loop's whole final text, once per turn (mod 0.6.0, MIP2-1407). */
  answer: '/v1/answer',
} as const

export const HEADER = { nonce: 'x-ccc-nonce', ts: 'x-ccc-ts', mac: 'x-ccc-mac' } as const

/** How far a request's timestamp may be from the app's clock. */
export const TIMESTAMP_WINDOW_MS = 60_000
/** The app holds a long poll this long, under the mod API's 30 s fetch limit. */
export const LONG_POLL_MS = 25_000
/** The largest request or reply body either side accepts. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024
/** Characters kept of a turn's final text on /v1/answer; at most 4 bytes each in UTF-8, so under MAX_BODY_BYTES. */
export const ANSWER_CHARS = 200_000

/** Body of /v1/answer: the turn's final visible text (`turn.complete`'s `answer`), when it ended. */
export interface AnswerPost {
  at: number
  text: string
}

export const SECRET_HEX = /^[0-9a-f]{64}$/
export const NONCE_HEX = /^[0-9a-f]{32}$/
export const MAC_HEX = /^[0-9a-f]{64}$/

export function requestText(method: string, path: string, nonce: string, ts: string, body: string): string {
  return `req\n${method}\n${path}\n${nonce}\n${ts}\n${body}`
}

export function replyText(nonce: string, status: number, body: string): string {
  return `rep\n${nonce}\n${status}\n${body}`
}

/** Strict hex: the whole string, even length, lowercase digits only. Null otherwise. */
export function fromHex(text: string, pattern: RegExp): Uint8Array | null {
  if (!pattern.test(text)) return null
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time comparison of two byte strings. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

// Messages.

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect: boolean
}

/** What the mod sends for a prompt. The app shows it on a card. */
export interface PermissionAsk {
  /** Random per hook call: PermissionRequest carries no tool_use_id (MIP2-1376 §6). */
  requestId: string
  /** The call's tool_use_id when the mod matched it from tool.check; best effort. */
  toolUseId: string | null
  agentId: string | null
  tool: string
  /** The tool input, for the card. */
  input: unknown
  /** Set for AskUserQuestion: the questions the app may answer. */
  questions: Question[] | null
  /** Whether the session offered something "remember" could keep. */
  canRemember: boolean
}

/** What the app answers. The mod never forwards it; it builds its own decision. */
export type PermissionAnswer =
  | { status: 'pending' }
  | { status: 'cancel' }
  | { status: 'answer'; verdict: 'allow' | 'deny'; remember?: boolean; answers?: Record<string, string> }

export interface PromptRelay {
  id: string
  text: string
}

/**
 * The prompt poll's other answer: the app has no report from this session
 * (it started after the session, or restarted) and asks for the whole file.
 */
export interface ReportWanted {
  want: 'report'
}

// Decisions. The mod builds the PermissionRequest decision from the app's
// answer and the session's own request; nothing else the app sends reaches
// Claude Code (MIP2-1376 §4, D-010).

/** Tools whose prompt a card may answer. Everything else opens the session (D-010). */
export const CARD_EXCLUDED_TOOLS = new Set(['ExitPlanMode'])

export const DENY_MESSAGE = 'Denied from CC Command Center.'

export interface SessionSuggestion {
  type: string
  destination?: string
  rules?: { toolName: string; ruleContent?: string }[]
  directories?: string[]
  behavior?: string
}

export type BuiltDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: SessionSuggestion[] }
  | { behavior: 'deny'; message: string }

/**
 * Questions a card may answer: every question single-choice with at least
 * one option (D-010). Null for any other input, which keeps the prompt in
 * the session.
 */
export function cardQuestions(input: unknown): Question[] | null {
  const qs = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(qs) || qs.length === 0) return null
  for (const q of qs) {
    if (typeof q !== 'object' || q === null) return null
    const { question, options, multiSelect } = q as Partial<Question>
    if (typeof question !== 'string' || multiSelect !== false || !Array.isArray(options) || options.length === 0) return null
    if (!options.every(o => typeof o === 'object' && o !== null && typeof o.label === 'string')) return null
  }
  return qs as Question[]
}

/** Every question answered, each with one of its own option labels. */
export function answersValid(questions: Question[], answers: unknown): answers is Record<string, string> {
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return false
  const given = answers as Record<string, unknown>
  if (Object.keys(given).length !== questions.length) return false
  return questions.every(q => {
    const value = given[q.question]
    return typeof value === 'string' && q.options.some(o => o.label === value)
  })
}

function touches(path: string, protectedDir: string): boolean {
  const p = path.replace(/\/+$/, '')
  const d = protectedDir.replace(/\/+$/, '')
  // A grant of the directory, anything in it, or any folder above it.
  return p === d || p.startsWith(`${d}/`) || d.startsWith(`${p}/`) || p === ''
}

/** Tools whose rules "remember" may keep: they read or fetch, and can't run a command that reads any file (gate L-4). */
const REMEMBER_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])

/** A path the mod can't resolve to the same place the session would: home-relative or with `..` (gate L-4). */
const unresolved = (p: string) => p.startsWith('~') || /(^|\/)\.\.(\/|$)/.test(p)

/** A rule's absolute path, from `//abs/**` content, without its glob tail. */
function rulePath(content: string): string {
  return content.replace(/^\/\//, '/').replace(/\/?\*.*$/, '')
}

/**
 * The session's own suggestions that "remember" may keep (MIP2-1376 §6;
 * tightened for gate L-4 before remember is wired): directories and allow
 * rules only, at `session` scope. A rule must name one of REMEMBER_TOOLS and
 * carry content; nothing written with `~` or `..`, and nothing that reaches
 * the channel directory, is kept.
 */
export function rememberable(suggestions: unknown, protectedDir: string): SessionSuggestion[] {
  if (!Array.isArray(suggestions)) return []
  const out: SessionSuggestion[] = []
  for (const s of suggestions as SessionSuggestion[]) {
    if (typeof s !== 'object' || s === null) continue
    if (s.type === 'addDirectories' && Array.isArray(s.directories)) {
      const dirs = s.directories.filter(d => typeof d === 'string' && d.startsWith('/') && !unresolved(d) && !touches(d, protectedDir))
      if (dirs.length) out.push({ type: 'addDirectories', directories: dirs, destination: 'session' })
    } else if (s.type === 'addRules' && Array.isArray(s.rules) && s.behavior === 'allow') {
      const rules = s.rules.filter(r => {
        if (typeof r?.toolName !== 'string' || !REMEMBER_TOOLS.has(r.toolName)) return false
        const content = r.ruleContent ?? ''
        if (!content || unresolved(content) || content.includes(protectedDir.replace(/\/+$/, ''))) return false
        // WebFetch and WebSearch rules name a domain or query, not a path.
        if (r.toolName === 'WebFetch' || r.toolName === 'WebSearch') return !content.includes('/')
        // A path rule must be `//`-absolute: a single `/` or no slash is relative to the session's folder
        // (permissions.md), which can be the home folder (gate run 2, L-4). It may not reach the channel directory.
        return content.startsWith('//') && !touches(rulePath(content), protectedDir)
      })
      if (rules.length) out.push({ type: 'addRules', rules, behavior: 'allow', destination: 'session' })
    }
  }
  return out
}

/**
 * The decision for an answered prompt, or null to leave the dialog: an
 * answer the request can't take (a question answer that doesn't match its
 * questions, an answer for a tool cards don't answer).
 */
export function buildDecision(
  ask: { tool: string; input: unknown; suggestions: unknown },
  answer: Extract<PermissionAnswer, { status: 'answer' }>,
  protectedDir: string,
): BuiltDecision | null {
  if (CARD_EXCLUDED_TOOLS.has(ask.tool)) return null
  if (answer.verdict === 'deny') return { behavior: 'deny', message: DENY_MESSAGE }
  if (answer.verdict !== 'allow') return null
  const decision: BuiltDecision = { behavior: 'allow' }
  if (ask.tool === 'AskUserQuestion') {
    const questions = cardQuestions(ask.input)
    if (!questions || !answersValid(questions, answer.answers)) return null
    decision.updatedInput = { questions, answers: { ...answer.answers } }
  }
  if (answer.remember === true) {
    const kept = rememberable(ask.suggestions, protectedDir)
    if (kept.length) decision.updatedPermissions = kept
  }
  return decision
}
