import os from 'node:os'
import { scanLiveSessions } from '../src/main/engine/sessions'

// One-shot validation of the state engine against the live ~/.claude data.
// Prints every live session with its transcript-derived coarse state, so the
// output can be eyeballed against what the sessions are actually doing.
const HOME = os.homedir()
const now = Date.now()
const sessions = scanLiveSessions(now)
const live = sessions.filter((s) => s.alive && !s.isSpare)
const spares = sessions.filter((s) => s.alive && s.isSpare)
const dead = sessions.filter((s) => !s.alive)

console.log(
  `Registry: ${sessions.length} entries — ${live.length} live sessions, ${spares.length} spares, ${dead.length} dead\n`,
)

const byState: Record<string, number> = {}
for (const s of live) byState[s.state] = (byState[s.state] || 0) + 1
console.log('Live coarse-state distribution:', JSON.stringify(byState))
console.log()

const shortCwd = (cwd: string) => cwd.replace(HOME, '~')
const age = (ms?: number) => (ms ? `${Math.round((now - ms) / 1000)}s` : '-')

for (const s of live.sort((a, b) => a.state.localeCompare(b.state) || (a.cwd < b.cwd ? -1 : 1))) {
  console.log(
    `[${s.state.padEnd(7)}] pid ${String(s.pid).padStart(6)}  reg:${(s.registryStatus ?? '-').padEnd(7)}  age:${age(s.transcriptMtimeMs).padStart(7)}  ${(s.name ?? '-').padEnd(30).slice(0, 30)}  ${shortCwd(s.cwd)}`,
  )
  console.log(`          ↳ ${s.stateReason}${s.transcriptPath ? '' : '  (no transcript)'}`)
}

if (spares.length) {
  console.log(`\nSpare background processes: ${spares.map((s) => s.pid).join(', ')}`)
}
if (dead.length) {
  console.log(
    `\nDead/stale registry entries (exited or PID reuse): ${dead
      .map((d) => `${d.pid}${d.name ? `(${d.name})` : ''}`)
      .join(', ')}`,
  )
}
