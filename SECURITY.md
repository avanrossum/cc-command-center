# Security

## Reporting a vulnerability

Report privately through GitHub: open a **Security Advisory** on this repository
(Security → Advisories → Report a vulnerability). That keeps the report private until a fix is
available.

Do not open a public issue for a vulnerability.

This is a solo project with no support SLA. Reports are read, but response time is not guaranteed.

## What the app does that is security-relevant

**Stores Anthropic API keys.** Keys are encrypted at rest with Electron `safeStorage`, which is
backed by the macOS Keychain, and the encrypted blob is kept in the app's local registry. If secure
storage is unavailable, the app refuses to store the key rather than falling back to plaintext.
After entry, a key is never displayed again; the UI shows only a name and a hint of at most the last
four characters. The decryption path is main-process only and is not exposed over IPC, so a
plaintext key is never sent to the renderer.

**Runs a local key daemon.** To bill a session to a chosen key, the app starts a Unix-domain socket
under `~/.claude/ccc/`, chmod `0600` (owner only). The session is spawned with a per-session
capability token in its environment — the token, not the key — plus an `apiKeyHelper` script. When
Claude Code needs the credential, the helper sends the token to the socket and the daemon returns
the decrypted key for that token. The token is minted at spawn and revoked when that session's PTY
exits. The key is decrypted in memory at use time and is never written to disk in plaintext.

**Modifies your global `~/.claude/settings.json`.** The app writes two things into it: the status
hooks that let sessions report their state, and a `permissions.allow` rule so managed sessions can
write their outbox without a permission prompt on every message. Handling:

- The file is backed up to `settings.json.ccc-bak` before any write, and the backup is a hard
  precondition — if the backup cannot be taken, the app refuses to write.
- Malformed input is refused, not repaired: non-JSON, a non-object root, a non-object `permissions`,
  or a non-array `permissions.allow` all cause the app to leave the file untouched.
- All other keys are preserved. Writes are atomic (temp file plus rename).
- The mailbox rule is scoped to the mail trees only — `Edit(~/.claude/ccc/mail/**)` and
  `Edit(~/.claude/ccc/mail-dev/**)` — deliberately not `~/.claude/ccc/**` wholesale, because that
  tree also holds the status hook script that runs on every hook event. A session is not
  pre-authorized to edit that.

**Hosts PTYs and can inject into them.** The app spawns and owns terminal processes, can inject
prompts into managed sessions, and lets sessions message each other through a filesystem mailbox
under `~/.claude/ccc/mail/`. Cross-session delivery is trust-gated per link: an untrusted link holds
the message instead of delivering it, and every routing decision is recorded in the message log
with its outcome (delivered, held, dropped).

## Known residual risk: a session can read its own API key

State plainly: **a session running on a metered API key can obtain that key's plaintext, and so can
any code that session runs — including a shell command produced by prompt injection.** The
`apiKeyHelper` mechanism exists so the session can fetch the credential, and anything running with
that session's environment can invoke the same helper.

This is inherent to supplying a credential to a session. It is not a bug that a code change removes.
The capability token narrows *which* key a session can reach and for how long, but a session that is
authorized to use a key is by construction able to read it.

Mitigations, all of them operational rather than technical:

- Do not use high-value or broadly-scoped keys for untrusted work, or for workloads running with
  auto-approve.
- Set a per-key spend limit in the Anthropic Console.
- Rotate keys, and rotate promptly if a session handled untrusted input.

## Threat model and scope

This is a single-user desktop application. The security boundary is the user account.

**Out of scope:** same-user local attackers. A process running as your own user can already read
this application's memory, your Keychain items after unlock, your `~/.claude` directory, and your
shell history. Nothing this app does can defend against that, and reports whose premise is "a
process running as the same user can read X" will be closed as out of scope.

**In scope:**

- At-rest protection of stored API keys (encryption, refusal to store when secure storage is
  unavailable).
- Leakage of keys to places they should not reach: the renderer process, logs, crash reports,
  transcripts, or disk in plaintext.
- Safe handling of the user's global `~/.claude/settings.json` — data loss, clobbering unrelated
  keys, or widening permission rules beyond what is documented above.
- Escapes from the trust gate on the cross-session bus (a message delivered over a link that is not
  trusted, or a hop that does not appear in the message log).
