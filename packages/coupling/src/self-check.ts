// The detect-and-degrade self-check (DECISION item 4). Alex: "Keep
// auto-update, but only fall back if the auto-update actually broke
// something". So nothing is switched off up front. On each poll the check
// reads what the sources did on the installed Claude Code version:
//
// - agents-json: every entry parsed, no state or wait value this version of
//   the app doesn't know;
// - channel: an app-hosted session's mod reached the app, which proves the
//   `pluginConfigs` secret path in the --settings file (MIP2-1376 §2);
// - mod events: after a full main-loop turn, turn.start, turn.step,
//   turn.complete and session.measure have each been seen;
// - card answers: a hosted session waiting on a permission prompt offered it
//   to the app;
// - prompt relay: a relayed prompt was submitted.
//
// A check passes once seen working and fails when a source that should have
// answered didn't. A failed event marks its fields stale; a failed channel
// marks every mod field stale and switches both control paths off; a failed
// control path switches that path off, and the session keeps its dialog.
// Results are kept per version, so a version that passed isn't re-judged
// from scratch after an app restart.

import { belowFloor, CLAUDE_CODE_FLOOR, type SelfCheckItem, type SelfCheckReport, type SessionSnapshot } from '@ccc/contract'
import type { ReporterFile } from '../../../mod/hooks/wire.ts'
import type { ReporterFields } from './reporter.ts'

/** The self-check item for the installed reporter mod's files (gate M-2). */
export const MOD_INTEGRITY = 'mod-integrity'
/** The self-check item for channel sockets replaced while in use (gate M-1). */
export const CHANNEL_SOCKETS = 'channel-sockets'
/** The self-check item for sessions whose mod would reload from a changed folder (gate run 2, L-3). */
export const MOD_RELOAD = 'mod-reload'
/** Sessions Claude Code started that the app couldn't account for and left running (pass 7, L-1). */
export const STRAY_SESSIONS = 'stray-sessions'
/** The shared supervisor's PATH holds the folder `claude` is in (MIP2-1457). */
export const SUPERVISOR_PATH = 'supervisor-path'
/** Channel settings files brought up to date at start: information, never a failure (pass 7, M-1). */
export const CHANNEL_SETTINGS = 'channel-settings'

export type CheckId =
  | 'agents-json'
  | 'channel'
  | 'event:turn.start'
  | 'event:turn.step'
  | 'event:turn.complete'
  | 'event:session.measure'
  | 'control:card-answers'
  | 'control:prompt-relay'

const LABELS: Record<CheckId, string> = {
  'agents-json': 'Session list (claude agents --json)',
  channel: 'Reporter channel and its settings secret',
  'event:turn.start': 'Mod event turn.start',
  'event:turn.step': 'Mod event turn.step (model, effort)',
  'event:turn.complete': 'Mod event turn.complete (tokens, last answer)',
  'event:session.measure': 'Mod event session.measure (context, usage, cost)',
  'control:card-answers': 'Answering prompts from cards',
  'control:prompt-relay': 'Sending prompts to a session',
}

/** Needed for "passed". The control paths pass only when used, so they aren't. */
const REQUIRED: CheckId[] = ['agents-json', 'channel', 'event:turn.start', 'event:turn.step', 'event:turn.complete', 'event:session.measure']

/** Checks a later success clears. */
const RECOVERABLE: ReadonlySet<CheckId> = new Set(['channel', 'control:card-answers', 'control:prompt-relay'])

/** The fields each event feeds; a failed event marks them stale. */
export const EVENT_FIELDS: Partial<Record<CheckId, (keyof ReporterFields)[]>> = {
  'event:turn.step': ['model', 'effort'],
  'event:turn.complete': ['tokens', 'turn'],
  'event:session.measure': ['context', 'costUsd', 'rateLimits'],
}
const ALL_MOD_FIELDS: (keyof ReporterFields)[] = [
  'model', 'turn', 'effort', 'context', 'tokens', 'costUsd', 'rateLimits', 'subagents', 'toolCalls', 'peerMessages', 'filesWritten',
]

/** A channel's mod may take this long after the app knows of it to make first contact. */
export const CHANNEL_DEADLINE_MS = 90_000
/** A permission prompt a hosted session shows this long without offering it to the app fails card answers. */
export const OFFER_DEADLINE_MS = 20_000
/** A relayed prompt not submitted this long after it was queued fails the relay. */
export const RELAY_DEADLINE_MS = 60_000
/** session.measure may arrive this long after a turn completes. */
const MEASURE_GRACE_MS = 15_000

