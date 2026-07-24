# Awareness — reading the fleet's status

How to tell, at a glance, what every session is doing and which ones are waiting on you.

The core question the app answers is "which sessions need me right now, and where?" This guide covers the surfaces that answer it: the beacon bar, the needs-you companion board, the per-session "why" line, and the way the app keeps those readings honest and steady. It is about how to read status, not how the status engine works underneath.

## The six states

Every session shows one coarse state at a time, resolved most-urgent-wins each scan (about every 1.5 seconds):

| State | Meaning |
| --- | --- |
| **needs-approval** | A permission dialog is open and the session can't clear it itself. |
| **working** | The assistant is actively running. |
| **your-turn** | The turn ended and the session is waiting on you. Split into a direct question and a soft turn-end (see below). |
| **blocked** | A parent whose blocking child hasn't finished. It names the child it's waiting on. |
| **done** | An unattended session finished after you last looked at it. |
| **idle** | Live but not doing anything and not waiting on you. |

Each state has a color used consistently across the beacon bar, the session rows, the companion board, and the overview grid. Amber is a permission gate, green is working, pink is a blocked parent.

## The beacon bar

The beacon bar is the always-visible header at the top of the window. It has two parts:

- **Tallies** — a count of the fleet by state. At any moment you can read how many sessions are working, how many are waiting on you, how many finished, and so on, regardless of which category you are currently viewing.
- **Top waiting items** — a short list of the things that need you most. Each entry jumps to its session when you click it.

The bar is fleet-wide. It does not reset or narrow when you switch categories, so it is the one place that always reflects the whole picture.

## The needs-you companion board

The companion board (the "why-board") is a docked pane that renders the full needs-you set as cards. Use it when several things need you at once and you want a single triage surface instead of clicking through category rails.

- **Scope** — the board shows either the current category or the whole fleet. When it is fleet-wide, each card that belongs to another category is tagged with that category's color so you can tell client work from personal at a glance.
- **Ordering** — cards are sorted by urgency, most urgent first: permission gates, then working, then a direct question, then a soft your-turn, then blocked, then done. The things that most need a decision land at the top.
- **Context bar** — each card carries a context-usage bar, so a session about to run low on context window is visible on the same surface.

A session waiting in a category you are not currently looking at still shows up on the fleet-scoped board. You do not have to remember it or go hunting for it.

## The "why" line

Every needs-you row and card carries a "why" line: the actual substance of the ask, so you can triage without opening the session.

- For a **permission gate**, it is the verbatim command being gated — for example, the exact shell command the session wants to run.
- For a **question**, it is the actual sentence the assistant ended its turn on.
- For a **blocked parent**, it is the name of the unfinished child it is waiting on.

This is read directly from the session's own transcript and terminal, in the session's words. (It is distinct from the optional Arbiter, which can add a separate one-line plain-English gloss; the "why" line is present whether or not the Arbiter is enabled.)

## Soft "your turn" vs a direct question

Both are your-turn states, but they mean different things and the app separates them.

- A **soft your-turn** is a turn that ended on a statement — the assistant finished a thought and it is your move, but nothing is blocked. Something like "Let me know what you want next."
- A **direct question** is a turn that ended on a genuine question the assistant is waiting on an answer for. It cannot proceed until you reply.

A direct question gets a badge, an "Asked you" label, and a higher sort position than a soft your-turn. At a glance you can separate the sessions that actually asked you something from the ones that are merely idle-and-your-move.

Caveat: this distinction currently lives in the sidebar and the overview grid. A deeper, unified re-tiering that promotes a direct question to its own rung across the beacon tally and notifications is on the roadmap, so the beacon tally does not yet split the two.

## "Done — your move" and how it clears

A session is flagged **done** only when all three of these hold:

1. Its turn ended on a statement (it actually finished, rather than pausing to ask you something).
2. It finished after the last time you looked at it.
3. You are not currently looking at it.

The effect is that you get told when an unattended session finishes — the one you set running and walked away from — without a session you are actively watching nagging you about its own completions.

The signal clears when you look. Once you open the session (or it falls behind your last-viewed watermark), the done flag resolves. You do not dismiss it manually.

## How the app keeps status steady

Two behaviors keep the readings honest and stop the display from strobing.

**Permission-gate detection.** A permission dialog looks like "working" in the transcript, because the session is technically mid-turn while it waits. Reading the transcript alone would show busy-green when the session is actually frozen on an approval it can't clear itself. Instead the app scans the terminal's raw buffer for the dialog's on-screen signature, anchored on the footer lines that stay put even when the header scrolls off. A session stuck on a permission prompt reads amber, not green, and flips back the instant you answer.

**No flicker.** State readings can briefly disagree from scan to scan. To avoid a session strobing between two colors, the app holds a higher-urgency state for a few seconds of consecutive lower readings before it releases. A genuine transition — for example a newer status event arriving right after you approve a gate — still releases immediately. The display stays steady, and a real change still snaps through at once.

Together these mean the color you see is one you can act on: a session that needs you shows that it needs you, holds that reading steadily, and drops it the moment the situation actually changes.

## The "did I handle that?" memory

Needs-you moments are backed by a ledger so nothing you have not looked at silently disappears. A gate keeps a stable identity even as its dialog repaints, marks itself as seen when you are focused on that session, and resolves after you handle it. The ledger survives an app restart, so a needs-you moment you left unhandled is still there — dimmed and resumable — after you quit and relaunch, rather than vanishing with the window.

---

Status readings depend on parts of Claude Code that are not a public API (the transcript format, the status hook, terminal rendering). The app is in beta and macOS-on-Apple-Silicon only, and an upstream Claude Code release can change these signals, so a reading can occasionally lag or misread until the app catches up.
