// The reporter mod. It gathers session state and sends it to the app over
// the session's authenticated channel (D-011 item 7, MIP2-1390), relays the
// app's answers to permission and question prompts, and submits prompts the
// app relays. It writes one file of its own, the usage governor's
// `<home>/.claude/ccc/usage/<sessionId>.json` (D-011 item 9).
//
// Loaded only with `--plugin-dir` on sessions the app launches (D-011 item
// 5). Its options (socket path, secret, channel root) come from
// `pluginConfigs["ccc-reporter@inline"]` in the session's 0600 --settings
// file. This plugin ships no command hooks: plugin options are exported to a
// command hook's environment, which would expose the secret (MIP2-1376 §6).
//
// Every hook passes its event on unchanged, except PermissionRequest when the
// app answers it; then the mod builds the decision itself (channel-wire.ts).

import type { EngineInterface, Register } from 'claude-code'
import { channelCall, channelFrom, channelHello, channelSend, type Channel } from './channel.ts'
import {
  ANSWER_CHARS,
  CHANNEL_PATHS,
  CARD_EXCLUDED_TOOLS,
  buildDecision,
  cardQuestions,
  rememberable,
  type AnswerPost,
  type PermissionAnswer,
  type PermissionAsk,
  type PromptRelay,
} from './channel-wire.ts'
import { backgroundedChildren } from './children.ts'
import { finishedCallSettles } from './offers.ts'
import { governorUsage } from './usage.ts'
import {
  DETAIL_CHARS,
  PREVIEW_CHARS,
  REPORTER_EVENT_LIMIT,
  REPORTER_NAME,
  REPORTER_WIRE,
  type AgentListEntry,
  type ReporterEvent,
  type ReporterFile,
} from './wire.ts'

const VERSION = '0.7.0'
const WRITTEN_FILE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Artifact'])
/** How long a prompt is offered to the app before the mod stops asking. The dialog stays open throughout. */
const PERMISSION_WAIT_MS = 30 * 60 * 1000
/**
 * Waits between failed calls in a permission hook. `$.clock.sleep` counts
 * against the hook's 10 s budget (the types, `clock.sleep`), so the sum stays
 * well under it; after the last, the prompt goes back to the dialog alone.
 */
const PERMISSION_RETRY_MS = [250, 500, 1000, 2000]
/** tool.check ids older than this are dropped unmatched. */
const TOOL_ID_TTL_MS = 30_000

// Distributes Omit over the event union, so each variant keeps its own fields.
type EventBody = ReporterEvent extends infer E ? (E extends unknown ? Omit<E, 'seq' | 'at' | 'agentId'> : never) : never

let channel: Channel | null = null
/** tool_use_ids from tool.check, keyed by tool and input, for the PermissionRequest that follows. */
const toolIds = new Map<string, { id: string; at: number }[]>()
/** Prompts offered to the app, so a local answer can end the offer. */
const offers = new Map<string, { toolUseId: string | null; agentId: string | null; tool: string; done: boolean }>()
/** Relayed prompt ids already submitted, so a repeated delivery never submits twice. */
const relayed = new Set<string>()
let polling = false
/** While calls fail, prompt polls wait out the back-off instead of firing every second. */
let nextPollAt = 0
let pollFailures = 0
let file: ReporterFile | null = null
let usagePath: string | null = null
let cwd = ''
let writing: Promise<void> | null = null
let dirty = false
/** The last report didn't reach the app; the next call that does resends it. */
let reportOwed = false

