import { describe, expect, it } from 'vitest'
import { computeApiBase, computeWsBase, isLikelyPublicHost } from './apiConfig'

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

describe('isLikelyPublicHost (2026-08-01 sprint)', () => {
  it('is false for localhost and the loopback IP', () => {
    expect(isLikelyPublicHost('localhost')).toBe(false)
    expect(isLikelyPublicHost('127.0.0.1')).toBe(false)
  })

  it('is false for every RFC 1918 private-LAN range the backend CORS policy allows', () => {
    expect(isLikelyPublicHost('10.0.0.5')).toBe(false)
    expect(isLikelyPublicHost('172.16.0.1')).toBe(false)
    expect(isLikelyPublicHost('172.31.255.254')).toBe(false)
    expect(isLikelyPublicHost('192.168.1.4')).toBe(false)
  })

  it('is true for a Cloudflare Pages hostname — the exact case this sprint addresses', () => {
    expect(isLikelyPublicHost('openiye.pages.dev')).toBe(true)
  })

  it('is true for any other public-looking hostname', () => {
    expect(isLikelyPublicHost('example.com')).toBe(true)
    expect(isLikelyPublicHost('openiye.com')).toBe(true)
  })

  it('is true for a private-range-adjacent but out-of-bounds IP (172.32.x is NOT RFC 1918)', () => {
    expect(isLikelyPublicHost('172.32.0.1')).toBe(true)
    expect(isLikelyPublicHost('172.15.0.1')).toBe(true)
  })
})
