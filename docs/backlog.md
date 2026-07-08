# Backlog — next features (specs)

## Upgrade xterm.js to 6.1+ (kitty keyboard protocol → Shift+Enter newline)

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
