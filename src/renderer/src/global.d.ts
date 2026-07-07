export {}

declare global {
  interface Window {
    cc: {
      getSessions: () => Promise<unknown>
      onSessions: (cb: (snapshot: unknown) => void) => () => void
    }
  }
}
