# IYE — Fullstack Audit & Public-Deploy Plan

2026-08-27. Scope: everything not already covered by the prior 12 sprint
reports in `docs/idealization_report.md` (184→243 frontend tests, 124
backend tests, 0 npm vulnerabilities, CI green, site live on
`openiye.pages.dev`). This pass used four independent read-only audits
(backend, SDK, frontend, infra/deploy) plus manual verification of the
highest-severity claims against the actual source.

## TL;DR

The **frontend and landing page are solid** — one new finding worth
fixing (no error boundary), a few small ones. The **backend has real,
previously-undiscovered security issues** that matter a lot the moment
it's reachable from the public internet instead of just your LAN — most
importantly, it currently broadcasts every uploaded frame to *every*
connected client, not just the uploader. And **"deploy the backend
live" is not a small step**: today it only runs on localhost, CORS is
hard-locked to LAN addresses, there's no Dockerfile/Procfile, and the
Ollama LLM dependency needs ~5GB RAM that no free hosting tier gives you.
None of this is a dead end — it's a normal-sized project with three
realistic paths, laid out below.

---

## Part 1 — New findings

### Backend (critical/high)

1. **[Critical] No auth anywhere, and `/stream` broadcasts every upload
   to every connected client.** `StreamHub.broadcast()`
   (`backend/app/api/main.py:280-284`) fans every payload out to *all*
   active WebSocket connections — verified by reading the code directly.
   Today, on a LAN, that's "you" talking to "your own browser tab" so it
   doesn't matter. The moment this is public, two strangers who both
   open the app see **each other's uploaded data** in real time — actual
   cross-user data leakage, plus unmetered LLM cost anyone can trigger.
   This is the single most important thing to fix before any public
   backend deploy, regardless of which hosting path you pick below.
2. **[High] No request size limits.** A multi-million-element array
   POSTed to `/api/canvas/vectors` sails past the existing validation
   and goes straight into UMAP/HDBSCAN — unbounded memory/CPU per
   request, nothing to throttle it.
3. **[Medium-High] Unbounded narrative-task queue.** The concurrency
   limiter (4 at a time) doesn't limit how many requests can *queue up*
   behind it; since each Ollama call takes ~15-22s, a burst of
   anomaly-triggering uploads backs up fast.
4. **[Medium] Prompt injection via client-supplied feature name** — an
   unsanitized string from the request body lands verbatim in the
   Ollama prompt.
5. **[Low-Medium] Raw exception text returned to callers** on
   unanticipated numpy/UMAP/HDBSCAN errors — minor internals leak.
6. **[Medium, opt-in feature] `capture_frame()` blocks the whole event
   loop on synchronous disk I/O**, with no file-size cap, if
   `IYE_CAPTURE_PATH` is ever set in a hosted deployment.
7. **[Low/informational] Two legacy duplicate routes are dead code** —
   registered after the real handlers with the same path, so Starlette
   never reaches them (verified with a live repro). Harmless today,
   but a maintenance trap: nobody will notice if they silently rot.
8. **[Medium] The temporal engine's actual anomaly-regime logic
   (spike/velocity/drift classification + hysteresis) has zero real
   test coverage** — the one integration test never sends enough frames
   to leave the "warmup" branch, so the most algorithmically subtle
   code in the backend is unverified by the 124-test suite.
9. **[Low] `backend/main.py` hardcodes `reload=True` and binds only to
   `127.0.0.1`** — fine for local dev, means this specific launcher
   can't serve external traffic at all as-is.

### SDK (`sdk/iye/`)

1. **[High] `sdk/setup.py` is missing `fastapi`**, even though
   `iye/server.py` imports it unconditionally at module load —
   confirmed live: `import iye` fails in a clean env with only the
   declared dependencies. Anyone installing just the SDK (not the full
   backend) can't use it at all.
2. **[High] One overflowing/malformed numeric cell silently reclassifies
   an entire column as categorical**, with no warning — confirmed with
   `[[1.0],[2.0],[3.0],[1e400]]` turning a clean numeric column into
   meaningless one-hot dummies.
3. **[High] Large numeric values crash with an uncaught `OverflowError`**
   when mixed with any categorical column — confirmed with values around
   `1e200`; this becomes an unhandled 500, breaking the "always a
   structured 422" contract the rest of the backend deliberately keeps.
4. **[Medium/High] NaN/Inf coordinates silently defeat anomaly
   detection** for a whole axis (the existing zero-guard doesn't catch
   NaN) and serialize to the frontend as JSON `null`, which the
   frontend's type contract doesn't expect.
5. **[Medium/informational] `iye/server.py`'s entire `StreamHub` is
   dead code** — the real backend (`app/api/main.py`) reimplements its
   own separate broadcast hub; the SDK's copy has never run in
   production or CI. Not a bug per se, but worth deleting or
   documenting so nobody trusts it as the real path.
6. Two smaller low-severity findings (duplicate column names merging
   silently in attribution; an unlocked but GIL-safe global in the
   client SDK).

### Frontend

Mostly clean — this codebase has already been through a lot of scrutiny.
One real gap, a few small ones:

1. **[High] No React error boundary anywhere in the app.** Confirmed —
   `App.tsx` only wraps the 3D viewport in `<Suspense>`, never an error
   boundary. If the R3F render tree throws for any reason not already
   guarded (malformed geometry from bad UMAP output, a failed lazy-chunk
   load on a flaky connection), the **entire app white-screens** with no
   recovery UI, for both the canvas and the sidebar.
2. **[Medium]** A malformed WebSocket frame with a ragged coordinate
   sub-array (e.g. `[1,2]` instead of `[x,y,z]`) doesn't get rejected —
   it silently desyncs every point after it in that frame.
