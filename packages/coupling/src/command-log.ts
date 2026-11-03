// A log of the `claude` lifecycle commands the app runs (MIP2-1446): each
// one's arguments, exit code and whole output, so what Claude Code said
// about a launch, resume or stop can be read afterwards. Claude Code 2.1.311
// prints a `note:` line when `--resume` starts a copy, and that line settles
// questions like MIP2-1434 and MIP2-1445.
//
// What's cut: the command lines carry the settings file's path, not the
// channel secret; a prompt after `--` is replaced by its length, and the
// exact prompt text is cut from the output if Claude Code echoes it; and
// anything shaped like a channel secret (64 hex characters) is cut. A
// prompt echoed in another form (wrapped, cut short, escaped) isn't
// recognized, so isn't cut (pass 8, L-1).

import { appendFile, chmod, rename, stat } from 'node:fs/promises'
import type { SpawnAttach } from './attach-view.ts'
import { ClaudeCommandError, type ClaudeRunner, type ClaudeSpawner } from './claude-cli.ts'

/** The most of each stream an entry keeps. */
export const COMMAND_LOG_STREAM_BYTES = 8 * 1024
/** Past this size the log is moved to `<path>.1`, replacing the previous one, and a new one started. */
export const COMMAND_LOG_MAX_BYTES = 1024 * 1024

/** The commands that change sessions; `agents --json` and `--version` run every poll and aren't logged. */
const LIFECYCLE = new Set(['--bg', '--resume', 'stop', 'respawn', 'rm', 'daemon'])

const SECRET_LIKE = /\b[0-9a-f]{64}\b/gi

/** How often unchanged summarized runs are counted in the log. */
const DAY_MS = 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000
/** The most changed-outcome summaries written in an hour; the rest are counted (gate pass 51, M-1). */
export const SUMMARY_CHANGES_PER_HOUR = 6

/** Stderr with what varies by run collapsed, so the same failure reads as one outcome: ids, hex, then digits. */
function collapse(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?:0x)?[0-9a-f]{6,}\b/gi, '<hex>')
    .replace(/\d+/g, '#')
}

export interface CommandEntry {
  at: string
  args: string[]
  cwd?: string
  code: number | null
  ms: number
  stdout: string
  stderr: string
  pid?: number
}

/** The arguments with a prompt after `--` replaced by its length. */
export function redactArgs(args: string[]): { args: string[]; prompt: string | null } {
  const i = args.indexOf('--')
  if (i < 0) return { args: [...args], prompt: null }
  const prompt = args.slice(i + 1).join(' ')
  return { args: [...args.slice(0, i + 1), `<prompt, ${prompt.length} characters>`], prompt: prompt || null }
}

function scrub(text: string, prompt: string | null): string {
  let out = prompt ? text.split(prompt).join('<prompt>') : text
  out = out.replace(SECRET_LIKE, '<secret-like>')
  const bytes = Buffer.from(out, 'utf8')
  return bytes.length <= COMMAND_LOG_STREAM_BYTES ? out : `${bytes.subarray(0, COMMAND_LOG_STREAM_BYTES).toString('utf8')}… (${bytes.length} bytes in all)`
}

