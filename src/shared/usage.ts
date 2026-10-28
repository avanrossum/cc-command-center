// Types shared by main and the window for the usage help panel (MIP2-1498 §4.5).

/** What the Arbiter gets for tips: windows and sessions' fields, no session text (§4.5 item 3). */
export interface TipFacts {
  windows: { kind: '5h' | '7d'; state: string; usedPercent: number | null; projectedPercent: number | null; resetsIn: string | null; movedPoints: number | null }[]
  sessions: { name: string; model: string | null; effort: string | null; contextPercent: number | null; cacheReadShare: number | null; runningSubagents: number; working: boolean; sharePercent: number }[]
}

export interface Tip {
  text: string
  evidence: string
}

export type TipsResult = { ok: true; tips: Tip[]; at: number } | { ok: false; reason: 'off' | 'capped' | 'error'; capUsd?: number; error?: string }
