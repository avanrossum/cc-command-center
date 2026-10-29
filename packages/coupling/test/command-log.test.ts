// The log of the app's own claude lifecycle commands (MIP2-1446).

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeCommandError } from '../src/claude-cli.ts'
import { CommandLog, COMMAND_LOG_STREAM_BYTES, redactArgs } from '../src/command-log.ts'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-log-'))
  path = join(dir, 'claude-commands.log')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const entries = () => readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, any>)
const SECRET = 'a'.repeat(64)

describe('CommandLog', () => {
  it("keeps a resume's whole output, the note: line included (MIP2-1446)", async () => {
    const log = new CommandLog(path)
    const out = 'background session c0ffee01 keeps its own saved options\nnote: the process was still running, so this started a copy as c0ffee0a\n'
    const run = log.wrap(async () => out)
    expect(await run(['--resume', 'c0ffee01-0000-4000-8000-000000000001', '--bg'], { cwd: '/w' })).toBe(out)
    await log.flushed()
    const [e] = entries()
    expect(e).toMatchObject({ args: ['--resume', 'c0ffee01-0000-4000-8000-000000000001', '--bg'], cwd: '/w', code: 0, stdout: out })
  })

  it('logs a failure with its exit code and both streams, and rethrows it', async () => {
    const log = new CommandLog(path)
    const run = log.wrap(async () => {
      throw new ClaudeCommandError('claude --bg: refused', 1, 'partial', 'Workspace not trusted.')
    })
    await expect(run(['--bg', '--', 'go'])).rejects.toThrow('refused')
    await log.flushed()
    expect(entries()[0]).toMatchObject({ code: 1, stdout: 'partial', stderr: 'Workspace not trusted.' })
  })

  it('never writes a prompt or anything shaped like a channel secret', async () => {
    const log = new CommandLog(path)
    const prompt = 'Reply with the single word FIRST and nothing else'
    const run = log.wrap(async () => `backgrounded · c0ffee01\necho: ${prompt}\nsecret ${SECRET}\n`)
    await run(['--bg', '--settings', '/ch/ab12cd34/settings.json', '--', prompt])
    await log.flushed()
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain(prompt)
    expect(text).not.toContain(SECRET)
    expect(entries()[0]!.args).toEqual(['--bg', '--settings', '/ch/ab12cd34/settings.json', '--', `<prompt, ${prompt.length} characters>`])
    expect(entries()[0]!.stdout).toContain('<prompt>')
  })

  it("doesn't log the polls, and caps each stream", async () => {
    const log = new CommandLog(path)
    await log.wrap(async () => '[]')(['agents', '--json', '--all'])
    await log.wrap(async () => '2.1.311')(['--version'])
    await log.wrap(async () => 'x'.repeat(COMMAND_LOG_STREAM_BYTES * 2))(['stop', 'c0ffee01'])
    await log.flushed()
    const logged = entries().filter(e => e.args)
    expect(logged.map(e => e.args[0])).toEqual(['stop'])
    expect(logged[0]!.stdout.length).toBeLessThan(COMMAND_LOG_STREAM_BYTES + 40)
    expect(logged[0]!.stdout).toContain(`(${COMMAND_LOG_STREAM_BYTES * 2} bytes in all)`)
  })

  it('logs a spawn with its pid, and a note', async () => {
    const log = new CommandLog(path)
    expect(log.wrapSpawner(() => 4242)(['daemon', 'run'])).toBe(4242)
    await log.note('unknown-state', { sessionId: 's', pid: 1, state: 'done' })
    expect(entries()).toEqual([expect.objectContaining({ args: ['daemon', 'run'], pid: 4242 }), expect.objectContaining({ note: 'unknown-state', sessionId: 's', state: 'done' })])
  })

  it('starts a new file past its size, keeping the previous one', async () => {
    const log = new CommandLog(path, Date.now, 200)
    const run = log.wrap(async () => 'y'.repeat(150))
    await run(['stop', 'a'])
    await run(['stop', 'b'])
    await log.flushed()
    expect(existsSync(`${path}.1`)).toBe(true)
  })

  it('cuts a prompt only after --', () => {
    expect(redactArgs(['stop', 'x'])).toEqual({ args: ['stop', 'x'], prompt: null })
  })

  it('keeps the log at 0600: new, across a rollover, and when it was found open', async () => {
    const log = new CommandLog(path, Date.now, 200)
    const run = log.wrap(async () => 'y'.repeat(150))
    await run(['stop', 'a'])
    await log.flushed()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await run(['stop', 'b'])
    await run(['stop', 'c'])
    await log.flushed()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600)
    chmodSync(path, 0o644)
    await run(['stop', 'd'])
    await log.flushed()
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("logs the trust run's command line and exit code, and none of its output", async () => {
    const log = new CommandLog(path)
    let exit: (e: { exitCode: number }) => void = () => {}
    const fakeProcess = { write: () => {}, resize: () => {}, kill: () => {}, onData: () => {}, onExit: (cb: typeof exit) => void (exit = cb) }
    const spawn = log.wrapTrust(() => fakeProcess)
    const p = spawn({ file: '/bin/claude', args: ['--bg', '--settings', '/s.json', '--', 'a private prompt'], cwd: '/w' }, 80, 24)
    p.onData(() => {})
    exit({ exitCode: 0 })
    await log.flushed()
    const [e] = entries()
    expect(e).toMatchObject({ args: ['--bg', '--settings', '/s.json', '--', '<prompt, 16 characters>'], cwd: '/w', code: 0, terminal: true })
    expect(e).not.toHaveProperty('stdout')
    expect(readFileSync(path, 'utf8')).not.toContain('a private prompt')
  })

  it('keeps stderr on success, where a resume prints its note, with the same redaction (MIP2-1453)', async () => {
    const log = new CommandLog(path)
    const prompt = 'a private prompt'
    const inner = Object.assign(async () => 'backgrounded · c0ffee01\n', {
      full: async () => ({ stdout: 'backgrounded · c0ffee01\n', stderr: `note: woke session c0ffee01 with its saved options.\n${prompt} ${SECRET}\n` }),
    })
    const run = log.wrap(inner)
    expect(await run(['--resume', 'c0ffee01-0000-4000-8000-000000000001', '--bg', '--', prompt])).toBe('backgrounded · c0ffee01\n')
    expect(await run.full!(['--resume', 'x', '--bg'])).toMatchObject({ stderr: expect.stringContaining('note: woke session') })
    await log.flushed()
    const [e] = entries()
    expect(e!.stderr).toContain('note: woke session c0ffee01')
    expect(e!.stderr).not.toContain(prompt)
    expect(e!.stderr).not.toContain(SECRET)
  })

  it('scrubs and caps the strings in a note (pass 8, L-1)', async () => {
    const log = new CommandLog(path)
    await log.note('unknown-state', { sessionId: 's', waitingFor: `approve ${SECRET} ${'x'.repeat(900)}`, pid: 1 })
    const [e] = entries()
    expect(e!.waitingFor).not.toContain(SECRET)
    expect(e!.waitingFor.length).toBeLessThanOrEqual(500)
    expect(e!.pid).toBe(1)
  })
})

describe('trustOutcome (MIP2-1558)', () => {
  it('reads whether the trust question showed, the backgrounded id and note lines, from a screen drawn with cursor moves', async () => {
    const { trustOutcome } = await import('../src/command-log.ts')
    const screen = '\x1b[2J❯\x1b[1CNo,\x1b[1Cexit\r\nYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder\r\n\x1b[>4m78backgrounded · 663f28a2 · Docs sync\r\nnote: session x is already running\r\n'
    expect(trustOutcome(screen.replace(/\x1b\[1C/g, ''))).toEqual({ asked: true, backgrounded: '663f28a2', notes: ['note: session x is already running'] })
    expect(trustOutcome('Workspace not trusted.')).toEqual({ asked: false, backgrounded: null, notes: [] })
  })
})
