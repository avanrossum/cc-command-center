# Backlog — next features (specs)

## ✅ Pre-release cleanup — DONE (2026-07-20, before The Arbiter)

Sequence the user set and we followed: (1) `feat/bigger-control-space` merged → (2) this cleanup
→ (3) build The Arbiter.

What ran, and what the audit found:

- **Branding consolidated on MipYip.** The dead brand is gone from file contents, commit
  messages, and commit/tag identity. Audit correction: `package.json` and `src/main/about.ts`
  were *already* migrated, so the source-rebranding item here was stale. The real exposure was
  in commit metadata, which no content-level search would have caught.
- **History rewritten** with `git-filter-repo` across all commits, tags re-pointed, unreachable
  objects pruned (`reflog expire` + `gc --prune=now`). A five-angle parallel audit plus a
  completeness critic found the contamination was near-total rather than the three commits
  originally listed — `git log -S` had under-reported it, because a term introduced once and
  never edited again never changes its occurrence count.
- **`release/` and `out/` deleted** (4.6 GB). Packaged `.zip`/`.dmg` builds embedded the old
  client name inside a **compressed** `app.asar`, which is invisible to `grep` — `grep -c` on a
  zip returns 0 while `unzip -p | grep -c` returns 7. These were gitignored, so no history
  rewrite would ever have touched them, and they are exactly what gets attached to a GitHub
  release. **Rule going forward: never publish a build produced before this date.**
- **`spike/` dropped.** Phase 0 throwaway (Channels-injection experiment, verdict: blocked → the
  app uses send-keys/bracketed paste instead). Unreferenced by the app; its `.mcp.json` also
  hardcoded absolute local paths.
- **Not scrubbed, deliberately:** `/Users/avanrossum` paths. The repo lives at
  `github.com/avanrossum/...`, so the username is public by definition — removing it would be
  theater. Author *display names* were likewise left intact; only the email domain changed.

Lesson worth keeping: verify a scrub with a per-blob scan plus a decompressing pass over
archives. Both `git grep` over refs and plain `grep` over binaries returned clean results on
demonstrably contaminated data during this audit.

## Quick wins (logged)

- ✅ **Context-window selector on spawn (SHIPPED v0.9.25, 2026-07-20).** New sessions could pick
  a model but not a context window, so every spawn landed on the default window. Claude Code
  selects the 1M variant with a **`[1m]` suffix on the model string** (`--model opus[1m]`) —
  verified empirically: `claude --model 'opus[1m]' -p … --output-format json` reports
  `"claude-opus-4-8[1m]"` with `contextWindow: 1000000`, and the statusLine payload's
  `model.display_name` reads `Opus 4.8 (1M context)` vs plain `Opus 4.8`. In the CLI bundle the
  alias allowlist is `["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]","fable[1m]","opusplan"]`
  and the display gate is `endsWith("[1m]") && supports_1m_suffix`, so the suffix attaches to
  aliases *and* full ids (`claude-opus-4-8[1m]`) but **not Haiku** (no 1M variant). A third
  "Context" dropdown sits beside Model/Effort, remembered via a new `lastContext` app-state key
  (kept separate from `lastModel` so the two restore independently). Disabled when the model is
  Default or Haiku. NB: `modelUsage.contextWindow` and the statusLine `context_window_size` both
  report the *model's* max (1000000) regardless of the suffix — the display_name is the reliable
  signal that 1M is actually engaged.
- ✅ **Rename a session from the sidebar (SHIPPED v0.9.24, 2026-07-18).** Right-click a session
  → "Rename…" → a small popover (`SessionNameEditor`, mirrors the category editor); blank restores
  the generated title. `session:setName` IPC → `setSessionName`; the open terminal header stays in
  sync. No engine change, as scoped.

## Known issues, deferred (user, 2026-07-09 — not critical now)

