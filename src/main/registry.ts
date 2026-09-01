import Database from 'better-sqlite3'
import { pairOf, aliasCandidate, type GrantRow } from './engine/mailbox'

export { mayMessage, type GrantRow } from './engine/mailbox'

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
  // Per-category OS-notification overrides, one per event class. null = inherit
  // the global setting, 0 = off, 1 = on.
  notify_permission: number | null
  notify_question: number | null
  notify_done: number | null
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
  // Set → the session is soft-archived: hidden from the sidebar, still fully intact
  // and restorable. Distinct from removal, which deletes the node.
  archived_at?: number | null
  // Scrollback is stored but intentionally NOT loaded by getNodeMap (it is large
  // and the scan runs every ~1.5s); fetch it on demand with getScrollback.
  scrollback?: string | null
  scrollback_at?: number | null
  // Remembered launch parameters (JSON) and whether to apply them without asking.
  // Unlike scrollback these ARE loaded by the scan — two short columns, and the
  // renderer needs them to know whether resuming should raise the params modal.
  resume_flags: string | null
  resume_flags_sticky: number | null
  // Immutable @-address, minted at adoption. Unlike `name` this never changes, so a
  // message addressed to it keeps resolving after Claude's auto-title drifts.
  alias?: string | null
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
  if (v < 13) {
    // Per-category notification overrides. NULL = inherit the global setting for
    // that class, 0 = off, 1 = on. Nullable on purpose: a new category needs zero
    // configuration and simply follows global until you deliberately diverge.
    db.exec(`
      ALTER TABLE category ADD COLUMN notify_permission INTEGER;
      ALTER TABLE category ADD COLUMN notify_question INTEGER;
      ALTER TABLE category ADD COLUMN notify_done INTEGER;
    `)
    db.pragma('user_version = 13')
  }
  if (v < 14) {
    // Per-session launch parameters, so model/effort/context/permission-mode
    // survive a resume — `claude --resume` does not carry them forward. JSON of
    // four validated fields (see engine/resumeFlags.ts), never the freeform flags
    // string. sticky=1 means "apply silently"; anything else gates behind the
    // parameters modal, which is the default for adopted and pre-existing rows.
    db.exec(`
      ALTER TABLE node ADD COLUMN resume_flags TEXT;
      ALTER TABLE node ADD COLUMN resume_flags_sticky INTEGER;
    `)
    db.pragma('user_version = 14')
  }
  if (v < 15) {
    // The durable mailbox. Every cross-session message is a row from the moment it
    // is claimed off disk, so "sent, unconfirmed, and now blank" cannot happen: the
    // body is committed before routing is ever attempted.
    //
    // The one place the gate ledger must NOT be copied is its ON DELETE CASCADE.
    // That is right for a gate — the transcript on disk is the real record — but
    // deleteNode runs on ORDINARY PTY EXIT (autoRemoveExitedSession), so a cascade
    // here would wipe every mailbox each time a session quits normally, reproducing
    // the exact data loss this table exists to prevent. Endpoints are plain TEXT
    // with no FK, and archival is an explicit step.
    //
    // Identity also differs deliberately. A gate is a recurring OBSERVATION keyed by
    // a stable fingerprint so rescans dedupe. A message is the opposite: every send
    // is a distinct event that must never dedupe, so the key is a minted id.
    db.exec(`
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY,
        from_session_id TEXT NOT NULL,
        from_handle TEXT NOT NULL,      -- display name frozen at send time
        to_session_id TEXT,             -- null until addressing resolves
        to_addr TEXT NOT NULL,          -- the literal address the sender wrote
        body TEXT NOT NULL,             -- FULL payload, never silently truncated
        state TEXT NOT NULL,            -- queued|held|delivered|read|failed|expired|archived
        reason TEXT,                    -- human-readable why-it-is-here
        spool TEXT,                     -- the on-disk claim, while one still exists
        thread_id TEXT,                 -- loop control once routing is a mesh
        origin TEXT NOT NULL DEFAULT 'session',  -- session|user|app
        created_at INTEGER NOT NULL,
        routed_at INTEGER,
        delivered_at INTEGER,
        read_at INTEGER,
        terminal_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS message_open ON message(to_session_id) WHERE terminal_at IS NULL;
      CREATE INDEX IF NOT EXISTS message_recent ON message(created_at DESC);
    `)
    db.pragma('user_version = 15')
  }
  if (v < 16) {
    // A stable, human-typable address per session. The @-handle has been the DISPLAY
    // name, which is Claude's auto-title when the user hasn't set one — and that
    // drifts as the conversation moves, so an address that worked yesterday silently
    // stops resolving. Direct precedent: outbox_token above exists for exactly this
    // reason, "durable identity a session carries across resume".
    db.exec(`
      ALTER TABLE node ADD COLUMN alias TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS node_alias ON node(alias) WHERE alias IS NOT NULL;
    `)
    db.pragma('user_version = 16')
  }
  if (v < 17) {
    // Who may message whom. The tree gave permission for free — one edge, one trusted
    // bit — but a mesh has N² pairs and cannot auto-grant. DEFAULT DENY: a pair may
    // message only with a live row here, or along an existing trusted edge.
    //
    // Stored as a SORTED pair so (a,b) and (b,a) are one row and a grant cannot be
    // duplicated or half-revoked. `mode` is directional, so "Beta may report to Alpha"
    // does not imply "Alpha may drive Beta". mode='none' is an explicit revoke that
    // OVERRIDES an underlying trusted edge — without it, revoking a parent/child pair
    // would silently do nothing.
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_grant (
        a_id TEXT NOT NULL,
        b_id TEXT NOT NULL,
        mode TEXT NOT NULL,              -- both | a_to_b | b_to_a | none
        granted_at INTEGER NOT NULL,
        granted_by TEXT NOT NULL,        -- user | auto-edge
        revoked_at INTEGER,
        PRIMARY KEY (a_id, b_id)
      );
    `)
    db.pragma('user_version = 17')
  }
  if (v < 18) {
    // Soft archive. Removal deletes the node outright, which is correct for debris but
    // wrong for "just get this out of my sidebar" — and there was no third option, so
    // the only fast way to clear a pile-up was the permanent one. archived_at keeps the
    // node, its name, its category and its edges intact while hiding it from the rail,
    // which makes restoring one write with nothing to re-decide.
    db.exec(`ALTER TABLE node ADD COLUMN archived_at INTEGER`)
    db.pragma('user_version = 18')
  }
}

// Remembered launch parameters for a session. `sticky` true → applied silently on
// resume; false/absent → the UI asks before resuming. Mirrors setNodeApiKey, the
// existing "per-session property re-applied at resume" precedent.
export function setNodeResumeFlags(
  sessionId: string,
  flagsJson: string | null,
  sticky: boolean,
): void {
  must()
    .prepare('UPDATE node SET resume_flags=?, resume_flags_sticky=? WHERE session_id=?')
    .run(flagsJson, sticky ? 1 : 0, sessionId)
}

export function getNodeResumeFlags(sessionId: string): { flags: string | null; sticky: boolean } {
  const r = must()
    .prepare('SELECT resume_flags AS f, resume_flags_sticky AS s FROM node WHERE session_id=?')
    .get(sessionId) as { f: string | null; s: number | null } | undefined
  return { flags: r?.f ?? null, sticky: r?.s === 1 }
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

// Persist a new category order: each id's `sort` becomes its index in the list.
// listCategories() then orders by sort, so the rail reflects the drag.
export function reorderCategories(ids: number[]): void {
  const db = must()
  const stmt = db.prepare('UPDATE category SET sort=? WHERE id=?')
  db.transaction((list: number[]) => list.forEach((id, i) => stmt.run(i, id)))(ids)
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
      `SELECT id, name, color, sort, label, emoji, arbiter_context,
              notify_permission, notify_question, notify_done
       FROM category ORDER BY sort, id`,
    )
    .all() as Category[]
}

export type NotifyClass = 'permission' | 'question' | 'done'
const NOTIFY_COL: Record<NotifyClass, string> = {
  permission: 'notify_permission',
  question: 'notify_question',
  done: 'notify_done',
}

// Set one category's override for one event class. null clears it back to
// "inherit the global setting" — the tri-state the settings UI exposes.
export function setCategoryNotify(id: number, cls: NotifyClass, value: boolean | null): void {
  const col = NOTIFY_COL[cls]
  if (!col) return // unknown class — never interpolate an unvetted string into SQL
  must()
    .prepare(`UPDATE category SET ${col}=? WHERE id=?`)
    .run(value === null ? null : value ? 1 : 0, id)
}

// ---------- Arbiter (optional control agent) ----------

export function setOutboxToken(sessionId: string, token: string): void {
  must().prepare('UPDATE node SET outbox_token=? WHERE session_id=?').run(token, sessionId)
}

// Mint the session's permanent alias, once. Never regenerated and never editable:
// the whole value is that it does not move. Derived from the display name so it is
// recognisable, with a short suffix from the session id so two "reviewer"s differ.
export function ensureAlias(sessionId: string, seed: string | null): string {
  const d = must()
  const row = d.prepare('SELECT alias FROM node WHERE session_id=?').get(sessionId) as
    | { alias: string | null }
    | undefined
  if (row?.alias) return row.alias
  let alias = aliasCandidate(seed, sessionId)
  const base = alias.slice(0, alias.lastIndexOf('-'))
  const tail = alias.slice(alias.lastIndexOf('-') + 1)
  // The unique index is the real guarantee; this only avoids throwing on a collision.
  for (let n = 2; n < 50; n++) {
    const clash = d.prepare('SELECT 1 FROM node WHERE alias=? AND session_id<>?').get(alias, sessionId)
    if (!clash) break
    alias = `${base}-${tail}${n}`
  }
  try {
    d.prepare('UPDATE node SET alias=? WHERE session_id=? AND alias IS NULL').run(alias, sessionId)
  } catch {
    return sessionId.slice(0, 8) // index rejected it — fall back rather than fail a scan
  }
  return alias
}

export function getAliasMap(): Map<string, string> {
  const rows = must()
    .prepare('SELECT session_id, alias FROM node WHERE alias IS NOT NULL')
    .all() as { session_id: string; alias: string }[]
  return new Map(rows.map((r) => [r.session_id, r.alias]))
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
    // null = inherit the global notification switches, so a new category needs no
    // configuration to behave sensibly.
    notify_permission: null,
    notify_question: null,
    notify_done: null,
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
  info: { cwd?: string; name?: string; origin?: string; skipAutoCategory?: boolean },
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
    //
    // skipAutoCategory is for a spawned CHILD, whose category is decided by its
    // edge — a blocking child inherits its parent via categoryOf, a tangential
    // child stays uncategorized. A child runs in its parent's folder, so without
    // this it would wrongly pick up a category from a sibling that merely shares
    // that folder (the "tangential child landed in some other category" bug).
    let categoryId: number | null = null
    if (info.cwd && !info.skipAutoCategory) {
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

// Move a node's last_seen forward without pretending its process ran. Used by the
// archive restore: the recency gate measures when a session was last SEEN, and
// restoring is the user saying it is current again.
export function touchNode(sessionId: string, at = Date.now()): void {
  must().prepare('UPDATE node SET last_seen=? WHERE session_id=?').run(at, sessionId)
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
      `SELECT session_id, cwd, name, category_id, origin, first_seen, last_seen, theme,
              resume_flags, resume_flags_sticky, alias, archived_at
       FROM node`,
    )
    .all() as NodeRow[]
  const m = new Map<string, NodeRow>()
  for (const r of rows) m.set(r.session_id, r)
  return m
}

// ---------- soft archive ----------

// Hide sessions from the sidebar without destroying them. Everything the user decided
// — name, category, edges, grants, remembered launch flags — stays put, so restoring
// is a single write rather than a set of decisions to make again.
//
// Contrast removeSessionsHard (index.ts), which deletes the node, purges the session
// files and denylists the id. That is right for debris and wrong for a pile-up you
// merely want out of the way, which is why this exists as a separate verb.
export function archiveNodes(ids: string[], at: number): number {
  if (!ids.length) return 0
  const db = must()
  const stmt = db.prepare(`UPDATE node SET archived_at = ? WHERE session_id = ?`)
  const run = db.transaction((list: string[]) => {
    let n = 0
    for (const id of list) n += stmt.run(at, id).changes
    return n
  })
  return run(ids)
}

export function unarchiveNode(id: string): void {
  must().prepare(`UPDATE node SET archived_at = NULL WHERE session_id = ?`).run(id)
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
const MAX_OPEN_GATES = 400 // ceiling on HELD rows, so unresumed sessions can't accumulate forever
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
// `liveSessionIds` is the set the scan could actually OBSERVE this tick. Only
// those sessions' gates are eligible for auto-resolve: a gate is resolved by
// watching it disappear, and a session that isn't running cannot be watched.
// Without this, an app restart (where every session starts dormant) resolved the
// entire ledger within one debounce — silently discarding every unhandled
// needs-you moment the user had not yet dealt with.
// A gate that transitioned into the open state on THIS tick — either brand new or
// a previously-resolved one recurring. This is the edge the OS notifier fires on:
// the fp identity means one live dialog notifies once, no matter how many scans
// it spans or how much its display text repaints.
export interface OpenedGate {
  fp: string
  sessionId: string
  categoryId: number | null
  kind: string
  payload: string
  autoSeen: boolean // you were attached to this session, so it was seen on arrival
}

export function syncGates(
  gates: OpenGate[],
  attachedSid: string | null,
  now: number,
  liveSessionIds?: Set<string>,
): OpenedGate[] {
  const d = must()
  const opened: OpenedGate[] = []
  const noteOpened = (g: OpenGate, fp: string, seenNow: number | null): void => {
    opened.push({
      fp,
      sessionId: g.sessionId,
      categoryId: g.categoryId,
      kind: g.kind,
      payload: g.payload,
      autoSeen: seenNow != null,
    })
  }
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
        noteOpened(g, fp, seenNow)
        if (seenNow) logEvent(d, g, fp, 'gate_seen', now)
      } else if (row.resolved_at != null) {
        // A previously-resolved gate is open again — a fresh occurrence.
        d.prepare(
          'UPDATE gate SET category_id=?, payload=?, first_seen=?, last_seen=?, seen_at=?, resolved_at=NULL, resolution=NULL WHERE fp=?',
        ).run(g.categoryId, g.payload, now, now, seenNow, fp)
        logEvent(d, g, fp, 'gate_open', now)
        noteOpened(g, fp, seenNow)
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
    const stale = (
      d
        .prepare('SELECT fp, session_id, category_id, kind FROM gate WHERE resolved_at IS NULL AND (last_seen < ? OR last_seen > ?)')
        .all(now - RESOLVE_DEBOUNCE_MS, now) as {
        fp: string
        session_id: string
        category_id: number | null
        kind: string
      }[]
    ).filter((row) => !liveSessionIds || liveSessionIds.has(row.session_id))
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
  return opened
}

function pruneLedger(d: Database.Database, now: number): void {
  // Open gates are held indefinitely for sessions that aren't running (a gate is
  // resolved by OBSERVING it clear, and a dormant session can't be observed) —
  // so they need their own bound, or a session that is never resumed again keeps
  // its row forever. Two backstops:
  //
  //  1. Age. Once a session passes the dormant window it is filtered out of the
  //     UI entirely, so a held gate for it is unreachable and unactionable.
  //     Retire it as 'stale' and let the resolved-row pruning below age it out.
  //  2. Count. A hard ceiling on open rows regardless of age, retiring the
  //     oldest first, in case something pathological produces gates faster than
  //     they clear.
  //
  // Sessions the user EXPRESSLY removes need neither: gate.session_id is
  // ON DELETE CASCADE against node, so deleting the node takes its gates with it.
  d.prepare(
    "UPDATE gate SET resolved_at=?, resolution='stale' WHERE resolved_at IS NULL AND last_seen < ?",
  ).run(now, now - GATE_RETENTION_MS)
  d.prepare(
    `UPDATE gate SET resolved_at=?, resolution='stale' WHERE resolved_at IS NULL AND fp NOT IN (
       SELECT fp FROM gate WHERE resolved_at IS NULL ORDER BY last_seen DESC LIMIT ?
     )`,
  ).run(now, MAX_OPEN_GATES)

  // Resolved gates: age out, then a global count backstop.
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
export interface HeldGate {
  sessionId: string
  kind: string
  payload: string
  firstSeen: number
  seen: boolean
}

// Open gates belonging to sessions that are NOT currently running. These are the
// needs-you moments a restart would otherwise hide: the state is on disk, the
// session just isn't up yet.
export function getHeldGates(excludeSessionIds: Set<string>): HeldGate[] {
  const rows = must()
    .prepare(
      'SELECT session_id, kind, payload, first_seen, seen_at FROM gate WHERE resolved_at IS NULL ORDER BY first_seen DESC',
    )
    .all() as {
    session_id: string
    kind: string
    payload: string
    first_seen: number
    seen_at: number | null
  }[]
  return rows
    .filter((r) => !excludeSessionIds.has(r.session_id))
    .map((r) => ({
      sessionId: r.session_id,
      kind: r.kind,
      payload: r.payload,
      firstSeen: r.first_seen,
      seen: r.seen_at != null,
    }))
}

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

// ---------- the mailbox: durable cross-session messages ----------
// Persisted the instant a payload is claimed off disk, BEFORE routing is attempted.
// That ordering is the whole point: the old pipeline emptied the outbox first and
// kept the only copy in memory, so a message that could not be routed vanished on
// quit with the sender believing it had sent. See the v15 migration for why this
// table does not cascade with its node.

export type MessageState =
  | 'queued' // persisted; addressing not yet resolved
  | 'held' // resolved but not sendable yet — `reason` carries the substate
  | 'delivered' // pasted into the target's input. Transport, not comprehension.
  | 'read' // recipient acknowledged (Phase 4)
  | 'failed' // terminal and actionable
  | 'expired' // aged out without ever becoming deliverable
  | 'archived' // an endpoint was removed; read-only for the retention window

export interface MessageRow {
  id: string
  from_session_id: string
  from_handle: string
  to_session_id: string | null
  to_addr: string
  body: string
  state: MessageState
  reason: string | null
  spool: string | null
  thread_id: string | null
  origin: string
  created_at: number
  routed_at: number | null
  delivered_at: number | null
  read_at: number | null
  terminal_at: number | null
  attempts: number
  last_attempt_at: number | null
}

export interface NewMessage {
  id: string
  fromSessionId: string
  fromHandle: string
  toSessionId?: string | null
  toAddr: string
  body: string
  state: MessageState
  reason?: string | null
  spool?: string | null
  origin?: string
  at: number
  terminal?: boolean // app/system notes are born terminal — nothing more happens to them
}

// Every state a message can reach and never leave. Used to stamp terminal_at, which
// is what the open-set index and the prune are keyed on.
const TERMINAL_STATES = new Set<MessageState>(['failed', 'expired', 'archived'])

export function insertMessage(m: NewMessage): void {
  const terminal = m.terminal || TERMINAL_STATES.has(m.state)
  must()
    .prepare(
      `INSERT OR REPLACE INTO message
         (id, from_session_id, from_handle, to_session_id, to_addr, body, state, reason,
          spool, origin, created_at, terminal_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      m.id,
      m.fromSessionId,
      m.fromHandle,
      m.toSessionId ?? null,
      m.toAddr,
      m.body,
      m.state,
      m.reason ?? null,
      m.spool ?? null,
      m.origin ?? 'session',
      m.at,
      terminal ? m.at : null,
    )
}

