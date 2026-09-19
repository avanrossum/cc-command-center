# State of the app — handoff for the Swift port

Written 2026-09-19, at the point the Electron implementation stops taking new
features. It records what exists, how far each piece was actually verified, and the
knowledge that cost real time to acquire — so a port re-derives none of it.

Audience: whoever plans and writes the Swift version. Assume they have not read the
other docs in this directory.

**Authority.** This file is accurate as of the commit that added it. `changelog.json`
is authoritative for what shipped to users; `docs/backlog.md` is authoritative for
design specs that were written but not built. Where this file and those disagree,
they win and this gets corrected.

---

## 1. What the app is

CC Command Center (CCCC) is a macOS desktop app that manages many concurrent Claude
Code CLI sessions in one window. The framing is **HITM — Human In The Middle**: agents
can message each other, and the human sits in the middle of that bus able to read,
drop, or inject.

It is a single-user tool. It was never built for distribution at scale, and the port
does not need to preserve anything that exists only for other people's machines.

Substrate today: Electron 43 + React 19 + electron-vite 5, `node-pty` for the PTYs,
`xterm.js` (DOM renderer) for the terminals, `better-sqlite3` for the registry.
~18,000 lines of TypeScript across 32 files.

---

## 2. Release status

| Track | Version | Date | Notes |
|---|---|---|---|
| **Stable** | `v0.24.1` | 2026-07-30 | What a normal install is running |
| **Beta** | `v0.24.2-beta.1` | 2026-08-03 | Prerelease; `allowPrerelease` derives from the installed app's own version |
| **Unreleased** | 16 commits on `main` | to 2026-09-01 | Never built, never signed, never installed |

Rollback tag `pre-voice-2026-09-01` marks the last state before the voice work.

The beta track works by GitHub prerelease: a stable install resolves through
`/releases/latest`, which excludes prereleases, so a stable user never sees a beta.
An install that is *already* on a beta version has `allowPrerelease` true and keeps
getting them. This was tested with a real second user.

---

## 3. Feature inventory, with how far it was actually verified

Verification levels used below, because "done" has meant four different things:

- **Shipped** — released, installed, used in daily work for weeks.
- **Verified** — driven end to end in a running build, but not lived with.
- **Built** — written and typechecked; the happy path was exercised.
- **Unverified** — written, never run by a human.

### Shipped and in daily use

| Feature | Notes |
|---|---|
| Multi-session terminal host | node-pty + xterm, one visible at a time, backgrounded PTYs keep running |
| Session adoption | Picks up Claude sessions this app did not start |
| Categories | Color, emoji, short word, drag-to-reorder, per-category notify overrides |
| Task tree | Typed parent→child edges: `blocking` and `tangential` |
| Needs-you detection | Permission / question / done, with a "why" line naming the actual gate |
| Gate ledger | Durable record of what was asked and whether you looked; survives restart |
| Mesh mailbox | Session-to-session messaging, grant-first, with spool + durable delivery |
| The Arbiter | Optional LLM pass that glosses and demotes needs-you flags; own budget + cap |
| Fleet activity | Subagents, shell tasks, workflows, read from transcripts |
| Artifact preview | Images, PDF, markdown, RTF, code; passive detection + drawer |
| Digests | Feed consumer, `ccc.feed.item/v1`, three-depth panel |
| Per-terminal themes | 8 built-ins |
| Context + rate readouts | Per-session ctx%, account 5h/7d, via an app-injected statusLine |
| API keys | safeStorage at rest, served to sessions over an owner-only socket |
| Auto-update | electron-updater, releases in the public repo, beta track |

### Verified but not lived with (all unreleased)

| Feature | Verified how |
|---|---|
| Failed-resume recovery | Detects a silently-cleared resume, adopts the running session, offers context preload |
| Statusline chaining | The user's own statusLine runs again inside app-spawned sessions |
| Done-latch | Stops a handled needs-you row reappearing on a later scan |
| Background agents | `claude agents --json`; surfaces agents no other view can see |
| Permission gate + CSP | Driven over CDP: mic granted, camera denied, remote script blocked, no violations |
| Soft archive + bulk cleanup | Migration v17→v18 against a copy of the real 342-node registry; archive/restore round-trip; cmd-click and shift-range in the live UI |
| Modal data-loss fixes | Drag-out leaves the dialog open; click-away with text prompts |
| Apple speech engine | Swift helper transcribed a `say(1)` utterance through the real IPC chain |

### Built but not verified by a human

| Feature | What is untested |
|---|---|
| **Live microphone capture** | `getUserMedia` → MediaRecorder → decode → WAV. Both ends are proven; the middle has never had a human speak into it. |
| **Whisper engine** | No engine was installed on the machine. Detection returns "not found" correctly; the transcribe path is unexercised. |
| **Model download** | Never run — would pull 148 MB+. The `.part`-then-rename discipline is unproven in practice. |
| **The packaged signed build of everything above** | The helper is wired into `pack`/`dist` and should be signed by `@electron/osx-sign` walking `Contents/`. Never built. |

