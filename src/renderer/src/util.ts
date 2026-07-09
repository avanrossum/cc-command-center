// Make a filesystem path safe to insert into terminal input: strip newlines
// (a newline in a filename — legal on macOS — could prematurely submit) and
// single-quote paths containing whitespace so they stay one token.
export function insertablePath(p: string): string {
  const clean = p.replace(/[\r\n]+/g, ' ').trim()
  return /\s/.test(clean) ? `'${clean.replace(/'/g, "'\\''")}'` : clean
}
