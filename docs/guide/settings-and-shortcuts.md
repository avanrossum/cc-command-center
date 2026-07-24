# Settings and keyboard shortcuts

Reference for every setting in the Settings window and every keyboard shortcut in CC Command Center. macOS on Apple Silicon only; the app is in active beta.

---

## Part 1 — Settings

Open Settings from the gear button in the top bar, or with `⌘,`. The window has five tabs: General, Terminal, Notifications, Arbiter, and API keys. Each control writes its value immediately; there is no separate Save step. Close the window with the Close button.

### General

**Trust children by default**
A checkbox (on by default). When on, a child session you spawn can message its parent and be messaged back without you approving the link first. When off, each new parent/child link starts untrusted and the awareness bus holds messages across it until you trust the link (right-click the session → Trust link). Trust is re-checked at delivery time, so revoking it drops any in-flight messages.

**Only show sessions managed here**
A checkbox (off by default). When on, live Claude Code sessions running in other terminals that this app does not own are hidden, so they stop adding to the needs-you bar as they work. Sessions the app manages, and dormant/resumable ones, always stay visible regardless of this setting.

**Awareness mailbox write permission**
The awareness bus works by having sessions write small files to `~/.claude/ccc/`. By default Claude Code prompts for permission on each such write. The Grant button adds one narrowly-scoped rule — `Write(~/.claude/ccc/**)` — to your global `~/.claude/settings.json` (backed up first) so those writes stop prompting. Once granted, the button reads "Granted ✓" and is disabled. This edits your global Claude settings; you can remove the rule there by hand at any time. There is also a first-run dialog that offers the same grant; declining it just records that you have seen it, and you can grant later here.

**Accurate status via hooks**
Installs lightweight hooks into your global Claude settings so every session reports its own state (working / your turn / needs-approval, including the moment a permission dialog opens) instead of the app inferring state from the transcript. The button toggles between Install and Remove. Newly installed hooks apply to sessions started after the install, not to sessions already running. This modifies your global Claude configuration.

### Terminal

**Font**
A combo field (type-ahead input backed by a list) for the terminal font family. The list is filtered to families the app detected as genuinely monospaced, because a proportional font misaligns Claude's terminal interface. You can type any family name. Leave it blank for the system default (Menlo). The change applies to every terminal, live.

**Size**
A number field, in pixels, range 6 to 40 (0.5 steps). Applies live to every terminal.

A preview line below the fields renders sample text in the chosen font and size.

### Notifications

**macOS notifications**
The master switch (off by default). Turning it on is also the point where macOS asks for notification permission. Notifications never fire while the app window is focused, since the needs-you bar already covers that case. While the master switch is off, the per-class checkboxes below are disabled.

**Notify me when a session…** — three per-class toggles:

- **Needs permission** (on by default) — a session is parked on a permission dialog and nothing moves until you answer.
- **Your turn** (on by default) — a session asked you a question and is waiting on the answer.
- **Finished a task** (off by default) — a session's turn ended on a completed task. Off by default because nothing is blocked and this is the highest-volume class.

These are the global defaults. Each category can override any of the three individually: right-click a category in the rail → Edit, and set the class to on, off, or inherit. A category that does not override a class follows the global setting here.

### Arbiter

The Arbiter is an optional agent that writes a one-line plain-English explanation of why each waiting session needs you, shown inline on the session row. It runs on metered Anthropic API billing, not your subscription, and takes no action on any session. It is off by default. Note: this feature has shipped but has not yet been exercised against a real API key.

**Enabled**
A checkbox. You cannot turn it on until at least one API key exists (add one on the API keys tab); the checkbox is disabled with an "add an API key first" note until then. Once enabled it stays clickable so you can always turn it off.

**Key**
A dropdown to pick which stored API key the Arbiter bills to. Defaults to none.

**Model**
Haiku (cheapest, the default), Sonnet (steadier triage), or Opus (best, priciest). Cost tracking follows the selected model, so the spend readout stays accurate.

**Daily cap**
A dollar amount (USD). This is a hard stop, not a warning: when the day's spend reaches the cap the agent stops making calls. Enter 0 for no cap.

