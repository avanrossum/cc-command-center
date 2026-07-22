// Render markdown artifacts to sanitized HTML. marked handles the CommonMark/GFM
// structure; DOMPurify strips anything that could execute in the renderer (inline
// event handlers, <script>, javascript: URLs). Artifacts are agent-produced, so
// their markdown is treated as untrusted for display even though it's local.
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: false })

// Returns sanitized HTML, or null if parsing failed — marked throws a
// RangeError (stack overflow) on pathologically nested input, and this runs
// during React render, so a throw would crash the tree. The caller falls back
// to showing the raw source when this is null.
export function renderMarkdown(md: string): string | null {
  try {
    const raw = marked.parse(md, { async: false }) as string
    return DOMPurify.sanitize(raw)
  } catch {
    return null
  }
}
