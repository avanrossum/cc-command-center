// Polls a SessionHost and the reporter mod's telemetry, and publishes
// FleetSnapshots. When a poll fails, the last sessions stay listed with that
// source's fields marked stale, and the source-health line says why, so a
// broken source degrades the view instead of emptying it (D-004).

import {
  CONTRACT_VERSION,
  field,
  markStale,
  type Field,
  type FleetSnapshot,
  type PendingRequest,
  type RateLimits,
  type SessionSnapshot,
  type SourceHealth,
  type UsageLimit,
} from '@ccc/contract'
import { reporterFields, type ReporterFields, type ReporterRead } from './reporter.ts'
import type { ReporterFile } from '../../../mod/hooks/wire.ts'
import type { ChannelHealth, SelfCheck } from './self-check.ts'
import type { SessionHost } from './session-host.ts'

/** A mod that hasn't been heard from this long has its fields marked stale (spec MIP2-1370 §4, Stale). */
export const MOD_SILENCE_MS = 60_000

/** How long a newly offered ask counts before Claude Code's own status must agree it's waiting. */
export const ASK_GRACE_MS = 15_000

/**
 * The asks that still need Alex, newest first (MIP2-1492). The mod keeps an
 * offer open until the tool runs or the turn ends, so a question answered in
 * the terminal stays offered while the turn goes on thinking. An ask counts
 * only while Claude Code says the session waits on Alex, or for
 * ASK_GRACE_MS after it was offered, so a poll can't race the dialog opening.
 * Newest first, so a newer prompt shows over an older one.
 */
export function livePending(pending: PendingRequest[], s: Pick<SessionSnapshot, 'activity' | 'needsYou'>, now: number): PendingRequest[] {
  const waiting = s.activity.value === 'waiting' || s.needsYou.value !== null
  return pending.filter(p => waiting || now - p.askedAt < ASK_GRACE_MS).sort((a, b) => b.askedAt - a.askedAt)
}

export type FleetListener = (snapshot: FleetSnapshot) => void

export interface FleetPollerOptions {
  host: SessionHost
  /** Reads the reporter mod's telemetry. Absent, sessions carry agents-json fields only. */
  readReporter?: () => Promise<ReporterRead> | ReporterRead
  /** Prompts the mods have offered to the app, by session. */
  readPending?: () => Map<string, PendingRequest[]>
  /** The usage governor's files, for the meter, given the sessions the app lists; a mod's own reading is the fallback. */
  readUsage?: (listed: ReadonlySet<string>) => Promise<Field<RateLimits> | null>
  /** Claude Code's `/usage` (MIP2-1522): the meter's main source; the newer of it and the files wins. */
  readReport?: () => Field<RateLimits> | null
  /** Its other limits (the Fable week, and kinds this version doesn't know). */
  readReportExtra?: () => Field<UsageLimit[]> | null
  /** QA's synthetic readings (MIP2-1516): the meter uses readUsage's reading alone, never a mod's. */
  usageFileOnly?: boolean
  /** The detect-and-degrade self-check (DECISION item 4). */
  selfCheck?: SelfCheck
  /** What the self-check reads about each channel. */
  readChannels?: () => ChannelHealth[]
  /** `claude --version`, read at start and every VERSION_EVERY_MS: auto-update changes it under a running app. */
  readVersion?: () => Promise<string | null>
  /** Where refused reports are logged. Defaults to console.warn. */
  log?: (line: string) => void
  intervalMs?: number
  now?: () => number
}

const VERSION_EVERY_MS = 5 * 60 * 1000

export class FleetPoller {
  private readonly host: SessionHost
  private readonly readReporter: FleetPollerOptions['readReporter'] | null
  private readonly readPending: FleetPollerOptions['readPending'] | null
  private readonly readUsage: FleetPollerOptions['readUsage'] | null
  private usageFile: Field<RateLimits> | null = null
  /** The meter's last reading, held while no new one reads (MIP2-1520). */
  private lastUsage: Field<RateLimits> | null = null
  private readonly usageFileOnly: boolean
  private readonly readReport: () => Field<RateLimits> | null
  private readonly readReportExtra: () => Field<UsageLimit[]> | null
  private readonly log: (line: string) => void
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly listeners = new Set<FleetListener>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private sessions: SessionSnapshot[] = []
  private health: SourceHealth = { source: 'agents-json', ok: false, lastOkAt: null, error: null }
  private modHealth: SourceHealth = { source: 'mod', ok: false, lastOkAt: null, error: null }
  private modFields = new Map<string, ReporterFields>()
  /** The last logged reason per ignored file, so each is logged once. */
  private readonly logged = new Map<string, string>()
  private latest: FleetSnapshot | null = null
  private readonly selfCheck: SelfCheck | null
  private readonly readChannels: FleetPollerOptions['readChannels'] | null
  private readonly readVersion: FleetPollerOptions['readVersion'] | null
  private versionReadAt = Number.NEGATIVE_INFINITY
  private rejectedEntries = 0
  private reporterFiles = new Map<string, ReporterFile>()