export interface ChannelHealth {
  sessionId: string | null
  /** Why the channel can't be trusted (its socket was replaced, gate M-1); null while it can. */
  untrusted?: string | null
  /** Connections accepted and requests read so far (MIP2-1435). */
  stats?: { connections: number; requests: number }
  /** When this run of the app made or recovered the channel. */
  createdAt: number
  /** The last verified request; 0 for none. */
  contactAt: number
  /** Made for a launch in this run, so its mod must make contact. */
  launched: boolean
  /** requestIds the mod has offered. */
  offered: number
  /** Prompts relayed to it: when queued, and whether submitted. */
  prompts: { at: number; submitted: boolean }[]
}

export interface SelfCheckInput {
  now: number
  sessions: SessionSnapshot[]
  /** Entries `agents --json` printed that the reader rejected. */
  rejectedEntries: number
  channels: ChannelHealth[]
  files: Map<string, ReporterFile>
  /** Sessions the app is changing now or did within the last 10 s (MIP2-1447). */
  changing?: ReadonlySet<string>
}

/** An unknown state that clears within this long is a transition, not a change in Claude Code (MIP2-1447). */
export const UNKNOWN_GRACE_MS = 10_000

interface StoredCheck {
  state: 'pass' | 'fail'
  detail: string | null
  /** The turn-event rule a turn.start or turn.step verdict was made under. Absent means rule 1. */
  rule?: number
}

/**
 * Rule 2 (MIP2-1418) judges only turns seen from their start. A turn.start
 * or turn.step failure saved under rule 1 may be the restart false alarm,
 * so it's dropped on load and judged again.
 */
const TURN_EVENT_RULE = 2
const TURN_EVENTS = new Set<CheckId>(['event:turn.start', 'event:turn.step'])

/** Self-check results by Claude Code version. The app keeps it on disk. */
export interface SelfCheckStore {
  load(): Record<string, Partial<Record<CheckId, StoredCheck>>>
  save(data: Record<string, Partial<Record<CheckId, StoredCheck>>>): void
}

export function memoryStore(): SelfCheckStore {
  let data: Record<string, Partial<Record<CheckId, StoredCheck>>> = {}
  return { load: () => data, save: d => void (data = d) }
}

export class SelfCheck {
  private version: string | null = null
  private results: Partial<Record<CheckId, StoredCheck>> = {}
  /** When a hosted session was first seen at a permission prompt with no offer, by sessionId. */
  private readonly unoffered = new Map<string, number>()
  /** The supervisor's PATH when it lacks the folder `claude` is in; null when it's fine or not known (MIP2-1457). */
  private supervisorPath: { pid: number; path: string | null; claudeDir: string } | null = null
  /** When a session command last ran without its reload switch, the supervisor not confirmed running (MIP2-1463); not saved. */
  private switchUnconfirmedAt: number | null = null
  /** Strays left running, until they leave the session list (pass 7, L-1); not saved. */
  private readonly strays = new Set<string>()
  /** Channels whose settings were migrated at start, for the information item (pass 7, M-1); not saved. */
  private migrated: string[] = []
  /** When each session was first seen in a state the app doesn't know, while it stays in one (MIP2-1447). */
  private readonly unknownSince = new Map<string, number>()
  private checkedAt: number | null = null
  /** The installed reporter mod was found changed and put back (gate M-2); not saved, since it isn't about the version. */
  private modChanged: { at: number; movedTo: string | null; why?: string; sessions: string[] } | null = null
  /** A mod check that threw, so its result is unknown (pass 4, M-3); not saved. */
  private modCheckFailed: { at: number; what: string; why: string } | null = null
  /** Sessions whose channel socket was replaced, by the last evaluation; not saved. */
  private untrusted: { sessionId: string | null; why: string }[] = []
  /** Sessions whose mod reported reloading on, by the last evaluation; not saved. */
  private reloading: string[] = []
  /** Sessions whose mod hasn't reached the app by the deadline, by the last evaluation; not saved (MIP2-1488). */
  private unconnected: { sessionId: string | null; since: number }[] = []
  /** Check again for the channel: the deadline counts from here for channels made before it (MIP2-1488). */
  private channelSince = 0
  /** What the app knows that may have cut sessions off: when Claude Code was installed and the supervisor started. */
  private causes: { claudeInstalledAt: number | null; supervisorStartedAt: number | null } = { claudeInstalledAt: null, supervisorStartedAt: null }

