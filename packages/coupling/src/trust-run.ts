// The trust step (Research MIP2-1388; ruling on that issue: Alex answers
// Claude Code's real trust question himself, and the app never writes trust).
// After `claude --bg` refuses an untrusted folder, and only on Alex's click,
// the same command runs in a terminal view in that folder. Claude Code draws
// its own trust dialog there; Alex answers it with the keyboard. The app sends
// only what Alex types: no keystroke of its own, and no write to
// `~/.claude.json`. The new session's id is read from the output.

import { randomUUID } from 'node:crypto'
import type { LaunchOptions } from './session-host.ts'
import type { SpawnAttach, AttachProcess } from './attach-view.ts'
import { backgroundedId, resumedCopy, type PreparedLaunch, type SupervisorHost } from './supervisor-host.ts'

export interface TrustEvents {
  data(runId: string, data: string): void
  /** The run ended: with the new session's id, or null when no session started (No, Esc, a failure), and the folder it ran in. */
  done(runId: string, sessionId: string | null, error: string | null, cwd?: string, resumed?: string): void
}

/** Output kept per run to find the id; the view gets every byte as it comes. */
const KEEP_BYTES = 64 * 1024

interface Run {
  process: AttachProcess
  prepared: PreparedLaunch
  output: string
  /** The session a resume's trust run was for (MIP2-1461). */
  resume?: string
}

export class TrustRuns {
  private readonly runs = new Map<string, Run>()

  constructor(
    private readonly host: Pick<SupervisorHost, 'prepareLaunch' | 'completeLaunch' | 'abandonLaunch'> & Partial<Pick<SupervisorHost, 'sessionSwitch'>>,
    private readonly binary: string,
    private readonly events: TrustEvents,
    private readonly spawn: SpawnAttach,
  ) {}

  async start(opts: LaunchOptions, cols: number, rows: number): Promise<string> {
    const prepared = await this.host.prepareLaunch(opts)
    const runId = randomUUID()
    // A parked 0.24 session's trust run resumes it: the same command the move runs, in a terminal (MIP2-1461).
    const args = opts.resume ? ['--resume', opts.resume, ...prepared.args] : prepared.args
    // A session command: the reload switch rides on it once the supervisor is confirmed running (MIP2-1463).
    const session = (await this.host.sessionSwitch?.()) ?? false
    const process = this.spawn({ file: this.binary, args, cwd: prepared.cwd, ...(session ? { session } : {}) }, cols, rows)
    const run: Run = { process, prepared, output: '', ...(opts.resume ? { resume: opts.resume } : {}) }
    this.runs.set(runId, run)
    process.onData(d => {
      run.output = (run.output + d).slice(-KEEP_BYTES)
      this.events.data(runId, d)
    })
    process.onExit(() => void this.finish(runId))
    return runId
  }

  /** Alex's own keystrokes for the dialog. */
  write(runId: string, data: string): void {
    this.runs.get(runId)?.process.write(data)
  }

  resize(runId: string, cols: number, rows: number): void {
    this.runs.get(runId)?.process.resize(cols, rows)
  }

  /** Alex closed the view before answering: no session. */
  cancel(runId: string): void {
    this.runs.get(runId)?.process.kill('SIGTERM')
  }

  private async finish(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) return
    this.runs.delete(runId)
    const text = run.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // A resume is checked as a move is: a copy keeps its own id, and output that names no session starts none (MIP2-1453).
    const copy = run.resume ? resumedCopy(text, run.resume) : undefined
    const shortId = copy === undefined ? backgroundedId(text) : copy === null ? run.resume!.slice(0, 8) : copy === 'unknown' ? null : copy
    if (!shortId) {
      await this.host.abandonLaunch(run.prepared)
      return this.events.done(runId, null, null)
    }
    try {
      const { sessionId } = await this.host.completeLaunch(run.prepared, shortId)
      this.events.done(runId, sessionId, null, run.prepared.cwd, run.resume)
    } catch (err) {
      await this.host.abandonLaunch(run.prepared)
      this.events.done(runId, null, err instanceof Error ? err.message : String(err))
    }
  }
}
