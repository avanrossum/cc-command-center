// Runs the `claude` binary. This file and the session hosts are the only code
// in the app that starts a `claude` process (D-004).

import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Runs `claude` with arguments and resolves to stdout. Swapped out in tests. */
/** `session`: the command starts or restarts a session, so it carries SESSION_SWITCHES (MIP2-1463). */
export type RunOptions = { timeoutMs?: number; cwd?: string; session?: boolean }

export type ClaudeRunner = ((args: string[], opts?: RunOptions) => Promise<string>) & {
  /**
   * The same command with both streams. Claude Code prints a resume's
   * `note:` line on stderr, so the copy check and the command log read it
   * here (MIP2-1453). Absent on a runner that has only stdout.
   */
  full?: (args: string[], opts?: RunOptions) => Promise<{ stdout: string; stderr: string }>
}

/** A `claude` command that failed: its exit code and both streams, for callers that read refusals. */
export class ClaudeCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'ClaudeCommandError'
  }
}

/** Runs `claude` and resolves to its exit code, for commands whose answer is the code. */
export type ClaudeExitCode = (args: string[], opts?: { timeoutMs?: number }) => Promise<number>

/** Starts `claude` detached from the app, so it outlives the app. Resolves to its pid. */
export type ClaudeSpawner = (args: string[]) => number | undefined

/**
 * Variables a `claude` the app starts may get, by name, each with its
 * reason. Each passes only when set (MIP2-1420; approved 2026-10-27,
 * including SSH_AUTH_SOCK and the network variables).
 */
const ALLOWED = new Map<string, string>([
  ['HOME', "Where Claude Code finds ~/.claude and the user's files"],
  ['PATH', 'Finding git, node and the tools sessions run'],
  ['USER', 'The account name tools read'],
  ['LOGNAME', 'The account name some tools read instead of USER'],
  ['SHELL', "The shell Claude Code's Bash tool runs"],
  ['LANG', 'Text encoding for tool output'],
  ['TERM', 'The terminal type for attach views and tool output'],
  ['TMPDIR', "macOS's per-user temporary folder"],
  ['TZ', 'Local time in tool output'],
  ['EDITOR', "The user's editor for tools that open one"],
  ['VISUAL', "The user's editor for tools that open one"],
  ['SSH_AUTH_SOCK', "git over SSH in a background session needs the user's agent"],
  ['HTTP_PROXY', "The user's network setup"],
  ['HTTPS_PROXY', "The user's network setup"],
  ['NO_PROXY', "The user's network setup"],
  ['http_proxy', "The user's network setup"],
  ['https_proxy', "The user's network setup"],
  ['no_proxy', "The user's network setup"],
  ['SSL_CERT_FILE', "The user's certificate setup, for a network that inspects TLS"],
  ['SSL_CERT_DIR', "The user's certificate setup, for a network that inspects TLS"],
  ['NODE_EXTRA_CA_CERTS', "The user's certificate setup, for a network that inspects TLS"],
  ['CLAUDE_CONFIG_DIR', "Which Claude Code config: the user's, or QA's isolated one"],
])
/** Variables matched by prefix: the locale (LC_ALL, LC_CTYPE, ...), for text encoding and formats. */
const ALLOWED_PREFIXES = ['LC_']

/**
 * The environment every `claude` the app runs gets: `--bg`, `--resume`,
 * `attach`, `stop`, `respawn`, `agents --json`, and the watchdog's
 * `daemon run` (MIP2-1420). It's built from an allowlist, not copied from
 * the app's own environment. A supervisor passes its environment to every
 * background session's Bash, so whatever the app was started with would
 * reach them all (Research MIP2-1419). Seen live: a supervisor QA's session
 * started passed QA's VITEST*, CLAUDE_PID and messaging socket and token.
 * Nothing else gets through: CLAUDE_CODE_CHILD_SESSION,
 * CLAUDE_CODE_SESSION_ID, CLAUDE_PID, messaging variables, NODE_OPTIONS,
 * VITEST*, CCC_* and the rest are left out. The app no longer sets
 * CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: it affects only nested interactive
 * sessions (MIP2-1419 corrects MIP2-1377 §5).
 */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (ALLOWED.has(k) || ALLOWED_PREFIXES.some(p => k.startsWith(p)))) out[k] = v
  }
  // Alex's login PATH, not the app's: an app opened from the Finder gets launchd's
  // /usr/bin:/bin:/usr/sbin:/sbin, and a supervisor the app starts would pass it to every session (MIP2-1457).
  if (loginPath) out.PATH = loginPath
  // CLAUDE_CODE_PLUGIN_DIR_WATCH=0 is no longer set here: on a supervisor the app started, it reached every
  // background session, terminal-started ones too. Each launch's --settings `env` carries it instead
  // (hub.ts settingsFor; Research observed it per session, MIP2-1457).
  return out
}

