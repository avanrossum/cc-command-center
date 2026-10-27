// Sending a prompt to a session that may be stopped (DECISION item 2):
// respawn first when its process is gone, wait for its mod to reach the app,
// then relay. A respawn ends a pending permission wait (MIP2-1377 §4a), so a
// session waiting on Alex is never respawned; the prompt is refused instead.

import type { FleetSnapshot } from '@ccc/contract'
import type { ChannelHub } from './channel/hub.ts'
import type { SessionHost } from './session-host.ts'

export interface SessionControlOptions {
  host: SessionHost
  hub: Pick<ChannelHub, 'relayPrompt' | 'health'>
  current: () => FleetSnapshot | null
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How long to wait for a respawned session's mod; ~2.5 s observed (MIP2-1377 §2). */
  contactTimeoutMs?: number
}

export class SessionControl {
  private readonly o: Required<SessionControlOptions>

  constructor(opts: SessionControlOptions) {
    this.o = { now: Date.now, sleep: ms => new Promise(r => setTimeout(r, ms)), contactTimeoutMs: 20_000, ...opts }
  }

  /** Relays `text` as Alex's own input. Resolves to the relay's id. */
  async sendPrompt(sessionId: string, text: string): Promise<string> {
    const s = this.o.current()?.sessions.find(x => x.sessionId === sessionId)
    if (!s) throw new Error('no such session')
    if (s.needsYou.value !== null) throw new Error('the session is waiting on you; answer it first')
    if (s.pid.value === null) {
      const since = this.o.now()
      await this.o.host.respawn(sessionId)
      await this.waitForContact(sessionId, since)
    }
    return this.o.hub.relayPrompt(sessionId, text)
  }

  private async waitForContact(sessionId: string, since: number): Promise<void> {
    const deadline = since + this.o.contactTimeoutMs
    while (this.o.now() < deadline) {
      const ch = this.o.hub.health().find(h => h.sessionId === sessionId)
      if (ch && ch.contactAt > since) return
      await this.o.sleep(250)
    }
    throw new Error("the session restarted but its reporter didn't reach the app")
  }
}