async function setUp($: EngineInterface): Promise<ReporterFile> {
  if (file) return file
  const sessionId = await $.session.id()
  const home = (await $.env.get('HOME')) ?? ''
  cwd = await $.session.cwd()
  usagePath = `${home}/.claude/ccc/usage/${sessionId}.json`
  const now = await $.clock.now()
  file = {
    wire: REPORTER_WIRE,
    plugin: { name: REPORTER_NAME, version: VERSION },
    sessionId,
    loadedAt: now,
    writtenAt: now,
    seq: 0,
    latest: { model: null, effort: null, measure: null, agents: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    events: [],
  }
  return file
}

/** Sends the reporter file to the app. Sends that arrive during one coalesce into the next. */
function flush($: EngineInterface): Promise<void> {
  if (writing) {
    dirty = true
    return writing
  }
  writing = (async () => {
    do {
      dirty = false
      if (!file || !channel) return
      file.writtenAt = await $.clock.now()
      // A failed send is owed: the next event, or the next call that reaches
      // the app, sends the whole file again.
      reportOwed = !(await channelSend($, channel, CHANNEL_PATHS.report, file))
    } while (dirty)
  })().finally(() => {
    writing = null
  })
  return writing
}

async function emit($: EngineInterface, agentId: string | undefined, body: EventBody): Promise<void> {
  const f = await setUp($)
  f.seq += 1
  f.events.push({ seq: f.seq, at: await $.clock.now(), agentId: agentId ?? null, ...body } as ReporterEvent)
  if (f.events.length > REPORTER_EVENT_LIMIT) f.events.splice(0, f.events.length - REPORTER_EVENT_LIMIT)
  await flush($)
}

async function refreshAgents($: EngineInterface): Promise<void> {
  const f = await setUp($)
  const agents = await $.agent.list()
  f.latest.agents = agents.map(
    (a): AgentListEntry => ({
      id: a.id,
      type: a.type ?? null,
      description: a.description ?? null,
      status: String(a.status),
      parentId: a.parentId ?? null,
    }),
  )
}

const preview = (text: string) => text.slice(0, PREVIEW_CHARS)

/** The input field that names what a call works on, in the order tools use them. */
const DETAIL_KEYS = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']

function detailOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const fields = input as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const value = fields[key]
    if (typeof value === 'string' && value !== '') return value.slice(0, DETAIL_CHARS)
  }
  return null
}

const callKey = (tool: string, input: unknown) => `${tool}\u0000${JSON.stringify(input)}`

function takeToolUseId(tool: string, input: unknown, now: number): string | null {
  const key = callKey(tool, input)
  const list = (toolIds.get(key) ?? []).filter(x => now - x.at < TOOL_ID_TTL_MS)
  const first = list.shift()
  if (list.length) toolIds.set(key, list)
  else toolIds.delete(key)
  return first?.id ?? null
}

/** Ends offers the session settled without the app: the call ran, or its loop's turn ended. */
function settleOffers(match: (o: { toolUseId: string | null; agentId: string | null; tool: string }) => boolean): void {
  for (const o of offers.values()) if (match(o)) o.done = true
}

/**
 * Offers a prompt to the app and waits for its answer. Null means the app
 * gave none, and the caller leaves the dialog. The dialog is open the whole
 * time, and whichever answers first applies (hooks.md, PermissionRequest).
 */
type Answered = Extract<PermissionAnswer, { status: 'answer' }>

async function offer($: EngineInterface, ask: PermissionAsk): Promise<Answered | null> {
  const ch = channel
  if (!ch) return null
  const deadline = (await $.clock.now()) + PERMISSION_WAIT_MS
  const state = { toolUseId: ask.toolUseId, agentId: ask.agentId, tool: ask.tool, done: false }
  offers.set(ask.requestId, state)
  let retries = 0
  try {
    while ((await $.clock.now()) < deadline && !state.done) {
      const r = await channelSend($, ch, CHANNEL_PATHS.permission, ask)
      if (!r) {
        const wait = PERMISSION_RETRY_MS[retries++]
        if (wait === undefined) return null
        await $.clock.sleep(wait)
        continue
      }
      retries = 0
      const a = r.body as PermissionAnswer | undefined
      if (a?.status === 'pending') continue
      return a?.status === 'answer' ? a : null
    }
    return null
  } finally {
    offers.delete(ask.requestId)
  }
}

