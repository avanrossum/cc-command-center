// Maps the reporter mod's telemetry to contract fields. The mod only
// gathers; deciding what is in flight, what was written and what the card
// shows happens here, so a change to the mod API is a change to the mod and
// this file (D-011 item 3). The telemetry arrives on the channel (channel/).

import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  field,
  type ContractorInfo,
  type FileWrite,
  type PeerMessage,
  type RateLimitWindow,
  type SessionSnapshot,
  type SubagentInfo,
  type ToolCallInfo,
} from '@ccc/contract'
import type { Measure, ReporterEvent, ReporterFile } from '../../../mod/hooks/wire.ts'
import { validateReporterFile, type Validated } from './reporter-schema.ts'

export type ReporterFields = Pick<
  SessionSnapshot,
  | 'model'
  | 'turn'
  | 'awaitingFirstPrompt'
  | 'effort'
  | 'context'
  | 'tokens'
  | 'costUsd'
  | 'rateLimits'
  | 'subagents'
  | 'toolCalls'
  | 'peerMessages'
  | 'filesWritten'
  | 'contractors'
>

const LEGACY_REPORTER_DIR = join(homedir(), '.claude', 'ccc', 'reporter')
const PEER_MESSAGES_KEPT = 20
const FILES_KEPT = 50

export interface ReporterRead {
  /** Keyed by sessionId; `mtimeMs` is when the app received the file. */
  files: Map<string, { file: ReporterFile; mtimeMs: number }>
  /** Reports refused, with the reason, for the source-health line and the log. */
  rejected: { name: string; reason: string }[]
}

export function parseReporterFile(text: string): Validated {
  return validateReporterFile(JSON.parse(text))
}

/**
 * Removes what the interim file transport left (app D-003, project D-015): the
 * session-named files in `~/.claude/ccc/reporter/`, then the folder if it is
 * empty. Nothing else there is touched. Telemetry now arrives on the channel.
 */
export async function removeLegacyReporterDir(dir = LEGACY_REPORTER_DIR): Promise<number> {
  let names: string[]
  try {
    const st = await lstat(dir)
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.()) return 0
    names = await readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
    const path = join(dir, name)
    const st = await lstat(path)
    if (st.isFile() && st.uid === process.getuid?.()) {
      await unlink(path)
      removed += 1
    }
  }
  if ((await readdir(dir)).length === 0) await rmdir(dir)
  return removed
}

function toWindow(limit: Measure['rateLimits'][number] | undefined): RateLimitWindow | null {
  if (!limit) return null
  const ms = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  return { usedPercent: limit.percentUsed, resetsAt: Number.isFinite(ms) ? Math.floor(ms / 1000) : null }
}

const CARD_PREVIEW_CHARS = 120

function cardPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > CARD_PREVIEW_CHARS ? `${flat.slice(0, CARD_PREVIEW_CHARS - 1)}…` : flat
}

/**
 * A received peer message arrives wrapped as
 * `<cross-session-message from="uds:…" from-name="…" …>body</cross-session-message>`
 * (observed on 2.1.311). Returns the sender's name, or its address when it
 * has none, and the body. Null when the text has no envelope.
 */
export function parseEnvelope(text: string): { from: string; name: string | null; address: string | null; body: string } | null {
  const open = /^\s*<cross-session-message\b([^>]*)>/.exec(text)
  if (!open) return null
  const attrs = open[1] ?? ''
  const attr = (key: string) => new RegExp(`(?:^|\\s)${key}="([^"]*)"`).exec(attrs)?.[1] ?? null
  const name = attr('from-name')
  const address = attr('from')
  const from = name ?? address
  if (!from) return null
  const body = text.slice(open[0].length).replace(/<\/cross-session-message>\s*$/, '').replace(/<\/cro[^>]*$/, '')
  return { from, name, address, body: body.trim() }
}

type Of<T extends ReporterEvent['type']> = Extract<ReporterEvent, { type: T }>
const ofType = <T extends ReporterEvent['type']>(events: ReporterEvent[], type: T) =>
  events.filter((e): e is Of<T> => e.type === type)

/**
 * `observedAt` is when the app last heard from the session's mod: its last
 * report or any later signed call. The mod reports changes as they happen,
 * so a quiet session's values are current as of that contact.
 */
