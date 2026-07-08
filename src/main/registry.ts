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
}

export interface NodeRow {
  session_id: string
  cwd: string | null
  name: string | null
  category_id: number | null
  origin: string | null
  first_seen: number
  last_seen: number
}

const PALETTE = [
  '#60a5fa',
  '#a78bfa',
  '#34d399',
  '#f59e0b',
  '#f472b6',
  '#22d3ee',
  '#fb7185',
  '#a3e635',
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
}

export interface Edge {
  child_id: string
  parent_id: string
  type: string
  source: string
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
     ON CONFLICT(child_id) DO UPDATE SET parent_id=excluded.parent_id, type=excluded.type`,
  ).run(childId, parentId, type, Date.now())
  return true
}

export function clearParent(childId: string): void {
  must().prepare('DELETE FROM edge WHERE child_id=?').run(childId)
}

export function getEdges(): Edge[] {
  return must().prepare('SELECT child_id, parent_id, type, source FROM edge').all() as Edge[]
}

export function listCategories(): Category[] {
  return must()
    .prepare('SELECT id, name, color, sort FROM category ORDER BY sort, id')
    .all() as Category[]
}

export function createCategory(name: string, color?: string): Category {
  const d = must()
  const count = (d.prepare('SELECT COUNT(*) AS c FROM category').get() as { c: number }).c
  const col = color || PALETTE[count % PALETTE.length]
  const info = d
    .prepare('INSERT INTO category (name, color, sort, created_at) VALUES (?,?,?,?)')
    .run(name, col, count, Date.now())
  return { id: Number(info.lastInsertRowid), name, color: col, sort: count }
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
    d.prepare(
      'INSERT INTO node (session_id, cwd, name, category_id, origin, first_seen, last_seen) VALUES (?,?,?,?,?,?,?)',
    ).run(sessionId, info.cwd ?? null, info.name ?? null, null, info.origin ?? 'adopted', now, now)
  }
}

export function assignCategory(sessionId: string, categoryId: number | null): void {
  must().prepare('UPDATE node SET category_id=? WHERE session_id=?').run(categoryId, sessionId)
}

export function getNodeMap(): Map<string, NodeRow> {
  const rows = must().prepare('SELECT * FROM node').all() as NodeRow[]
  const m = new Map<string, NodeRow>()
  for (const r of rows) m.set(r.session_id, r)
  return m
}
