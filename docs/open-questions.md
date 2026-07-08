# Open questions — for later review

Parked questions with preliminary analysis. Not decided or scheduled; captured so they aren't lost. Each has a preliminary feasibility read and a "to investigate" list, not a commitment.

---

## Q1 — Always-visible 5h / 7d usage tracker, globally sourced

**Asked:** 2026-07-07. **Status:** open, not scheduled.

**The ask.** Show the rolling **5-hour and 7-day rate-limit usage** somewhere always visible in the app. Critically, it can't depend on the user's *personal* `~/.claude/usage-cache.json` — that file is written by the user's own statusline/governance hooks and won't exist for an outside tester. CCC needs to source the numbers itself, in a way that works on any machine running Claude Code.

**Why it matters.** An operator running a fleet of sessions needs to see how close they are to a limit before starting more work — the same reason the user's governance hook exists. If CCC is the cockpit, the fuel gauge belongs in it. It's also a prerequisite if CCC ever launches its own agents/workflows and wants to wind down gracefully.

**Preliminary analysis.** Likely feasible, but the real work is finding the *canonical* source that Claude Code itself uses, rather than the user's hook cache. Candidate sources, roughly in order of preference:
- **A CLI-written cache.** Claude Code's `/usage` view gets its numbers from somewhere. If the CLI persists them to a global location (something under `~/.claude/`, not the user's hook output), CCC can read that file the same no-daemon way it reads session state. **Investigate first** — cheapest if it exists.
- **An Anthropic usage/rate-limit endpoint** hit directly by CCC using the stored credentials (OAuth token from `~/.claude/.credentials.json` / Keychain, or an API key). Robust and truly "global," but needs the endpoint, auth-type handling (subscription OAuth vs API key), and careful credential handling.
- **Rate-limit response headers** (`anthropic-ratelimit-*`) — only available on requests CCC itself makes, which it doesn't today. Not a fit unless CCC starts making API calls.

**To investigate.**
1. Where does `claude` store/fetch the 5h/7d numbers that `/usage` shows? Is there a global file CCC can read?
2. If not, is there a usable usage endpoint + the credential to call it?
3. Placement: a persistent gauge in the top bar / beacon bar (already a persistent region — see `docs/design-brief.md` §5.2). Two small bars (5h, 7d) with percent + reset countdown.
4. Refresh cadence and staleness handling (the user's own convention treats >30 min as stale).

---

## Q2 — A global "activity" view of all workers / workflows / routines across every session

**Asked:** 2026-07-07. **Status:** open, not scheduled.

**The ask.** A screen that shows **all active sub-work** — subagents, workflows, background tasks, routines — regardless of which session started it, with status / progress / drill-down per item.

**Why it matters.** Sessions aren't the only unit of work. A single session can fan out a workflow of a dozen agents (this very session did). Today that activity is invisible unless you're looking at the session that launched it. A fleet operator wants one place to see everything running and how far along it is.

**Preliminary analysis.** Feasible with the **same no-daemon, file-scan approach** the session engine already uses, extended to sub-work artifacts. The data is already on disk:
- **Workflows** write a journal with live per-agent state. (Observed: a workflow's output includes a `workflowProgress` array with each agent's `state` = queued/running/done, tokens, tool-call count, timing.) That's drill-down/progress data, parseable directly.
- **Subagents** write transcripts under `~/.claude/projects/<proj>/subagents/**` (e.g. `subagents/workflows/wf_*`, `agent-<id>.jsonl`). Enumerable per session and correlatable to the parent.
- **Background bash tasks** (`run_in_background`) are OS child processes plus `tasks/*.output` files under the session dir — discoverable via the tasks dir + a ppid-chain walk (the same liveness machinery already used for sessions).
- **Liveness** (running vs finished) comes from the same PID-reuse-safe process check plus whether the artifact has a terminal record.

This is a natural third level of the existing hierarchy: category → session → (subagent / workflow / task). It could fold into the task tree as a deeper tier, or be its own "Activity" screen paired with the beacon bar.

**Caveats / to investigate.**
1. **Cost.** Scanning many subagent/task files across all projects wants the event-driven **chokidar watcher (roadmap Phase 3)**, not the current 1.5s poll.
2. **Correlation.** Mapping a subagent/workflow artifact back to its owning session reliably (path structure + ppid chain).
3. **"Routines."** Clarify the term — scheduled/cron tasks and long-running loops? If those live on disk (cron definitions, scheduled-task state), surface them too.
4. **Scope.** This is a substantial new surface, not a tweak. Scope it as its own feature once the watcher exists.

---

## Q3 — What does the "status dot" actually mean? (esp. blue = "waiting")

**Asked:** 2026-07-07. **Status:** answered inline below. Cheap fix **shipped** — blue relabeled **"Your turn"** in the UI. The real precision fix is roadmap **Phase 7**.

**The observation (correct).** Sessions sometimes turn **blue ("Waiting on you")** when they aren't really waiting on the human so much as "the assistant finished its turn / asked something / is ready for a new turn."

**How it actually works today** (`src/main/engine/transcript.ts`). The state is derived purely by reading the tail of the session's transcript and finding the **last real conversation record** (skipping metadata records and subagent sidechains), then:

| Last record | Condition | State |
|---|---|---|
| `assistant`, `stop_reason: tool_use` | — | **working** (green) — mid-turn, about to run a tool |
| `assistant`, any other stop_reason (e.g. `end_turn`) | ended **< 5 min** ago | **waiting** (blue) |
| `assistant`, completed turn | ended **> 5 min** ago | **idle** (gray) |
| `user` | **< 5 min** ago | **working** (green) — assistant responding |
| `user` | **> 5 min** ago | **idle** (gray) — turn that never got a response |
| no parseable conversation record | — | **unknown** (purple) |

So **blue means only: "the assistant's most recent turn ended recently, so structurally it's your move."** It does **not** parse for a question, an `AskUserQuestion`, or a permission prompt. It can't currently tell these three apart:
1. Claude genuinely asked a question and is waiting.
2. Claude finished a task, said "done," and is simply idle-soon (your move, but nothing needed).
3. Claude is blocked on a permission prompt (this likely reads **green**, because the pending tool call is a `tool_use` record — a separate blind spot).

**Two directions for a fix.**
- **Cheap + honest (do soon):** rename the blue state from "Waiting on you" to **"Your turn"** / "Ready for you." That's exactly what the signal means and stops implying the app detected a real question. Low effort, removes the false precision.
- **Real precision (roadmap Phase 7):** split `WAITING_PERMISSION` / `WAITING_INPUT` out of `WAITING`, driven by Claude Code **hook events** (`Notification: permission_prompt`, `Stop`, etc.) and/or an on-demand PTY/screen scrape — not transcript tailing, which is inherently coarse. This is already scoped in `docs/roadmap.md` Phase 7. Heuristics on the final assistant message (does it end with a question / an `AskUserQuestion` tool_use) could be an interim signal but are unreliable on their own.
