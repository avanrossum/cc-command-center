// The oldest Claude Code version this app is tested against (MIP2-1406).
// Below it the app runs read-only with its control paths off (DECISION item
// 4: detect and degrade, never refuse to start). The floor moves up only
// when the contract needs something a newer version added, and each move is
// recorded in the app's DECISIONS.md.

export const CLAUDE_CODE_FLOOR = '2.1.311'

/** Compares dotted versions numerically: -1, 0 or 1. A suffix (`-dev…`) is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0]!.split('.').map(n => Number.parseInt(n, 10) || 0)
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export function belowFloor(version: string): boolean {
  return compareVersions(version, CLAUDE_CODE_FLOOR) < 0
}
