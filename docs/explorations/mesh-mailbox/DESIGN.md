# Mesh mailbox — diagnosis and design

Handoff from the `mesh-mailbox` workflow (run `wf_6be57717-cc0`). Two stacked
pieces of work: **fix the delivery bugs first**, then build the durable mailbox.

---

## Facet A — why messages are lost

Two independent defects compound. "Tangential" is a correlate, not a cause — I confirmed routing contains ZERO `edge.type` branches (`src/main/index.ts:1732-1735`, `:1822-1823`, `:1883-1888`); the only type branches in the app are category inheritance (`:701`), the blocked-parent gate ledger (`:945`), and the schema default.

**Cause 1 — silent, unbounded defer on a busy target (`src/main/index.ts:1894`).**
`if (target.state !== 'idle' && target.state !== 'waiting') { i++; continue }`. The ONLY expiry in `tryDeliveries` is `if (now - d.at > 120_000)` at `:1874`, which sits inside `if (!target || !term)` at `:1873` — structurally unreachable for a target that is found but busy. And `logMsg` is called only on delivered/dropped/expired (`:1876`, `:1890`, `:1906`, `:1914`), never on defer. So a message to a working session is invisible in three places at once: not in the outbox file, not in the Messages panel, not delivered. It is indistinguishable from "never sent."

Why this bites tangential children specifically: a tangential offshoot exists to run a long independent task, so it is `working` for most of its life and fails the gate permanently. A blocking child is the thing its parent is waiting on, so it is normally idle/waiting and passes. The user's own report — "the child was mid-task on a long job" — matches this gate exactly.

**Cause 2 — the payload is destroyed before routing is ever attempted (`src/main/index.ts:1684-1695`).**
`drainOutboxes` does `readFileSync(fp)` then `writeFileSync(fp, '')`. Routing is a *separate* call afterwards: `processMailbox` at `:1851-1853` is `drainOutboxes(); if (!awarenessPaused) routeHeld(sessions)`. From the truncate onward the only copy lives in `heldMessages` (`:1616`) and `deliveryQueue` (`:1607`), both plain in-memory structures that are never serialized anywhere in the codebase. This is exactly the blank file the user observed, and it is why the deferred message from Cause 1 was unrecoverable: quit or reload the app and it is gone with no trace, while the sender believes it sent successfully.

**Amplifier A — dead-row target lookup (`src/main/index.ts:1871`).**
`const target = sessions.find((s) => s.sessionId === d.to)` — no `.alive` guard. A resumed session yields a dead + a live row under one id; the app documents this at `:932-942` and dedups *preferring the alive row*, and guards with `!s.alive` at `:2057` and `:2088` ("a stale dead record on a recycled pid can't consume the pending entry"). `tryDeliveries` is the one site that does not. A dead row's state is `unknown` (`src/main/engine/sessions.ts:145-150`, reason `'process not alive'`), which never passes the `:1894` gate, and the 120s expiry cannot fire because `findManagedTerm` still finds the live terminal. Permanent stall.

**Amplifier B — the parent may never have learned the address.** `parentBlessNote` is queued in `pendingParentNotes` and delivered only while the PARENT is idle/waiting, hard-expiring at 10 minutes (`:3199-3219`). A parent that spawns a tangential offshoot keeps working by definition, so it is the most likely to blow that window. If it never learned the exact `@"name"` form, a quoted miss falls through at `:1748` and routes UP to its own parent (`:1821-1844`), or sits `held: no parent link` and expires at 30 min (`HELD_TTL_MS`, `:1569`, `:1781-1784`).

**Amplifier C — exit destroys mail.** `p.onExit` at `:1364-1379` does `heldMessages.delete(ob.token)` and `unlinkSync(ob.path)`. Anything written just before exit is destroyed rather than flushed.

**Amplifier D — hand-made edges are untrusted.** `edge:set` (`:2714-2718`) never calls `setEdgeTrust`, unlike the spawn path (`:2109-2112`). A tangential link created via right-click holds every message as `held: link not trusted` and expires it silently at 30 min.

Most likely single cause for the reported incident: Cause 1 held the message in memory forever with no log line, and Cause 2 had already made the payload unrecoverable.

---

## The immediate fix (ship first, independently)

