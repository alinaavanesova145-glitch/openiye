/**
 * App.scroll.test.tsx (2026-08-29 sprint) — regression guard for the
 * "I can't scroll the screen" bug: index.css's `body { overflow: hidden }`
 * was shared by BOTH entry points (the fixed-viewport operational canvas
 * AND the normal tall marketing landing page), silently making the
 * landing page unscrollable. Fixed by removing the rule from index.css
 * and re-declaring it narrowly inside App.tsx's GlobalStyles, which only
 * ever mounts on the operational canvas (see App.tsx's 2026-08-29 comment
 * on GlobalStyles for the full explanation).
 *
 * This test asserts both halves mechanically, so a regression here is a
 * test failure, not a silent "page won't scroll" bug someone has to
 * notice by hand:
 *   1. index.css's `body {...}` block does NOT reintroduce a global
 *      scroll lock.
 *   2. GlobalStyles' injected stylesheet DOES still lock body scroll —
 *      the operational canvas's fixed-viewport behavior must not regress
 *      just because the lock moved.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GlobalStyles } from './App'

const INDEX_CSS_PATH = join(__dirname, 'index.css')

function extractBodyBlock(css: string): string {
  const match = /(?<![\w-])body\s*{([^}]*)}/.exec(css)
  if (!match) throw new Error('no top-level body {...} block found in index.css')
  return match[1]
}

describe('index.css does not lock page scroll globally (2026-08-29 sprint)', () => {
  it('the body rule has no overflow declaration — index.css is shared by the landing page, a normal tall page', () => {
    const cssText = readFileSync(INDEX_CSS_PATH, 'utf-8')
    const bodyBlock = extractBodyBlock(cssText)
    expect(bodyBlock).not.toMatch(/overflow\s*:/)
  })
})

describe('GlobalStyles still locks scroll for the operational canvas (2026-08-29 sprint)', () => {
  it('injects a body { overflow: hidden } rule, scoped to the page that actually needs a fixed viewport', () => {
    const { container } = render(<GlobalStyles />)
    const styleTag = container.querySelector('style')
    expect(styleTag).not.toBeNull()
    const cssText = styleTag?.textContent ?? ''
    const bodyBlock = extractBodyBlock(cssText)
    expect(bodyBlock).toMatch(/overflow\s*:\s*hidden/)
  })
})
