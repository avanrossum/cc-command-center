import fs from 'node:fs'
import path from 'node:path'

// Artifact detection: the previewable files THIS session produced. Two sources,
// scoped to avoid the folder-wide noise a blanket cwd scan caused (sessions
// sharing a directory showing each other's files):
//   1. TRANSCRIPT (Write/Edit paths) — text, code, markdown, html the agent
//      authored. Genuinely per-session.
//   2. CWD, BINARIES ONLY (image/audio/pdf/office), recent — the chart/chime/
//      generated doc a Bash step made, which never appears as a Write. Binaries
//      are rare in a project dir, so scanning just those stays low-noise.
// A path is kept only if it still exists as a file, so a since-deleted artifact
// drops off on its own.

export type ArtifactKind =
  | 'image'
  | 'svg'
  | 'pdf'
  | 'html'
  | 'markdown'
  | 'text'
  | 'audio'
  | 'code'
  | 'office'

export interface ArtifactInfo {
  path: string
  name: string
  kind: ArtifactKind
  mtimeMs: number
}

// Reasonable coverage of what an agent might actually produce — images, docs,
// sound, code, office files — not every extension on earth. Since detection is
// transcript-scoped (files the agent WROTE), config-y extensions (json/yaml) are
// safe to include here: they only surface if the agent authored them.
const EXT_KIND: Record<string, ArtifactKind> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image',
  '.svg': 'svg',
  '.pdf': 'pdf',
  '.html': 'html', '.htm': 'html',
  '.md': 'markdown', '.markdown': 'markdown',
  '.txt': 'text', '.csv': 'text', '.tsv': 'text', '.log': 'text',
  '.wav': 'audio', '.mp3': 'audio', '.m4a': 'audio', '.ogg': 'audio', '.flac': 'audio', '.aac': 'audio',
  '.docx': 'office', '.doc': 'office', '.xlsx': 'office', '.xls': 'office', '.pptx': 'office',
  '.ppt': 'office', '.odt': 'office', '.ods': 'office', '.odp': 'office', '.rtf': 'office',
  '.py': 'code', '.js': 'code', '.mjs': 'code', '.cjs': 'code', '.ts': 'code', '.tsx': 'code',
  '.jsx': 'code', '.sh': 'code', '.bash': 'code', '.zsh': 'code', '.rb': 'code', '.go': 'code',
  '.rs': 'code', '.java': 'code', '.c': 'code', '.h': 'code', '.cpp': 'code', '.cc': 'code',
  '.hpp': 'code', '.cs': 'code', '.php': 'code', '.swift': 'code', '.kt': 'code', '.scala': 'code',
  '.css': 'code', '.scss': 'code', '.less': 'code', '.json': 'code', '.yaml': 'code', '.yml': 'code',
  '.toml': 'code', '.xml': 'code', '.sql': 'code', '.lua': 'code', '.pl': 'code', '.r': 'code',
}
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])
const MAX_ARTIFACTS = 40
const MAX_SCAN_BYTES = 8 * 1024 * 1024 // tail window of the transcript, like the subtask scan
// Binary artifacts (a chart, a chime, a generated PDF/DOCX) are almost always
// produced by a Bash step, so they never appear as a Write in the transcript. We
// pick them up with a shallow cwd scan — limited to BINARY kinds and recent
// files, because unlike text/config a project dir rarely has stray binaries, so
// this adds the coverage without the folder-wide noise that made us drop the
// general cwd scan.
const CWD_KINDS = new Set<ArtifactKind>(['image', 'audio', 'pdf', 'office'])
const RECENT_MS = 24 * 60 * 60 * 1000
const MAX_CWD_ENTRIES = 3000

function kindOf(p: string): ArtifactKind | null {
  return EXT_KIND[path.extname(p).toLowerCase()] ?? null
}

// The kind of a path by extension (null = not a recognized artifact). Exported so
// the open/read guard and the read handler share one source of truth.
export function artifactKindOf(p: string): ArtifactKind | null {
  return kindOf(p)
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

// Recent BINARY previewables at the top level of the cwd — the chart/chime/PDF a
// Bash step made, which the transcript never names. One shallow readdir, never
// recursive; skips dotfiles and anything older than RECENT_MS.
function fromCwdBinaries(cwd: string, now: number): string[] {
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
    const kind = kindOf(e.name)
    if (!kind || !CWD_KINDS.has(kind)) continue
    const full = path.join(cwd, e.name)
    try {
      if (now - fs.statSync(full).mtimeMs <= RECENT_MS) out.push(full)
    } catch {
      /* gone */
    }
  }
  return out
}

// Previewable files this session produced, newest first. Text/code/markdown/html
// come from the transcript (session-scoped); recent binaries come from a shallow
// cwd scan. mtime-cached by transcript + cwd mtime.
export function scanArtifacts(
  transcriptPath: string | undefined,
  cwd: string,
  now = Date.now(),
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
  let cwdMtime = 0
  try {
    cwdMtime = fs.statSync(cwd).mtimeMs
  } catch {
    /* no cwd */
  }
  const key = `${txSize}:${txMtime}:${cwdMtime}`
  const cacheKey = `${transcriptPath}|${cwd}`
  const hit = cache.get(cacheKey)
  if (hit && hit.key === key) return hit.artifacts

  const paths = new Set<string>()
  if (txSize) for (const p of fromTranscript(transcriptPath, txSize, cwd)) paths.add(p)
  for (const p of fromCwdBinaries(cwd, now)) paths.add(p)

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
