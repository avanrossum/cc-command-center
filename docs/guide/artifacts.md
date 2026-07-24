# Artifacts — previewing what a session produces

How to see the files a session wrote — charts, docs, code, audio — without leaving the app or hunting through Finder.

When a Claude Code session produces files, the artifacts drawer collects them and previews most of them in place. This guide covers where the drawer lives, what it picks up, which kinds render inline versus open in another app, and how to sort the list and jump to a file in Finder.

## The artifacts drawer

The drawer belongs to the session you currently have open, and it sits with that session's terminal. It folds down over the terminal so the preview and the file list share the same space as the session output.

- **Handle.** A collapsed drawer is a single handle labeled `artifacts` with a count of how many files it found. Click the handle to fold the drawer open; click it again (or the `close drawer` button) to fold it shut.
- **Hidden when empty.** If the open session produced nothing previewable, the drawer is not shown at all. It appears once there is at least one artifact.
- **Persisted.** Whether the drawer is open and which sort you chose are remembered across restarts.

The drawer is scoped to one session — the one you are viewing. It is not a fleet-wide file browser. Switch sessions and the drawer shows that session's files instead.

## What it detects

Detection is passive. There is no daemon and nothing installed inside the session. The drawer builds its list two ways and merges them:

1. **Files the session wrote.** The app reads the session's own transcript and picks up the `file_path` of every `Write`, `Edit`, and `NotebookEdit` the agent ran, as long as the extension is one it recognizes. This is genuinely per-session — it is the text, code, Markdown, HTML, and config the agent authored. Only the tail of the transcript is scanned (the last 8 MB), so a very long session sees its recent writes.
2. **Recent files in the working directory.** A chart, a chime, or a generated PDF is usually produced by a Bash step, which never appears as a `Write` in the transcript. To catch those, the app does one shallow, non-recursive scan of the session's working directory and keeps files that are a document or binary kind (image, audio, PDF, Office, or RTF), are at the top level, are not dotfiles, and were modified in the last 24 hours.

The reason the working-directory scan is limited to those binary and document kinds is noise. A project folder is full of text and config files that belong to the repo, not to this session, so a blanket scan would show every session the whole folder. Binaries and generated documents are rare enough in a project directory that scanning only for them stays accurate even when several sessions share the same folder.

A few properties follow from how this works:

- A file is kept only if it still exists on disk, so an artifact you have since deleted drops off the list on its own.
- The list is capped at 40 files and sorted newest first before it reaches the drawer.
- Detection is cached against the transcript and folder modification times, so it does no work until something actually changes.

## Inline previews vs open-externally

Selecting a file in the list renders it in the preview pane on the left. What happens there depends on the kind:

| Kind | Extensions | Preview |
| --- | --- | --- |
| **Image** | png, jpg, jpeg, gif, webp, bmp | Rendered inline. |
| **SVG** | svg | Rendered inline as an image. Any script inside the SVG never runs, because it is drawn through a script-inert `<img>`. |
| **Audio** | wav, mp3, m4a, ogg, flac, aac | A themed player with play/pause, a click-to-seek bar, and an `m:ss` time readout. |
| **Code** | py, js, ts, tsx, go, rs, java, c, css, json, yaml, sql, and many more | Syntax-highlighted. If highlighting fails, it falls back to plain text. |
| **Markdown** | md, markdown | Rendered by default, with a **rendered / raw** toggle to switch to the source. If the renderer chokes on the input, it shows the raw source instead of an empty pane. |
| **Text** | txt, csv, tsv, log | Shown as plain text. |
| **RTF** | rtf | The RTF markup is parsed and rendered in the pane. If it cannot be rendered, the pane offers to open it instead. |
| **HTML** | html, htm | Opens in your browser. |
| **PDF** | pdf | Opens in your default app. |
| **Office** | docx, doc, xlsx, xls, pptx, ppt, odt, ods, odp | Opens in your default app. |

For the kinds that open externally, the preview pane shows a card with the file name, a short reason ("Opens in your browser.", "PDF — open to view it.", "Opens in your default app."), and an **Open** button that hands the file to the OS. HTML, PDF, and Office are deliberately not rendered inside the app.

Two more cases land on that same open-externally card:

- **Too large to preview.** Inline previews are size-capped — 20 MB for images, SVG, and audio; 512 KB for text, code, Markdown, and RTF. A file over its cap shows "Too large to preview inline." with an Open button, rather than loading a huge file into the pane.
- **Unreadable.** If a file cannot be read, the pane says so and offers Open.

Each preview is wrapped in its own error boundary, so a single file that fails to render shows a "Couldn't preview this file." card with an Open button rather than blanking the app. Switching to another artifact resets it.

## The file list

The right side of the open drawer lists the session's artifacts.

- **Sort.** Toggle between **recent** (most recently modified first, the default) and **name** (alphabetical). The choice is persisted.
- **Kind badge.** Each row leads with a short badge — the file extension, or the kind name if there is no extension.
- **Modified time.** Each row shows a relative time: "just now", then minutes (`5m ago`), hours (`3h ago`), and days (`2d ago`), then a short absolute date once the file is more than a week old. Hover the time to see the full timestamp.
- **Select.** Click a row to load that file into the preview pane.
- **Reveal in Finder.** The `⤴` button on each row opens Finder with that file selected, for when you want to work with it outside the app.

---

Artifact detection reads the session's transcript and terminal, which are parts of Claude Code that are not a public API. The app is in beta and runs on macOS (Apple Silicon) only. An upstream Claude Code change to the transcript format could affect which writes are detected, and the working-directory scan is time-bounded to 24 hours, so an older generated binary may not appear even though the session made it.
