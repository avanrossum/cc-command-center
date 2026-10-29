// An Admin key in the Arbiter's slot has a Remove button beside its warning (gate pass 17, M-3).

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AdminKeyWarning } from '../src/renderer/components/Settings.tsx'

describe('AdminKeyWarning', () => {
  it('tells the user to remove the key, and gives them the button to do it', () => {
    const html = renderToStaticMarkup(<AdminKeyWarning onRemoved={() => {}} />)
    expect(html).toContain('organization-admin rights')
    expect(html).toMatch(/<button[^>]*>Remove<\/button>/)
  })
})
