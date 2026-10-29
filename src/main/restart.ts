// Every restart of a session on its saved options that the app starts goes
// through here (gate pass 18, H-1, M-2; pass 19, H-1): a resume from the
// app, the watchdog's respawn, the respawn before a prompt to a stopped
// session, and an attach to a stopped session, which Claude Code restarts
// too ("when you reply or attach, Claude restarts it", agent-view.md). A
// bare restart loads what Claude Code saved for the session, so the
// verdict (mod-verdict.ts restartVerdict) is asked at the moment of the
// restart: after a resume's stop and re-key.
//
// Known gaps (pass 19, M-1): the time between this check and Claude Code
// reading the file as the process starts, which the app can't close, since
// passing the options explicitly turns a resume into a copy (QA MIP2-1505);
// and the supervisor's own restart of a session that exits unexpectedly,
// which the app neither starts nor sees. Detecting the latter (a process
// change the app didn't start) is 1.0.2 work.

import type { SessionHost } from '@ccc/coupling'
import { ModStuck } from './resume.ts'

/**
 * The host, with `resume`, `respawn`, and `attach` to a stopped session,
 * refused when `verdict` gives a reason. Every other method is the host's
 * own. Main hands only this to the code that restarts sessions (wireHosts).
 */
export function guardRestarts<H extends Pick<SessionHost, 'resume' | 'respawn' | 'attach'>>(
  host: H,
  verdict: (sessionId: string) => string | null,
  stopped: (sessionId: string) => boolean = () => true,
): H {
  return new Proxy(host, {
    get(target, prop, receiver) {
      // An attach to a running session restarts nothing, so it's left alone; to a stopped one, it's a restart.
      if (prop === 'attach') {
        return async (sessionId: string, ...rest: unknown[]) => {
          const why = stopped(sessionId) ? verdict(sessionId) : null
          if (why) throw new ModStuck(why)
          return (target.attach as (id: string, ...a: unknown[]) => unknown).call(target, sessionId, ...rest)
        }
      }
      if (prop === 'resume' || prop === 'respawn') {
        return async (sessionId: string, ...rest: unknown[]) => {
          const why = verdict(sessionId)
          if (why) throw new ModStuck(why)
          return (target[prop] as (id: string, ...a: unknown[]) => Promise<void>).call(target, sessionId, ...rest)
        }
      }
      const v = Reflect.get(target, prop, receiver) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
}

/**
 * The host for each consumer that can restart a session (gate pass 19,
 * L-2): the watchdog, the controls (resume and the prompt's respawn), the
 * Focus views (attach), and the trust step. Each gets the guarded host, so
 * none can be handed the raw one by mistake.
 */
export function wireHosts<H extends Pick<SessionHost, 'resume' | 'respawn' | 'attach'>>(host: H, verdict: (sessionId: string) => string | null, stopped: (sessionId: string) => boolean) {
  const restarts = guardRestarts(host, verdict, stopped)
  return { watchdog: restarts, control: restarts, pool: restarts, trust: restarts }
}
