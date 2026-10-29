// The PATH a session's tools run with (MIP2-1539). `ps` shows the environment
// the pre-started process began with; Claude Code then applies the
// dispatching shell's PATH, which Bash, hooks, MCP servers and the mod's own
// children all get (Research MIP2-1534, run B1). So a child of the mod
// measures it. Only presence flags and a count leave the session.
//
// The two engine calls it makes, typed here rather than from 'claude-code',
// so the app's tests read this file without the engine's declarations.

export interface PathEngine {
  env: { get(name: string): Promise<string | undefined> }
  process: { run(argv: readonly string[], init?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string }> }
}

export interface RuntimePath {
  localBin: boolean
  homebrew: boolean
  entries: number
}

/** Which of the app's folders the runtime PATH holds, and its length; undefined when it can't be read. */
export async function measurePath($: PathEngine): Promise<RuntimePath | undefined> {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const r = await $.process.run(['/bin/sh', '-c', 'printf %s "$PATH"'], { timeoutMs: 5000 })
    if (r.exitCode !== 0) return undefined
    const parts = r.stdout.split(':').filter(Boolean)
    return { localBin: home !== '' && parts.includes(`${home}/.local/bin`), homebrew: parts.includes('/opt/homebrew/bin'), entries: parts.length }
  } catch {
    return undefined
  }
}
