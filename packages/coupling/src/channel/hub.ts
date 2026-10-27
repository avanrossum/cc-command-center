// Every session's channel, held by the app (D-011 item 7, MIP2-1390).
//
// For each launch the hub makes a new channel: a 0700 folder under
// `~/.ccc/ch/`, a new 32-byte secret, the session's 0600 --settings file
// carrying the secret in `pluginConfigs` and `//`-absolute deny rules on the
// whole channel root, and the server on the folder's socket. The secret goes
// to the session only through that file: never the environment, never a
// command line (D-017).

import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { CardQuestion, PendingRequest } from '@ccc/contract'
import {
  LONG_POLL_MS,
  SECRET_HEX,
  answersValid,
  type AnswerPost,
  type PermissionAnswer,
  type PermissionAsk,
  type PromptRelay,
  type ReportWanted,
} from '../../../../mod/hooks/channel-wire.ts'
import { REPORTER_NAME, type ReporterFile } from '../../../../mod/hooks/wire.ts'
import type { ReporterRead } from '../reporter.ts'
import { newSecret } from './crypto.ts'
import { cardInput, summarize } from './messages.ts'
import { PeerResolver } from './peer.ts'
import type { ChannelHealth } from '../self-check.ts'
import { ChannelServer } from './server.ts'

/** Short, so the socket path stays under the ~100-byte limit (MIP2-1376 §1). */
export const DEFAULT_CHANNEL_ROOT = join(homedir(), '.ccc', 'ch')
const SOCKET_PATH_LIMIT = 100
const SETTINGS_FILE = 'settings.json'
const SOCKET_FILE = 's.sock'
const PLUGIN_KEY = `${REPORTER_NAME}@inline`

export interface ChannelLaunch {
  channelId: string
  settingsPath: string
  /** Arguments for `claude --bg`: the mod and the settings file, by path only. */
  args: string[]
}

export type AnswerInput =
  | { verdict: 'allow'; remember?: boolean; answers?: Record<string, string> }
  | { verdict: 'deny' }

export interface PromptStatus {
  id: string
  state: 'queued' | 'delivered' | 'submitted'
  at: number
}

interface Pending {
  ask: PermissionAsk
  askedAt: number
  /** The mod's last poll for it. A mod that stops polling (its process respawned) left it orphaned. */
  polledAt: number
  answer: PermissionAnswer | null
  deliver: ((a: PermissionAnswer) => void) | null
}

interface Prompt {
  id: string
  text: string
  state: PromptStatus['state']
  at: number
}

class SessionChannel {
  sessionId: string | null = null
  file: ReporterFile | null = null
  receivedAt = 0
  /** The last verified request of any kind. */
  contactAt = 0
  readonly pending = new Map<string, Pending>()
  readonly prompts: Prompt[] = []
  promptWaiter: (() => void) | null = null
  server: ChannelServer | null = null
  /** requestIds the mod has offered over this channel's life. */
  offered = 0
  /** The main loop's last final text (mod 0.6.0); kept in memory only. */
  answer: AnswerPost | null = null
  /** Why the channel can't be trusted any more (its socket was replaced); null while it can (gate M-1). */
  untrusted: string | null = null
  /**
   * A mark carried over a re-key until the resume finishes (pass 6, M-1).
   * The channel takes no card answers or relayed prompts while it's set,
   * but its watchers and checks keep running, unlike `untrusted`.
   */
  pendingClear: string | null = null
  /** Watches the channel's folder for its socket being moved or replaced (gate run 2, M-1). */
  watcher: FSWatcher | null = null
  /** When the watch began: events from the server's own bind just before it are ignored. */
  watchedAt = 0
  /** Connections waiting on a peer check now (gate run 2, L-5). */
  peerChecks = 0
  /**
   * The settings file as the app wrote or checked it: its SHA-256 and its
   * inode, size, mtime and ctime. Any difference marks the channel untrusted
   * (pass 4, H-1). A write restored to the same bytes still changes ctime
   * (pass 5, M-2).
   */
  settingsSeen: SettingsSeen | null = null
  readonly createdAt: number

  constructor(
    readonly id: string,
    readonly dir: string,
    readonly secret: string,
    now: number,
    /** Made for a launch in this run of the app, so its mod must make contact. */
    readonly launched: boolean,
  ) {
    this.createdAt = now
  }
}

/** An offer the mod hasn't polled for this long is orphaned: the long poll is 25 s. */
const ORPHANED_AFTER_MS = 40_000
/** Where the channel folder records the session it serves, once bound. */
const SESSION_FILE = 'session'
/**
 * The version of what settingsFor() writes (MIP2-1444; pass 6, M-2). 1: the
 * channel root and the mod folders denied. 2: the app's data folder too
 * (pass 5, M-3). 3: `env` turns off mod reload for the session
 * (MIP2-1457). Each channel's version is kept in the app's store,
 * which sessions are denied, not in the channel's folder, which the actor
 * a check guards against can write (pass 7, M-1).
 */
export const SETTINGS_VERSION = 3
/** The version a channel with no stored version is checked against: what 1d3208c, the last build before the store kept versions, wrote (pass 8, M-1). */
const LAST_UNRECORDED_VERSION = 2

/**
 * The session's own environment switch: it doesn't reload the reporter mod
 * when its folder changes, so a Bash write there can't run inside a live
 * session; the app's hash check catches it at the next start (gate M-2,
 * Research MIP2-1430). Set per session in --settings, not on the
 * supervisor, so sessions started from a terminal keep Claude Code's
 * default (MIP2-1457; Research observed it per session).
 */
const SESSION_ENV = { CLAUDE_CODE_PLUGIN_DIR_WATCH: '0' } as const

/** Where each channel's settings version is kept: the app's store in the app, a map in tests. */
export interface SettingsVersions {
  get(channelId: string): number | undefined
  set(channelId: string, version: number): void
  delete(channelId: string): void
}

