# CC Command Center

A macOS app that hosts many concurrent Claude Code CLI sessions in one window.
Single-user tool (Alex). Not an Anthropic product.

## Status: the Electron implementation is closed

As of 2026-09-19 the Electron version stops taking new features. A **Swift port** is
the forward path. Tag `electron-final` marks the last Electron state.

**Read `docs/STATE-OF-THE-APP.md` first.** It is the handoff: the feature inventory
with honest verification levels, the Claude Code coupling surface, the gotchas worth
inheriting, and what is Electron-specific versus what is the actual product.

Do not add features to the Electron app. Bug fixes to keep the daily driver usable are
fine if asked for.

## Current state

| | |
|---|---|
| Stable release | `v0.24.1` (2026-07-30) — what the installed app runs |
| Beta release | `v0.24.2-beta.1` (2026-08-03) |
| Unreleased | 16 commits on `main`, never built, signed or installed |
| Registry schema | `user_version` 18 |
| Rollback points | `electron-final`, `pre-voice-2026-09-01` |

## Working rules that survive the port

- **Verify by running.** Driving the real app has repeatedly caught bugs that reading
  the code did not. "Typechecks" is not "works".
- **Extract pure logic into `engine/` modules with a headless probe.**
  `scripts/mail-probe.ts` (130+ assertions) caught failures review missed. This is the
  highest-value structural decision in the codebase — carry it into Swift.
- **A check that judges duration must distinguish "not observed" from "not
  happening."** This has bitten four separate times. A first run must never report the
  whole existing state as new.
- **Never print signing secrets.** API keys are never viewable, logged, or sent to the
  renderer.
- **Strict versioning** via `npm run bump`; releases via `npm run release`.
- Commit messages end with the Co-Authored-By line.

## Layout

```
src/main/          Electron main: PTYs, registry, mailbox, scans, IPC
src/main/engine/   Pure logic, probe-testable — the portable part
src/renderer/src/  React UI (App.tsx is ~5,000 lines; do not recreate that)
native/ccc-speech/ Swift helper for Apple on-device speech
docs/              STATE-OF-THE-APP.md is the handoff; backlog.md is spec-of-record
scripts/           bump, publish, probes, build-speech
```
