# Managing sessions — open, launch, spawn, resume, remove

How to open an existing session, launch a new one, spawn children, resume a dormant session, and retire a session or its whole subtree.

This guide covers the lifecycle of a session inside the app: getting one into the window, configuring how it runs, and taking it back out. Where a setting has a caveat or a non-obvious behavior, it is stated here.

## Two kinds of session: managed and adopted

The app tracks two kinds of session, and the difference decides what you can do with each.

- **Managed** — the app launched the `claude` process itself, under a terminal (PTY) it owns. A managed session can receive injected prompts, take part in cross-session messaging, and carry remembered launch flags.
- **Adopted** — a `claude` session you started in some other terminal (iTerm, Terminal, a bare shell). The app finds it by scanning `~/.claude/sessions` about every 1.5 seconds and confirming the PID is a genuinely live `claude` process. An adopted session shows its live state in the sidebar and can be categorized, named, made a child, or removed, but it is read-only until you open it.

Opening an adopted session does not take over its existing terminal. The app runs its own `claude --resume` copy of the conversation. If the original is still running elsewhere, you now have a second copy, and the terminal header says so ("resumed copy — original still running elsewhere").

## Opening and attaching a session

Click a session row in the sidebar to open it in the main terminal pane.

- For a **managed session that is still live**, opening re-attaches to the terminal the app already owns.
- For an **adopted or dormant session**, opening runs `claude --resume <id>`. If that session has no remembered launch flags, the resume-parameters modal appears first so its model, effort, context, and permission mode are set before it resumes (see [Launch flags that survive a resume](#launch-flags-that-survive-a-resume)). Cancelling the modal aborts the open and leaves nothing behind.

A resumed session paints its last roughly 1000 lines of scrollback into the pane immediately, so you see the prior conversation instead of a blank terminal while `claude --resume` starts up.

## The New Session composer

The **New session** button (in the sidebar) opens a two-column composer that launches a managed session and adopts it in one step. It spawns a real `claude` process under an app-owned terminal and applies the category, name, and initial instructions once the next scan adopts it.

The composer remembers your last model, effort, context, permission mode, and the "always use these flags" choice, and pre-fills them the next time you open it.

### Fields

| Field | What it does |
| --- | --- |
| **Name** | Optional label for the session (for example `schema-fix`). |
| **Category** | Which category the session belongs to, or Uncategorized. |
| **Folder** | The working directory. Use **Choose…** for a folder picker, or click an entry in the **Recent** list to reuse it. Required — **Create session** stays disabled until a folder is set. |
| **Model** | Default, Opus, Sonnet, Haiku, Fable, or **Custom…**. Custom reveals a text field for a model id (for example `claude-opus-4-8`). |
| **Effort** | Reasoning effort — see below. |
| **Context** | Default or 1M — see below. |
| **Mode** | Permission mode at launch — see below. |
| **Flags** | Optional free-text CLI arguments (for example `--add-dir ../shared`). Appended after the structured arguments, so anything you type here wins. Never remembered across a resume. |
| **Always use these flags on resume** | Stores the launch parameters so a later resume applies them silently instead of asking. |
| **Use an API key for this session** | Runs the session on a named Anthropic API key (metered billing) instead of your subscription. |
| **Initial instructions** | Optional first message, delivered once the session is adopted and its input is up. |

### Model and effort (including ultracode)

Effort runs from **low** through **max**, plus **ultracode**. Ultracode is not a sixth level of the same kind: the CLI maps it to `xhigh` effort and injects a standing instruction to orchestrate work with the Workflow tool, so it depends on workflows being available in that session.

Ultracode only applies to a model that supports `xhigh`. The option is hidden for a model that does not (Haiku), because the CLI would accept `--effort ultracode` and silently ignore it. Default and Custom stay permissive, since neither resolves to a concrete model in the composer. If ultracode is selected and you then switch to a model that cannot do it, it downgrades to `xhigh` rather than launching a flag that does nothing.

### 1M context

The **Context** picker's **1M** choice appends the `[1m]` suffix to the model string, which is how the CLI opts a session into the 1M-token window. It is enabled only for models that have a 1M variant — not Default (there is no model string to suffix) and not Haiku. For a Custom model, it enables once you have typed a model id.

### Permission Mode

The **Mode** picker sets `--permission-mode` at launch:

| Mode | Behavior |
| --- | --- |
| **Default** | Emits no flag; the CLI uses `permissions.defaultMode` from your Claude settings. |
| **Plan** | Works out an approach before touching anything. |
| **Accept edits** | Auto-accepts file edits. |
| **Auto** | Lets the session's classifier approve routine gates on its own. |
| **Don't ask** | Suppresses the usual prompts. |
| **Manual (ask every time)** | Forces ask-every-time, overriding your settings default. |
| **Bypass all (danger)** | Turns off permission checks for this launch. |

Bypass all is never remembered as a sticky flag. Left selected, it would silently relaunch later sessions with all permission checks off, so the app drops it from the stored parameters.

### Per-session API key

Ticking **Use an API key for this session** runs it on a named key you added under Settings → Keys, billed to that key instead of your subscription. The key is fetched at runtime from a local owner-only key daemon and re-applied on resume; it never enters the session's environment as plaintext.

A session running on a key can read that key, and so can anything the session runs. Prefer a key with a spend limit, and avoid putting a high-value key on untrusted or fully automated work.

## Spawning a child

From an active session you can spawn a child session with a typed relationship to its parent.

- Right-click a session and choose **Spawn blocking child…** or **Spawn tangential offshoot…**.
- With text selected in a terminal, press **Cmd+K** to instant-spawn a tangential child seeded with the selection, or right-click the selection to open the composer (it defaults to tangential; toggle it there).

### Blocking vs tangential

- **Blocking child** — the parent rolls back to it and shows the **blocked** state (naming the child) until the child finishes. Use this for a subtask the parent genuinely waits on.
- **Tangential offshoot** — spun off with context but does not block the parent. Use this for independent work that shares background.

### The spawn composer

- **Name** — optional, and how you address the child over the messaging bus (`@"Child Name"`). It stays fixed once set. A name already used by a sibling is rejected, because it would make @-addressing ambiguous.
- **Folder** — defaults to the parent's working directory; change it with **Change…**.
- **Handoff note** — optional, delivered as the child's first message. Use it to hand over the gap to fill, context, and links. The child also receives a short preamble teaching it the mailbox path before the note.
- **Start in auto mode** — launches the child with `--permission-mode auto`.

### Auto mode

Auto mode lets the child approve routine permission gates on its own, the mailbox write in particular, so parent/child messaging flows without you clearing a dialog on every write. It is sticky for children — a resumed child keeps `--permission-mode auto`, otherwise its mailbox-write gate reappears and the coordination stalls.

For a smooth back-and-forth, keep **both** sessions in auto mode. Each session's first mailbox write crosses a permission gate, and a parent that is not in auto also pauses for approval before acting on a child's reply. Pre-authorizing the mailbox in Settings removes the write gate entirely.

## Resuming a dormant session

A session that was running and is no longer live shows a **resume** tag in the sidebar. Opening it runs `claude --resume`.

Because `claude --resume` starts a session at the CLI defaults regardless of how it was first launched, a dormant session with no remembered flags shows the resume-parameters modal first, so its model, effort, context, and mode are set before it comes back. Cancelling aborts the resume.

**On app start,** restore-on-launch reopens the last-active session and its task tree (bounded to six members), so parents can message their children again. A dormant tree member that needs its launch parameters is not resumed automatically. It is selected and offered a **Resume…** button instead, so the parameters modal appears at a moment you chose rather than popping on launch.

**If the transcript is gone,** a missing or pruned conversation cannot be resumed. A recovery card appears with two choices: **Start fresh here**, which launches a new session in the same folder and removes the old one, or **Remove from list**, which drops it.

## Launch flags that survive a resume

`claude --resume` does not carry forward the model, effort, context, or permission mode a session was created with. The app stores those four fields per session and rebuilds them into the command line after `--resume`, so a session reopens with the settings it was running rather than reverting to CLI defaults.

Only these four structured fields are stored — never the free-text **Flags** string. Replaying arbitrary flags could re-inject arguments like `-p` or `--continue` that collide with `--resume`, so the freeform string is dropped on resume. Bypass permission mode is also never stored.

There are three ways these flags get set:

- **The "always use these flags on resume" checkbox** (in the New Session composer and the resume modal). When ticked, a later resume applies the stored flags silently. When unticked, the resume-parameters modal appears each time you resume a dormant copy.
- **The resume-parameters modal** ("Set the starting parameters for this session"), shown before a session with no sticky flags resumes. It has the same model, effort, context, and mode pickers, pre-filled from what the session remembers or your last-used choices, plus an optional "Remember these settings when resuming in the future" checkbox. Confirm resumes; Cancel aborts the open.
- **Right-click → Launch settings…**, which opens the same modal in edit mode to change or clear the remembered flags later. Edit mode saves and closes without resuming or attaching, and has no checkbox — choosing it already means "save these." This is the only way to change sticky flags once set, so ticking "always" with the wrong model is not a one-way door. To clear them, set the fields back to Default and save.

## Removing or terminating a session or subtree

Right-click a session and choose **Remove from list**. For a live managed session the item reads **Remove from list (ends terminal)**; for a dormant one there is no terminal to end.

If the session has children or is a live managed session, a confirmation names what goes with it — for example "Remove 'X' and its 2 descendant sessions? Their terminals will be ended." Removal takes the whole subtree in one action.

Removing a session kills its managed terminal (no hanging PTYs), purges its dead session files, deletes its registry node (edges, gates, and event log cascade with it), drops its hook-status file, and deny-lists its id so a ghost row cannot re-adopt it on the next scan. If the session you were viewing was one of those removed, its terminal closes.

Two related behaviors:

- **A session that exits on its own** (a crash, or a normal end) is auto-removed without deny-listing, so a later `claude --resume` can re-adopt it. A transient crash is not a one-way door; only an explicit removal deny-lists.
- **Deleting a category** hard-removes its sessions the same way. The delete confirmation warns how many sessions it terminates and suggests moving any you want to keep to another category first.

---

Sessions depend on parts of Claude Code that are not a public API (the session registry files, transcript format, status hook, and terminal rendering). The app is in beta and macOS-on-Apple-Silicon only, and an upstream Claude Code release can change these signals, so behavior here can lag or need a catch-up after a CLI update.
