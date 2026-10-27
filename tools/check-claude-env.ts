// The live check for MIP2-1420: what reaches a background session's Bash
// when the app launches it.
//
//   CLAUDE_CONFIG_DIR=~/.claude-ccc-qa npm run check:claude-env -- <trusted folder>
//
// It plants canary values in the launching environment (a fake CLAUDE_PID,
// VITEST, a messaging token, NODE_OPTIONS and a CCC_ variable), launches a
// Haiku `--bg` session through the app's claudeEnv, has it run `env` (the
// only tool it may use), and reads the output from the transcript. It
// passes when no canary arrived. Variables Claude Code sets for its own
// session (CLAUDECODE, its own CLAUDE_CODE_SESSION_ID, ...) are listed but
// aren't leaks. The supervisor passes its own environment to sessions, so
// this runs only when no supervisor is running in that config: the launch
// below then starts it, with claudeEnv's environment.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeEnv, resolveClaudeBinary } from '../packages/coupling/src/claude-cli.ts'

const CANARY = 'leak-1420'
const PLANTED = {
  CLAUDE_PID: '4242420',
  VITEST: CANARY,
  CLAUDE_CODE_MESSAGING_TOKEN: CANARY,
  NODE_OPTIONS: `--title=${CANARY}`,
  CCC_CANARY: CANARY,
}

const folder = process.argv[2]
const config = process.env.CLAUDE_CONFIG_DIR
if (!folder?.startsWith('/') || !config) {
  console.error('usage: CLAUDE_CONFIG_DIR=<isolated config> npm run check:claude-env -- <trusted folder>')
  process.exit(64)
}
if (config.replace(/\/+$/, '') === join(homedir(), '.claude')) {
  console.error("refused: run it in an isolated config, not the user's own")
  process.exit(64)
}

const bin = resolveClaudeBinary()
const env = claudeEnv({ ...process.env, ...PLANTED })
const claude = (args: string[], cwd?: string) => execFileSync(bin, args, { env, cwd, encoding: 'utf8', timeout: 60_000 })

const status = (() => {
  try {
    return claude(['daemon', 'status'])
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? '')
  }
})()
if (/^pid:\s+\d+/m.test(status)) {
  console.error(`a supervisor is already running in ${config}; its environment, not this launch's, would reach the session. Run again once it idles out.\n${status}`)
  process.exit(2)
}

const out = claude(['--bg', '--name', 'ccc-1420-envcheck', '--model', 'haiku', '--allowedTools', 'Bash(env)', '--', 'Run the Bash command `env` exactly once, with no arguments. Then reply with the single word: done.'], folder)
const shortId = /backgrounded · ([0-9a-f]{8})/.exec(out)?.[1]
if (!shortId) {
  console.error(`no session id in: ${out}`)
  process.exit(1)
}
const listed = JSON.parse(claude(['agents', '--json', '--all'])) as { id: string; sessionId: string }[]
const sessionId = listed.find(e => e.id === shortId)?.sessionId
const transcript = sessionId ? join(config, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`) : ''

let envText: string | null = null
for (let i = 0; i < 90 && envText === null; i++) {
  execFileSync('sleep', ['2'])
  if (!transcript || !existsSync(transcript)) continue
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.includes('tool_result') || !line.includes('PATH=')) continue
    const blocks = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content
    for (const b of Array.isArray(blocks) ? blocks : []) {
      const c = (b as { type?: string; content?: unknown }).content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x as { text?: string }).text ?? '').join('') : ''
      if (b && (b as { type?: string }).type === 'tool_result' && text.includes('PATH=')) envText = text
    }
  }
}
try {
  claude(['stop', shortId])
  claude(['rm', shortId])
} catch {
  // Left for the supervisor's idle stop; say so below.
  console.error(`note: couldn't stop and remove ${shortId}; remove it by hand`)
}
if (envText === null) {
  console.error(`no env output in ${transcript || 'the transcript'} within 3 minutes`)
  process.exit(1)
}

const vars = new Map(envText.split('\n').flatMap(l => (/^[A-Za-z_][A-Za-z0-9_]*=/.test(l) ? [[l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const] : [])))
// Every planted value is unique to this run: any appearance is a leak.
const leaks = [...vars].filter(([k, v]) => v.includes(CANARY) || (k === 'CLAUDE_PID' && v === PLANTED.CLAUDE_PID))
console.log(`session ${shortId}: ${vars.size} variables in its Bash`)
console.log(`names: ${[...vars.keys()].sort().join(' ')}`)
if (leaks.length) {
  console.error(`FAIL: from the launching environment: ${leaks.map(([k]) => k).join(', ')}`)
  process.exit(1)
}
console.log(`PASS: none of ${Object.keys(PLANTED).join(', ')} reached the session from the launch`)
