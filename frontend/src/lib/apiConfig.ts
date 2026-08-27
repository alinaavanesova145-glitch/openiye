/**
 * apiConfig — single source of truth for how the frontend addresses the
 * backend. Derived from the page's own host, not hardcoded to localhost, so
 * the app works identically whether opened via localhost or a LAN IP (e.g.
 * http://192.168.1.4:3000) — see docs/idealization_report.md, 2026-07-14
 * sprint, Phase 2.
 *
 * Root cause this replaces: the REST client and useVectorStream each had
 * their own hardcoded `http://127.0.0.1:8050` / `ws://127.0.0.1:8050`
 * literal. `127.0.0.1` always means "this machine's own loopback" — when a
 * remote LAN device opens the Vite dev server's LAN URL, its browser's
 * `127.0.0.1` refers to *that device*, which has no backend running, so
 * every request/connection failed regardless of whether the real backend
 * host was reachable over the LAN.
 *
 * VITE_API_BASE / VITE_WS_BASE env vars override the derived values when
 * set (e.g. a non-standard deploy topology) and win over host-derivation.
 */

const BACKEND_PORT = 8050

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/** Pure — no env/window access — so it's trivially unit-testable without
 *  mocking globals or forcing a module re-evaluation. */
export function computeApiBase(protocol: string, hostname: string): string {
  return `${protocol}//${hostname}:${String(BACKEND_PORT)}`
}

/** Pure — swaps the http(s) scheme for its ws(s) counterpart. */
export function computeWsBase(apiBase: string): string {
  return apiBase.replace(/^http/, 'ws')
}

/** Pure — flags a VITE_API_BASE override with no `http://`/`https://`
 *  scheme (2026-08-27 sprint, finding #4). Without this, e.g.
 *  `VITE_API_BASE=192.168.1.4:8050` silently produces a fetch URL that's
 *  resolved as *relative* to the page instead of absolute, and a
 *  WebSocket URL that throws a SyntaxError — both of which manifest as a
 *  permanently-failing reconnect loop indistinguishable from "the backend
 *  just isn't running yet," with no hint that the env var itself is the
 *  actual cause. Returns a warning string to log, or null when the
 *  override is well-formed. */
export function validateApiBaseOverride(override: string): string | null {
  if (/^https?:\/\//.test(override)) return null
  return (
    `VITE_API_BASE is set to "${override}", which has no http:// or https:// scheme — ` +
    'requests built from it will not resolve as an absolute URL and will fail in a way ' +
    `that looks identical to "backend not running." Did you mean "http://${override}"?`
  )
}

/** Thin environment-reading wrapper around computeApiBase — not itself unit
 *  tested (same "prove the pure core, document the env-coupled boundary"
 *  pattern already used elsewhere in this codebase); reads
 *  import.meta.env/window.location once at module load. */
function deriveApiBase(): string {
  const override = import.meta.env.VITE_API_BASE
  if (override) {
    const warning = validateApiBaseOverride(override)
    // This project's eslint config doesn't restrict console usage (see
    // ErrorBoundary.tsx) — a misconfigured env var deserves to be loud.
    if (warning) console.warn(`[apiConfig] ${warning}`)
    return stripTrailingSlash(override)
  }
  if (typeof window === 'undefined') return computeApiBase('http:', '127.0.0.1')
  return computeApiBase(window.location.protocol, window.location.hostname)
}

function deriveWsBase(apiBase: string): string {
  const override = import.meta.env.VITE_WS_BASE
  if (override) return stripTrailingSlash(override)
  return computeWsBase(apiBase)
}

/** e.g. `http://192.168.1.4:8050` — protocol mirrors the page's own
 *  (http page -> http backend, https -> wss for the WS counterpart). */
export const API_BASE: string = deriveApiBase()

/** e.g. `ws://192.168.1.4:8050` (or `wss://` when the page is https). */
export const WS_BASE: string = deriveWsBase(API_BASE)

// ─── Public-deployment detection (2026-08-01 sprint) ───────────────────────────
// The backend is LAN-bound by design — its own CORS policy
// (backend/app/api/main.py's DEV_CORS_ORIGIN_REGEX) only ever allows
// localhost/127.0.0.1 and the RFC 1918 private ranges. This mirrors that
// exact same boundary on the frontend side, purely to decide whether to
// show an honest "this needs a local network connection" notice instead
// of a silently-stuck-disconnected canvas — see App.tsx's ViewportPanel.
// It does NOT gate any request; API_BASE/WS_BASE above are unaffected and
// still just derive from window.location either way. There is no
// production backend for a public host to fall back to.

const PRIVATE_HOSTNAME_PATTERN =
  /^(localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})$/

/** Pure — same "prove the core, document the env boundary" split as
 *  computeApiBase/computeWsBase above. */
export function isLikelyPublicHost(hostname: string): boolean {
  return !PRIVATE_HOSTNAME_PATTERN.test(hostname)
}

function deriveIsPublicHost(): boolean {
  if (typeof window === 'undefined') return false
  return isLikelyPublicHost(window.location.hostname)
}

/** True when the page itself was loaded from somewhere outside the
 *  private/local network the backend's own CORS policy would ever accept
 *  a request from (e.g. `openiye.pages.dev`) — meaning no backend can
 *  possibly be reachable here, by design, not as a bug. */
export const IS_PUBLIC_HOST: boolean = deriveIsPublicHost()