/** Long-polls the app for a relayed prompt and submits it as Alex's own input. */
async function pollPrompt($: EngineInterface): Promise<void> {
  if (polling || !channel) return
  const now = await $.clock.now()
  if (now < nextPollAt) return
  polling = true
  try {
    const r = await channelCall($, channel, 'GET', CHANNEL_PATHS.prompt)
    // 1 s doubling to 60 s while the app doesn't answer; back to every second once it does.
    pollFailures = r ? 0 : pollFailures + 1
    nextPollAt = r ? 0 : now + Math.min(60_000, 1000 * 2 ** Math.min(pollFailures - 1, 6))
    const relay = r?.status === 200 ? (r.body as Partial<PromptRelay> & { want?: unknown }) : undefined
    // The app is back, or started after this session: bring it up to date.
    if (r && (reportOwed || relay?.want === 'report')) {
      await setUp($)
      void flush($)
    }
    if (typeof relay?.id !== 'string' || typeof relay.text !== 'string' || relay.text === '') return
    if (!relayed.has(relay.id)) {
      relayed.add(relay.id)
      await $.prompt.submit({ text: relay.text, asUser: true })
    }
    await channelCall($, channel, 'POST', CHANNEL_PATHS.promptAck, { id: relay.id })
  } finally {
    polling = false
  }
}

