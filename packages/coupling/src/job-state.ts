// A background session's saved launch options (Research MIP2-1506, Claude
// Code 2.1.312): `<config>/jobs/<short id>/state.json`, field `respawnFlags`,
// an argv array. A bare `--resume <id> --bg` or `respawn` restarts the
// session with these, its saved `--plugin-dir` included. The file is still
// there after `claude stop`.
//
// agent-view.md: "The files under `~/.claude/jobs/<id>/` are not a stable
// interface." So this is a read-only, best-effort hint (D-004 fallback): a
// missing file or any shape other than the one observed is refused with
// the reason, never guessed at. Nothing here writes to the file.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const SHORT_ID = /^[0-9a-f]{8}$/
/** A state file is small; anything larger isn't the shape observed. Bytes. */
export const STATE_MAX_BYTES = 256 * 1024

/** The Claude Code config folder the app's own `claude` commands use: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR && isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : join(homedir(), '.claude')
}

/**
 * Reads a state file without blocking: the file itself is opened no-follow
 * (its parent folders may be links) and non-blocking, then fstat'd, and
 * read only if it's a regular file within STATE_MAX_BYTES, at most that
 * many bytes (gate pass 17, M-2; pass 18, L-1). A session can replace its own file with a FIFO, a link or
 * a huge file; this runs on the main thread. Throws on anything else.
 */
export function readStateFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error('not a regular file')
    if (st.size > STATE_MAX_BYTES) throw new Error('too large')
    const buf = Buffer.alloc(STATE_MAX_BYTES + 1)
    let n = 0
    for (let r; n <= STATE_MAX_BYTES && (r = readSync(fd, buf, n, STATE_MAX_BYTES + 1 - n, null)) > 0; ) n += r
    if (n > STATE_MAX_BYTES) throw new Error('too large')
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The mod folder and the settings file a session would restart with, both absolute, and every saved flag. */
export type SavedOptions = { dir: string; settings: string; flags: string[]; cwd: string } | { refused: string }

/** The value after `flag`, which must appear exactly once, as a separate argument; null otherwise. */
function single(flags: string[], flag: string): string | null {
  const at = flags.flatMap((f, i) => (f === flag || f.startsWith(`${flag}=`) ? [i] : []))
  if (at.length !== 1 || flags[at[0]!] !== flag) return null
  const value = flags[at[0]! + 1]
  return typeof value === 'string' && value !== '' && !value.startsWith('--') ? value : null
}

/**
 * The `--plugin-dir` and `--settings` a session would restart with, as
 * absolute paths. A relative one is resolved against the file's `cwd`, as
 * Claude Code saves paths exactly as given. Refused when the file is
 * missing, unreadable or not a small regular file, names another session,
 * or `respawnFlags` isn't an array of strings with exactly one of each flag
 * followed by a value. The app checks every saved flag against its record
 * of the launch on every restart (mod-verdict.ts restartVerdict; gate pass
 * 17, M-1; pass 18, H-1, M-1).
 */
export function readSavedOptions(configDir: string, shortId: string, sessionId: string, read: (path: string) => string = readStateFile): SavedOptions {
  if (!SHORT_ID.test(shortId)) return { refused: 'its short id has an unexpected form' }
  let text: string
  try {
    text = read(join(configDir, 'jobs', shortId, 'state.json'))
  } catch {
    return { refused: "Claude Code's saved options for it can't be read" }
  }
  let state: unknown
  try {
    state = JSON.parse(text)
  } catch {
    return { refused: "Claude Code's saved options for it aren't readable JSON" }
  }
  const shape = "Claude Code's saved options for it have an unexpected shape"
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return { refused: shape }
  const s = state as { sessionId?: unknown; cwd?: unknown; respawnFlags?: unknown }
  if (s.sessionId !== sessionId) return { refused: "Claude Code's saved options there are for another session" }
  const flags = s.respawnFlags
  if (!Array.isArray(flags) || !flags.every(f => typeof f === 'string')) return { refused: shape }
  const dir = single(flags, '--plugin-dir')
  const settings = single(flags, '--settings')
  if (dir === null || settings === null) return { refused: shape }
  const abs = (v: string) => (isAbsolute(v) ? resolve(v) : typeof s.cwd === 'string' && isAbsolute(s.cwd) ? resolve(s.cwd, v) : null)
  const d = abs(dir)
  const st = abs(settings)
  // The folder it restarts in is checked too (gate pass 19, M-2).
  if (typeof s.cwd !== 'string' || !isAbsolute(s.cwd)) return { refused: shape }
  return d && st ? { dir: d, settings: st, flags: [...flags], cwd: resolve(s.cwd) } : { refused: shape }
}

/**
 * What a blocked job with no process waits on, from its state file's
 * \`needs\` (or \`detail\`), in Claude Code's words (MIP2-1558, QA
 * MIP2-1559: "approve 1 new project MCP server (<name>) — attach to
 * respond"). Read-only and best effort, as readSavedOptions: null when the
 * file is missing, odd, or says nothing. Control characters are dropped and
 * the text capped; it's shown as untrusted text.
 */
export function readJobNeeds(configDir: string, shortId: string, read: (path: string) => string = readStateFile): string | null {
  if (!SHORT_ID.test(shortId)) return null
  try {
    const s = JSON.parse(read(join(configDir, 'jobs', shortId, 'state.json'))) as { needs?: unknown; detail?: unknown }
    const text = typeof s.needs === 'string' && s.needs.trim() ? s.needs : typeof s.detail === 'string' ? s.detail : ''
    const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
    return clean ? clean.slice(0, 300) : null
  } catch {
    return null
  }
}