export class CommandLog {
  private chain: Promise<void> = Promise.resolve()
  /** What each wrapper writes at close. */
  private readonly closers: (() => void)[] = []

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly maxBytes = COMMAND_LOG_MAX_BYTES,
  ) {}

  /** Appends one entry, after any still being written. A failure to write is logged to the console only. */
  write(entry: CommandEntry | Record<string, unknown>): Promise<void> {
    this.chain = this.chain.then(() => this.append(entry)).catch(err => console.warn(`command log: ${String(err)}`))
    return this.chain
  }

  /** Resolves once every entry written so far is on disk. */
  flushed(): Promise<void> {
    return this.chain
  }

  /** Something the app observed about Claude Code, such as a state it doesn't know (MIP2-1447). Strings are scrubbed and capped (pass 8, L-1). */
  note(kind: string, data: Record<string, unknown>): Promise<void> {
    const clean = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? scrub(v, null).slice(0, 500) : v]))
    return this.write({ at: new Date(this.now()).toISOString(), note: kind, ...clean })
  }

  private async append(entry: CommandEntry | Record<string, unknown>): Promise<void> {
    const st = await stat(this.path).catch(() => null)
    if (st && st.size > this.maxBytes) {
      await rename(this.path, `${this.path}.1`)
      await chmod(`${this.path}.1`, 0o600)
    }
    // 0600 always: a file left open to others is closed before anything more is added to it (pass 8, L-1).
    if (st && st.size <= this.maxBytes && (st.mode & 0o077) !== 0) await chmod(this.path, 0o600)
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }

  /**
   * The runner, logging each lifecycle command it runs, whether it succeeds
   * or fails, with both streams: on success too, since Claude Code prints a
   * resume's `note:` on stderr (MIP2-1453).
   */
  wrap(run: ClaudeRunner): ClaudeRunner {
    return this.logged(run, r => {
      // `daemon status` is a read, not a change; only `daemon run` is logged.
      if (!LIFECYCLE.has(r.args[0] ?? '') || (r.args[0] === 'daemon' && r.args[1] !== 'run')) return
      const { args, prompt } = redactArgs(r.args)
      void this.write({ at: new Date(r.started).toISOString(), args, ...(r.cwd ? { cwd: r.cwd } : {}), code: r.code, ms: r.ms, stdout: scrub(r.stdout, prompt), stderr: scrub(r.stderr, prompt) })
    })
  }

  /**
   * The runner, logging a summary of a command that runs every few minutes,
   * such as `-p /usage` (gate pass 20, I-5; pass 48, M-1; pass 50, M-1; pass
   * 51, M-1), only when its outcome changes, and at most SUMMARY_CHANGES_PER_HOUR
   * times an hour. The outcome compared is the exit code, what `describe`
   * reads from stdout, and stderr with its digits, hex and ids collapsed, so
   * failure text that varies by run reads as one outcome. Runs not written
   * are counted, and the count goes in one entry a day, and at close. A
   * summary has the arguments, folder, exit code, time, each stream's size,
   * the start of stderr scrubbed, and `describe`'s result, scrubbed, under
   * `result`.
   */
  wrapSummary(run: ClaudeRunner, describe: (stdout: string) => Record<string, unknown>): ClaudeRunner {
    let last: string | null = null
    let unchanged = 0
    let suppressed = 0
    let countedAt: number | null = null
    let lastShown: { args: string[]; cwd?: string; code: number | null } | null = null
    const changesAt: number[] = []
    const writeCount = (now: number) => {
      if (!lastShown || (!unchanged && !suppressed)) return
      void this.write({ at: new Date(now).toISOString(), note: 'unchanged-runs', ...lastShown, count: unchanged, ...(suppressed ? { suppressedChanges: suppressed } : {}), ...(countedAt !== null ? { since: new Date(countedAt).toISOString() } : {}) })
      unchanged = 0
      suppressed = 0
      countedAt = now
    }
    this.closers.push(() => writeCount(this.now()))
    return this.logged(run, r => {
      const { args, prompt } = redactArgs(r.args)
      // Its own try: a describe that throws is noted, scrubbed, not lost, and never fails the run (gate pass 50, L-4; 51).
      let result: Record<string, unknown>
      try {
        result = Object.fromEntries(Object.entries(describe(r.stdout)).map(([k, v]) => [k, typeof v === 'string' ? scrub(v, prompt).slice(0, 500) : v]))
      } catch (err) {
        result = { describeError: scrub(String(err), prompt).slice(0, 200) }
      }
      const stderr = r.stderr ? scrub(r.stderr, prompt).slice(0, 500) : ''
      const outcome = JSON.stringify([r.code, result, collapse(stderr)])
      const now = this.now()
      lastShown = { args, ...(r.cwd ? { cwd: r.cwd } : {}), code: r.code }
      countedAt ??= now
      while (changesAt.length && now - changesAt[0]! >= HOUR_MS) changesAt.shift()
      if (outcome === last || changesAt.length >= SUMMARY_CHANGES_PER_HOUR) {
        // Past the write cap, `last` stays the last outcome written, so the next one that differs from it is written in
        // full (gate pass 53, L-3).
        if (outcome === last) unchanged++
        else suppressed++
        if (now - countedAt >= DAY_MS) writeCount(now)
        return
      }
      last = outcome
      changesAt.push(now)
      void this.write({
        at: new Date(r.started).toISOString(),
        args,
        ...(r.cwd ? { cwd: r.cwd } : {}),
        code: r.code,
        ms: r.ms,
        stdoutBytes: Buffer.byteLength(r.stdout),
        stderrBytes: Buffer.byteLength(r.stderr),
        ...(stderr ? { stderr } : {}),
        ...(unchanged ? { unchangedBefore: unchanged } : {}),
        result,
      })
      unchanged = 0
    })
  }

  /** Writes what the wrappers still hold, such as a pending count of unchanged runs; for quitting (gate pass 51, L-5). */
  close(): Promise<void> {
    for (const close of this.closers.splice(0)) close()
    return this.flushed()
  }

  /**
   * The runner, handing each run, whether it succeeded or failed, to
   * `record`, after the command (gate pass 50, L-5; pass 51, L-2/L-3): a
   * recorder that throws is logged to the console, never fails the command
   * or records it twice.
   */
  private logged(run: ClaudeRunner, record: (r: { args: string[]; cwd?: string; started: number; ms: number; code: number | null; stdout: string; stderr: string }) => void): ClaudeRunner {
    const inner: NonNullable<ClaudeRunner['full']> = run.full ?? ((args, opts) => run(args, opts).then(stdout => ({ stdout, stderr: '' })))
    const safe = (r: Parameters<typeof record>[0]) => {
      try {
        record(r)
      } catch (err) {
        console.warn(`command log: ${String(err)}`)
      }
    }
    const full: NonNullable<ClaudeRunner['full']> = async (args, opts) => {
      const started = this.now()
      const base = { args, ...(opts?.cwd ? { cwd: opts.cwd } : {}), started }
      let out: Awaited<ReturnType<typeof inner>>
      try {
        out = await inner(args, opts)
      } catch (err) {
        const e = err instanceof ClaudeCommandError ? { code: err.code, stdout: err.stdout, stderr: err.stderr } : { code: null, stdout: '', stderr: String(err) }
        safe({ ...base, ms: this.now() - started, ...e })
        throw err
      }
      safe({ ...base, ms: this.now() - started, code: 0, stdout: out.stdout, stderr: out.stderr })
      return out
    }
    const wrapped: ClaudeRunner = (args, opts) => full(args, opts).then(r => r.stdout)
    wrapped.full = full
    return wrapped
  }

  /**
   * The trust step's terminal run: its command line when it starts, its exit
   * code when it ends, and what it says about the session (MIP2-1558):
   * whether the trust question showed, the `backgrounded` id and any
   * `note:` lines. Never the output itself, which the terminal view shows.
   */
  wrapTrust(spawn: SpawnAttach): SpawnAttach {
    return (cmd, cols, rows) => {
      const started = this.now()
      const args = redactArgs(cmd.args).args
      const p = spawn(cmd, cols, rows)
      let text = ''
      p.onData(d => void (text = (text + d).slice(-TRUST_KEEP)))
      p.onExit(({ exitCode }) =>
        void this.write({ at: new Date(started).toISOString(), args, ...(cmd.cwd ? { cwd: cmd.cwd } : {}), code: exitCode, ms: this.now() - started, terminal: true, outcome: trustOutcome(text) }),
      )
      return p
    }
  }

  /** The spawner, logging each start (the watchdog's `daemon run`) with its pid; its output isn't captured. */
  wrapSpawner(spawn: ClaudeSpawner): ClaudeSpawner {
    return args => {
      const pid = spawn(args)
      void this.write({ at: new Date(this.now()).toISOString(), args: redactArgs(args).args, code: null, ms: 0, stdout: '', stderr: '', ...(pid !== undefined ? { pid } : {}) })
      return pid
    }
  }
}

/** Output kept per trust run to read its outcome. */
const TRUST_KEEP = 64 * 1024

/**
 * What a trust run's output says, for the log (MIP2-1558): whether Claude
 * Code asked the trust question, the session it backgrounded, and its
 * `note:` lines. The screen itself isn't kept. Escape sequences are dropped
 * first; Claude Code draws with cursor moves, so words can run together.
 */
export function trustOutcome(output: string): { asked: boolean; backgrounded: string | null; notes: string[] } {
  const text = output.replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  const backgrounded = /backgrounded\s*·\s*([0-9a-f]{8})/.exec(text)?.[1] ?? null
  const notes = [...text.matchAll(/note:[^\r\n]{0,240}/g)].map(m => m[0].trim()).slice(0, 5)
  return { asked: /trust\s*this\s*folder/i.test(text), backgrounded, notes }
}