  constructor(private readonly store: SelfCheckStore) {}

  /** Sets the installed version, from `claude --version`. A new version starts its own results. */
  setVersion(version: string | null): void {
    if (version === this.version) return
    this.version = version
    this.results = version ? { ...(this.store.load()[version] ?? {}) } : {}
    for (const id of TURN_EVENTS) {
      const r = this.results[id]
      if (r?.state === 'fail' && (r.rule ?? 1) < TURN_EVENT_RULE) delete this.results[id]
    }
    this.unoffered.clear()
  }

  /** New sessions the app couldn't account for and left running; shown until they leave the list (pass 7, L-1). */
  addStrays(ids: readonly string[]): void {
    for (const id of ids) this.strays.add(id)
  }

  /** A session command ran with its reload switch in its settings file only (MIP2-1463). */
  noteSwitchUnconfirmed(at: number): void {
    this.switchUnconfirmedAt = at
  }

  /** The latest read of the supervisor's PATH; null when no supervisor runs (MIP2-1457). */
  noteSupervisorPath(r: { pid: number; path: string | null; claudeDir: string; ok: boolean } | null): void {
    this.supervisorPath = r && !r.ok ? { pid: r.pid, path: r.path, claudeDir: r.claudeDir } : null
  }

  /** Channels whose settings files were brought up to date at start (pass 7, M-1). */
  noteMigrated(entries: readonly string[]): void {
    this.migrated = [...entries]
  }

  evaluate(input: SelfCheckInput): void {
    const listed = new Set(input.sessions.map(s => s.sessionId))
    for (const id of this.strays) if (!listed.has(id)) this.strays.delete(id)
    if (!this.version) return
    this.checkedAt = input.now
    this.checkAgentsJson(input)
    const onVersion = this.filesOnVersion(input.files)
    this.checkChannels(input)
    this.untrusted = input.channels.filter(c => c.untrusted).map(c => ({ sessionId: c.sessionId, why: c.untrusted! }))
    // A mod 0.6.1 or later that saw CLAUDE_CODE_PLUGIN_DIR_WATCH anything but "0" means a session whose settings
    // didn't carry the switch: it would reload a changed mod folder while it runs (gate run 2, L-3; MIP2-1457).
    const live = new Set(input.sessions.filter(s => s.pid.value !== null).map(s => s.sessionId))
    this.reloading = [...input.files.values()].filter(f => live.has(f.sessionId) && f.latest.pluginDirWatch !== undefined && f.latest.pluginDirWatch !== '0').map(f => f.sessionId)
    this.checkEvents(onVersion, input.now)
    this.checkControls(input)
    this.persist()
  }

  /**
   * Check again (settings, MIP2-1424): forgets this version's results, so
   * each check is observed afresh. A failed check otherwise stays failed.
   */
  recheck(now = Date.now()): void {
    if (!this.version) return
    // The channel deadline starts over too, or a late channel fails again at once (MIP2-1488).
    this.channelSince = now
    this.unconnected = []
    this.results = {}
    this.unoffered.clear()
    this.persist()
  }

  /** Fields to mark stale: those of failed events, or every mod field when the channel failed. */
  degradedFields(): ReadonlySet<keyof ReporterFields> {
    if (this.results.channel?.state === 'fail') return new Set(ALL_MOD_FIELDS)
    const out = new Set<keyof ReporterFields>()
    for (const [id, fields] of Object.entries(EVENT_FIELDS) as [CheckId, (keyof ReporterFields)[]][]) {
      if (this.results[id]?.state === 'fail') for (const f of fields) out.add(f)
    }
    return out
  }

  /** Below the tested floor: read-only, every control path off (MIP2-1406). */
  tooOld(): boolean {
    return this.version !== null && belowFloor(this.version)
  }

  controlOff(): SelfCheckReport['controlOff'] {
    if (this.tooOld()) return ['card-answers', 'prompt-relay']
    const channelDown = this.results.channel?.state === 'fail'
    const off: SelfCheckReport['controlOff'] = []
    if (channelDown || this.results['control:card-answers']?.state === 'fail') off.push('card-answers')
    if (channelDown || this.results['control:prompt-relay']?.state === 'fail') off.push('prompt-relay')
    return off
  }