3. **[Low]** A JSON upload with a column literally named `__proto__`
   silently vanishes from the parsed matrix (JS's own prototype guard
   prevents anything unsafe — it's a silent-data-loss bug, not a
   security one).
4. **[Low]** Misconfiguring `VITE_API_BASE` without a scheme produces a
   permanently-failing reconnect loop that looks identical to "backend
   not running yet" — the real cause is never surfaced.
5. **[Low]** Neither "explain this point" hook cancels its in-flight
   request on component unmount (only on being superseded by a new
   click) — wastes a real LLM call, otherwise harmless.

No XSS: confirmed zero uses of `dangerouslySetInnerHTML` anywhere;
all LLM/user-controlled text goes through JSX's normal auto-escaping.

### Infra / deploy readiness

1. **[Critical for a public deploy] No Dockerfile, Procfile, or any
   container/process config exists anywhere in the repo.** A PaaS has
   nothing to build the backend from today.
2. **[Critical] CORS is hard-locked to `localhost`/LAN IPs only**
   (the code's own comment flags this as dev-only) — `openiye.pages.dev`
   wouldn't be allowed to talk to it as-is.
3. **[Critical] `backend/main.py` binds to `127.0.0.1`**, not
   `0.0.0.0`/`$PORT` — unreachable on any standard PaaS.
4. **[High] All server state lives in in-process Python globals**
   (connections, temporal engine, pending tasks) — caps any deploy to
   exactly one instance; autoscaling or a rolling restart would silently
   fragment clients and reset calibration.
5. **[High] The Ollama dependency has no path to public hosting as-is.**
   It's coupled to Ollama's specific request shape (not a generic LLM
   interface), and a real model needs ~5GB+ RAM — no free/hobby PaaS
   tier provides that, and none offer managed Ollama.
6. **[Medium]** `requirements.txt` (stale/unpinned) still exists
   alongside the real `requirements.lock.txt` — a PaaS's auto-detection
   could easily pick the wrong one.
7. **[Medium]** The numerics stack (umap-learn/hdbscan/numba) risks
   OOM and slow cold starts on constrained free-tier RAM; numba's
   writable JIT cache directory isn't addressed for typical read-only
   container filesystems.
8. **[Informational, corrected]** One earlier automated pass flagged
   "no `.gitignore` exists" — that's wrong, I checked directly: it
   exists, is thorough, and already excludes `.env*` files properly.
   No actual gap there.
9. **[Informational, clean]** A full-repo secret scan found no real
   committed credentials.
10. The live health endpoint (`main.py`, not the dead-code copy in
    `routes/health.py`) is real and liveness-probe-suitable.

---

## Part 2 — What "deploy the backend live" actually means

Two things are true at once:

**It's needed regardless of hosting choice:** items 1-4 under Backend
above (no auth/broadcast leak, no size limits, no CORS allowlist, no
`0.0.0.0` bind) are genuine problems the moment this backend is
reachable from the internet — they're not tied to any specific hosting
provider, so they get fixed no matter which path you pick below.

**The Ollama dependency is the real fork in the road.** It's the one
piece of this stack that doesn't fit neatly onto a free/cheap host, and
it changes which of the three options below makes sense.

## Part 3 — Three realistic paths

**A. Keep the backend LAN-only (today's actual, deliberate design).**
Every sprint report going back to 2026-08-01 treats "no public backend"
as intentional, not an oversight — that's exactly why `PublicHostNotice`
exists and reads "nothing is broken, there's just no backend to find
from here." The public product is the landing page + the static
interactive demo (`DemoWidget`, sample data, no backend needed), which
already fully works, live, today. Cost: $0. Work: none beyond the
security/bug fixes above (worth doing anyway, since your own machine on
your LAN is still a "public-ish" surface on shared wifi). This is the
lowest-risk option if the backend was never meant to be a public,
multi-user service.

**B. Swap Ollama for a hosted LLM API, deploy the backend to a normal
PaaS (Render/Fly.io/Railway free-to-cheap tier).** Requires: rewriting
the narrative-generation call to hit a hosted API instead of local
Ollama (a real code change, not huge), an API key from whichever
provider you pick, and picking up per-request LLM cost (usually small,
but real, and needs a payment method on file with that provider —
that's a step only you can do). In exchange you get a fully public,
always-on demo backend on a plausibly-free compute tier. Still needs
the security fixes, a Dockerfile, CORS allowlist, and the single-instance
limitation accepted (or a move to shared state, which is a bigger job).

**C. Keep Ollama, rent a VPS with real RAM (roughly $5-20+/mo).** Keeps
the "runs a local LLM" story intact, but is real recurring cost and real
infra work (Docker, a process manager, manually keeping Ollama alive
alongside the API process) — signing up and paying for that VPS is
again something only you can do.

I can't create accounts or spend money on your behalf (a firm policy
for me, not a project limitation), so B and C both need you to make an
account/payment decision before I can go further on them. Also worth
being honest about: option A costs nothing and ships today; B and C are
real projects on top of a working product, not quick add-ons.

## Part 4 — What I'd do right now, regardless of which path you pick

The backend security fixes (items 1-4 under "Backend" in Part 1) are
useful no matter what you decide, and I can start on those immediately
without needing any account or payment decision from you:
scope the broadcast hub to per-session instead of global, add a request
body size cap, tighten CORS to an explicit allowlist instead of the LAN
regex, and fix the SDK's `OverflowError`/NaN-handling/`setup.py`
dependency gap. Say the word and I'll get started, or tell me which of
A/B/C you want first and I'll sequence the work around that instead.
