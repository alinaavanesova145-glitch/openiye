/**
 * theme.consistency.test.ts (2026-08-01 sprint) — CSS can't `import` from
 * TypeScript, so @lib/theme's exported constants and index.css's `:root`
 * custom properties are two files that must be kept in sync by hand. This
 * test closes that gap mechanically: it parses index.css's `:root` block
 * and asserts every `--iye-*` token's literal value matches the
 * corresponding THEME export, so a drift is a test failure the next time
 * either file changes, not a silent visual bug someone has to notice.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THEME } from './theme'

const INDEX_CSS_PATH = join(__dirname, '..', 'index.css')

function parseRootCustomProperties(css: string): Record<string, string> {
  const rootMatch = /:root\s*{([^}]*)}/.exec(css)
  if (!rootMatch) throw new Error('no :root block found in index.css')
  const body = rootMatch[1]
  const props: Record<string, string> = {}
  for (const line of body.split(';')) {
    const propMatch = /--([a-z-]+):\s*(.+)/.exec(line.trim())
    if (propMatch) {
      props[propMatch[1]] = propMatch[2].trim()
    }
  }
  return props
}

// camelCase THEME key -> kebab-case CSS custom property name (minus the
// --iye- prefix), for exactly the tokens meant to be identical in both
// worlds. Per-surface bespoke opacities (DataSourcePanel's text tiers,
// landing.css's own text/textMuted/textFaint hierarchy) are deliberately
// NOT in this map — see theme.ts's docstring for why those stay local.
const SHARED_TOKEN_MAP: Record<string, string> = {
  bg: 'bg',
  bgRaised: 'bg-raised',
  pink: 'pink',
  cyan: 'cyan',
  pinkDim: 'pink-dim',
  pinkBorder: 'pink-border',
}

describe('theme.ts and index.css stay in sync', () => {
  const cssText = readFileSync(INDEX_CSS_PATH, 'utf-8')
  const cssProps = parseRootCustomProperties(cssText)

  it('index.css actually declares a :root block with iye- tokens (sanity check on the parse itself)', () => {
    expect(Object.keys(cssProps).length).toBeGreaterThan(0)
  })

  it.each(Object.entries(SHARED_TOKEN_MAP))('THEME.%s matches --iye-%s in index.css', (themeKey, cssName) => {
    const themeValue = THEME[themeKey as keyof typeof THEME]
    const cssValue = cssProps[`iye-${cssName}`]
    expect(cssValue, `--iye-${cssName} not found in index.css's :root block`).toBeDefined()
    expect(cssValue).toBe(themeValue)
  })
})
