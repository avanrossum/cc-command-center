// Validates a reporter file before anything reads it. The file is untrusted
// input (project D-015 condition 2): any process running as Alex can write it.
// A file whose header doesn't validate is rejected whole; an event that
// doesn't validate is dropped and counted.

import { REPORTER_WIRE, type AgentListEntry, type Measure, type ReporterEvent, type ReporterFile } from '../../../mod/hooks/wire.ts'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const strOrNull = (v: unknown) => v === null || isStr(v)
const numOrNull = (v: unknown) => v === null || isNum(v)
/** A field added after wire 0: absent in older files. */
const optStrOrNull = (v: unknown) => v === undefined || strOrNull(v)

/** Longest string kept from any field; longer values are cut. */
const MAX_STRING = 4096

function isMeasure(v: unknown): v is Measure {
  if (!isObj(v) || !isObj(v.context) || !isNum(v.context.window)) return false
  if (v.context.tokens !== undefined && !isNum(v.context.tokens)) return false
  if (v.context.percent !== undefined && !isNum(v.context.percent)) return false
  if (!Array.isArray(v.rateLimits)) return false
  for (const r of v.rateLimits) {
    if (!isObj(r) || !isStr(r.kind) || !isNum(r.percentUsed)) return false
    if (r.resetsAt !== undefined && !isStr(r.resetsAt)) return false
  }
  return v.cost === undefined || (isObj(v.cost) && isNum(v.cost.usd))
}

function isTokens(v: unknown): boolean {
  return isObj(v) && isNum(v.input) && isNum(v.output) && isNum(v.cacheRead) && isNum(v.cacheWrite)
}

function isAgent(v: unknown): v is AgentListEntry {
  return isObj(v) && isStr(v.id) && strOrNull(v.type) && strOrNull(v.description) && isStr(v.status) && strOrNull(v.parentId)
}

const EVENT_FIELDS: Record<ReporterEvent['type'], (e: Obj) => boolean> = {
  'session.start': e => isStr(e.model) && isStr(e.cwd) && isStr(e.version),
  'session.end': e => strOrNull(e.reason),
  'turn.start': () => true,
  'turn.step': e => isStr(e.model) && strOrNull(e.effort),
  'turn.complete': e =>
    optStrOrNull(e.answer) &&
    strOrNull(e.reason) && numOrNull(e.durationMs) && (e.usage === null || (isTokens(e.usage) && strOrNull((e.usage as Obj).model))),
  'session.measure': e => isMeasure(e.measure),
  'agent.spawn': e => strOrNull(e.spawnedId) && isStr(e.subagentType) && isStr(e.description) && strOrNull(e.model) && isBool(e.background),
  'tool.start': e => isStr(e.toolUseId) && isStr(e.tool) && strOrNull(e.path) && optStrOrNull(e.detail),
  'tool.end': e => isStr(e.toolUseId) && isStr(e.tool) && isBool(e.isError),
  'peer.sent': e => isStr(e.to) && isStr(e.preview),
  'peer.received': e => isStr(e.from) && isStr(e.preview),
  'child.started': e => isStr(e.shortId) && /^[0-9a-f]{8}$/.test(e.shortId as string) && strOrNull(e.name),
}

function isEvent(v: unknown): v is ReporterEvent {
  if (!isObj(v) || !isNum(v.seq) || !isNum(v.at) || !strOrNull(v.agentId) || !isStr(v.type)) return false
  const check = EVENT_FIELDS[v.type as ReporterEvent['type']]
  return check !== undefined && check(v)
}

/** Cuts every string in a validated value to MAX_STRING characters. */
function capStrings<T>(v: T): T {
  if (typeof v === 'string') return (v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v) as T
  if (Array.isArray(v)) return v.map(capStrings) as T
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x)])) as T
  return v
}

export interface Validated {
  file: ReporterFile
  droppedEvents: number
}

export function validateReporterFile(data: unknown): Validated {
  if (!isObj(data)) throw new Error('reporter file is not an object')
  if (data.wire !== REPORTER_WIRE) throw new Error(`reporter wire ${String(data.wire)}, expected ${REPORTER_WIRE}`)
  const { plugin, latest } = data
  if (!isStr(data.sessionId) || !/^[0-9a-f-]{36}$/.test(data.sessionId)) throw new Error('sessionId is not a session UUID')
  if (!isObj(plugin) || !isStr(plugin.name) || !isStr(plugin.version)) throw new Error('plugin is invalid')
  if (!isNum(data.loadedAt) || !isNum(data.writtenAt) || !isNum(data.seq)) throw new Error('loadedAt, writtenAt or seq is invalid')
  if (!isObj(latest) || !strOrNull(latest.model) || !strOrNull(latest.effort) || !(latest.version === undefined || isStr(latest.version))) {
    throw new Error('latest is invalid')
  }
  if (!(latest.pluginDirWatch === undefined || strOrNull(latest.pluginDirWatch))) throw new Error('latest.pluginDirWatch is invalid')
  if (!(latest.measure === null || isMeasure(latest.measure))) throw new Error('latest.measure is invalid')
  if (!Array.isArray(latest.agents) || !latest.agents.every(isAgent)) throw new Error('latest.agents is invalid')
  if (!isTokens(latest.tokens)) throw new Error('latest.tokens is invalid')
  if (!Array.isArray(data.events)) throw new Error('events is not an array')

  const events = data.events.filter(isEvent)
  const file = capStrings({ ...(data as unknown as ReporterFile), events })
  return { file, droppedEvents: data.events.length - events.length }
}
