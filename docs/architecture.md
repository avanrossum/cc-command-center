# Architecture

The platform and hosting decision is the project's D-011 (MIP2-1367). This note maps it to the code.

```
Claude Code ──► packages/coupling ──► @ccc/contract ──► src/main ──IPC──► src/preload ──► src/renderer
 (agents --json,   (the only reader      (SessionSnapshot   (security,        (window.ccc)     (UI; contract
  the mod)          of Claude Code)       v1, types)         IPC, windows)                      types only)
```

| Module | Holds | May import |
|---|---|---|
| `packages/contract` | SessionSnapshot v1, FleetSnapshot, Field | nothing |
| `mod` | The reporter mod: runs inside each app-launched session; sends telemetry and offers prompts over the channel, submits relayed prompts, writes the usage governor's file | `claude-code` types, its own files |
| `packages/coupling` | `claude` runner, `agents --json` reader, the channel hub and server (`channel/`), reporter validator and mapping, SessionHost, SupervisorHost, FleetPoller | contract, the mod's `wire.ts` and `channel-wire.ts`, Node |
| `src/main` | Electron main: security baseline, app:// protocol, IPC, windows | coupling, contract, Electron |
| `src/preload` | `window.ccc` over contextBridge | Electron's renderer modules, `src/shared` |
| `src/shared` | IPC channel names and the `CccApi` type | contract types |
| `src/renderer` | The UI in React: `model/` derives card states, order and text from the contract (pure, tested); `components/` draws the top bar, sidebar, Fleet and rail; `styles/` holds UX's tokens and the layout CSS | contract types, React |

`test/boundaries.test.ts` checks the import rules.

## Renderer security (D-011 item 8)

`src/main/security.ts`, with the pure rules in `src/main/policy.ts`:

- `app.enableSandbox()`; every window has `contextIsolation`, `sandbox`, no `nodeIntegration`, no `webviewTag`.
- Pages load from `app://ccc/`, a privileged standard scheme served from `dist/renderer` with a path check and a CSP header (`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; …`; inline styles are for xterm.js, D-004). The page carries the same CSP in a meta tag.
- Every permission request and check is denied, including device permissions.
- Requests to `http`, `https`, `ws`, `wss` and `file` are canceled.
- Navigation, redirects and webview attachment are prevented. `window.open` is denied; an `https` link goes to `shell.openExternal`, and no other scheme does.
- IPC handlers answer only the top-level frame of the app's origin.

Fuses and signing come with packaging (N4).

## The mod-to-app channel (D-011 item 7, D-005)

```
session (claude --bg)                          app main process
  ccc-reporter mod  ── $.http.fetch ──►  ~/.ccc/ch/<id>/s.sock  ──►  ChannelServer ──► ChannelHub
     HMAC from digest      socketPath        0700 dir, 0600 socket      HMAC, nonce,     telemetry, pending
                                                                        ts window        prompts, relays
```

The hub writes each launch's 0600 `--settings` file with the secret and the deny rules. `claude --bg` gets `--plugin-dir` and `--settings` by path only.
