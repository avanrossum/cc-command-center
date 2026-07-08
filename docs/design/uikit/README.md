# Handoff: Claude Command Center — visual system / UI kit

## Overview
Claude Command Center is a macOS (Electron) desktop app that manages many concurrent
`claude` CLI sessions in one window — a cockpit for an operator running a fleet of
agents. This package is the **designed visual system** for it: tokens, component
redlines, every entity state, motion, iconography, the About window, and accessibility
acceptance criteria. It restyles/elevates the working v0.1.0 build and designs the
near-term four-region cockpit ahead of engineering. It does **not** change what the app
does.

The single most important outcome the design serves: **one-second triage of "who needs
me?"** via the beacon bar + the session-row status system.

## About the design files
The files here are **design references authored in HTML** (a live, interactive
prototype) — they show intended look and behavior, not production code to copy verbatim.
The task is to **recreate them in the app's existing environment**: React 19 + plain CSS
(CSS custom properties in one `styles.css`; no Tailwind, no CSS-in-JS), Electron 43, Vite,
`@xterm/xterm` 6 WebGL terminal.

- `styles.css` in this folder **is** meant to drop in almost as-is — it's the token
  layer + a few canonical primitives, written in the project's real convention. It
  replaces the §10 variables in `src/renderer/src/styles.css`.
- `Claude Command Center UI Kit.dc.html` is the visual source of truth. Open it to see
  the assembled cockpit and every redline. (It uses a lightweight custom-element runtime
  for authoring only — ignore that; read it as HTML/CSS.)

## Fidelity
**High-fidelity.** Final colors, typography, spacing, radii, states, and motion. Recreate
pixel-faithfully using the codebase's existing plain-CSS patterns. All values below are
targets, not the current-build snapshot.

## Where each piece lands (current renderer file map)
- `src/renderer/src/styles.css` — **all tokens + primitives.** Start here; paste the token
  blocks from this folder's `styles.css`.
- `src/renderer/src/App.tsx` — top bar → **beacon bar**, sidebar → **category rail + task
  tree**, tree building, context menu.
- `src/renderer/src/Terminal.tsx` — xterm host → **terminal pane frame + term bar/tabs**.
- `src/main/about.ts` — **About window** (self-contained HTML string).

## Screens / regions (target: four-region cockpit)

### 1 · Beacon bar  (global, always visible, never scrolls — height 58px)
- **Purpose:** answer "who needs me?" at a glance, across all categories.
- **Layout:** left→right, all full-height, hairline-separated: traffic-light region +
  pulsing brand dot + `command-center` wordmark (mono) → count tally block → `NEEDS YOU`
  ledger of jumpable waiting/blocked items → `⌘K` at far right. Top bar is the window
  drag region (`-webkit-app-region: drag`); interactive children opt out with `no-drag`.
- **Count tally:** big number (17px, status color) over a 8.5px uppercase mono label,
  per state: WORKING / WAITING / BLOCKED / IDLE / TOTAL. A zero count dims to `--cc-faint`.
- **NEEDS YOU items:** each is `[index 2-digit] [status glyph] [session name] [category
  dot] [age]`, left-bordered 2px in its status color, tinted background at ~7% of that
  color. Waiting = blue square; blocked = magenta diamond. **Clicking an item switches the
  rail to that session's category and selects it — the beacon bar itself never changes.**
  Overflow past 3 collapses to `+N more →` (opens the command palette filtered to waiting).
- **Calm state (0 waiting/blocked):** counts only + a quiet `all clear — nothing needs
  you` line with the pulsing green dot. This is the reward state — must feel calm.

### 2 · Category rail  (width 68px)
- **Purpose:** hard-separated collections (personal / business / each client). Selecting
  one swaps the tree + terminal beneath, **without touching the beacon bar** — switching
  rooms.
- **Cell (46px):** a single category-color letter (700, 13px). **Active cell** uses the
  exact selected-row language: left 3px bar in the category color + `--cc-fill-sel`
  background, `--cc-r-0` corners. **Waiting present** → a 3px bar on the **right** edge in
  `--cc-waiting` (mirrors the left bar; scales to any count, no number). This right-edge
  bar was the deliberate resolution to "the pip shouldn't float."
- `+` add-category pins to the bottom; opens the inline create input. Overflow scrolls.