Four small changes in `src/main/index.ts`, each independently shippable and none requiring the redesign or a schema migration.

**A. Persist before truncate — claim by rename, not by blanking.**
In `drainOutboxes` (`:1684-1695`), replace `writeFileSync(fp, '')` with an atomic claim:
`renameSync(fp, join(MAIL_DIR, 'spool', `${token}-${Date.now()}.msg`))`, then recreate an empty `<token>.msg`, then read the spool file. Delete the spool file only on a terminal outcome (delivered, or dropped by policy). This single change:
- makes every payload recoverable and copy-pasteable from `~/.claude/ccc/mail/spool/` by hand, today, with no UI;
- closes the read/truncate race (anything written between `:1686` and `:1692` is currently destroyed silently);
- makes the swallowed truncate failure at `:1691-1695` — which today causes silent duplicate delivery on the next 1.5s scan, with no dedupe key anywhere in the pipeline — impossible, since rename is atomic;
- needs NO permission change: `MAIL_RULES` at `:2811` is `['Edit(~/.claude/ccc/mail/**)', 'Edit(~/.claude/ccc/mail-dev/**)']`, so a `mail/spool/` subdirectory is already covered. A new sibling tree would not be, and would require re-running `grantMailPermission()` (`:2827`) on every user.
At startup, re-claim any orphan spool files into `heldMessages` before the first scan.

**B. Make the busy defer visible and bounded (`:1894`).**
Two additions at that branch:
1. Log the first defer using the same latch pattern as `held.logged` at `:1796-1799` — add a `logged` flag to `Delivery` and emit `logMsg(..., 'deferred: target busy')` once. The Messages panel then stops showing literally nothing for the most common failure.
2. Add a real deadline: past N minutes queued (suggest 30, matching `HELD_TTL_MS`), move to a terminal state `failed: target never free` and RETAIN the spool file rather than discarding. Also cap `deliveryQueue.length` — it is currently unbounded with no expiry path for this case.

**C. Alive-preferring target lookup (`:1871`).**
Replace `sessions.find((s) => s.sessionId === d.to)` with a resolve that prefers the alive row, mirroring the dedup the app already does at `:932-942` and the `!s.alive` guards at `:2057` / `:2088`. One or two lines; converts a class of permanent stalls into ordinary deliveries.

**D. Flush, don't destroy, on exit (`:1364-1379`).**
Before `unlinkSync(ob.path)`, read the outbox one final time and claim it. Replace `heldMessages.delete(ob.token)` with a move of the still-held segments into the spool directory. A dying session's last message should survive it.

**Optional, cheap, closes Amplifier D:** make `edge:set` (`:2714-2718`) apply the same `trustChildrenByDefault` rule the spawn path does (`:2109-2112`), or surface "untrusted link" in the UI so a silently-muted hand-made edge is visible.

Note on scope: A + C + D are strictly additive. B changes an invisible hang into a visible failure, which is the behavior change the user actually asked for.

---

## Facet B — the durable mesh mailbox

## Storage — mirror the gate ledger's lifecycle, but NOT its cascade

New migration `if (v < 15)` in `src/main/registry.ts` (head is v14 at `:259-270`).

**The one place the gate ledger must NOT be copied.** `gate.session_id` is `REFERENCES node(session_id) ON DELETE CASCADE` (`registry.ts:174`), which is correct there because "the transcript on disk is the real record" (`:168-170`). It is wrong for mail. `deleteNode` runs not only on explicit removal (`removeSessionsHard`, `index.ts:3492-3517`) but on **ordinary PTY exit** — `autoRemoveExitedSession` (`index.ts:1400-1412`) is called from `onExit` at `:1387` for any session the app did not deliberately kill. A cascading mailbox would silently wipe every message whenever a session exits normally, reproducing the exact defect being fixed. So `from_session_id` / `to_session_id` are plain TEXT with no FK, and archival is an explicit step.