/**
 * Variables for a command that starts or restarts a session: `--bg`,
 * `--resume`, `respawn` and the trust run, never `daemon run` (MIP2-1463).
 * A session takes its environment from the command that
 * started it (seen live, MIP2-1457), so this reaches the session and not
 * the supervisor, as long as the supervisor is already running. It backs up
 * the same switch in the session's --settings `env`.
 *
 * CLAUDE_CODE_PLUGIN_DIR_WATCH=0: the session doesn't reload the reporter
 * mod when its folder changes, so a Bash write there can't run inside a
 * live session; the app's hash check catches it at the next start (gate
 * M-2, Research MIP2-1430).
 */
export const SESSION_SWITCHES: Readonly<Record<string, string>> = { CLAUDE_CODE_PLUGIN_DIR_WATCH: '0' }

/** claudeEnv plus SESSION_SWITCHES, for a session command. */
export function sessionEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...claudeEnv(env), ...SESSION_SWITCHES }
}

/** The login shell's PATH, once resolved at start; null until then, when the app's own is used. */
let loginPath: string | null = null
/** Resolves once the login PATH is known; every claude the runner starts waits for it (pass 8, L-2). */
let pathReady: Promise<void> = Promise.resolve()

/** Whether pathReady has settled, so a spawn can go at once (MIP2-1489). */
let pathSettled = true

/**
 * Makes every claude the app starts wait for the login PATH, resolved in the
 * background: the runner, the exit-code check and the spawner (pass 8, L-2;
 * MIP2-1489).
 */
export function awaitLoginPath(ready: Promise<void>): void {
  pathSettled = false
  const mine: Promise<void> = ready
    .catch(() => {})
    .then(() => {
      if (pathReady === mine) pathSettled = true
    })
  pathReady = mine
}

/** Sets the PATH every `claude` the app runs gets (MIP2-1457). */
export function setLoginPath(path: string | null): void {
  loginPath = path
}

/** A PATH made of absolute folders only, or null. */
export function cleanPath(text: string): string | null {
  const dirs = text.trim().split(':').filter(d => d.startsWith('/') && !d.includes('\0'))
  return dirs.length ? [...new Set(dirs)].join(':') : null
}

const MARK = '__CCC_PATH__'

/**
 * Alex's login PATH (MIP2-1457): `$SHELL -l -c` printing PATH after a
 * marker, so anything the profile prints is ignored. It runs with only
 * HOME, USER and SHELL, a 5 s timeout and no terminal. If that fails, it's
 * built from `/usr/libexec/path_helper` with `/opt/homebrew/bin` in front.
 * Either way `~/.local/bin`, where the native installer puts `claude`, is
 * added at the end when it exists and is missing: a login shell that isn't
 * interactive doesn't read `.zshrc`, which is where it's usually added
 * (seen live on Alex's machine). At the end, so a user-writable folder
 * never shadows a system one (pass 8, L-2).
 */
