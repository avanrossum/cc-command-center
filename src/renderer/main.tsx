// The renderer's entry: mounts the command center. It reads only the
// contract types and window.ccc (src/shared/ipc.ts).

import { createRoot } from 'react-dom/client'
import { App } from './components/App.tsx'

createRoot(document.getElementById('root')!).render(<App />)
