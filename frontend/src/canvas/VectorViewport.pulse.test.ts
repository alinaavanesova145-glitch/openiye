import { describe, expect, it } from 'vitest'
import {
  BASE_AMPLITUDE,
  BASE_PULSE_HZ,
  COMPOSITE_AMP_SCALE,
  MAX_PULSE_HZ,
  VELOCITY_FREQ_SCALE,
  computeBeaconPulseAmplitude,
  computeBeaconPulseFrequencyHz,
  resolveExplanationDisplay,
} from './VectorViewport'

describe('computeBeaconPulseFrequencyHz', () => {
  it('returns the base frequency at zero velocity', () => {
    expect(computeBeaconPulseFrequencyHz(0)).toBe(BASE_PULSE_HZ)
  })

  it('scales linearly with velocity below the clamp', () => {
    const velocity = 1.5
    const expected = BASE_PULSE_HZ + velocity * VELOCITY_FREQ_SCALE
    expect(computeBeaconPulseFrequencyHz(velocity)).toBeCloseTo(expected)
    expect(computeBeaconPulseFrequencyHz(velocity)).toBeLessThan(MAX_PULSE_HZ)
  })

  it('clamps at MAX_PULSE_HZ for large velocity', () => {
    expect(computeBeaconPulseFrequencyHz(100)).toBe(MAX_PULSE_HZ)
  })

  it('never goes below BASE_PULSE_HZ (velocity is a non-negative magnitude in practice)', () => {
    expect(computeBeaconPulseFrequencyHz(0)).toBeGreaterThanOrEqual(BASE_PULSE_HZ)
  })

  it('is monotonically non-decreasing in velocity', () => {
    const samples = [0, 0.5, 1, 2, 3, 5, 10, 50]
    const results = samples.map(computeBeaconPulseFrequencyHz)
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThanOrEqual(results[i - 1])
    }
  })
})

describe('computeBeaconPulseAmplitude', () => {
  it('returns the base amplitude at zero composite_smoothed', () => {
    expect(computeBeaconPulseAmplitude(0)).toBe(BASE_AMPLITUDE)
  })

  it('scales linearly with composite_smoothed (no upper clamp)', () => {
    const composite = 4
    const expected = BASE_AMPLITUDE + composite * COMPOSITE_AMP_SCALE
    expect(computeBeaconPulseAmplitude(composite)).toBeCloseTo(expected)
  })

  it('never goes below BASE_AMPLITUDE', () => {
    expect(computeBeaconPulseAmplitude(0)).toBeGreaterThanOrEqual(BASE_AMPLITUDE)
  })

  it('is monotonically non-decreasing in composite_smoothed', () => {
    const samples = [0, 0.5, 1, 2, 5, 20]
    const results = samples.map(computeBeaconPulseAmplitude)
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeGreaterThanOrEqual(results[i - 1])
    }
  })
})

describe('resolveExplanationDisplay', () => {
  it('returns null for a NOMINAL frame regardless of explanation', () => {
    expect(resolveExplanationDisplay('NOMINAL', null)).toBeNull()
    expect(resolveExplanationDisplay('NOMINAL', 'System nominal.')).toBeNull()
  })

  it('returns the "analyzing…" placeholder for an ANOMALY frame with a pending (null) narrative', () => {
    expect(resolveExplanationDisplay('ANOMALY', null)).toBe('analyzing…')
  })

  it('returns the real explanation once the narrative has arrived', () => {
    expect(resolveExplanationDisplay('ANOMALY', 'structural drift on axis 2')).toBe('structural drift on axis 2')
  })
})
