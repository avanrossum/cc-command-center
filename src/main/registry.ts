import Database from 'better-sqlite3'

// Persistent registry: maps each stable Claude session id to a "node" that
// carries the command center's own metadata (category now; typed parent/child
// edges next). Survives app restarts. The live coarse state is NOT stored here
// — that comes from the engine each scan.

let db: Database.Database | null = null

export interface Category {
  id: number
  name: string
  color: string
  sort: number
  label: string | null // short rail word; null → auto-derived from the name
  emoji: string | null // optional glyph shown in the rail and on cross-category tags
  // Privacy gate for the Arbiter. 0 (default) → only metadata about this
  // category's sessions may be sent to the API; 1 → the substance may go too.
  // Opt-in by design: an untouched category never leaks session content.
  arbiter_context: number
}

export interface NodeRow {
  session_id: string
  cwd: string | null
  name: string | null
  category_id: number | null
  origin: string | null
  first_seen: number
  last_seen: number
  theme: string | null
  // Scrollback is stored but intentionally NOT loaded by getNodeMap (it is large
  // and the scan runs every ~1.5s); fetch it on demand with getScrollback.
  scrollback?: string | null
  scrollback_at?: number | null
}

// Distinct 10-hue category palette (Claude Design kit) — deliberately spread so
// two categories never read as the same color; never a status hue.
const PALETTE = [
  '#e2b34a', // gold
  '#4ac0e2', // sky
  '#e2724a', // terracotta
  '#9b6ff0', // violet
  '#d14a9b', // raspberry
  '#2fb8a0', // teal
  '#e0625f', // coral
  '#9bbf4a', // lime
  '#6d7cf0', // indigo
]

function must(): Database.Database {
  if (!db) throw new Error('registry not initialized')
  return db
}

