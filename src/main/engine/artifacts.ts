import fs from 'node:fs'
import path from 'node:path'

// Artifact detection: the previewable files THIS session produced. Sourced from
// the transcript's Write/Edit tool_use blocks — files the agent actually wrote,
// which is genuinely per-session. A folder (cwd) scan was tried but dropped: it
// surfaced every previewable file in the directory, so sessions sharing a folder
// all showed each other's files — confusing, and not "this session's work". The
// tradeoff is that a file created only by a Bash step (not the Write tool) isn't
// caught; a folder browser could be a separate view later. A path is kept only if
// it still exists as a file, so a since-deleted artifact drops off on its own.

export type ArtifactKind = 'image' | 'svg' | 'pdf' | 'html' | 'markdown' | 'text'

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
  // Plain text / data files an agent commonly produces. JSON/YAML/XML are left
  // out on purpose — they're usually config, not a produced artifact.
  '.txt': 'text',
  '.csv': 'text',
  '.tsv': 'text',
  '.log': 'text',
}
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])
const MAX_ARTIFACTS = 40
const MAX_SCAN_BYTES = 8 * 1024 * 1024 // tail window of the transcript, like the subtask scan

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

// Previewable files this session wrote, newest first. mtime-cached by the
// transcript's size/mtime (a new Write appends, so both change).
export function scanArtifacts(
  transcriptPath: string | undefined,
  cwd: string,
  _now = Date.now(),
): ArtifactInfo[] {
  if (!transcriptPath) return []
  let txSize = 0
  let txMtime = 0
  try {
    const st = fs.statSync(transcriptPath)
    txSize = st.size
    txMtime = st.mtimeMs
  } catch {
    return [] // no transcript — nothing to attribute to this session
  }
  const key = `${txSize}:${txMtime}`
  const cacheKey = `${transcriptPath}|${cwd}`
  const hit = cache.get(cacheKey)
  if (hit && hit.key === key) return hit.artifacts

  const paths = new Set<string>()
  if (txSize) for (const p of fromTranscript(transcriptPath, txSize, cwd)) paths.add(p)

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
