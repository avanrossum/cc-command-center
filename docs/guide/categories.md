# Categories — organizing the fleet

How to group your sessions into hard-separated collections, give each one an identity, and control what it shows and notifies.

A category is a collection that holds sessions. You put personal projects in one, your own business in another, and each client in its own. Client work never appears alongside personal work. The category rail runs down the left side of the window; clicking a category selects it and shows its sessions in the pane below.

Categories separate the session lists, not the whole app. The fleet-wide surfaces — the beacon bar at the top and the needs-you companion board — still count and show sessions across every category, so scoping your view to one client never hides a permission gate waiting in another.

## The Uncategorized bucket

There is always an "Uncategorized" section at the end of the rail. A session that hasn't been assigned lives there. It behaves like any other category for viewing, but it is not a real category row: it can't be recolored, renamed, given an emoji, or given notification overrides, and it always follows the global notification settings. It is not draggable.

## A category's identity: color, emoji, and short label

Each real category has three visual parts. Set them in the category editor: right-click a category's rail cell to open it.

- **Color** — pick from a fixed nine-hue palette. The palette is spread so two categories never read as the same color, and none of the hues is a status color (amber, green, pink, and so on), so a category color can't be confused with a session's state. The color shows as the rail cell's accent and tags any card that belongs to this category on a fleet-wide board.
- **Emoji** — optional. Pick one from the grid in the editor, or type/paste your own (only the first emoji is kept). It shows in the rail cell and as a provenance tag when this category's sessions appear on a cross-category surface. Choose the "no emoji" option (⊘) to clear it.
- **Short label** — the word shown in the narrow rail cell. It is capped at eight characters. If you leave it blank it defaults to the first word of the category name. Set a custom short word for a name that doesn't truncate well.

For a category that already exists, each field saves the instant you change it — picking a color or emoji takes effect immediately, with no separate save step. A brand-new category is written when you click Create.

## Creating a category

Two ways:

- Click the **+** button at the end of the category rail.
- Right-click a session and choose **+ New category…**.

Either opens the editor in create mode. A name is required; color, emoji, and label are optional and can be set later.

## Reordering the rail

Drag a category cell to a new slot to change its position in the rail. The rail reorders as you drop, and the order persists across restarts. Uncategorized is not draggable and is not a valid drop target, so it stays at the end.

## Assigning a session to a category

- **At launch** — the New Session composer has a Category dropdown, so a session starts in the right collection instead of being sorted afterward.
- **Later** — right-click a session, and under "Move … to" pick a category or Uncategorized. A checkmark shows the current one.
- **Automatically, by folder** — when a brand-new session starts, if another session in the same working directory is already categorized, the new one inherits that category. This happens only at creation, so a later manual move is never overridden.

One exception: a **blocking child** takes its category from its parent and can't be moved on its own. Its right-click menu shows "Category follows its parent (blocking child)" instead of the move list. Change the parent's category to move the child. A tangential offshoot has no such tie and can be assigned freely.

## Per-category notification overrides

macOS notifications have three classes, matching the global settings in Settings → Notifications:

- **Needs permission** — a session is stopped on a permission gate.
- **Your turn** — a session ended its turn and is waiting on you.
- **Finished** — an unattended session completed a task.

Each class is a global on/off switch. In the category editor, every class also has a per-category override with three positions:

- **auto** — inherit the global setting for that class. This is the default, so a new category needs no configuration to behave sensibly.
- **on** — always notify for this class in this category, even if the global switch is off.
- **off** — never notify for this class in this category, even if the global switch is on.

The typical use is keeping noisy classes quiet where you don't want them (personal) and loud where you do (clients). Overrides save live as you set them. They only matter when macOS notifications are enabled globally; with notifications off entirely, nothing fires regardless of the overrides.

## Hiding sessions you don't manage here

Settings → General has an **"Only show sessions managed here"** toggle. It is a single global setting, not a per-category one, but it changes what appears in every category's list.

With it on, live Claude Code sessions running in other terminals that this app doesn't manage are hidden, so external work stops adding rows and inflating the needs-you count. Sessions the app owns, and dormant sessions you can resume, always stay visible. With it off (the default), adopted external sessions appear alongside your own.

## Switching to an empty category

When you select a category with no running session, the pane shows a message scoped to that category rather than a generic prompt:

- If the category holds sessions but they are all dormant: "No running sessions in {name}," with a note to resume one from the list or start a new session.
- If the category has no sessions at all: "No running sessions in {name}," with a note to start a new session to get going there.

Clicking a category rail cell also tries to reopen the last session you had open in that category, if it still exists and still belongs there. If there is nothing to reopen and the terminal currently mounted belongs to a different category, the pane detaches it (the session keeps running in the background) so an empty category doesn't appear to contain a foreign session.

## Deleting a category

In the editor, click **Delete category**, then confirm. The confirm step matters here: deleting a category also terminates and removes every session in it, not just the category row. The confirmation names the count ("Terminates N sessions") for exactly this reason. Move any sessions you want to keep to another category first, then delete. An empty category deletes with a plain confirm and no session loss.

---

Categories, colors, emoji, labels, order, and notification overrides are stored in the app's local registry and survive restarts. The app is in beta and macOS-on-Apple-Silicon only. Notification behavior depends on macOS granting the app notification permission, which it asks for the first time you enable notifications.