---

## 4. The coupling surface — read this before porting anything

The app depends on Claude Code internals that are **not a public API**. This is the
single largest source of fragility and the thing a port most needs to inherit
deliberately rather than rediscover. Claude Code version at time of writing: 2.1.224.

| Surface | What is read/written | Stability |
|---|---|---|
| `~/.claude/projects/**/*.jsonl` | Transcripts — subagent scanning, last assistant text, question detection, failed-resume evidence | **Undocumented.** Format has already changed once (`message.content` is a bare string ~4% of the time). |
| `~/.claude/sessions/<pid>.json` | Live session registry — which sessions exist, their ids | **Undocumented.** |
| `~/.claude/settings.json` | App writes hooks + statusLine here; reads to detect prior config | Documented config file, but the app mutating it is the app's own risk |
| `claude agents --json` | Background agents | **Documented as "for scripting; does not require a TTY."** The one sanctioned interface here. Prefer this shape. |
| `--settings <file>` | Additive per-session settings: statusLine + apiKeyHelper | Documented, and verified additive |
| `--resume <id>` | Resuming a session | Documented |
| `--model 'opus[1m]'` | 1M context selection via a suffix on the model string | Verified empirically; the display_name is the only reliable confirmation |
| `TERM_PROGRAM` | Spoofed to `iTerm.app` so Claude enables the kitty keyboard protocol | **Allowlist-gated inside the CLI binary.** Pure internal coupling. |
| Hook payloads | `PreToolUse` / `PostToolUse` / `Stop` / `Notification` / `UserPromptSubmit` | Documented hooks; payload shape is not |
| PTY screen contents | Buffer scanning for gate detection | The most fragile of all — see §6 |

**Port guidance.** Keep the documented surfaces (`--settings`, `--resume`, `agents
--json`, hooks). Treat the transcript and session-registry readers as a compatibility
layer with one owner, so a CLI change breaks one file rather than the app. Avoid
adding new screen-scraping; the existing use is a liability that was earned, not a
pattern to extend.

The daemon's `~/.claude/daemon/roster.json` carries `ptySock` and `ptyAuth` and was
deliberately **not** used, in favor of `claude agents --json`. Keep that choice.

---

## 5. Data model

SQLite, `user_version` migrations, currently at **v18**. Tables:

| Table | Holds |
|---|---|
| `node` | One row per session: cwd, name, category, theme, resume flags, alias, `archived_at` |
| `category` | Color, emoji, label, order, notify overrides, arbiter-context flag |
| `edge` | `child_id` PK → one parent max; `type` blocking/tangential; `trusted` |
| `gate` | The needs-you ledger: kind, first_seen, seen_at, resolved_at |
| `event_log` | Gate history |
| `message` | Mesh mailbox: state machine `queued→held→delivered→read`, plus `failed`/`expired`/`archived` |
| `message_grant` | Who may message whom; sorted pair, directional `mode`, explicit `none` overrides an edge |
| `api_key` | safeStorage-encrypted blobs |
| `arbiter_log`, `arbiter_spend` | Arbiter transcript and metered spend |
| `app_state` | Key/value settings |

The schema is portable as-is. A Swift port can open the same file with the same
migrations and keep every session, name, category and edge. **That is worth doing** —
the registry is the only irreplaceable state, and 342 nodes of it exist.

Everything else on disk is regenerable: `~/.claude/ccc/` holds mail, spool, status,
usage, feeds, the key socket and the generated hook scripts.

---

## 6. Gotchas that cost real time

Each of these was discovered by something breaking, not by reading. They are
substrate-independent unless noted.

**Differential repaint breaks naive ANSI stripping.** Claude Code repaints the TUI
differentially, so the PTY byte stream does not contain a clean copy of what is on
screen. Any gate detection reading the buffer must account for this. There are
checked-in PTY fixtures for exactly this reason — keep that discipline.

**A check that judges duration must distinguish "not observed" from "not
happening."** This bit four separate times: the gate ledger's `liveSessionIds` guard,
`peersOf` on a cold fleet, the digests catch-up-on-launch design, and the hook-drift
baseline. After a restart everything looks dormant and every gate looks unresolved. A
first run must never report the entire existing state as new.

**Session identity can fork underneath you.** Claude Code can change its own session
id mid-life (observed after `/resume` was opened and cancelled). The app keys
everything on session id, so the row goes dormant while its terminal is plainly alive,
a duplicate appears, and the user's name and category strand on the abandoned id.
Unfixed. See backlog item 5.

**`claude --resume` can fail silently and start a cleared session instead.** No error
is reported. The user sees what looks like wiped work. Detection and recovery exist
(v0.24.2-beta.1) and it is worth porting.

**macOS gives no programmatic control over system dictation.** There is a
`startDictation:` action and no counterpart; Electron dropped the `selector` MenuItem
property; there is no dictation role. A start/stop control requires owning the audio.
This is an OS fact and applies identically to a Swift app — except a Swift app can
call `DictationTranscriber` directly and needs no helper process.

