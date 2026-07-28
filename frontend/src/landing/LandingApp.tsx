import { Suspense, lazy } from 'react'
import './landing.css'

// Lazy-loaded so the hero's headline/copy paint immediately — the 3D
// engine (three.js + @react-three/*) is the vast majority of the bundle
// and shouldn't block first paint. Mirrors the exact same pattern
// src/App.tsx already uses for the real product's VectorViewport.
const DemoWidget = lazy(() => import('./DemoWidget'))

const DemoWidgetFallback = () => (
  <div className="demo-widget-canvas">
    <div className="demo-widget-fallback">loading demo…</div>
  </div>
)

// CONTACT PLACEHOLDER (2026-07-30 sprint) — no CRM/waitlist/form backend
// exists anywhere in this codebase (confirmed via audit). This mailto
// address is a placeholder assuming the openiye.com domain; it has not
// been verified to be a real, monitored inbox. Flagged explicitly in the
// sprint report as needing real infrastructure before launch, per the
// task's instruction not to fabricate a working integration.
const CONTACT_EMAIL = 'hello@openiye.com'

const STEPS = [
  {
    n: '01',
    title: 'Drop any file',
    body: 'CSV, JSON, or mixed numeric/categorical/text logs — no manual vector prep, no data science team required.',
  },
  {
    n: '02',
    title: 'Auto-encode + reduce',
    body: 'Categorical and text columns are classified and encoded automatically; the full feature set is reduced to 3D via UMAP.',
  },
  {
    n: '03',
    title: 'Cluster + flag outliers',
    body: 'HDBSCAN finds the dense structure; any point crossing a 2.5σ Z-score threshold on any axis is flagged as anomalous.',
  },
  {
    n: '04',
    title: 'Click for a narrated why',
    body: 'A local LLM explains each flagged point in plain English, grounded in its own deviation and cluster membership.',
  },
]

const FEATURES = [
  {
    title: 'Handles messy files automatically',
    body: 'Low-cardinality categorical columns are one-hot encoded, higher-cardinality ones frequency-encoded, and near-unique free text is excluded — all before it reaches the model, with exactly what was encoded always labeled.',
  },
  {
    title: '3D spatial anomaly detection',
    body: 'UMAP + HDBSCAN turn an arbitrary numeric feature space into a navigable 3D point cloud, so structure and outliers are something you can see, not just a table of scores.',
  },
  {
    title: 'LLM-grounded explanations',
    body: 'Click any flagged point and a local model explains it in plain English — citing its actual deviation and cluster status, not generic filler.',
  },
  {
    title: 'Python SDK for headless workflows',
    body: 'iye.show() and iye.explain_anomaly() bring the same pipeline and narrative explanations to scripts and automated monitoring, no browser required.',
  },
]

export default function LandingApp() {
  return (
    <div className="landing-root">
      <div className="landing-hero-top">
        <a href="#top" className="landing-wordmark">
          <em>IYE</em> · Anomaly Detection Engine
        </a>
        <a href={`mailto:${CONTACT_EMAIL}`} className="landing-cta landing-cta--secondary">
          Get in touch
        </a>
      </div>

      <header className="landing-hero" id="top">
        <div className="landing-eyebrow">structural anomaly detection, explained in plain english</div>
        <h1 className="landing-h1">
          Drop a messy file. Get a <em>3D anomaly map</em> you can click and ask why.
        </h1>
        <p className="landing-sub">
          IYE auto-encodes whatever you throw at it, reduces it to a navigable 3D point cloud, flags
          the outliers, and explains each one in plain English — grounded in the actual data, not
          generic AI filler. Try the interactive demo below, no upload required.
        </p>
        <div className="landing-hero-cta-row">
          <a href={`mailto:${CONTACT_EMAIL}`} className="landing-cta landing-cta--primary">
            Get in touch
          </a>
          <a href="#how-it-works" className="landing-cta landing-cta--secondary">
            See how it works
          </a>
        </div>

        <Suspense fallback={<DemoWidgetFallback />}>
          <DemoWidget />
        </Suspense>
      </header>

      <section className="landing-section landing-section--tight">
        <div className="landing-eyebrow">the problem</div>
        <h2 className="landing-h2">Your outliers are hiding in a format your tools don&rsquo;t understand</h2>
        <p className="landing-p">
          Real operational data is rarely clean numeric columns — it&rsquo;s a mix of measurements,
          categories, and free text, and most anomaly-detection tooling either can&rsquo;t ingest it at
          all or needs a data science team to prep it first. IYE takes the file as it is: numeric
          columns pass through untouched, bounded categorical columns are encoded automatically, and
          only genuinely unusable free text is excluded — always labeled, never silently dropped.
        </p>
      </section>

      <section className="landing-section landing-section--tight" id="how-it-works">
        <div className="landing-eyebrow">how it works</div>
        <h2 className="landing-h2">Four steps, no configuration</h2>
        <div className="landing-steps">
          {STEPS.map((s) => (
            <div className="landing-step" key={s.n}>
              <div className="landing-step-number">{s.n}</div>
              <div className="landing-step-title">{s.title}</div>
              <div className="landing-step-body">{s.body}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-eyebrow">what&rsquo;s shipped</div>
        <h2 className="landing-h2">Built for people who work with real data, not demos</h2>
        <div className="landing-features">
          {FEATURES.map((f) => (
            <div className="landing-feature" key={f.title}>
              <div className="landing-feature-title">{f.title}</div>
              <div className="landing-feature-body">{f.body}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section landing-cta-section">
        <h2 className="landing-h2">Want to see it on your own data?</h2>
        <p className="landing-p">
          We&rsquo;re early — reach out and we&rsquo;ll walk you through it directly.
        </p>
        <a href={`mailto:${CONTACT_EMAIL}`} className="landing-cta landing-cta--primary">
          Get in touch
        </a>
        <p className="landing-cta-note">
          This opens an email draft to {CONTACT_EMAIL} — we don&rsquo;t yet have a form or CRM wired
          up, so a direct email is currently the only way to reach us.
        </p>
      </section>

      <footer className="landing-footer">
        <span>© {new Date().getFullYear()} IYE. All rights reserved.</span>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </footer>
    </div>
  )
}
