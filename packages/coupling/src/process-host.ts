// Which terminal app an interactive session runs in (MIP2-1466): its
// process's parents, walked with `ps`, until one is a known terminal. The
// app can't attach to an interactive session, so it says where it runs and
// that closing it there lets the app resume it. Here because only the
// coupling package starts processes.

import { execFile } from 'node:child_process'

/** Process names (`ps -o comm`, a path or a name) and the terminal each means. */
const TERMINALS: [RegExp, string][] = [
  [/iTerm/i, 'iTerm2'],
  [/\/Terminal\.app\/|^Terminal$/, 'Terminal'],
  [/ghostty/i, 'Ghostty'],
  [/wezterm/i, 'WezTerm'],
  [/(^|\/)kitty$/i, 'kitty'],
  [/alacritty/i, 'Alacritty'],
  [/(^|\/)Warp(\.app|$)|\/Warp\.app\//, 'Warp'],
  [/Visual Studio Code|\/Code Helper|(^|\/)Code$/, 'VS Code'],
  [/Cursor(\.app|\sHelper)/, 'Cursor'],
  [/(^|\/)tmux/, 'tmux'],
  [/(^|\/)screen$/, 'screen'],
]

/** The terminal a process name means, or null. */
export function terminalName(comm: string): string | null {
  return TERMINALS.find(([rx]) => rx.test(comm))?.[1] ?? null
}

/** One `ps` row: the parent pid and the process name. */
export type PsRow = { ppid: number; comm: string }

const readPs = (pid: number): Promise<PsRow | null> =>
  new Promise(resolve =>
    execFile('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { timeout: 3_000 }, (err, stdout) => {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(err ? '' : stdout)
      resolve(m ? { ppid: Number(m[1]), comm: m[2]! } : null)
    }),
  )

/**
 * The terminal app `pid` runs under, or null when none is found within 20
 * parents. A multiplexer (tmux, screen) is named when no terminal app is
 * above it, since its own parent is a server, not the window.
 */
export async function terminalHostOf(pid: number, ps: (pid: number) => Promise<PsRow | null> = readPs): Promise<string | null> {
  let found: string | null = null
  let current = pid
  for (let i = 0; i < 20 && current > 1; i++) {
    const row = await ps(current)
    if (!row) break
    const name = terminalName(row.comm)
    if (name && name !== 'tmux' && name !== 'screen') return name
    found ??= name
    current = row.ppid
  }
  return found
}
