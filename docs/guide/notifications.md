# Notifications

Native macOS notifications that tell you when a session needs you, even when the app is on another monitor or behind other windows.

Notifications are off by default. When on, the app posts a macOS notification for a small set of attention events, filtered so an active fleet does not flood you with banners. Everything below is macOS-only.

## Turning them on

1. Open **Settings → Notifications**.
2. Turn on the master switch.

The first time you enable notifications, macOS shows its own permission prompt asking whether this app may send notifications. You have to allow it there. The app switch controls whether the app *tries* to notify; the macOS permission controls whether the system *shows* what the app posts. Both must be on.

If you deny the macOS prompt (or denied it earlier), the app switch alone does nothing. Fix it in **System Settings → Notifications → [the app]** and turn "Allow notifications" back on.

## The three event classes

Each notification belongs to one of three classes. Each class has its own switch and its own shipped default.

| Class | Fires when | Default |
| --- | --- | --- |
| **Needs permission** | A session is stopped at a permission dialog it cannot clear itself and only you can approve or deny. | On |
| **Your turn** | A session ended its turn waiting on you, including when it asked you a direct question. | On |
| **Done** | An unattended session finished its work and it is your move. | Off |

The defaults are deliberate. Needs-permission and your-turn mean something is stopped and only you can unstick it, so they notify. Done is the highest-volume class — a busy fleet finishes work constantly — so it stays off by default to keep it from training you to ignore banners. Turn it on if you want completion notices.

Note that a **blocked** parent (a session waiting on its own child) does not notify. The child that is actually stopped has its own gate and notifies for itself, so notifying the parent too would report one situation twice.

Each notification carries:

- **Title** — the session name.
- **Subtitle** — the category (emoji and label) and the class, for example `🏢 Acme · Needs permission`.
- **Body** — the reason: the verbatim gated command for a permission, the sentence the assistant ended on for a question, or the completion note for done.

## Global switches and per-category overrides

The three class switches in **Settings → Notifications** are the global defaults. They apply to every session unless a category overrides them.

Every category can override any of the three classes. In a category's settings, each class can be set to:

- **Inherit** — use the global switch (the default).
- **On** — notify for this class in this category regardless of the global switch.
- **Off** — stay quiet for this class in this category regardless of the global switch.

A per-category setting wins over the global switch. Use it to keep noisy classes quiet where you don't care (your personal category) and loud where you do (client categories). A category left on "inherit" for a class follows whatever the global switch says.

## When notifications fire, and when they don't

**Never while the app window is focused.** If the app has focus, no notification fires, whatever the switches say. When you are looking at the app, the needs-you bar already shows what is waiting, so a banner would be redundant. The gate is *focused*, not *visible*: an app window sitting open on a second monitor while you work in another app is exactly when a notification is useful, and it will fire.

**Once per event.** Each event notifies a single time. A permission dialog that repaints itself, or a state the app re-reads on every scan, is still one event and still one notification. It will not re-fire while it stays in that state.

**Per-session cooldown.** After a session notifies, it will not notify again for about 10 seconds, so a session flipping rapidly between states cannot storm you with banners.

## Clicking a notification

Click a notification to jump straight to the session that posted it. Clicking:

1. Brings the app to the front.
2. Switches to that session's category.
3. Opens that session and highlights its row.

One click on the banner takes you to the exact session that needs you, so you do not have to find it in the fleet yourself.

## macOS notification style: use "Alert"

macOS lets you choose, per app, how notifications appear. In **System Settings → Notifications → [the app]**, the alert style is either **Banners** or **Alerts**:

- **Banners** appear briefly and disappear on their own.
- **Alerts** stay on screen until you dismiss or click them.

Set the style to **Alerts**. Because clicking a notification is how you open the session, a banner that auto-dismisses can vanish before you get to it. An alert waits until you act, so the click-to-open behavior is reliable and a notice you missed is still on screen when you come back.

This style is a macOS setting, not an app setting — the app cannot change it for you. Set it once in System Settings.
