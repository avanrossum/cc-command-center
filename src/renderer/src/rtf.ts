// A compact RTF → HTML converter for previewing .rtf artifacts in-pane. RTF is
// text-based markup, so we parse a practical subset — paragraphs/line breaks,
// bold/italic/underline, tabs, and unicode/hex escapes — and skip the header
// destinations (font/color/style tables, info, embedded pictures/objects). It is
// NOT a full RTF engine; anything it can't render still falls back to "open
// externally". Output is a fixed safe tag set (<b>/<i>/<u>/<br>) built from
// HTML-escaped text, so it's inert by construction.

// CP1252 high range (0x80–0x9F) — the bytes an agent's RTF most often carries via
// \'hh: smart quotes, dashes, ellipsis. Outside this range we fall back to latin1.
const CP1252: Record<number, string> = {
  0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†',
  0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹',
  0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž',
  0x9f: 'Ÿ',
}
const byteChar = (code: number): string =>
  code >= 0x80 && code <= 0x9f ? (CP1252[code] ?? '') : String.fromCharCode(code)

// Destination groups whose contents are metadata, not document text.
const SKIP_DEST = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata',
  'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl',
  'generator', 'xmlnstbl', 'filetbl', 'revtbl', 'protusertbl', 'mmathPr',
])

interface St {
  b: boolean
  i: boolean
  u: boolean
  uc: number
  skip: boolean
}

export function rtfToHtml(rtf: string): string | null {
  if (!rtf || !rtf.includes('\\rtf')) return null
  const stack: St[] = [{ b: false, i: false, u: false, uc: 1, skip: false }]
  let top = stack[0]
  let out = ''
  let uniSkip = 0 // chars to drop as \uN fallback (per the group's \ucN)
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const emit = (text: string): void => {
    if (top.skip || !text) return
    if (uniSkip > 0) {
      const drop = Math.min(uniSkip, text.length)
      uniSkip -= drop
      text = text.slice(drop)
      if (!text) return
    }
    let h = esc(text)
    if (top.u) h = `<u>${h}</u>`
    if (top.i) h = `<i>${h}</i>`
    if (top.b) h = `<b>${h}</b>`
    out += h
  }
  const applyWord = (word: string, num: number | null): void => {
    if (SKIP_DEST.has(word)) {
      top.skip = true
      return
    }
    switch (word) {
      case 'par':
      case 'sect':
      case 'line':
        if (!top.skip) out += '<br>'
        return
      case 'tab':
        emit('\t')
        return
      case 'b':
        top.b = num !== 0
        return
      case 'i':
        top.i = num !== 0
        return
      case 'ul':
        top.u = num !== 0
        return
      case 'ulnone':
        top.u = false
        return
      case 'uc':
        top.uc = num ?? 1
        return
      case 'u':
        if (num != null) emit(String.fromCharCode(num < 0 ? num + 0x10000 : num))
        uniSkip = top.uc
        return
      default:
        return
    }
  }

  let i = 0
  const n = rtf.length
  while (i < n) {
    const c = rtf[i]
    if (c === '{') {
      stack.push({ ...top })
      top = stack[stack.length - 1]
      i++
    } else if (c === '}') {
      if (stack.length > 1) {
        stack.pop()
        top = stack[stack.length - 1]
      }
      i++
    } else if (c === '\\') {
      const next = rtf[i + 1]
      if (next === '\\' || next === '{' || next === '}') {
        emit(next)
        i += 2
      } else if (next === '*') {
        top.skip = true
        i += 2
      } else if (next === "'") {
        const code = parseInt(rtf.substr(i + 2, 2), 16)
        if (!isNaN(code)) {
          if (uniSkip > 0) uniSkip--
          else emit(byteChar(code))
        }
        i += 4
      } else if (next && /[a-zA-Z]/.test(next)) {
        let j = i + 1
        while (j < n && /[a-zA-Z]/.test(rtf[j])) j++
        const word = rtf.substring(i + 1, j)
        let numStr = ''
        if (rtf[j] === '-') {
          numStr = '-'
          j++
        }
        while (j < n && /[0-9]/.test(rtf[j])) numStr += rtf[j++]
        if (rtf[j] === ' ') j++ // one optional space delimiter is consumed
        applyWord(word, numStr === '' || numStr === '-' ? null : parseInt(numStr, 10))
        i = j
      } else {
        if (next === '~') emit(' ')
        else if (next === '_' || next === '-') {
          /* optional/non-breaking hyphen — skip */
        }
        i += 2
      }
    } else if (c === '\r' || c === '\n') {
      i++ // literal newlines in RTF are not content
    } else {
      let j = i
      while (j < n && !'\\{}\r\n'.includes(rtf[j])) j++
      emit(rtf.substring(i, j))
      i = j
    }
  }
  return out.replace(/(<br>)+$/, '').trim() ? out : null
}