export function initRegistry(dbPath: string): void {
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const v = (db.pragma('user_version', { simple: true }) as number) || 0
  if (v < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS category (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS node (
        session_id TEXT PRIMARY KEY,
        cwd TEXT,
        name TEXT,
        category_id INTEGER REFERENCES category(id) ON DELETE SET NULL,
        origin TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `)
    db.pragma('user_version = 1')
  }
  if (v < 2) {
    // Typed parent→child edges. child_id is PRIMARY KEY, so a child has at most
    // one parent. type: 'blocking' (parent rolls back to it) | 'tangential'.
    db.exec(`
      CREATE TABLE IF NOT EXISTS edge (
        child_id TEXT PRIMARY KEY REFERENCES node(session_id) ON DELETE CASCADE,
        parent_id TEXT NOT NULL REFERENCES node(session_id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'blocking',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at INTEGER NOT NULL
      );
    `)
    db.pragma('user_version = 2')
  }
  if (v < 3) {
    // Per-terminal color theme (an xterm ITheme name, or a serialized custom
    // theme). NULL = the default theme.
    db.exec(`ALTER TABLE node ADD COLUMN theme TEXT;`)
    db.pragma('user_version = 3')
  }
  if (v < 4) {
    // Scrollback snapshot for resume-on-restart: a serialized xterm buffer
    // painted into the pane before the resumed session repaints. Plus a small
    // key/value store for workspace state (last-active session, open set).
    db.exec(`
      ALTER TABLE node ADD COLUMN scrollback TEXT;
      ALTER TABLE node ADD COLUMN scrollback_at INTEGER;
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `)
    db.pragma('user_version = 4')
  }
  if (v < 5) {
    // Short rail tag per category, plus recolor existing categories onto the
    // distinct palette (their old auto-colors could sit close together).
    db.exec(`ALTER TABLE category ADD COLUMN label TEXT;`)
    const cats = db.prepare('SELECT id FROM category ORDER BY sort, id').all() as { id: number }[]
    const upd = db.prepare('UPDATE category SET color=? WHERE id=?')
    cats.forEach((c, i) => upd.run(PALETTE[i % PALETTE.length], c.id))
    db.pragma('user_version = 5')
  }
  if (v < 6) {
    // Per-link messaging trust ("bless a link once"): when 1, the app auto-
    // delivers awareness messages across this edge without per-message approval.
    db.exec(`ALTER TABLE edge ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0;`)
    db.pragma('user_version = 6')
  }
  if (v < 7) {
    // Named Anthropic API keys. secret_enc holds the Electron safeStorage
    // ciphertext (OS-keychain-backed) — never the plaintext. `hint` is the last
    // few chars, for display only.
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_key (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        hint TEXT NOT NULL,
        secret_enc BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    db.pragma('user_version = 7')
  }
  if (v < 8) {
    // Which API key (if any) a session runs on, so a resume re-applies it instead
    // of silently falling back to the subscription.
    db.exec(`ALTER TABLE node ADD COLUMN api_key_id INTEGER;`)
    db.pragma('user_version = 8')
  }
  if (v < 9) {
    // The gate ledger + durable activity log — the "did I handle that?" memory.
    // A `gate` row is ONE needs-you moment, keyed by a stable fingerprint so it
    // survives the 1.5s rescan and a full restart. seen_at / resolved_at are both
    // AUTO-set (focus / absence) — there is no manual "mark done", so the ledger
    // can never become an inbox. Both tables cascade-DELETE with their node, so a
    // removed session takes its whole history with it: the transcript on disk is
    // the real record, this layer is a convenience index and is deleted freely.
    db.exec(`
      CREATE TABLE IF NOT EXISTS gate (
        fp TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES node(session_id) ON DELETE CASCADE,
        category_id INTEGER,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        seen_at INTEGER,
        resolved_at INTEGER,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS gate_open ON gate(session_id) WHERE resolved_at IS NULL;
      CREATE TABLE IF NOT EXISTS event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        session_id TEXT REFERENCES node(session_id) ON DELETE CASCADE,
        category_id INTEGER,
        kind TEXT NOT NULL,
        fp TEXT,
        detail TEXT
      );
    `)
    db.pragma('user_version = 9')
  }
  if (v < 10) {
    // Optional per-category emoji — part of the category's visual identity (color +
    // emoji + short label) so it reads at a glance in the rail AND as a
    // cross-category provenance tag.
    db.exec(`ALTER TABLE category ADD COLUMN emoji TEXT;`)
    db.pragma('user_version = 10')
  }
  if (v < 11) {
    // The Arbiter (optional control agent).
    //
    // arbiter_context is the PRIVACY GATE and defaults to 0 — opt-in, never
    // opt-out. 0 means only metadata (state, tool name, category) may be sent to
    // the API; 1 means the substance (pending command, the question text) may go
    // too. A category the user never touches therefore leaks nothing, which is
    // the safe default for client work.
    //
    // arbiter_spend is the money ledger. Every billable call appends one row
    // whether it succeeded or not, so the running total can never silently
    // under-report. arbiter_log is the console feed — bounded, cosmetic, and
    // safe to delete.
    db.exec(`
      ALTER TABLE category ADD COLUMN arbiter_context INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS arbiter_spend (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS arbiter_spend_at ON arbiter_spend(at);
      CREATE TABLE IF NOT EXISTS arbiter_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL
      );
    `)
    db.pragma('user_version = 11')
  }
  if (v < 12) {
    // The session's outbox token, so a RESUMED session gets its ORIGINAL mailbox
    // path back. That path was taught to the session in its spawn preamble and
    // now lives in its context; minting a fresh token on resume would leave the
    // session writing to a file the app no longer watches.
    db.exec(`ALTER TABLE node ADD COLUMN outbox_token TEXT;`)
    db.pragma('user_version = 12')
  }
}

export function setNodeApiKey(sessionId: string, apiKeyId: number | null): void {
  must().prepare('UPDATE node SET api_key_id=? WHERE session_id=?').run(apiKeyId, sessionId)
}
export function getNodeApiKey(sessionId: string): number | null {
  const row = must().prepare('SELECT api_key_id FROM node WHERE session_id=?').get(sessionId) as
    | { api_key_id: number | null }
    | undefined
  return row?.api_key_id ?? null
}

export interface ApiKeyRow {
  id: number
  name: string
  hint: string
  created_at: number
}
// List keys WITHOUT the secret — this is all the renderer ever sees.
export function listApiKeys(): ApiKeyRow[] {
  return must()
    .prepare('SELECT id, name, hint, created_at FROM api_key ORDER BY created_at DESC, id DESC')
    .all() as ApiKeyRow[]
}
export function addApiKey(name: string, hint: string, secretEnc: Buffer): ApiKeyRow {
  const created_at = Date.now()
  const info = must()
    .prepare('INSERT INTO api_key (name, hint, secret_enc, created_at) VALUES (?,?,?,?)')
    .run(name, hint, secretEnc, created_at)
  return { id: Number(info.lastInsertRowid), name, hint, created_at }
}
// Main-process only: the encrypted blob, for safeStorage.decryptString at use time.
export function getApiKeySecretEnc(id: number): Buffer | null {
  const row = must().prepare('SELECT secret_enc FROM api_key WHERE id=?').get(id) as
    | { secret_enc: Buffer }
    | undefined
  return row ? row.secret_enc : null
}
export function removeApiKey(id: number): void {
  must().prepare('DELETE FROM api_key WHERE id=?').run(id)
}
export function apiKeyExists(id: number): boolean {
  return !!must().prepare('SELECT 1 FROM api_key WHERE id=?').get(id)
}

export function setEdgeTrust(childId: string, trusted: boolean): void {
  must().prepare('UPDATE edge SET trusted=? WHERE child_id=?').run(trusted ? 1 : 0, childId)
}

export function setCategoryLabel(id: number, label: string | null): void {
  must().prepare('UPDATE category SET label=? WHERE id=?').run(label, id)
}

export function setCategoryEmoji(id: number, emoji: string | null): void {
  must().prepare('UPDATE category SET emoji=? WHERE id=?').run(emoji, id)
}

export function setCategoryColor(id: number, color: string): void {
  must().prepare('UPDATE category SET color=? WHERE id=?').run(color, id)
}

// Set (or clear, with null) a session's terminal theme by name.
export function setTheme(sessionId: string, theme: string | null): void {
  must().prepare('UPDATE node SET theme=? WHERE session_id=?').run(theme, sessionId)
}

// Scrollback snapshot: persisted per session, fetched on demand (never in the
// periodic scan). Only writes when the node already exists.
export function setScrollback(sessionId: string, data: string, at: number): void {
  must().prepare('UPDATE node SET scrollback=?, scrollback_at=? WHERE session_id=?').run(data, at, sessionId)
}

export function getScrollback(sessionId: string): string | null {
  const row = must().prepare('SELECT scrollback FROM node WHERE session_id=?').get(sessionId) as
    | { scrollback: string | null }
    | undefined
  return row?.scrollback ?? null
}

// Workspace key/value state (last-active session id, open session set, …).
export function setAppState(key: string, value: string): void {
  must()
    .prepare('INSERT INTO app_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value)
}

export function getAppState(key: string): string | null {
  const row = must().prepare('SELECT value FROM app_state WHERE key=?').get(key) as
    | { value: string | null }
    | undefined
  return row?.value ?? null
}

export interface Edge {
  child_id: string
  parent_id: string
  type: string
  source: string
  trusted: number
}

// Set (or move) a child's parent. Rejects self-parenting and any cycle (parent
// must not already be a descendant of the child). Returns false if rejected.
export function setParent(
  childId: string,
  parentId: string,
  type: 'blocking' | 'tangential',
): boolean {
  if (childId === parentId) return false
  const d = must()
  let cur: string | undefined = parentId
  const seen = new Set<string>()
  while (cur) {
    if (cur === childId) return false // would create a cycle
    if (seen.has(cur)) break
    seen.add(cur)
    const row = d.prepare('SELECT parent_id FROM edge WHERE child_id=?').get(cur) as
      | { parent_id: string }
      | undefined
    cur = row?.parent_id
  }
  d.prepare(
    `INSERT INTO edge (child_id, parent_id, type, source, created_at) VALUES (?,?,?, 'manual', ?)
     ON CONFLICT(child_id) DO UPDATE SET parent_id=excluded.parent_id, type=excluded.type,
       trusted=CASE WHEN parent_id=excluded.parent_id THEN trusted ELSE 0 END`,
  ).run(childId, parentId, type, Date.now())
  return true
}

export function clearParent(childId: string): void {
  must().prepare('DELETE FROM edge WHERE child_id=?').run(childId)
}

export function getEdges(): Edge[] {
  return must()
    .prepare('SELECT child_id, parent_id, type, source, trusted FROM edge')
    .all() as Edge[]
}

export function listCategories(): Category[] {
  return must()
    .prepare(
      'SELECT id, name, color, sort, label, emoji, arbiter_context FROM category ORDER BY sort, id',
    )
    .all() as Category[]
}

// ---------- Arbiter (optional control agent) ----------

export function setOutboxToken(sessionId: string, token: string): void {
  must().prepare('UPDATE node SET outbox_token=? WHERE session_id=?').run(token, sessionId)
}

export function getOutboxToken(sessionId: string): string | null {
  const r = must()
    .prepare('SELECT outbox_token AS t FROM node WHERE session_id=?')
    .get(sessionId) as { t: string | null } | undefined
  return r?.t ?? null
}

export function setCategoryArbiterContext(id: number, on: boolean): void {
  must().prepare('UPDATE category SET arbiter_context=? WHERE id=?').run(on ? 1 : 0, id)
}

// Categories cleared to send substance. The Arbiter consults this on every run
// rather than caching it, so revoking a category takes effect immediately.
export function arbiterContextCategoryIds(): Set<number> {
  const rows = must()
    .prepare('SELECT id FROM category WHERE arbiter_context=1')
    .all() as { id: number }[]
  return new Set(rows.map((r) => r.id))
}

export interface ArbiterSpendRow {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number
  ok: boolean
}

// Append-only. A failed call still records what it burned — a request that errors
// after the model generated tokens is still billable, and silently dropping it
// would make the running total lie in the one direction that matters.
export function recordArbiterSpend(r: ArbiterSpendRow): void {
  must()
    .prepare(
      `INSERT INTO arbiter_spend
       (at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, ok)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      Date.now(),
      r.model,
      r.input_tokens,
      r.output_tokens,
      r.cache_read_tokens,
      r.cache_write_tokens,
      r.cost_usd,
      r.ok ? 1 : 0,
    )
}

export interface ArbiterSpendSummary {
  todayUsd: number
  totalUsd: number
  calls: number
  lastAt: number | null
}

// "Today" is local-midnight based, matching how a person reads a daily spend
// figure — not a rolling 24h window.
export function getArbiterSpend(): ArbiterSpendSummary {
  const d = must()
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const today = d
    .prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM arbiter_spend WHERE at >= ?')
    .get(midnight.getTime()) as { s: number }
  const all = d
    .prepare(
      'SELECT COALESCE(SUM(cost_usd),0) AS s, COUNT(*) AS c, MAX(at) AS m FROM arbiter_spend',
    )
    .get() as { s: number; c: number; m: number | null }
  return { todayUsd: today.s, totalUsd: all.s, calls: all.c, lastAt: all.m }
}

export interface ArbiterLogRow {
  id: number
  at: number
  kind: string
  text: string
}

const ARBITER_LOG_CAP = 200

export function appendArbiterLog(kind: string, text: string): void {
  const d = must()
  d.prepare('INSERT INTO arbiter_log (at, kind, text) VALUES (?,?,?)').run(Date.now(), kind, text)
  // Bounded ring — the console is a live feed, not a record.
  d.prepare(
    `DELETE FROM arbiter_log WHERE id NOT IN
     (SELECT id FROM arbiter_log ORDER BY id DESC LIMIT ?)`,
  ).run(ARBITER_LOG_CAP)
}

export function getArbiterLog(limit = 60): ArbiterLogRow[] {
  return must()
    .prepare('SELECT id, at, kind, text FROM arbiter_log ORDER BY id DESC LIMIT ?')
    .all(limit) as ArbiterLogRow[]
}

export function createCategory(name: string, color?: string): Category {
  const d = must()
  const count = (d.prepare('SELECT COUNT(*) AS c FROM category').get() as { c: number }).c
  const col = color || PALETTE[count % PALETTE.length]
  const info = d
    .prepare('INSERT INTO category (name, color, sort, created_at) VALUES (?,?,?,?)')
    .run(name, col, count, Date.now())
  return {
    id: Number(info.lastInsertRowid),
    name,
    color: col,
    sort: count,
    label: null,
    emoji: null,
    arbiter_context: 0, // new categories never send substance until told to
  }
}

export function renameCategory(id: number, name: string): void {
  must().prepare('UPDATE category SET name=? WHERE id=?').run(name, id)
}

export function deleteCategory(id: number): void {
  // node.category_id falls back to NULL via ON DELETE SET NULL
  must().prepare('DELETE FROM category WHERE id=?').run(id)
}

export function ensureNode(
  sessionId: string,
  info: { cwd?: string; name?: string; origin?: string },
): void {
  const d = must()
  const now = Date.now()
  const existing = d.prepare('SELECT session_id FROM node WHERE session_id=?').get(sessionId)
  if (existing) {
    d.prepare(
      'UPDATE node SET cwd=COALESCE(?,cwd), name=COALESCE(?,name), last_seen=? WHERE session_id=?',
    ).run(info.cwd ?? null, info.name ?? null, now, sessionId)
  } else {
    // Auto-categorize a brand-new session by folder: if another session in the
    // same cwd is already categorized, inherit that category. Only at creation,
    // so a later manual move to Uncategorized (or elsewhere) is never overridden.
    let categoryId: number | null = null
    if (info.cwd) {
      const sib = d
        .prepare('SELECT category_id FROM node WHERE cwd=? AND category_id IS NOT NULL LIMIT 1')
        .get(info.cwd) as { category_id: number } | undefined
      categoryId = sib?.category_id ?? null
    }
    d.prepare(
      'INSERT INTO node (session_id, cwd, name, category_id, origin, first_seen, last_seen) VALUES (?,?,?,?,?,?,?)',
    ).run(sessionId, info.cwd ?? null, info.name ?? null, categoryId, info.origin ?? 'adopted', now, now)
  }
}

export function assignCategory(sessionId: string, categoryId: number | null): void {
  must().prepare('UPDATE node SET category_id=? WHERE session_id=?').run(categoryId, sessionId)
}

// Remove a node entirely (edges cascade via ON DELETE CASCADE). Used to drop a
// terminated session from the list.
export function deleteNode(sessionId: string): void {
  must().prepare('DELETE FROM node WHERE session_id=?').run(sessionId)
}

export function getNodeMap(): Map<string, NodeRow> {
  // Deliberately excludes the scrollback blob — this runs every scan.
  const rows = must()
    .prepare(
      'SELECT session_id, cwd, name, category_id, origin, first_seen, last_seen, theme FROM node',
    )
    .all() as NodeRow[]
  const m = new Map<string, NodeRow>()
  for (const r of rows) m.set(r.session_id, r)
  return m
}

// ---------- gate ledger: the "did I handle that?" memory ----------

export interface OpenGate {
  sessionId: string
  categoryId: number | null
  kind: 'permission' | 'question' | 'blocked'
  // The fingerprint identity for this kind — STABLE across scans: a permission's
  // constant marker (its command text oscillates as the TUI repaints, so it can't
  // be the identity), a question's text (a reworded question IS a new gate), a
  // blocked child's stable id (not its drifting display name). Kept separate from
  // the display payload so a volatile display string can never churn the fp.
  key: string
  payload: string // the display substance (command / question / child name)
}

export interface GateRow {
  fp: string
  session_id: string
  category_id: number | null
  kind: string
  payload: string
  first_seen: number
  last_seen: number
  seen_at: number | null
  resolved_at: number | null
}

const RESOLVE_DEBOUNCE_MS = 3500 // a gate must be absent ~2+ scans (1.5s each) before it resolves
const GATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // resolved rows kept a week, then pruned
const MAX_RESOLVED_GATES = 300 // global backstop on resolved rows
const EVENTS_PER_SESSION = 60 // per-session ring cap on the activity log
const MAX_EVENTS = 4000 // global backstop on the activity log
let lastPruneAt = 0

function gateFp(g: OpenGate): string {
  // Identity = session + kind + STABLE key (not the volatile display payload), so
  // one live dialog keeps one fp across scans and a restart. uuid|kind|key is
  // injective — the uuid and kind never contain a pipe, so a key with pipes stays
  // one trailing field and can't collide.
  return `${g.sessionId}|${g.kind}|${g.key}`
}

function logEvent(
  d: Database.Database,
  g: { sessionId: string; categoryId: number | null; kind: string },
  fp: string,
  event: string,
  at: number,
): void {
  d.prepare('INSERT INTO event_log (at, session_id, category_id, kind, fp, detail) VALUES (?,?,?,?,?,?)').run(
    at,
    g.sessionId,
    g.categoryId,
    event,
    fp,
    g.kind,
  )
}

// Reconcile the ledger with the gates open right now. Upserts current gates
// (auto-seen when the human is focused on that session), auto-resolves gates that
// have been absent past the debounce, and prunes periodically. All in one
// transaction. Query getUnhandledSessions() / getOpenGates() for the UI.
export function syncGates(gates: OpenGate[], attachedSid: string | null, now: number): void {
  const d = must()
  d.transaction(() => {
    for (const g of gates) {
      const fp = gateFp(g)
      const seenNow = attachedSid === g.sessionId ? now : null
      const row = d.prepare('SELECT resolved_at, seen_at FROM gate WHERE fp=?').get(fp) as
        | { resolved_at: number | null; seen_at: number | null }
        | undefined
      if (!row) {
        d.prepare(
          'INSERT INTO gate (fp, session_id, category_id, kind, payload, first_seen, last_seen, seen_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(fp, g.sessionId, g.categoryId, g.kind, g.payload, now, now, seenNow)
        logEvent(d, g, fp, 'gate_open', now)
        if (seenNow) logEvent(d, g, fp, 'gate_seen', now)
      } else if (row.resolved_at != null) {
        // A previously-resolved gate is open again — a fresh occurrence.
        d.prepare(
          'UPDATE gate SET category_id=?, payload=?, first_seen=?, last_seen=?, seen_at=?, resolved_at=NULL, resolution=NULL WHERE fp=?',
        ).run(g.categoryId, g.payload, now, now, seenNow, fp)
        logEvent(d, g, fp, 'gate_open', now)
        if (seenNow) logEvent(d, g, fp, 'gate_seen', now)
      } else {
        const newlySeen = row.seen_at == null && seenNow != null
        d.prepare('UPDATE gate SET category_id=?, payload=?, last_seen=?, seen_at=COALESCE(seen_at, ?) WHERE fp=?').run(
          g.categoryId,
          g.payload,
          now,
          seenNow,
          fp,
        )
        if (newlySeen) logEvent(d, g, fp, 'gate_seen', now)
      }
    }
    // Auto-resolve: open gates not touched this scan for longer than the debounce.
    // The `last_seen > now` arm handles a backward clock step: a gate that vanished
    // before the step has a "future" last_seen and would otherwise never resolve
    // (pip stuck). A genuinely-open gate is touched this scan so last_seen === now.
    const stale = d
      .prepare('SELECT fp, session_id, category_id, kind FROM gate WHERE resolved_at IS NULL AND (last_seen < ? OR last_seen > ?)')
      .all(now - RESOLVE_DEBOUNCE_MS, now) as {
      fp: string
      session_id: string
      category_id: number | null
      kind: string
    }[]
    for (const s of stale) {
      d.prepare("UPDATE gate SET resolved_at=?, resolution='cleared' WHERE fp=?").run(now, s.fp)
      logEvent(d, { sessionId: s.session_id, categoryId: s.category_id, kind: s.kind }, s.fp, 'gate_resolved', now)
    }
    if (now < lastPruneAt) lastPruneAt = now // clock stepped back — don't starve the prune
    if (now - lastPruneAt > 60_000) {
      lastPruneAt = now
      pruneLedger(d, now)
    }
  })()
}

function pruneLedger(d: Database.Database, now: number): void {
  // Resolved gates: age out, then a global count backstop. Open gates never pruned.
  d.prepare('DELETE FROM gate WHERE resolved_at IS NOT NULL AND resolved_at < ?').run(now - GATE_RETENTION_MS)
  d.prepare(
    `DELETE FROM gate WHERE resolved_at IS NOT NULL AND fp NOT IN (
       SELECT fp FROM gate WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT ?
     )`,
  ).run(MAX_RESOLVED_GATES)
  // Activity log: age out, per-session ring cap, then a global backstop.
  d.prepare('DELETE FROM event_log WHERE at < ?').run(now - GATE_RETENTION_MS)
  d.prepare(
    `DELETE FROM event_log WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS rn FROM event_log
       ) WHERE rn > ?
     )`,
  ).run(EVENTS_PER_SESSION)
  d.prepare('DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY id DESC LIMIT ?)').run(MAX_EVENTS)
}

// Sessions with an open gate the human hasn't looked at yet — drives the pip.
export function getUnhandledSessions(): Set<string> {
  const rows = must()
    .prepare('SELECT DISTINCT session_id FROM gate WHERE resolved_at IS NULL AND seen_at IS NULL')
    .all() as { session_id: string }[]
  return new Set(rows.map((r) => r.session_id))
}

// Currently-open gates (unresolved), oldest first. For the companion why-board and
// the since-you-were-away briefing later; also used by the ledger tests.
export function getOpenGates(): GateRow[] {
  return must()
    .prepare(
      'SELECT fp, session_id, category_id, kind, payload, first_seen, last_seen, seen_at, resolved_at FROM gate WHERE resolved_at IS NULL ORDER BY first_seen',
    )
    .all() as GateRow[]
}