/** A plain map, for a hub with nowhere else to keep them. */
export function memoryVersions(): SettingsVersions {
  const m = new Map<string, number>()
  return { get: id => m.get(id), set: (id, v) => void m.set(id, v), delete: id => void m.delete(id) }
}
/** Marks a channel that stopped being trustworthy, with why, so the mark outlives an app restart (gate run 3, M-1). */
const UNTRUSTED_FILE = 'untrusted'

/** At most this many connections per channel wait on a peer check at once (gate run 2, L-5). */
export const PEER_CHECKS_MAX = 8
/** Watch events this soon after the watch starts are the server's own bind. */
const WATCH_GRACE_MS = 500

/** Whether something accepts a connection on `path` within half a second. */
export function answers(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const sock = connect(path)
    const done = (v: boolean) => (sock.destroy(), resolve(v))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(500, () => done(false))
  })
}

export interface ChannelHubOptions {
  /** The reporter mod's folder, passed to `--plugin-dir`. */
  modDir: string
  root?: string
  /** How long a long poll is held; LONG_POLL_MS outside tests. */
  longPollMs?: number
  now?: () => number
  log?: (line: string) => void
  /** A session's main loop ended a turn with text (mod 0.6.0): for the card summaries (MIP2-1422). */
  onAnswer?: (sessionId: string, post: AnswerPost) => void
  /**
   * The session's process id, from `claude agents --json`; null while it
   * isn't listed. With it, every connection must come from that process
   * (gate M-1): a secret read by a Bash command is refused, since the Bash
   * child connects as its own pid (Research's peer-pid memo).
   */
  sessionPid?: (sessionId: string) => number | null
  /**
   * A channel stopped being trustworthy: its socket was moved or replaced
   * while the app ran, or something else answered it while the app was
   * closed. Main stops the session (gate run 2, M-1).
   */
  onUntrusted?: (sessionId: string | null, why: string) => void
  /** Every installed mod version's folder, denied to sessions whole (gate run 2, L-1); without it, `modDir` alone is. */
  modRoot?: string
  /** More folders denied to sessions whole: the app's data folder, so a session's Edit tool can't change its store (pass 5, M-3). */
  denyAlso?: string[]
  /** Finds a connection's peer; the default reads `lsof`. */
  peers?: PeerResolver
  /** How long a connection waits for its session's pid before it's refused. */
  peerWaitMs?: number
  /**
   * The launch options the app recorded for a session, so a re-key writes
   * the settings file from the app's own record (pass 4, H-1). Without one,
   * the two options are read from the old file and checked.
   */
  launchOf?: (sessionId: string) => LaunchOptions | null
  /** Each channel's settings version (pass 7, M-1); a map in memory without one. */
  versions?: SettingsVersions
  /** A channel's settings file was brought up to date at recovery, for the self-check (pass 7, M-1). */
  onMigrated?: (channelId: string, from: number, to: number) => void
}

export interface LaunchOptions {
  isolation?: 'none' | 'worktree'
  ultracode?: boolean
}

export class ChannelHub {
  readonly root: string
  private modDir: string
  private readonly modRoot: string | null
  private readonly denyAlso: string[]
  /** Why launches are refused, or null: the current mod copy is changed and couldn't be repaired (pass 5, H-1). */
  private launchBlock: string | null = null
  /** Each session's re-key, run one after another (pass 5, M-4). */
  private readonly rekeys = new Map<string, Promise<void>>()
  private readonly onUntrusted: (sessionId: string | null, why: string) => void
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly longPollMs: number
  private readonly onAnswer: (sessionId: string, post: AnswerPost) => void
  private readonly sessionPid: ((sessionId: string) => number | null) | null
  private readonly peers: PeerResolver
  private readonly peerWaitMs: number
  private readonly channels = new Map<string, SessionChannel>()
  /**
   * Sessions whose channel stopped being trustworthy, kept apart from the
   * channels themselves, so a channel that leaves the map (a failed re-key)
   * doesn't take the mark with it (pass 4, M-1). Cleared only by a re-key
   * that finishes.
   */
  private readonly untrustedSessions = new Map<string, string>()
  private readonly launchOf: (sessionId: string) => LaunchOptions | null
  private readonly versions: SettingsVersions
  private readonly onMigrated: (channelId: string, from: number, to: number) => void
  /** Watches the channel root, where a channel's whole folder could be swapped (gate run 3, M-3). */
  private rootWatcher: FSWatcher | null = null
  private control: { cardAnswers: boolean; promptRelay: boolean } = { cardAnswers: true, promptRelay: true }

  constructor(opts: ChannelHubOptions) {
    this.root = opts.root ?? DEFAULT_CHANNEL_ROOT
    this.modDir = opts.modDir
    this.modRoot = opts.modRoot ?? null
    this.denyAlso = opts.denyAlso ?? []
    this.onUntrusted = opts.onUntrusted ?? (() => {})
    this.onAnswer = opts.onAnswer ?? (() => {})
    this.sessionPid = opts.sessionPid ?? null
    this.peers = opts.peers ?? new PeerResolver()
    this.peerWaitMs = opts.peerWaitMs ?? 10_000
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (line => console.warn(line))
    this.longPollMs = opts.longPollMs ?? LONG_POLL_MS
    this.launchOf = opts.launchOf ?? (() => null)
    this.versions = opts.versions ?? memoryVersions()
    this.onMigrated = opts.onMigrated ?? (() => {})
  }

