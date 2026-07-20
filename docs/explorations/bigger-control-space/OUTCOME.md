# Outcome: the "bigger control space" — built & merged

**What this is:** the result of the discussion-first exploration in `BRIEF.md`. Built
2026-07-19/20 in a session running *inside* the app (Claude Code in CC Command Center),
on branch `feat/bigger-control-space`, merged to `main`. This note is the handoff for
the Desktop session that built the app — read it before touching the surfaces below.

The vibe crystallized (see memory `command-center-control-space-exploration`) into:
**glance not inbox** (the human decides urgency), **persistence** ("did I handle that?"
survives a restart), and **substance** (every "needs you" carries the actual why). All
shipped. Nothing here depends on the Arbiter or an API key.

---

## What shipped (by area)

### 1. The "why" — substance in every needs-you moment
The snapshot now carries a per-session **why** (`EnrichedSession.why / whyKind / whyCoarse`
in `src/main/index.ts`), rendered as a muted second line under gated rows in the tree
(`App.tsx` `whyOf()` + the `.why` element), and in the companion board:
- **permission** → the gated command, parsed conservatively from the PTY buffer
  (`engine/dialog.ts` `parseDialogCommand`). Ambiguous dialogs (a command + a
  description) return undefined → a coarse `wants approval` label with a `coarse` tag.
  **Verbatim command extraction is deliberately conservative pending real captured
  dialogs** — it never shows a guessed command.
- **question** → the actual question, from the last assistant message
  (`questionFromText`), only when it reads as a question.
- **blocked** → `blocked → <child>`, derived in the renderer from the edge graph.

### 2. Refined state taxonomy (the user's model)
Two "needs you" tiers by what they demand of the human:
- **permission** ("open a door" — approve so Claude continues) — amber, **latched**.
- **question** ("needs your brain" — an AskUserQuestion/elicitation, OR a turn that
  ended on a `?`) — blue / "your turn", **holds until you act** (rescued from aging to
  idle), and enters the beacon NEEDS YOU. A turn that ends WITHOUT a question still fades
  to idle ("done").
Key fixes in `snapshot()`: AskUserQuestion fires **no hook** — added a buffer signature
(`detectInteractivePrompt`, "Enter to select … to navigate"). A hook-reported gate is
latched only when the freshness block was skipped (so it doesn't defeat the 30s cap).
`AttentionKind` is now `'permission' | 'question'`.

### 3. Persistence — the gate ledger ("did I handle that?")
`registry.ts` migration **user_version = 9**: tables `gate` (fp = `session|kind|key`,
`first_seen/last_seen/seen_at/resolved_at`) and `event_log`, both **FK ON DELETE CASCADE
to node** (delete-on-removal — a removed session takes its history with it; the transcript
on disk is the real record, this is a convenience index). `syncGates()` runs each scan:
upsert open gates, **auto-seen** when the focused window's attached session matches,
**auto-resolve** when a gate is absent past a ~3.5s debounce, re-open a resolved fp fresh.
No manual "mark done" — it can't become an inbox. Bounded: resolved rows 7d + 300 cap;
event_log 60/session + 4000 global; prune ~once/min. The snapshot exposes per-session
`unhandled` → the tree pip + the companion card pip, which clears on focus and **survives
restart** (seen_at persists).

**fp identity rule (important):** the fp `key` is STABLE per kind, separate from the
display `payload` — permission uses a constant marker (its command text oscillates as the
TUI repaints), blocked uses the child's stable id (not its drifting name). Do not fold a
volatile display string into the fp.

### 4. Category identity
Migration **user_version = 10**: `category.emoji`. A category is now color + optional
emoji + a short word (`label`, relaxed from 2 forced-uppercase chars) + full name on hover
— in the rail AND as the tag on every cross-category card. The category editor has a
clickable emoji grid (display-only field; the grid is the picker) and doubles as the
**New category** editor (the ＋ button; `id===null` = create mode). `autoTag` now yields a
readable first word, not initials.

### 5. The companion pane (right of the terminal)
`.terminalarea` split into a width-clamped `.termstack` + a **hideable** `.companion`
(default open; open/hidden + scope persist via `stateSet`). Collapsed → a `.comp-spine`
with the needs-you count. Contents:
- **The Strip** — per-session duration swimlanes over a rolling ~6-min window. A
  renderer-side ring buffer (`stripHist`, change-points only, accumulated from the 1.5s
  snapshots, **lost on restart** by design). 1.5px dividers so adjacent same-brightness
  states read distinctly.
- **The why-board** — every needs-you session as a card (state dot + name + category tag +
  age + the why); unhandled cards carry a bright pip, seen ones don't (no dimming — that
  hurt readability). **Scope toggle: this category vs ALL** (each card category-tagged,
  never merged). Defaults to All.
The beacon's NEEDS YOU list hides while the pane is open (no duplicate); tallies stay.
No new backend — the board is the live needs-you set rendered with substance.

---

## The Arbiter seam (for whoever builds the control agent)
Everything is a read-only surface with a wired-but-empty hook for the Arbiter:
- `EnrichedSession.whyGloss` / `Session.whyGloss` — a plain-English gloss the Arbiter
  fills later; **always undefined today**, rendered only when present (italic, tagged).
- The `gate.payload` column IS the Arbiter's input contract (the verbatim substance).
Build the narrator gloss as an OPTIONAL layer on top of the always-on verbatim base, so
it degrades cleanly with no API key.

---

## Adversarial review
An independent multi-agent review (isolated, no session context) found **12 confirmed
bugs**; all fixed in commit `cb0aa88` before the pane work. Notably: the permission fp
oscillation, the latch defeating the 30s cap, and **auto-seen ignoring window focus** (a
gate arriving while you're in another app was silently marked seen → the pip never fired;
now gated on `BrowserWindow` focus). See the commit body for the full list.

## Testing
`registry.ts` and `engine/dialog.ts` are Electron-free (except better-sqlite3), so they're
unit-tested against an in-memory DB. **Run native-module tests under electron-as-node**
(system node ABI ≠ Electron's):
```
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx <test.ts>
```
18 gate-lifecycle + 11 dialog-parser assertions pass. typecheck + build clean on the merge.
Visual layout (the pane, the Strip) is best confirmed in the running app — this session
could not screenshot the native window.

## Not built (deferred)
- **Since-you-were-away briefing** — the restart recap (still-waiting / resolved-while-away
  / resume-threads) from `gate` + `event_log`. The data is already accumulating.
- **Ambient edge** — the out-of-app top-edge/dock signal; decided **optional, default off**.
- **Radar** (urgency-as-distance) — the user loves it but it's a *later* optional module;
  it can read the same gate ledger.
- **Narrator gloss** — the Arbiter's job (seam is in place, see above).

## Gotcha for anyone editing this code
The Read tool renders NUL bytes as spaces. An early gate fp used literal `\0` separators
(SQLite truncates TEXT at NUL → every gate on a session would collide); it's now a pipe.
If you hand-write separators, avoid `\0`.