// Advance a message. Timestamps are set on the transition that earns them and never
// cleared, so the row reads as a history rather than only a current position.
// NOTHING here touches `body` — no transition may discard the payload, which is the
// invariant the whole table exists to hold.
export function setMessageState(
  id: string,
  state: MessageState,
  reason: string | null,
  at: number,
  opts: { toSessionId?: string | null; spool?: string | null; attempt?: boolean } = {},
): void {
  const d = must()
  const terminal = TERMINAL_STATES.has(state)
  d.prepare(
    `UPDATE message SET
       state=?,
       reason=?,
       to_session_id=COALESCE(?, to_session_id),
       routed_at=CASE WHEN routed_at IS NULL AND ? IS NOT NULL THEN ? ELSE routed_at END,
       delivered_at=CASE WHEN ?='delivered' AND delivered_at IS NULL THEN ? ELSE delivered_at END,
       read_at=CASE WHEN ?='read' AND read_at IS NULL THEN ? ELSE read_at END,
       terminal_at=CASE WHEN ? THEN COALESCE(terminal_at, ?) ELSE terminal_at END,
       spool=CASE WHEN ? THEN NULL ELSE spool END,
       attempts=attempts + CASE WHEN ? THEN 1 ELSE 0 END,
       last_attempt_at=CASE WHEN ? THEN ? ELSE last_attempt_at END
     WHERE id=?`,
  ).run(
    state,
    reason,
    opts.toSessionId ?? null,
    opts.toSessionId ?? null,
    at,
    state,
    at,
    state,
    at,
    terminal ? 1 : 0,
    at,
    opts.spool === null ? 1 : 0,
    opts.attempt ? 1 : 0,
    opts.attempt ? 1 : 0,
    at,
    id,
  )
}

