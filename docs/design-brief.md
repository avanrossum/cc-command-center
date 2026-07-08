# Claude Command Center — Design Brief for Claude Design

**For:** a UI kit and visual system.
**From:** the engineering build (MipYip, LLC).
**Status of the product:** working v0.1.0 desktop app (macOS, Electron). The current UI is functional and clean but plain. The goal of this engagement is a designed visual system that raises it to "amazing" without changing what the app *does* or breaking the technical constraints below.

Read this whole document before designing. The two sections that most constrain your work are **§3 Hard constraints** and **§6 Entity state matrix** — the app lives or dies on legibility of many sessions' states at a glance, and on not fighting the terminal it hosts.

---

## How to read this brief — build status & design latitude

This brief covers both **what exists today** and **where the product is going**, on purpose: we want the visual system designed around the target, not just the current build. Every component in §7 carries a build-status tag:

- **[NOW]** — exists in code today (v0.1.0). Restyle / elevate it; the backend is real.
- **[NEXT]** — near-term (roadmap Phase 6). **Not built yet** — design it ahead of engineering so we build to your design. Underlying infrastructure is partly in place.
- **[LATER]** — a known future feature (Phases 7–8). Wireframe-level direction is enough; don't over-invest.

Roadmap phases are in `docs/roadmap.md`. Do **not** assume a [NEXT]/[LATER] feature has working backend logic — you're designing the surface ahead of it. The current single-sidebar layout (§5.1) is [NOW]; the four-region cockpit (§5.2) is the [NEXT] target.

**Design latitude — this is important.** Where this brief gives a constraint or a *current* value but not a *final* number, that decision is **yours** to make and return as a token: exact row heights, the blocked-state hue, motion durations/easings, icon forms, the spacing scale, precise beacon-bar layout. Treat a missing specific as license to decide, not a blocker to stall on. Return your decisions as CSS custom properties (§11) with a one-line rationale. The pixel values quoted in §3.3/§10/§13 are a factual snapshot of what's there now (your density budget and starting point), not a target to preserve. We would rather you decide and document than send back 20 clarifying questions — flag only genuine product ambiguities.

---

## 1. What the product is

Claude Command Center is a **single desktop window that manages many concurrent Claude Code CLI sessions**. A power user runs 10–25 `claude` sessions at once across different projects; today those are scattered across that many terminal windows ("window soup"), and it is impossible to see, at a glance, which ones are working, which are waiting for a human, and which are idle — or how they relate to each other.

The app solves four things:

1. **Containment** — every session in one window instead of N terminal windows.
2. **Status** — every session's live state (working / waiting-on-me / idle) always visible, including a global board that spans all categories.
3. **Hierarchy** — sessions form task trees. A parent session hits a gap, spins off a child to handle it, then continues. Two kinds of child edges (see §6.2).
4. **Cross-session actions & resume** — inject a prompt into another session, hand off context, and restore everything after a quit/reboot.

It is a **cockpit for an operator running a fleet of agents**. The emotional target: calm, in-control, "I can see everything and nothing is lost." Not a dashboard full of charts — a live operations surface.

## 2. Who it's for and how it's used

- **User:** a technical operator (developer / founder) running many agent sessions across personal projects, their own company, and multiple clients. Comfortable with terminals and keyboard-driven tools.
- **Context of use:** open all day on a large display, often on a second monitor, glanced at constantly and acted on in bursts. The user is frequently *away* from it and returns to triage "who needs me."
- **Primary job-to-be-done on each glance:** "Which sessions are waiting on me right now, and where?" Answering that in under a second is the single most important design outcome.
- **Distribution:** macOS desktop app, dark environments, developer aesthetic. Will be given to outside testers soon.

## 3. Hard constraints (do not violate)

