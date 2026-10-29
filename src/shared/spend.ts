// Spend, shared by main and the window (spec MIP2-1498 §5). No token counts.

export interface SimulatedSpend {
  /** This calendar month's sessions at Claude Code's list prices, US dollars. Not money spent. */
  totalUsd: number
  todayUsd: number
  topSessions: { sessionId: string; usd: number }[]
  byModel: { model: string; usd: number }[]
  /** Sessions this month that reported no cost, so aren't counted. */
  noCost: number
  /** Which ones, for the panel's list (MIP2-1521). */
  noCostIds?: string[]
  /** When the app began counting, Unix ms: the figures go back only to then (MIP2-1521). */
  since?: number
}

export interface RealSpend {
  /** A Console key (Admin, personal or service account) is saved. */
  configured: boolean
  /** This calendar month's Console cost, US dollars; null before the first good poll. */
  totalUsd: number | null
  todayUsd: number | null
  byModel: { model: string; usd: number }[]
  /** When the amounts were read, Unix ms. */
  at: number | null
  /** The last poll's error, the API's own message; cleared by a good poll. */
  error: string | null
  errorAt: number | null
}

export interface SpendState {
  source: 'real' | 'simulated'
  simulated: SimulatedSpend
  real: RealSpend
}