- **Mailbox write still prompts on file CREATE.** Despite the working `Write(~/.claude/ccc/**)`
  rule, a session CREATING its outbox `.msg` for the first time still shows a "Create file"
  permission prompt (the one whose option 2 is "allow Claude to edit its own settings"). It's a
  write to the same folder, so the rule *should* cover it. Leading hypothesis: Claude Code matches
  the rule against the path AS CALLED — and Claude expresses the outbox as a RELATIVE path
  (`../../../.claude/ccc/mail-dev/x.msg`) since it's outside cwd — so an absolute/`~` rule misses
  it. Candidate fixes to TEST empirically: add a leading-`**` glob `Write(**/.claude/ccc/**)`
  (matches the relative form too, still scoped to .claude/ccc), and/or make the child write via the
  absolute path, and/or inspect the actual permission matcher (docs say it resolves to absolute —
  empirics disagree). This blocks a beat of the parent/child relationship (the write pauses for
  approval), so resolve before wide use.
- **Selection → spawn (Cmd+K / right-click) not reliably firing.** Even after capturing the
  selection at right-mousedown, it still doesn't work in practice. Likely cause: Claude Code enables
  terminal mouse tracking, so xterm doesn't own the DOM text selection (`term.getSelection()` is
  empty) — the "selection" the user sees may be the OS/CC layer, not xterm's. Needs a different
  capture path (track xterm `onSelectionChange`, or detect/relax mouse mode, or a dedicated
  "spawn from selection" affordance). NTH for later; parked.



## Robust tree termination (user, 2026-07-09)

Asking the root session to "end the whole tree" didn't reliably execute — the parent argued
about the relayed request, and even when it agreed, the actual termination didn't go through
(it messaged the child to "wind down" but nothing terminated). Two layers:

- **UI path (mostly covered as of v0.9.5):** right-click a session → Remove from list now kills
  the whole subtree's terminals + removes the nodes (with a confirm). That's a reliable operator
  "end the tree" — but it also *removes* them from the list. Consider a distinct **"End
  session + subtree"** action that terminates the PTYs (self-exit sentinel) *without* removing
  the registry nodes, so the tree can be resumed later.
