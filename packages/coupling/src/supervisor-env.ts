// Whether the shared supervisor was started with Alex's PATH (MIP2-1457).
// Seen live (2.1.311, isolated config): a session's commands use the PATH of
// whatever last started or restarted it (`--bg`, `--resume`, `respawn`),
// not the supervisor's; `ps -E` on the session still shows the
// supervisor's. A supervisor started without the folder `claude` is in
// shows that something without Alex's PATH has been starting sessions, and
// any it restarts on its own may lack his tools. The app says so.

import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { ClaudeCommandError, type ClaudeRunner } from './claude-cli.ts'

export interface SupervisorPath {
  pid: number
  /** The supervisor's PATH, or null when it couldn't be read. */
  path: string | null
  /** The folder holding the `claude` binary the app runs. */
  claudeDir: string
  /** Whether the supervisor's PATH holds that folder. */
  ok: boolean
}

/** The supervisor's pid from `claude daemon status`, or null when it isn't running. */
export function daemonPid(status: string): number | null {
  if (/not running/.test(status)) return null
  const pid = /^\s*pid:\s+(\d+)/m.exec(status)?.[1]
  return pid ? Number(pid) : null
}

/**
 * PATH from `ps eww` output: the command, then its environment, with no
 * delimiter. The last `PATH=` is the environment's; one inside the command
 * line comes first (pass 8, L-5). Null when absent, or when it holds no
 * absolute folder: then it's unknown, not a failure.
 */
export function pathFromPs(text: string): string | null {
  const all = [...text.matchAll(/(?:^|\s)PATH=(\S*)/g)]
  const value = all.at(-1)?.[1] ?? null
  return value && value.split(':').some(d => d.startsWith('/')) ? value : null
}

const readPs = (pid: number): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile('/bin/ps', ['eww', '-o', 'command=', '-p', String(pid)], { timeout: 5_000, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  )

/** The running supervisor's PATH against the folder holding `binary`; null when no supervisor runs. */
export async function checkSupervisorPath(run: ClaudeRunner, binary: string, ps: (pid: number) => Promise<string> = readPs): Promise<SupervisorPath | null> {
  // `daemon status` exits non-zero when no supervisor runs; its output still says so (MIP2-1463 live run).
  const status = await run(['daemon', 'status'], { timeoutMs: 10_000 }).catch((err: unknown) => (err instanceof ClaudeCommandError ? `${err.stdout}\n${err.stderr}` : ''))
  const pid = daemonPid(status)
  if (pid === null) return null
  const claudeDir = dirname(binary)
  const path = pathFromPs(await ps(pid).catch(() => ''))
  // An unreadable PATH is unknown, not a failure (pass 8, L-5).
  if (path === null) return null
  return { pid, path, claudeDir, ok: path.split(':').includes(claudeDir) }
}
