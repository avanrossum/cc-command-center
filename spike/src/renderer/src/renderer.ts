import '@xterm/xterm/css/xterm.css'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'

interface PtyApi {
  start: (cols: number, rows: number) => void
  input: (data: string) => void
  resize: (cols: number, rows: number) => void
  onData: (cb: (data: string) => void) => void
  onInfo: (cb: (msg: string) => void) => void
  onExit: (cb: (code: number) => void) => void
}

const ptyApi = (window as unknown as { ptyApi: PtyApi }).ptyApi

const term = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 13,
  scrollback: 10000,
  theme: { background: '#1e1e1e' },
})

const fit = new FitAddon()
term.loadAddon(fit)

const el = document.getElementById('term')!
term.open(el)

// xterm 6.0 removed the canvas renderer; WebGL is the accelerated path.
let webglOk = false
try {
  const webgl = new WebglAddon()
  webgl.onContextLoss(() => webgl.dispose())
  term.loadAddon(webgl)
  webglOk = true
} catch (e) {
  console.error('WebGL addon failed to load; falling back to DOM renderer', e)
}

fit.fit()
ptyApi.start(term.cols, term.rows)

term.onData((d) => ptyApi.input(d))
ptyApi.onData((d) => term.write(d))
ptyApi.onInfo((msg) => console.log('[pty]', msg))
ptyApi.onExit((code) => term.write(`\r\n\x1b[90m[process exited: ${code}]\x1b[0m\r\n`))

const ro = new ResizeObserver(() => {
  fit.fit()
  ptyApi.resize(term.cols, term.rows)
})
ro.observe(el)

term.focus()
console.log(`[spike] renderer up — WebGL: ${webglOk ? 'on' : 'OFF (DOM fallback)'}, size ${term.cols}x${term.rows}`)
