# ALTO Pro — Engineering Handoff

This document maps every file in the repository, separates the shared
infrastructure (billing, login, links, rate-limiting) from the roofing-specific
parts (roof measurement and roof pricing), and gives a file-by-file plan for
switching the product from roof measurements to real-estate comps.

> Repository note: this repo may contain a second unrelated project (an old
> "NANO" kids' screen-time app) at the repo root (index.html, js/, css/, ios/,
> nano-standalone.html, NANO README/ROADMAP). None of it runs in production and
> none of it is touched by ALTO Pro. NEVER edit those files for this product.

## Shared infrastructure — FREEZE, do not modify (inside tradetechpro/server/index.mjs unless noted)
- Stripe billing: /api/stripe/webhook (~82-133); env STRIPE_WEBHOOK_SECRET, STRIPE_PAYMENT_LINK
- Login / sessions: auth() (~730); getSessionContractor / useInvite / createInvite in db.mjs
- Magic-link token access: /invite/:token (~1517); db.createInvite/useInvite
- Staff auth + cookies: adminOk / closerOk / csOk (~754-766); reqCookies/setKeyCookie/clearKeyCookie; loginPage(); env ADMIN_KEY, CLOSER_KEY, CS_KEY
- IP rate-limiting / abuse caps: overQuota() (~1608) + db.incrCounter
- Custom domains / host routing: cfAddHostname() (~36), host-routing middleware (~140-170), canonBase() (~748), db.getContractorByDomain
- Accounts / data store: db.mjs entirely (contractors, sessions, invites, app_state, kv, metrics, leads, tasks, meetings). The leads/app_state JSON columns hold arbitrary data, so comps fit without a schema change.
- Build/deploy plumbing: vite.config.js, tailwind.config.js, postcss.config.js, package.json scripts, tradetechpro/index.html, .gitignore

## Roofing-specific — REPLACE for comps (inside tradetechpro/server/index.mjs)
- Google Solar roof measurement: solarLookup() (~244)
- Roof outline tracing: roofOutline() (~418), traceMaskOutline() (~308), regularizeOutline() (~361), simplifyPoly() (~288)
- Pitch math: pitchKeyFromDegrees() (~205), PITCH_FACTORS (~178)
- Roof demo data: MOCK_PROPERTIES / mockLookup() (~179-202)
- Property data (DUAL-USE, keep+expand): rentcastLookup() (~470)
- Parcel boundary (dual-use): parcelLookup() (~559), simplifyLatLng() (~550)
- The measurement endpoint: POST /api/lookup (~574) — returns roofArea, pitch, segments, outline. Biggest rewrite.
- Satellite image + roof overlay: GET /api/roofimg (~660)
- Quote pricing math: inside /api/widget/quote (~1652, the squares/matSquares/base block)
- AI secretary prompt: /api/widget/chat system prompt (~1642)
- Website copy: templates.mjs (DEFAULT_SERVICES + hero/section text), landingPage() (~1889), decks /ventas /demo /equipo /cierre
- Contractor app roof UI: tradetechpro/src/TradeTechPro.jsx (~293 roof/trace/measure references)

## Switching roof -> comps: files you MUST change
1. tradetechpro/server/index.mjs:
   - Replace POST /api/lookup (~574): call a comps source (RentCast AVM + sold comps via RENTCAST_KEY) instead of solarLookup+roofOutline. Return { value, valueRange, comps: [...], subject: {...} }.
   - Replace pricing block in POST /api/widget/quote (~1688): delete squares/matSquares/base math; output estimated value/range.
   - Repurpose rentcastLookup() (~470) into the primary data call (AVM + comps).
   - Rewrite /api/widget/chat system prompt (~1642) to a real-estate valuation assistant.
   - Delete/stub roof-only helpers once unused: solarLookup, roofOutline, traceMaskOutline, regularizeOutline, pitchKeyFromDegrees, PITCH_FACTORS, MOCK_PROPERTIES/mockLookup.
2. tradetechpro/src/TradeTechPro.jsx: remove roof trace/draw-squares/measurement screens; build comps result view (subject + comparable list + value). Keep app shell, navigation, login, payments, customers screens.
3. tradetechpro/server/templates.mjs: keep all three template structures and CSS; rewrite DEFAULT_SERVICES, hero/section text, and the iframe label from roofing to comps.
4. tradetechpro/server/index.mjs copy-only surfaces: landingPage(), /onboarding questions, /ventas /demo /equipo /cierre decks; dashboard labels in /admin /closer /cs that say techo/squares.
5. render.yaml / .env.example: keep all billing/auth/Cloudflare keys; add whatever comps API key you adopt.

## Files you must NEVER touch
- The frozen parts of index.mjs listed above (Stripe webhook, auth, cookies, loginPage, /invite/:token, overQuota, canonBase, cfAddHostname, host-routing).
- tradetechpro/server/db.mjs entirely.
- Build/deploy plumbing (vite, tailwind, postcss, package.json scripts, index.html, .gitignore).
- The entire NANO project at the repo root, if present.