```
CREATE TABLE message (
  id TEXT PRIMARY KEY,           -- 'm-<epochms>-<n>'; minted at PERSIST time
  from_session_id TEXT NOT NULL, -- NO FK (nodes die on ordinary exit)
  from_handle TEXT NOT NULL,     -- display name frozen at send time
  to_session_id TEXT,            -- NULL until addressing resolves
  to_addr TEXT NOT NULL,         -- the literal address the sender wrote
  body TEXT NOT NULL,            -- FULL payload, never silently truncated
  state TEXT NOT NULL,           -- queued|held|delivered|read|failed|expired|archived
  reason TEXT,                   -- human-readable why-it-is-here
  created_at INTEGER NOT NULL, routed_at INTEGER, delivered_at INTEGER,
  read_at INTEGER, terminal_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER,
  thread_id TEXT,                -- loop control in a mesh
  origin TEXT NOT NULL DEFAULT 'session'   -- session|user|app
);
CREATE INDEX message_pending ON message(to_session_id) WHERE terminal_at IS NULL;

CREATE TABLE message_grant (
  a_id TEXT NOT NULL, b_id TEXT NOT NULL,  -- stored sorted → canonical pair
  mode TEXT NOT NULL,                       -- 'both' | 'a_to_b' | 'b_to_a'
  granted_at INTEGER NOT NULL, granted_by TEXT NOT NULL,  -- 'user' | 'auto-edge'
  revoked_at INTEGER,
  PRIMARY KEY (a_id, b_id)
);
```

Identity differs deliberately from the gate ledger. `gateFp` is a stable fingerprint `sessionId|kind|key` (`registry.ts:697-703`) because a gate is a recurring *observation* that must dedupe across rescans. A message is the opposite: every send is a distinct event that must never dedupe. PK is a minted id. What IS borrowed: the lifecycle column shape (`first_seen`/`seen_at`/`resolved_at` → `created_at`/`delivered_at`/`read_at`/`terminal_at`), the single transactional reconcile function, two-axis retention, and the backward-clock-step guards at `registry.ts:801` and `:815`.

Bodies are stored in FULL. Today the pipeline truncates twice with no log line — `slice(-4000)` at `index.ts:1716` (drops the HEAD of a long message) and `slice(0, 500)` at `:1664`. "Recoverable and copy-pasteable" is the requirement; the bound is a per-message ceiling (suggest 256 KB) with an explicit `failed: message too large`, never silent truncation.

## The persist-before-truncate rule — the core defect

Non-negotiable invariant. `drainOutboxes` (`index.ts:1675-1720`) becomes:
1. `renameSync(<token>.msg → mail/spool/<token>-<n>.msg)` — atomic claim, no read/truncate race.
2. Read the spool file.
3. `INSERT INTO message (... state='queued')` — committed.
4. Only then `unlinkSync` the spool file.

Crash between 1 and 3: the spool file is on disk and re-claimed at startup. Crash between 3 and 4: the row exists; the spool file is a duplicate suppressed by token+content+mtime. There is never an instant where an in-flight message has zero on-disk copies. Today's ordering is the inverse — truncate at `:1692`, route at `:1853` — and every loss in Facet A follows mechanically from it.

## Delivery state machine

- **queued** — persisted from the outbox; addressing not yet resolved. Entry: outbox drain, user compose, app note.
- **held** — resolved but not sendable *yet*. `reason` carries the substate: `no-grant`, `target-dormant`, `target-busy`, `paused`, `grant-revoked`. Held is the honest name for what today is an invisible `continue` at `:1894`. Every held message appears in the inbox with its reason.
- **delivered** — `injectPrompt` returned; text is in the target's input. Sets `delivered_at`. This is *transport* success, not comprehension. Today's log conflates the two under one word.
- **read** — recipient acknowledged. Sets `read_at`. Only `read` proves it became a turn.
- **failed** — terminal and actionable: `unknown-address`, `target-removed`, `no-grant-denied`, `rate-capped`, `too-large`, `target never free`, `delivered, never acknowledged`.
- **expired** — aged out without reaching read.
- **archived** — an endpoint session was removed; read-only for the retention window.

Rules:
- **No transition ever discards the body.** Today five paths do (`:1782`, `:1804`, `:1876`, `:1890`, `:1906`).
- `delivered → read` is the only auto-advance. `delivered → failed` on ack timeout is what eliminates "sent, unconfirmed."
- `held → queued` re-evaluates every scan on any grant/state change.
- `failed|expired → queued` ONLY via explicit user resend, which bumps `attempts` and logs the resend as a user act.
- **Auto-timeout must copy the `liveSessionIds` guard** (`registry.ts:810`, rationale at `:726-732`): only sessions the scan could OBSERVE this tick are eligible. Without it an app restart — where every session starts dormant — mass-fails the entire inbox within one debounce. That lesson was already paid for once in the gate ledger; do not re-learn it.

