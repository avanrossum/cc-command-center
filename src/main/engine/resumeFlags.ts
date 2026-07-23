// Per-session launch parameters, remembered so they survive a resume.
//
// `claude --resume <id>` does NOT carry forward the model/effort/permission-mode
// the session was created with — they have to be re-supplied on every resume, which
// is what this module exists to automate. (Verified against CLI 2.1.218: a session
// created at effort=high, resumed with --effort ultracode --permission-mode plan,
// records xhigh + plan + the ultracode reminder on the resumed turn.)
//
// Only these four STRUCTURED fields are stored — never the freeform Flags string a
// user can type in the composer. That string is shell-split and passed straight to
// spawn, so replaying it could re-inject -p / --continue / --session-id / a bare
// positional prompt and collide with --resume. Storing four validated fields and
// rebuilding the argv keeps the stored value non-injectable however it got written.

export interface ResumeFlags {
  model: string // bare model id or alias, no [1m] suffix
  context: string // '' | '1m'
  effort: string // '' | low | medium | high | xhigh | max | ultracode
  mode: string // '' | plan | acceptEdits | auto | dontAsk | manual
}

const MODEL_RE = /^[A-Za-z0-9._\-[\]]{0,64}$/
const EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
// bypassPermissions is deliberately NOT storable: a sticky row would silently
// relaunch that session with every permission check off, forever, unprompted.
const MODES = new Set(['', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'manual'])

export const EMPTY_RESUME_FLAGS: ResumeFlags = { model: '', context: '', effort: '', mode: '' }

// Coerce anything (JSON from the DB, an IPC payload) into a safe ResumeFlags.
// Unknown values degrade to '' rather than throwing — a bad field shouldn't cost
// the user the other three.
export function sanitizeResumeFlags(v: unknown): ResumeFlags {
  const o = (v ?? {}) as Record<string, unknown>
  const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '')
  const model = str(o.model)
  const context = str(o.context)
  const effort = str(o.effort)
  const mode = str(o.mode)
  return {
    model: MODEL_RE.test(model) ? model : '',
    context: context === '1m' ? '1m' : '',
    effort: EFFORTS.has(effort) ? effort : '',
    mode: MODES.has(mode) ? mode : '',
  }
}

export function parseResumeFlags(json: string | null | undefined): ResumeFlags | null {
  if (!json) return null
  try {
    return sanitizeResumeFlags(JSON.parse(json))
  } catch {
    return null
  }
}

export function isEmptyResumeFlags(f: ResumeFlags): boolean {
  return !f.model && !f.context && !f.effort && !f.mode
}

// Rebuild argv from stored fields. Appended AFTER --resume, so these win.
// The 1M context is a `[1m]` suffix on the model string, not its own flag, and it
// only means anything when there IS a model to suffix.
export function buildResumeArgs(f: ResumeFlags): string[] {
  const s = sanitizeResumeFlags(f)
  const out: string[] = []
  if (s.model) {
    const model = s.context === '1m' ? s.model.replace(/(\[1m\])+$/i, '') + '[1m]' : s.model
    out.push('--model', model)
  }
  if (s.effort) out.push('--effort', s.effort)
  if (s.mode) out.push('--permission-mode', s.mode)
  return out
}
