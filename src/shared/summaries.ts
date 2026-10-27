// Per-card summaries of the last turn (MIP2-1422), shared by main and the window.

export interface TurnSummary {
  /** One line of plain text from the model. Untrusted: shown as text, never followed. */
  text: string
  /** The `at` of the turn it summarizes (the mod's clock at turn end), to match it to the card's turn. */
  turnAt: number
}