  /**
   * The app found the installed reporter mod's files changed since it
   * shipped, moved that copy to `movedTo` and put the shipped one back
   * (gate M-2, MIP2-1430). Sessions that loaded the changed copy keep it
   * until they restart.
   */
  /**
   * A mod copy was found changed. `movedTo` is null when it couldn't be set
   * aside (an immutable flag, say): it still has its name, and a session
   * respawned from it would load it (pass 4, M-3).
   */
  markModChanged(at: number, movedTo: string | null, sessions: string[] = [], why?: string): void {
    this.modChanged = { at, movedTo, sessions, ...(why ? { why } : {}) }
  }

  /** A mod check threw, so the copy it covers is unchecked (pass 4, M-3). */
  markModCheckFailed(at: number, what: string, why: string): void {
    this.modCheckFailed = { at, what, why }
  }

  report(): SelfCheckReport | null {
    if (!this.version) return null
    const checks: SelfCheckItem[] = (Object.keys(LABELS) as CheckId[]).map(id => ({
      id,
      label: LABELS[id],
      state: this.results[id]?.state ?? 'pending',
      detail: this.results[id]?.detail ?? null,
    }))
    const mod: SelfCheckItem = {
      id: MOD_INTEGRITY,
      label: "Reporter mod files match what the app shipped",
      state: this.modChanged || this.modCheckFailed ? 'fail' : 'pass',
      detail: modDetail(this.modChanged, this.modCheckFailed),
    }
    const reload: SelfCheckItem = {
      id: MOD_RELOAD,
      // What each session's mod reports seeing, so advisory: it confirms the setting the mod sees, not that Claude
      // Code's reload watcher obeys it, and a changed mod can report anything (gate run 3, L-6; MIP2-1463).
      label: "Sessions don't reload the reporter mod while they run (as each mod reports; advisory)",
      state: this.reloading.length || this.switchUnconfirmedAt !== null ? 'fail' : 'pass',
      detail:
        [
          this.reloading.length ? `${this.reloading.map(id => id.slice(0, 8)).join(', ')}: the session's mod sees reload on, so a change to the mod's folder would load while it runs` : null,
          this.switchUnconfirmedAt !== null
            ? "the app couldn't confirm Claude Code's supervisor was running before a session command, so that session's reload switch is only in its settings file"
            : null,
        ]
          .filter(Boolean)
          .join('; ') || null,
    }
    const sockets: SelfCheckItem = {
      id: CHANNEL_SOCKETS,
      label: 'Session channel sockets are the ones the app made',
      state: this.untrusted.length ? 'fail' : 'pass',
      detail: this.untrusted.length ? this.untrusted.map(u => `${u.sessionId?.slice(0, 8) ?? 'a session'}: ${u.why}`).join('; ') : null,
    }
    const strays: SelfCheckItem = {
      id: STRAY_SESSIONS,
      label: 'Every running session is one the app started or knows',
      state: this.strays.size ? 'fail' : 'pass',
      detail: this.strays.size ? [...this.strays].map(id => id.slice(0, 8)).join(', ') : null,
    }
    const sp = this.supervisorPath
    const supervisor: SelfCheckItem = {
      id: SUPERVISOR_PATH,
      label: "Claude Code's background supervisor can find claude and your tools",
      state: sp ? 'fail' : 'pass',
      detail: sp
        ? `supervisor pid ${sp.pid} has PATH ${sp.path ?? '(unreadable)'}, without ${sp.claudeDir}. A session's commands use the PATH of whatever last started or restarted it, so ones not started or restarted by the app may not find claude, gh, node or npm.`
        : null,
    }
    const extra = [mod, sockets, reload, strays, supervisor, ...(this.migrated.length ? [{ id: CHANNEL_SETTINGS, label: 'Channel settings files brought up to date at start', state: 'pass' as const, detail: this.migrated.join('; ') }] : [])]
    if (this.tooOld()) {
      const floor: SelfCheckItem = {
        id: 'version-floor',
        label: `Claude Code ${CLAUDE_CODE_FLOOR} or later`,
        state: 'fail',
        detail: `${this.version} is older than this app supports`,
      }
      return { claudeVersion: this.version, state: 'too-old', checks: [floor, ...checks, ...extra], controlOff: this.controlOff(), checkedAt: this.checkedAt, unconnected: this.unconnected, causes: this.causes }
    }
    // A changed mod is not a Claude Code change: it has its own band, not "degraded".
    const failed = checks.some(c => c.state === 'fail')
    const passed = REQUIRED.every(id => this.results[id]?.state === 'pass')
    return { claudeVersion: this.version, state: failed ? 'degraded' : passed ? 'passed' : 'new', checks: [...checks, ...extra], controlOff: this.controlOff(), checkedAt: this.checkedAt, unconnected: this.unconnected, causes: this.causes }
  }

