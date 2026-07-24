// Demo / fixture mode (CCC_DEMO=1). Renders a curated, innocuous fake fleet so
// marketing screenshots and short videos never expose real conversations or client
// data. Pure functions of elapsed demo time: pausing the demo clock freezes a clean
// still; letting it run animates the fleet (states change, the overview reorders,
// the needs-you bar updates). index.ts owns the app types and converts these plain
// shapes into the real Snapshot, so this file has no imports from index (no cycle).
//
// Nothing here runs unless CCC_DEMO is set, and in that mode the app also points at
// a throwaway userData profile — the real registry is never loaded.

export const DEMO_ON = !!process.env.CCC_DEMO

export interface DemoCategory {
  id: number
  name: string
  color: string
  sort: number
  label: string
  emoji: string
}
export interface DemoEdge {
  child_id: string
  parent_id: string
  type: 'blocking' | 'tangential'
}
export interface DemoSession {
  sessionId: string
  name: string
  cwd: string
  categoryId: number
  state: 'working' | 'waiting' | 'idle' | 'unknown'
  attention?: 'permission' | 'question'
  whyKind?: 'permission' | 'question' | 'done'
  why?: string
  contextPct: number
}

const LOOP_MS = 48_000 // the fleet's scripted timeline repeats on this period

export function demoCategories(): DemoCategory[] {
  return [
    { id: 1, name: 'Personal', color: '#e2b34a', sort: 0, label: 'personal', emoji: '🏠' },
    { id: 2, name: 'Acme Co', color: '#4ac0e2', sort: 1, label: 'acme', emoji: '💼' },
    { id: 3, name: 'Beta Labs', color: '#9b6ff0', sort: 2, label: 'beta', emoji: '🧪' },
  ]
}

// The Acme migration is a parent with a blocking child (schema-fix) and a
// tangential offshoot (docs-pass). While the blocking child works, the parent
// reads as "blocked" in the UI (derived from these edges + the child's state).
export function demoEdges(): DemoEdge[] {
  return [
    { child_id: 'd-schema', parent_id: 'd-migrate', type: 'blocking' },
    { child_id: 'd-docs', parent_id: 'd-migrate', type: 'tangential' },
  ]
}

interface Beat {
  at: number // seconds into the loop this state begins
  state: DemoSession['state']
  attention?: DemoSession['attention']
  whyKind?: DemoSession['whyKind']
  why?: string
}
// The last beat whose `at` has passed, wrapping at LOOP_MS.
function beatAt(beats: Beat[], tSec: number): Beat {
  let cur = beats[0]
  for (const b of beats) if (b.at <= tSec) cur = b
  return cur
}

interface Cast {
  sessionId: string
  name: string
  cwd: string
  categoryId: number
  contextPct: number
  beats: Beat[]
}

// The cast. Names, folders, and "why" text are deliberately mundane and generic —
// nothing that looks like a real client or a real conversation.
const CAST: Cast[] = [
  {
    sessionId: 'd-blog',
    name: 'blog-redesign',
    cwd: '~/dev/personal/blog',
    categoryId: 1,
    contextPct: 34,
    beats: [
      { at: 0, state: 'working' },
      { at: 12, state: 'waiting' }, // soft "your turn" for a beat
      { at: 19, state: 'working' },
    ],
  },
  {
    sessionId: 'd-recipes',
    name: 'recipe-scraper',
    cwd: '~/dev/personal/recipes',
    categoryId: 1,
    contextPct: 47,
    beats: [
      {
        at: 0,
        state: 'waiting',
        whyKind: 'question',
        why: 'Dedupe recipes by source URL or by normalized title?',
      },
    ],
  },
  {
    sessionId: 'd-migrate',
    name: 'acme-api-migration',
    cwd: '~/dev/acme/api',
    categoryId: 2,
    contextPct: 63,
    beats: [{ at: 0, state: 'working' }], // reads "blocked" while its child works
  },
  {
    sessionId: 'd-schema',
    name: 'acme-schema-fix',
    cwd: '~/dev/acme/api',
    categoryId: 2,
    contextPct: 71,
    beats: [
      { at: 0, state: 'working' },
      // 'idle' (not 'waiting') so a DONE blocking child stops blocking its parent —
      // the blocked derivation keys on working/waiting, matching the real engine.
      { at: 31, state: 'idle', whyKind: 'done', why: 'done' }, // finishes → parent unblocks
    ],
  },
  {
    sessionId: 'd-docs',
    name: 'acme-docs-pass',
    cwd: '~/dev/acme/api',
    categoryId: 2,
    contextPct: 22,
    beats: [{ at: 0, state: 'idle', whyKind: 'done', why: 'done' }],
  },
  {
    sessionId: 'd-billing',
    name: 'acme-billing-report',
    cwd: '~/dev/acme/reports',
    categoryId: 2,
    contextPct: 55,
    beats: [
      { at: 0, state: 'working' },
      {
        at: 7,
        state: 'working',
        attention: 'permission',
        why: 'npm run report:generate -- --client acme --month current',
      },
      { at: 24, state: 'working' }, // approved → back to work
    ],
  },
  {
    sessionId: 'd-embed',
    name: 'beta-embeddings',
    cwd: '~/dev/beta/embeddings',
    categoryId: 3,
    contextPct: 12,
    beats: [
      { at: 0, state: 'working' },
      { at: 37, state: 'idle' },
      { at: 45, state: 'working' },
    ],
  },
  {
    sessionId: 'd-eval',
    name: 'beta-eval-harness',
    cwd: '~/dev/beta/eval',
    categoryId: 3,
    contextPct: 8,
    beats: [{ at: 0, state: 'idle' }],
  },
  {
    sessionId: 'd-tuning',
    name: 'beta-prompt-tuning',
    cwd: '~/dev/beta/tuning',
    categoryId: 3,
    contextPct: 41,
    beats: [{ at: 0, state: 'waiting' }], // soft your-turn, no question
  },
]

