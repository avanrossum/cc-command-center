# Digests — writing a feed the command center can read

The Digests panel is a **consumer**. It surfaces items and records your verdict on
them. It does not fetch anything, schedule anything, or know what any of your signals
mean. Something else decides what deserves your attention and writes it to disk; this
reads that directory.

The app ships no producers. That is the honest cost of the design: the panel is empty
until you write something to fill it. What you get in exchange is that a producer you
write in an afternoon, in any language, appears in the panel with no change to the app
— including one written long after this was.

---

## The split

| Concern | Lives in | Runs |
|---|---|---|
| **Noticing** — watch something, decide what matters | a producer | unattended, on a schedule |
| **Transport** — durable, ordered, resumable | the filesystem | always |
| **Surfacing** — show a human, take their verdict | the Digests panel | when you're looking |

```
producers                      transport                        consumer
─────────                      ─────────                        ────────
your watcher  ─┐                                            ┌─▶ Digests panel
another one   ─┼── write ──▶  ~/.claude/ccc/feeds/<src>/ ───┼─▶ a statusline
a third       ─┘                <item-id>.json              └─▶ a shell script
```

Neither side imports the other. A producer's only output is JSON files in a directory;
the consumer's only input is that directory. That is the whole interface.

Consequences worth naming, because they are the reason for the shape:

- A new producer appears in the panel with **no app change** — it lists `feeds/` and
  finds a new directory.
- Producers run whether or not the app is open. Items queue up.
- Testing a producer needs no UI. Testing the panel needs no producer.

### Two trees, one of them public

```
~/.claude/ccc/feeds/<source>/     PUBLIC. The app reads this, and only this.
~/.claude/digests/<source>/       PRIVATE. Your config, dedup state, spend ledger, logs.
```

The app never reads the private tree, and neither should any other consumer. It sits
adjacent to credentials and holds state that is explicitly not stable.

---

## The item

One JSON file per item, in `~/.claude/ccc/feeds/<source>/`. The filename is yours; only
the contents matter.

```jsonc
{
  "schema":      "ccc.feed.item/v1",              // pin this exactly
  "source":      "security",                       // matches the directory name
  "id":          "security:repo:acme/api:aws-key", // stable, content-derived
  "created_at":  "2026-07-29T18:04:11+00:00",      // first emission; never changes
  "updated_at":  "2026-07-29T19:22:03+00:00",
  "occurred_at": "2026-07-23T14:31:02+00:00",      // when the THING happened
  "state":       "unread",
  "title":       "One line. The claim, not a teaser.",
  "summary":     "One sentence of why this surfaced.",
  "body_md":     "Markdown. May be long. May be empty.",
  "score":       8,                                 // 0-10, or null
  "severity":    null,                              // info|low|medium|high|critical, or null
  "tags":        ["secret-leak", "aws"],
  "actions":     [{ "label": "Open file", "kind": "open_path", "value": "/abs/path" }],
  "meta":        { }                                // yours; the app won't branch on it
}
```

`schema`, `source`, `id`, the three timestamps, `state` and `title` are required.
Everything else may be absent, and the panel renders a sparse item fine.

### `score` or `severity`, never both

`score` answers *how interesting* (0–10). `severity` answers *how bad* (an enum). Set
one and leave the other `null`. The panel renders a number for the first and a coloured
chip for the second. Setting both makes the sort order ambiguous — the app resolves it
in favour of `severity` and drops the score, which is probably not what you meant.

### Write files atomically

Write to a temp name and rename into place. The panel may read at any moment, and a
half-written file is one it has to skip. `.tmp` files are ignored.

---

## The four rules that fail quietly

Each of these produces a feed that looks fine item by item and is wrong as a whole.

**1. Derive the `id` from the thing, never from the time.**

```
security:repo:acme/api:aws-key:config/settings.py     ✅ stable
security:scan-1785301226                              ❌ new item every run
```

Re-emitting the same id is an **update**. A timestamped id makes a fresh item on every
run, so the feed becomes an append-only log of one condition, you dismiss a copy, and
another arrives fifteen minutes later. The test: *would you want to see this twice?*

**2. Preserve the state the consumer set.**

`unread` is written once, by you, on first emission. Every other state belongs to the
panel. Before writing an existing id, read the current file and keep its `state` and
its original `created_at`. A producer that overwrites `state` resurrects everything you
dismissed, on every run, forever — and no single item looks wrong.

