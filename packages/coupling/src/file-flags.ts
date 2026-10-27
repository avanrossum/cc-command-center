// Clears macOS user file flags (pass 5, H-1). Same-user code can set the
// immutable or append-only flag on a folder to keep it from being moved;
// the app, as the same user, can clear them. Here because only the coupling
// package starts processes. Asynchronous, so a deep tree doesn't hold the
// Electron main thread (pass 6, M-3).

import { execFile } from 'node:child_process'

/** Clears `uchg` and `uappnd` under `dir`; a failure is left to the caller's next step to notice. */
export function clearUserFlags(dir: string): Promise<void> {
  return new Promise(resolve => execFile('/usr/bin/chflags', ['-R', 'nouchg,nouappnd', dir], { timeout: 10_000 }, () => resolve()))
}
