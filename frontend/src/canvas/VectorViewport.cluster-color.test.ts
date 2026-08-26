import { describe, expect, it } from 'vitest'
import { isClusterCyan } from './VectorViewport'

/**
 * isClusterCyan (2026-08-28 sprint) — regression coverage for the cluster
 * hull color flicker: ClusterHulls used to assign pink/cyan by an
 * insertion-order counter (`toggle++ % 2`), not the cluster's own stable
 * `label`, so the same logical cluster could flip color between frames
 * with zero underlying data change whenever iteration order shifted (e.g.
 * a different cluster crossed the >=4-point hull threshold first).
 * isClusterCyan is now the single source of truth both InstancedCoreNodes
 * and ClusterHulls derive color from.
 */
describe('isClusterCyan', () => {
  it('is deterministic by label alone, independent of call order', () => {
    // The exact bug this guards against: querying the same label twice in
    // different "positions" (simulating two different frames where this
    // cluster was encountered at a different point in iteration) must
    // never disagree.
    expect(isClusterCyan(3)).toBe(isClusterCyan(3))
    const results = [7, 2, 7, 0, 7].map(isClusterCyan)
    expect(results[0]).toBe(results[2])
    expect(results[0]).toBe(results[4])
  })

  it('alternates by label parity — even/zero pink, odd cyan', () => {
    expect(isClusterCyan(0)).toBe(false)
    expect(isClusterCyan(1)).toBe(true)
    expect(isClusterCyan(2)).toBe(false)
    expect(isClusterCyan(3)).toBe(true)
  })

  it('noise (label < 0) is never cyan', () => {
    expect(isClusterCyan(-1)).toBe(false)
  })
})
