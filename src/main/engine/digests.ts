// Digest feeds — the consumer side of the `ccc.feed.item/v1` contract.
//
// A producer is an unattended job that decides something deserves attention and writes
// JSON files into `~/.claude/ccc/feeds/<source>/`. This module reads that directory and
// nothing else. Neither side imports the other; the filesystem is the whole interface,
// which is what lets a producer that did not exist when this was written show up here
// with no change.
//
// Rules taken from the contract, each of which fails QUIETLY if ignored:
//   - Discover sources by LISTING the feeds directory. Never hardcode a source name.
//   - Ignore `*.tmp` — those are mid-write.
//   - Ignore items whose `schema` is unrecognised rather than best-effort parsing them.
//     A future v2 changes field meanings, and guessing displays wrong information
//     confidently.
//   - Sort on `occurred_at` (when the thing happened), NOT `created_at` (when the
//     producer noticed). Verified against a real feed: a source backfilling six days
//     emits items whose occurred_at is far older than created_at, and sorting on the
//     wrong one makes a backfill look like everything happened at once.
//   - `score` and `severity` are alternatives; either may be null.
//   - `actions` are HINTS, not commands. Nothing here executes a value, ever.
//   - Never read `~/.claude/digests/` — producer-private, holds spend ledgers and
//     credential-adjacent config.
//   - An empty source directory is healthy and means "nothing to surface".
import { readdirSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import os from 'node:os'

export const FEED_SCHEMA = 'ccc.feed.item/v1'

// Consumer-owned except for `unread`, which only a producer sets, and only on first
// emission. A producer re-emitting an existing id must preserve whatever we wrote here.
export type DigestState = 'unread' | 'read' | 'dismissed' | 'kept' | 'actioned'
const STATES = new Set<string>(['unread', 'read', 'dismissed', 'kept', 'actioned'])

export interface DigestAction {
  label: string
  kind: string // an OPEN set — render the kinds we support, ignore the rest
  value: string
}

export interface DigestItem {
  id: string
  source: string
  file: string // absolute path, so the verdict can be written back
  createdAt: string
  updatedAt: string
  occurredAt: string
  occurredMs: number // parsed once, for sorting
  state: DigestState
  title: string
  summary: string
  bodyMd: string
  score: number | null
  severity: string | null
  tags: string[]
  actions: DigestAction[]
  meta: Record<string, unknown>
}

export interface DigestSource {
  name: string
  dir: string
  items: DigestItem[]
  unread: number
  /** Registered but unreadable — surfaced rather than hidden, so a broken path is
   *  visible instead of looking like a healthy empty source. */
  error?: string
}

export function defaultFeedsRoot(): string {
  return join(os.homedir(), '.claude', 'ccc', 'feeds')
}

// An item file, as opposed to the change log or a half-written temp file. index.jsonl
// is a change log that may hold stale duplicate lines; the item files are the truth.
export function isItemFile(name: string): boolean {
  return name.endsWith('.json') && !name.endsWith('.tmp') && !name.includes('.tmp.')
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

// Parse one item, or return undefined. Strict about `schema`, lenient about everything
// optional: the contract says every display field may be absent, so a sparse item must
// still render rather than disappear.
export function parseItem(raw: unknown, file: string): DigestItem | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (o.schema !== FEED_SCHEMA) return undefined // unknown version — do not guess
  const id = str(o.id)
  const title = str(o.title)
  if (!id || !title) return undefined // the two fields with nothing to fall back to
  const state = (STATES.has(str(o.state)) ? o.state : 'unread') as DigestState
  // occurred_at is the sort key. Fall back through the other stamps rather than
  // dropping an item that omitted it.
  const occurredAt = str(o.occurred_at) || str(o.created_at) || str(o.updated_at)
  const t = Date.parse(occurredAt)
  const score = typeof o.score === 'number' && Number.isFinite(o.score) ? o.score : null
  const severity = str(o.severity) || null
  return {
    id,
    source: str(o.source),
    file,
    createdAt: str(o.created_at),
    updatedAt: str(o.updated_at),
    occurredAt,
    occurredMs: Number.isFinite(t) ? t : 0,
    state,
    title,
    summary: str(o.summary),
    bodyMd: str(o.body_md),
    // Setting both is a producer bug the contract warns about. Prefer severity — the
    // risk-shaped one — and drop the ambiguous score rather than sorting on a coin flip.
    score: severity ? null : score,
    severity,
    tags: Array.isArray(o.tags) ? o.tags.filter((x): x is string => typeof x === 'string') : [],
    actions: Array.isArray(o.actions)
      ? o.actions.flatMap((a): DigestAction[] => {
          if (!a || typeof a !== 'object') return []
          const r = a as Record<string, unknown>
          const label = str(r.label)
          const kind = str(r.kind)
          const value = str(r.value)
          return label && kind && value ? [{ label, kind, value }] : []
        })
      : [],
    meta: o.meta && typeof o.meta === 'object' ? (o.meta as Record<string, unknown>) : {},
  }
}

// Most recent first, by when the THING happened.
export function compareItems(a: DigestItem, b: DigestItem): number {
  return b.occurredMs - a.occurredMs || a.id.localeCompare(b.id)
}

// Still worth the human's attention. `dismissed` and `actioned` are finished; `kept` is
// a working set and stays visible.
export function isOpenItem(i: DigestItem): boolean {
  return i.state !== 'dismissed' && i.state !== 'actioned'
}

export function readSource(dir: string, name: string, cap = 500): DigestSource {
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(isItemFile)
  } catch (e) {
    return { name, dir, items: [], unread: 0, error: String((e as Error)?.message ?? e) }
  }
  const items: DigestItem[] = []
  for (const n of names) {
    const file = join(dir, n)
    try {
      // One malformed item must never take the whole source down.
      const item = parseItem(JSON.parse(readFileSync(file, 'utf8')), file)
      if (item) items.push(item)
    } catch {
      /* mid-write, malformed, or unreadable — skip it this pass */
    }
  }
  items.sort(compareItems)
  return {
    name,
    dir,
    items: items.slice(0, cap),
    unread: items.filter((i) => i.state === 'unread').length,
  }
}

// Every source: the standard tree, plus any directory the user added by hand.
export function readAllSources(extraDirs: string[] = [], root = defaultFeedsRoot()): DigestSource[] {
  const out: DigestSource[] = []
  const seen = new Set<string>()
  let discovered: string[] = []
  try {
    discovered = readdirSync(root).filter((n) => {
      try {
        return statSync(join(root, n)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    /* no feeds tree yet — the normal state before any producer has run */
  }
  for (const n of discovered.sort()) {
    const dir = join(root, n)
    seen.add(dir)
    out.push(readSource(dir, n))
  }
  for (const dir of extraDirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    out.push(readSource(dir, basename(dir) || dir))
  }
  return out
}

// Record the human's verdict. This is the ONLY write a consumer makes into the feed
// tree, and it is atomic (temp + rename) so a producer reading concurrently never sees
// a half file. Only `state` and `updated_at` move; every other field is preserved.
export function writeItemState(file: string, state: DigestState, nowIso: string): boolean {
  const tmp = `${file}.ccc-tmp`
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (raw.schema !== FEED_SCHEMA) return false
    raw.state = state
    raw.updated_at = nowIso
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`)
    renameSync(tmp, file)
    return true
  } catch {
    try {
      unlinkSync(tmp) // never leave a temp file behind to be mistaken for an item
    } catch {
      /* nothing more to do */
    }
    return false
  }
}
