// Links in a session's terminal view (MIP2-1471): OSC 8 hyperlinks, which
// Claude Code prints, and plain http(s) text (xterm's web-links addon). As
// in 0.24, a plain click opens one. Main decides what may open
// (policy.ts, checkTerminalLink); everything is sent there, so a refused
// link says why instead of doing nothing. Hovering shows the target, since
// an OSC 8 link's text can differ from where it goes.

import type { IBufferRange, ILinkHandler } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'

export interface LinkUi {
  /** `text` is an OSC 8 link's visible text, which main compares with its target (pass 9, M-3; pass 10, M-2). */
  open(url: string, text?: string, atEdge?: boolean): void
  /** The visible text in a buffer range. */
  textAt(range: IBufferRange): LinkText
  /** Shows where the link under the mouse goes. */
  show(url: string): void
  hide(): void
}

/**
 * The terminal's `linkHandler`, for OSC 8 links. xterm passes the link's
 * target, not its text. Non-http targets reach `open` too
 * (`allowNonHttpProtocols`), so main can refuse them with a notice; without
 * it xterm drops them silently.
 */
export function oscLinkHandler(ui: LinkUi): ILinkHandler {
  return {
    activate: (_event, uri, range) => {
      const { text, atEdge } = ui.textAt(range)
      ui.open(uri, text, atEdge)
    },
    hover: (_event, uri) => ui.show(uri),
    leave: () => ui.hide(),
    allowNonHttpProtocols: true,
  }
}

/** The web-links addon, for http(s) URLs in plain text. */
export function webLinks(ui: LinkUi): WebLinksAddon {
  return new WebLinksAddon((_event, uri) => ui.open(uri), { hover: (_event, text) => ui.show(text), leave: () => ui.hide() })
}

/** The hover line's text: the target, cut in the middle when long so both ends show. */
export function linkTip(url: string, max = 120): string {
  if (url.length <= max) return url
  const half = Math.floor((max - 1) / 2)
  return `${url.slice(0, half)}…${url.slice(url.length - half)}`
}

/** The part of xterm's buffer `textAt` reads. */
export interface LinkBuffer {
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string } | undefined
}

export interface LinkText {
  text: string
  /**
   * Whether the text touches the edge: it ends in the last column, or starts
   * in the first on a wrapped line. xterm 6 gives an OSC 8 link one line at
   * a time, so a link that wraps is only partly here (pass 10, M-2).
   */
  atEdge: boolean
}

/**
 * The visible text of an xterm link range: 1-based columns, inclusive end,
 * rows 1-based as `getLine(y - 1)` reads them (xterm 6.0.0's
 * OscLinkProvider; pass 10, L-5).
 */
export function textAt(buffer: LinkBuffer, cols: number, range: IBufferRange): LinkText {
  const parts: string[] = []
  for (let y = range.start.y; y <= range.end.y; y++) {
    const line = buffer.getLine(y - 1)
    if (!line) continue
    parts.push(line.translateToString(true, y === range.start.y ? range.start.x - 1 : 0, y === range.end.y ? range.end.x : undefined))
  }
  const first = buffer.getLine(range.start.y - 1)
  const atEdge = range.end.x >= cols || (range.start.x === 1 && first?.isWrapped === true)
  return { text: parts.join(''), atEdge }
}
