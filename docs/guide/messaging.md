# Agent-to-agent messaging

How a parent and child Claude Code session send each other messages through the command center, with no skill, MCP server, or Channels dependency installed in either session.

## What it is

Two sessions the app manages can talk to each other. A child can send its parent an update or a question; a parent can send a named child an instruction. The command center is the transport in the middle: it already reads every session (transcript tail) and can type into any managed session (send-keys), and the typed edge graph is the address book. The sessions themselves use only their normal tools — writing a file, receiving input — plus a short convention delivered to them as text.

Nothing is installed inside a session. There is no plugin, no MCP server, no channel process. A session learns the whole protocol from one block of text handed to it at spawn.

This is Phase 9 in the roadmap. It is beta, macOS-only, and coupled to Claude Code internals (transcript format, terminal rendering, permission-dialog behavior), so an upstream Claude Code release can break it.

## What it requires: a managed PTY

Messaging works only for sessions the app owns the PTY for — sessions started through the New Session composer, spawned as children, or launched by the app and resumed under it. Those sessions get an outbox and can be typed into.

A session running in a raw iTerm window that the app merely adopted is read-only for the bus. It has no outbox to write to and the app cannot inject a message into a terminal it does not own. An adopted session stays read-only until you resume it under management. The message log records a delivery to an unreachable target as `expired: target not open` rather than pretending it landed.

## The mailbox bus

Every app-spawned session is given one file, its outbox, through the `CC_OUTBOX` environment variable. The path looks like `~/.claude/ccc/mail/<token>.msg` (packaged) or `~/.claude/ccc/mail-dev/<token>.msg` (dev). The session writes a message by writing that file with its ordinary Write or Bash tools. It never needs to know how routing works — only that writing to this one path sends a message.

On each scan (~1.5s) the app drains every outbox:

1. Read the file. If it has content, empty it (the session writes fresh each time).
2. The content is copied into an in-memory held buffer. It is not dropped on read. A message for a link that is not yet deliverable waits in memory instead of vanishing.
3. Route each held message to a target via the edge graph, then deliver it when the target is free.

Because the file is read-then-emptied and the content is held in memory, a message survives the states where it cannot be delivered yet (the link is not trusted, the target session has not been adopted, routing is paused). It flushes when the condition clears.

## How a session learns to use it

At spawn the app injects a one-time preamble as the session's first context. There is no skill behind it; it is plain instruction text:

- Write to your outbox file to message a linked session.
- Plain text goes to your parent.
- A message starting with `@"<name>"` (the child's name in double quotes) goes to that child.
- To end your own session, write exactly `[[CCC:EXIT]]` to the outbox.
- A message is delivered when the recipient is free; only message on a genuine need.

A top-level parent that was never spawned by the app — so never saw a preamble — is taught the same thing the first time one of its child links is trusted, through a bless note the app injects (see below).

## Addressing

- **Plain text → parent.** A message with no `@` prefix routes up to the session's parent in the edge graph.
- **`@"Child Name" text` → that child.** The quoted name is matched against the sender's children by display name (your override, else Claude's title, else `pid <n>`). Quotes let names with spaces route correctly. A bare `@name` also works for single-token names via longest-prefix match with a word-boundary check, so `@apidoc` cannot accidentally match a child named `a`.
- A directed message whose quoted name matches no child is not guessed at. A bare directive that matches no child falls through and routes up to the parent, so an `@scoped/package` reference in prose still reaches someone rather than being lost.
- **`[[CCC:EXIT]]` → self-termination.** A session cannot end its own process by conversation; asking a child to "exit" only makes it idle. Writing the exact exit sentinel to the outbox gives it a lever: the app sees it on drain and kills that session's PTY. The match is exact so it is always deliberate, and it is detected in the outbox file, not in terminal output, so the teaching text in the preamble cannot trigger it.

## State-aware delivery

A routed message is not typed into the target the moment it arrives. Injecting text mid-generation would corrupt the target's in-flight input. The app holds every message and delivers it only when the target is affirmatively free — its coarse state is `idle` or `waiting`. Any other state (working, needs-approval, blocked, or an unknown state) defers delivery to a later scan. Unknown is treated as not-free, so the rule fails safe.