  private set(id: CheckId, state: 'pass' | 'fail', detail: string | null = null): void {
    // The session list and the events stay failed once failed: a value this
    // app doesn't know, or an event that didn't come, is a change on this
    // version even if a later poll looks fine. The channel and the control
    // paths recover on a later success: a real break doesn't succeed later,
    // and one session that never started shouldn't switch them off for a
    // whole version.
    if (this.results[id]?.state === 'fail' && state === 'pass' && !RECOVERABLE.has(id)) return
    this.results[id] = TURN_EVENTS.has(id) ? { state, detail, rule: TURN_EVENT_RULE } : { state, detail }
  }

  private persist(): void {
    if (!this.version) return
    this.store.save({ ...this.store.load(), [this.version]: this.results })
  }

  /**
   * A state the app doesn't know fails the check only once it persists: 10 s
   * on a session the app isn't changing (MIP2-1447). A shorter one, or one
   * on a session the app is stopping, respawning or resuming, shows on that
   * card alone. `waitingFor` is an open string: an undocumented value shows
   * on the card as it is, and doesn't fail the check (Research MIP2-1448).
   */
  private checkAgentsJson({ sessions, rejectedEntries, now, changing = new Set() }: SelfCheckInput): void {
    const unknownNow = new Set(sessions.filter(s => s.activity.value === 'unknown').map(s => s.sessionId))
    for (const id of this.unknownSince.keys()) if (!unknownNow.has(id)) this.unknownSince.delete(id)
    for (const id of unknownNow) if (changing.has(id)) this.unknownSince.delete(id)
    else if (!this.unknownSince.has(id)) this.unknownSince.set(id, now)
    const lasting = [...this.unknownSince.values()].filter(at => now - at >= UNKNOWN_GRACE_MS).length
    if (rejectedEntries > 0) return this.set('agents-json', 'fail', `${rejectedEntries} entries unreadable`)
    if (lasting > 0) return this.set('agents-json', 'fail', `${lasting} sessions in a state this app doesn't know`)
    if (sessions.length > 0 && unknownNow.size === 0) this.set('agents-json', 'pass')
  }

  private filesOnVersion(files: Map<string, ReporterFile>): ReporterFile[] {
    return [...files.values()].filter(f => {
      const v = f.latest.version ?? f.events.find(e => e.type === 'session.start' && 'version' in e)
      return (typeof v === 'string' ? v : v && 'version' in v ? v.version : null) === this.version
    })
  }

  /**
   * Every channel the app expects to hear from (launched in this run, or its
   * session running) must reach the app within CHANNEL_DEADLINE_MS. It fails
   * while any is late, naming them, and passes once none is and one has been
   * heard. An untrusted channel is left out: it has its own security item and
   * band, and this check never clears it (MIP2-1488).
   */
  private checkChannels({ channels, sessions, now }: SelfCheckInput): void {
    const alive = new Set(sessions.filter(s => s.pid.value !== null).map(s => s.sessionId))
    this.unconnected = channels
      .filter(ch => !ch.untrusted && ch.contactAt === 0)
      .filter(ch => ch.launched || (ch.sessionId !== null && alive.has(ch.sessionId)))
      .filter(ch => now - Math.max(ch.createdAt, this.channelSince) > CHANNEL_DEADLINE_MS)
      .map(ch => ({ sessionId: ch.sessionId, since: ch.createdAt }))
    if (this.unconnected.length) {
      const n = this.unconnected.length
      this.set('channel', 'fail', `${n === 1 ? "a hosted session's mod hasn't" : `${n} hosted sessions' mods haven't`} reached the app in ${Math.round(CHANNEL_DEADLINE_MS / 1000)} s`)
    } else if (channels.some(ch => ch.contactAt > 0)) {
      this.set('channel', 'pass')
    }
  }

