// The PATH every claude the app runs gets, and the supervisor check (MIP2-1457).

import { describe, expect, it } from 'vitest'
import { claudeEnv, cleanPath, resolveLoginPath, setLoginPath } from '../src/claude-cli.ts'
import { checkSupervisorPath, daemonPid, pathFromPs, processPathOk, processStartedAt, sharedSupervisorStart, supervisorState } from '../src/supervisor-env.ts'
import { ClaudeCommandError as CommandError } from '../src/claude-cli.ts'

const env = { HOME: '/Users/x', USER: 'x', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

describe('resolveLoginPath', () => {
  it("takes the login shell's PATH after the marker, ignoring what the profile prints, and runs it with only HOME, USER and SHELL", async () => {
    const seen: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
    const r = await resolveLoginPath({ ...env, SECRET: 'no' }, async (file, args, opts) => {
      seen.push({ file, args, env: opts.env })
      return 'Welcome!\n__CCC_PATH__/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin:/bin'
    })
    expect(r).toEqual({ path: '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin:/bin', from: 'login-shell' })
    // A login shell that doesn't read .zshrc misses ~/.local/bin, where claude is: it's added at the end, so a
    // user-writable folder never shadows a system one (pass 8, L-2).
    const noLocal = await resolveLoginPath(env, async () => '__CCC_PATH__/opt/homebrew/bin:/usr/bin', p => p === '/Users/x/.local/bin')
    expect(noLocal.path).toBe('/opt/homebrew/bin:/usr/bin:/Users/x/.local/bin')
    expect(seen[0]).toMatchObject({ file: '/bin/zsh', args: ['-l', '-c', expect.stringContaining('__CCC_PATH__')] })
    expect(seen[0]!.env).toEqual({ HOME: '/Users/x', USER: 'x', SHELL: '/bin/zsh' })
  })

  it('falls back to path_helper with /opt/homebrew/bin in front and ~/.local/bin at the end, where they exist', async () => {
    const r = await resolveLoginPath(
      env,
      async file => {
        if (file === '/bin/zsh') throw new Error('timed out')
        return 'PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"; export PATH;'
      },
      p => p === '/Users/x/.local/bin' || p === '/opt/homebrew/bin',
    )
    expect(r).toEqual({ path: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/x/.local/bin', from: 'path_helper' })
  })

  it("falls back when the shell prints no usable PATH, and keeps launchd's when path_helper fails too", async () => {
    const r = await resolveLoginPath(env, async () => { throw new Error('no') }, () => false)
    expect(r).toEqual({ path: '/usr/bin:/bin:/usr/sbin:/sbin', from: 'path_helper' })
    const junk = await resolveLoginPath(env, async file => (file === '/bin/zsh' ? '__CCC_PATH__relative:also' : 'PATH="/usr/bin"; export PATH;'), () => false)
    expect(junk).toEqual({ path: '/usr/bin', from: 'path_helper' })
  })

  it('keeps absolute folders only, once each', () => {
    expect(cleanPath(' /a:rel:/b:/a: ')).toBe('/a:/b')
    expect(cleanPath('')).toBeNull()
  })
})

describe('claudeEnv PATH', () => {
  it("gives every claude the login PATH, not the app's own, once resolved", () => {
    setLoginPath('/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin')
    try {
      expect(claudeEnv(env).PATH).toBe('/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin')
    } finally {
      setLoginPath(null)
    }
    expect(claudeEnv(env).PATH).toBe(env.PATH)
  })
})

describe('checkSupervisorPath', () => {
  it("reads the supervisor's pid and PATH, and says whether claude's folder is on it", async () => {
    expect(daemonPid('pid:     79806\nversion: 2.1.311\n')).toBe(79806)
    expect(daemonPid('not running\n')).toBeNull()
    expect(pathFromPs('claude daemon run --spawned-by {} HOME=/Users/x PATH=/usr/bin:/bin:/usr/sbin:/sbin CLAUDE_CODE_PLUGIN_DIR_WATCH=0')).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
    const run = Object.assign(async () => 'pid:     79806\n', {})
    const bad = await checkSupervisorPath(run, '/Users/x/.local/bin/claude', async () => 'claude daemon run PATH=/usr/bin:/bin')
    expect(bad).toEqual({ pid: 79806, path: '/usr/bin:/bin', claudeDir: '/Users/x/.local/bin', ok: false })
    const good = await checkSupervisorPath(run, '/Users/x/.local/bin/claude', async () => 'claude daemon run PATH=/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin')
    expect(good?.ok).toBe(true)
    expect(await checkSupervisorPath(Object.assign(async () => 'not running\n', {}), '/x/claude')).toBeNull()
    // `daemon status` exits non-zero when nothing runs: that's no supervisor, not an error (MIP2-1463 live run).
    const { ClaudeCommandError } = await import('../src/claude-cli.ts')
    const exits = Object.assign(async () => {
      throw new ClaudeCommandError('claude daemon: not running', 1, 'not running\n', '')
    }, {})
    expect(await checkSupervisorPath(exits, '/x/claude')).toBeNull()
    // The environment's PATH is the last one, after the command line's; one with no absolute folder is unknown (pass 8, L-5).
    expect(pathFromPs('claude daemon run --x PATH=/evil PATH=/usr/bin:/opt/homebrew/bin')).toBe('/usr/bin:/opt/homebrew/bin')
    expect(pathFromPs('claude daemon run PATH=relative:also')).toBeNull()
    expect(await checkSupervisorPath(run, '/Users/x/.local/bin/claude', async () => 'claude daemon run')).toBeNull()
  })
})

describe('the supervisor start the host and the watchdog share (pass 9, L-5)', () => {
  it('starts at most once per gap, and answers with that start', () => {
    let t = 0
    let pid = 100
    const spawned: number[] = []
    const start = sharedSupervisorStart(() => (spawned.push(++pid), pid), 10_000, () => t)
    expect(start()).toBe(101)
    t = 9_999
    expect(start()).toBe(101)
    t = 10_000
    expect(start()).toBe(102)
    expect(spawned).toEqual([101, 102])
  })
  it('reads up, down only when Claude Code says so, and unknown otherwise', async () => {
    expect(await supervisorState(async () => 'pid:     4242\n')).toBe('up')
    expect(await supervisorState(async () => { throw new CommandError('claude daemon status', 1, 'Supervisor not running\n', '') })).toBe('down')
    expect(await supervisorState(async () => { throw new Error('timed out') })).toBe('unknown')
    expect(await supervisorState(async () => { throw new CommandError('claude daemon status', 2, 'something else', '') })).toBe('unknown')
    expect(await supervisorState(async () => '')).toBe('unknown')
  })
})

describe('waiting for the login PATH (MIP2-1489)', () => {
  it('starts a supervisor only once the login PATH is known, and with it', async () => {
    const { awaitLoginPath, createClaudeSpawner, createClaudeExitCode } = await import('../src/claude-cli.ts')
    const { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ccc-path-race-'))
    const seen = join(dir, 'path.txt')
    const fake = join(dir, 'claude')
    writeFileSync(fake, `#!/bin/sh\nprintf '%s' "$PATH" > '${seen}'\n`)
    chmodSync(fake, 0o755)
    let resolve!: () => void
    awaitLoginPath(new Promise<void>(r => (resolve = r)))
    try {
      // Before the PATH is known: nothing starts, and no pid is claimed.
      expect(createClaudeSpawner(fake)(['daemon', 'run'])).toBeUndefined()
      const exit = createClaudeExitCode(fake)(['daemon', 'status'])
      await new Promise(r => setTimeout(r, 150))
      expect(existsSync(seen)).toBe(false)
      // Known: the deferred start runs with the login PATH, and the status check goes too.
      setLoginPath('/opt/login/bin:/usr/bin:/bin')
      resolve()
      expect(await exit).toBe(0)
      for (let i = 0; i < 50 && !readFileSync(seen, { flag: 'a+' }).toString().includes('/opt/login/bin'); i++) await new Promise(r => setTimeout(r, 20))
      expect(readFileSync(seen, 'utf8').startsWith('/opt/login/bin:/usr/bin:/bin')).toBe(true)
      // Once settled, a start goes at once and has its pid.
      expect(createClaudeSpawner(fake)(['daemon', 'run'])).toEqual(expect.any(Number))
    } finally {
      awaitLoginPath(Promise.resolve())
      setLoginPath(null)
      await new Promise(r => setTimeout(r, 50))
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('processStartedAt (MIP2-1488)', () => {
  it("reads ps's lstart in the C locale, and nothing else", async () => {
    expect(await processStartedAt(1, async () => 'Thu Oct  8 02:53:01 2026\n')).toBe(new Date(2026, 9, 8, 2, 53, 1).getTime())
    expect(await processStartedAt(1, async () => '')).toBeNull()
    expect(await processStartedAt(1, async () => 'mer 28 oct 02:53:01 2026')).toBeNull()
    expect(await processStartedAt(1, async () => Promise.reject(new Error('no such process')))).toBeNull()
  })
})

describe('processPathOk (MIP2-1518)', () => {
  it("reads a session process's own PATH, the last PATH=, and says unknown when it can't", async () => {
    const ps = (text: string) => async () => text
    expect(await processPathOk(1, '/Users/x/.local/bin', ps('claude --bg PATH=/usr/bin:/Users/x/.local/bin HOME=/Users/x'))).toBe(true)
    expect(await processPathOk(1, '/Users/x/.local/bin', ps('claude --bg PATH=/usr/bin:/bin'))).toBe(false)
    expect(await processPathOk(1, '/Users/x/.local/bin', ps(''))).toBeNull()
  })
})
