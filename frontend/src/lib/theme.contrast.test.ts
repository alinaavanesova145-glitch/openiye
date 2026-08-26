/**
 * theme.contrast.test.ts (2026-08-28 sprint) — every real text color used
 * against this theme's #0a0a0d background must clear WCAG AA's 4.5:1
 * normal-text floor. An audit found two that didn't: DataSourcePanel's old
 * pinkText50 (pinkAlpha(0.5), 3.63:1) and the textMuted used by both
 * DataSourcePanel and DiagnosticSidebar (whiteAlpha(0.38), 3.51:1) — real
 * body text (drop-zone hints, frame-metadata values, status labels,
 * explanation text), not decorative, so this isn't a cosmetic nitpick.
 *
 * Imports the actual exported COLORS objects those two files render with,
 * not hand-copied duplicate values — a future alpha change that
 * regresses contrast fails here automatically, it doesn't require anyone
 * to remember to update a second, disconnected number.
 */
import { describe, expect, it } from 'vitest'
import { THEME, contrastRatio } from './theme'
import { COLORS as DataSourcePanelColors } from '@/ui/DataSourcePanel'
import { COLORS as DiagnosticSidebarColors } from '@/ui/DiagnosticSidebar'

const AA_NORMAL_TEXT_MIN = 4.5

describe('contrastRatio (the utility itself)', () => {
  it('matches WCAG\'s own reference figures for pure black/white', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1)
    expect(contrastRatio('#000000', '#000000')).toBeCloseTo(1, 5)
  })

  it('is symmetric — which color is "fg" vs "bg" only matters for alpha compositing', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(contrastRatio('#000000', '#ffffff'), 5)
  })

  it('alpha-composites a translucent fg over bg before computing luminance', () => {
    // A fully-transparent "white" text is indistinguishable from the
    // background itself — contrast 1:1, not whatever pure white would give.
    expect(contrastRatio('rgba(255, 255, 255, 0)', '#0a0a0d')).toBeCloseTo(1, 2)
  })
})

describe('actual text tokens clear WCAG AA (4.5:1) against the real background', () => {
  it.each([
    ['DataSourcePanel textMuted', DataSourcePanelColors.textMuted],
    ['DataSourcePanel pinkText60', DataSourcePanelColors.pinkText60],
    ['DataSourcePanel pinkText70', DataSourcePanelColors.pinkText70],
    ['DiagnosticSidebar textMuted', DiagnosticSidebarColors.textMuted],
    ['DiagnosticSidebar textPrimary', DiagnosticSidebarColors.textPrimary],
    ['DiagnosticSidebar pinkText', DiagnosticSidebarColors.pinkText],
  ])('%s >= 4.5:1 against THEME.bg', (_label, color) => {
    expect(contrastRatio(color, THEME.bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MIN)
  })
})