export function reporterFields(file: ReporterFile, observedAt = file.writtenAt): ReporterFields {
  const at = observedAt
  const f = <T>(value: T) => field(value, 'mod', at)
  const { latest, events } = file
  const out: ReporterFields = {}

  if (latest.model) out.model = f(latest.model)
  if (latest.effort) out.effort = f(latest.effort)
  out.tokens = f({ ...latest.tokens })

  const measure = latest.measure
  if (measure) {
    const c = measure.context
    out.context = f({ usedTokens: c.tokens ?? null, windowTokens: c.window, percent: c.percent ?? null })
    if (measure.cost) out.costUsd = f(measure.cost.usd)
    out.rateLimits = f({
      fiveHour: toWindow(measure.rateLimits.find(r => r.kind === 'five_hour')),
      sevenDay: toWindow(measure.rateLimits.find(r => r.kind === 'seven_day')),
    })
  }

  const spawnModel = new Map(ofType(events, 'agent.spawn').map(e => [e.spawnedId, e.model]))
  out.subagents = f(
    latest.agents.map(
      (a): SubagentInfo => ({
        agentId: a.id,
        type: a.type,
        description: a.description,
        model: spawnModel.get(a.id) ?? null,
        status: a.status,
        parentAgentId: a.parentId,
      }),
    ),
  )

  // The main loop's turn: its last start, and the completion after it.
  const mainTurns = events.filter(
    (e): e is Of<'turn.start'> | Of<'turn.complete'> => (e.type === 'turn.start' || e.type === 'turn.complete') && e.agentId === null,
  )
  const lastStart = mainTurns.filter(e => e.type === 'turn.start').at(-1)
  const lastEnd = mainTurns.filter((e): e is Of<'turn.complete'> => e.type === 'turn.complete').at(-1)
  if (lastStart || lastEnd) {
    out.turn = f({
      running: !!lastStart && (!lastEnd || lastEnd.seq < lastStart.seq) && events.at(-1)?.type !== 'session.end',
      startedAt: lastStart?.at ?? null,
      endedAt: lastEnd && (!lastStart || lastEnd.seq > lastStart.seq) ? lastEnd.at : null,
      lastAnswer: lastEnd?.answer ? cardPreview(lastEnd.answer) : null,
    })
  }

  // Started without a prompt and none sent since (MIP2-1426). An event window that has
  // lost its session.start has seen turns, so the answer is no.
  const startSeq = ofType(events, 'session.start').at(-1)?.seq
  out.awaitingFirstPrompt = f(startSeq !== undefined && !events.some(e => e.type === 'turn.start' && e.agentId === null && e.seq > startSeq))

  const ended = new Set(ofType(events, 'tool.end').map(e => e.toolUseId))
  // A session that ended has nothing in flight, whatever its last events say.
  const sessionEnded = events.at(-1)?.type === 'session.end'
  out.toolCalls = f(
    sessionEnded
      ? []
      : ofType(events, 'tool.start')
          .filter(e => !ended.has(e.toolUseId))
          .map(
            (e): ToolCallInfo => ({
              toolUseId: e.toolUseId,
              tool: e.tool,
              detail: e.detail ? cardPreview(e.detail) : null,
              agentId: e.agentId,
              startedAt: e.at,
            }),
          ),
  )

  // A reply names its sender, with its socket address; a send may name only
  // the address. Map addresses to names so both sides read the same.
  const names = new Map<string, string>()
  for (const e of ofType(events, 'peer.received')) {
    const env = parseEnvelope(e.preview)
    if (env?.address && env.name) names.set(env.address, env.name)
  }
  out.peerMessages = f(
    events
      .filter((e): e is Of<'peer.sent'> | Of<'peer.received'> => e.type === 'peer.sent' || e.type === 'peer.received')
      .slice(-PEER_MESSAGES_KEPT)
      .map((e): PeerMessage => {
        if (e.type === 'peer.sent') return { direction: 'sent', peer: names.get(e.to) ?? e.to, at: e.at, preview: cardPreview(e.preview) }
        const envelope = parseEnvelope(e.preview)
        return { direction: 'received', peer: envelope?.from ?? e.from, at: e.at, preview: cardPreview(envelope?.body ?? e.preview) }
      }),
  )

  // A file counts as written once its tool call ends without an error.
  const succeeded = new Set(ofType(events, 'tool.end').filter(e => !e.isError).map(e => e.toolUseId))
  const writes = new Map<string, FileWrite>()
  for (const e of ofType(events, 'tool.start')) {
    if (e.path && succeeded.has(e.toolUseId)) {
      writes.delete(e.path)
      writes.set(e.path, { path: e.path, tool: e.tool, at: e.at, url: null })
    }
  }
  out.filesWritten = f([...writes.values()].slice(-FILES_KEPT))

  const children = new Map<string, ContractorInfo>()
  for (const e of ofType(events, 'child.started')) children.set(e.shortId, { shortId: e.shortId, name: e.name, startedAt: e.at })
  if (children.size) out.contractors = f([...children.values()])

  return out
}