export async function resolveLoginPath(
  env: NodeJS.ProcessEnv = process.env,
  exec: (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<string> = execText,
  exists: (path: string) => boolean = existsSync,
): Promise<{ path: string; from: 'login-shell' | 'path_helper' }> {
  const shell = env.SHELL && env.SHELL.startsWith('/') ? env.SHELL : '/bin/zsh'
  const base = { HOME: env.HOME ?? homedir(), USER: env.USER ?? '', SHELL: shell }
  try {
    const out = await exec(shell, ['-l', '-c', `printf '${MARK}%s' "$PATH"`], { env: base, timeout: 5_000 })
    const i = out.lastIndexOf(MARK)
    const path = i >= 0 ? cleanPath(out.slice(i + MARK.length)) : null
    if (path) return { path: withClaudeDir(path, base.HOME, exists), from: 'login-shell' }
  } catch {
    // Fall through to path_helper.
  }
  let helper = '/usr/bin:/bin:/usr/sbin:/sbin'
  try {
    const out = await exec('/usr/libexec/path_helper', ['-s'], { env: base, timeout: 5_000 })
    helper = cleanPath(/PATH="([^"]*)"/.exec(out)?.[1] ?? '') ?? helper
  } catch {
    // launchd's default stands.
  }
  const front = ['/opt/homebrew/bin'].filter(exists)
  return { path: withClaudeDir(cleanPath([...front, helper].join(':'))!, base.HOME, exists), from: 'path_helper' }
}

/** `~/.local/bin` at the end of `path` when it exists and isn't already on it. */
function withClaudeDir(path: string, home: string, exists: (p: string) => boolean): string {
  const local = join(home, '.local', 'bin')
  return exists(local) && !path.split(':').includes(local) ? `${path}:${local}` : path
}

function execText(file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number }): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { ...opts, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  )
}

/**
 * Finds the `claude` binary. An app opened from the Finder doesn't get the
 * login shell's PATH, so the native installer's location is checked before
 * PATH. `CCC_CLAUDE_BIN` overrides both.
 */
export function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.CCC_CLAUDE_BIN,
    join(homedir(), '.local', 'bin', 'claude'),
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'claude')),
  ]
  for (const path of candidates) {
    if (path && isExecutable(path)) return path
  }
  throw new Error('claude binary not found: set CCC_CLAUDE_BIN or install Claude Code')
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function createClaudeRunner(binary = resolveClaudeBinary()): ClaudeRunner {
  const full: NonNullable<ClaudeRunner['full']> = async (args, opts = {}) => {
    await pathReady
    return new Promise((resolve, reject) => {
      execFile(
        binary,
        args,
        { timeout: opts.timeoutMs ?? 10_000, maxBuffer: 16 * 1024 * 1024, env: opts.session ? sessionEnv() : claudeEnv(), cwd: opts.cwd },
        (error, stdout, stderr) => {
          if (error) {
            const detail = (stderr.trim() || stdout.trim()).split('\n')[0] || error.message
            const code = typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : null
            reject(new ClaudeCommandError(`claude ${args[0] ?? ''}: ${detail}`, code, stdout, stderr))
          } else {
            resolve({ stdout, stderr })
          }
        },
      )
    })
  }
  const run: ClaudeRunner = (args, opts) => full(args, opts).then(r => r.stdout)
  run.full = full
  return run
}

export function createClaudeExitCode(binary = resolveClaudeBinary()): ClaudeExitCode {
  return async (args, opts = {}) => {
    // The watchdog's status check waits for the login PATH like every other claude (MIP2-1489).
    await pathReady
    return new Promise(resolve => {
      execFile(binary, args, { timeout: opts.timeoutMs ?? 10_000, env: claudeEnv() }, error => {
        if (!error) return resolve(0)
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code
        // A timeout or a missing binary isn't an answer; report it as -1.
        resolve(typeof code === 'number' ? code : -1)
      })
    })
  }
}

export function createClaudeSpawner(binary = resolveClaudeBinary()): ClaudeSpawner {
  const start = (args: string[]): number | undefined => {
    // Its own process group and no stdio tie to the app: quitting the app
    // must not take Claude Code's supervisor, and every session, with it.
    const child = spawn(binary, args, { detached: true, stdio: 'ignore', env: claudeEnv() })
    child.on('error', () => {})
    child.unref()
    return child.pid
  }
  return args => {
    // A supervisor started before the login PATH is known would keep launchd's bare one, and a
    // Claude Code upgrade carries it forward (MIP2-1486, MIP2-1489). Until then the start waits,
    // and its pid isn't known yet.
    if (pathSettled) return start(args)
    void pathReady.then(() => start(args))
    return undefined
  }
}