  /** Creates the channel root and its parent at 0700, and refuses one that isn't private to this user. */
  async ensureRoot(): Promise<void> {
    for (const dir of [join(this.root, '..'), this.root]) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await checkPrivateDir(dir)
    }
  }

  /** A new channel for one `claude --bg` launch. */
  async prepareLaunch(opts: { isolation?: 'none' | 'worktree'; ultracode?: boolean } = {}): Promise<ChannelLaunch> {
    if (this.launchBlock) throw new Error(`Launching is paused: ${this.launchBlock}`)
    await this.ensureRoot()
    const id = randomBytes(4).toString('hex')
    const dir = join(this.root, id)
    const socketPath = join(dir, SOCKET_FILE)
    if (Buffer.byteLength(socketPath) > SOCKET_PATH_LIMIT) {
      throw new Error(`socket path is ${Buffer.byteLength(socketPath)} bytes, over ${SOCKET_PATH_LIMIT}`)
    }
    await mkdir(dir, { mode: 0o700 })
    const ch = new SessionChannel(id, dir, newSecret(), this.now(), true)
    const settingsPath = join(dir, SETTINGS_FILE)
    // `wx`: never write through a file or link already there.
    const text = JSON.stringify(this.settingsFor(ch, socketPath, opts.isolation ?? 'none', opts.ultracode === true), null, 2)
    await writeFile(settingsPath, text, { mode: 0o600, flag: 'wx' })
    ch.settingsSeen = { hash: sha256(text), ...(await statOf(settingsPath)) }
    this.versions.set(id, SETTINGS_VERSION)
    await this.start(ch, socketPath)
    return { channelId: id, settingsPath, args: ['--plugin-dir', this.modDir, '--settings', settingsPath] }
  }

  /** The session's --settings file. */
  settingsFor(ch: { secret: string }, socketPath: string, isolation: 'none' | 'worktree' = 'none', ultracode = false): object {
    // The reporter mod's folder too: a session that edits it changes every session's mod (gate M-2).
    const deny = denyRules([this.root, this.modDir, ...(this.modRoot ? [this.modRoot] : []), ...this.denyAlso])
    return {
      pluginConfigs: { [PLUGIN_KEY]: { options: { socketPath, secret: ch.secret, channelRoot: this.root } } },
      permissions: { deny },
      env: { ...SESSION_ENV },
      // Edit in place unless the category says otherwise (D-011 item 2).
      // Without the key, Claude Code's own worktree guard applies (MIP2-1377 §1a).
      ...(isolation === 'none' ? { worktree: { bgIsolation: 'none' } } : {}),
      // Workflows for each substantive task, at the session's own effort (settings-reference `ultracode`).
      ...(ultracode ? { ultracode: true } : {}),
    }
  }

  /**
   * Restarts the servers for channels left by an earlier run of the app, so
   * sessions that outlived it keep their channel. A folder that fails a
   * check is skipped and logged.
   */
  async recover(): Promise<string[]> {
    await this.ensureRoot()
    const recovered: string[] = []
    for (const id of await readdir(this.root)) {
      if (!/^[0-9a-f]{8}$/.test(id) || this.channels.has(id)) continue
      const dir = join(this.root, id)
      try {
        await checkPrivateDir(dir)
        const settings = await readSettings(join(dir, SETTINGS_FILE))
        const secret = settings.data.pluginConfigs?.[PLUGIN_KEY]?.options?.secret
        if (typeof secret !== 'string' || !SECRET_HEX.test(secret)) throw new Error('no secret in the settings file')
        const ch = new SessionChannel(id, dir, secret, this.now(), false)
        ch.settingsSeen = { hash: sha256(settings.text), ...settings.stat }
        // The file the session will read on its next start must be the one the app wrote (pass 4, H-1).
        ch.sessionId = await readSessionId(join(dir, SESSION_FILE))
        let altered = this.settingsAltered(settings.data, join(dir, SOCKET_FILE), SETTINGS_VERSION)
        // A file an older version wrote, with nothing else changed, is brought up to date in place: the same
        // secret, so a running session keeps its channel, and the new rules apply from its next start. Only a
        // channel the store recorded at that older version qualifies; one it has no version for, or anything
        // else changed, is still marked (MIP2-1444; pass 6, M-2; pass 7, M-1).
        // A channel the store has no version for was written before versions were kept in the store (1d3208c
        // kept them in the folder): it's taken as version 2, the last shape a released build wrote, which already
        // has every deny rule. Only an exact v2 file migrates; anything else is marked (pass 8, M-1).
        const version = this.versions.get(id) ?? LAST_UNRECORDED_VERSION
        if (altered !== null && version < SETTINGS_VERSION && this.settingsAltered(settings.data, join(dir, SOCKET_FILE), version) === null) {
          await this.migrate(ch, settings.data, version)
          altered = null
        }
        // While the app was closed nothing should answer the socket. Something that does held the
        // secret and may have answered the session's prompts (gate run 2, M-1).
        const squatted = await answers(join(dir, SOCKET_FILE))
        const marked = await readMark(join(dir, UNTRUSTED_FILE))
        await this.start(ch, join(dir, SOCKET_FILE))
        if (marked) this.markUntrusted(ch, marked)
        else if (squatted) this.markUntrusted(ch, 'another process was answering its channel while the app was closed')
        else if (altered) this.markUntrusted(ch, `its settings file was changed while the app was closed (${altered})`)
        else if (ch.sessionId && this.untrustedSessions.has(ch.sessionId)) this.markUntrusted(ch, this.untrustedSessions.get(ch.sessionId)!)
        recovered.push(id)
      } catch (err) {
        this.log(`channel: skipped ${id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return recovered
  }

  /** Stops a channel and removes its folder: on `rm`, or when its session is gone. */
  async close(channelId: string): Promise<void> {
    const ch = this.channels.get(channelId)
    this.channels.delete(channelId)
    this.versions.delete(channelId)
    ch?.watcher?.close()
    await ch?.server?.close()
    const dir = join(this.root, channelId)
    if (!/^[0-9a-f]{8}$/.test(channelId)) return
    try {
      await checkPrivateDir(dir)
      await rm(dir, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  async closeAll(): Promise<void> {
    this.rootWatcher?.close()
    this.rootWatcher = null
    for (const ch of this.channels.values()) ch.watcher?.close()
    await Promise.all([...this.channels.values()].map(ch => ch.server?.close()))
  }

  /** Binds a launched channel to its session as soon as the launch knows the id. */
  bind(channelId: string, sessionId: string): void {
    const ch = this.channels.get(channelId)
    if (!ch || ch.sessionId) return
    ch.sessionId = sessionId
    void writeFile(join(ch.dir, SESSION_FILE), sessionId, { mode: 0o600 }).catch(() => {})
    // A swap before the session was known is reported now, so its session is stopped (gate run 3, M-2).
    if (ch.untrusted) {
      this.untrustedSessions.set(sessionId, ch.untrusted)
      this.onUntrusted(sessionId, ch.untrusted)
    }
  }

  /**
   * Gives a session's channel a new secret and rewrites its settings file
   * whole from the app's own record, so nothing another process put in it
   * survives: not a `socketPath`, a permission or a hook (pass 4, H-1). The
   * server restarts on the channel's own socket with the new secret.
   *
   * The fallible work comes first: the new file is written beside the old
   * one before anything is torn down. If any step fails, the old channel
   * stays in place and the session stays untrusted (pass 4, M-1).
   *
   * `keepMark` rotates without clearing the untrusted mark: the app does
   * that when it stops an untrusted session, so a wake from anywhere (the
   * `claude` CLI, the supervisor) finds a secret the impostor never read,
   * and the channel still takes no card answers until it's resumed from the
   * app (pass 4, M-2, L-5). A resume from the app re-keys and clears it. The
   * Ed25519 reply key (MIP2-1436 item 1) is to rotate the same way.
   */
  rekey(sessionId: string, opts: { keepMark?: boolean } = {}): Promise<void> {
    // One at a time per session, each after the last settles (pass 5, M-4).
    const run = (this.rekeys.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(() => this.rekeyNow(sessionId, opts))
    this.rekeys.set(sessionId, run)
    void run.catch(() => {}).finally(() => {
      if (this.rekeys.get(sessionId) === run) this.rekeys.delete(sessionId)
    })
    return run
  }

  private async rekeyNow(sessionId: string, opts: { keepMark?: boolean }): Promise<void> {
    const old = [...this.channels.values()].find(c => c.sessionId === sessionId)
    if (!old) throw new Error(`no channel for session ${sessionId}`)
    const why = old.untrusted ?? this.untrustedSessions.get(sessionId) ?? null
    await checkPrivateDir(old.dir)
    const settingsPath = join(old.dir, SETTINGS_FILE)
    const socketPath = join(old.dir, SOCKET_FILE)
    const launch = this.launchOf(sessionId) ?? (await launchOptionsIn(settingsPath))
    const ch = new SessionChannel(old.id, old.dir, newSecret(), this.now(), true)
    ch.sessionId = sessionId
    const text = JSON.stringify(this.settingsFor(ch, socketPath, launch.isolation ?? 'none', launch.ultracode === true), null, 2)
    const tmp = `${settingsPath}.rekey-${randomBytes(8).toString('hex')}`
    await rm(tmp, { force: true })
    await writeFile(tmp, text, { mode: 0o600, flag: 'wx' })
    old.watcher?.close()
    old.watcher = null
    await old.server?.close()
    try {
      await rename(tmp, settingsPath)
      ch.settingsSeen = { hash: sha256(text), ...(await statOf(settingsPath)) }
      this.versions.set(old.id, SETTINGS_VERSION)
      if (opts.keepMark && why) ch.pendingClear = why
      this.channels.delete(old.id)
      await this.start(ch, socketPath)
    } catch (err) {
      // The old channel stays, marked, so nothing treats the session as trusted (pass 4, M-1). Its
      // server is closed, so it's held but not served: a session woken now gets no channel until the
      // next resume from the app re-keys it (pass 5, L-1).
      await rm(tmp, { force: true }).catch(() => {})
      old.untrusted ??= why ?? `its re-key failed: ${err instanceof Error ? err.message : String(err)}`
      this.untrustedSessions.set(sessionId, old.untrusted)
      const held = this.channels.get(old.id)
      if (!held || held === old || held === ch) this.channels.set(old.id, old)
      throw err
    }
    if (!opts.keepMark) {
      await rm(join(old.dir, UNTRUSTED_FILE), { force: true })
      this.untrustedSessions.delete(sessionId)
    }
    this.log(`channel ${ch.id}: new secret for ${sessionId.slice(0, 8)}${opts.keepMark && why ? ' (still untrusted until resumed from the app)' : ''}`)
  }

  /**
   * Clears a session's untrusted mark, after a resume from the app re-keyed
   * its channel with the mark kept and the session came back (pass 5, L-2).
   * The new channel is checked first: a socket or settings file changed
   * during the resume keeps it marked, with the new reason, and true is
   * returned only when the mark was cleared (pass 6, M-1).
   */
  async clearMark(sessionId: string): Promise<boolean> {
    await (this.rekeys.get(sessionId) ?? Promise.resolve()).catch(() => {})
    const ch = [...this.channels.values()].find(c => c.sessionId === sessionId)
    // No channel: nothing for clearing the mark to enable, so both marks stay (pass 7, L-2).
    if (!ch) return false
    if (ch.untrusted) return false
    const changed = ch.server?.socketChanged() ?? this.settingsChanged(ch)
    if (changed) {
      this.markUntrusted(ch, changed)
      return false
    }
    ch.pendingClear = null
    this.untrustedSessions.delete(sessionId)
    await rm(join(ch.dir, UNTRUSTED_FILE), { force: true })
    return true
  }

  /** Refuses launches with this reason while it's set (pass 5, H-1). */
  blockLaunches(reason: string | null): void {
    this.launchBlock = reason
  }

  /** Why launches are refused, or null. */
  launchBlocked(): string | null {
    return this.launchBlock
  }

  /** Points new launches at another mod copy: a fresh one, when the old one couldn't be repaired (pass 5, H-1). */
  setModDir(dir: string): void {
    this.modDir = dir
  }

  /**
   * Marks sessions untrusted from the app's own record (pass 4, M-2). The
   * store's copy covers a lost folder mark. It doesn't hold against same-user
   * code, which can write the store as well (pass 5, M-3).
   */
  restoreMarks(marks: Iterable<[sessionId: string, why: string]>): void {
    for (const [sessionId, why] of marks) {
      this.untrustedSessions.set(sessionId, why)
      const ch = [...this.channels.values()].find(c => c.sessionId === sessionId)
      if (ch) this.markUntrusted(ch, why)
    }
  }

  /** Closes the channel of a session that was removed. */
  async closeFor(sessionId: string): Promise<void> {
    const id = this.channelOf(sessionId)
    if (id) await this.close(id)
  }

  channelOf(sessionId: string): string | null {
    for (const ch of this.channels.values()) if (ch.sessionId === sessionId) return ch.id
    return null
  }

  /** The telemetry each channel last sent, in the shape the FleetPoller reads. */
  readReporter(): ReporterRead {
    const files: ReporterRead['files'] = new Map()
    for (const ch of this.channels.values()) {
      if (ch.sessionId && ch.file) files.set(ch.sessionId, { file: ch.file, mtimeMs: Math.max(ch.receivedAt, ch.contactAt) })
    }
    return { files, rejected: [] }
  }

  /** Prompts waiting for an answer, by session. */
  pendingRequests(): Map<string, PendingRequest[]> {
    const out = new Map<string, PendingRequest[]>()
    if (!this.control.cardAnswers) return out
    const now = this.now()
    for (const ch of this.channels.values()) {
      for (const [id, p] of ch.pending) {
        if (!p.deliver && now - p.polledAt > ORPHANED_AFTER_MS) ch.pending.delete(id)
      }
      if (!ch.sessionId || ch.pending.size === 0 || ch.untrusted || ch.pendingClear) continue
      out.set(
        ch.sessionId,
        [...ch.pending.values()].map(p => ({
          requestId: p.ask.requestId,
          tool: p.ask.tool,
          summary: summarize(p.ask),
          ...(({ fields, refusal }) => ({ fields, refusal }))(cardInput(p.ask)),
          questions: p.ask.questions?.map((q): CardQuestion => ({ question: q.question, options: q.options.map(o => o.label) })) ?? null,
          canRemember: p.ask.canRemember,
          agentId: p.ask.agentId,
          askedAt: p.askedAt,
        })),
      )
    }
    return out
  }

  /**
   * Answers a pending prompt. False when the request is gone (answered in
   * the session, or ended) or the answer doesn't fit its questions.
   */
  answer(requestId: string, input: AnswerInput): boolean | 'session-only' {
    if (!this.control.cardAnswers) return false
    for (const ch of this.channels.values()) {
      const p = ch.pending.get(requestId)
      if (!p) continue
      if (ch.untrusted || ch.pendingClear) return false
      if (input.verdict === 'allow' && p.ask.questions && !answersValid(p.ask.questions, input.answers)) return false
      // A permission the card can't show in full is approved only in the session (gate H-1); Deny is always safe.
      if (input.verdict === 'allow' && !p.ask.questions && cardInput(p.ask).refusal !== null) return 'session-only'
      const answer: PermissionAnswer =
        input.verdict === 'deny'
          ? { status: 'answer', verdict: 'deny' }
          : { status: 'answer', verdict: 'allow', remember: input.remember === true, ...(input.answers ? { answers: input.answers } : {}) }
      if (p.deliver) {
        p.deliver(answer)
      } else {
        p.answer = answer
      }
      return true
    }
    return false
  }

  /**
   * Queues text for the session to submit as Alex's own input. The text is
   * delivered once; it is never re-sent, so it can't run twice.
   */
  relayPrompt(sessionId: string, text: string): string {
    if (!this.control.promptRelay) throw new Error('sending prompts is switched off for this Claude Code version')
    const ch = [...this.channels.values()].find(c => c.sessionId === sessionId)
    if (!ch) throw new Error(`no channel for session ${sessionId}`)
    const why = ch.untrusted ?? ch.pendingClear
    if (why) throw new Error(`the session's channel can't be trusted (${why}); type in the session`)
    if (text.trim() === '') throw new Error('empty prompt')
    const id = randomUUID()
    ch.prompts.push({ id, text, state: 'queued', at: this.now() })
    ch.promptWaiter?.()
    return id
  }

  /**
   * Switches the control paths, from the self-check (DECISION item 4). With
   * card answers off, every offer is canceled so the mod returns the prompt
   * to the session's dialog.
   */
  setControl(off: readonly ('card-answers' | 'prompt-relay')[]): void {
    this.control = { cardAnswers: !off.includes('card-answers'), promptRelay: !off.includes('prompt-relay') }
    if (this.control.cardAnswers) return
    for (const ch of this.channels.values()) {
      for (const p of ch.pending.values()) p.deliver?.({ status: 'cancel' })
      ch.pending.clear()
    }
  }

  /** What the self-check reads about each channel. */
  health(): ChannelHealth[] {
    this.checkSockets()
    return [...this.channels.values()].map(ch => ({
      untrusted: ch.untrusted ?? ch.pendingClear,
      ...(ch.server ? { stats: { ...ch.server.stats } } : {}),
      sessionId: ch.sessionId,
      createdAt: ch.createdAt,
      contactAt: ch.contactAt,
      launched: ch.launched,
      offered: ch.offered,
      prompts: ch.prompts.map(p => ({ at: p.at, submitted: p.state === 'submitted' })),
    }))
  }

  /**
   * Compares each channel's socket file with the one its server bound (gate
   * M-1). One that's gone, replaced or owned by someone else means another
   * process may be answering the mod: the channel stops taking card answers
   * and relayed prompts, its waiting prompts go back to the session's own
   * dialog, and the card says why.
   */
  checkSockets(): void {
    for (const ch of this.channels.values()) {
      if (ch.untrusted || !ch.server) continue
      const why = ch.server.socketChanged() ?? this.settingsChanged(ch)
      if (why) this.markUntrusted(ch, why)
    }
  }

  /**
   * Compares the channel's settings file with what the app wrote or checked
   * (pass 4, H-1). Claude Code reads it again on every start, resume or
   * respawn, so an edit made without touching the socket is caught here.
   */
  private settingsChanged(ch: SessionChannel): string | null {
    const seen = ch.settingsSeen
    if (!seen) return null
    try {
      const fd = openSync(join(ch.dir, SETTINGS_FILE), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const st = fstatSync(fd)
        if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) return 'its settings file is no longer private'
        if (st.ino !== seen.ino || st.size !== seen.size || st.mtimeMs !== seen.mtimeMs || st.ctimeMs !== seen.ctimeMs) return 'its settings file was changed'
        return sha256(readFileSync(fd)) === seen.hash ? null : 'its settings file was changed'
      } finally {
        closeSync(fd)
      }
    } catch {
      return 'its settings file was removed or replaced'
    }
  }

  /** Rewrites a channel's settings file at the current version, keeping its secret and launch options (MIP2-1444). */
  private async migrate(ch: SessionChannel, data: SettingsData, from: number): Promise<void> {
    const wt = data.worktree as { bgIsolation?: unknown } | undefined
    const launch = (ch.sessionId ? this.launchOf(ch.sessionId) : null) ?? { isolation: wt?.bgIsolation === 'none' ? 'none' : 'worktree', ultracode: data.ultracode === true }
    const settingsPath = join(ch.dir, SETTINGS_FILE)
    const text = JSON.stringify(this.settingsFor(ch, join(ch.dir, SOCKET_FILE), launch.isolation ?? 'none', launch.ultracode === true), null, 2)
    const tmp = `${settingsPath}.migrate-${randomBytes(8).toString('hex')}`
    await writeFile(tmp, text, { mode: 0o600, flag: 'wx' })
    await rename(tmp, settingsPath)
    ch.settingsSeen = { hash: sha256(text), ...(await statOf(settingsPath)) }
    this.versions.set(ch.id, SETTINGS_VERSION)
    this.log(`channel ${ch.id}: settings brought from version ${from} to ${SETTINGS_VERSION}`)
    this.onMigrated(ch.id, from, SETTINGS_VERSION)
  }

  /**
   * Why a recovered settings file isn't one the app wrote, or null (pass 4,
   * H-1). Its secret is the session's own; everything else must be what
   * settingsFor() makes: the channel's own socket and root, deny rules
   * covering the channel root (older launches may also deny an older mod
   * folder), and nothing more.
   */
  private settingsAltered(data: SettingsData, socketPath: string, version: number): string | null {
    const keys = Object.keys(data)
    if (keys.some(k => !['pluginConfigs', 'permissions', 'worktree', 'ultracode', ...(version >= 3 ? ['env'] : [])].includes(k))) return 'extra keys'
    if (version >= 3 && JSON.stringify(data.env) !== JSON.stringify(SESSION_ENV)) return 'env'
    const configs = data.pluginConfigs ?? {}
    if (Object.keys(configs).length !== 1) return 'extra plugin configs'
    if (Object.keys(configs[PLUGIN_KEY] ?? {}).join() !== 'options') return 'plugin config'
    const options = configs[PLUGIN_KEY]?.options as Record<string, unknown> | undefined
    if (!options || Object.keys(options).sort().join() !== 'channelRoot,secret,socketPath') return 'channel options'
    if (options.socketPath !== socketPath || options.channelRoot !== this.root) return 'socket path'
    const perms = data.permissions as Record<string, unknown> | undefined
    if (!perms || Object.keys(perms).join() !== 'deny' || !Array.isArray(perms.deny)) return 'permissions'
    const deny = perms.deny as unknown[]
    if (!deny.every(r => typeof r === 'string' && /^(Read|Edit)\(\/\/[^()]+\/\*\*\)$/.test(r))) return 'permissions'
    // Every folder the app denies now, extras allowed since they only narrow (pass 5, M-1). A packaged
    // app's mod root covers every version's folder, so a file from an older version still passes.
    const required = [this.root, ...(this.modRoot ? [this.modRoot] : [this.modDir]), ...(version >= 2 ? this.denyAlso : [])]
    if (!denyRules(required).every(r => deny.includes(r))) return 'permissions'
    if (data.worktree !== undefined && JSON.stringify(data.worktree) !== '{"bgIsolation":"none"}') return 'worktree'
    if (data.ultracode !== undefined && data.ultracode !== true) return 'ultracode'
    return null
  }

  /** Stops trusting a channel: no card answers or relayed prompts, waiting prompts back to the session's dialog. */
  private markUntrusted(ch: SessionChannel, why: string): void {
    if (ch.untrusted) return
    ch.untrusted = why
    ch.pendingClear = null
    if (ch.sessionId) this.untrustedSessions.set(ch.sessionId, why)
    this.log(`channel ${ch.id}: untrusted: ${why}`)
    try {
      // Written beside it with `wx` and renamed over it, so a link left at the mark's name is replaced, not written through (pass 4, L-1).
      const tmp = join(ch.dir, `${UNTRUSTED_FILE}.${process.pid}`)
      rmSync(tmp, { force: true })
      writeFileSync(tmp, why, { mode: 0o600, flag: 'wx' })
      renameSync(tmp, join(ch.dir, UNTRUSTED_FILE))
    } catch (err) {
      this.log(`channel ${ch.id}: couldn't record the untrusted mark: ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const p of ch.pending.values()) p.deliver?.({ status: 'cancel' })
    ch.pending.clear()
    for (const pr of ch.prompts) if (pr.state === 'queued') pr.state = 'delivered'
    this.onUntrusted(ch.sessionId, why)
  }

  /**
   * Watches the channel's folder (kqueue/FSEvents) so a swap of its socket is
   * caught when it happens, not at the next poll: any rename of `s.sock`
   * marks the channel untrusted, even if the original is back by the time
   * the event is read (gate run 2, M-1). The server never renames its own
   * socket while it runs. Events in the first half second are the server's
   * own bind and are checked, not trusted.
   */
  /**
   * Watches the channel root once: a rename of a channel's folder there marks
   * that channel untrusted, as a rename of its socket does (gate run 3, M-3).
   * The app's own new folder is within its channel's grace and is checked by
   * inode; a folder the app closes has already left the map.
   */
  private watchRoot(): void {
    if (this.rootWatcher) return
    try {
      this.rootWatcher = watch(this.root, (event, name) => {
        for (const ch of this.channels.values()) {
          if (ch.untrusted || !ch.server || (name !== null && name !== ch.id)) continue
          const changed = ch.server.socketChanged()
          if (changed) this.markUntrusted(ch, changed)
          else if (event === 'rename' && name === ch.id && this.now() - ch.watchedAt >= WATCH_GRACE_MS) this.markUntrusted(ch, 'its channel folder was moved or replaced')
        }
      })
      this.rootWatcher.on('error', err => this.log(`channel root: watch: ${err.message}`))
      this.rootWatcher.unref?.()
    } catch (err) {
      this.log(`channel root: watch: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private watchSocket(ch: SessionChannel): void {
    try {
      ch.watchedAt = this.now()
      ch.watcher = watch(ch.dir, (event, name) => {
        if (ch.untrusted || !ch.server) return
        if (name === SETTINGS_FILE) {
          // A rename of the file outside the app's own re-key (which closes this watcher first) marks it, even if
          // the bytes are back by now (pass 5, M-2).
          const early = this.now() - ch.watchedAt < WATCH_GRACE_MS
          const altered = this.settingsChanged(ch) ?? (event === 'rename' && !early ? 'its settings file was replaced' : null)
          if (altered) this.markUntrusted(ch, altered)
          return
        }
        if (name !== null && name !== SOCKET_FILE) return
        const early = this.now() - ch.watchedAt < WATCH_GRACE_MS
        const changed = ch.server.socketChanged() ?? this.settingsChanged(ch)
        if (changed) this.markUntrusted(ch, changed)
        else if (event === 'rename' && !early) this.markUntrusted(ch, 'the socket file was moved or replaced')
      })
      ch.watcher.on('error', err => this.log(`channel ${ch.id}: watch: ${err.message}`))
      ch.watcher.unref?.()
    } catch (err) {
      this.log(`channel ${ch.id}: watch: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Why the session's channel can't be trusted, or null. */
  untrustedReason(sessionId: string): string | null {
    return this.untrustedSessions.get(sessionId) ?? [...this.channels.values()].find(c => c.sessionId === sessionId)?.untrusted ?? null
  }

  /** Refuses a connection from any process but the session's own (gate M-1). */
  private async checkPeer(ch: SessionChannel, fd: number | null): Promise<string | null> {
    if (!this.sessionPid) return null
    if (fd === null) return 'no descriptor for the connection'
    const pidOf = this.sessionPid
    let expected: number | null = ch.sessionId ? pidOf(ch.sessionId) : null
    if (expected === null) {
      // Only connections waiting for the session's pid are capped, so a flood can't hold the channel
      // (gate run 2, L-5). Once the pid is known each connection gets one quick lookup and no wait, so a
      // flood can't lock out the session's own mod either (gate run 3, L-5).
      if (ch.peerChecks >= PEER_CHECKS_MAX) return 'too many connections waiting on the peer check'
      ch.peerChecks += 1
      try {
        expected = await this.waitForPid(ch, pidOf)
      } finally {
        ch.peerChecks -= 1
      }
    }
    return this.peerVerdict(fd, expected, ch.id)
  }

  /** A launch's mod can call before the app has bound the channel or listed the session. */
  private async waitForPid(ch: SessionChannel, pidOf: (sessionId: string) => number | null): Promise<number | null> {
    const deadline = this.now() + this.peerWaitMs
    for (;;) {
      const expected = ch.sessionId ? pidOf(ch.sessionId) : null
      if (expected !== null || this.now() >= deadline) return expected
      await new Promise(r => setTimeout(r, 250))
    }
  }

  private async peerVerdict(fd: number, expected: number | null, channelId: string): Promise<string | null> {
    if (expected === null) return "the session's process isn't known yet"
    const pids = await this.peers.peersOf(fd, channelId)
    if (pids.length === 1 && pids[0] === expected) return null
    return pids.length === 0 ? 'no peer process found' : `peer ${pids.join(', ')} is not the session's process ${expected}`
  }

  /** The session's last turn's whole final text, from a mod 0.6.0 or later; null before its first turn ends in this run of the app. Untrusted text. */
  lastAnswer(sessionId: string): AnswerPost | null {
    return [...this.channels.values()].find(c => c.sessionId === sessionId)?.answer ?? null
  }

  promptStatus(sessionId: string): PromptStatus[] {
    const ch = [...this.channels.values()].find(c => c.sessionId === sessionId)
    return ch?.prompts.map(({ id, state, at }) => ({ id, state, at })) ?? []
  }

  private async start(ch: SessionChannel, socketPath: string): Promise<void> {
    ch.server = new ChannelServer({
      socketPath,
      secret: ch.secret,
      now: this.now,
      checkPeer: fd => this.checkPeer(ch, fd),
      handlers: {
        report: file => {
          // The first report binds the channel to its session; another sessionId is refused.
          if (ch.sessionId && ch.sessionId !== file.sessionId) throw new Error('report for another session')
          const first = !ch.sessionId
          if (first) void writeFile(join(ch.dir, SESSION_FILE), file.sessionId, { mode: 0o600 }).catch(() => {})
          ch.sessionId = file.sessionId
          if (first && ch.untrusted) {
            this.untrustedSessions.set(file.sessionId, ch.untrusted)
            this.onUntrusted(file.sessionId, ch.untrusted)
          }
          ch.file = file
          ch.receivedAt = this.now()
        },
        permission: (ask, signal) => this.hold(ch, ask, signal),
        permissionDone: requestId => void ch.pending.delete(requestId),
        nextPrompt: signal => this.nextPrompt(ch, signal),
        promptAck: id => {
          const p = ch.prompts.find(x => x.id === id)
          if (p) p.state = 'submitted'
        },
        answer: post => {
          if (ch.answer && post.at < ch.answer.at) return
          ch.answer = post
          if (ch.sessionId) this.onAnswer(ch.sessionId, post)
        },
        contact: () => {
          ch.contactAt = this.now()
        },
        refused: reason => this.log(`channel ${ch.id}: refused: ${reason}`),
      },
    })
    await ch.server.listen()
    this.watchSocket(ch)
    this.watchRoot()
    this.channels.set(ch.id, ch)
  }

  private hold(ch: SessionChannel, ask: PermissionAsk, signal: AbortSignal): Promise<PermissionAnswer> {
    // Switched off: the mod gives the prompt back to the dialog.
    if (!this.control.cardAnswers) return Promise.resolve({ status: 'cancel' })
    let p = ch.pending.get(ask.requestId)
    if (!p) {
      p = { ask, askedAt: this.now(), polledAt: this.now(), answer: null, deliver: null }
      ch.pending.set(ask.requestId, p)
      ch.offered += 1
    }
    p.polledAt = this.now()
    const entry = p
    if (entry.answer) {
      ch.pending.delete(ask.requestId)
      return Promise.resolve(entry.answer)
    }
    return new Promise(resolve => {
      const done = (a: PermissionAnswer) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        entry.deliver = null
        if (a.status === 'answer') ch.pending.delete(ask.requestId)
        resolve(a)
      }
      const onAbort = () => done({ status: 'pending' })
      const timer = setTimeout(() => done({ status: 'pending' }), this.longPollMs)
      signal.addEventListener('abort', onAbort)
      entry.deliver = done
    })
  }

  private nextPrompt(ch: SessionChannel, signal: AbortSignal): Promise<PromptRelay | ReportWanted | null> {
    // A channel recovered after an app restart has no telemetry until the
    // mod sends its whole report; ask for it instead of waiting.
    if (!ch.file) return Promise.resolve({ want: 'report' })
    const take = (): PromptRelay | null => {
      const p = ch.prompts.find(x => x.state === 'queued')
      if (!p) return null
      p.state = 'delivered'
      return { id: p.id, text: p.text }
    }
    const now = take()
    if (now) return Promise.resolve(now)
    return new Promise(resolve => {
      const finish = (value: PromptRelay | null) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (ch.promptWaiter === wake) ch.promptWaiter = null
        resolve(value)
      }
      const wake = () => finish(take())
      const onAbort = () => finish(null)
      const timer = setTimeout(() => finish(null), this.longPollMs)
      signal.addEventListener('abort', onAbort)
      ch.promptWaiter = wake
    })
  }
}

/** Throws unless `dir` is a real directory, owned by this user, closed to others. */
async function checkPrivateDir(dir: string): Promise<void> {
  const st = await lstat(dir)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory`)
  if (st.uid !== process.getuid?.()) throw new Error(`${dir} is not owned by this user`)
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} is open to other users (mode ${(st.mode & 0o777).toString(8)})`)
}

async function readSessionId(path: string): Promise<string | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const text = (await handle.readFile('utf8')).trim()
      return /^[0-9a-f-]{36}$/.test(text) ? text : null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/** The untrusted mark's reason, or null when there's none (gate run 3, M-1). */
async function readMark(path: string): Promise<string | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return (await handle.readFile('utf8')).slice(0, 300) || 'marked untrusted by an earlier run'
    } finally {
      await handle.close()
    }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'its untrusted mark could not be read'
  }
}

