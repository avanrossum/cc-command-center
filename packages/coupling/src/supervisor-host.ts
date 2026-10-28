// SessionHost on Claude Code's supervisor: `claude --bg` to launch,
// `agents --json` to read state, `attach` for Focus, and `stop`, `respawn`,
// `rm` and a bare `--resume` for the lifecycle (DECISION item 2).
//
// From Research's MIP2-1377 memo, on 2.1.311:
// - `--resume <id> --bg` with any flags starts a copy under a new id; with
//   none, it wakes the same session with its saved options (§1b). So resume
//   passes no flags.
// - `--plugin-dir` and `--settings` are saved with the session and come back
//   on respawn (§2), so the settings file stays on disk for its life.
// - `--bg` refuses an untrusted folder with "Workspace not trusted"
//   (MIP2-1388); launch reports that as its own error.

import { realpathSync } from 'node:fs'
import { parseAgentsJson, toSnapshot } from './agents-json.ts'
import { supervisorState } from './supervisor-env.ts'
import { ClaudeCommandError, type ClaudeRunner } from './claude-cli.ts'
import type { AttachCommand, LaunchOptions, ListResult, SessionHost } from './session-host.ts'

/** What the host needs from the channel hub. */
export interface HostChannels {
  prepareLaunch(opts: { isolation: 'none' | 'worktree'; ultracode?: boolean }): Promise<{ channelId: string; args: string[] }>
  bind(channelId: string, sessionId: string): void
  closeFor(sessionId: string): Promise<void>
  /** Closes a channel whose launch failed, so no check waits on a session that never started. */
  close(channelId: string): Promise<void>
}

export interface SupervisorHostOptions {
  run: ClaudeRunner
  /** The `claude` binary, for the attach command a terminal view runs. */
  binary?: string
  channels?: HostChannels
  now?: () => number
  /** How long launch waits for the new session to appear in `agents --json`. */
  appearTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  /**
   * New sessions a launch or resume couldn't account for and left alone,
   * because another operation overlapped it or its folder wasn't known
   * (pass 6, H-2). Main says so; nothing is removed.
   */
  onStrays?: (ids: string[]) => void
  /**
   * An entry with a status, state or wait the app doesn't know: its raw
   * values, once per session per change, for the command log (MIP2-1447).
   */
  onUnknown?: (raw: { sessionId: string; pid?: number; status?: string; state?: string; waitingFor?: string }) => void
  /**
   * Starts the supervisor the way the watchdog does: `claude daemon run`,
   * with the user's environment and none of the session switches (MIP2-1463).
   */
  startSupervisor?: () => void
  /** A session command ran without its switch, because the supervisor couldn't be confirmed running first (MIP2-1463). */
  onSwitchUnconfirmed?: () => void
}

/** One launch or resume while it runs: set when any other starts or ends meanwhile (pass 6, H-2). */
interface Operation {
  overlapped: boolean
}

/** A folder's real path, or the spelling given when it doesn't resolve (pass 6, L-4). */
function realFolder(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path.replace(/\/+$/, '') || '/'
  }
}

/**
 * `--bg` refused the folder because the workspace isn't trusted (Research
 * MIP2-1388). `variant` says what can be done:
 * - `trust`: an untrusted folder; Alex can answer Claude Code's own trust
 *   question in a terminal view (the trust step);
 * - `home`: the home folder, trusted one session at a time and never stored;
 * - `missing`: the folder doesn't resolve on disk.
 */
export class WorkspaceNotTrusted extends Error {
  constructor(
    readonly cwd: string,
    readonly variant: 'trust' | 'home' | 'missing',
    readonly claudeMessage: string,
  ) {
    super(claudeMessage || `Workspace not trusted: ${cwd}`)
    this.name = 'WorkspaceNotTrusted'
  }
}

/** Reads a `Workspace not trusted.` refusal from a command's output; null for any other failure. */
export function trustRefusal(text: string, cwd: string): WorkspaceNotTrusted | null {
  const line = text.split('\n').find(l => l.trim().startsWith('Workspace not trusted.'))?.trim()
  if (!line) return null
  if (/home directory is trusted one session at a time/i.test(line)) return new WorkspaceNotTrusted(cwd, 'home', line)
  if (/could not be resolved on disk/i.test(line)) return new WorkspaceNotTrusted(cwd, 'missing', line)
  return new WorkspaceNotTrusted(cwd, 'trust', line)
}

