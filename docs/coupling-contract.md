# Coupling contract v1

The UI depends on `@ccc/contract` (`packages/contract/src`). The coupling package (`@ccc/coupling`) is the only code that runs or reads Claude Code, and it publishes the contract (D-004, D-011 item 3). This note says what each field means and where it comes from. The types file is the authority.

## Field

Every snapshot field is a `Field<T>`: `value`, `source`, `observedAt` (Unix milliseconds) and `stale`. A field whose source stops confirming it keeps its last value with `stale: true`. When a poll of `agents --json` fails, every session stays listed, each `agents-json` field is marked stale, and `FleetSnapshot.sources` carries the error.

Sources, in the order the coupling prefers them: `agents-json`, `mod`, `hook`, `fallback-transcript`, `fallback-screen`. No fallback is planned.

## SessionSnapshot, from `agents --json`

Read with `claude agents --json --all` every 2 seconds. Field meanings are from code.claude.com/docs/en/agent-view.md, "List sessions as JSON" and "Read session state from a script" (read 2026-10-26, Claude Code 2.1.311).

| Contract field | From | Notes |
|---|---|---|
| `sessionId` | `sessionId` | The key. An entry without one is rejected and counted on the source line |
| `kind` | `kind` | An undocumented value reads as `interactive` |
| `cwd`, `startedAt`, `name` | same names | |
| `shortId` | `id` | Background sessions only |
| `pid` | `pid` | Null when the process isn't alive |
| `activity` | `state`, `status` | See below |
| `needsYou` | `waitingFor` | See below |

`activity`:

| Entry | Activity |
|---|---|
| `state: blocked`, `pid` present | `waiting` |
| `state: blocked`, no `pid` | `stale` (D-011 item 2) |
| `pid` present, `status` `busy` / `waiting` / `idle` | `working` / `waiting` / `idle` |
| no `pid`, `state` `working` / `done` / `failed` / `stopped` | `working` / `idle` / `failed` / `stopped` |
| anything else | `unknown` |

`needsYou` is set only when `activity` is `waiting`:

| `waitingFor` | `kind` |
|---|---|
| `permission prompt` | `permission` |
| `input needed` | `question` |
| `sandbox request` | `sandbox` |
| `worker request` | `worker` |
| `dialog open` | `dialog` |
| absent | `blocked` |
| any other value | `other` |

`detail` keeps the source's own words.

## SessionSnapshot, from the reporter mod

The mod (`mod/`) sends its reporter file (wire 0, `mod/hooks/wire.ts`) over the session's authenticated channel (D-005). The coupling package validates it (`reporter-schema.ts`), the channel hub holds the latest per session (`channel/hub.ts`), and `reporter.ts` maps it.

| Contract field | From the mod | Notes |
|---|---|---|
| `model`, `effort` | `turn.step` of the main loop | Effort is what the last model request used |
| `context` | `session.measure` `context` | |
| `costUsd` | `session.measure` `cost.usd` | |
| `rateLimits` | `session.measure` `rateLimits` | `resetsAt` converted from ISO 8601 to Unix seconds |
| `tokens` | Sum of main-loop `turn.complete` usage | Counts from the mod's load in this process, so it restarts at zero after a respawn |
| `subagents` | `$.agent.list()` after `agent.spawn` and each subagent `turn.complete` | `model` from the spawn result |
| `toolCalls` | `tool.call` start without an end | Empty after `session.end` |
| `peerMessages` | `session.send`, `session.receive` | A received message's sender is read from its `<cross-session-message from-name=…>` envelope; the preview is the body, 120 characters |
| `filesWritten` | `tool.call` on Write, Edit, NotebookEdit, Artifact that ended without an error | `url` stays null until an Artifact result is probed |

Every mod field has `source: 'mod'` and `observedAt` set to the file's `writtenAt`.

`pendingRequests` lists the prompts the mod has offered to the app: `requestId`, `tool`, a one-line `summary` (untrusted text), single-choice `questions` with their option labels, `canRemember`, `agentId` and `askedAt`. The app answers one with `ChannelHub.answer(requestId, …)`, which refuses a question answer that doesn't use the question's own labels. The mod writes only when something happens, so age alone doesn't make a field stale. Mod fields go stale when the session's `pid` is gone or the reporter read fails.

The mod also writes `~/.claude/ccc/usage/<sessionId>.json` for `usage-governor.sh` (D-011 item 9). `test/mod-usage.test.ts` runs the governor's own `jq` expression on it.

## SessionHost

`packages/coupling/src/session-host.ts`: `launch`, `resume`, `attach`, `stop`, `respawn`, `list`. `SupervisorHost` builds `list` in N0. The other methods throw `NotBuiltYet` until N2 and Research's hosting probes (MIP2-1377).
