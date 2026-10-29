// Keeps Claude Code's supervisor running while the app hosts sessions
// (DECISION item 2). Research MIP2-1377 §3, on 2.1.311:
// - `claude daemon status` exits 1 when no supervisor runs (documented);
// - `claude daemon run` started a supervisor in 1–2 s that reattached kept
//   sessions, same pid, after a graceful stop and after `kill -9` (documented
//   command, observed reattach);
// - `claude daemon restart` is disabled;
// - without a supervisor, sessions exit about 47–62 s later;
// - `claude respawn <id>` starts a supervisor too, but restarts that session
//   and loses any pending permission wait (observed, undocumented).
//
// So: poll the status; when it's down and the app hosts live background
// sessions, start `claude daemon run` detached. Only if that hasn't brought
// a supervisor back in time, respawn hosted sessions one by one, never one
// that is waiting on Alex.

import type { SessionSnapshot } from '@ccc/contract'
import type { ClaudeExitCode, ClaudeSpawner } from './claude-cli.ts'

export interface WatchdogOptions {
  exitCode: ClaudeExitCode
  spawn: ClaudeSpawner
  /** Respawns one session. */
  respawn: (shortId: string) => Promise<void>
  /** The sessions the app knows now. */
  sessions: () => SessionSnapshot[]
  now?: () => number
  log?: (line: string) => void
  intervalMs?: number
  /** Don't start another `daemon run` sooner than this after the last. */
  startGapMs?: number
  /** Respawn as a last resort once the supervisor has been down this long. Sessions die at about 47 s. */
  respawnAfterMs?: number
  /** Sessions never to respawn: their channel isn't trusted, so they'd wake on a secret an impostor holds. */
  skip?: (sessionId: string) => boolean
}

export type WatchdogState =
  | { kind: 'up' }
  | { kind: 'idle' }
  | { kind: 'restarting'; downSince: number; attempts: number }
  | { kind: 'unknown'; detail: string }

/** Live background sessions: the ones that die with the supervisor. */
export function hostedSessions(sessions: SessionSnapshot[]): SessionSnapshot[] {
  return sessions.filter(s => s.kind.value === 'background' && s.pid.value !== null && !s.pid.stale)
}

export class SupervisorWatchdog {
  private readonly o: Required<Omit<WatchdogOptions, 'log'>> & { log: (line: string) => void }
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastStartAt = Number.NEGATIVE_INFINITY
  private downSince: number | null = null
  private attempts = 0
  private readonly respawned = new Set<string>()
  /** When the supervisor came back after this watchdog started it, for the settings window. */
  private readonly restarts: number[] = []
  state: WatchdogState = { kind: 'idle' }

  constructor(opts: WatchdogOptions) {
    this.o = {
      now: Date.now,
      log: line => console.warn(line),
      intervalMs: 5_000,
      startGapMs: 10_000,
      respawnAfterMs: 30_000,
      skip: () => false,
      ...opts,
    }
  }

  start(): void {
    if (this.timer) return
    const loop = async () => {
      await this.tick().catch(err => this.o.log(`watchdog: ${err instanceof Error ? err.message : String(err)}`))
      if (this.timer) this.timer = setTimeout(loop, this.o.intervalMs)
    }
    this.timer = setTimeout(loop, 0)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Restarts that brought the supervisor back since `t` (Unix milliseconds). */
  restartsSince(t: number): number {
    return this.restarts.filter(at => at >= t).length
  }

  async tick(): Promise<WatchdogState> {
    const code = await this.o.exitCode(['daemon', 'status'])
    const now = this.o.now()
    if (code === 0) {
      if (this.downSince !== null) this.o.log(`watchdog: supervisor back after ${Math.round((now - this.downSince) / 1000)} s`)
      if (this.downSince !== null && this.attempts > 0) this.restarts.push(now)
      this.downSince = null
      this.attempts = 0
      this.respawned.clear()
      return (this.state = { kind: 'up' })
    }
    if (code !== 1) return (this.state = { kind: 'unknown', detail: `daemon status exited ${code}` })

    // Down. Nothing to rescue: a supervisor starts on demand with the next launch.
    const hosted = hostedSessions(this.o.sessions())
    if (hosted.length === 0) {
      this.downSince = null
      return (this.state = { kind: 'idle' })
    }

    this.downSince ??= now
    if (now - this.lastStartAt >= this.o.startGapMs) {
      this.lastStartAt = now
      this.attempts += 1
      const pid = this.o.spawn(['daemon', 'run'])
      this.o.log(`watchdog: supervisor down with ${hosted.length} hosted sessions; started daemon run (pid ${pid ?? '?'})`)
    }

    // Last resort, before the sessions' own one-minute limit.
    if (now - this.downSince >= this.o.respawnAfterMs) {
      for (const s of hosted) {
        const id = s.shortId.value
        if (!id || this.respawned.has(id)) continue
        // A session whose channel isn't trusted isn't brought back on its old secret (gate run 3, M-1).
        if (this.o.skip(s.sessionId)) continue
        // A respawn ends the process and a pending permission wait with it (MIP2-1377 §4a).
        if (s.needsYou.value !== null || s.activity.value === 'waiting') continue
        this.respawned.add(id)
        this.o.log(`watchdog: respawning ${id}`)
        // By session id: respawn and its check take the full id, not the short one (MIP2-1507 QA note).
        await this.o.respawn(s.sessionId).catch(err => this.o.log(`watchdog: respawn ${id} failed: ${err instanceof Error ? err.message : String(err)}`))
      }
    }
    return (this.state = { kind: 'restarting', downSince: this.downSince, attempts: this.attempts })
  }
}
