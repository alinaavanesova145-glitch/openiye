import { describe, expect, it } from 'vitest'
import { computeApiBase, computeWsBase } from './apiConfig'

describe('computeApiBase', () => {
  it('derives from localhost', () => {
    expect(computeApiBase('http:', 'localhost')).toBe('http://localhost:8050')
  })

  it('derives from a LAN IP — the exact bug this sprint fixes', () => {
    expect(computeApiBase('http:', '192.168.1.4')).toBe('http://192.168.1.4:8050')
  })

  it('derives from the loopback IP', () => {
    expect(computeApiBase('http:', '127.0.0.1')).toBe('http://127.0.0.1:8050')
  })

  it('mirrors an https page protocol', () => {
    expect(computeApiBase('https:', 'example.com')).toBe('https://example.com:8050')
  })
})

describe('computeWsBase', () => {
  it('swaps http for ws', () => {
    expect(computeWsBase('http://192.168.1.4:8050')).toBe('ws://192.168.1.4:8050')
  })

  it('swaps https for wss', () => {
    expect(computeWsBase('https://example.com:8050')).toBe('wss://example.com:8050')
  })
})