### 3 · Task tree  (selected category)
- **Session row (height 38px, pad 0/14, dot 8px, gap 8px):**
  `[connector] [status dot] [name (12.5 sans)] … [modifier tag] [age (10 mono)]`.
  Second line cwd (10 mono, `--cc-meta`) when shown, elides mid-path.
  **Selection ≠ status:** selected = neutral `--cc-fill-sel` fill; status = 2.5px inset
  left bar. A row can be both (selected + waiting shows fill + blue bar + bold white name).
- **Typed edges:** blocking = solid warm `└─` (`--cc-edge-blocking`, child gates parent);
  tangential = dotted cool `└╌` (`--cc-edge-tangential`, offshoot, doesn't block). Indent
  12px per level, ~3 levels. Solid-vs-dotted is legible in grayscale (not hue-dependent).
- **Blocked-parent banner:** inline under a blocked parent — `⏸ blocked · waiting on →
  <child>`, magenta left rule; the child name is a jump link.
- **Collapsed roll-up:** a collapsed parent (`▸`) shows a small pip of its **worst
  descendant** status (e.g. "2 waiting"), so collapsing never hides an alert.
- **Modifiers:** `perm` tag (waiting-permission, ringed square); `◐ monitor` dashed tag
  (adopted / monitor-only — can't receive injected prompts until restarted under
  management); `exit 0` tag + strikethrough name (exited).
- **Category group header:** color square + uppercase mono name + `[count]`, collapsible.
- **Context menu (right-click):** mono section headers + hairline separators; MOVE TO
  CATEGORY list with `✓` on current; "Make blocking child of… ›" / "Make tangential
  offshoot… ›" open a pick-a-parent submode; Clear parent; + New category.

### 4 · Terminal region  (term bar 42px + xterm pane + status line 26px)
- **Model = tabs, not split.** Only the visible tab holds a live WebGL context (hard ~16
  cap); background tabs keep their status dot but the grid is dormant until focused.
- **Term bar:** tabs each `[status dot] [name] [✕]`; active tab has a 2px bottom border in
  its status color. Right side: cwd (mono, truncates) + per-terminal **theme swatch** (13px
  rounded square) → opens the color-scheme picker (~8 built-ins + `.itermcolors` import).
- **Pane frame:** `--cc-term-bg` #0b0d12, **never re-themed** (even in light mode); 1px
  `--cc-border`, no glow/gradient/shadow bleeding into the grid. ~14–16px pad top/left.
- **Status line:** mirrors the session status in words + glyph (`◍ WAITING · INPUT`),
  model, context %, output; on exit prints an `exit N` chip.
- **Empty/first-run:** no-selection placeholder (`⌥↩ to jump to next waiting`), empty
  category ("right-click a session to move it here"), first-run welcome — all carry the
  pulsing green brand dot.

### Planned surfaces (design present; backend not yet built)
- **Cross-session send** (Phase 5): inject / broadcast / copy / handoff, with a delivery
  language — `◷ queued`, `✓ delivered`, `⚠ failed` (failure self-explains, e.g. target is
  monitor-only). Lives in the term bar + context menu.
- **Command palette** (`⌘K`, Phase 6): keyboard-first "jump to next waiting"; selection
  ring = the focus-visible token.
- **Drag-to-reparent:** drop ON a row → blocking child (amber outline preview); drop
  BETWEEN rows → tangential offshoot (slate insertion line).

## Interactions & behavior
- Selection drives the terminal; selected row ↔ open tab are linked.
- Category switch = 260ms crisp cross-fade of tree + terminal; beacon bar unaffected.
- Beacon item / banner child / roll-up are all jump targets (may cross categories).
- Keyboard-first AND mouse: every action reachable by keyboard; visible focus rings on
  rows, buttons, tabs, menu items.
- Right-click context menu with a pick-a-parent submode.

## State (per session, drives the row + terminal)
- Coarse: `working | waiting | idle | unknown | blocked`.
- Waiting sub-split (Phase 7): `waiting-input | waiting-permission`.
- Modifiers: `adopted/monitor-only` (degraded send), `resumed-copy`, `exited`, age.
- Tree edges: `blocking | tangential`; a parent is `blocked` when a blocking child is
  unfinished (engine must compute this — new for Phase 6).
- Category: name, color (from the 10-color palette), count; plus an "Uncategorized" holding
  group using `--cc-faint`.

## Design tokens
All tokens are in `styles.css` (this folder) as CSS custom properties, with dark `:root`
and `[data-theme="light"]` blocks. Headlines:
- **Surfaces:** `--cc-bg #0e0d0b`, `--cc-surface #14120f`, `--cc-surface-2 #100f0d`,
  `--cc-rail #0c0b09`, `--cc-term-bg #0b0d12` (never themed), `--cc-border #2a2824`.
- **Text (4 tiers):** `--cc-text #e7e3db` · `--cc-dim #9a9384` · `--cc-meta #8a8272` ·
  `--cc-faint #6a6355` (non-text/decorative only).
- **Status:** working `#34d399` · waiting `#60a5fa` · idle `#6b7280` · unknown `#a78bfa` ·
  **blocked `#e070c8`** (magenta — chosen distinct from idle AND from the amber edge).
- **Edges:** blocking `#d0a35b` · tangential `#7d8698`.
- **Category palette (10):** gold `#e2b34a`, sky `#4ac0e2`, terracotta `#e2724a`, violet
  `#9b6ff0`, raspberry `#d14a9b`, teal `#2fb8a0`, coral `#e0625f`, lime `#9bbf4a`, indigo
  `#6d7cf0`, + Uncategorized gray. Used only in the rail/header — never as a status dot.
- **Type:** UI `-apple-system, system-ui`; mono `ui-monospace, "SF Mono", Menlo`. Scale
  52/27/15/13/12.5/11/10.
- **Radius:** 1px inside (rows/rail/chrome), 6px floating (buttons/chips/menus), 9px cards,
  12px window only. **Space:** 2px grid. **Elevation:** hairline first; `--cc-e-1` menus,
  `--cc-e-2` window. **Motion:** 120/180/260ms, pulse 2400ms; `--cc-ease-out`,
  `--cc-ease-inout`.

## Motion
Only three things move: **working pulse** (2400ms box-shadow ripple, infinite — the
signature life-sign, GPU-cheap so dozens run calmly); **attention arrival** (one-shot ring
when a session *enters* waiting — fires once, never a persistent blink); **category swap**
(260ms cross-fade, no slide/bounce). `prefers-reduced-motion`: pulse → static 1px ring,
arrival → 1-frame fill, transitions → 0ms. Status never depends on motion.

## Iconography
14 line glyphs, 20×20 box, 1.5px stroke, `currentColor` (tints to any status/category):
new, close, collapse, palette, next-waiting, inject, broadcast, copy, handoff, category,
theme, monitor, drag, status. Bundle as inline SVG — no network. See §07 of the kit for
the exact paths.

## Accessibility (acceptance criteria — testable)
- **Contrast (measured vs #0b0d12 term / #0f1115 app):** text 15.2/14.9 (AAA), dim
  6.4/6.2, meta 5.1/5.0 (AA); faint 3.3/3.2 (non-text only). Status/edge indicators:
  working 10.1, waiting 7.7, blocked 6.8, unknown 7.2, edge-blocking 8.4, edge-tangential
  5.3 — all ≥3:1 (most clear AAA as text too); idle 4.0/3.9 (≥3:1 indicator; row name uses
  `--cc-meta`). Full table in §10 of the kit.
- **CVD:** every coarse state pairs color with a unique shape (●▪◆○◌) + motion + position;
  edges split solid vs dotted. Verified in a fully-desaturated strip (§03) — the worst case
  for protanopia/deuteranopia/tritanopia.
- **Focus-visible:** 2px `--cc-waiting` outline, 2px offset, on every interactive element.
- **Hit areas:** row 38px full-width, rail cell 46px, tab 42px, beacon item full 58px,
  menu item 28px — the whole element is the target, not just the glyph.

## Design decisions taken on the brief's latitude (flagged)
1. **Blocked hue = `#e070c8` (magenta)** — reads distinct from idle gray and from the amber
   blocking-edge; diamond shape keeps it clear of the waiting square.
2. **Warm-graphite chrome** (evolved from the cooler `#0f1115` snapshot) so app chrome reads
   as its own material against the cool terminal near-black. `--cc-term-bg` stays #0b0d12.
3. **Category waiting cue = right-edge bar**, reusing the accent-bar language rather than a
   floating badge.
4. Row heights, rail width, motion timings, spacing scale set as the returned tokens above.

## Files
- `Claude Command Center UI Kit.dc.html` — the full visual system (cockpit + all redlines).
- `styles.css` — drop-in tokens + canonical primitives for `src/renderer/src/styles.css`.
