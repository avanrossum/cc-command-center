import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin, type Plugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Content-Security-Policy for the PACKAGED renderer.
//
// Second layer under the permission gate in src/main/index.ts. The artifact drawer
// renders agent-produced markdown, RTF and highlighted code through
// dangerouslySetInnerHTML; DOMPurify is the first layer, and this is what still
// holds if a sanitizer bypass ever lands.
//
// Each relaxation below is here because something real needs it:
//   style-src 'unsafe-inline'  xterm's DOM renderer injects a <style> element at
//                              runtime, so styles cannot be locked to 'self'.
//                              Inline STYLE is not script; this is the cheap one to
//                              concede. React's style={{}} goes through the CSSOM
//                              and is not covered by CSP at all.
//   img-src / media-src data:  artifact:read hands back images and audio as data
//                              URLs (App.tsx ArtifactPreview / AudioPlayer).
// Everything else is denied outright by default-src 'none'. Notably script-src is
// 'self' with NO 'unsafe-inline' and NO 'unsafe-eval' — the whole point.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

// Injected as a <meta> tag at BUILD time only.
//
// Two reasons it is not set from main via onHeadersReceived: the packaged renderer
// loads over file://, where header interception is not dependable, and a meta tag
// travels with the document either way.
//
// Build-only because a single policy cannot serve both modes. `npm run dev` runs
// through Vite, which injects an inline React Refresh preamble and needs a
// websocket for HMR — both of which a policy this strict kills. Dev loads from
// localhost and never ships, so it is deliberately left ungoverned; if that ever
// stops being true, the fix is a separate dev policy, not a weaker shared one.
function cspPlugin(): Plugin {
  return {
    name: 'ccc-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
            injectTo: 'head-prepend',
          },
        ]
      },
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), cspPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
})