/** Read and Edit denials on each folder, under each spelling of its path; `//` makes a rule's path absolute (permissions.md; MIP2-1376 §2). */
function denyRules(dirs: string[]): string[] {
  const roots = new Set<string>()
  for (const dir of dirs) {
    roots.add(dir)
    try {
      roots.add(realpathSync(dir))
    } catch {
      // A folder that doesn't resolve keeps the one spelling.
    }
  }
  return [...roots].flatMap(r => [`Read(//${r.replace(/^\/+/, '')}/**)`, `Edit(//${r.replace(/^\/+/, '')}/**)`])
}

type SettingsData = { pluginConfigs?: Record<string, { options?: { secret?: unknown } & Record<string, unknown> }> } & Record<string, unknown>

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

/** A channel's settings file, refused unless it's a private regular file of this user's. */
interface SettingsStat {
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}
type SettingsSeen = SettingsStat & { hash: string }

const pickStat = (st: SettingsStat): SettingsStat => ({ ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs })

async function statOf(path: string): Promise<SettingsStat> {
  return pickStat(await lstat(path))
}

async function readSettings(settingsPath: string): Promise<{ text: string; data: SettingsData; stat: SettingsStat }> {
  const handle = await open(settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = await handle.stat()
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error('settings file is not private')
    const text = await handle.readFile('utf8')
    const data = JSON.parse(text) as unknown
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('settings file is not an object')
    return { text, data: data as SettingsData, stat: pickStat(st) }
  } finally {
    await handle.close()
  }
}

/**
 * The two launch options a channel's settings file carries, for a session
 * the app has no launch record of. Only these two are read, each checked;
 * a file that can't be read gives the defaults, since the re-key replaces
 * it whole either way.
 */
async function launchOptionsIn(settingsPath: string): Promise<LaunchOptions> {
  try {
    const { data } = await readSettings(settingsPath)
    const wt = data.worktree as { bgIsolation?: unknown } | undefined
    return { isolation: wt?.bgIsolation === 'none' ? 'none' : 'worktree', ultracode: data.ultracode === true }
  } catch {
    return {}
  }
}
