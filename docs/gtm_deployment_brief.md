# GTM Deployment Brief — Domain, Hosting & Email

**Date:** 2026-08-01
**Status:** Research + repo prep complete. No purchases, accounts, or DNS changes made — every action below that requires a login, payment, or DNS change is a CEO decision, not something this agent executed. See "Waiting on CEO" at the end.

---

## 1. Domain Status

**`openiye.com` is confirmed available**, checked directly against the authoritative `.com` registry (not a third-party lookup tool):

```
$ whois -h whois.verisign-grs.com openiye.com
No match for domain "OPENIYE.COM".
```

Corroborated by DNS: `openiye.com` currently has no `A` or `NS` records at all — it isn't parked, isn't resolving, isn't in use anywhere. This is a live check as of today; availability can change until it's actually registered, so treat this as "available now," not "reserved."

Since it's confirmed available (not "unavailable or unclear"), there's no need to fall back to alternatives — but two are noted below in case registration is delayed or the name doesn't clear at purchase time for some reason.

### Alternative options (backup only, not needed if `openiye.com` clears)

| Option | Approx. price | Notes |
|---|---|---|
| `iye.io` | ~$35–45/yr (.io pricing) | Shorter, common in dev-tool branding, but `.io` carries a slight "not a real company" connotation to some enterprise buyers — a consideration for a B2B sell. |
| `openiye.ai` | ~$75–100/yr, **2-year minimum term** | On-brand for an AI-adjacent product, but meaningfully pricier and .ai's wholesale cost just rose (~$160 wholesale as of March 2026), which registrars pass through. Only worth it if `.ai` branding specifically matters to positioning. |
| `getiye.com` / `useiye.com` | ~$10/yr (.com pricing) | Common SaaS naming pattern if `openiye.com` somehow doesn't clear; less distinctive than the existing name. |

**Recommendation: register `openiye.com`.** It's available, it's already the product's name throughout the codebase and docs, and `.com` is the safest default for a B2B buyer's trust.

