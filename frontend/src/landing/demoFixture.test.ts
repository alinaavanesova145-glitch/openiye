import { describe, expect, it } from 'vitest'
import { DEMO_ANOMALY_INDICES, DEMO_NARRATIVES, DEMO_POINTS } from './demoFixture'

describe('demoFixture data integrity', () => {
  it('every point has a unique, sequential index matching its array position', () => {
    DEMO_POINTS.forEach((p, i) => {
      expect(p.index).toBe(i)
    })
  })

  it('every anomaly index refers to a real fixture point', () => {
    const validIndices = new Set(DEMO_POINTS.map((p) => p.index))
    for (const idx of DEMO_ANOMALY_INDICES) {
      expect(validIndices.has(idx)).toBe(true)
    }
  })

  it('every anomaly point is labeled noise (clusterLabel -1), consistent with its narrative text', () => {
    for (const idx of DEMO_ANOMALY_INDICES) {
      const point = DEMO_POINTS.find((p) => p.index === idx)
      expect(point?.clusterLabel).toBe(-1)
    }
  })

  it('every anomaly index has a corresponding pre-generated narrative', () => {
    for (const idx of DEMO_ANOMALY_INDICES) {
      expect(DEMO_NARRATIVES[idx]).toBeTypeOf('string')
      expect(DEMO_NARRATIVES[idx].length).toBeGreaterThan(0)
    }
  })

  it('no narrative exists for a non-anomaly point (grounded only in what was actually flagged)', () => {
    const anomalySet = new Set(DEMO_ANOMALY_INDICES)
    for (const idx of Object.keys(DEMO_NARRATIVES).map(Number)) {
      expect(anomalySet.has(idx)).toBe(true)
    }
  })

  it('every anomaly point has at least one axis exceeding the real backend’s 2.5σ anomaly threshold', () => {
    for (const idx of DEMO_ANOMALY_INDICES) {
      const point = DEMO_POINTS.find((p) => p.index === idx)
      const maxZ = Math.max(
        Math.abs(point?.zScores.x ?? 0),
        Math.abs(point?.zScores.y ?? 0),
        Math.abs(point?.zScores.z ?? 0),
      )
      expect(maxZ).toBeGreaterThan(2.5)
    }
  })

  it('nominal (non-anomaly) points stay comfortably under the anomaly threshold', () => {
    const anomalySet = new Set(DEMO_ANOMALY_INDICES)
    for (const point of DEMO_POINTS) {
      if (anomalySet.has(point.index)) continue
      const maxZ = Math.max(Math.abs(point.zScores.x), Math.abs(point.zScores.y), Math.abs(point.zScores.z))
      expect(maxZ).toBeLessThan(2.5)
    }
  })

  it('narrative text cites a specific deviating axis and magnitude, not generic filler', () => {
    for (const text of Object.values(DEMO_NARRATIVES)) {
      expect(text).toMatch(/axis/)
      expect(text).toMatch(/\|z\|=\d/)
    }
  })

  it('every point has exactly 3 coordinate and z-score dimensions (the passthrough case)', () => {
    for (const p of DEMO_POINTS) {
      expect(p.position).toHaveLength(3)
      expect(Object.keys(p.zScores).sort()).toEqual(['x', 'y', 'z'])
    }
  })
})