- **Autonomous path (open):** a parent telling a child (via the bus) to end itself is brittle —
  the child may argue or may not emit the `[[CCC:EXIT]]` sentinel. And there's no
  cascade-via-messaging (a child ending doesn't tell ITS children to end). Options: a bus
  control-directive the app interprets as "terminate this subtree" (app cascades the kill,
  no LLM compliance needed), and/or firmer preamble wording so an exit request reliably yields
  the sentinel. The control agent could own "wind down this branch" as a first-class operation.

Not urgent (user flagged it as a tangent). The self-terminate primitive ([[CCC:EXIT]]) and the
remove-subtree cascade are the building blocks.



## SHIPPED — the bigger control space (v0.9.25 → v0.10.0, 2026-07-19/20)

Built on `feat/bigger-control-space` (a session running *inside* the app), merged to main.
Full handoff for the Desktop session: `docs/explorations/bigger-control-space/OUTCOME.md`.
All read-only surfaces; no Arbiter / API-key dependency.

- ✅ **"Why" line**: every needs-you row/card carries the actual gated command (conservative,
  parsed from the PTY buffer — coarse fallback rather than a guess), the real question (from the
  transcript), or `blocked → child`.
- ✅ **Refined state taxonomy**: permission ("open a door", latched) vs question ("needs your
  brain" — AskUserQuestion + a turn ending on `?`, holds until you act, no silent idle fade).
  AskUserQuestion is now detected (it fires no hook — added a buffer signature).
- ✅ **Gate ledger** (registry v9): durable `gate` + `event_log`, FK-cascade **delete-on-removal**,
  auto-seen (gated on window focus) / auto-resolve (debounce), bounded caps. Drives the "did I
  handle it?" pip; survives restart. Hardened against a 12-bug adversarial review.
- ✅ **Category identity** (registry v10): color + optional emoji (clickable grid) + short word +
  full-name-on-hover, in the rail and on cross-category tags. The ＋ opens the same editor.
- ✅ **Companion pane**: hideable panel right of the terminal — the Strip (duration swimlanes) + a
  cross-category "needs you" why-board (this-category / ALL scope, default ALL). Beacon NEEDS-YOU
  list hides while it's open. Arbiter gloss seam (`whyGloss`) wired but empty.
- ⏳ Deferred: since-you-were-away briefing; ambient edge (optional, default off); radar (later).

## SHIPPED — this-phase wrap-up (v0.8.1 → v0.9.0, 2026-07-08)

- ✅ **Selection → tangent** (v0.8.1): Cmd+K on a terminal selection spawns a tangential child
  seeded with it (instant); right-click opens the composer pre-filled.
- ✅ **Name a child at spawn** (v0.8.2): the spawn dialog now has a Name field → stable user name
  applied on adoption → `@`-addressing resolves on it (off Claude's drifting auto-title). The
  handle/purpose spec below is now PARTIAL — remaining fast-follow: a separate **editable purpose
  subtitle** (from the handoff note) + **immutability** enforcement of the handle.
- ✅ **Settings menu + trust-children-by-default (default ON) + first-run mailbox permission**
  (v0.9.0): gear in the beacon bar; auto-trust spawned links; one-time offer (and a Settings button)
  to add `Write(~/.claude/ccc/**)` to `~/.claude/settings.json` (safe merge, backed up).

## SHIPPED — terminal-UX + spawn/lifecycle batch (v0.9.1 → v0.9.4, 2026-07-09)

- ✅ **Selection → blocking too** (v0.9.1): spawn composer has a Tangential/Blocking toggle;
  selection spawn is Cmd+K (tangent) / Cmd+Shift+K (blocking); right-click → composer.
- ✅ **Self-terminate** (v0.9.1): a session writes exactly `[[CCC:EXIT]]` to its outbox → the app
  kills that PTY (drainOutboxes; onExit prunes). Taught in the preamble. Gives a parent a real lever
  to end a child (vs "ack and idle").
- ✅ **Cmd+Click a file path** (v0.9.2): opens with the OS default app, relative to the session cwd.
  Hardened (v0.9.4): directories / .app bundles / OS-executed types are REVEALED in Finder, not
  launched (arbitrary-app-launch guard).
- ✅ **Terminal status bar** (v0.9.3): ＋file/folder picker (per-session last dir; inserts path) +
  drag-drop a file onto the terminal + composer toggle + a context-usage slot (placeholder).
- ✅ **Prompt composer v1** (v0.9.3): togglable field, Enter=newline, ⌘↩=send. Draft cleared on
  session switch (v0.9.4).
- ✅ **Hardened** (v0.9.4): 5 review findings fixed (launch guard, composer session-switch,
  path sanitize, self-exit log-after-kill, link-regex tightened).

Still OPEN: handle/purpose **purpose-subtitle + immutability** (fast-follow); composer
**paste-image/file → temp-path** + the **interactive-Q/A** integration; status-bar
**context-usage readout** (needs a data source — is it exposed by Claude Code?); Cmd+Click
**wide-char column** offset + **live-cwd** tracking (both minor/cosmetic); the **README** (GA).



## Session handles vs. purpose labels — stable identity + visible purpose (user, 2026-07-08)

**Diagnosis (what's happening now).** The spawn-child dialog (`SpawnComposer`) has NO name field —
only Folder + Handoff note — so spawned children can't be named at spawn. Their sidebar names are
**Claude's own auto-titles** (`node.name`, derived from each session's conversation, updated via
`ensureNode`); they can **drift** as the conversation grows. Only sessions named via the New-session
modal (or a manual rename → `sessionNames` app_state) have a stable user name (e.g. "Parent-01").
The real problem: `@`-addressing in the awareness bus resolves against `displayName` = that drifting
auto-title, so a child's callsign can change out from under the router (this also caused the phantom
"child-of-child" 4th-level in the multi-hop relay test — an ambiguous name read as real structure).

**Design — split identity from purpose:**
- **Handle** — a short, **fixed-at-spawn, immutable** identifier; the ONLY thing `@name` resolves
  against. Settable in the spawn dialog (add the field), or auto-assigned a short slug (`c1`, `c2`…)
  if blank. Never drifts → hardens bus addressing AND gives children clear, non-renamable identities.
- **Purpose** — an **editable** subtitle showing what the child was spawned to do, sourced from the
  handoff-note gist (or a dedicated field). Never used for addressing.
- Sidebar row: **`c1`** · *investigate the fms module*. Stop resolving `@name`/`displayName` on
  Claude's auto-title; resolve on the handle.

**Recommended default:** handle settable-at-spawn + immutable; purpose from the handoff note, freely
editable. Pairs with the awareness bus (stable @handles) and the settings/trust work above.

## README / landing narrative with screenshots (user, 2026-07-08)

The bidirectional bus + multi-hop relay + HITM frame is the significant, sellable story and needs a
real writeup — README / landing narrative / marketing — built around **pictures**. No such doc exists
yet. Structure it on three shots the user already has: (1) the bidirectional round-trip, (2) the
multi-hop relay transcript (grandchild status rolled up through a child that only sees its own
children), (3) the sidebar tree. Anchor the narrative on the HITM frame (see `docs/concepts.md`):
Human-In-The-Middle multi-agent orchestration, with read/drop/inject over an autonomous agent bus.
Emphasize: local-knowledge + relay scales to arbitrary depth; the human stays the middle node;
everything is observable + killable. (Claude can draft the narrative; the user supplies the images.)
Ready-made worked example to mock up on the page: `docs/examples/parent-child-adversarial.md` — the
"terrible song" conflict test that shows the bus, @-addressing, and the trust model (agents hold to
their own brief; only the human can change the plan) in one memorable story.

## Settings menu + "Trust children by default" (user, 2026-07-08)

**Motivation.** The explicit Trust-link (bless) step is friction for a link you deliberately
created. Make autonomous messaging on a spawned link the DEFAULT, with an opt-out for the
cautious.

**New surface: a settings menu.** The app has none yet; `app_state` (registry kv,
`getAppState`/`setAppState`) already exists to persist settings. Entry point: a gear in the
beacon bar (or an app-menu item) → a modal/panel that accumulates settings over time. Future
homes: awareness-pause default, the prompt-composer toggle, theme defaults, etc.

**First setting: "Trust children by default" — default ON.**
- **ON**: a child you spawn is trusted at creation (`edge.trusted = 1`). Autonomous messaging
  flows immediately, both ways — no manual bless.
  - Implication: the parent bless-note (how to `@name` the child) fires at **spawn/adoption**,
    not on a manual trust. And the child's up-messages flow immediately (not held-until-bless).
- **OFF**: spawned children start untrusted; you must right-click → **Trust link** to enable
  messaging (current behavior). Show the hint text — "you'll need to manually trust children
  by right-clicking → Trust link" — under the unchecked toggle, and optionally as a one-time
  reminder toast at spawn.

**Scope (open decision).** Does "trust children" cover only app-**spawned** children, or also
manual re-parents ("make blocking child of…")? Recommend: auto-trust applies to **spawned**
children (deliberate creation); wiring two pre-existing sessions still warrants an explicit
trust. Revisit.

**Safety note.** With auto-trust, the **kill switch** becomes the primary "stop everything"
control (no per-link human gate in the default path). The combined per-link rate guard,
only-when-free delivery, and the preamble's "only on genuine need" remain the containment.
Defensible because you spawned the child deliberately — but it raises the importance of the
kill switch being prominent and obvious.

## Spawn a child from a terminal selection — frictionless tangent (user, 2026-07-08)

**The idea.** Select text in a session's terminal, then right-click → menu item OR press a
shortcut (e.g. Cmd+K) → **auto-spawn a child seeded with that selection as its context.** You
spot something in a session's output, grab it, and it becomes a new session's starting brief
without derailing the current one. This is the [tangent concept](concepts.md) made instant —
the exact "idea mid-flow, seed a separate context, don't stain this one" workflow, triggered
straight from what you're reading.

**Mechanism (small — reuses existing machinery).**
- xterm gives us the selection directly: `term.getSelection()` (no clipboard needed;
  auto-copy-on-select is a separate nicety).
- Parent = the focused/attached session (whose terminal holds the selection).
- Reuse `spawnChild(parentSessionId, cwd, type, note)` — the selection becomes the `note`
  (handoff/seed), delivered as the child's first message after the awareness preamble. cwd
  defaults to the parent's cwd.
- Edge type: default **tangential offshoot** (non-blocking — this IS the tangent case; the
  parent keeps going).

**Triggers (offer both):**
- **Right-click** a terminal with a selection → context items: "Spawn tangent with selection"
  (instant) and "Spawn child with selection…" (opens SpawnComposer pre-filled, to tweak
  folder/category/name/type first).
- **Keyboard shortcut** while text is selected — candidate Cmd+K (verify it doesn't collide
  with a terminal/menu shortcut; may need Cmd+Shift+K). Instant tangential spawn. NB: the
  terminal returns false for Cmd combos so the menu handles them — this shortcut needs a home
  that doesn't fight the editMenu / kitty path.

**Instant vs. composer:** the ask is "auto-spawn" (instant). Recommend shortcut / first menu
item = **instant tangential spawn**; second menu item = **pre-filled composer** for when you
want to adjust. Best of both.

**Nice-to-haves:** a toast confirming "spawned tangent from selection" + the child name; cap
or trim a huge selection so the seed stays manageable.

## Terminal status bar + file insertion (user, 2026-07-08)

A status bar under the terminal pane. Contents:
- **Context usage** for the currently-loaded session — % of the context window used
  (this is per-session context, distinct from the 5h/7d rate gauge in `open-questions.md`
  Q1). SOURCE (user, 2026-07-09): the user's own statusline plugin/hook already computes
  this — check that config (`~/.claude/statusline.*` / the statusline command) for how it
  derives context% per session, then read the same source rather than re-deriving.
- **At least one more useful readout** (TBD — user wants ≥1 more, unsure what). Candidates:
  model, session cost/tokens, cwd, git branch of the cwd, last-activity, coarse state.
- **"Add file/folder" button** → a Finder open dialog that opens to the **last location used
  for THIS session** (per-session last dir, NOT the app-global `lastFolder` app_state — needs
  a per-session variant, keyed by sessionId). On pick, **insert the full path into the
  terminal WITHOUT pressing enter**, so the user can weave it into a prompt ("adjust this per
  the spec, file: {path}").
- **Drag/drop**: dropping a file/folder onto the terminal pane pastes its full path (same as
  the button — no enter).

This is the baseline; it works today with no interception risk. The composer below is the
richer version of the same intent — ship this first.

## Optional prompt composer under the terminal — "type without the Shift+Enter dance" (user, 2026-07-08)

An **optional, togglable** full-text prompt area beneath the terminal. Typing directly into
the terminal stays fine; this is opt-in for when you want a real text field. When ON:
- **Regular Enter = newline; Cmd+Enter = send.** No more Shift+Enter to add lines.
- **Paste an image** → saved to a temp location accessible to that session; the saved path is
  passed along with the prompt on send (so the image reaches Claude Code as a file path and
  plain Enter stays free for newlines).
- **Paste any other file** → same (saved/referenced by path).
- The **"add file/folder" button** (from the status-bar spec) TAGS items for inclusion with
  the prompt on send, instead of inserting a path inline.
- When the composer is toggled **OFF**, that button reverts to the baseline behavior (insert
  the path as plain text into the terminal).
- **On send**: the composer assembles prompt text + tagged file/image paths and injects it
  into the PTY (bracketed paste + CR — the same transport as cross-session send).

**Hard caveat — interactive Q/A (open, flagged, NOT solved).** Claude Code sometimes asks
questions / shows permission prompts / menus in the TUI. If the composer is the primary input,
we need a **durable** way to surface and answer those. The live terminal sits underneath (the
composer injects into the same PTY), so the raw TUI is always the fallback — but a clean
integration (route CC's question up into the composer, or detect a prompt and refocus the
terminal) is unsolved. Candidates: hooks, PTY/screen interception, signals. Must be durable,
not brittle screen-scraping. This is the gate on making the composer the *primary* input; the
status-bar baseline has no such dependency.

## Cmd+Click a file path to open it — iTerm Semantic History parity (user, 2026-07-08)

**Goal.** Cmd+Click a file path in the terminal to open it (default app or editor),
the way iTerm2 does. Concretely: the paths Claude Code prints (e.g. a report at
`tasks/2026-07-08_.../MOE2-ARCH-HAG-V1.0.pdf`, or `src/main/index.ts:42`) become
clickable and open.

**Research verdict (2026-07-08, verified both ends).** This is a **terminal** feature,
not a Claude Code one:
- iTerm2's **Semantic History** detects path-like text with its own regex, resolves
  it against the cwd it tracks per line, and opens on Cmd+Click.
- Claude Code (binary inspection, v2.1.205) emits file paths as **plain text** in agent
  output — the OSC 8 `link()` helper exists but is wired only into statusline/formatting
  contexts, not the response pipeline (open FRs: anthropics/claude-code #13008, #27889,
  #48652). It also does **not** emit OSC 7 (cwd). So iTerm resolving relative paths is
  100% iTerm inferring the cwd (shell integration / proc inspection).
- **We have an advantage:** we already track each session's cwd (`termOpen` opts.cwd /
  registry `node.cwd`), so relative-path resolution is trivial — no OSC 7 needed.

**Mechanism (xterm 6.1 has the exact API).**
- `term.registerLinkProvider(ILinkProvider)`: `provideLinks(lineNumber, cb)` scans the
  buffer line, regex-matches path-like tokens (with optional `:line:col`), returns
  `ILink[]` with `range`, `text`, `decorations {underline, pointerCursor}`, and
  `activate(event, text)`.
- `activate(event, text)`: gate on `event.metaKey` (Cmd+Click only); strip a trailing
  `:line:col`; call a new IPC `term:openPath(termKey, cleanPath)`.
- Main `term:openPath`: resolve `isAbsolute(p) ? p : join(session.cwd, p)` (cwd from
  `terminals.get(key).cwd`); if `existsSync` → `shell.openPath(full)` (default app —
  opens PDFs/images/docs, which is the common case); else flash "not found".

**Details / decisions.**
- **Path regex** is the fiddly part — match `/abs`, `./rel`, `a/b.ext`, `dir/dir/file`,
  with optional `:\d+(:\d+)?`, without lighting up every word. iTerm's trick is to
  **verify existence** before decorating. MVP: check-on-click (simplest). Cleaner:
  check-at-provide-time (only real files underline) at the cost of more IPC.
- **`:line:col`**: strip for the existence check; pass to an editor if opening in one
  (`code -g file:line:col`) vs. `shell.openPath` for the default app.
- **Bonus (cheap, future-proof):** also set xterm's `linkHandler` (OSC 8) with
  `allowNonHttpProtocols: true`, so if/when Claude Code wires up file hyperlinks, or any
  program emits real OSC 8, those Just Work. Add `@xterm/addon-web-links` (not currently
  installed) so `http(s)://` URLs open in the browser.
- **Polish (optional):** underline-only-while-Cmd-held (track Meta keydown/keyup, toggle
  link decorations) to match iTerm exactly; default is underline-on-hover +
  open-on-Cmd+Click (VS Code style).

**Effort:** small-to-medium; lands cleanly because we own the cwd. Files touched:
`Terminal.tsx` (registerLinkProvider), `index.ts` (`term:openPath` handler),
`preload` + `global.d.ts` (bridge).

## Right-click "New session from here" variants (user, 2026-07-08)

1. **New session in this folder (+ optional context).** Right-click a session → "New session here" spawns an INDEPENDENT new session in the *same cwd* (no typed edge — unlike Spawn child), pre-filling the New-session modal's folder from the source and letting the user type initial context/instructions. Small: reuses the New-session modal + `session:create`; just seed the folder from the right-clicked session.

2. **New session with summarized context.** Right-click → "Spawn new session with context": the **control agent** (fleet conductor — see roadmap Future direction) reads the source session's transcript, SUMMARIZES the relevant working context, and uses that summary as the new session's initial prompt. This is Phase 10's "context without the whole transcript" realized through the control agent — the same bounded-brief mechanism as tangent spawning + handoff notes. **Depends on the control agent existing.**



## Broadcast — scope + graph-aware quick-selects (user, 2026-07-08)

Broadcast (the `SendComposer` checkbox fan-out) works well. Two enhancements the
user flagged as roadmap:

1. **Scope control.** The composer currently lists every managed live session
   app-wide (`live.filter(s => s.managed && !s.dormant)`), but the user perceives
   it as scoped to the current category/folder. Add an explicit, visible scope
   toggle: **this category** (default) vs **all categories** — so the intent is
   obvious and expandable rather than implicit.

2. **Graph-aware quick-selects.** Buttons that select target sets from the edge
   graph relative to the origin session:
   - **All children** — every session with a typed edge whose parent is the origin
     (one hop; consider a "descendants" variant for the whole subtree).
   - **All siblings** — every session sharing the origin's parent, with a
     toggle to **include / exclude the parent** itself.
   These compute from `snap.edges` (child_id/parent_id). Big boon once the fleet
   has real tree structure — "tell all my children to X", "sync the siblings."
   Pairs naturally with the awareness bus (a parent broadcasting down its subtree)
   and the future control agent (which could issue these fan-outs itself).

## Upgrade xterm.js to 6.1+ (kitty keyboard protocol → Shift+Enter newline) — ✅ DONE (on beta)

**Done 2026-07-08 (v0.6.7):** bumped `@xterm/xterm` → `6.1.0-beta.288` + addon-webgl `0.20.0-beta.287`, addon-fit `0.12.0-beta.288`, addon-serialize `0.15.0-beta.288`, and set `vtExtensions: { kittyKeyboard: true }` on the terminal. xterm now answers Claude's keyboard-protocol negotiation and reports Shift+Enter as CSI-u (`\x1b[13;2u`) → Claude inserts a newline natively. Custom key handler removed. **On BETA packages** — the user opted in to unblock the reflex-level friction. **Follow-up:** move all four to stable 6.1 when it ships; watch for any beta regressions in WebGL rendering / fit / serialize (scrollback snapshots) / normal input + paste.

**Original rationale (why 6.0 couldn't):**

**Why.** Shift+Enter can't insert a soft newline on xterm.js 6.0: the terminal can't represent Shift+Enter distinctly from Enter (it drops the modifier and sends bare CR). Modern Claude Code expects the **kitty keyboard protocol** — Shift+Enter encoded as `\x1b[13;2u` (CSI-u: key 13 = Enter, modifier 2 = Shift). Kitty-protocol support landed in **xterm.js 6.1** (PR #5600). Every legacy byte we can inject fails: LF (`\x0a`) and CR submit; ESC+CR (`\x1b\r`, Option/Meta+Enter) inserts when empty but misbehaves with text; bracketed-paste LF sticks when empty but **submits once the buffer has text** (Ink's documented "trailing-newline-in-paste = submit"). Confirmed authoritatively (claude-code-guide research, 2026-07-08).

**Blocker.** As of 2026-07-08, xterm 6.1 is **beta only** (`6.1.0-beta.288`), and it would move `@xterm/xterm` + `addon-webgl` + `addon-fit` + `addon-serialize` all onto beta. Not worth destabilizing the terminal (the app's hero feature) for a newline nicety. **Do this when 6.1 goes stable.**

**Work when unblocked.** Bump xterm + the three addons to 6.1/matching stable. On 6.1, xterm negotiates the kitty protocol with claude and sends `\x1b[13;2u` for Shift+Enter **natively** — no custom key handler needed (remove the note in `Terminal.tsx`). Verify the WebGL renderer, fit, and serialize still work, and that normal input/paste/resize are unaffected. Interim for users: Claude's built-in `\`+Enter (backslash line-continuation) gives multiline, protocol-independent.



Shelved deliberately at the end of a long session. Each is self-contained and ready to build.

## 1. Per-terminal theme selector — ✅ SHIPPED v0.2.0 (import bonus still open)

**Done:** 8 built-in xterm IThemes (`src/renderer/src/themes.ts`), `node.theme` column (migration `user_version=3`) + `setTheme` + `theme:set` IPC, a term-bar picker with live apply + persistence, and a shape-distinct identity swatch on sidebar rows. Themes are remembered per session and applied live without remounting the terminal.

**Still open (the bonus):** `.itermcolors` import — parse the plist (keys like `Ansi 0 Color`, `Background Color`, `Cursor Color` → dicts of `Red/Green/Blue Component` floats 0–1), convert each float triple to `#rrggbb`, map iTerm keys → xterm ITheme keys, store the resulting ITheme JSON (a `custom_theme` table or a serialized value in `node.theme`), and add an "Import .itermcolors…" item (`dialog.showOpenDialog` with `filters:[{name:'iTerm colors', extensions:['itermcolors']}]`). Original spec retained below for that work.

Differentiate sessions visually the way iTerm color schemes do today. Per-terminal, remembered.

**Data:** add a `theme` TEXT column to `node` in `src/main/registry.ts` (migration `user_version = 3`), plus `getTheme(sessionId)` / `setTheme(sessionId, name)`. Store the theme *name* (built-ins) or a serialized custom theme.

**Built-in themes:** define ~8 xterm `ITheme` objects (background, foreground, cursor, cursorAccent, selectionBackground, + the 16 ANSI colors `black…brightWhite`) in a `src/renderer/src/themes.ts`. Give them names (e.g. Default, Solarized Dark, Dracula, Nord, Gruvbox, Tokyo Night, Rosé Pine, Monokai). Keep contrast high — these render Claude's TUI.

**Apply:** `TerminalView` reads the node's theme and passes it to `new XTerm({ theme })`; changing it live via `term.options.theme = t`. Key the `<TerminalView>` remains the pid; theme change should NOT remount (mutate `term.options.theme`), so lift theme into a prop and add an effect that updates `term.options.theme` when it changes.

**UI:** a small swatch/dropdown in the `.termbar` (terminal header). On select → `window.cc.themeSet(sessionId, name)` (new IPC `theme:set`, pushSessions or a dedicated event), and apply live. Also surface the current theme's accent as a tiny swatch on the sidebar row so sessions are distinguishable at a glance in the list too — this is the iTerm-parity win.

**Import `.itermcolors` (bonus):** an iTerm color file is an XML plist mapping keys like `Ansi 0 Color`, `Background Color`, `Foreground Color`, `Cursor Color` to dicts of `Red/Green/Blue Component` floats (0–1). Parse the plist (a tiny hand-rolled parser or a plist dep), convert each float triple to `#rrggbb`, map iTerm keys → xterm ITheme keys (`Ansi 0..15` → `black, red, green, yellow, blue, magenta, cyan, white, brightBlack…brightWhite`; `Background/Foreground/Cursor` → the matching ITheme fields). Store the resulting ITheme JSON in the `theme` column (or a `custom_theme` table). Add a "Import .itermcolors…" item (Electron `dialog.showOpenDialog` with `filters:[{name:'iTerm colors', extensions:['itermcolors']}]`).

## 2. New session — extras

The folder-picker launch exists. Still to add:
- **Optional CLI args** — a small text field in the new-session flow passed to `launchSession(cwd, args)` (already accepts `args`); split respecting quotes.
- **Bare-terminal adoption** — "open a plain shell, run claude yourself, the app adopts it." Harder: the app-owned pty would be the *shell*, and the claude it spawns is a grandchild with a different pid. Options: (a) host a shell pty and watch for a new `~/.claude/sessions/<pid>.json` whose pid is a descendant of the shell pid (walk ppid chain), then bind that node to this terminal; (b) simpler interim: a "＋ New shell" that opens a shell terminal and lets the user run anything, with the resulting claude auto-appearing in the sidebar (unbound to the shell terminal) via the normal scan.

## 3. Resume-on-restart (Phase 4 — the "heaven forbid I reboot" requirement)

On quit, persist which nodes had an open terminal + a scrollback snapshot (`@xterm/addon-serialize`) + layout. On launch, rebuild the tree/category layout and relaunch `claude --resume <session-id>` per formerly-open node, painting the snapshot until the live TUI repaints. No live process survives quit/reboot on any substrate — resume is always a `--resume` relaunch from the registry.

## 4. Quality upgrades (from roadmap)

- **Live chokidar watcher + hook endpoint** (Phase 3) — replace the 1.5s poll with instant, event-driven updates; batch the per-pid `ps` calls.
- **Terminal tabs / multiple visible** — currently one terminal visible at a time (backgrounded ptys keep running + buffer).
- **"Blocked" status** — a parent with an unfinished blocking child should render "blocked, waiting on → child" (compute from edges + child state).
- **Precise waiting-vs-permission** (Phase 7) — `reg:waiting` sessions currently read idle; needs a PTY/screen read.