**3. `occurred_at` is when the thing happened, not when you noticed.**

The panel sorts on it. A source backfilling a week emits items whose `occurred_at` is
days older than `created_at`; sorting on the wrong one collapses the whole backfill into
a single moment.

**4. Emit few items.**

The scarce resource is your attention, not disk. A source that flags everything trains
you to ignore the panel, which breaks every other source too. Prefer a threshold you can
raise with one number.

---

## What the panel does with it

- **Discovers** sources by listing `feeds/`. No source names are hardcoded. An empty
  source directory is healthy and means "nothing to surface".
- **Ignores** items whose `schema` it doesn't recognise, rather than guessing at them.
- **Sorts** on `occurred_at`, newest first.
- **Marks read** when you open an item — knowing what you've already seen is the point.
- **Hides** `dismissed` and `actioned`. `kept` stays visible as a working set.
- **Writes** exactly one thing back into your feed: `state` and `updated_at`, atomically.
  Nothing else in the file is touched, and nothing outside `feeds/` is ever written.

### Actions are hints, not commands

`actions[]` entries are rendered as buttons. The app supports `open_path`, which reveals
the path in Finder. Any other `kind` is displayed greyed out and does nothing.

**Nothing from a feed item is ever executed.** These files are written by unattended
jobs; treating a value in one as a command would make every producer a shell. If you
want an action the app doesn't support, the honest move is to add the kind to the app,
not to smuggle a command through a field.

---

## A minimal producer

No library is required. Any language that can write JSON will do.

```python
import json, os, hashlib
from datetime import datetime, timezone

SOURCE = "stalled"
FEED = os.path.expanduser(f"~/.claude/ccc/feeds/{SOURCE}")
os.makedirs(FEED, exist_ok=True)

def emit(local_id, **fields):
    item_id = f"{SOURCE}:{local_id}"
    path = os.path.join(FEED, hashlib.sha1(item_id.encode()).hexdigest()[:16] + ".json")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # Rule 2: keep what the human already said about this item.
    prior = {}
    if os.path.exists(path):
        try:
            prior = json.load(open(path))
        except Exception:
            prior = {}

    item = {
        "schema": "ccc.feed.item/v1",
        "source": SOURCE,
        "id": item_id,
        "created_at": prior.get("created_at", now),
        "updated_at": now,
        "state": prior.get("state", "unread"),
        "score": None, "severity": None, "summary": "", "body_md": "",
        "tags": [], "actions": [], "meta": {},
        **fields,
    }
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(item, fh, indent=2)
    os.replace(tmp, path)          # atomic

emit(
    "repo:acme/billing-api",
    title="billing-api has been mid-refactor for 9 days",
    summary="14 uncommitted files on refactor/invoice-splitting, no activity since the 20th.",
    body_md="The branch is 31 commits behind main, so the longer it sits the more the merge costs.",
    score=7,
    tags=["stalled", "uncommitted"],
    occurred_at="2026-07-20T09:12:00+00:00",
)
```

Run it from `cron`, a LaunchAgent, or by hand. The panel picks up the change within a
moment — it watches the feed tree and refreshes on write.

### Design notes for producers

- **Cost nothing in a live session.** Read artifacts already on disk, out of band, on a
  schedule. No hooks, no instruction injected into someone's turn.
- **Filter cheaply before you filter expensively.** If a model decides what's
  interesting, use deterministic rules first to cut what it never needs to see. The
  cheap filter is the cost control; the model is not.
- **If a model decides, constrain what it returns.** An enum, an integer, one line.
  A screening model asked for prose will write plausible prose about nothing.
- **Fail closed on spend.** An unattended job on a live API key needs a hard cap checked
  before each call.
- **Survive a bad record.** A daemon that dies on one malformed input stops surfacing
  everything.
- **Be idempotent.** Re-running should produce the same feed. That is what makes running
  every fifteen minutes cost nothing.

---

## Adding a feed from somewhere else

Sources under `~/.claude/ccc/feeds/` are found automatically. **Add a feed…** at the
bottom of the panel registers a directory anywhere else — useful for a producer that
writes into its own project. The folder is validated by reading it, so a wrong path is
refused immediately instead of sitting in the panel looking empty.
