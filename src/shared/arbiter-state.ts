// What the Arbiter shows (MIP2-1411), shared by main and the window.

/** The Arbiter's model (MIP2-1411), named in the settings window. */
export const ARBITER_MODEL = 'claude-haiku-5-5'

export interface ArbiterState {
  status: 'off' | 'waiting' | 'ranked' | 'capped' | 'error'
  /**
   * Session ids in the Arbiter's order. The model's per-card reasons stay
   * out: its text never reaches the window (QA on MIP2-1411).
   */
  order: { sessionId: string }[]
  /**
   * The session to answer first, with the names it unblocks. The names come
   * from the app's own evidence (peer messages without a reply, contractor
   * parents), never from the model's text. Null without evidence.
   */
  start: { sessionId: string; name: string; unblocks: string[] } | null
  spentTodayUsd: number
  capUsd: number
  at: number
  error: string | null
}

/** One line of the Arbiter log (D-014). */
export interface ArbiterLogEntry {
  at: number
  kind: string
  usd?: number
  start?: string | null
  error?: string
  sessions?: number
}
