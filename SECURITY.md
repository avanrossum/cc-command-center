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
- The rules written are a fixed constant. They are never derived from the app's configured mail
  path, so no environment variable can widen what is written into your settings. Pointing the mail
  tree elsewhere (`CCC_MAIL_DIR`, for development) means sessions are prompted on every outbox
  write; it does not extend the grant to the new location.

**Hosts PTYs and can inject into them.** The app spawns and owns terminal processes, can inject
prompts into managed sessions, and lets sessions message each other through a filesystem mailbox
under `~/.claude/ccc/mail/`.

Which sessions may message each other is **default deny**. A pair can exchange messages only via a
grant you created or an existing trusted parent/child edge; no session can open a link for itself
or request one. Grants are directional and revocable, an explicit revoke overrides the trusted edge
beneath it, and permission is re-checked at the moment of delivery, so revoking stops messages
already in flight. An address a session is not permitted to reach fails identically whether that
session exists or not, so addressing cannot be used to enumerate the fleet. A grant may span
categories if you create one — the category boundary is a display and organization boundary, and
the grant is the security boundary.

Every message is recorded in the app's registry with both endpoints, its full body, its state, and
the reason it reached that state. A global pause halts all delivery and survives a restart.

**Reads terminal input to know when a session is busy typing.** A message is injected as a
bracketed paste plus a submit, so delivering into a half-written prompt would send the human's
draft along with it. To avoid that, the app counts characters as they pass through its terminal
input handler and holds delivery while the count is above zero. It keeps an **integer per
terminal** — never the content, and nothing is persisted or transmitted.

## Data the app stores at rest, in plaintext

Only API keys are encrypted. Everything below is stored unencrypted in the app's own registry
(`~/Library/Application Support/CC Command Center/registry.db`) or under `~/.claude/ccc/`, and can
contain whatever your sessions produced — including client work:

- **Cross-session message bodies**, in full, in the `message` table. Kept for a retention window you
  set in Settings (1–90 days, default 7), after which they are pruned.
- **Undelivered message payloads** as files under `~/.claude/ccc/mail/spool/`. This is deliberate:
  it is what makes a message recoverable by hand when delivery fails. Aged out on the same schedule.
- **Terminal scrollback** per session, so a pane can be repainted after a restart.
- Session names, folders, categories, the parent/child graph, and messaging grants.

This is consistent with the threat model below — a process running as you can read all of it
anyway. It is documented so the retention control is discoverable and so nobody is surprised by
what a backup of that directory contains.

## Prompt injection across the message bus

A delivered message becomes a real turn in the receiving session, so a session that can message
another can put text in front of that agent. This is the intended capability, and it is also the
main injection surface. What the app does about it:

- **Delivered messages are framed as data.** The envelope states that the message comes from another
  session, is information rather than an instruction from the user, and that the sender has no
  authority over the recipient.
- **Control sequences are stripped from delivered bodies.** Acknowledgement tokens and the
  self-exit sentinel are redacted on the way in, so a peer cannot forge a read receipt or a
  termination by planting one in text that gets forwarded.
- **The self-exit sentinel is self-scoped.** It is matched only in a session's own outbox file and
  only ends that session's own process. It is not addressable to anyone else.
- **Acknowledgements are scoped to the recipient.** A session cannot mark another session's mail as
  read by quoting an id it happened to see.
- **The directory is scoped.** A session asking who it may message is answered with its permitted
  peers only; it cannot enumerate the fleet or discover sessions in other categories.
- **Fan-out is bounded.** Per-pair and per-session rate limits, plus a fleet-wide circuit breaker
  that trips the global pause rather than silently dropping messages.

What none of this does is make a peer's message trustworthy. Treat a fleet where any session
handles untrusted input as a fleet where every session it may message handles untrusted input.

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
- Escapes from the messaging permission model: a message delivered between a pair with no grant and
  no trusted edge, a revoked pair that still delivers, a directional grant honored in the wrong
  direction, a message delivered while the global pause is on, or a delivery that leaves no record.
- Anything that lets a session widen its own reach: opening a grant for itself, enumerating sessions
  it may not message, forging a read receipt, or terminating a session other than itself.