/** The short id `--bg` prints for a new session: `backgrounded · <id>`, or its attach hint. */
/** "started a copy as <id>", or "started a restricted copy as <id>" from a restricted shell (Research MIP2-1445). */
const COPY_AS = /started a (?:restricted )?copy as ([0-9a-f]{8})/

/**
 * Whether a bare `--resume <id> --bg` started a copy, and its short id, or
 * null when it woke the same session (MIP2-1453 part 1). Claude Code
 * 2.1.311 prints a `note:` line on stderr either way, and has eight copy
 * reasons, not all of whose wording is known (Research MIP2-1445). The same
 * session is only a backgrounded id that's the session's own, or a note
 * "woke session <its short id>", with no other note. Any other note, or
 * another session's id, is a copy. When neither stream gives an id, it's
 * "unknown", never the same session.
 */
export function resumedCopy(stdout: string, sessionId: string, stderr = ''): string | null {
  const text = `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const named = COPY_AS.exec(text)?.[1]
  if (named) return named
  const own = sessionId.slice(0, 8)
  const notes = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('note:'))
  const woke = notes.filter(n => n.startsWith(`note: woke session ${own}`))
  const shown = backgroundedId(stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
  if (shown && shown !== own) return shown
  if (notes.length > woke.length) return 'unknown'
  if (shown === own || woke.length > 0) return null
  return 'unknown'
}

export function backgroundedId(text: string): string | null {
  return /backgrounded\s*·\s*([0-9a-f]{8})/.exec(text)?.[1] ?? /claude attach ([0-9a-f]{8})/.exec(text)?.[1] ?? null
}

/** A launch prepared but not yet run: its arguments and the channel it carries. */
export interface PreparedLaunch {
  args: string[]
  cwd: string
  channelId: string | null
}

/** A resume that Claude Code turned into a copy under another id (MIP2-1377 §1b). */
export class ResumedAsCopy extends Error {
  constructor(readonly copyId: string) {
    super(`resumed as a copy, ${copyId}`)
    this.name = 'ResumedAsCopy'
  }
}

/**
 * A launch or resume started sessions besides the one expected (MIP2-1443).
 * Claude Code's output isn't trusted to say so: the MIP2-1441 live run's
 * resume of a running session started one and printed nothing the app
 * recognized. `removed` says whether the app stopped and removed them.
 */
export class StraySessions extends Error {
  constructor(
    readonly ids: string[],
    readonly removed: boolean,
  ) {
    super(
      `Claude Code started ${ids.length === 1 ? 'another session' : `${ids.length} other sessions`} (${ids.map(i => i.slice(0, 8)).join(', ')}) besides the one expected; ${removed ? 'the app stopped and removed it' : 'another launch in that folder was under way, so the app left it for you to check'}.`,
    )
    this.name = 'StraySessions'
  }
}

/** How long after the app changes a session its transitional states are forgiven (MIP2-1447). */
const CHANGING_MS = 10_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHORT_ID = /^[0-9a-f]{8}$/

export class SupervisorHost implements SessionHost {
  private readonly run: ClaudeRunner
  private readonly binary: string
  private readonly channels: HostChannels | null
  private readonly now: () => number
  private readonly appearTimeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  /** sessionId → short id, from the last list. */
  private readonly shortIds = new Map<string, string>()
  /** sessionId → working folder, from the last list. */
  private readonly cwds = new Map<string, string>()
  /** When the app last started or finished changing each session: a stop, respawn, resume or copy (MIP2-1447). */
  private readonly touched = new Map<string, number>()
  /** Launches and resumes under way (pass 6, H-2). */
  private readonly inFlight = new Set<Operation>()
  /** Every session a launch, copy, move or resume returned: never a stray (pass 6, H-2). */
  private readonly accounted = new Set<string>()
  private readonly onStrays: (ids: string[]) => void
  private readonly onUnknown: NonNullable<SupervisorHostOptions['onUnknown']>
  private readonly startSupervisor: (() => void) | null
  private ensuring: Promise<boolean> | null = null
  private readonly onSwitchUnconfirmed: () => void
  /** The last unknown shape reported per session, so a poll every 2 s doesn't repeat it. */
  private readonly unknownSeen = new Map<string, string>()

  constructor(opts: SupervisorHostOptions) {
    this.run = opts.run
    this.binary = opts.binary ?? 'claude'
    this.channels = opts.channels ?? null
    this.now = opts.now ?? Date.now
    this.appearTimeoutMs = opts.appearTimeoutMs ?? 15_000
    this.onStrays = opts.onStrays ?? (() => {})
    this.onUnknown = opts.onUnknown ?? (() => {})
    this.startSupervisor = opts.startSupervisor ?? null
    this.onSwitchUnconfirmed = opts.onSwitchUnconfirmed ?? (() => {})
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  }

  async list(): Promise<ListResult> {
    // `--all` keeps background sessions whose process has exited, which the
    // docs name as the way to poll ("Read session state from a script").
    const stdout = await this.run(['agents', '--json', '--all'])
    const observedAt = this.now()
    const { entries, rejected } = parseAgentsJson(stdout)
    for (const e of entries) {
      if (e.id && e.sessionId) this.shortIds.set(e.sessionId, e.id)
      if (e.sessionId && e.cwd.startsWith('/')) this.cwds.set(e.sessionId, e.cwd)
    }
    const sessions = entries.map(e => toSnapshot(e, observedAt))
    // A session gone from the list can't be a stray again; its id needn't be kept (pass 7, L-1).
    const listed = new Set(sessions.map(x => x.sessionId))
    for (const id of this.accounted) if (!listed.has(id)) this.accounted.delete(id)
    sessions.forEach((s, i) => {
      const e = entries[i]!
      const odd = s.activity.value === 'unknown' || s.needsYou.value?.kind === 'other'
      const key = odd ? JSON.stringify([e.pid !== undefined, e.status, e.state, e.waitingFor]) : null
      if (key === null) return void this.unknownSeen.delete(s.sessionId)
      if (this.unknownSeen.get(s.sessionId) === key) return
      this.unknownSeen.set(s.sessionId, key)
      this.onUnknown({ sessionId: s.sessionId, ...(e.pid !== undefined ? { pid: e.pid } : {}), ...(e.status !== undefined ? { status: e.status } : {}), ...(e.state !== undefined ? { state: e.state } : {}), ...(e.waitingFor !== undefined ? { waitingFor: e.waitingFor } : {}) })
    })
    return { sessions, rejected }
  }

  /** The `claude --bg` arguments for a launch, with a new channel. Shared with the trust step's terminal run. */
  async prepareLaunch(opts: LaunchOptions): Promise<PreparedLaunch> {
    if (!opts.cwd.startsWith('/')) throw new Error('launch needs an absolute folder')
    const channel = await this.channels?.prepareLaunch({ isolation: opts.isolation ?? 'none', ultracode: opts.ultracode === true })
    const args = ['--bg']
    if (opts.name) args.push('--name', opts.name)
    if (opts.model) args.push('--model', opts.model)
    if (opts.effort) args.push('--effort', opts.effort)
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)
    if (channel) args.push(...channel.args)
    // Alex's extra flags come after the app's own (MIP2-1387 §2.1).
    if (opts.extraArgs?.length) args.push(...opts.extraArgs)
    // `--` ends the options, so a prompt that starts with "-" stays a prompt.
    if (opts.prompt) args.push('--', opts.prompt)
    return { args, cwd: opts.cwd, channelId: channel?.channelId ?? null }
  }

  /** Finishes a launch from the printed short id: the full session id, and the channel bound to it. */
  async completeLaunch(prepared: PreparedLaunch, shortId: string): Promise<{ sessionId: string }> {
    const sessionId = await this.sessionIdOf(shortId)
    if (prepared.channelId) this.channels?.bind(prepared.channelId, sessionId)
    return { sessionId }
  }

  /** Discards a prepared launch that didn't start a session. */
  async abandonLaunch(prepared: PreparedLaunch): Promise<void> {
    if (prepared.channelId) await this.channels?.close(prepared.channelId).catch(() => {})
  }

  async launch(opts: LaunchOptions): Promise<{ sessionId: string }> {
    return this.watchingStrays(opts.cwd, r => [r.sessionId], () => this.launchNow(opts))
  }

  private async launchNow(opts: LaunchOptions): Promise<{ sessionId: string }> {
    const prepared = await this.prepareLaunch(opts)
    try {
      let stdout: string
      try {
        stdout = await this.run(prepared.args, { cwd: prepared.cwd, timeoutMs: 30_000, session: await this.sessionSwitch() })
      } catch (err) {
        // Match the message, not only the exit code: code 1 is observed, not documented (MIP2-1388).
        const text = err instanceof ClaudeCommandError ? `${err.stdout}\n${err.stderr}` : String(err)
        throw trustRefusal(text, opts.cwd) ?? err
      }
      const shortId = backgroundedId(stdout)
      if (!shortId) throw new Error(`claude --bg printed no session id: ${stdout.trim().split('\n')[0] ?? ''}`)
      return await this.completeLaunch(prepared, shortId)
    } catch (err) {
      // A refused or failed launch has no session behind its channel.
      await this.abandonLaunch(prepared)
      throw err
    }
  }

  /** A bare `claude --resume <id> --bg`: the same session, with its saved options. */
  async resume(sessionId: string): Promise<void> {
    if (!UUID.test(sessionId)) throw new Error('not a session id')
    const cwd = await this.cwdOf(sessionId)
    await this.changingWhile(sessionId, () => this.watchingStrays(cwd, () => [sessionId], () => this.resumeNow(sessionId, cwd)))
  }

  private async resumeNow(sessionId: string, cwd: string | undefined): Promise<void> {
    // From the session's own folder: a restart from elsewhere can be refused as untrusted (MIP2-1388).
    const args = ['--resume', sessionId, '--bg']
    const opts = { timeoutMs: 30_000, cwd, session: await this.sessionSwitch() }
    // Both streams: the `note:` line is on stderr (MIP2-1453).
    const { stdout, stderr } = this.run.full ? await this.run.full(args, opts) : { stdout: await this.run(args, opts), stderr: '' }
    const copy = resumedCopy(stdout, sessionId, stderr)
    if (copy) throw new ResumedAsCopy(copy)
    // The command returns before the supervisor has the process up. An attach
    // started now finds the session stopped and exits at once (MIP2-1415).
    await this.runningOf(sessionId)
  }

  /**
   * Starts a copy of a session's conversation with new launch settings
   * (spec MIP2-1387 §2.3). Flags on `--resume <id> --bg` make Claude Code
   * start a copy under a new id and leave the original as it was
   * (MIP2-1377 1b). The copy gets its own channel, so the app hosts it like
   * any launch.
   */
  async startCopy(sessionId: string, opts: Omit<LaunchOptions, 'cwd' | 'prompt'>): Promise<{ sessionId: string }> {
    if (!UUID.test(sessionId)) throw new Error('not a session id')
    const cwd = await this.cwdOf(sessionId)
    if (!cwd) throw new Error('no folder known for the session')
    return this.watchingStrays(cwd, r => [r.sessionId], () => this.startCopyNow(sessionId, cwd, opts))
  }

  private async startCopyNow(sessionId: string, cwd: string, opts: Omit<LaunchOptions, 'cwd' | 'prompt'>): Promise<{ sessionId: string }> {
    const prepared = await this.prepareLaunch({ ...opts, cwd })
    try {
      const stdout = await this.run(['--resume', sessionId, ...prepared.args], { cwd, timeoutMs: 30_000, session: await this.sessionSwitch() })
      const shortId = COPY_AS.exec(stdout)?.[1] ?? backgroundedId(stdout)
      if (!shortId) throw new Error(`claude --resume printed no copy id: ${stdout.trim().split('\n')[0] ?? ''}`)
      return await this.completeLaunch(prepared, shortId)
    } catch (err) {
      await this.abandonLaunch(prepared)
      throw err
    }
  }

  /**
   * Moves a session Electron CCCC hosted into the app (MIP2-1425; DECISION
   * item 11; spec MIP2-1379 §6). Its interactive process must have exited:
   * the app never ends one itself. `claude --resume <id> --bg` with the
   * app's flags then resumes it in place, under the same sessionId, as a
   * background session with the reporter mod (Research MIP2-1377 §5).
   * A different id is reported, not hidden: the original conversation stays
   * on disk either way.
   */
  async moveIn(sessionId: string, opts: Omit<LaunchOptions, 'prompt' | 'extraArgs' | 'ultracode'>): Promise<{ sessionId: string; sameId: boolean }> {
    if (!UUID.test(sessionId)) throw new Error('not a session id')
    return this.watchingStrays(this.cwds.get(sessionId) ?? opts.cwd, r => [r.sessionId], () => this.moveInNow(sessionId, opts))
  }

  private async moveInNow(sessionId: string, opts: Omit<LaunchOptions, 'prompt' | 'extraArgs' | 'ultracode'>): Promise<{ sessionId: string; sameId: boolean }> {
    const { sessions } = await this.list()
    const listed = sessions.find(s => s.sessionId === sessionId)
    if (listed && listed.pid.value !== null) {
      throw new Error(listed.kind.value === 'background' ? 'it already runs in the background' : 'it is still open in CC Command Center 0.24; close it there first')
    }
    const prepared = await this.prepareLaunch({ ...opts, cwd: this.cwds.get(sessionId) ?? opts.cwd })
    try {
      let out: { stdout: string; stderr: string }
      try {
        const args = ['--resume', sessionId, ...prepared.args]
        const opts = { cwd: prepared.cwd, timeoutMs: 30_000, session: await this.sessionSwitch() }
        // Both streams: the `note:` line is on stderr (MIP2-1453).
        out = this.run.full ? await this.run.full(args, opts) : { stdout: await this.run(args, opts), stderr: '' }
      } catch (err) {
        const text = err instanceof ClaudeCommandError ? `${err.stdout}\n${err.stderr}` : String(err)
        throw trustRefusal(text, prepared.cwd) ?? err
      }
      // A copy, or output that doesn't say which session it is, is never taken for the same session (MIP2-1453, MIP2-1461).
      const copy = resumedCopy(out.stdout, sessionId, out.stderr)
      const shortId = copy === null ? sessionId.slice(0, 8) : copy === 'unknown' ? null : copy
      if (!shortId) throw new ResumedAsCopy('unknown')
      const done = await this.completeLaunch(prepared, shortId)
      return { sessionId: done.sessionId, sameId: done.sessionId === sessionId }
    } catch (err) {
      await this.abandonLaunch(prepared)
      throw err
    }
  }

  /**
   * Runs in the session's own folder. If the attach falls through to agent
   * view, Claude Code asks to trust the attach process's folder; the
   * session's folder is already trusted, and `/` must never be offered.
   */
  async attach(sessionId: string): Promise<AttachCommand> {
    const shortId = await this.shortIdOf(sessionId)
    const cwd = this.cwds.get(sessionId)
    if (!cwd) throw new Error('no folder known for the session')
    return { file: this.binary, args: ['attach', shortId], cwd }
  }

  /**
   * Runs a launch or resume, then compares the session list with the one
   * before (MIP2-1443). A new session in the same folder that no operation
   * returned is a stray. It's stopped and removed, and the operation fails
   * with StraySessions, whatever Claude Code printed, only when it can be
   * pinned on this operation: the folder is known and no other launch or
   * resume started or ended while this one ran. Otherwise it's reported and
   * left, and the operation's own result stands (pass 6, H-2). Folders are
   * compared by real path (pass 6, L-4).
   */
  private async watchingStrays<T>(cwd: string | undefined, expected: (r: T) => string[], op: () => Promise<T>): Promise<T> {
    const me: Operation = { overlapped: this.inFlight.size > 0 }
    for (const other of this.inFlight) other.overlapped = true
    this.inFlight.add(me)
    try {
      const before = new Set((await this.list()).sessions.map(s => s.sessionId))
      const result = await op()
      for (const id of expected(result)) this.accounted.add(id)
      const folder = cwd === undefined ? undefined : realFolder(cwd)
      const strays = (await this.list()).sessions
        .filter(s => !before.has(s.sessionId) && !this.accounted.has(s.sessionId))
        .filter(s => folder === undefined || realFolder(s.cwd.value) === folder)
        .map(s => s.sessionId)
      if (!strays.length) return result
      if (folder === undefined || me.overlapped) {
        this.onStrays(strays)
        return result
      }
      for (const id of strays) {
        await this.stop(id).catch(() => {})
        await this.rm(id).catch(() => {})
      }
      throw new StraySessions(strays, true)
    } finally {
      this.inFlight.delete(me)
      for (const other of this.inFlight) other.overlapped = true
    }
  }

  /**
   * Whether the supervisor is running, starting it the watchdog's way if it
   * isn't and waiting up to the appear timeout (MIP2-1463). A session
   * command run while no supervisor runs would start one itself, with the
   * command's environment, switches included.
   */
  ensureSupervisor(): Promise<boolean> {
    // Commands at the same moment share one check and one start (pass 9, L-5).
    this.ensuring ??= this.ensureOnce().finally(() => (this.ensuring = null))
    return this.ensuring
  }

  private async ensureOnce(): Promise<boolean> {
    const state = await supervisorState(this.run)
    if (state === 'up') return true
    // Only Claude Code saying it isn't running counts; a failed or timed-out check starts nothing (pass 9, L-5).
    if (state === 'unknown' || !this.startSupervisor) return false
    this.startSupervisor()
    const deadline = this.now() + this.appearTimeoutMs
    while (this.now() < deadline) {
      await this.sleep(250)
      if ((await supervisorState(this.run)) === 'up') return true
    }
    return false
  }

  /**
   * Whether a session command may carry SESSION_SWITCHES: only once the
   * supervisor is confirmed running, so they reach the session and never
   * the supervisor. Otherwise the session's --settings `env` alone carries
   * the reload switch, and main is told (MIP2-1463).
   */
  async sessionSwitch(): Promise<boolean> {
    const ok = await this.ensureSupervisor()
    if (!ok) this.onSwitchUnconfirmed()
    return ok
  }

  async stop(sessionId: string): Promise<void> {
    await this.changingWhile(sessionId, async () => void (await this.run(['stop', await this.shortIdOf(sessionId)])))
  }

  /** Sessions changed by the app now or within the last 10 s; the self-check doesn't fail on what they print meanwhile (MIP2-1447). */
  changing(): ReadonlySet<string> {
    const now = this.now()
    for (const [id, at] of this.touched) if (at !== Infinity && now - at > CHANGING_MS) this.touched.delete(id)
    return new Set(this.touched.keys())
  }

  private async changingWhile<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    this.touched.set(sessionId, Infinity)
    try {
      return await fn()
    } finally {
      this.touched.set(sessionId, this.now())
    }
  }

  /**
   * Stops the session if it has a process, and returns once `agents --json`
   * shows none; false when it had none. A resume re-keys its channel, and
   * `claude --resume <id> --bg` doesn't restart a running session: it leaves
   * the process on the old secret and starts another session beside it
   * (MIP2-1441 live run). So the app stops it first.
   */
  async stopIfRunning(sessionId: string): Promise<boolean> {
    const running = async () => (await this.list()).sessions.find(s => s.sessionId === sessionId)?.pid.value != null
    if (!(await running())) return false
    await this.stop(sessionId)
    const deadline = this.now() + this.appearTimeoutMs
    while (await running()) {
      if (this.now() >= deadline) throw new Error(`session ${sessionId.slice(0, 8)} didn't stop within ${Math.round(this.appearTimeoutMs / 1000)} s`)
      await this.sleep(250)
    }
    return true
  }

  async respawn(sessionId: string): Promise<void> {
    await this.changingWhile(sessionId, async () => void (await this.run(['respawn', await this.shortIdOf(sessionId)], { timeoutMs: 30_000, cwd: await this.cwdOf(sessionId), session: await this.sessionSwitch() })))
  }

  /** The session's folder, when listed; undefined leaves the app's own. */
  private async cwdOf(sessionId: string): Promise<string | undefined> {
    if (!this.cwds.has(sessionId)) await this.list().catch(() => undefined)
    return this.cwds.get(sessionId)
  }

  /** Removes the session from Claude Code's list and closes its channel. */
  async rm(sessionId: string): Promise<void> {
    await this.run(['rm', await this.shortIdOf(sessionId)])
    await this.channels?.closeFor(sessionId)
  }

  private async shortIdOf(sessionId: string): Promise<string> {
    if (!UUID.test(sessionId)) throw new Error('not a session id')
    let id = this.shortIds.get(sessionId)
    if (!id) {
      await this.list()
      id = this.shortIds.get(sessionId)
    }
    // A background session's short id is the start of its UUID; fall back to that.
    id ??= sessionId.slice(0, 8)
    if (!SHORT_ID.test(id)) throw new Error('no short id for the session')
    return id
  }

  /** Waits until `agents --json` lists the session with a process. */
  private async runningOf(sessionId: string): Promise<void> {
    const deadline = this.now() + this.appearTimeoutMs
    for (;;) {
      const { sessions } = await this.list()
      if (sessions.find(s => s.sessionId === sessionId)?.pid.value != null) return
      if (this.now() >= deadline) throw new Error(`session ${sessionId.slice(0, 8)} didn't come back within ${Math.round(this.appearTimeoutMs / 1000)} s`)
      await this.sleep(250)
    }
  }

  /** The new session's full id, once `agents --json` lists it. */
  private async sessionIdOf(shortId: string): Promise<string> {
    const deadline = this.now() + this.appearTimeoutMs
    for (;;) {
      await this.list()
      for (const [sessionId, id] of this.shortIds) if (id === shortId) return sessionId
      if (this.now() >= deadline) throw new Error(`session ${shortId} didn't appear in claude agents`)
      await this.sleep(500)
    }
  }
}