One message is delivered per target per scan, so two distinct messages land as two distinct turns rather than being merged into one pasted block. When delivered, a message is typed in as a fresh turn:

```
[message from <sender name>]
<the message text>
```

A message whose target session is not open expires after two minutes and is logged as expired. A message that never becomes routable at all expires after 30 minutes.

## The approve-before-send gate

Routing is gated on link trust. A message only moves across an edge the operator has blessed. Trust is a property of the parent→child edge.

- By default, a child spawned from the composer is trusted automatically on adoption (the "trust children by default" setting, on by default), and the parent is sent a bless note teaching it how to message that child down the newly trusted link.
- With that setting off, messages on an unblessed link are held — logged as `held: link not trusted` — until you trust the link. Nothing is lost while it waits.
- Trust is re-checked at delivery time, not only at routing time. Untrusting a link, or re-parenting a session, drops any in-flight message on that link rather than letting a stale queued message land after you revoked trust.

There is also a **global pause** — one switch that freezes all routing and delivery fleet-wide. While paused, outboxes are still drained into the held buffer so nothing is lost; nothing is routed or delivered until you resume. Use it to stop all autonomous messaging at once.

## The message log

A header badge opens a log of every hop the bus handled: from, to, the message text, and a status. Statuses you will see include `delivered`, `held: link not trusted`, `held: no parent link`, `dropped: link no longer trusted`, `dropped: loop/rate guard`, `dropped: empty directed message`, `expired: target not open`, `expired: never routable`, and `terminated: self-exit`. Every autonomous hop is visible and auditable; the log keeps the most recent entries.

## Why keep both parent and child in auto mode

Sending a message means the session writes its outbox file, and writing a file is a tool call Claude Code normally stops to ask you about. If a session pauses on a permission dialog every time it wants to message, the exchange is not autonomous — you are clearing a dialog on every hop.

Auto mode is the fix. The composer's auto-mode checkbox launches a child with `--permission-mode auto`, which is sticky across resume, so the child self-approves routine gates — the outbox write among them — and never stops to ask. Keep the parent in auto mode as well, because the parent writes to its own outbox to message the child, and that write is gated on the parent's side. With both ends in auto mode, each side self-approves its own outbox write and a full parent → child → parent exchange flows with no human clearing a dialog on either end.

The app also pre-authorizes edits to the mail directory in your global Claude Code settings (`Edit(~/.claude/ccc/mail/**)`), which removes the prompt for editing an existing outbox. Auto mode is the more complete cover, because the very first write to a fresh outbox is a file create, and it is sticky across resume — a resumed child that lost auto mode would stall on its next outbox write. The child spawn deliberately keeps auto mode sticky for exactly this reason.

## The loop guard

Autonomous back-and-forth needs a bound so a ping-pong cannot storm.

- **Per-link rate cap.** A link (a parent↔child pair) allows at most 6 delivered messages per 60-second window. Both directions share one budget, so a bidirectional exchange is capped at 6 per window total, not 6 each way. A message over the cap is dropped and logged as `dropped: loop/rate guard`.
- **Hop cap.** A hard hop ceiling (`HOP_MAX`, 6) backstops a runaway chain. In the current mailbox model the rate cap is the effective guard; the hop cap remains as a ceiling.
- **Write flood bound.** A single session's held buffer keeps at most the last 30 messages, so a session writing its outbox in a tight loop cannot grow memory without bound.
- **Time-to-live.** Undeliverable messages expire (2 minutes if the target is not open, 30 minutes if never routable) rather than accumulating forever.

## Caveats

- macOS on Apple Silicon only; beta, solo project, no support SLA.
- Coupled to Claude Code internals. Delivery uses send-keys (a bracketed-paste envelope plus a carriage return) because in-session Channels injection is blocked in this environment. A change to how the Claude TUI accepts pasted input, to the transcript format, or to permission-dialog behavior can break the bus after an upstream release.
- Managed-PTY only. Adopted external sessions are read-only for the bus until resumed under management, and that limitation is surfaced in the log.
- Not an official Anthropic product; independent and not affiliated with or endorsed by Anthropic.
