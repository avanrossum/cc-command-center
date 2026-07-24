# Troubleshooting

Common situations you may hit while running the app, what causes each, and how to fix or work around it.

This app is in beta, runs on macOS (Apple Silicon), and reads parts of Claude Code that are not a public API (the transcript format, the status hook, session registry files, terminal rendering). Some of the situations below come from that coupling, and a few resolve on their own once the app catches up to your Claude Code version. Where a fix lives in macOS System Settings rather than the app, that is called out.

## An external session you don't manage shows in the needs-you bar

**Symptom.** A session you started in iTerm, Terminal, or some other window — one this app did not launch — appears in the fleet and shows up in the beacon "needs you" bar or the companion board, adding noise while it works. You did not start it here and you do not want to triage it here.

**Why.** The app adopts every live `claude` process on the machine, not only the ones it launched, so sessions you run in other terminals are visible and readable. That adoption is useful for status, but an external session you are driving elsewhere can crowd the needs-you surfaces with attention events you are already handling in its own window.

**What to do.**

1. Open **Settings → General**.
2. Turn on **"Only show sessions managed here."**

This hides live Claude Code sessions running in terminals the app does not manage. Your own app-launched sessions stay, and resumable (dormant) sessions stay. Only currently-alive, unmanaged sessions are hidden. Turn it back off any time you want the full machine-wide picture again.

## A resumed session still shows "needs approval" from before

**Symptom.** A session that was parked on a permission dialog when you last quit comes back after a restart still colored amber ("needs approval"), and — before this was fixed — stayed amber even after you resumed it, with no dialog actually on screen.

**Why.** `claude --resume` cannot restore a live permission dialog. It reopens the conversation at the last line, so the interactive prompt that was on screen is gone. The old permission event, though, was still recorded from before the quit, and the state engine could re-apply it to the resumed session even though nothing was actually waiting.

**What to do.** Nothing — the app now handles this. Each resumed session's process is stamped with its start time, and any status event older than that process is treated as stale and discarded. After a resume the process is new, so every pre-resume permission event is dropped and the live terminal (which correctly shows no dialog) becomes the authority. A genuine new gate that opens after the resume still fires normally.

One related behavior to expect: a **dormant** (not-yet-resumed) session can still show its held gate from the "did I handle that?" ledger. That is deliberate — it is the memory that you left that session needing you. It is the live, resumed session that no longer keeps a phantom gate. If you ever see a resumed, on-screen session still stuck amber with no visible dialog, interact with it once (the next scan reads the live buffer) or resume it again.

## Notifications don't show action buttons

**Symptom.** macOS notifications from the app either vanish before you can click them, or don't show the action buttons you expected.

**Why, in two parts.**

- **Action buttons are not shipped yet.** Today's notifications are text banners: a title (the session name), a subtitle (category and class), and a body (the reason). You click the banner to jump to the session. Interactive notifications — the verbatim question or permission query lifted into the body with its options as buttons and an inline reply field — are on the roadmap, not in the current build. So if you are looking for `[ Yes ] [ No ]` style buttons, they are not there yet.
- **The macOS notification style must be Alert.** Regardless of the above, for a notification to persist on screen (and, later, to carry action buttons at all) macOS requires the app's notification style to be **Alert**, not **Banner**. Banners appear briefly and disappear on their own, which can make them vanish before you click through to the session. The app cannot set this style for you; it is a per-app user setting.

**What to do.**

1. Open **System Settings → Notifications**, and select this app in the list.
2. Set the alert style to **Alerts** (not **Banners**).
3. Confirm **"Allow notifications"** is on. If you denied the macOS permission prompt earlier, the in-app notification switch alone does nothing until you re-allow it here.

Also confirm notifications are enabled in the app itself: **Settings → Notifications**, master switch on, plus the class switches (needs-permission, your-turn, done) you want. Notifications never fire while the app window is focused, so test with the app on another monitor or behind another window.

## The app breaks after a Claude Code upgrade

**Symptom.** Status readings go wrong, sessions read the wrong color, permission gates stop being detected, "why" lines go blank, or something else that worked yesterday misreads today — shortly after Claude Code updated itself.

