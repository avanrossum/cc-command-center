import fs from 'node:fs'
import path from 'node:path'

// Fleet activity: the subagents a session has spawned, from two sources.
//
// 1. THE TRANSCRIPT. A subagent started with the Agent/Task tool is a `tool_use`
//    block in the main transcript; its `input.description` is the "what it's
//    working on", and a later `tool_result` with the same id means done.
//
// 2. WORKFLOW JOURNALS. The Workflow tool does NOT record its agents as Agent
//    tool_use blocks — it shows one `Workflow` tool_use, and its agents live in
//    `<session>/subagents/workflows/wf_*/`. Each run has a `journal.jsonl`
//    (a `started` then a `result` line per agent — result present = done) and a
//    per-agent `agent-<id>.jsonl` whose first user message is the agent's prompt.
//    Reading the transcript alone misses every workflow agent, which is why a
//    session that ran a workflow showed nothing.
//
// 3. BACKGROUND SHELL TASKS (`Bash` with run_in_background). A `Bash` tool_use
//    with `input.run_in_background === true`; its IMMEDIATE tool_result is the
//    LAUNCH — "Command running in background with ID: <id>" — NOT completion, so
//    a shell task is never marked done just because a result exists. Completion
//    is a later `<task-notification>` (a user message) carrying `<task-id>` +
//    `<status>` (completed / failed / killed / stopped). Verified against real
//    CLI sessions (2026-07-22), not just Desktop.
//
// All of this is confirmed against real files (2026-07-20). Notable traps found
// by looking rather than assuming: the tool is named `Agent` (not `Task`) here;
// `message.content` is a bare string ~4% of the time, not always a list; the
// journal's `key` is a content hash, NOT the human label — the useful
// description is the agent's first user message.

export type SubtaskStatus = 'running' | 'done' | 'stalled' | 'failed'
export type SubtaskSource = 'task' | 'workflow' | 'shell'

export interface SubtaskInfo {
  id: string // tool_use id (task) or agentId (workflow) or bg task id (shell)
  description: string
  subagentType?: string
  background: boolean
  source: SubtaskSource
  status: SubtaskStatus
  startedAt?: number
}

// One workflow RUN, summarized as a single rich entry (not per-agent rows). Name
// + description come from the run's persisted script; agent progress from its
// journal. Per-phase progress and token/duration totals are NOT here: they live
// only in the running app's memory (the journal/agent files carry no phase field
// and no usage), so they can't be reconstructed from disk.
export interface WorkflowInfo {
  runId: string
  name: string
  description?: string
  agentTotal: number
  agentDone: number
  status: 'running' | 'done'
  startedAt?: number
}

const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])
const STALLED_MS = 5 * 60 * 1000
// Bound the transcript scan. Covers the 99th-percentile transcript (~4.4MB
// measured across 1834 real transcripts; median 73KB). A subagent whose entire
// lifecycle predates the window is omitted, never mislabelled — a tool_use and
// its tool_result both fall after the window start.
const MAX_SCAN_BYTES = 8 * 1024 * 1024
// Per session, across both sources, so a 100-agent workflow can't flood the panel.
const MAX_SUBTASKS = 40

// ---- transcript (Agent/Task tool) -----------------------------------------

interface TxCache {
  mtimeMs: number
  size: number
  tasks: { info: SubtaskInfo; mtimeMs: number }[]
}
const txCache = new Map<string, TxCache>()

function tsToMs(ts: unknown): number | undefined {
  if (typeof ts !== 'string') return undefined
  const n = Date.parse(ts)
  return Number.isFinite(n) ? n : undefined
}

// Map a task-notification <status> to a terminal SubtaskStatus. completed/stopped
// ended cleanly enough to read as done; failed/killed are the awareness signal.
function notifStatus(s: string): SubtaskStatus {
  return s === 'failed' || s === 'killed' ? 'failed' : 'done'
}

