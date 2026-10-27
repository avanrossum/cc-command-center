// What a move from CC Command Center 0.24 resumes with (MIP2-1425; spec
// MIP2-1379 §6.2 step 3): the session's folder and name, and the launch
// settings 0.24 saved for it (model, 1M context, effort, mode). And whether
// a session can be copied yet (MIP2-1434). Pure.

import type { SessionSnapshot } from '@ccc/contract'
import type { LaunchRequest } from '../shared/ipc.ts'
import type { SessionMeta } from '../shared/store.ts'
import { checkLaunch } from './validate.ts'

export function moveRequest(meta: SessionMeta | undefined, listedCwd: string | undefined): LaunchRequest | null {
  const cwd = listedCwd ?? meta?.cwd
  if (!cwd) return null
  const f = meta?.resumeFlags ?? {}
  // 0.24's `ultracode` effort is xhigh here (MIP2-1387 §2.4), and its `1m` context is the model's [1m] suffix.
  const effort = f.effort === 'ultracode' ? 'xhigh' : f.effort
  const model = f.model ? (f.context === '1m' && !f.model.endsWith('[1m]') ? `${f.model}[1m]` : f.model) : undefined
  const full = { cwd, name: meta?.name, model, effort, permissionMode: f.mode }
  // A saved value the app doesn't accept is dropped, not sent; the session then runs with Claude Code's default for it.
  return checkLaunch(full) ?? checkLaunch({ cwd, name: meta?.name }) ?? checkLaunch({ cwd })
}

/**
 * Why a session can't be copied yet, or null (MIP2-1434, QA's follow-up on
 * MIP2-1440). Claude Code 2.1.311 copies a session that never ran a turn of
 * its own, prints "started a copy", and the copy fails within seconds.
 * - Its mod's last word counts, even after the process stops: a session last
 *   seen awaiting its first message never had a turn.
 * - A session the app launched whose mod hasn't reported yet (about 3 s
 *   after launch) is waited for.
 * - A session without the mod (started outside the app) can be copied once
 *   the agent list shows it idle or working. Claude Code lists one that
 *   hasn't had its first message as blocked (Research MIP2-1426).
 */
export function copyRefusal(s: SessionSnapshot | undefined, launchedHere = false): string | null {
  if (!s) return 'Wait a moment for the session to report, then try again.'
  const name = s.name.value || 'This session'
  if (s.awaitingFirstPrompt?.value) return `${name} hasn't had a message yet, and Claude Code can't copy a session before its first turn. Send it a message, then try again.`
  if (s.awaitingFirstPrompt) return null
  if (launchedHere) return 'Wait a moment for the session to report, then try again.'
  if (s.activity.value === 'idle' || s.activity.value === 'working') return null
  return `${name} can't be copied until it has had a message.`
}

/**
 * Why a session can't be moved into the app now, or null (pass 8, M-2).
 * The move sheet and the trust step's resume both ask, so neither path can
 * resume what the other refuses. It must be a session started outside this
 * app (a 0.24 import, or one run in a terminal, MIP2-1466), not yet moved
 * or archived, with no process running it, and its channel must not be
 * marked untrusted.
 */
export function movePreflight(meta: SessionMeta | undefined, listed: SessionSnapshot | undefined, untrusted: string | null): string | null {
  if (meta?.origin === 'app') return 'it was started in this app; resume it instead'
  if (meta?.movedAt) return 'it was already moved into the app'
  if (meta?.archivedAt) return "it's archived"
  // Not removedAt: the store sets it whenever a listed session leaves the list, which for an interactive
  // session is just its exit, the very thing a move waits for (MIP2-1466 live run). It clears when listed again.
  if (listed && listed.pid.value !== null && !listed.pid.stale) return 'it is still running; close it first'
  if (untrusted) return `its channel can't be trusted (${untrusted})`
  return null
}

/**
 * What the Focus view says for an interactive session running outside the
 * app (MIP2-1466): where, since when, and that closing it there lets the
 * app resume it. `host` is the terminal app, when it could be found.
 */
export function terminalMessage(host: string | null, startedAt: number): string {
  const since = new Date(startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `Running in a terminal (${host ? `${host}, ` : ''}since ${since}). Close it there, then the app can resume it.`
}