## Addressing and stable handles

Today the handle is `displayName()` (`index.ts:1648-1651`): user override → **Claude's drifting auto-title** → `pid <n>`. A quoted miss silently reroutes UP to the parent (`:1748` → `:1821-1844`). Both are wrong for a mesh.

- **Stable address**: an immutable, human-typable alias minted per node at first adoption, stored as a new `node.alias TEXT UNIQUE` column — e.g. `@apidoc-7f3`. Direct precedent: `node.outbox_token` (`registry.ts:240-247`) exists for exactly this reason, "durable identity a session carries in its own context" across resume.
- **Display name** stays mutable and resolves as an alias *of* the handle. Order: exact alias → exact display name → unambiguous display-name prefix.
- **Reserved**: `@parent`, `@children`, `@user` (the last writes to the human's inbox only; never injected into any session).
- **Unknown or ambiguous address is a hard failure**, never a silent reroute. `failed: unknown-address` with the candidate list in `reason`, plus a bounce injected back into the sender's own terminal. Delete the `:1748` fall-through.
- **Removed target**: `getRemovedSet()` (`index.ts:317`) is already the deny-list. Addressing a removed session yields `failed: address no longer valid — session removed` as a bounce, satisfying the user's requirement directly.

## Permission model for arbitrary pairs

The tree gives permission for free — one edge, one `trusted` bit (`registry.ts:139`, `:336-338`). A mesh has N² pairs and cannot auto-grant.

- **Default deny.** A pair may message only with a live `message_grant` row.
- **Auto-grant only along an existing trusted edge**, preserving today's `trustChildrenByDefault` behavior (`index.ts:279`, `:2109-2112`). Everything else is a user act.
- **Two grant paths.** (a) Directly in the routing modal: pick pair, pick direction. (b) **On demand** — an ungranted send lands as `held: no-grant` and surfaces as a needs-you request: "Alpha wants to message Beta — allow / allow once / deny." Because the message is ALREADY durably stored, approving delivers the original payload; nobody retypes anything.
- **Directional** (`a_to_b` / `b_to_a` / `both`), so "Beta may report to Alpha" does not imply "Alpha may drive Beta."
- **Revocable, re-checked at delivery** (the existing precedent at `:1883-1892`), but in-flight messages go `held: grant-revoked` rather than being dropped. Reset grants on re-parent, mirroring `registry.ts:423`.
- **Persist the global pause.** `awarenessPaused` (`index.ts:1577`) is a bare in-memory boolean that silently resets to false on every restart — a kill switch that un-flips itself. Move it to `app_state`. While paused, the drain still PERSISTS (safe now that persistence precedes routing) and nothing delivers.

## Read receipts — file, not terminal

**Recommend the file**, written into the same mail tree. Three reasons grounded in this codebase:
1. Terminal output is the least reliable channel available here. `term.buffer` (`index.ts:1361`) is a differentially-repainted ANSI stream, and the v0.20.1 gate-clearing work was specifically a fight with differential repaint breaking ANSI stripping.
2. The file path is already permissioned. `MAIL_RULES` (`:2811`) pre-authorizes `Edit(~/.claude/ccc/mail/**)` in the user's global settings, and `--permission-mode auto` is made sticky across resume precisely so "a resumed child must keep it or its mailbox-write gate reappears" (`:1980-1985`). A receipt under `mail/` needs no new grant and triggers no dialog.
3. The exit sentinel already proves the file works as a control lane, and is deliberately matched on the FILE not on terminal output "so the teaching text in the preamble can't false-trigger it" (`:1573-1574`). Receipts follow the same precedent for the same reason.

Mechanism — delivery injects an envelope carrying the id:
```
[message from Alpha · id m-1738-7]
FIRST: write  ACK m-1738-7  to <outbox>. Then read the message.
<body>
```
The drain recognizes `ACK <id>`, sets `read_at`, and does not treat it as a message. **Both teaching texts must change in the same commit** — `awarenessPreamble` (`:1618-1631`) and `parentBlessNote` (`:1636-1644`) — and both currently end with "(No acknowledgement needed for this note.)", which is precisely the clause to replace. Updating one leaves half the fleet ignorant: the preamble covers app-spawned sessions, the bless note covers top-level parents that never saw one.

**Belt and braces:** a passive receipt from the hook status file. `STATUS_DIR/<id>.json` already exists (`:3509`) and the scan already fuses hook state (`:730-771`). A hook event on the target within a few seconds of `delivered_at` corroborates that the paste became a turn, and can advance `delivered → read` with `reason: 'inferred'`. Show `read (acked)` and `read (inferred)` distinctly — do not pretend they are equal evidence.

## Retention and archival on session removal

- In `removeSessionsHard` (`:3492-3517`) and `autoRemoveExitedSession` (`:1400`), add an explicit archive step: `UPDATE message SET state='archived', terminal_at=? WHERE (from_session_id=? OR to_session_id=?) AND terminal_at IS NULL`, and revoke that session's grants. No cascade.
- Archived mail stays readable and copy-pasteable in the inbox under "Removed sessions" for a user-set `ARCHIVE_RETENTION_DAYS` (default 7, matching `GATE_RETENTION_MS` at `registry.ts:690`), then the prune deletes it.
- Retention mechanics copied from `pruneLedger` (`registry.ts:824-865`): age out first, then hard count ceilings applied SEPARATELY to open (`terminal_at IS NULL`), terminal, and archived rows, plus a per-session ring cap (the `ROW_NUMBER() OVER (PARTITION BY ...)` pattern at `:857-862`) so one chatty pair cannot crowd out the fleet. Throttle to once a minute with the clock-step guard at `:815`.

## How a session queries its directory

Today no directory exists that a session is ever told about — the only session list is the human-facing SendComposer (`App.tsx:4192`). Add a query lane **on the same outbox file**: no new transport, no new permission, no MCP server.

- `?WHO` → the app injects a compact directory of peers this session MAY address: stable handle, display name, category, current coarse state, grant direction. **Scoped to permitted peers only** — a session must not enumerate the whole fleet, which would leak the hard category separation the app is built around.
- `?INBOX` → its own undelivered/unread mail with ids, which makes "go check your mailbox" a real, executable instruction.
- `?WHOIS <addr>` → validate one address before sending, including "no longer valid — removed."

Replies are injected via the existing `injectPrompt` (`:1995-2004`) and logged with `origin='app'` so the record shows the app spoke, not a peer.

## UI

**Segmentation is the requirement, not a flat log** (user, 2026-07-29, after using the
Phase 2 panel): the final view needs "better segmentation across sessions — almost
like a stack of in/outboxes per session." A flat, fleet-wide list answers "what
happened recently"; it does not answer "what is waiting on THIS session", which is
the question you actually have when you open it. Per-session grouping also makes the
hard category separation legible in the mailbox, which a flat list quietly erodes.

Shape to build toward: the inbox groups by session, each group showing that session's
IN (addressed to it) and OUT (sent by it) stacks with their own counts, collapsed by
default and ordered by what needs attention. The fleet-wide flat list stays available
as a view, not as the default. This supersedes the flat list shipped in Phase 2.

One modal, three tabs, replacing `MessageLog` (`App.tsx:4093-4153`) and re-pointed at real rows instead of the 40-entry snapshot slice (`index.ts:1051`):
- **Inbox** — every message with state, reason, both endpoints, full body, copy button, and Resend / Cancel / Grant-and-deliver.
- **Route** — pick sender, pick recipient from the directory, send. Keep `session:send` (`:3319-3329`) as the transport but LOG it: today it bypasses trust, pause, the free-target gate, the rate limit, and the log entirely. A mesh must not retain an unlogged back door.
- **Grants** — the pair matrix with revoke.
Header badge counts unread + failed, not total.

## Delivery-gate prerequisite

The bus reads the RAW transcript state: `tryDeliveries` runs at `index.ts:683`, before enrichment begins at `:713`, so it never sees the hook-fused or buffer-refined state the UI shows. A session parked on a permission dialog whose transcript tail is older than `IDLE_MS` derives as `idle` (`engine/transcript.ts:78`, 5 min), so the bus will paste into a session sitting on a modal. Move the gate to the enriched state — this is a prerequisite for trusting receipts at all.

---

## Phased plan

### 1. Phase 1 — Stop losing payloads  ✅ SHIPPED v0.21.0

**Delivers:** The reported bug stops recurring, and every message ever sent is recoverable from disk by hand. No schema change, no UI change, no protocol change — shippable as a patch release.

(A) Claim-by-rename in drainOutboxes: rename the outbox to mail/spool/<token>-<n>.msg instead of blanking it; recreate the empty outbox; delete the spool file only on a terminal outcome. Re-claim orphan spool files at startup. (B) Log the first busy-defer with the held.logged latch pattern, and add a real deadline plus a length cap on deliveryQueue. (C) Alive-preferring target lookup. (D) Flush held segments and the final outbox read to spool on PTY exit instead of deleting them. Optional: auto-trust on edge:set to match the spawn path.

**Files:** src/main/index.ts — drainOutboxes :1675-1720 (esp. the truncate at :1692), tryDeliveries :1860-1916 (target lookup :1871, busy gate :1894), onExit :1364-1379, edge:set :2714-2718. No new permission rule needed: MAIL_RULES at :2811 already covers mail/**.

### 2. Phase 2 — Durable message table + read-only inbox  ✅ SHIPPED (unreleased)

**Delivers:** "Sent, unconfirmed, and now blank" becomes structurally impossible. The user can open a panel and read/copy any message ever sent, with its real state and the reason it is in that state.

Migration v15: message table (no FK to node — see architecture) with the full state machine, plus a prune with age + count ceilings from day one so growth is bounded before the mesh arrives. Persist to SQLite between the rename and the unlink. Replace the 60-entry in-memory messageLog ring with queries. Re-point the MessageLog modal at real rows: state, reason, both endpoints, FULL body, copy button. Move the delivery gate from the raw scan state to the enriched/hook-fused state.

**Files:** src/main/registry.ts (new v15 block after :270; model the lifecycle and prune on gate/syncGates/pruneLedger at :163-196, :745-822, :824-865). src/main/index.ts :1607-1608, :1663-1666, :1051, and the scan ordering at :682-683 vs :713. src/renderer/src/App.tsx :4093-4153.

### 3. Phase 3 — Manual resend and hard-fail bounces  ✅ SHIPPED (unreleased)

**Delivers:** The user's stated workflow: a send that failed because the target was gated, offline, or unresumed can be resent from the UI without retyping. Mis-addressed messages stop disappearing.

Resend / Cancel actions on any non-delivered row (bump attempts, log as a user act). Replace the silent reroute-up on a quoted-name miss with failed: unknown-address plus a bounce injected into the sender. Addressing a session in the removedSessions deny-list yields failed: address no longer valid. Persist awarenessPaused to app_state so the kill switch survives restart.

**Files:** src/main/index.ts — matchDirectedChild :1740-1765 (esp. the :1748 fall-through), routeHeld :1821-1844, getRemovedSet :317, setAwarenessPaused :1668-1670. Renderer inbox actions.

### 4. Phase 4 — Read receipts

**Delivers:** Delivery is confirmed, not assumed. Every message shows delivered vs read, and a delivered-but-never-acknowledged message becomes a visible failure instead of a silent success.

Inject the envelope with the message id and the ACK instruction. Recognize 'ACK <id>' in the drain (file-matched, like the exit sentinel) and set read_at. Add the hook-status-file inference as a fallback, distinguishing read (acked) from read (inferred). Advance delivered -> failed on ack timeout, guarded by the liveSessionIds rule. Update awarenessPreamble AND parentBlessNote in the same commit — both currently end with "(No acknowledgement needed for this note.)".

**Files:** src/main/index.ts — awarenessPreamble :1618-1631, parentBlessNote :1636-1644, EXIT_SENTINEL/drain :1575 + :1699-1714, injectPrompt call site :1909, hook fusion :730-771, STATUS_DIR.

### 5. Phase 5 — Stable handles and the directory query

**Delivers:** Addresses stop breaking when Claude's auto-title drifts, and a session can ask who it may talk to and who is present — the user's explicit requirement.

Add node.alias (immutable, minted at adoption) as the stable address; resolution order alias -> exact display name -> unambiguous prefix. Reserved addresses @parent / @children / @user. Add the ?WHO / ?INBOX / ?WHOIS query lane on the existing outbox file, replies injected and logged as origin='app'. Scope ?WHO to permitted peers only. Teach the new forms in both teaching texts.

**Files:** src/main/registry.ts (alias column; outbox_token at :240-247 is the precedent). src/main/index.ts — displayName :1648-1651, parseDirective :1656-1661, matchDirectedChild :1725-1765, drainOutboxes. Third resolution site to keep in sync: :3184-3187.

### 6. Phase 6 — Grants and arbitrary-pair routing

**Delivers:** The actual mesh: any session may talk to any other session the user permits, with a routing modal and a grants matrix. Deliberately last, because everything before it is a safety improvement to the tree that already exists.

message_grant table with directional, revocable pairs; default deny; auto-grant only along an existing trusted edge. On-demand approval flow: an ungranted send holds as no-grant and surfaces as a needs-you request that delivers the ORIGINAL stored payload on approval. Routing modal (pick sender, pick recipient, send) with session:send re-routed through the logged, permissioned path. Thread ids, per-pair and per-session budgets, and a fleet-wide circuit breaker that trips into the persisted pause.

**Files:** src/main/registry.ts (message_grant; trust precedent at :139, :336-338, reset-on-reparent at :423). src/main/index.ts — routeHeld/tryDeliveries trust checks :1795-1802, :1823-1834, :1883-1892, rate guard :1901-1908, dead hop guard :1566 + :1814/:1842, session:send :3319-3329. src/renderer/src/App.tsx SendComposer :4176-4192.

### 7. Phase 7 — Archival on removal and retention

**Delivers:** A removed session's mailbox is archived, still readable and copy-pasteable, and eventually deleted on a user-set retention in days. Addressing a removed session is told it is no longer valid.

Explicit archive step in removeSessionsHard and autoRemoveExitedSession (NOT a cascade — nodes are deleted on ordinary exit, so an FK cascade would wipe mail on every normal quit). Revoke grants on removal. Removed-sessions section in the inbox. Retention setting in days, enforced by the existing once-a-minute prune with the clock-step guard.

**Files:** src/main/index.ts — removeSessionsHard :3492-3517, autoRemoveExitedSession :1400-1412, onExit :1387. src/main/registry.ts — prune (model on pruneLedger :824-865), deleteNode :644-646. Settings UI.

---

## Risks

- Prompt injection and authority escalation. A mesh means any permitted session can write text that lands in another session's input as a genuine turn, indistinguishable from the user typing. Today's envelope is a bare `[message from <name>]` (index.ts:1909) with no trust framing. Mitigations: the preamble must state explicitly that peer text is DATA, not instruction, and that a peer has no authority over this session; sanitize control sequences (ACK ids, `[[CCC:EXIT]]`) out of delivered bodies so a body cannot forge a receipt or a kill; keep sentinel matching on the FILE only, preserving the discipline already documented at :1573-1574; and scope `?WHO` so a session cannot map the fleet or discover peers in other categories.
- A peer must never be able to terminate another session. The exit sentinel (:1575, :1699-1714) is currently self-scoped and must stay that way. In a mesh, any control verb that becomes addressable to a third party is a privilege escalation — the sentinel, the query lane, and any future control message must all be strictly self-scoped or user-only.
- Delivery loops. The tree bounded fan-out structurally; a mesh does not. The existing hop guard is dead code — every Delivery is pushed with `hops: 1` (:1814, :1842) against `HOP_MAX = 6` (:1566), acknowledged in the comment at :1900. A mesh needs a real propagated thread_id, the existing sorted-pair budget (:1901-1902) kept, a NEW per-session global outbound budget (the pair key alone cannot stop a fan-out star), and a fleet-wide circuit breaker that trips into the persisted pause rather than dropping messages.
- Unbounded growth. Full bodies, N-squared pairs, receipts, and directory replies all add rows, and the current design has no durable store at all so this risk is new. Mitigate with the gate ledger's exact two-axis prune plus a per-session ring cap, a per-message size ceiling with an explicit `failed: too large`, and caps on pending rows. Critically: never bound by silent truncation — today's `slice(-4000)` at :1716 (which drops the HEAD of a long message) and the `splice` at :1717 both destroy data with no log entry, and those are the anti-patterns.
- Human-in-the-middle erosion — the most important risk. Every improvement here makes the fleet more capable of running itself, which is exactly what the user is wary of. Design responses: default-deny grants with every grant a user act; a pause that is persisted and visible rather than one that silently un-flips on restart (:1577); held and deferred messages VISIBLE in the inbox, since today's silent `continue` at :1894 is precisely the failure mode that makes an autonomous system untrustworthy; receipts surfaced so the user sees what actually landed; and the user's own `session:send` logged like everything else instead of bypassing trust, pause, the free gate, the rate limit and the log (:3319-3329). Consider a supervised mode where non-edge (cross-branch) messages always require per-message approval, keeping auto-delivery confined to the tree the user already blessed.
- Delivered does not mean read, and the current gate makes that worse. `injectPrompt` is a bracketed paste plus a delayed CR (:1995-2004). The bus reads the RAW transcript state — tryDeliveries runs at :683, before enrichment at :713 — so it never sees `attention` and will paste into a session parked on a permission or folder-trust modal whose transcript tail derives as `idle` (engine/transcript.ts:78, IDLE_MS 5 min). That paste can be swallowed or, worse, answer the dialog. Moving the gate to the enriched state is a prerequisite for trusting receipts at all.
- Receipts cost a turn and change agent behavior. Making ACK the mandatory first action inserts an extra round-trip into every message and may interrupt a session mid-reasoning. If receipts are too heavy the agent will skip them, and a skipped ACK that auto-fails a correctly-delivered message is worse than no receipt. The hook-inferred fallback exists to absorb this, but it should be treated as a real failure mode, not a footnote.
- Cascade misuse would silently reintroduce the bug at a larger scale. If the message table is written with `REFERENCES node(session_id) ON DELETE CASCADE` by analogy to the gate ledger (registry.ts:174), every mailbox is wiped whenever a session exits normally, because autoRemoveExitedSession calls deleteNode from onExit (:1387, :1400). This is the single most likely implementation mistake in the whole design.
- Migration discontinuity. In-flight held messages and the delivery queue are memory-only today and will be lost on the upgrade restart. Unavoidable, but the release note must say so rather than letting a user discover it as another silent loss.
- Adopted (external iTerm) sessions can never receive — the app owns no PTY (findManagedTerm, :2035-2040). In a mesh with a visible directory, a send-only peer that silently never receives recreates the hail-mary experience for a whole class of sessions unless the directory marks them explicitly.

---

## Open questions

- Retention default in days for archived mailboxes, and whether archived mail should survive a CATEGORY delete (cat:delete removes whole session sets via the same removeSessionsHard path).
- Are read receipts mandatory (a session that does not ACK gets re-nudged, and a delivered message with no ACK auto-fails) or advisory (record the receipt if it comes)? Mandatory costs a turn per message and risks false failures on a session that is simply slow.
- Does the mesh REPLACE the current @"name" parent/child addressing or extend it? Keeping "plain text goes to your parent" is friendly but becomes ambiguous once a session has many peers and no obvious default recipient.
- Default grant policy for a newly spawned child. Edges auto-trust today (trustChildrenByDefault, default ON). Should mesh grants ever auto-create for anything other than an existing trusted edge, or is every non-edge pair always an explicit user act?
- May a session REQUEST a grant ("I need to talk to Beta"), and if so does that request itself raise a needs-you notification — i.e. can an agent generate an interrupt for the human?
- Should adopted (external) sessions appear in the directory as send-only, or be hidden entirely? Showing them is honest; hiding them prevents wasted sends.
- Does the user want a per-message approval mode for cross-branch sends, and given the human-in-the-middle stance, should that be the DEFAULT rather than an option?
- Should ?WHO ever reveal peers across category boundaries? Hard category separation is a stated design principle for client work, and a directory is the most likely place to leak it.
- Maximum message size, and the behavior past it: fail outright, or spill the body to a file and deliver a pointer the recipient is told to read?
- Should a manual resend reuse the original message id (idempotent, lets a recipient dedupe) or mint a new one (reads as a distinct nudge)?
- Should the exit sentinel remain in the mailbox at all once mail is durable and auditable, or move to its own control lane so a message body can never be confused with a kill command?
- When the user resends from the UI on behalf of a session, is the message attributed to that session or to the user? This matters for the recipient's trust framing and for the audit trail.

---
