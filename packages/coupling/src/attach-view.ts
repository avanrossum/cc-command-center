// Focus: `claude attach <id>` in a pseudo-terminal the app owns (DECISION
// item 2). The renderer draws it with xterm.js; this side runs the process.
//
// Leaving (spec MIP2-1379 §2.2, Research MIP2-1403): only Ctrl+Z ends
// `claude attach`; every other way out switches it to agent view, which must
// not stay live in the pane, and holds a supervisor spare until the process
// ends. So leaving always ends the process: Ctrl+Z first, then SIGTERM.

import * as pty from 'node-pty'
import { claudeEnv, sessionEnv } from './claude-cli.ts'
import type { AttachCommand, SessionHost } from './session-host.ts'

export interface AttachEvents {
  data(sessionId: string, data: string): void
  exit(sessionId: string, code: number): void
}

/** The process interface the pool needs; node-pty's IPty, or a stand-in in tests. */
export interface AttachProcess {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
}

export type SpawnAttach = (cmd: AttachCommand, cols: number, rows: number) => AttachProcess

export const spawnAttach: SpawnAttach = (cmd, cols, rows) => {
  const p = pty.spawn(cmd.file, cmd.args, { name: 'xterm-256color', cols, rows, cwd: cmd.cwd, env: (cmd.session ? sessionEnv() : claudeEnv()) as Record<string, string> })
  return {
    write: d => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: s => p.kill(s),
    onData: cb => void p.onData(cb),
    onExit: cb => void p.onExit(cb),
  }
}

/** How many views stay attached at once (spec §2.3: matches Split's maximum). */
export const KEPT_ATTACHED = 4
/** After Ctrl+Z, how long the process gets to exit before SIGTERM. */
const LEAVE_GRACE_MS = 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PASTE_END = '\x1b[201~'

/** Text as one bracketed paste; an embedded end marker can't end it early. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text.split(PASTE_END).join('')}${PASTE_END}`
}

/** A path as one shell word: single-quoted when it holds a space or a shell-special character. */
export function quotePath(path: string): string {
  return /^[A-Za-z0-9_./~@%+=:,-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

interface View {
  process: AttachProcess
  leaving: boolean
  usedAt: number
}

export class AttachPool {
  private readonly views = new Map<string, View>()

  constructor(
    private readonly host: Pick<SessionHost, 'attach'>,
    private readonly events: AttachEvents,
    private readonly spawn: SpawnAttach = spawnAttach,
    private readonly now: () => number = Date.now,
  ) {}

  has(sessionId: string): boolean {
    return this.views.has(sessionId)
  }

  attached(): string[] {
    return [...this.views.keys()]
  }

  /** Attaches the session, or brings an attached one forward. Keeps at most KEPT_ATTACHED. */
  async open(sessionId: string, cols: number, rows: number): Promise<void> {
    if (!UUID.test(sessionId)) throw new Error('not a session id')
    const live = this.views.get(sessionId)
    if (live && !live.leaving) {
      live.usedAt = this.now()
      live.process.resize(cols, rows)
      return
    }
    const cmd = await this.host.attach(sessionId)
    const process = this.spawn(cmd, cols, rows)
    const view: View = { process, leaving: false, usedAt: this.now() }
    this.views.set(sessionId, view)
    process.onData(d => this.events.data(sessionId, d))
    process.onExit(({ exitCode }) => {
      if (this.views.get(sessionId) === view) this.views.delete(sessionId)
      this.events.exit(sessionId, exitCode)
    })
    this.evict()
  }

  write(sessionId: string, data: string): void {
    const v = this.views.get(sessionId)
    if (v && !v.leaving) v.process.write(data)
  }

  paste(sessionId: string, text: string, submit: boolean): void {
    this.write(sessionId, bracketedPaste(text) + (submit ? '\r' : ''))
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.views.get(sessionId)?.process.resize(cols, rows)
  }

  /** Ends the attach process: the session keeps running in the supervisor. */
  leave(sessionId: string): void {
    const v = this.views.get(sessionId)
    if (!v || v.leaving) return
    v.leaving = true
    v.process.write('\x1a')
    setTimeout(() => {
      if (this.views.get(sessionId) === v) v.process.kill('SIGTERM')
    }, LEAVE_GRACE_MS).unref?.()
  }

  leaveAll(): void {
    for (const id of [...this.views.keys()]) this.leave(id)
  }

  private evict(): void {
    const live = [...this.views.entries()].filter(([, v]) => !v.leaving)
    if (live.length <= KEPT_ATTACHED) return
    live.sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [id] of live.slice(0, live.length - KEPT_ATTACHED)) this.leave(id)
  }
}