What the Arbiter sends is scoped by category. It reads the substance and name of a session only for categories you have explicitly cleared in the category editor; every other session sends its state and shape alone, with the name replaced by a stable handle.

### API keys

Add and remove named Anthropic API keys. Keys are encrypted at rest in the macOS Keychain, are never displayed again after entry, and never leave the machine in the clear.

**Add a key**
Enter a name (for example "Personal" or "Work") and paste the key value (hidden field). Press Enter in the key field, or click Add Claude API key. Both fields must be filled.

**Existing keys**
Each stored key shows its name and a masked hint. Remove deletes it after a confirmation prompt.

A stored key can be assigned per session (in the New Session composer) to run that session on metered API billing instead of your subscription, and can be selected as the Arbiter's billing key above.

---

## Part 2 — Keyboard shortcuts

Shortcuts use the macOS convention: `⌘` Command, `⇧` Shift, `↩` Return, `Esc` Escape. Inside a terminal, the app deliberately never sends any `⌘` combination to the session as input, so app and menu shortcuts fire normally even while the terminal has focus.

| Shortcut | Where | What it does |
|----------|-------|--------------|
| `⌘⇧E` | Anywhere | Toggle the fleet overview grid (every active session at once). Works even while a terminal is focused. `⌘E` alone is avoided because it collides with common global hotkeys. |
| `Esc` | Overview grid | Close the overview grid. |
| `Esc` | Any composer or editor modal | Cancel and close (spawn-a-child composer, cross-session send composer, category editor, rename, launch-parameters modal). |
| `⌘K` | Terminal, with text selected | Instantly spawn a tangential offshoot seeded with the selected text. Does nothing if no text is selected. |
| `⌘⇧K` | Terminal | Not bound. It was intended for blocking-from-selection but collides with global apps (for example Notion), so blocking-from-selection is offered by right-clicking the selection instead, which opens the spawn composer with the type preset. |
| `⌘↩` | Prompt composer (under the terminal) | Send the composed prompt to the open session. Plain `Enter` inserts a newline instead of sending. `Ctrl+↩` also sends. |
| `⌘↩` | Spawn-a-child composer | Submit (create the child). Works from the name and handoff-note fields. `Ctrl+↩` also works. |
| `⌘↩` | Cross-session send / broadcast composer | Send the prompt to the selected target session(s). `Ctrl+↩` also works. |
| `⌘,` | Anywhere | Open Settings (menu accelerator). |
| `Enter` | Category editor, rename field, add-API-key field | Save / submit that field's value. |
| `Shift+Enter` | Terminal | Insert a newline in Claude's prompt (handled natively by the kitty keyboard protocol, reported to Claude as a real newline). |
| `⌘V` | Terminal | Paste the clipboard into the session. Handles both text and images (an image on the clipboard is pasted into Claude Code). |
| `⌘C` | Terminal | Copy the current terminal selection (standard Edit-menu behavior). |
| `⌘`-click | Terminal, on a file path | Open that file or folder in the OS default app (iTerm Semantic History parity). Recognizes anchored macOS paths including ones with spaces, and resolves a mid-sentence path to the longest existing prefix. |

Standard macOS menu roles also apply through the app menu: `⌘Q` quit, `⌘W` close window, `⌘M` minimize, `⌘R` reload, plus the usual Edit, View, and Window menu items.

### Related mouse interactions

These are not keyboard shortcuts, but they are the fastest way to do a few things:

- **Drag a file or folder from Finder onto the terminal** — inserts its full path at the cursor (no Enter), so you can weave it into a prompt.
- **Right-click a terminal selection** — opens the spawn composer to make a child (tangential or blocking) seeded with the selected text.
- **Right-click a session row** — the session context menu (move to category, rename, launch settings, copy last output, send prompt, spawn child, set parent edge, trust link, remove).
- **Right-click a category rail cell** — the category editor (name, emoji, short label, color, Arbiter clearance, per-class notification overrides).
- **Click a tile in the overview grid** — closes the grid and dives into that session.
- **Drag a category rail cell** — reorder categories.
