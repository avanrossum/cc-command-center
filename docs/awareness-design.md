# Awareness protocol — design (Phase 9)

Sessions become aware of, and message, each other **autonomously**, with the app as the bus. No skill / MCP / Channels install in the sessions — they use only native capabilities plus a convention taught as text. This is the layer on top of the now-complete send primitives (inject / broadcast / copy).

## The loop
1. **Express** — a session signals it wants to message another, by a convention it was *told* (not a tool it installed).
2. **Detect** — the app sees the signal (it already reads every session).
3. **Route** — the app resolves the target via the typed edge graph (parent / child / named).
4. **Gate** — a consequential message is surfaced for approval (default) before it goes.
5. **Deliver** — the app injects it into the target as a new turn, **when the target is at a good moment** (idle / waiting — the state engine already knows), via the existing send-keys inject.
6. **Guard** — a hop counter stops parent→child→parent runaway loops.

Every primitive already exists: read (transcript tail), write (inject), address book (edges), state-aware timing (the status engine), gate/guard (new, small).

## Decisions needed (product/trust calls — yours)

### A. Transport — how a session expresses send-intent
- **A1 · Transcript marker.** The session emits a line like `@parent: <message>` in its normal output; the app watches the transcript for it. *Lightest* — zero setup, but probabilistic (Claude must format it) and it shows in scrollback.
- **A2 · Filesystem mailbox.** On spawn the app sets `CC_OUTBOX` / `CC_INBOX` / `CC_PEER` env vars; the session writes a message file with its normal Write/Bash; the app watches the file. *More robust* — structured, survives scrollback, easy to parse; needs the session to be told to write there.
- **A3 · Both** — mailbox primary, marker as a fallback/interim.

### B. Autonomy — how much oversight
- **B1 · Approve-each (default recommended).** Every cross-session message surfaces in the UI for a one-click approve/deny before delivery. Safe; you stay in the loop; matches the delivered/queued/failed language.
- **B2 · Autonomous within a pair, once trusted.** After you bless a parent↔child link, messages flow without per-message approval (still logged + interruptible). Faster; more trust.
- **B3 · Autonomous but throttled** — auto-deliver but rate-limited + fully logged, with a kill switch.

### C. Scope — who can message whom
- **C1 · Tree edges only** — parent↔child (blocking) links, matching the hierarchy model.
- **C2 · Any managed session → any** — full mesh; the edge graph is just the default address book.

## DECISIONS (user, 2026-07-08) — build to these
- **Transport = A2 filesystem mailbox.** Env `CC_OUTBOX`/`CC_INBOX`/`CC_PEER` on managed launch; session writes/reads message files with native Write/Bash; app watches.
- **Autonomy = B2 autonomous within a trusted pair.** You **bless a link once**; thereafter messages flow **without per-message approval** — but every hop is **logged and interruptible**, with a global kill switch. (Not approve-each.)
- **Scope = C1 tree edges by DEFAULT, C2 overridable.** Route parent↔child by default, but the user can add explicit any→any links ("be disorganized") — trust is per-link regardless.

Implication: the safety model is **trust-gate (bless the link) + full log + loop guard + kill switch**, not per-message approval. The message log / transparency surface is therefore *mandatory*, not optional.

## Recommendation (superseded by the decisions above; kept for context)
Start minimal and safe: **A2 (mailbox) + B1 (approve-each) + C1 (tree edges)** as slice 1 — a child writes to its outbox, the app routes to the parent, surfaces it for approval, and delivers when the parent is idle/waiting. Prove the loop end-to-end with a human gate, then relax autonomy (B2) and widen scope (C2) once trusted. This is also the exact substrate the **control agent** (roadmap Future direction) would later drive — build it as tools the app exposes, so an agent can only do what a user could, all logged.

## Slice 1 (once decisions are made)
- Managed launch sets the mailbox env + injects a one-line preamble teaching the convention.
- A watcher on the outbox file(s) → parse → resolve target via edges → enqueue.
- An **inbox/approvals surface** in the UI (pending messages: from → to, preview, approve / deny / edit).
- On approve, deliver via the existing inject when the target hits idle/waiting; log every hop; enforce the hop-count guard.
- A visible **message log** (transparency — the same requirement as the control agent).