  constructor(opts: FleetPollerOptions) {
    this.host = opts.host
    this.readReporter = opts.readReporter ?? null
    this.readPending = opts.readPending ?? null
    this.readUsage = opts.readUsage ?? null
    this.usageFileOnly = opts.usageFileOnly === true
    this.readReport = opts.readReport ?? (() => null)
    this.readReportExtra = opts.readReportExtra ?? (() => null)
    this.log = opts.log ?? (line => console.warn(line))
    this.intervalMs = opts.intervalMs ?? 2_000
    this.now = opts.now ?? Date.now
    this.selfCheck = opts.selfCheck ?? null
    this.readChannels = opts.readChannels ?? null
    this.readVersion = opts.readVersion ?? null
  }

  subscribe(listener: FleetListener): () => void {
    this.listeners.add(listener)
    if (this.latest) listener(this.latest)
    return () => this.listeners.delete(listener)
  }

  current(): FleetSnapshot | null {
    return this.latest
  }

  start(): void {
    if (this.timer) return
    // Each poll schedules the next once it settles, so a slow `claude`
    // never has two polls in flight.
    // A poll that throws still schedules the next, so nothing stops polling for good (gate pass 15, M-2).
    const loop = async () => {
      try {
        await this.pollOnce()
      } catch (err) {
        console.warn(`fleet poll: ${message(err)}`)
      } finally {
        if (this.timer) this.timer = setTimeout(loop, this.intervalMs)
      }
    }
    this.timer = setTimeout(loop, 0)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async pollOnce(): Promise<FleetSnapshot> {
    try {
      const { sessions, rejected } = await this.host.list()
      this.sessions = sessions
      this.rejectedEntries = rejected.length
      this.health = {
        source: 'agents-json',
        ok: true,
        lastOkAt: this.now(),
        error: rejected.length ? `${rejected.length} entries unreadable: ${rejected[0]?.reason}` : null,
      }
    } catch (err) {
      this.sessions = this.sessions.map(staleAgentsJsonFields)
      this.health = { ...this.health, ok: false, error: message(err) }
    }
    await this.pollReporter()
    const listed = new Set(this.sessions.map(s => s.sessionId))
    this.usageFile = (await this.readUsage?.(listed).catch(() => null)) ?? null
    await this.runSelfCheck()
    return this.publish()
  }

  private async runSelfCheck(): Promise<void> {
    if (!this.selfCheck) return
    if (this.readVersion && this.now() - this.versionReadAt >= VERSION_EVERY_MS) {
      this.versionReadAt = this.now()
      this.selfCheck.setVersion(await this.readVersion().catch(() => null))
    }
    if (!this.health.ok) return
    this.selfCheck.evaluate({
      now: this.now(),
      sessions: this.sessions.map(s => this.withModFields(s)),
      rejectedEntries: this.rejectedEntries,
      channels: this.readChannels?.() ?? [],
      files: this.reporterFiles,
      changing: this.host.changing?.() ?? new Set(),
    })
  }

  private async pollReporter(): Promise<void> {
    if (!this.readReporter) return
    try {
      const { files, rejected } = await this.readReporter()
      this.logRejected(rejected)
      this.reporterFiles = new Map([...files].map(([id, { file }]) => [id, file]))
      this.modFields = new Map([...files].map(([id, { file, mtimeMs }]) => [id, reporterFields(file, mtimeMs)]))
      this.modHealth = {
        source: 'mod',
        ok: true,
        lastOkAt: this.now(),
        error: rejected.length ? `${rejected.length} reporter files unreadable: ${rejected[0]?.reason}` : null,
      }
    } catch (err) {
      // Keep the last fields; withModFields marks them stale.
      this.modHealth = { ...this.modHealth, ok: false, error: message(err) }
    }
  }

  private logRejected(rejected: ReporterRead['rejected']): void {
    const now = new Set(rejected.map(r => r.name))
    for (const { name, reason } of rejected) {
      if (this.logged.get(name) !== reason) this.log(`reporter: ignored ${name}: ${reason}`)
      this.logged.set(name, reason)
    }
    for (const name of this.logged.keys()) if (!now.has(name)) this.logged.delete(name)
  }

  private withModFields(s: SessionSnapshot): SessionSnapshot {
    const mod = this.modFields.get(s.sessionId)
    if (!mod) return s
    // The reporter sends only when something happens, so its age says
    // nothing. Its fields are stale when its process is gone or its source
    // failed.
    // `observedAt` is the mod's last contact; a live mod polls at least
    // every 25 s, so a minute without one means its channel is gone.
    const lastContact = mod.tokens?.observedAt ?? 0
    const stale = !this.modHealth.ok || s.pid.value === null || this.now() - lastContact > MOD_SILENCE_MS
    const pending = livePending(this.readPending?.().get(s.sessionId) ?? [], s, this.now())
    // A source the self-check found broken on this version reads stale.
    const degraded = this.selfCheck?.degradedFields(s.sessionId) ?? new Set()
    const fields = stale ? staleModFields(mod) : staleModFields(mod, degraded)
    // `blocked` with no `waitingFor` on a session awaiting its first message
    // isn't Alex's to answer: it reads idle (Research MIP2-1426). Only on the
    // mod's live word; any other such session stays Needs you.
    const firstPrompt = fields.awaitingFirstPrompt
    const waitsForFirst = !!firstPrompt?.value && !firstPrompt.stale && s.needsYou.value?.kind === 'blocked' && s.needsYou.value.detail === null && pending.length === 0
    return {
      ...s,
      ...(waitsForFirst ? { activity: { ...s.activity, value: 'idle' as const }, needsYou: { ...s.needsYou, value: null } } : {}),
      ...fields,
      pendingRequests: field(stale ? [] : pending, 'mod', this.now()),
    }
  }

  /**
   * Both windows for the meter (MIP2-1520, MIP2-1522). Claude Code's own
   * `/usage` and the governor's files come first, the newer of the two: the
   * report's time is when it was read, a file's mtime when its reading was
   * taken. A mod's `rateLimits` carry
   * its last contact, which an idle session renews every 25 s with an old
   * reading, so they're used only when no file reads, and only with a window
   * that hasn't reset. The meter never steps back to an older reading than
   * the one it shows, and holds that one while nothing new reads; the pace
   * line ages it.
   */
  private usage(sessions: SessionSnapshot[]): Field<RateLimits> | null {
    if (this.usageFileOnly) return this.usageFile
    const live = (f: Field<RateLimits> | null | undefined): f is Field<RateLimits> => !!f && !f.stale && f.value.fiveHour !== null
    const now = this.now()
    const fromMod = () =>
      sessions
        .map(s => s.rateLimits)
        .filter(live)
        .filter(f => (f.value.fiveHour?.resetsAt ?? 0) * 1000 > now)
        .sort((a, b) => b.observedAt - a.observedAt)[0] ?? null
    // Claude Code's `/usage` and the files both carry when they were read; the newer wins (MIP2-1522).
    const best = [this.readReport(), this.usageFile].filter(live).sort((a, b) => b.observedAt - a.observedAt)[0] ?? null
    const pick = best ?? fromMod()
    const last = this.lastUsage
    // A file's reading replaces a mod's whatever their times, since the two times measure different things.
    if (pick && (!last || pick.observedAt >= last.observedAt || (pick.source !== 'mod' && last.source === 'mod'))) this.lastUsage = pick
    return this.lastUsage
  }

  private publish(): FleetSnapshot {
    const sessions = this.sessions.map(s => this.withModFields(s))
    const snapshot: FleetSnapshot = {
      contractVersion: CONTRACT_VERSION,
      at: this.now(),
      sessions,
      usage: this.usage(sessions),
      ...(this.readReportExtra() ? { usageExtra: this.readReportExtra()! } : {}),
      selfCheck: this.selfCheck?.report() ?? null,
      sources: this.readReporter ? [this.health, this.modHealth] : [this.health],
    }
    this.latest = snapshot
    // One listener that throws neither stops the others nor the poll (gate pass 15, M-2).
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (err) {
        console.warn(`fleet listener: ${message(err)}`)
      }
    }
    return snapshot
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Marks every mod field stale, or only those in `only`. */
function staleModFields(mod: ReporterFields, only?: ReadonlySet<keyof ReporterFields>): ReporterFields {
  const out: ReporterFields = {}
  for (const key of Object.keys(mod) as (keyof ReporterFields)[]) {
    const f = mod[key]
    // Each key keeps its own Field type; the loop only flips `stale`.
    if (f) Object.assign(out, { [key]: !only || only.has(key) ? markStale(f as Field<unknown>) : f })
  }
  return out
}

function staleAgentsJsonFields(s: SessionSnapshot): SessionSnapshot {
  return {
    ...s,
    kind: markStale(s.kind),
    cwd: markStale(s.cwd),
    startedAt: markStale(s.startedAt),
    name: markStale(s.name),
    shortId: markStale(s.shortId),
    pid: markStale(s.pid),
    activity: markStale(s.activity),
    needsYou: markStale(s.needsYou),
  }
}