// One reporter per session (D-011 item 5) is the engine's own rule: a second
// module named ccc-reporter is not loaded ("another plugin of that name loads
// first", observed on 2.1.311 with two --plugin-dir copies). D-003.
export const register: Register = (on, options) => {
  channel = channelFrom(options)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // Each poll waits for the last; the app holds each one up to 25 s.
    if (channel) $.clock.every(1000, () => void pollPrompt($))
    const version = await $.session.version()
    const f = await setUp($)
    f.latest.version = version.version
    // What this session sees for mod reloading: the app sets it off for every session it starts (gate run 2, L-3).
    f.latest.pluginDirWatch = (await $.env.get('CLAUDE_CODE_PLUGIN_DIR_WATCH')) ?? null
    await emit($, undefined, { type: 'session.start', model: await $.session.model(), cwd: e.cwd, version: version.version })
    return r
  })

  on('session.end', async ($, e, next) => {
    await emit($, undefined, { type: 'session.end', reason: e.reason ?? null })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await emit($, e.agentId, { type: 'turn.start' })
    return next(e)
  })

  // Effort and model arrive on each model request (Research, MIP2-1368 §2).
  on('turn.step', async function* ($, e, next) {
    const f = await setUp($)
    const effort = e.effort === undefined ? null : String(e.effort)
    if (!e.agentId) {
      f.latest.model = e.model
      f.latest.effort = effort
    }
    await emit($, e.agentId, { type: 'turn.step', model: e.model, effort })
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const f = await setUp($)
    const u = e.usage
    const usage = u
      ? { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, model: u.model ?? null }
      : null
    if (usage && !e.agentId) {
      const t = f.latest.tokens
      t.input += usage.input
      t.output += usage.output
      t.cacheRead += usage.cacheRead
      t.cacheWrite += usage.cacheWrite
    }
    settleOffers(o => o.agentId === (e.agentId ?? null))
    if (e.agentId) await refreshAgents($)
    const answer = !e.agentId && typeof (e as { answer?: unknown }).answer === 'string' ? (e as { answer: string }).answer.slice(0, DETAIL_CHARS) : null
    await emit($, e.agentId, { type: 'turn.complete', reason: e.reason ?? null, durationMs: e.durationMs ?? null, usage, answer })
    // The whole text goes once, apart from the report the mod resends on
    // every event: the app keeps the latest for Copy last output.
    const full = !e.agentId && typeof (e as { answer?: unknown }).answer === 'string' ? (e as { answer: string }).answer : ''
    if (full && channel) {
      const post: AnswerPost = { at: await $.clock.now(), text: full.slice(0, ANSWER_CHARS) }
      await channelSend($, channel, CHANNEL_PATHS.answer, post)
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    const f = await setUp($)
    const measure = { context: e.context, rateLimits: e.rateLimits, ...(e.cost ? { cost: e.cost } : {}) }
    f.latest.measure = measure
    await emit($, undefined, { type: 'session.measure', measure })
    const usage = governorUsage(f.sessionId, cwd, measure, `${REPORTER_NAME}@${VERSION}`)
    if (usage && usagePath) await $.fs.write(usagePath, JSON.stringify(usage))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    await refreshAgents($)
    // The spawning loop: absent for the main loop.
    await emit($, e.parentAgentId, {
      type: 'agent.spawn',
      spawnedId: r.deny === undefined ? (r.agentId ?? null) : null,
      subagentType: e.subagentType,
      description: e.description,
      model: r.deny === undefined ? r.model : null,
      background: Boolean(e.background),
    })
    return r
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
    const rawPath = WRITTEN_FILE_TOOLS.has(tool) ? (input.file_path ?? input.notebook_path) : undefined
    settleOffers(o => o.toolUseId === e.tool_use_id)
    await emit($, e.agentId, {
      type: 'tool.start',
      toolUseId: e.tool_use_id,
      tool,
      path: typeof rawPath === 'string' ? rawPath : null,
      detail: detailOf(e),
    })
    const r = await next(e)
    // Finished (PostToolUse): its offer is settled however the dialog was answered. An offer whose
    // tool_use_id couldn't be matched (null) settles with the first call of its tool to finish, so a
    // question answered in the terminal doesn't stay offered for the rest of the turn (MIP2-1492).
    settleOffers(o => finishedCallSettles(o, { toolUseId: e.tool_use_id, tool }))
    const isError = Boolean((r as { isError?: unknown }).isError)
    await emit($, e.agentId, { type: 'tool.end', toolUseId: e.tool_use_id, tool, isError })
    if (tool === 'Bash' && !isError) {
      for (const child of backgroundedChildren(r)) await emit($, e.agentId, { type: 'child.started', ...child })
    }
    return r
  })

  on('session.send', async ($, e, next) => {
    const r = await next(e)
    await emit($, e.agentId, { type: 'peer.sent', to: e.to, preview: preview(e.text) })
    return r
  })

  on('session.receive', async ($, e, next) => {
    const origin = e.origin as { kind: string; teammate?: string }
    await emit($, e.agentId, { type: 'peer.received', from: origin.teammate ?? origin.kind, preview: preview(e.text) })
    return next(e)
  })

  // Remembers each call's id for the PermissionRequest that may follow it.
  on('tool.check', async ($, e, next) => {
    if (channel && e.tool_use_id) {
      const key = callKey(String(e.tool), (e as { input?: unknown }).input)
      toolIds.set(key, [...(toolIds.get(key) ?? []), { id: e.tool_use_id, at: await $.clock.now() }])
    }
    return next(e)
  })

  // Card answers (D-010): tool permissions and single-choice questions.
  // Anything else, and any failure, leaves the dialog.
  on('classic.PermissionRequest', async ($, e, next) => {
    const ch = channel
    if (!ch || CARD_EXCLUDED_TOOLS.has(e.tool_name)) return next(e)
    const questions = e.tool_name === 'AskUserQuestion' ? cardQuestions(e.tool_input) : null
    if (e.tool_name === 'AskUserQuestion' && !questions) return next(e)
    // The app proves the secret before the request, which carries the command,
    // is sent; channelSend repeats the hello after any failure.
    if (!(await channelHello($, ch))) return next(e)
    const ask: PermissionAsk = {
      requestId: crypto.randomUUID(),
      toolUseId: takeToolUseId(e.tool_name, e.tool_input, await $.clock.now()),
      agentId: (e as { agent_id?: string }).agent_id ?? null,
      tool: e.tool_name,
      input: e.tool_input,
      questions,
      canRemember: rememberable(e.permission_suggestions, ch.channelRoot).length > 0,
    }
    const answer = await offer($, ask)
    if (!answer) {
      await channelCall($, ch, 'POST', CHANNEL_PATHS.permissionDone, { requestId: ask.requestId })
      return next(e)
    }
    let decision: ReturnType<typeof buildDecision> = null
    try {
      decision = buildDecision({ tool: e.tool_name, input: e.tool_input, suggestions: e.permission_suggestions }, answer, ch.channelRoot)
    } catch {
      decision = null
    }
    if (!decision) {
      await channelCall($, ch, 'POST', CHANNEL_PATHS.permissionDone, { requestId: ask.requestId })
      return next(e)
    }
    return { decision } as Awaited<ReturnType<typeof next>>
  })
}
