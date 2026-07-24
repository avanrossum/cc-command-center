# Concepts — the mental model

How to think about Command Center: what it is, how it labels sessions, and the vocabulary the rest of the app uses.

## The core idea

Command Center is one macOS window that hosts many Claude Code sessions at once, each in a real terminal. A typical operator runs 5 to 25 sessions across personal projects, their own business, and several clients. Without the app those are scattered terminal windows, and you lose track of which one is waiting on you, what it was waiting for, whether you already answered it, and what you set running last night. The app keeps a live picture of every session and holds that state across restarts, so a session going out of view does not mean losing track of it.

You stay in the middle of the fleet. Each session still expects a human to answer its questions, clear its permission prompts, and decide what runs next. The app does not take sessions off your hands and run them unattended; it keeps you able to supervise many sessions from one place. The internal name for this is HITM — human in the middle. You sit at a node in the mesh: you can watch every session, message any of them, spawn new ones, and route messages between them. The features exist to extend how many sessions one person can watch, not to remove the person.

Two constraints to know up front. It is beta software, macOS on Apple Silicon only, and it needs the Claude Code CLI already installed. It reads parts of Claude Code that are not a public API — the transcript format, the session registry files, hook payloads, the terminal buffer — so an upstream Claude Code release can break it, and there is no support SLA.

## The STATE taxonomy

Every session shows one state at a time. The state is fused each scan (about every 1.5 seconds) from several signals: the state derived from the transcript, the Claude Code status hook, a scan of the live terminal buffer for a permission dialog, and the parent/child graph. When signals disagree, the most urgent one wins. The states, in urgency order:

| State | Color | Order | Means |
|---|---|---|---|
| Needs approval | Amber `#f59e0b` | highest | The session is parked on a permission dialog it cannot clear itself. Read from the live terminal buffer, so it is high-signal, not a guess. |
| Working | Green `#34d399` | | The assistant is actively doing work. Nothing is waiting on you. |
| Your turn | Blue `#60a5fa` | | The assistant's last turn ended recently, so structurally the next move is yours. |
| Blocked | Pink `#e070c8` | | A parent whose blocking child is not finished yet. The row names the child it is waiting on. |
| Done | Teal `#5eead4` | | A turn that ended on a statement — the job finished and you were not watching. Awareness of completion, lower urgency than the gates above. |
| Idle | Gray `#6b7280` | lowest | Alive but nothing in motion and nothing pending. |

Two more you will see occasionally:

- **Unknown** (purple `#a78bfa`) — the app cannot read a coarse state for the session yet.
- **Dormant** — not an engine state but a session condition, covered under [managed, adopted, and external sessions](#managed-adopted-and-external-sessions) below. A dormant session displays its last known coarse state, dimmed, as a row you can resume.

**Your turn vs. asked you a direct question.** Both read as blue. The app separates a soft turn-end ("tell me what's next") from a turn that ended on a genuine question that blocks the assistant. A real question gets a badge, an "Asked you" label, and sorts just above the soft your-turn rows. The distinction currently lives in the sidebar and overview; a deeper re-tiering across the tally and notifications is on the roadmap.

**Needs approval vs. done.** Needs approval is a hard stop: the session cannot proceed until you answer. Done means it already stopped on its own, and it is telling you so. A session marks done only when its turn ended on a statement, it finished after the last time you looked at it, and you are not currently viewing it, so a session you are watching does not nag you about its own completions.

## "Needs you" and the gate ledger

"Needs you" is the set of sessions that want something from you right now: a permission to approve, a question to answer, or a parent blocked on a child. The core question the app answers is "which sessions are waiting on me, and where" — the beacon bar at the top counts the fleet by state and lists the top few things waiting on you, and clicking one jumps to that session. A docked companion board renders the whole needs-you set as cards, scoped to the current category or the whole fleet.

Every needs-you row carries a **why-line** — the substance of the ask, so you can triage without opening the session:

- **Permission** — the verbatim command that is gated.
- **Question** — the actual sentence the assistant ended on.
- **Blocked** — the name of the unfinished child the parent is waiting on.

The **gate ledger** is the app's memory of whether you handled something. It is a SQLite-backed record, reconciled every scan against the currently open gates, keyed by a stable fingerprint so a dialog that repaints on screen stays one gate rather than spawning duplicates. A gate marks itself seen when you are focused on that session and resolves after you handle it. The ledger survives a restart. A needs-you moment you have not looked at does not silently disappear, and after you quit and relaunch it is still there — dimmed and resumable. This is the "did I handle that?" question the ledger exists to answer.

## Categories

Sessions live in categories — for example personal, business, and each client. Categories are hard-separated: client work does not bleed into personal, and each category has its own color, an optional emoji, and a short rail label so a collection reads at a glance. They render as a rail you can drag to reorder.

Categories also scope notifications. Each category can override any notification class (needs permission, question, done) and otherwise inherits the global setting, so a noisy class can stay quiet for personal work and loud for clients. On launch the app restores the last category you were in and the last session you had open there.

## The parent/child hierarchy

Sessions form a tree. From an active session you can spawn a child in a folder you choose, and the edge between them is typed. The edge type determines whether the parent waits.

- **Blocking edge** (drawn solid) — a real dependency. The parent rolls back to the child and shows as blocked (pink) until the child finishes. The parent's work is not done until the child's is. A parent with an unfinished blocking child computes as blocked and names the child holding it up.
- **Tangential edge** (drawn dotted) — a decoupled side-exploration. You had an idea mid-session and want to chase it without staining the current context, and it is not blocking. The parent keeps going; the tangent runs on its own; any result comes back through a handoff note or the messaging bus rather than by blocking the parent.

The **handoff note** is an optional message passed at spawn time — enough context to start the child on its task without dragging the parent's whole transcript along. On launch, opening any member of a tree brings the rest of the family back up (bounded to six) so parents and children can message each other again.

Sessions in a tree can exchange messages over an agent-to-agent bus that the app routes, but only after you bless the link between them, and every hop is logged and interruptible with a global pause switch. Messaging is a separate topic from the hierarchy itself; the hierarchy is what the bus uses as its address book.

## Managed, adopted, and external sessions

The app watches `~/.claude/sessions` and adopts every live `claude` process into the view. It confirms each one is a genuinely live process (matching command and start time, so a recycled PID cannot impersonate a dead session) and derives a coarse state from the transcript. What the app can do with a session depends on whether the app owns its process.

- **Managed (app-owned PTY)** — a session the app spawned itself, through the New Session composer or by spawning a child. The app owns the terminal, so it can inject prompts, deliver cross-session messages, remember launch flags across a resume, run the session on a per-session API key, and show the session's context-window usage. This is the session type that participates fully in messaging and the hierarchy.

- **Adopted / external (unmanaged)** — a Claude Code session you started in some other terminal. The app detects it, shows its coarse state and why-lines, and lets you categorize or remove it, but it does not own the terminal. It cannot inject prompts into an external session or route messages to it, and the context-window readout shows unknown because that requires the app-owned status line. A "hide unmanaged sessions" toggle removes external sessions from the view so the fleet reflects only what you manage here.

- **Dormant** — an app-owned session whose process is not currently running: the state every managed session starts in after you quit and relaunch, or a session that was terminated but kept as a resume row. A dormant row shows the session's last known state, dimmed. Opening it resumes the session with `claude --resume`, rebuilding the model, effort, context, and permission-mode flags that a plain resume would otherwise drop. Its gates persist in the ledger, so a needs-you moment is still waiting for you after a restart.