// A readable label for a shell command: first line, with leading `cd …;` and
// `source …;` boilerplate stripped so the real command (e.g. `npm run dev`)
// leads instead of a long path. Falls back to the raw first line.
function commandLabel(cmd: string): string {
  let s = cmd.split('\n')[0].trim()
  s = s.replace(/^(?:cd\s+[^;]+;\s*)+/, '')
  s = s.replace(/^(?:source\s+[^;]+;\s*)+/, '')
  return s.trim() || cmd.split('\n')[0].trim()
}

// A tool_result's content is a string, or an array of {type:'text', text} blocks.
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' ? ((b as { text?: string }).text ?? '') : ''))
      .join(' ')
  }
  return ''
}

function readWindow(path: string, size: number, maxBytes: number): { buf: string; from: number } | null {
  const from = Math.max(0, size - maxBytes)
  try {
    const fd = fs.openSync(path, 'r')
    try {
      const len = size - from
      const b = Buffer.alloc(len)
      fs.readSync(fd, b, 0, len, from)
      return { buf: b.toString('utf8'), from }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

function scanTranscript(transcriptPath: string): { info: SubtaskInfo; mtimeMs: number }[] {
  let stat: fs.Stats
  try {
    stat = fs.statSync(transcriptPath)
  } catch {
    txCache.delete(transcriptPath)
    return []
  }
  const cached = txCache.get(transcriptPath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.tasks

  const win = readWindow(transcriptPath, stat.size, MAX_SCAN_BYTES)
  if (!win) return cached?.tasks ?? []
  const lines = win.buf.split('\n')
  const start = win.from > 0 ? 1 : 0 // partial first line when we started mid-file
  const uses = new Map<string, SubtaskInfo>()
  const doneIds = new Set<string>()
  // Background shell tasks: captured by tool_use, linked to a durable task id via
  // the launch tool_result, and marked terminal only by a later task-notification.
  const shellUses = new Map<string, { command: string; startedAt?: number }>() // toolu id → shell
  const toolToTaskId = new Map<string, string>() // toolu id → background task id
  const taskStatus = new Map<string, SubtaskStatus>() // task id → terminal status
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    // A completion notice is a plain-string user message, skipped by the array
    // check below, so read its terminal status straight off the raw line.
    if (line.includes('task-notification')) {
      const m = line.match(/<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([a-z]+)<\/status>/)
      if (m) taskStatus.set(m[1], notifStatus(m[2]))
    }
    let r: Record<string, unknown>
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const content = (r.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type === 'tool_use' && AGENT_TOOL_NAMES.has(b.name as string)) {
        const id = b.id as string
        if (!id) continue
        const input = (b.input ?? {}) as Record<string, unknown>
        uses.set(id, {
          id,
          description: (input.description as string) || 'subagent',
          subagentType: input.subagent_type as string | undefined,
          background: input.run_in_background === true,
          source: 'task',
          status: 'running',
          startedAt: tsToMs(r.timestamp),
        })
      } else if (b.type === 'tool_use' && b.name === 'Bash') {
        const input = (b.input ?? {}) as Record<string, unknown>
        const id = b.id as string
        if (id && input.run_in_background === true) {
          shellUses.set(id, {
            command: commandLabel((input.command as string) || 'shell task'),
            startedAt: tsToMs(r.timestamp),
          })
        }
      } else if (b.type === 'tool_result') {
        const tid = b.tool_use_id as string | undefined
        if (tid) doneIds.add(tid)
        // Link a background launch ack to its durable id, so completion comes from
        // the task-notification — NOT this immediate ack. Two launch shapes: Bash
        // ("Command running in background with ID: X") and a backgrounded Agent
        // ("Async agent launched successfully … agentId: X"). The agentId is used
        // only as an internal status key here, never surfaced to the user.
        const rc = resultText(b.content)
        const m =
          rc.match(/running in background with ID:\s*([A-Za-z0-9]+)/) ||
          rc.match(/Async agent launched successfully[\s\S]*?agentId:\s*([A-Za-z0-9]+)/)
        if (m && tid) toolToTaskId.set(tid, m[1])
      }
    }
  }
  // A background subtask's terminal status is its task-notification, never the
  // immediate launch ack — otherwise every backgrounded agent/task reads 'done'
  // the instant it starts. A foreground agent still completes on tool_result.
  const statusOf = (info: SubtaskInfo): SubtaskStatus => {
    if (info.background) {
      const linked = toolToTaskId.get(info.id)
      return (linked && taskStatus.get(linked)) || 'running'
    }
    return doneIds.has(info.id) ? 'done' : 'running'
  }
  const tasks: { info: SubtaskInfo; mtimeMs: number }[] = [...uses.values()].map((info) => ({
    info: { ...info, status: statusOf(info) },
    mtimeMs: stat.mtimeMs,
  }))
  // Fold in background shell tasks. Identity is the durable task id (matches the
  // .output file) when known; status comes ONLY from the notification, so a
  // long-running dev server stays 'running' — never 'done' from the launch result.
  for (const [tooluId, u] of shellUses) {
    const taskId = toolToTaskId.get(tooluId)
    tasks.push({
      info: {
        id: taskId || tooluId,
        description: u.command.slice(0, 90),
        background: true,
        source: 'shell',
        status: (taskId && taskStatus.get(taskId)) || 'running',
        startedAt: u.startedAt,
      },
      mtimeMs: stat.mtimeMs,
    })
  }
  txCache.set(transcriptPath, { mtimeMs: stat.mtimeMs, size: stat.size, tasks })
  return tasks
}

// ---- workflow summaries ----------------------------------------------------

interface WfSummaryCache {
  sig: string
  summaries: WorkflowInfo[]
}
const wfSummaryCache = new Map<string, WfSummaryCache>()

// name / description from a workflow script's meta block (near the top of the file).
function readScriptMeta(scriptPath: string): { name?: string; description?: string } {
  let head: string
  try {
    const fd = fs.openSync(scriptPath, 'r')
    try {
      const b = Buffer.alloc(4096)
      const n = fs.readSync(fd, b, 0, 4096, 0)
      head = b.toString('utf8', 0, n)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return {}
  }
  const name = head.match(/name:\s*'([^']*)'/)?.[1] || head.match(/name:\s*"([^"]*)"/)?.[1]
  const description =
    head.match(/description:\s*'([^']*)'/)?.[1] || head.match(/description:\s*"([^"]*)"/)?.[1]
  return { name, description }
}

// runId -> script path from <session>/workflows/scripts. A script filename ends
// with its runId (...-<runId>.js), which is the run dir's basename.
function scriptsByRunId(sessionDir: string): Map<string, string> {
  const dir = path.join(sessionDir, 'workflows', 'scripts')
  const m = new Map<string, string>()
  try {
    for (const f of fs.readdirSync(dir)) {
      const runId = f.endsWith('.js') ? f.match(/(wf_[A-Za-z0-9-]+)\.js$/)?.[1] : undefined
      if (runId) m.set(runId, path.join(dir, f))
    }
  } catch {
    /* no scripts dir */
  }
  return m
}

// One WorkflowInfo per workflow RUN: agent progress from the journal, name +
// description from the run's script. mtime-cached by run-dir signature.
export function scanWorkflowSummaries(transcriptPath: string, now = Date.now()): WorkflowInfo[] {
  const sessionDir = transcriptPath.replace(/\.jsonl$/, '')
  const root = path.join(sessionDir, 'subagents', 'workflows')
  let runDirs: { runId: string; dir: string }[]
  try {
    runDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ runId: e.name, dir: path.join(root, e.name) }))
  } catch {
    wfSummaryCache.delete(transcriptPath)
    return [] // no workflows dir — the common case
  }

  // Signature: journal growth (completion) or a new agent file (spawn) changes it,
  // so the cache invalidates exactly when progress could have changed.
  const parts: string[] = []
  const runData: {
    runId: string
    journals: string[]
    agentTotal: number
    startedAt: number
    lastActivity: number
  }[] = []
  for (const { runId, dir } of runDirs) {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    const journals: string[] = []
    let agentTotal = 0
    let startedAt = 0
    let lastActivity = 0 // newest mtime in the run — for staleness (ended vs running)
    for (const name of entries) {
      const full = path.join(dir, name)
      const bump = (mt: number): void => {
        if (mt > lastActivity) lastActivity = mt
      }
      if (name === 'journal.jsonl') {
        journals.push(full)
        try {
          const st = fs.statSync(full)
          parts.push(`${full}:${st.mtimeMs}:${st.size}`)
          bump(st.mtimeMs)
        } catch {
          /* gone */
        }
      } else if (name.startsWith('agent-') && name.endsWith('.jsonl')) {
        agentTotal++
        parts.push(full)
        try {
          const mt = fs.statSync(full).mtimeMs
          if (!startedAt || mt < startedAt) startedAt = mt
          bump(mt)
        } catch {
          /* gone */
        }
      }
    }
    runData.push({ runId, journals, agentTotal, startedAt, lastActivity })
  }
  const sig = parts.sort().join('|')
  const cached = wfSummaryCache.get(transcriptPath)
  if (cached && cached.sig === sig) return cached.summaries

  const scripts = scriptsByRunId(sessionDir)
  const summaries: WorkflowInfo[] = []
  for (const { runId, journals, agentTotal, startedAt, lastActivity } of runData) {
    const doneAgentIds = new Set<string>()
    for (const j of journals) {
      let buf: string
      try {
        buf = fs.readFileSync(j, 'utf8')
      } catch {
        continue
      }
      for (const line of buf.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const o = JSON.parse(t) as { type?: string; agentId?: string }
          if (o.type === 'result' && o.agentId) doneAgentIds.add(o.agentId)
        } catch {
          /* skip */
        }
      }
    }
    // Cap done at total so progress never reads > 100%.
    const agentDone = Math.min(doneAgentIds.size, agentTotal)
    const meta = scripts.has(runId) ? readScriptMeta(scripts.get(runId)!) : {}
    // Done when every agent resolved, OR when the run has been idle past the stall
    // window — a workflow whose retried/killed agents never got a result line would
    // otherwise read 'running' forever. Only a genuinely active run keeps churning.
    const allResolved = agentTotal > 0 && agentDone >= agentTotal
    const stale = lastActivity > 0 && now - lastActivity > STALLED_MS
    summaries.push({
      runId,
      name: meta.name || 'workflow',
      description: meta.description,
      agentTotal,
      agentDone,
      status: allResolved || stale ? 'done' : 'running',
      startedAt: startedAt || undefined,
    })
  }
  summaries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  wfSummaryCache.set(transcriptPath, { sig, summaries })
  return summaries
}

// ---- public ----------------------------------------------------------------

// A running subtask whose source file hasn't advanced for STALLED_MS reads as
// stalled — the run was likely interrupted. NOT applied to shell tasks: a healthy
// long-running one (a dev server) sits quiet with the transcript unchanged for
// hours, so its liveness is the presence/absence of a completion notification,
// not file mtime.
function applyStall(entry: { info: SubtaskInfo; mtimeMs: number }, now: number): SubtaskInfo {
  if (
    entry.info.source !== 'shell' &&
    entry.info.status === 'running' &&
    now - entry.mtimeMs > STALLED_MS
  ) {
    return { ...entry.info, status: 'stalled' }
  }
  return entry.info
}

export function scanSubtasks(transcriptPath: string, now = Date.now()): SubtaskInfo[] {
  const merged = scanTranscript(transcriptPath)
  const out = merged
    .map((e) => applyStall(e, now))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  return out.slice(0, MAX_SUBTASKS)
}

export function forgetSubtasks(transcriptPath: string): void {
  txCache.delete(transcriptPath)
  wfSummaryCache.delete(transcriptPath)
}