// Delivered is treated as terminal until read receipts land (Phase 4), when the
// terminal point moves to `read` and a delivered-but-never-acknowledged message
// becomes a visible failure instead of a silent success.
export function markDelivered(id: string, at: number): void {
  setMessageState(id, 'delivered', null, at, { spool: null, attempt: true })
  must().prepare('UPDATE message SET terminal_at=COALESCE(terminal_at, ?) WHERE id=?').run(at, id)
}

// Newest first — the inbox order. Bodies are PREVIEWED here, not returned whole: this
// feeds the 1.5s snapshot, and a message may be a quarter of a megabyte. The full
// body is fetched per row on demand (getMessageBody), so the copy-out surface is
// still lossless without paying for it on every scan.
export interface MessageBrief extends Omit<MessageRow, 'body'> {
  preview: string
  body_len: number
}
export function listMessages(limit = 100, previewChars = 400): MessageBrief[] {
  return must()
    .prepare(
      `SELECT id, from_session_id, from_handle, to_session_id, to_addr, state, reason, spool,
              thread_id, origin, created_at, routed_at, delivered_at, read_at, terminal_at,
              attempts, last_attempt_at,
              substr(body, 1, ?) AS preview, length(body) AS body_len
       FROM message ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(previewChars, limit) as MessageBrief[]
}

// Corroborate that a delivered message actually became a turn. `how` distinguishes
// an acknowledgement the recipient wrote from one inferred out of session activity —
// they are NOT equal evidence and the panel says which.
// `by` scopes the acknowledgement to the session the message was actually sent to, so
// one session cannot mark another's mail as read by quoting an id it happened to see.
export function markRead(id: string, how: string, at: number, by?: string): void {
  must()
    .prepare(
      `UPDATE message SET state='read', reason=?, read_at=COALESCE(read_at, ?)
       WHERE id=? AND read_at IS NULL AND state IN ('delivered','read')
         AND (? IS NULL OR to_session_id = ?)`,
    )
    .run(how, at, id, by ?? null, by ?? null)
}

// Delivered but not yet corroborated. Bounded and recent-only: an old delivery whose
// session has long since moved on can never be corroborated, so there is no point
// re-checking it forever.
export function getUnreadDelivered(since: number): MessageRow[] {
  return must()
    .prepare(
      "SELECT * FROM message WHERE state='delivered' AND read_at IS NULL AND delivered_at > ? LIMIT 200",
    )
    .all(since) as MessageRow[]
}

// Put a finished message back in flight. Only ever called for an explicit user
// resend, so it bumps attempts and records that a human did it — a message must
// never revive itself, which is how a retry loop becomes an autonomous fleet.
export function reopenMessage(id: string, reason: string, at: number): void {
  must()
    .prepare(
      `UPDATE message SET state='queued', reason=?, terminal_at=NULL,
         attempts=attempts+1, last_attempt_at=? WHERE id=?`,
    )
    .run(reason, at, id)
}

// The whole payload for one message. Deliberately its own call: this is what "copy
// it out by hand" resolves to, and it must never be the clipped version.
export function getMessageBody(id: string): string | undefined {
  const r = must().prepare('SELECT body FROM message WHERE id=?').get(id) as
    | { body: string }
    | undefined
  return r?.body
}

// Messages still in flight. Read at launch to re-hydrate the in-memory pipeline, so
// a restart resumes delivery instead of quietly abandoning everything mid-route.
export function getOpenMessages(): MessageRow[] {
  return must()
    .prepare('SELECT * FROM message WHERE terminal_at IS NULL ORDER BY created_at')
    .all() as MessageRow[]
}

// Every spool path any row still points at, terminal or not. The orphan sweep needs
// ALL of them: a message that failed keeps its file for recovery, and if only OPEN
// rows were counted the sweep would re-adopt that file on every launch and mint a
// fresh duplicate row each time.
export function getSpooledPaths(): Set<string> {
  const rows = must()
    .prepare('SELECT spool FROM message WHERE spool IS NOT NULL')
    .all() as { spool: string }[]
  return new Set(rows.map((r) => r.spool))
}

export function getMessage(id: string): MessageRow | undefined {
  return must().prepare('SELECT * FROM message WHERE id=?').get(id) as MessageRow | undefined
}

export function countOpenMessages(): number {
  const r = must()
    .prepare("SELECT COUNT(*) AS n FROM message WHERE terminal_at IS NULL AND state != 'queued'")
    .get() as { n: number }
  return r.n
}

// A removed session's mail is ARCHIVED, not deleted: still readable and copyable in
// the inbox under the retention window, then pruned like anything else terminal. An
// open message is archived where it stands; a delivered one keeps its own outcome,
// because "this landed before the session was removed" is the true record.
export function archiveMessages(sessionId: string, at: number): void {
  must()
    .prepare(
      `UPDATE message SET state='archived',
         reason=COALESCE(reason,'') || CASE WHEN reason IS NULL OR reason='' THEN '' ELSE ' · ' END
                || 'session removed',
         terminal_at=COALESCE(terminal_at, ?)
       WHERE (from_session_id=? OR to_session_id=?) AND terminal_at IS NULL`,
    )
    .run(at, sessionId, sessionId)
}

// User-set, in days. A mailbox is a record you may need to go back to, and how far
// back is a judgement about your own work, not something to hard-code.
const DEFAULT_RETENTION_DAYS = 7
const MAX_OPEN_MESSAGES = 500
const MAX_TERMINAL_MESSAGES = 2000
const MESSAGES_PER_SESSION = 200

// Two-axis retention, same shape as pruneLedger: age out first, then hard count
// ceilings applied SEPARATELY to open and terminal rows, plus a per-sender ring cap
// so one chatty pair cannot crowd the rest of the fleet out of the inbox.
export function pruneMessages(now: number, retentionDays?: number): void {
  const d = must()
  const days = Number.isFinite(retentionDays) && (retentionDays as number) > 0
    ? Math.min(365, retentionDays as number)
    : DEFAULT_RETENTION_DAYS
  const MESSAGE_RETENTION_MS = days * 24 * 60 * 60 * 1000
  // An open message older than the retention window is never going to route.
  d.prepare(
    `UPDATE message SET state='expired', reason=COALESCE(reason,'aged out'), terminal_at=?
     WHERE terminal_at IS NULL AND created_at < ?`,
  ).run(now, now - MESSAGE_RETENTION_MS)
  d.prepare(
    `UPDATE message SET state='expired', reason=COALESCE(reason,'displaced by newer mail'), terminal_at=?
     WHERE terminal_at IS NULL AND id NOT IN (
       SELECT id FROM message WHERE terminal_at IS NULL ORDER BY created_at DESC LIMIT ?
     )`,
  ).run(now, MAX_OPEN_MESSAGES)
  d.prepare('DELETE FROM message WHERE terminal_at IS NOT NULL AND terminal_at < ?').run(
    now - MESSAGE_RETENTION_MS,
  )
  d.prepare(
    `DELETE FROM message WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY from_session_id ORDER BY created_at DESC) AS rn
         FROM message WHERE terminal_at IS NOT NULL
       ) WHERE rn > ?
     )`,
  ).run(MESSAGES_PER_SESSION)
  d.prepare(
    `DELETE FROM message WHERE terminal_at IS NOT NULL AND id NOT IN (
       SELECT id FROM message WHERE terminal_at IS NOT NULL ORDER BY terminal_at DESC LIMIT ?
     )`,
  ).run(MAX_TERMINAL_MESSAGES)
}

// ---------- messaging grants: who may talk to whom ----------
// Default deny. The user grants; no session can ever open a link for itself, only use
// one that was opened for it. Every grant is a human act (or the auto-trust on a child
// the human deliberately spawned), which is the line between a fleet you direct and a
// fleet that organises itself.

// `dir` is expressed FROM x TO y and normalised to the stored orientation.
export function setGrant(
  x: string,
  y: string,
  dir: 'both' | 'to' | 'from' | 'none',
  by: string,
  at: number,
): void {
  if (x === y) return
  const { a, b, flipped } = pairOf(x, y)
  const mode =
    dir === 'both' || dir === 'none'
      ? dir
      : (dir === 'to') !== flipped
        ? 'a_to_b'
        : 'b_to_a'
  must()
    .prepare(
      `INSERT INTO message_grant (a_id, b_id, mode, granted_at, granted_by, revoked_at)
       VALUES (?,?,?,?,?,NULL)
       ON CONFLICT(a_id, b_id) DO UPDATE SET mode=excluded.mode, granted_at=excluded.granted_at,
         granted_by=excluded.granted_by, revoked_at=NULL`,
    )
    .run(a, b, mode, at, by)
}

// Revoke is stored as mode='none' rather than a delete, so it also overrides the
// trusted edge underneath. A deleted row would fall straight back through to the edge
// and the revoke would appear to do nothing.
export function revokeGrant(x: string, y: string, at: number): void {
  setGrant(x, y, 'none', 'user', at)
}

export function listGrants(): GrantRow[] {
  return must()
    .prepare('SELECT * FROM message_grant WHERE revoked_at IS NULL ORDER BY granted_at DESC')
    .all() as GrantRow[]
}

// Every explicit decision, as a lookup. Read once per scan, not per pair.
export function grantMap(): Map<string, GrantRow> {
  const m = new Map<string, GrantRow>()
  for (const g of listGrants()) m.set(`${g.a_id}|${g.b_id}`, g)
  return m
}

// A removed session's grants go with it. Not a cascade — the same reasoning as the
// message table: nodes are deleted on ordinary exit, and a grant is a decision the
// user made, so it is retired explicitly and visibly.
export function revokeGrantsFor(sessionId: string, at: number): void {
  must()
    .prepare('UPDATE message_grant SET revoked_at=? WHERE (a_id=? OR b_id=?) AND revoked_at IS NULL')
    .run(at, sessionId, sessionId)
}
