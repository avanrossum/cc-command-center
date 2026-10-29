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

/**
 * Usage credits for the billing period, from Claude Code's `/usage`
 * (MIP2-1522, spec MIP2-1498 §9.1). Amounts in minor units of `currency`
 * (cents for USD). No reset date is reported.
 */
export interface CreditsSpend {
  enabled: boolean
  used: number
  /** Null: Claude Code reports no cap of its own, which isn't "unlimited". */
  limit: number | null
  currency: string
  /** When it was read, Unix ms. */
  at: number
}

export type SpendSource = 'real' | 'simulated' | 'credits'

export interface SpendState {
  source: SpendSource
  simulated: SimulatedSpend
  real: RealSpend
  /** Null when Claude Code didn't report usage credits. */
  credits: CreditsSpend | null
}

/** An amount in minor units: `$12.40` for USD, `12.40 EUR` otherwise. */
export function creditsMoney(minor: number, currency: string): string {
  const major = (minor / 100).toFixed(2)
  return currency === 'USD' ? `$${major}` : `${major} ${currency}`
}
