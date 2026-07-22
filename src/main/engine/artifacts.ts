import fs from 'node:fs'
import path from 'node:path'

// Artifact detection: the previewable files a session produced. Two passive
// sources, no filesystem watcher:
//   1. THE TRANSCRIPT. Write/Edit tool_use blocks carry a file_path — catches
//      agent-authored files (HTML mocks, SVGs, docs) anywhere on disk.
//   2. THE CWD TOP LEVEL. A shallow readdir (one level, never recursive — no
//      descending into node_modules) catches files a Bash step produced (a chart
//      a script rendered, a screenshot) that the transcript never names.
// A path is kept only if it still exists as a file, so a since-deleted artifact
// drops off on its own. This mirrors the subtask scanner: derive from what's on
// disk, cache by mtime, surface nothing that isn't really there.

export type ArtifactKind = 'image' | 'svg' | 'pdf' | 'html' | 'markdown'

export interface ArtifactInfo {
  path: string
  name: string
  kind: ArtifactKind
  mtimeMs: number
}

const EXT_KIND: Record<string, ArtifactKind> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.svg': 'svg',
  '.pdf': 'pdf',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
}
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])
const MAX_ARTIFACTS = 40
const RECENT_MS = 24 * 60 * 60 * 1000 // a cwd file counts if touched within a day
const MAX_SCAN_BYTES = 8 * 1024 * 1024 // tail window of the transcript, like the subtask scan
const MAX_CWD_ENTRIES = 2000 // don't stat an enormous directory

function kindOf(p: string): ArtifactKind | null {
  return EXT_KIND[path.extname(p).toLowerCase()] ?? null
}

interface Cache {
  key: string
  artifacts: ArtifactInfo[]
}
const cache = new Map<string, Cache>()

// Write/Edit file_paths from the transcript tail. Absolute paths are used as-is;
// a relative one is resolved against the cwd.
function fromTranscript(transcriptPath: string, size: number, cwd: string): string[] {
  const from = Math.max(0, size - MAX_SCAN_BYTES)
  let buf: string
  try {
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const len = size - from
      const b = Buffer.alloc(len)
      fs.readSync(fd, b, 0, len, from)
      buf = b.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
  const out: string[] = []
  const lines = buf.split('\n')
  const start = from > 0 ? 1 : 0
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || !line.includes('file_path')) continue
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
      if (b.type !== 'tool_use' || !WRITE_TOOLS.has(b.name as string)) continue
      const fp = (b.input as { file_path?: unknown } | undefined)?.file_path
      if (typeof fp !== 'string' || !fp) continue
      if (!kindOf(fp)) continue
      out.push(path.isAbsolute(fp) ? fp : path.resolve(cwd, fp))
    }
  }
  return out
}

// Previewable files at the TOP LEVEL of the cwd, touched recently. One readdir,
// never recursive.
function fromCwd(cwd: string, now: number): string[] {
  if (!cwd) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries.slice(0, MAX_CWD_ENTRIES)) {
    if (!e.isFile() || e.name.startsWith('.')) continue
    if (!kindOf(e.name)) continue
    const full = path.join(cwd, e.name)
    try {
      if (now - fs.statSync(full).mtimeMs <= RECENT_MS) out.push(full)
    } catch {
      /* gone */
    }
  }
  return out
}

// Previewable files this session produced, newest first. mtime-cached by the
// transcript's size/mtime plus the cwd's mtime (a new file bumps the dir mtime).
export function scanArtifacts(
  transcriptPath: string | undefined,
  cwd: string,
  now = Date.now(),
): ArtifactInfo[] {
  let txSize = 0
  let txMtime = 0
  if (transcriptPath) {
    try {
      const st = fs.statSync(transcriptPath)
      txSize = st.size
      txMtime = st.mtimeMs
    } catch {
      /* no transcript — cwd scan still runs */
    }
  }
  let cwdMtime = 0
  try {
    cwdMtime = fs.statSync(cwd).mtimeMs
  } catch {
    /* no cwd */
  }
  const key = `${txSize}:${txMtime}:${cwdMtime}`
  const cacheKey = `${transcriptPath ?? ''}|${cwd}`
  const hit = cache.get(cacheKey)
  if (hit && hit.key === key) return hit.artifacts

  const paths = new Set<string>()
  if (transcriptPath && txSize) for (const p of fromTranscript(transcriptPath, txSize, cwd)) paths.add(p)
  for (const p of fromCwd(cwd, now)) paths.add(p)

  const out: ArtifactInfo[] = []
  for (const p of paths) {
    const kind = kindOf(p)
    if (!kind) continue
    let st: fs.Stats
    try {
      st = fs.statSync(p)
    } catch {
      continue // since deleted — drop it
    }
    if (!st.isFile()) continue
    out.push({ path: p, name: path.basename(p), kind, mtimeMs: st.mtimeMs })
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const artifacts = out.slice(0, MAX_ARTIFACTS)
  cache.set(cacheKey, { key, artifacts })
  return artifacts
}

export function forgetArtifacts(transcriptPath: string, cwd: string): void {
  cache.delete(`${transcriptPath}|${cwd}`)
}
