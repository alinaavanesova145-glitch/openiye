import { describe, expect, it } from 'vitest'
import {
  SEVERITY_Z_CEIL,
  SEVERITY_Z_FLOOR,
  computeSeverity,
  computeSeverityColor,
  computeSeverityScale,
} from './VectorViewport'

describe('computeSeverity', () => {
  it('is 0 at (or below) the anomaly threshold floor', () => {
    expect(computeSeverity(SEVERITY_Z_FLOOR)).toBe(0)
    expect(computeSeverity(0)).toBe(0) // clamped, never negative
  })

  it('is 1 at (or above) the ceiling', () => {
    expect(computeSeverity(SEVERITY_Z_CEIL)).toBe(1)
    expect(computeSeverity(100)).toBe(1) // clamped, never above 1
  })

  it('scales linearly between floor and ceiling', () => {
    const midpoint = (SEVERITY_Z_FLOOR + SEVERITY_Z_CEIL) / 2
    expect(computeSeverity(midpoint)).toBeCloseTo(0.5)
  })

  it('is monotonically non-decreasing in Z-score magnitude', () => {
    const samples = [0, 1, 2.5, 3, 4, 5, 6, 10]
    const results = samples.map(computeSeverity)
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThanOrEqual(results[i - 1])
    }
  })
})

describe('computeSeverityColor', () => {
  it('returns a valid 6-digit hex color string at every severity level', () => {
    for (const z of [0, SEVERITY_Z_FLOOR, 4, SEVERITY_Z_CEIL, 10]) {
      expect(computeSeverityColor(z)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('is a different color at minimum vs. maximum severity (visually distinct)', () => {
    expect(computeSeverityColor(SEVERITY_Z_FLOOR)).not.toBe(computeSeverityColor(SEVERITY_Z_CEIL))
  })

  it('is deterministic — same input always produces the same color', () => {
    expect(computeSeverityColor(4.2)).toBe(computeSeverityColor(4.2))
  })
})

describe('computeSeverityScale', () => {
  it('is 1 (no scaling) at the floor', () => {
    expect(computeSeverityScale(SEVERITY_Z_FLOOR)).toBe(1)
  })

  it('is larger than 1 at the ceiling (most anomalous points read as visually bigger)', () => {
    expect(computeSeverityScale(SEVERITY_Z_CEIL)).toBeGreaterThan(1)
  })

  it('is monotonically non-decreasing in Z-score magnitude', () => {
    const samples = [0, 2.5, 3, 4, 5, 6, 10]
    const results = samples.map(computeSeverityScale)
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThanOrEqual(results[i - 1])
    }
  })
})
