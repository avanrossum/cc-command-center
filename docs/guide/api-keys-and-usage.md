# API keys, metered spend, and usage

How to add an Anthropic API key, bill a specific session to it instead of your subscription, read the context and rate-limit meters, and run the optional Arbiter control agent.

Most sessions run on your Claude subscription and cost nothing per message. This page covers the parts that touch a metered API key: adding one, pointing a session at it, watching the usage readouts, and the Arbiter, which is the only feature that spends API money on its own.

---

## Add a named API key

Open Settings and go to the **Keys** tab.

1. Enter a **name** for the key (for example `Personal`, `Work`, or a client name). The name is how you pick the key later, so make it recognizable.
2. Paste the key itself (`sk-ant-…`) into the hidden field.
3. Click **Add Claude API key**.

You can add as many keys as you want. Each row in the list shows the name and a short hint (the last few characters), with a **Remove** button.

### How the key is stored

- The key is encrypted at rest with the operating system keychain (Electron `safeStorage`, backed by the macOS Keychain). It is stored as an encrypted blob in the app's registry, never as plaintext on disk.
- After you add it, the full key is never shown again and never logged. The Keys list and every other surface show only the name and the last-few-character hint.
- The key never leaves the machine in the clear.

Removing a key deletes the encrypted blob. A session already running on that key keeps working until it stops, but the key can no longer be applied to new or resumed sessions.

---

## Run a session on a key (metered billing)

By default every session runs on your Claude subscription. You can instead bill a specific session to a stored API key. This is for work you want metered separately, such as a client's usage or an unattended automated session.

You choose the key when you start a session, in two places:

- The **New Session** composer.
- The **Spawn child** modal (when you branch a child off an existing session).

Both show a **Use an API key for this session** checkbox, off by default. Tick it and pick a key from the dropdown. The session runs on that key; everything else stays on your subscription. The setting is remembered per session, so a session you resume comes back on the same key rather than silently reverting to the subscription.

Only sessions the app launches can run on a key. A session you started in another terminal and the app adopted cannot be moved onto a key.

### How the key reaches the session

The key is not placed in the session's environment. Putting `ANTHROPIC_API_KEY` in the environment would trigger a per-session approval prompt inside Claude Code and expose the key in the process listing. Instead the app uses Claude Code's `apiKeyHelper`:

- The session is spawned with a per-session **capability token** (random bytes, not the key) in its environment, plus the path to a local socket.
- An owner-only local key daemon (a Unix socket with `0600` permissions) holds the decryption. When the session needs the key, its helper sends the token, the daemon decrypts the key in memory, and returns it.
- The key is never written to a plaintext file, never in the environment, and never visible in a process listing.

### Security caveat (inherent, disclosed in the picker)

A session running on a key — and any code that session runs, including a command produced by prompt injection — can read that key, because it is a same-user process that must be able to fetch the key to make requests. This is true of any delivery method (environment variable, file, or socket), not a specific bug.

The mitigation is operational, and the key picker states it: prefer a key that has a spend limit set on the Anthropic side, and do not use a high-value key on untrusted or fully-automated (auto-mode) work. Keep such work on a spend-limited key and keep your subscription sessions separate.

---

## Usage readouts

### Per-session context window

Each session shows the percentage of the model's context window it has used. It appears as a chip on the session row, a thin bar under the row, and next to the open terminal.

- Around 65% the readout warms (amber).
- At 85% and above it shows a warning marker, because the session is near auto-compact and worth attention before it compacts.

This number comes from the session's own status-line payload, which only the app-owned status line can read. Sessions the app launched report their context percentage; sessions the app merely adopted (started elsewhere) show no value, because the app did not install their status line.

### Account-wide 5h and 7d rate limits

The top header (the beacon bar) shows two small bars for the account's rate-limit usage:

- **5h** — the rolling five-hour window.
- **7d** — the rolling seven-day window.

Each bar shows the percentage used and a live countdown to when that window resets (for example `2h13m`, or `now` once it has reset). This tells you how close the whole account is to being throttled and when the pressure lifts, so you can pace fan-out work.

These numbers are read from the status-line payloads of app-spawned sessions (the same source as the context percentage). They are reconciled across sessions rather than trusting whichever file is freshest: the app keeps the most recent window and takes the highest percentage reported in it, since usage within a window only rises until it resets. Readings older than ten minutes are discarded, because rate-limit numbers go stale quickly. If no app-spawned session has reported recently, the bars are absent rather than showing a stale figure.

---

## The Arbiter (optional metered control agent)

The Arbiter is an optional agent that writes a one-line, plain-English explanation of why each session is waiting on you — for example "wants to delete the migrations folder" — rendered inline on that session's row. It reads only; it takes no action on any session.

Unlike the rest of the app, the Arbiter spends API money. It is a direct metered Anthropic API call, billed to a key you choose, not to your subscription.

### Beta caveat — off by default

The Arbiter is optional and disabled by default. It does nothing until you turn it on in Settings and give it an API key. It is a beta feature: it has shipped but has not yet been exercised against a live API key, so its output quality and its cost arithmetic against real usage are not yet field-verified. Start it with a small daily cap and a single low-sensitivity category if you want to try it.

### Enabling it

In Settings, go to the **Arbiter** tab:

- **Enabled** — the on/off switch. It cannot be turned on until you have added at least one API key.
- **Key** — which stored key the Arbiter bills to.
- **Model** — Haiku (the default and cheapest), Sonnet (steadier triage), or Opus (best and priciest). Pricing tracks the chosen model.
- **Daily cap** — see below.

### Privacy opt-in (per category, default off)

The Arbiter sends session information to the Anthropic API to write its gloss. What it may send is controlled per category, and every category starts closed.

- For a category you have **not** cleared, the Arbiter sends only the session's state and shape. The session name is withheld and replaced with a stable anonymous handle, because a session's name usually describes the work it is doing.
- For a category you have cleared, the Arbiter also sends the session's substance and name, so it can write a specific gloss.

You clear a category in the category editor with the **Arbiter may read this category** checkbox. Client or personal content never leaves the machine unless you tick that box for its category.

### Cost cap and spend readout

The Arbiter's spend is always on screen in its console, and a daily cap keeps it bounded:

- Set a **Daily cap** in USD (the default is `$1`; `0` means no cap).
- The cap is checked before every request. When the day's spend reaches the cap, the Arbiter stops making requests. It stops rather than warning and continuing.
- Every billable call records its cost using standard model pricing, so the running total tends to over-report slightly rather than under-report.

### Pause versus disable

Two separate controls stop the Arbiter:

- **Pause** lives in the Arbiter's own console. It halts the agent while keeping the key, the cap, and the glosses already paid for. Use it to stop the agent for a while without losing its setup.
- **Disable** is the Enabled checkbox in Settings. It turns the feature off as configuration.