1. **The terminal is the hero content.** The right-hand pane hosts a live `claude` TUI rendered by **xterm.js** (a canvas/WebGL terminal grid). You cannot restyle the terminal's *contents* — Claude's TUI paints its own colors, spinners, and boxes. You design the **chrome around** the terminal (the frame, header, tabs, borders, padding) and must ensure it never competes with or muddies terminal legibility. The terminal background is near-black (`#0b0d12`); app chrome should sit comfortably against it.
2. **Dark-first, and it must coexist with terminal colors.** The chrome palette must not clash with the 16 ANSI colors a terminal emits. Avoid saturated backgrounds bleeding into the terminal area. A light theme is optional/secondary; dark is the product.
3. **Density is real.** The sidebar/tree must stay readable and scannable at **20–30 sessions** across several categories with nesting. Row height, truncation, and status affordances must survive that density. Don't design for 5 rows. *Current numbers as a starting point (yours to change): sidebar 340px wide; row ~34px tall (7px vertical padding, 13px name + 10px cwd on a second line); status dot 8px; tree indent 16px per level; category color dot 8px; count badge pill; UI text 13px, monospace metadata 10–11px. Treat these as the present density budget, not a target.*
4. **Status legibility beats decoration.** Color is *the* status channel; spend the palette's contrast budget on making working/waiting/idle/blocked instantly distinguishable, including for the ~8% of users with color-vision deficiency (pair color with shape/position/motion, not color alone).
5. **macOS-native feel, Electron reality.** Standard traffic-light window controls, `hiddenInset` title bar (the top bar is a draggable region), respects macOS conventions. Rendered with HTML/CSS in Chromium — anything CSS can do is available, but keep it GPU-cheap (see #6).
6. **Performance / self-contained.** No runtime network calls for assets. Fonts must be bundleable (system fonts preferred: SF Pro / system-ui for UI, SF Mono / Menlo / `ui-monospace` for code and IDs). Motion must be cheap — many rows may animate (pulsing "working" dots). Only visible terminal panes hold WebGL contexts (a hard ~16-context cap), so the design can't assume many terminals painted at once.
7. **Deliver as drop-in tokens.** The codebase is React 19 + plain CSS (CSS custom properties in one `styles.css`, no Tailwind/CSS-in-JS). The most useful deliverable is a **token system expressed as CSS custom properties** plus per-component redlines, so it drops into this stack. See §11.

## 4. Design goals — what "amazing" means here

- **One-second triage.** From a cold glance, the user knows how many sessions need them and can jump to the first one. The global status board (beacon bar, §5) is the centerpiece of this.
- **Trustworthy calm.** Idle sessions recede; working sessions have quiet life; only *waiting-on-me* is allowed to pull the eye. The app should feel calm when nothing needs attention and unmistakable when something does. Nothing blinks for the sake of blinking.
- **Legible hierarchy.** The task tree reads instantly: what's a child, whether it *blocks* its parent or is a tangential offshoot, and which parent is *blocked* waiting on a child.
- **Hard-separated categories that never bleed.** Personal / the business / each client are distinct collections. Switching between them must feel like switching rooms, while the global board still shows cross-category alerts.
- **Per-session identity.** The user differentiates sessions by color today (iTerm themes). The design should support giving each terminal a recognizable color identity that also shows up as a cue in the list (planned feature, §7).
- **A developer tool that feels crafted**, not a web dashboard. Precision, restraint, good typography, meaningful motion.

**Non-goals:** playful illustration, marketing gloss, light-mode-first, dense data-viz/charts, heavy skeuomorphism. This is an instrument.

## 5. Information architecture

### 5.1 Current layout (v0.1.0 — what exists today)

```
┌───────────────────────────────────────────────────────────────┐
│  ●  Claude Command Center   [0.1.0-63842]     ● 3 working  ● 2 waiting  ● 6 idle   11 sessions │  topbar (drag region)
├──────────────────────┬────────────────────────────────────────┤
│  ＋ New session…       │  session name        ~/path   [resumed] ✕ │  termbar
│  CATEGORIES   + Cat   │                                          │
│  ┌──────────────────┐ │                                          │
│  │ ● Client · Acme  3│ │            (live claude terminal)        │
│  │   ● sf-sync    2m │ │                                          │
│  │   └─ schema-fix 1m│ │                                          │
│  │   └╌ spike     4m │ │                                          │
│  ├──────────────────┤ │                                          │
│  │ ● Personal      2 │ │                                          │
│  └──────────────────┘ │                                          │
│  (sidebar, 340px)     │  (terminal area, fills remaining width)  │
└──────────────────────┴────────────────────────────────────────┘
```

Regions today:
- **Top bar** — brand (pulsing dot + name), version badge, and a summary of counts by state + total. Draggable.
- **Sidebar (340px)** — "＋ New session" button; a CATEGORIES header with "+ Category"; then one collapsible **group per category**, each rendering its sessions as an **indented task tree**. An "Uncategorized" holding group. Each session is a **row** (§6.1). Right-click a row for a context menu (assign category, set/clear parent edge).
- **Terminal area** — a **term bar** (session name, cwd, a "resumed copy" note, close button) above one live terminal pane. When nothing is selected, a centered placeholder/empty state.
- **Context menu** — floating menu for category assignment and edge-setting.
- **About window** — separate small branded window (already designed minimally; you may restyle — §7).

### 5.2 Target layout (Phase 6 — design for this)

The product is heading toward a **four-region cockpit**. Please design the target IA as the primary deliverable, and treat the current layout as a subset/milestone of it. The change from today is the addition of a persistent global **beacon bar** and a dedicated **category rail**, so categories stop sharing one scrolling sidebar.

```
┌───────────────────────────────────────────────────────────────┐
│  BEACON BAR — global, always visible, never scrolls away        │
│  counts + a live list of every waiting/blocked session anywhere │
├────┬───────────────────────┬──────────────────────────────────┤
│ C  │  task tree for the     │  termbar + tabs                   │
│ A  │  selected category     │                                   │
│ T  │  (indented, typed      │      (live claude terminal;       │
│ .  │   edges, blocked        │       possibly several as tabs    │
│ R  │   banners, roll-up)     │       or a split)                 │
│ A  │                         │                                   │
│ I  │                         │                                   │
│ L  │                         │                                   │
└────┴───────────────────────┴──────────────────────────────────┘
```

- **Beacon bar (global status board):** the single most important new surface. Always visible regardless of which category is focused. Shows global counts and, critically, a **live list/among of every session that is waiting-on-me or blocked anywhere**, each clickable to jump straight to it (crossing categories). This is what makes "who needs me?" a one-second answer. Design it to stay calm when the waiting count is 0 and to be unmistakable when it's not — without being alarming or noisy.
- **Category rail:** hard-separated collections (personal / business / each client), one compact entry each, with a **per-category "waiting" pip**. Selecting one swaps the tree + terminal below **without changing the beacon bar**. Needs an icon/color identity per category and an obvious selected state. Categories must feel isolated ("switching rooms").
- **Task tree:** as today but richer — collapse/expand with **worst-descendant status roll-up** on collapsed parents, a **blocked-parent banner**, and drag-to-reparent.
- **Terminal region:** may host **multiple terminals as tabs** (or a split) rather than strictly one at a time. Design a tab/pane model that respects the WebGL "only visible panes are live" constraint.

**States to cover for the two centerpiece regions** (enumerated so nothing's missed — the exact layout is your call):
- **Beacon bar:** at-rest/calm (0 waiting, 0 blocked); a few (1–3) waiting/blocked shown as jumpable items; many (overflow — decide truncate vs. scroll vs. "+N more"); waiting vs. blocked visually distinct within the list; clicking an item jumps to that session and switches to its category.
- **Category rail:** the set of categories with per-category waiting pip (present only when waiting > 0, or always — your call); selected vs. unselected; many categories (overflow behavior); zero-waiting-everywhere calm state; add-category affordance.

Please design both even though they aren't built yet — they're the near-term direction and the visual system should be built around them.

## 6. Entity state matrix (design every state)

### 6.1 Session (the core entity, rendered as a row and as a terminal)

A session row currently shows: an optional tree connector, a **status dot**, the session **name**, its **cwd** (monospace, dimmed), and a right-aligned **age** (e.g. `2m`). Selected and hover states exist. Waiting rows get a left accent bar.

**Coarse states** (this is the primary status channel — make them unmistakable, and distinguishable without relying on hue alone):

| State | Meaning | Current color | Notes |
|---|---|---|---|
| **working** | actively producing output | green `#34d399` | dot **pulses** (subtle). The "alive" state. |
| **waiting** | waiting on the human (input or a permission prompt) | blue `#60a5fa` | **the attention state** — should read as "come here." Row has a left accent bar today. Highest-priority to surface. |
| **idle** | done / stale, nothing happening | gray `#6b7280` | should recede. |
| **unknown** | state can't be determined (parser/degraded) | purple `#a78bfa` | rare; a graceful "we're not sure" look, not an error. |
| **blocked** *([NEXT], no code yet)* | a parent whose blocking child is unfinished | — | needs its own treatment + a banner ("blocked, waiting on → schema-fix"). Its hue is **your** deliverable; it must read distinctly from **idle** and must not be confused with the **amber blocking-edge** connector color. Design this. |

Sub-states / modifiers to account for:
- **waiting-permission vs waiting-input** *(planned, Phase 7):* a finer split of "waiting" — blocked on a permission dialog vs. asking a question. May want a distinct glyph/shade within the waiting family.
- **age / staleness:** every row carries a relative age (`12s`, `4m`, `3h`, `2d`). Consider how age reads without adding noise.
- **adopted vs managed / degraded send-capability:** some sessions are "adopted" (running in an external terminal, monitor-only until resumed) — they can't receive injected prompts until "restarted under management." This is a real status the UI must be able to mark (a "monitor-only / degraded" affordance). A "resumed copy — original keeps running" note already appears in the term bar.
- **spare/background sessions:** filtered out; not shown.
- **selected / hover / focused** row states.

### 6.2 Task-tree edges (typed parent→child relationships)

Two visually distinct edge types — this distinction must be obvious at a glance:

| Edge | Meaning | Current treatment |
|---|---|---|
| **blocking** | the child gates the parent; parent rolls back to it | solid amber connector `└─`, color `#d0a35b` |
| **tangential** | spun off *with* context but does **not** block the parent | dotted/slate connector `└╌`, color `#7d8698` |

Design a connector/indentation system that scales to a few levels of nesting and clearly encodes edge type (solid+warm = blocking, dotted+cool = tangential is the current language; you may evolve it). Also design the **blocked-parent banner** and the **collapsed-parent roll-up** (a collapsed parent should show the worst status among its descendants).

### 6.3 Category (hard-separated collection)

Each category has a name, a **color**, and a count. Personal / business / clients. Needs: a rail entry (icon + color + name + waiting pip), a selected state, a group header in the tree, and an "Uncategorized" holding state. Colors are user-assignable from a palette — design a palette of ~8–12 category colors that are mutually distinguishable and coexist with the status colors (don't reuse the status greens/blues for categories in a way that causes confusion).

### 6.4 System / empty / error states (design these too)

- **No session selected** — the terminal-area placeholder.
- **Empty category** — "right-click a session to move it here."
- **No sessions at all** — first-run empty state (worth an inviting treatment).
- **Session exited** — the terminal prints an exit notice; consider a chrome affordance.
- **Degraded / unknown-state** node — graceful, not alarming.
- **Nothing waiting** — the beacon bar's calm/at-rest state.

## 7. Component inventory (each needs a designed treatment)

Existing — **[NOW], real in code** (restyle / elevate). Two of these straddle into [NEXT]: item 2's count pills grow into the full beacon bar, and item 10's term bar grows to host tabs + a theme swatch — design the [NOW] form and the [NEXT] evolution:
1. **Top bar / brand** — pulsing status dot motif, wordmark, **version badge** (monospace pill, e.g. `0.1.0-63842`), draggable region.
2. **Global summary → Beacon bar** — evolve today's count pills into the full global board (§5.2). Count pills currently: colored dot + `N working`, etc., dim when zero.
3. **Status pill / count chip.**
4. **Category group header** — color dot + name + count badge.
5. **Session row** — the workhorse component; all states in §6.1. Optimize for scan-ability at density.
6. **Tree connectors** — blocking vs tangential (§6.2).
7. **Context menu** — floating; category assignment list (with checkmark on current), "make blocking child of…", "make tangential offshoot of…", "clear parent", "new category". Needs a refined menu system (headers, separators, submenus/modes, hover).
8. **New-session button** — currently a green outlined "＋ New session…".
9. **Category create / rename inline input.**
10. **Term bar** — session name, cwd (monospace, truncating), status/notes (e.g. amber "resumed copy" tag), close button; will grow to host **tabs** and a **per-terminal theme swatch**.
11. **Terminal pane frame** — padding/border around xterm; must protect terminal legibility.
12. **Placeholder / empty states** (§6.4).
13. **About window** — small branded window: app name, full version + build hash + build time, "by MipYip, LLC" (link to https://mipyip.com), a source-repo link, a "automatic updates coming" note, copyright. Currently a dark card with a green pulse mark; you may give it a proper treatment. Keep it self-contained (no external assets).

Planned — **no UI in code yet; design ahead of engineering.** Phase tags reference `docs/roadmap.md`:
14. **[NEXT] Category rail** (§5.2) — Phase 6.
15. **[NEXT] Blocked-parent banner** + **collapsed roll-up** (§6.2) — Phase 6 (also needs a "blocked" state the engine doesn't compute yet).
16. **[NEXT] Per-terminal theme swatch + picker** — the user assigns each terminal a color scheme (iTerm-style). Needs: a swatch/dropdown in the term bar, and a **small color cue on the sidebar row** so sessions are distinguishable by color in the list — resolve how that cue coexists with the status dot (don't let it read as a second status). Design the swatch, the picker, and the row cue. (~8 built-in schemes + user `.itermcolors` imports.) Backlog spec: `docs/backlog.md` #1.
17. **[NEXT] Cross-session send affordances** — inject a prompt into another session, **broadcast** to many, **copy** text out, **share/handoff** a file + note to a child on spawn. Needs iconography and a delivered/queued/failed status language (an action that can be "queued", "delivered", or "failed" must look different). Also an optional **handoff-note** composer shown when spawning a child. Phase 5. Decide where these live (term bar / context menu / a send panel) — your call, note the rationale.
18. **[LATER] Keyboard command palette / "jump to next waiting"** — a keyboard-first navigation surface. Design a palette and clear focus/selection rings for full keyboard operation. Focus-ring style is a [NOW] concern (applies to today's rows/buttons too); the palette surface itself is Phase 6.
19. **[LATER] Multiple terminals** — tab bar or split for the terminal region. State whether the model is tabs (one visible) or a split (several visible); tabs is the likely default given the WebGL visible-only constraint. Phase 6/8.

## 8. Interaction & navigation model

- **Keyboard-first and mouse both.** Every action reachable by keyboard; a "jump to next waiting session" affordance; a command palette (planned). Design visible focus rings and selection states that work for keyboard navigation, not just hover.
- **Right-click context menus** on rows (category + edge actions). Menu has modes (root → pick-a-parent submenu).
- **Drag-to-reparent** *(planned):* drop a session onto another's body → blocking child; drop *between* rows → tangential offshoot. Design the drag affordances and drop targets/indicators for both outcomes.
- **Selection** drives the terminal pane; the selected row and the open terminal are linked.
- **Category switching** swaps tree + terminal but not the beacon bar.

## 9. Motion

Restrained and meaningful:
- **"Working" pulse** — the green dot pulses softly (current: a 2s box-shadow ripple). This is the app's signature life sign; refine it. It may run on many rows at once, so it must be cheap and calm, not distracting.
- **Attention arrival** — when a session transitions *into* waiting-on-me, a subtle one-shot cue is welcome (not a persistent blink).
- **State transitions** — brief, easing color/position changes; nothing bouncy.
- **Category switch** — a quick, crisp swap; no long animations (this is glanced at constantly).
Define a small motion language: durations, easings, what animates and what must not.

## 10. Current design tokens (starting point — evolve or replace)

Present palette (CSS custom properties in `src/renderer/src/styles.css`):

```
--bg:     #0f1115   /* app background */
--panel:  #161922   /* group/card background */
--panel2: #1b1f2a   /* header background */
--border: #262c3a   /* hairlines */
--text:   #e5e7eb   /* primary text */
--dim:    #8b94a7   /* secondary text */
--dim2:   #5b6474   /* tertiary text / cwd / meta */
--term-bg:#0b0d12   /* terminal background (near-black) */
```

Status colors: working `#34d399`, waiting `#60a5fa`, idle `#6b7280`, unknown `#a78bfa`.
Edge colors: blocking `#d0a35b` (amber), tangential `#7d8698` (slate).
Accent (new-session, "on" states): green family around `#34d399` / `#7ee7b8`.

Typography: UI in system sans (`-apple-system, BlinkMacSystemFont, system-ui`) at ~13px/1.5; IDs, paths, versions, and metadata in monospace (`ui-monospace, Menlo, "SF Mono"`) at 10–12px. Corners ~6–9px. Hairline borders on a dark ground.

You are free to evolve this into a fuller, more refined system (elevation, a proper type scale, a spacing scale, refined status hues with better CVD-separation). Keep the **dark, terminal-adjacent, developer-instrument** character.

## 11. What we need back from you (the UI kit)

Deliver a system that drops into a React 19 + plain-CSS (custom properties) codebase. Ideally:

1. **Token set as CSS custom properties** — full color system (dark required; light optional), a type scale, a spacing/radius scale, elevation/shadows, motion tokens (durations/easings). Named so they can replace/extend the variables in §10.
2. **A status color system** specifically solved for working/waiting/idle/unknown/blocked + the waiting-permission split, verified for contrast on `--term-bg`/`--bg` and distinguishable under color-vision deficiency.
3. **A category color palette** (~8–12) that coexists with the status colors.
4. **Component specs / redlines** for every item in §7 — sizing, spacing, states (default/hover/selected/focus/disabled/empty), at the density in §3.
5. **A states matrix** for the session row and the beacon bar showing every state together.
6. **The two new regions** — beacon bar and category rail (§5.2) — designed, since the system should be built around them.
7. **Iconography direction** — a small, coherent icon set (status, send/broadcast/copy/handoff, category, theme swatch, close, collapse). Line-based, monochrome-tintable, bundleable (SVG).
8. **Motion spec** (§9).
9. **The About window** treatment (§7.13), self-contained.
10. **Accessibility, as concrete acceptance criteria** — a contrast table giving the WCAG ratio for every status/edge/text color against both `--term-bg` (`#0b0d12`) and `--bg` (`#0f1115`), meeting AA (≥ 4.5:1 for text, ≥ 3:1 for non-text/UI indicators); CVD simulations (protanopia / deuteranopia / tritanopia) demonstrating all coarse states stay distinguishable (color paired with shape/position/motion, not hue alone); `:focus-visible` treatment for keyboard nav; minimum hit areas.

Format: whatever's most useful, but **CSS-variable tokens + annotated component redlines + a states matrix** are the highest-value artifacts for handing straight back to engineering. A Figma/visual kit is welcome alongside, but the tokens are what we integrate.

## 12. Brand

- **Company:** MipYip, LLC — https://mipyip.com. The product is "Claude Command Center."
- **Motif already in use:** a small **pulsing green dot** as the live/brand mark (top bar and About). It ties the brand to the core idea (live sessions breathing). Keep or evolve this idea; it's a good anchor.
- **Voice:** precise, calm, technical. No marketing gloss inside the app.
- No logo asset exists yet; a simple, bundleable wordmark/mark suggestion is welcome (must render self-contained — SVG/inline, no external fonts/CDN).

## 13. Technical reference (for accurate redlines)

- **Stack:** Electron 43, React 19, plain CSS (one `styles.css`, CSS custom properties — no Tailwind, no CSS-in-JS). Vite build. macOS-only for now.
- **Terminal:** `@xterm/xterm` 6.0 with the WebGL renderer; you style the frame, not the grid. Terminal font is Menlo/Monaco ~12.5px on `#0b0d12`.
- **Window:** `hiddenInset` title bar; the top bar is the drag region (interactive controls opt out with `-webkit-app-region: no-drag`).
- **Renderer file map (current):**
  - `src/renderer/src/App.tsx` — layout, sidebar, tree building, context menu, top bar.
  - `src/renderer/src/Terminal.tsx` — the xterm host (terminal pane).
  - `src/renderer/src/styles.css` — **all** styles/tokens (this is where your tokens land).
  - `src/main/about.ts` — the About window (self-contained HTML string).
- **Example data for realistic mockups** (use these lengths/shapes, don't invent short ones):
  - Session names: derived from the task, up to ~40 chars — e.g. `schema-migration-spike`, `client-acme-invoice-export`, `fix-webgl-context-leak`, or an unnamed session shown as `pid 48213`.
  - Category names: up to ~24 chars — e.g. `Personal`, `MipYip`, `Client · Acme Corp`, `Client · Northwind`.
  - cwds: home-relativized with `~`, up to ~60 chars, monospace, truncate on the left-important tail — e.g. `~/Developer/claude-command-center`, `~/clients/acme/web/apps/dashboard`.
  - Ages: `12s`, `4m`, `3h`, `2d`. Counts per category: 1–12. Nesting: up to ~3 levels deep.
- **Constraints recap:** self-contained assets only; GPU-cheap motion; only visible terminal panes are live (WebGL context cap ~16); density 20–30 sessions.

---

*Questions or ambiguities: note them back and we'll resolve. The most important thing to get right is §4 goal #1 — one-second triage of "who needs me" via the beacon bar and the session-row status system.*