export function demoFleet(elapsedMs: number): DemoSession[] {
  const tSec = (elapsedMs % LOOP_MS) / 1000
  return CAST.map((c) => {
    const b = beatAt(c.beats, tSec)
    return {
      sessionId: c.sessionId,
      name: c.name,
      cwd: c.cwd,
      categoryId: c.categoryId,
      contextPct: c.contextPct,
      state: b.state,
      attention: b.attention,
      whyKind: b.whyKind,
      why: b.why,
    }
  })
}

// Account-wide usage for the beacon readout — a slow ramp so the meter looks live.
export function demoUsage(
  elapsedMs: number,
  now: number,
): { fiveHour: { pct: number; resetsAt: number }; sevenDay: { pct: number; resetsAt: number } } {
  const frac = (elapsedMs % LOOP_MS) / LOOP_MS
  // resetsAt is unix SECONDS (matches the real statusLine payload) — the renderer
  // does resetsAt * 1000 - now, so seconds here, not milliseconds.
  const inSec = (hours: number): number => Math.floor((now + hours * 3600_000) / 1000)
  return {
    fiveHour: { pct: Math.round(24 + frac * 14), resetsAt: inSec(2.5) },
    sevenDay: { pct: Math.round(51 + frac * 4), resetsAt: inSec(40) },
  }
}

// Short, innocuous output tails for the overview grid thumbnails.
const PEEK: Record<string, string[]> = {
  'd-blog': ['· Rewrote the hero section', '· Updated the CSS grid', '  Working on the nav…'],
  'd-recipes': ['Parsed 214 recipes', '', 'Dedupe recipes by source URL or', 'by normalized title?'],
  'd-migrate': ['Waiting on schema-fix to land', 'before running the migration.'],
  'd-schema': ['· Added the users.email index', '· Backfilling in batches of 500', '  batch 6/9…'],
  'd-docs': ['Regenerated the API reference.', '', '✓ done — your move'],
  'd-billing': [
    'Ready to generate the report.',
    '',
    'Run: npm run report:generate',
    '  1. Yes   2. Yes, always   3. No',
  ],
  'd-embed': ['· Chunked 1,204 docs', '· Embedding at 240 chunks/s', '  38% complete…'],
  'd-eval': ['Eval harness idle.', 'Awaiting the next run.'],
  'd-tuning': ['Tried 4 prompt variants.', '', 'Which direction should I take next?'],
}
export function demoPeek(
  sessionIds: string[],
  elapsedMs: number,
): { sessionId: string; tail: string }[] {
  // A moving caret so the thumbnails read as live rather than frozen.
  const caret = (elapsedMs % 1000) < 500 ? '▍' : ' '
  return sessionIds.map((id) => {
    const lines = PEEK[id] ?? ['…']
    return { sessionId: id, tail: lines.join('\r\n') + caret }
  })
}

// A canned session transcript to paint into the main terminal when a demo tile is
// opened. Kept generic and innocuous. \x1b codes give it a little color like the
// real TUI. index.ts streams this in chunks for a typewriter effect on video.
export function demoTerminal(sessionId: string): string {
  const c = CAST.find((x) => x.sessionId === sessionId)
  const name = c?.name ?? sessionId
  const cwd = c?.cwd ?? '~/dev'
  const G = '\x1b[38;5;114m' // green
  const D = '\x1b[38;5;244m' // dim
  const R = '\x1b[0m'
  const body =
    PEEK[sessionId]?.join('\r\n') ?? 'Working on it…'
  return [
    `${D}╭──────────────────────────────────────────────╮${R}`,
    `${D}│${R} ${G}Claude Code${R}  ${D}·${R} ${name}                       ${D}│${R}`,
    `${D}│${R} ${D}${cwd}${R}                          ${D}│${R}`,
    `${D}╰──────────────────────────────────────────────╯${R}`,
    '',
    `${D}›${R} pick up where we left off`,
    '',
    body,
    '',
    `${D}›${R} ${'▍'}`,
    '',
  ].join('\r\n')
}
