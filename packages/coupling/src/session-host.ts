// How the app runs sessions (DECISION item 2). The supervisor implementation
// is the plan; an app-owned PTY implementation is the fallback, built only if
// a contingency trigger fires. Both sit behind this interface, so the rest of
// the app doesn't change when the host does.

import type { SessionSnapshot } from '@ccc/contract'

export interface LaunchOptions {
  cwd: string
  name?: string
  model?: string
  effort?: string
  permissionMode?: string
  /** The first prompt. A session started without one reads as blocked. */
  prompt?: string
  /** Worktree isolation, per category (D-011 item 2). `none`, editing in place, is the default. */
  isolation?: 'none' | 'worktree'
  /** `"ultracode": true` in the session's settings file (settings-reference `ultracode`); the effort level is unchanged. */
  ultracode?: boolean
  /** Extra flags, after the app's own; checked against the app's flags before they get here (src/shared/flags.ts). */
  extraArgs?: string[]
  /** The trust step only: resume this session (`--resume <id>`) instead of starting one (MIP2-1461). */
  resume?: string
}

export interface ResumeOptions {
  model?: string
  effort?: string
  permissionMode?: string
}

/** A command the app runs in a terminal view to show a session (Focus). */
export interface AttachCommand {
  file: string
  args: string[]
  cwd: string
  /** A trust run, which starts or resumes a session: it carries SESSION_SWITCHES (MIP2-1463). */
  session?: boolean
}

export interface ListResult {
  sessions: SessionSnapshot[]
  /** Entries the host couldn't read, for the source-health line. */
  rejected: { index: number; reason: string }[]
}

export interface SessionHost {
  launch(opts: LaunchOptions): Promise<{ sessionId: string }>
  /** Resumes with the session's saved options; flags would start a copy (MIP2-1377 §1b). */
  resume(sessionId: string): Promise<void>
  /** A copy of the conversation under a new id, with new launch settings (MIP2-1387 §2.3). */
  startCopy(sessionId: string, opts: Omit<LaunchOptions, 'cwd' | 'prompt'>): Promise<{ sessionId: string }>
  /** Moves a session whose 0.24 process has exited into the app: resumed in place with the app's flags (MIP2-1425). */
  moveIn(sessionId: string, opts: Omit<LaunchOptions, 'prompt' | 'extraArgs' | 'ultracode'>): Promise<{ sessionId: string; sameId: boolean }>
  /** The command to run in a terminal view. The view's process is the attach; exiting it detaches. */
  attach(sessionId: string): Promise<AttachCommand>
  stop(sessionId: string): Promise<void>
  /** Stops the session if it has a process and waits until it has none; false when it had none. */
  stopIfRunning(sessionId: string): Promise<boolean>
  respawn(sessionId: string): Promise<void>
  rm(sessionId: string): Promise<void>
  list(): Promise<ListResult>
  /** Sessions the app is stopping, respawning, resuming or copying now, or did within the last 10 s (MIP2-1447). */
  changing?(): ReadonlySet<string>
}

/** Thrown by a host method whose milestone hasn't been built yet. */
export class NotBuiltYet extends Error {
  constructor(method: string, milestone: string) {
    super(`SessionHost.${method} is not built yet (milestone ${milestone})`)
    this.name = 'NotBuiltYet'
  }
}
