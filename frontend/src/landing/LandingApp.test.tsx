import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import LandingApp from './LandingApp'

/**
 * DemoWidget mounts a real react-three-fiber <Canvas>, which — same
 * documented boundary as VectorViewport.memo.test.tsx and
 * App.suspense.test.tsx — cannot render under jsdom (no real WebGL
 * context). Mocked here so this file can test LandingApp's actual static
 * content (copy, CTA links, section structure) without hitting that wall;
 * the lazy-loading mechanism itself is already proven generically by
 * App.suspense.test.tsx, and DemoWidget's own interactive behavior is
 * proven by useFixtureAnomalyExplain.test.ts and demoFixture.test.ts.
 */
vi.mock('./DemoWidget', () => ({
  default: () => <div data-testid="mock-demo-widget">mock demo widget</div>,
}))

// Phrases that would constitute fabricated social proof — a regression
// guard against these creeping back in, per the task's explicit
// instruction not to include fabricated urgency or social proof anywhere.
const FORBIDDEN_PATTERNS = [
  /trusted by/i,
  /customers?\b.*\b(rely|love|use)/i,
  /\d[,.]?\d*\+?\s*(companies|customers|users)/i,
  /only \d+ (spots?|seats?) left/i,
  /testimonial/i,
]

describe('LandingApp', () => {
  it('renders the hero headline and demo widget slot', async () => {
    render(<LandingApp />)
    expect(screen.getByText(/3D anomaly map/i)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('mock-demo-widget')).toBeInTheDocument()
    })
  })

  it('renders all four how-it-works steps', () => {
    render(<LandingApp />)
    expect(screen.getByText('Drop any file')).toBeInTheDocument()
    expect(screen.getByText('Auto-encode + reduce')).toBeInTheDocument()
    expect(screen.getByText('Cluster + flag outliers')).toBeInTheDocument()
    expect(screen.getByText("Click for a narrated why")).toBeInTheDocument()
  })

  it('renders all four feature highlights, each tied to real shipped capability', () => {
    render(<LandingApp />)
    expect(screen.getByText('Handles messy files automatically')).toBeInTheDocument()
    expect(screen.getByText('3D spatial anomaly detection')).toBeInTheDocument()
    expect(screen.getByText('LLM-grounded explanations')).toBeInTheDocument()
    expect(screen.getByText('Python SDK for headless workflows')).toBeInTheDocument()
  })

  it('every CTA is a mailto link, honestly labeled — no fake form claiming to be wired up', () => {
    render(<LandingApp />)
    const ctaLinks = screen.getAllByText('Get in touch')
    expect(ctaLinks.length).toBeGreaterThan(0)
    for (const link of ctaLinks) {
      expect(link.closest('a')).toHaveAttribute('href', 'mailto:hello@openiye.com')
    }
    expect(
      screen.getByText(/we don.t yet have a form or crm wired up/i),
    ).toBeInTheDocument()
  })

  it('contains no fabricated social proof, customer counts, or false urgency', () => {
    render(<LandingApp />)
    const bodyText = document.body.textContent ?? ''
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(bodyText).not.toMatch(pattern)
    }
  })

  it('does not crash when rendered at a narrow (mobile) viewport width', () => {
    const original = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 })
    window.dispatchEvent(new Event('resize'))

    expect(() => render(<LandingApp />)).not.toThrow()
    expect(screen.getByText(/3D anomaly map/i)).toBeInTheDocument()

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: original })
  })
})
