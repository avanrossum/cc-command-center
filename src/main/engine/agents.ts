// Background agents — sessions Claude Code runs under its own daemon rather than in a
// terminal you own.
//
// These are invisible to the rest of this app. A session that has become a background
// agent still appears in the sidebar as an ordinary resumable row, and clicking resume
// fails with "that session is still running as a background agent" — after the click,
// with no warning before it. Worse, the agent forked at some point in the original
// conversation, so resuming the interactive side picks up from the fork rather than
// from where the work actually got to.
//
// Read through `claude agents --json`, which the CLI documents as "for scripting; does
// not require a TTY". That matters: this app already couples to several NON-public
// formats (transcripts, session registry files, terminal rendering) and each one is a
// standing risk. The daemon's own roster.json sits right there with pty sockets and
// auth tokens in it, and driving that would be a far deeper and more fragile coupling
// than a documented, scriptable command. Use the front door.
import { execFileSync } from 'node:child_process'

export interface AgentRow {
  /** Short id, present for background agents; this is what the agent view lists. */
  id?: string
  sessionId: string
  kind: 'background' | 'interactive'
  cwd: string
  name: string
  startedAt: number
  /** Background lifecycle: blocked | done | … . Absent for interactive. */
  state?: string
  /** Coarse activity: idle | … . May be absent on either kind. */
  status?: string
  pid?: number
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// Parse the command's stdout. Tolerant by design: an unrecognised field is ignored and
// an entry missing a session id is dropped, so a CLI that grows the shape cannot break
// the panel — it just shows what it understands.
export function parseAgents(raw: string): AgentRow[] {
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: AgentRow[] = []
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    const sessionId = str(o.sessionId)
    if (!sessionId) continue
    const kind = str(o.kind) === 'background' ? 'background' : 'interactive'
    out.push({
      id: str(o.id) || undefined,
      sessionId,
      kind,
      cwd: str(o.cwd),
      name: str(o.name) || sessionId.slice(0, 8),
      startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
      state: str(o.state) || undefined,
      status: str(o.status) || undefined,
      pid: typeof o.pid === 'number' ? o.pid : undefined,
    })
  }
  return out
}

/** Just the background ones — the sessions this app cannot otherwise see. */
export function backgroundAgents(rows: AgentRow[]): AgentRow[] {
  return rows
    .filter((r) => r.kind === 'background')
    .sort((a, b) => b.startedAt - a.startedAt)
}

// Run the command. Bounded and non-fatal: it spawns a process, so a hang must never
// wedge the scan, and a CLI too old to know the flag simply yields nothing.
export function listAgents(claudeBin: string): AgentRow[] {
  try {
    const raw = execFileSync(claudeBin, ['agents', '--json'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    })
    return parseAgents(raw)
  } catch {
    return []
  }
}