**`analyzeSequence(from: audioFile)`, not a hand-built stream.** Building an
`AsyncStream<AnalyzerInput>` and converting with `AVAudioConverter` — the shape every
streaming example shows — fails with a bare `nilError` naming nothing. Directly
relevant to the port, which will use this API natively.

**Bracketed paste plus a delayed CR is the working injection method.** `\x1b[200~` …
`\x1b[201~` then `\r`. Channels injection was tried and abandoned.

**Shift+Enter needs the kitty keyboard protocol**, which Claude gates on a
`TERM_PROGRAM` allowlist. Faking `iTerm.app` is what makes it work.

**`grep` under-reports contamination.** `git log -S` misses a term introduced once and
never edited; plain `grep` returns 0 on a compressed `app.asar` inside a zip where
`unzip -p | grep` returns 7. Verify scrubs with a per-blob scan and a decompressing
pass.

**Extract pure logic so silent failures get probe coverage.** `scripts/mail-probe.ts`
(130+ assertions) caught bugs that review did not: spool-name collision, `user-docs`
matching `@user`, a query-drain infinite loop, Tab-as-text, alias double-hyphen. The
engine modules under `src/main/engine/` exist to be testable without a UI. **Port this
shape.** It is the highest-value structural decision in the codebase.

---

## 7. Electron-specific vs portable

**Portable — the actual product.** The registry schema and migrations. The state
taxonomy (working / your turn / blocked / idle, and permission vs question vs done).
The gate ledger model. The mailbox state machine and grant model. The digest item
contract (`ccc.feed.item/v1`). The transcript and session-file readers. Injection via
bracketed paste. All of `src/main/engine/`.

**Electron-specific — solved problems that stop being problems.**

| Electron problem | In Swift |
|---|---|
| Permission gate + CSP (Electron grants everything by default) | Not applicable; no renderer, no web content |
| `dangerouslySetInnerHTML` for artifact preview | Native views; the sanitizer problem disappears |
| Mic entitlement + helper process | Call `DictationTranscriber` directly in-process |
| Nested-binary signing, deployment targets, rpath | One binary |
| `asarUnpack` for native modules | Not applicable |
| xterm.js IME/composition handling | SwiftTerm or a native terminal view has its own characteristics — re-derive, do not assume |
| electron-updater + blockmaps | Sparkle, or nothing, for a single-user app |
| 135 MB DMG | Small |

**Rethink rather than port.** The one-terminal-visible-at-a-time constraint was an
Electron performance accommodation. The renderer's 1.5 s poll was always meant to
become a watcher. `App.tsx` is ~5,000 lines and should not be recreated as one file.

---

## 8. Known open problems, carried forward

1. **Session identity fork** (§6, backlog item 5) — unfixed, user-visible, three
   distinct symptoms from one cause.
2. **`term.draft` desync, the half that is not fixable by counting.** The counter sees
   only bytes sent through the app's own input path, so text Claude Code's `/voice`
   inserts is invisible to it, and a delivery can land under typed text. The other half
   (a stuck counter holding mail forever) was fixed with a staleness guard.
3. **Background agent takeover does not stick.** `agents:takeOver` launches a *utility
   terminal*, which is in-memory only, alive-only, and hardcoded to no category. It
   appears once and never returns. Needs to be a real registry node.
4. **Mailbox write still prompts on file CREATE** despite the granted rule; suspected
   relative-path matching.
5. **Selection → spawn (Cmd+K) unreliable** — Claude enables mouse tracking, so xterm
   does not own the DOM selection.
6. **Built-in digest producers** — designed in detail (backlog item 6), never built.
   Includes a stated invariant: a spending producer shares the Arbiter's cap, never its
   own.
7. **Hook drift check** — designed (backlog item 8), never built. Surfaces hooks in
   `~/.claude/settings.json` the app did not write. Relevant because this app supplies
   the camouflage for that injection vector.

---

## 9. Notes for the port

**Keep the registry file.** Same schema, same migrations, open it in place. Session
names, categories and edges are the only state that cannot be regenerated, and there
are 342 nodes of history.

**Keep the engine/probe split.** Pure functions with a headless probe caught real bugs
repeatedly. It is worth more than any single feature.

**Port the state taxonomy before the UI.** Permission vs question vs done, and
notice-tier vs action-tier, were settled by use, not by design. A failed background
task is notice-only and deliberately does not raise a needs-you flag.

**Do not port the voice architecture.** It exists as a helper process because Electron
cannot reach the Speech framework. Swift calls `DictationTranscriber` directly. Keep
the two-engine idea (Apple for zero setup, Whisper for technical vocabulary) and the
decision not to bundle model weights. Keep the measured accuracy note: Apple heard
"verify the migration" as "verify the immigration."

**Start from the coupling table in §4,** not from the feature list. What the app can
know about Claude Code is what determines what it can do.

**The marketing and docs are real.** `README.md`, `docs/digests.md` and the MipYip page
describe a public product. If the Swift version is single-user only, decide early
whether that public face continues, because it shapes what has to keep working.
