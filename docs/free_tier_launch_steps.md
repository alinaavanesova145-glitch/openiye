# Free-tier launch — get IYE's landing page live at $0

Companion to `docs/gtm_deployment_brief.md`, which assumes buying
`openiye.com` right away. This is the zero-cost variant: skip the domain
and email entirely for now, launch on Cloudflare Pages' free
`*.pages.dev` subdomain, and add the custom domain later whenever it's
worth the ~$10/yr. No step below costs anything or requires a payment
method.

## What this gets you

A live public URL serving `landing.html` (the self-contained marketing
page + interactive demo — no backend required), with the operational
`index.html` app showing the honest "local network required" notice
instead of hanging, and auto-redeploy on every future `git push` to
`main`.

## Steps (all in the Cloudflare dashboard, ~10 minutes)

1. **Push the two commits waiting locally.** From a terminal on your own
   Mac (not this session — it has no stored GitHub credentials):
   ```
   cd ~/Documents/openiye.com && git push origin main
   ```
   This carries the Cloudflare-routing/design-token sprint and the new
   `og-image.png` up to GitHub.

2. **Create a free Cloudflare account** at
   [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) —
   email + password, verify the email. No card required for the free
   plan.

3. In the dashboard: **Workers & Pages → Create → Pages → Connect to
   Git.** Authorize the GitHub OAuth prompt for your own account, then
   pick the `openiye` repo.

4. **Build settings** (matches `frontend/wrangler.toml`'s comments
   exactly):
   - Root directory: `frontend`
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Framework preset: Vite (or leave as None — the three fields above
     are what actually matter)

5. **Deploy.** Cloudflare assigns a free subdomain automatically —
   something like `openiye.pages.dev` or `<project-name>.pages.dev`
   (the project name is editable in the dashboard before or after
   first deploy; `wrangler.toml`'s `iye-landing` is just a placeholder,
   rename freely). Build takes ~1–2 minutes.

6. **Visit the assigned URL.** The root `/` should serve the landing
   page (via `_redirects`), with the interactive demo working with no
   backend. Visiting the bare app root without the marketing redirect
   (or opening `index.html` directly) should show the "this view needs
   your local network" notice, not a stuck spinner.

7. **Every future `git push origin main`** auto-triggers a new
   Cloudflare Pages build and deploy — no extra steps once step 3–4 are
   done once.

## One thing to fix once you know the real URL

`frontend/landing.html`'s `og:image`/`twitter:image` tags currently
point at `https://openiye.com/og-image.png`, assuming the eventual
custom domain. If you're launching on the free `*.pages.dev` subdomain
first, update those two `<meta>` tags to the actual `*.pages.dev` URL
(or leave them pointed at `openiye.com` if you plan to buy the domain
before sharing the link anywhere) — otherwise LinkedIn/Twitter link
previews will 404 on the image fetch. One-line edit, no rebuild logic
involved.

## Deliberately deferred (costs money, not needed to go live)

- **`openiye.com` domain (~$10/yr)** — confirmed available as of the
  2026-08-01 GTM brief; register at Spaceship or Porkbun whenever it's
  worth it, then add as a custom domain to the same Cloudflare Pages
  project (free, DNS auto-configured, no dashboard steps beyond what's
  already set up here).
- **`hello@openiye.com` email (Cloudflare Email Routing, free)** — needs
  the domain above first; see `docs/gtm_deployment_brief.md` §3 for the
  exact setup once that's in place.
