# Exploration: the "bigger control space"

**Type:** discussion-first design exploration. Do NOT start building. The goal of the
first session is to understand what the user is reaching for and sketch options, not
to ship code.

**Owner:** Alexander (alex@mipyip.com). Solo builder of CC Command Center.

---

## The ask, in the user's words

> There's something I feel like I'm missing, and that's the "bigger control space" —
> I don't mean a new page (though that *might* be it) so much as *better visibility*
> into what everyone is *doing* and *why* they are waiting on me.
>
> Frankly, I don't know what I want, because I've never seen it before, and it's kind
> of a vibe that I'm trying to fill.

So: this is a vibe to fill, not a spec to implement. The user is the domain expert on
the feeling ("I'm running N agents and I can't tell, at a glance, what's happening and
what actually needs me"). Your job is to draw it out, reflect it back, and mock options
until the vibe crystallizes — then, and only then, scope a build.

The one concrete thing the user already knows they want (already shipped as of v0.9.23):
a **side-rail indicator per category showing that a session in it needs input** — now
colored by *why* (approval / blocked / your-turn). Treat that as the smallest seed of
the bigger idea, not the whole thing.

---

## What this product is (so you don't re-derive it)

**CC Command Center** — a macOS Electron app for running and orchestrating *many*
concurrent Claude Code CLI sessions from one window. The user coined the framing:
**HITM — Human In The Middle** multi-agent orchestration. The human is the central node
of a mesh of sessions, with three powers over every link: **read** (see what's said),
**drop** (kill / untrust), **inject** (send / spawn). See `docs/concepts.md`.

Core existing surfaces (the "four-region cockpit"):
- **Beacon bar** (top): a global status board — tallies (working / your-turn / blocked /
  idle / total) + a "NEEDS YOU" ledger of the top few sessions that require the human,
  most-urgent first. High-signal by design — see the "don't over-flag" principle below.
- **Category rail** (far left): hard-separated categories (personal / business / clients).
  Clicking one filters the list and reopens the last session you had there. Each cell now
  shows a colored "needs you" dot (the seed above).
- **Session list / tree** (left): sessions grouped by category, as an indented tree via
  typed parent→child edges (blocking vs tangential). Sorted in tiers: active-needs-you,
  active-idle (by last-opened), then dormant/resume.
- **Terminal pane** (right): one live session's terminal at a time (xterm + node-pty),
  with a status bar (＋file, composer, ⟳ redraw).

---

## Signals the app already has (the raw material for "visibility")

This is the important part — a lot of the substance for "what's everyone doing / why are
they waiting" already exists as data; it's mostly a surfacing problem.

1. **Hook-driven per-session status** (as of v0.9.20). Every session (that installed the
   hooks) reports its own state via Claude Code hooks → `~/.claude/ccc/status/<sid>.json`:
   `working` / `waiting` (turn ended) / `permission` (dialog open — the definitive
   needs-approval edge) / `idle`. Fused with the transcript scan in `snapshot()`. This is
   authoritative and near-instant. THE key new capability that makes richer visibility
   possible.
2. **The transcript** (`~/.claude/projects/*/<sid>.jsonl`): every turn, tool call, and
   assistant message. The *substance* of what a session is doing and the last thing it
   said (e.g. the actual question it's waiting on, the actual tool it wants to run) lives
   here. Largely un-surfaced today (only coarse state is derived from it).
3. **The permission dialog buffer scan** (`detectPrompt`): for managed sessions, the app
   sees the live permission dialog in the PTY buffer — including WHAT tool/command is
   being gated.
4. **The awareness bus + message log**: sessions message each other (child→parent,
   parent→`@child`); every hop is logged and shown in the ✉ panel. A seed of a
   fleet-wide "activity feed."
5. **The edge graph**: parent/child, blocking/tangential relationships between sessions.
6. **Session metadata**: category, name, cwd, model, effort, age, transcript mtime.
7. **(Scoped, not yet built) per-session context% / cost / 5h / 7d** — via an app-owned
   statusLine that dumps Claude Code's status payload. See `docs/roadmap.md` and the memory
   note; decision was to replicate in-app (self-contained, no dependency on the user's
   personal statusline). Not built yet.

The gap the user feels is NOT "we lack data" — it's "the data isn't composed into a view
that tells me, at a glance, *what's happening across the fleet and what actually needs me
and why*."

---

## Directions to explore (options to put in front of the user, NOT decisions)

Bring these as sketches/mockups, ask which resonates, expect the user to reshape them:

1. **Substance in the "needs you" moments.** Turn "session X needs you" into "session X
   wants to run `npm run deploy` — allow?" or "session X asked: *should the migration be
   reversible?*". Pull the actual permission target (tool + command/file) and the actual
   trailing question from the transcript/buffer. This may be the highest-leverage move:
   it directly answers "*why* are they waiting on me."
2. **A fleet activity feed / timeline.** A chronological stream of notable cross-session
   events: X finished a turn, Y hit a permission gate, Z asked a question, W spawned a
   child, V went idle. The message log is a seed. Could be a panel, a page, or a
   collapsible strip.
3. **Per-session "what it's doing" one-liners.** Without opening the terminal, show each
   session's current activity (last tool / last assistant line / "editing foo.ts",
   "running tests", "waiting: your turn"). Ambient awareness of the whole fleet.
4. **The Arbiter (control agent) as the narrator.** The decided-but-unbuilt control agent
   (in-process metered API call, Sonnet, read-only triage — see the memory note
   `command-center-control-agent-and-next`) could consume the hook status + transcripts and
   emit "here's what's happening and who needs you and why" in natural language. The
   "bigger control space" might partly BE the Arbiter's output surface.
5. **A dedicated overview / dashboard.** The user said it "might" be a new page. Weigh a
   dedicated fleet-overview view vs. enriching the existing cockpit. What would live there
   that the cockpit can't hold?
6. **Reorganize around "what needs me."** A primary view sorted/grouped by the human's
   required actions, with everything else secondary.

These are not mutually exclusive. The likely answer is a small combination that nails the
vibe. Resist scope creep — find the one or two moves that make the user go "yes, THAT."

---

## Design principles / constraints (hold these)

- **HITM.** The human stays the central, in-the-loop node. Surfaces should amplify the
  human's read/drop/inject powers, not replace their judgment.
- **High signal — don't over-flag.** The user has already pushed back hard on noise: a
  session that replied and went idle does NOT "need you." "Needs you" = a real gate
  (permission) or a real question or a blocked-on-child parent. Whatever you design,
  protect this. (History: the beacon used to flag every idle session; that was the bug.)
- **Plain, declarative language** everywhere (the user's global rule): no hype, no
  contrast-reveals, no "the prize / load-bearing / here's the elegant part." State the
  thing. This applies to UI copy AND to how you write in the session.
- **Categories are hard-separated** (personal / business / clients) — visibility must
  respect that boundary; a global view shouldn't leak client work into a personal glance
  inappropriately (discuss with the user).
- **It ships to other people eventually.** Don't design anything that depends on the
  user's personal tooling/scripts (this killed the statusline-wrapper idea). Self-contained.
- **Performance:** the scan runs every 1.5s; only one terminal renders at a time. A
  fleet-wide view reads files (transcripts/status), not live PTYs — keep it cheap.

---

## Open questions to ask the user (start here — interview before designing)

1. Walk me through the last moment you felt lost in the fleet. What did you want to know
   that you couldn't see?
2. When a session is "waiting on you," what do you actually need to decide, and what
   information would let you decide it in 2 seconds without opening the terminal?
3. Is "what everyone's doing" a *glance* (ambient, always-on) or a *drill-in* (when you
   choose to look)? Both?
4. New page vs. richer cockpit — do you picture leaving the terminal to see this, or
   seeing it alongside?
5. How much should the app *interpret* (summarize, rank, narrate — i.e. the Arbiter) vs.
   just *show* raw truth? Where's the trust line?
6. What's the failure mode you fear — missing something that needed you, or being
   overwhelmed by noise? (Shapes whether we bias toward completeness or quiet.)

---

## How to run the first session

1. **Read this brief + the pointers below.** Don't re-derive the product.
2. **Interview, don't pitch.** Use the open questions. Reflect the vibe back in the user's
   own terms before proposing anything.
3. **Sketch, then react.** Mock 2–3 of the directions above (the `visualize` / Artifact
   tools are good for this — show a "needs you" card with substance, a fleet feed, etc.)
   and let the user point at what's right and what's wrong.
4. **Converge on the smallest thing that fills the vibe.** Then scope it into
   `docs/roadmap.md` / `docs/backlog.md` and hand back to a build session.
5. **Update memory** (`command-center-*`) with whatever the user decides the vibe IS, so
   it's not lost.

Do not open a build until the user has said "yes, that's it" to a concrete sketch.

---

## Pointers (read these next)

**Repo docs:**
- `docs/concepts.md` — HITM, manipulation-resistance property, the mental model.
- `docs/roadmap.md` — phases, the control agent decisions, hook-status (done), what's next.
- `docs/backlog.md` — specs + deferred items (incl. the workflow/subagent activity view,
  the sidebar-rename quick win).
- `docs/open-questions.md` — parked questions (Q1 usage gauge, Q2 activity view, Q3 status
  precision — several are adjacent to this exploration).
- `docs/design-brief.md` — the UI-kit brief / target IA (beacon + rail cockpit).

**Memory (`~/.claude/projects/-Users-avanrossum-Developer-claude-command-center/memory/`),
read the index `MEMORY.md` first, then especially:**
- `command-center-vision.md` — the one-window-many-sessions vision + requirements.
- `command-center-concepts` / `command-center-hierarchy-model.md` — edges, blocking vs
  tangential, category inheritance.
- `command-center-categories.md` — hard-separated categories + the global status board.
- `command-center-control-agent-and-next.md` — the Arbiter architecture + what's shipped
  through v0.9.22 (hook status, API keys) + next candidates. **The most current status.**
- `command-center-v0-progress.md` — the full build history (long; skim for the hook-status
  and API-key sections).
- `command-center-design-brief.md` — the target information architecture.

**Key code (for grounding, not for editing in the design session):**
- `src/main/index.ts` — `snapshot()` (the fusion of hook + transcript state; where a
  fleet view would source truth), the awareness bus, `readHookStates`, `detectPrompt`.
- `src/renderer/src/App.tsx` — the beacon (`needsYou`, `counts`), the rail, the session
  tree (`groups`/`buildTree`), `dstate`.
- `src/main/engine/transcript.ts` — how state is derived from a transcript (the substance
  for "what is it doing" lives in the transcript this reads).

**Current shipped version:** v0.9.23 (this brief was written at that point). The app is
in active daily dogfooding by the user with a real fleet of ~6+ sessions.
