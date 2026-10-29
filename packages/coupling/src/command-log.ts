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
    const inner: NonNullable<ClaudeRunner['full']> = run.full ?? ((args, opts) => run(args, opts).then(stdout => ({ stdout, stderr: '' })))
    const full: NonNullable<ClaudeRunner['full']> = async (args, opts) => {
      // `daemon status` is a read, not a change; only `daemon run` is logged.
      if (!LIFECYCLE.has(args[0] ?? '') || (args[0] === 'daemon' && args[1] !== 'run')) return inner(args, opts)
      const started = this.now()
      const { args: shown, prompt } = redactArgs(args)
      const entry = (code: number | null, stdout: string, stderr: string): CommandEntry => ({
        at: new Date(started).toISOString(),
        args: shown,
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        code,
        ms: this.now() - started,
        stdout: scrub(stdout, prompt),
        stderr: scrub(stderr, prompt),
      })
      try {
        const out = await inner(args, opts)
        void this.write(entry(0, out.stdout, out.stderr))
        return out
      } catch (err) {
        void this.write(err instanceof ClaudeCommandError ? entry(err.code, err.stdout, err.stderr) : entry(null, '', String(err)))
        throw err
      }
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
