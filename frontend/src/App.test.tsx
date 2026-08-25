import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PublicHostNotice, shouldShowPublicHostNotice } from './App'

describe('shouldShowPublicHostNotice (2026-08-01 sprint)', () => {
  it('is false on a private/LAN host regardless of stream state', () => {
    expect(shouldShowPublicHostNotice(false, 'disconnected')).toBe(false)
    expect(shouldShowPublicHostNotice(false, 'error')).toBe(false)
    expect(shouldShowPublicHostNotice(false, 'connecting')).toBe(false)
    expect(shouldShowPublicHostNotice(false, 'connected')).toBe(false)
  })

  it('is true on a public host whenever the stream is not connected', () => {
    expect(shouldShowPublicHostNotice(true, 'disconnected')).toBe(true)
    expect(shouldShowPublicHostNotice(true, 'error')).toBe(true)
    expect(shouldShowPublicHostNotice(true, 'connecting')).toBe(true)
  })

  it('is false on a public host once actually connected — never masks a real success', () => {
    expect(shouldShowPublicHostNotice(true, 'connected')).toBe(false)
  })
})

describe('PublicHostNotice', () => {
  it('explains the LAN requirement honestly and links to the live demo', () => {
    render(<PublicHostNotice />)
    expect(screen.getByText('local network required')).toBeInTheDocument()
    expect(screen.getByText(/can.t reach one from the public internet, by design/)).toBeInTheDocument()
    const link = screen.getByText('see the live interactive demo instead')
    expect(link.closest('a')).toHaveAttribute('href', '/landing.html')
  })

  it('never claims the connection is broken or will fix itself', () => {
    render(<PublicHostNotice />)
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/error|failed|retry|reconnecting/i)
  })
})