Sources: [Domain Registrar Prices 2026: .com & .ai Compared](https://namebuddy.ai/guides/best-domain-registrars-2026), [.AI domain name prices going up $20](https://domainnamewire.com/2026/02/02/ai-domain-name-prices-going-up-20/)

---

## 2. Hosting / Deployment Recommendation

Compared for a static Vite multi-page build (`index.html` + `landing.html`, no server-side rendering, no backend hosted publicly — the real backend stays LAN-only by design):

| | Free tier | Paid tier | Custom domain + SSL | GitHub CI/CD |
|---|---|---|---|---|
| **Cloudflare Pages** | Unlimited bandwidth, 500 builds/mo | $20/mo (5,000 builds) | Automatic, free SSL | Auto-deploy on push to `main`, connect via CEO's GitHub login |
| **Vercel** | Generous but capped; a traffic spike can turn a $0 bill into a real one | $20/user/mo (Pro) | Automatic, free SSL | Same |
| **Netlify** | 100GB bandwidth, 300 build min/mo | $19/mo flat (Pro, unlimited team members) | Automatic, free SSL | Same |

**Recommendation: Cloudflare Pages.** For a pre-revenue GTM page, the deciding factor is *unlimited free bandwidth* — a landing page's whole point is to be shared (LinkedIn, HN, etc.), and Cloudflare is the only one of the three where a successful share can't produce a surprise bill. It also pairs naturally with Cloudflare Email Routing (Section 3) and Cloudflare DNS, so the domain's nameservers, hosting, and email routing can all live under one dashboard regardless of which registrar the domain itself is bought through — you don't need to register *through* Cloudflare to use their DNS/Pages/Email for free.

One caveat found during research and worth double-checking at purchase time: some sources say Cloudflare's own registrar currently only handles *transfers and renewals*, not new registrations — if still true, register the domain at a low-cost registrar (Spaceship or Porkbun, ~$10/yr, flat renewal pricing) and then point its nameservers to Cloudflare (free, ~5 minutes), rather than trying to register directly through Cloudflare.

**Connecting the repo requires the CEO's own GitHub login** — this agent cannot create that OAuth connection or grant Cloudflare access to the repo.

Sources: [Vercel vs Netlify vs Cloudflare Pages Pricing 2026](https://www.devtoolreviews.com/reviews/vercel-vs-netlify-vs-cloudflare-pages-pricing-comparison-2026), [Netlify vs Vercel vs Cloudflare Pages: The Honest 2026 Comparison](https://toolchase.com/blog/netlify-vs-vercel-vs-cloudflare/), [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite), [Vite 3 · Cloudflare Pages docs](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/)

---

## 3. Email Setup Recommendation

The landing page's CTA already points to `hello@openiye.com` — which matches the recommended domain, so **no code change is needed once the inbox is confirmed live.**

| | Cost | Setup effort | Drawback |
|---|---|---|---|
| **Cloudflare Email Routing + Gmail "Send As"** | Free | DNS records (auto-added by Cloudflare) + one verification email + a few minutes in Gmail settings | Receive-only natively — sending *as* `hello@openiye.com` requires Gmail's "Send mail as" workaround, which can occasionally show "on behalf of" or need SPF tuning to avoid spam flags |
| **ImprovMX Premium** | $9/mo or $90/yr | Similar DNS setup | Same fundamental limitation — a forwarder, not a real mailbox, unless paying for outbound SMTP |
| **Google Workspace** | $7/user/month | Full MX record migration, more setup | Fully solves sending — a real, native mailbox — but a recurring seat cost that isn't justified yet at pre-launch stage |

**Recommendation: Cloudflare Email Routing (free) + Gmail "Send As"** for now. It gets a real, monitored `hello@openiye.com` inbox live at zero cost, receiving into whatever Gmail inbox is already checked daily. The "on behalf of" sending nuance is a real but minor drawback for a small team's early outbound email — worth revisiting with **Google Workspace** once there's an actual team and the polish of native sending starts to matter.

Both DNS record changes and Cloudflare/Google account creation require the CEO's direct action.

Sources: [Cloudflare Email Routing: Free Custom Domain Email](https://mecanik.dev/en/posts/cloudflare-email-routing-free-custom-domain-email/), [ImprovMX vs Forward Email Comparison](https://forwardemail.net/en/blog/improvmx-vs-forward-email-email-service-comparison)

---

## 4. Repo Prep (done this sprint)

- **`frontend/wrangler.toml`** — Cloudflare Pages config with a placeholder project name (`iye-landing`), `pages_build_output_dir = "./dist"`, no real account/project ID anywhere. Documents the one dashboard field Cloudflare Pages still needs manually: **Root directory = `frontend`** (this is a monorepo — the buildable Vite project isn't at the repo root).
- **`frontend/public/_redirects`** — a Cloudflare Pages rewrite rule (`/ /landing.html 200`) so the public domain root serves the marketing page, not the operational 3D canvas app (which needs a LAN-local backend and was never meant to be public). Confirmed via `vite build` that this file is copied into `dist/_redirects` correctly by Vite's existing `public/` convention — no build changes needed.
- Verified `vite build` still produces the expected `dist/index.html` + `dist/landing.html` + `dist/_redirects` output, and the full frontend suite (148 tests), `tsc`, and `eslint` all stayed green after adding these files.
- **Not changed:** the `mailto:hello@openiye.com` CTA — per explicit instruction, left alone until the inbox is confirmed live.

---

## Waiting on CEO

Nothing below was done by this agent — each requires a login, a payment, or a DNS change only the CEO can make:

- [ ] Register `openiye.com` (confirmed available) at a registrar — Spaceship or Porkbun recommended (~$10/yr, flat renewal pricing, no bait-and-switch renewal hike)
- [ ] Create a free Cloudflare account (if one doesn't already exist)
- [ ] Point the domain's nameservers to Cloudflare (DNS change at the registrar)
- [ ] Connect the GitHub repo to Cloudflare Pages (requires CEO's GitHub login/OAuth grant)
- [ ] Set **Root directory = `frontend`** when creating the Cloudflare Pages project (the one manual dashboard field `wrangler.toml` can't fully cover for a monorepo)
- [ ] Enable Cloudflare Email Routing on the domain and verify the destination inbox via the confirmation email
- [ ] Set up Gmail "Send As" for `hello@openiye.com` if sending *from* that address (not just receiving) is wanted
- [ ] Confirm the `hello@openiye.com` inbox is actually live and monitored before treating it as real anywhere outside this landing page (business cards, other marketing, etc.)
- [ ] (Optional, later) Evaluate Google Workspace once there's a real team and native sending starts to matter
- [ ] (Optional, still-open gap from the 2026-07-30 sprint) Design a real `og:image` asset (1200×630) for LinkedIn/Twitter link previews — none exists yet
