# Quick Comp — engine + business OS

English-first SaaS sold to realtors: instant comps/CMAs from the phone, plus a
lead-capture website whose home-value widget turns homeowners into seller
leads. One Express server serves the client PWA, all staff portals, the sales
landing, and every client website. The codebase is a **sibling of ALTO Pro**
(the contractor product): same engine patterns, different product — ALTO is
the master; fixes are ported from ALTO to here, pattern by pattern, never by
copying whole files. The human side of the machine (team roles, scripts, GHL
recipes, launch steps) lives in `tradetechpro/playbook/` — read it before
re-deriving any process.

## Map

- `tradetechpro/server/index.mjs` — the monolith: APIs, portals (/admin, /cs,
  /closer, /onboarding), sales landing (/ventas — also served at the bare
  ROOT_DOMAIN), sales deck (/demo), client widgets (/w/:slug), sample site
  (/ejemplo), shared client reports (/r), Stripe + Cloudflare + GHL
  integrations.
- `tradetechpro/server/templates.mjs` — the website factory: client-site
  templates rendered from data.
- `tradetechpro/server/valuation.mjs` — the comp engine: normalizes RentCast
  comps, weighted sold-$/sqft valuation, confidence label, radius/lookback
  auto-expansion.
- `tradetechpro/server/db.mjs` — Postgres (Supabase) with JSON-file fallback
  (`server/data/store.json`, mem + debounced persist).
- `tradetechpro/src/TradeTechPro.jsx` — the client PWA (React, vite → `dist/`):
  comps, lending, tax record, workspace (listing writer, social writer,
  appraisal packet, profile + brand color), leads inbox with mini-CRM.
- `tradetechpro/public/` — static assets (vite copies to dist on build).
- `tradetechpro/scripts/` — test suites: `valuation-test.mjs` + `smoke.mjs`
  (run by `npm test`). Run after EVERY change, before every commit.
- `tradetechpro/playbook/` — the business playbook (launch, team, GHL, sales,
  env catalog, backups).

## Non-negotiable conventions

1. **Branch**: develop on `claude/zen-carson-snpkxa`, push with
   `git push -u origin claude/zen-carson-snpkxa`. **Render deploys `main`** —
   work goes live only when a PR to main is merged (never open a PR unless
   the owner asks).
2. **Test live before committing.** Boot locally from `tradetechpro/`:
   `(ADMIN_KEY=testadmin CS_KEY=testcs CLOSER_KEY=testcloser DEMO_PASS=testpass PORT=8787 node server/index.mjs > /tmp/srv.log 2>&1 &)`
   then drive the affected flow with Playwright, then `npm test` (must pass).
3. **Small additive commits.** One ported item per commit; existing flows must
   not change behavior.
4. **App changes need `npm run build`** (dist is what the server serves) —
   dist/ itself is gitignored; Render builds on deploy.
5. English-first copy with full Spanish mirror (the `L`/`t` string objects) —
   every user-visible string exists in both languages. Realtor tone:
   professional, warm, no hype. Fair-Housing rules in all AI prompts (schools
   factually by name only, no neighborhood quality claims).
6. Secrets never in git — env catalog in `playbook/05-env.md`, values in
   Render + the owner's password manager.

## Domain knowledge that keeps getting re-learned

- **Built-in accounts** (protected from deletion, hidden from client lists):
  `alto-demo` (demo widget/valuator the landing embeds), `alto-ventas` (sales
  landing's own lead inbox — its GHL webhook forwards every landing lead to
  setters).
- **Demo caps**: anonymous app lookups 6/day per IP + 10 lifetime
  (`demolk:<ip>` kv counter); client accounts 40/day anti-runaway. The demo
  client-side counter is `alto_demo_meas` in localStorage. DEMO_PASS
  (`?pass=<DEMO_PASS>`) makes a device unlimited — the /demo deck injects it
  for keyed staff so sales calls never hit the cap.
- **Leads flow**: widget/quiz/trial → `/api/widget/lead` → saved +
  `forwardLead` → per-account GHL webhook (`data.webhook`, https only).
  Channel leads (WhatsApp/IG/Messenger) come IN from GHL via `/api/hl/lead`
  (HL_WEBHOOK_SECRET, phone dedupe 24h) and are NOT re-forwarded (no loop).
- **Site bot**: every published client site ships the AI chat bubble
  (templates.mjs `chatHtml`); `/api/widget/chat` answers as that realtor using
  `site.botFacts` (composed from the structured `site.botTrain` by the /cs
  trainer) as the ONLY extra truth; a phone typed in chat becomes a real lead
  (saved + forwarded + push). Staff preview (?preview=1) = test mode, no leads.
  Fair Housing rules are hard-coded in every bot prompt.
- **Stripe**: 3 payment links (env: STRIPE_PAYMENT_LINK[_PRO|_WIDGET]),
  webhook tags plan by exact amount paid ($67→pro, $197→widget,
  $297→complete, ±$10 tolerance), handles pay-before-account via
  `paid:<phone|email>` kv (48h), creates self-serve accounts from
  checkout.session.completed.
- **Comps data honesty**: Texas is a non-disclosure state — sold prices are
  estimated there, ranges are wider. Never claim pinpoint accuracy in
  non-disclosure states; the range + confidence + county tax record IS the
  pitch. A signed-in agent must never receive simulated comps (demo fallback
  is anonymous-only).
- **Realtor branding**: one brand hex in the profile drives every client-facing
  document (reports, invoices, /r shared pages). Client documents carry the
  REALTOR's brand, not Quick Comp's.
- **curl-ing portals**: `/admin?key=` redirects key→cookie; use
  `curl -s -L -c jar -b jar`.

## Current state / flags

- Stripe payment links live in Render (Jul 2026); STRIPE_WEBHOOK_SECRET
  recommended next.
- RentCast + Google keys live; AI via OPENAI_API_KEY (+ OPENAI_MODEL) or
  ANTHROPIC_API_KEY.
- Schools API: deferred on cost; Listing Writer has a manual schools field
  ready to auto-populate when a provider is picked.
- Deploy gap: Render deploys `main`; feature work accumulates on
  `claude/zen-carson-snpkxa` until the owner merges a PR.