**Why.** The app depends on parts of Claude Code that are not a public API: the transcript record format, the status-hook payload shape, the `sessions/<pid>.json` registry files, the permission-dialog text it scans for, and how the TUI renders in the terminal. When Claude Code ships a release that changes any of those, the app can misread until it is updated to match. This is expected for a tool coupled to internals, and there is no support SLA.

**What to do.**

1. **Update the app.** Check for a newer build (the app checks after launch and daily, and surfaces available updates with release notes). A break right after a Claude Code release is often already fixed in a newer app build.
2. **Expect graceful degradation, not a dark board.** The app is built so a single parse failure degrades one session to an unknown/coarse reading rather than taking the whole fleet down. If one session reads oddly but the rest are fine, that is the intended failure mode; the affected session's status may just lag.
3. **If a critical signal is broken and no app update fixes it,** a short-term workaround is to hold Claude Code at the version that last worked until a matching app build ships. Note your Claude Code version and the app's build id (shown in the top bar and the About window) when you report it, so the break maps to exact versions on both sides.

## A native-module / ABI mismatch (app won't launch)

**Symptom.** The app fails to launch, or crashes immediately on start, typically after you changed the Electron version, pulled new source, or reinstalled dependencies. The underlying error mentions a native module compiled against a different Node.js/Electron version (`NODE_MODULE_VERSION`), usually pointing at `node-pty` or `better-sqlite3`.

**Why.** Those two are native modules with no drop-in prebuilt for this exact Electron version. They are compiled against a specific ABI, and an Electron or Node version bump invalidates that build until the modules are rebuilt. A released, signed build ships with these already rebuilt and packaged, so this is almost entirely a run-from-source situation, not something a tester on a downloaded build should hit.

**What to do.**

- **Running from source:** rebuild the native modules against the app's Electron version, then relaunch:

  ```
  npx electron-rebuild -f
  ```

  `@electron/rebuild` is already a dependency, and `node-pty` + `better-sqlite3` are the modules it rebuilds. Do this after any Electron bump, a fresh `npm install`, or when the launch error names one of those modules. The packaged-build path (`npm run pack` / `npm run dist`) rebuilds them as part of packaging.
- **Running a downloaded build:** you should not normally see this. If you do, the download is likely mismatched or corrupt — reinstall the latest released build rather than trying to rebuild anything by hand.

A readable startup self-check that names this problem and the fix, instead of failing silently, is a planned hardening item and is not in the build yet. For now, the module name in the launch error is the signal.

## The overview at very high session counts

**Symptom.** With a large fleet, the 50k-foot overview grid (Show all / Cmd+Shift+E) doesn't show a tile for every session, or you expect to see idle sessions in it and don't.

**Why, and what to expect.** The grid is built to stay legible and responsive no matter how busy the fleet is, so it makes two deliberate trims:

- **It caps at 24 tiles.** Beyond that, the remainder shows as a **"+N more"** count rather than rendering every session. Tiles are sorted by urgency (permission, working, question, soft your-turn, blocked, done) and animate into position, so the sessions that most need you are the ones on screen, top-left. The overflow is the least-urgent tail.
- **Idle sessions are hidden by default.** The grid's default view is what's in motion. A persisted **Show-idle** checkbox adds live-idle sessions when you want the whole live fleet. If a session you expected is missing and it is simply idle, flip Show-idle on.

**What to do when the fleet is large.**

- Use the **beacon bar** as the always-visible, fleet-wide count and top-waiting list; it does not cap and does not narrow when you switch categories. It is the reliable "what needs me across everything" surface at any session count.
- Use the **needs-you companion board** (fleet-scoped) for triage when several things need you at once; cross-category cards are tagged by category color.
- Lean on **categories** to split a large fleet into readable collections, and click a tile to dive into a session rather than treating the grid as the place to manage everything.
- Only the tile's outline color and position are real-time on every scan; the thumbnail image is a periodic snapshot, so trust the color at the edge over the freshness of the picture inside a busy grid.

## When you report a problem

Include the app's **build id** (top bar and the About window — it maps to the exact commit) and your **Claude Code version**. Because the two are coupled, a bug usually depends on both, and the pair tells you whether the fix is an app update, a Claude Code version to hold at, or something new.