  /**
   * Check again, for the channel only (MIP2-1488): a running session's mod
   * reconnects by itself within a minute (Research, MIP2-1488), so the
   * deadline starts over from now and the other results stand.
   */
  recheckChannel(now: number): void {
    this.channelSince = now
    delete this.results.channel
    this.unconnected = []
    this.persist()
  }

  /** When the running Claude Code was installed and the supervisor started, for the channel band's likely cause. */
  noteCauses(c: Partial<{ claudeInstalledAt: number | null; supervisorStartedAt: number | null }>): void {
    this.causes = { ...this.causes, ...c }
  }

  private checkEvents(files: ReporterFile[], now: number): void {
    for (const f of files) {
      const main = f.events.filter(e => e.agentId === null)
      const complete = main.find(e => e.type === 'turn.complete')
      if (!complete) continue
      this.set('event:turn.complete', 'pass')
      // Judge only a turn seen from its start: one after a session.start or
      // an earlier turn.complete in the same events. After an app restart
      // the events begin at the reconnect, mid-turn (MIP2-1418).
      const ends = main.flatMap((e, i) => (e.type === 'turn.complete' ? [i] : []))
      const starts = main.flatMap((e, i) => (e.type === 'session.start' || e.type === 'turn.complete' ? [i] : []))
      const whole = ends.map(end => ({ end, from: starts.filter(i => i < end).at(-1) })).filter(t => t.from !== undefined).at(-1)
      if (whole) {
        const turn = main.slice(whole.from! + 1, whole.end)
        for (const [id, type] of [
          ['event:turn.start', 'turn.start'],
          ['event:turn.step', 'turn.step'],
        ] as const) {
          const has = turn.some(e => e.type === type)
          this.set(id, has ? 'pass' : 'fail', has ? null : `no ${type} before a completed turn`)
        }
      }
      if (main.some(e => e.type === 'session.measure') || f.latest.measure) this.set('event:session.measure', 'pass')
      else if (now - complete.at > MEASURE_GRACE_MS) this.set('event:session.measure', 'fail', 'no session.measure after a completed turn')
    }
  }

  private checkControls({ channels, sessions, now }: SelfCheckInput): void {
    const bySession = new Map(channels.filter(c => c.sessionId).map(c => [c.sessionId!, c]))
    for (const ch of channels) {
      if (ch.offered > 0) this.set('control:card-answers', 'pass')
      if (ch.prompts.some(p => p.submitted)) this.set('control:prompt-relay', 'pass')
      const late = ch.prompts.find(p => !p.submitted && now - p.at > RELAY_DEADLINE_MS)
      if (late && now - ch.contactAt < RELAY_DEADLINE_MS) {
        this.set('control:prompt-relay', 'fail', `a relayed prompt wasn't submitted in ${RELAY_DEADLINE_MS / 1000} s`)
      }
    }
    for (const s of sessions) {
      const ch = bySession.get(s.sessionId)
      const atPrompt = s.needsYou.value?.kind === 'permission' && ch && ch.contactAt > 0 && now - ch.contactAt < 60_000
      if (!atPrompt || (s.pendingRequests?.value.length ?? 0) > 0) {
        this.unoffered.delete(s.sessionId)
        continue
      }
      const since = this.unoffered.get(s.sessionId) ?? now
      this.unoffered.set(s.sessionId, since)
      if (now - since > OFFER_DEADLINE_MS) {
        this.set('control:card-answers', 'fail', `a permission prompt wasn't offered to the app in ${OFFER_DEADLINE_MS / 1000} s`)
      }
    }
  }
}

/** `2.1.311 (Claude Code)` → `2.1.311`. */
export function parseVersion(stdout: string): string | null {
  return /^\s*(\d+\.\d+\.\d+\S*)/.exec(stdout)?.[1] ?? null
}

function modDetail(
  changed: { movedTo: string | null; why?: string; sessions: string[] } | null,
  failed: { what: string; why: string } | null,
): string | null {
  const parts: string[] = []
  if (changed) {
    const where = changed.movedTo
      ? `changed outside the app and moved to ${changed.movedTo}`
      : `changed outside the app and couldn't be set aside (${changed.why ?? 'unknown error'}); a session respawned from it would load it`
    parts.push(`${where}${changed.sessions.length ? `; sessions started on it: ${changed.sessions.join(', ')}` : ''}`)
  }
  if (failed) parts.push(`the check of ${failed.what} failed (${failed.why}), so it's unchecked`)
  return parts.length ? parts.join('. ') : null
}
