import { useEffect, useRef } from 'react'
import { Terminal as XTerm, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { themeByName } from './themes'
import { insertablePath } from './util'
import '@xterm/xterm/css/xterm.css'

interface Props {
  termKey: string
  sessionId?: string
  pid?: number
  cwd: string
  resume: boolean
  themeName?: string | null
  // Spawn a child seeded with the current terminal selection. instant=true →
  // spawn immediately (Cmd+K tangent / Cmd+Shift+K blocking); instant=false → open
  // the composer pre-filled with the given type as default (right-click).
  onSpawnFromSelection?: (text: string, instant: boolean, type: 'blocking' | 'tangential') => void
}

// Hosts one live terminal. The PTY lives in the main process and keeps running
// when this component unmounts (switching sessions) — main replays its buffered
// scrollback on reattach, so we just create a fresh xterm and let main feed it.
export function TerminalView({
  termKey,
  sessionId,
  pid,
  cwd,
  resume,
  themeName,
  onSpawnFromSelection,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  // Held in a ref so the terminal setup effect (which captures it) doesn't need to
  // re-run — and always calls the latest callback.
  const spawnCbRef = useRef(onSpawnFromSelection)
  useEffect(() => {
    spawnCbRef.current = onSpawnFromSelection
  }, [onSpawnFromSelection])

  useEffect(() => {
    const host = hostRef.current!
    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 12.5,
      // Initial theme; live changes are applied via the effect below without
      // remounting. themeName is intentionally NOT a dep of this setup effect.
      theme: themeByName(themeName).theme,
      scrollback: 8000,
      // Kitty keyboard protocol (xterm 6.1+): xterm answers Claude's protocol
      // negotiation and reports Shift+Enter as CSI-u (\x1b[13;2u), which Claude
      // inserts as a newline — the correct, native path (no key-injection hack).
      vtExtensions: { kittyKeyboard: true },
      // OSC 8 hyperlinks open in the system browser. Overriding linkHandler is
      // REQUIRED: xterm's default shows a confirm() and then calls window.open()
      // with no url + sets location.href — which our deny-based window-open
      // handler can't forward, so links appeared to warn-then-do-nothing.
      linkHandler: { activate: (_ev, uri) => void window.cc.openExternal(uri).catch(() => {}) },
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    const serialize = new SerializeAddon()
    term.loadAddon(serialize)
    term.open(host)
    // Renderer: xterm's built-in DOM renderer, no GPU addon. The WebGL addon
    // drops cell updates during rapid output (spinner/streaming) — blank/stale
    // cells that only clear on the next full repaint (a resize forces one), which
    // is exactly the glitch users hit. The DOM renderer repaints every dirty cell
    // correctly and, for the single visible terminal at Claude's output rates, is
    // plenty fast. The canvas addon isn't an option here: it has no build on this
    // xterm 6.1 beta stream (deprecated upstream in favor of WebGL).
    let disposed = false
    fit.fit()

    // Persist a scrollback snapshot (debounced) so a restart can repaint this
    // pane before the resumed session redraws. Only scanned sessions have a
    // stable id to key on; brand-new (unadopted) terminals are skipped.
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    const saveSnapshot = () => {
      if (!sessionId) return
      try {
        window.cc.snapshotSave(sessionId, serialize.serialize({ scrollback: 1000 }))
      } catch {
        /* serialize can throw on a disposed terminal — ignore */
      }
    }
    const scheduleSave = () => {
      if (!sessionId) return
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(saveSnapshot, 4000)
    }

    const offData = window.cc.onTermData((p) => {
      if (p.key === termKey) {
        term.write(p.data)
        scheduleSave()
      }
    })
    const offExit = window.cc.onTermExit((p) => {
      if (p.key === termKey) term.write(`\r\n\x1b[90m[session exited: ${p.code}]\x1b[0m\r\n`)
    })
    const onData = term.onData((d) => window.cc.termInput(termKey, d))

    // Shift+Enter → newline is handled natively by the kitty keyboard protocol
    // (vtExtensions.kittyKeyboard above), so no custom key handler is needed.

    // On macOS the Cmd (meta) key is never terminal input — every Cmd shortcut
    // belongs to the app menu / OS (paste, copy, quit, close, …). Return FALSE for
    // any Cmd combo so xterm ignores the key at the top of _keyDown: no PTY write,
    // no preventDefault, so the menu accelerator fires normally. (Returning true
    // let xterm consume Cmd+V/Cmd+Q under the kitty protocol — it sent a CSI-u
    // sequence and called preventDefault, typing a literal 'v' and blocking Cmd+Q.)
    // The Edit-menu Paste role then handles Cmd+V for BOTH text and images: it
    // fires webContents.paste → xterm sends a bracketed paste, and Claude Code
    // pastes the clipboard image on it. So no extra image handling belongs here —
    // an explicit Ctrl+V injection here just double-pasted the image. Non-Cmd keys
    // fall through (return true) so kitty Shift+Enter and Ctrl+V still work.
    // Special case: Cmd+K with a selection instant-spawns a tangent seeded with it.
    // (Blocking-from-selection is offered via the right-click composer instead — a
    // Cmd+Shift+K shortcut collides with global apps like Notion.)
    term.attachCustomKeyEventHandler((e) => {
      if (e.metaKey) {
        if (
          e.type === 'keydown' &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.shiftKey &&
          (e.key === 'k' || e.key === 'K')
        ) {
          const sel = term.getSelection().trim()
          if (sel) {
            spawnCbRef.current?.(sel, true, 'tangential')
            return false
          }
        }
        return false
      }
      return true
    })

    // Right-click with a selection → spawn via the composer (pick tangent/blocking,
    // adjust folder/name). The right-click clears/re-selects under the cursor before
    // the contextmenu fires, so capture the selection at right-MOUSEDOWN (capture
    // phase, before xterm handles it) — otherwise we'd get one word, or nothing.
    let ctxSel = ''
    const onMouseDown = (ev: MouseEvent): void => {
      if (ev.button === 2) ctxSel = term.getSelection().trim()
    }
    const onCtx = (ev: MouseEvent): void => {
      if (ctxSel) {
        ev.preventDefault()
        spawnCbRef.current?.(ctxSel, false, 'tangential') // composer default; toggle in it
      }
    }
    host.addEventListener('mousedown', onMouseDown, true)
    host.addEventListener('contextmenu', onCtx)

    // Drag a file/folder onto the terminal → insert its full path at the cursor
    // (no enter), so you can weave it into a prompt.
    const onDragOver = (ev: DragEvent): void => {
      if (ev.dataTransfer?.types.includes('Files')) ev.preventDefault()
    }
    const onDrop = (ev: DragEvent): void => {
      const files = ev.dataTransfer?.files
      if (!files || !files.length) return
      ev.preventDefault()
      const paths = Array.from(files)
        .map((f) => window.cc.getPathForFile(f))
        .filter(Boolean)
        .map(insertablePath)
      if (paths.length) window.cc.termInput(termKey, `${paths.join(' ')} `)
    }
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('drop', onDrop)

    // Cmd+Click a file path to open it (iTerm Semantic History parity). Two
    // shapes: (1) an ANCHORED path (~/, /, ./, ../) whose segments may contain
    // single spaces — macOS paths like "Test 1/file.md" — so a space no longer
    // splits the link; (2) an UNANCHORED multi-segment path with NO spaces (kept
    // prose-safe). Optional :line[:col] suffix. Shape (1) can over-capture
    // trailing words when a path sits mid-sentence; main corrects that by
    // resolving to the longest existing prefix, so the click still opens the file.
    const pathRe =
      /(?:~\/|\.{1,2}\/|\/)[\w.\-]+(?:[ /][\w.\-]+)*(?::\d+){0,2}|[\w.\-]+(?:\/[\w.\-]+)+(?::\d+){0,2}/g
    const linkProv = term.registerLinkProvider({
      provideLinks(y, cb) {
        const line = term.buffer.active.getLine(y - 1)
        if (!line) return cb(undefined)
        const text = line.translateToString(true)
        const links: ILink[] = []
        pathRe.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = pathRe.exec(text))) {
          const s = m.index
          const str = m[0]
          // Reduce false positives: skip URL fragments (preceded by ':' or '/', e.g.
          // "https://…") and bare "word/word" (fractions like 2/3, refs like a/HEAD).
          // Keep it only if it has a path anchor (/, ./, ../, ~/) or a file extension.
          const before = text[s - 1]
          if (before === ':' || before === '/') continue
          const lastSeg = str.split('/').pop() ?? ''
          const hasAnchor = /^(?:~\/|\.\.?\/|\/)/.test(str)
          const hasExt = /\.[A-Za-z0-9]{1,8}(?::\d+)*$/.test(lastSeg)
          if (!hasAnchor && !hasExt) continue
          links.push({
            text: str,
            range: { start: { x: s + 1, y }, end: { x: s + str.length, y } },
            decorations: { pointerCursor: true, underline: true },
            activate: (ev, t) => {
              if (ev.metaKey) window.cc.termOpenPath(termKey, t).catch(() => {})
            },
          })
        }
        cb(links.length ? links : undefined)
      },
    })

    window.cc
      .termOpen(termKey, { sessionId, pid, cwd, resume, cols: term.cols, rows: term.rows })
      .then(() => {
        window.cc.termResize(termKey, term.cols, term.rows)
      })

    // Coalesce resize bursts (window drag, composer open/close) to one fit per
    // frame, and only push a PTY resize when the grid actually changed.
    let roRaf: number | null = null
    const ro = new ResizeObserver(() => {
      if (roRaf != null) cancelAnimationFrame(roRaf)
      roRaf = requestAnimationFrame(() => {
        roRaf = null
        if (disposed) return
        const before = `${term.cols}x${term.rows}`
        fit.fit()
        if (`${term.cols}x${term.rows}` !== before) {
          window.cc.termResize(termKey, term.cols, term.rows)
        }
      })
    })
    ro.observe(host)
    term.focus()

    return () => {
      disposed = true
      if (roRaf != null) cancelAnimationFrame(roRaf)
      if (saveTimer) clearTimeout(saveTimer)
      saveSnapshot() // flush a final snapshot before tearing down the xterm
      ro.disconnect()
      host.removeEventListener('mousedown', onMouseDown, true)
      host.removeEventListener('contextmenu', onCtx)
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('drop', onDrop)
      linkProv.dispose()
      offData()
      offExit()
      onData.dispose()
      term.dispose()
      termRef.current = null
      // Intentionally NOT closing the PTY: it keeps running in the background.
    }
  }, [termKey, sessionId, cwd, resume])

  // Apply theme changes live without tearing down the terminal.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeByName(themeName).theme
  }, [themeName])

  return <div className="termhost" ref={hostRef} />
}
