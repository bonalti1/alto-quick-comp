# 🔑 Environment variable catalog

VALUES never go in git — they live in Render (production) and in the owner's
password manager. This catalog says what each key is, where it comes from and
what breaks without it. `server/.env.example` mirrors it in .env format;
`render.yaml` declares them for Render blueprints.

## Portal access (SECRETS — unique and strong)

| Var | What it opens |
|---|---|
| `ADMIN_KEY` | /admin — the whole business. The most sensitive. |
| `CS_KEY` | /cs (ADMIN_KEY also enters) |
| `CLOSER_KEY` | /closer + /onboarding (ADMIN_KEY also enters) |
| `DEMO_PASS` | Unlimited demo mode (`?pass=`). Not guessable — every free valuation costs API money. |
| `HQ_KEY` | /hq — the owner's private cockpit (portfolio + idea board + AI partner). Nobody else's key opens it, not even ADMIN_KEY. |

⚠️ Rule: all keys distinct from each other and from any other account's
password, rotated if one ever appears in a screenshot or chat.

## Data

| Var | Notes |
|---|---|
| `DATABASE_URL` | Supabase Postgres. Without it: local JSON file (WIPED on every Render deploy). |

## Money (Stripe)

| Var | Notes |
|---|---|
| `STRIPE_PAYMENT_LINK_PRO` / `STRIPE_PAYMENT_LINK_WIDGET` / `STRIPE_PAYMENT_LINK` | One Payment Link per plan ($67 / $197 / $297 Complete). New price = new link + amount in `PLAN_BY_AMOUNT` (index.mjs). |
| `STRIPE_WEBHOOK_SECRET` | Signature for /api/stripe/webhook (paid → activate + tag plan; failed → grace; canceled → pause). |

## Product APIs

| Var | Notes |
|---|---|
| `GOOGLE_MAPS_API_KEY` | Server-side: Places + Geocoding + Static Maps. |
| `GOOGLE_MAPS_BROWSER_KEY` | Domain-restricted key for the browser map. |
| `RENTCAST_API_KEY` | Comps + property records (owner, taxes, beds/sqft). THE core data key. |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | AI (listing writer, social writer, site bots, report summaries). |
| `ANTHROPIC_API_KEY` | Alternative AI provider (takes precedence when set). |
| `REGRID_API_KEY` | Parcel boundaries (dormant until purchased). |

## Notifications

| Var | Notes |
|---|---|
| `STAFF_WEBHOOK_URL` | Slack/Discord-compatible webhook — pings the team on payments and sales leads. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web push (the lead buzz on the realtor's phone). Generate once: `npx web-push generate-vapid-keys`; SUBJECT is `mailto:you@domain`. Without them the 🔔 card says "coming soon". |

## Client domains (Cloudflare / Render)

| Var | Notes |
|---|---|
| `ROOT_DOMAIN` / `APP_HOST` | Set once DNS is live: bare-domain sales page, app.* host, client subdomains. |
| `CF_API_TOKEN` / `CF_ZONE_ID` / `CF_CNAME_TARGET` | Cloudflare for SaaS: client custom domains with auto-SSL. |
| `CF_ACCOUNT_ID` + `CF_REG_*` (NAME/ORG/EMAIL/PHONE/STREET/CITY/STATE/ZIP/COUNTRY) | One-click domain BUY via Cloudflare Registrar from onboarding. Needs the token to have Registrar write permission + a billing profile with payment method + accepted registration agreement (one-time dashboard setup). Phone format `+1.9565551234`. Without these: search still works (no prices, no buy button). |
| `RENDER_API_KEY` / `RENDER_SERVICE_ID` / `RENDER_ORIGIN` | Server registers custom domains with the Render service (routing + SSL). ORIGIN = host bought domains CNAME to (defaults to CF_CNAME_TARGET). |

## GHL / marketing

| Var | Notes |
|---|---|
| `HL_WEBHOOK_SECRET` | Shared secret of the GHL→engine bridge (/api/hl/lead). |
| `GHL_BOOKING_URL` | Calendar Scheduling Link (embedded after the quiz). |
| `META_PIXEL_ID` | Meta pixel on public pages. |

## Misc

| Var | Notes |
|---|---|
| `ADMIN_LANG` | Default admin portal language. |
| `PORT` | Local port (Render injects its own). |

## Local development

Boot from `tradetechpro/`:

```
(ADMIN_KEY=testadmin CS_KEY=testcs CLOSER_KEY=testcloser DEMO_PASS=testpass PORT=8787 node server/index.mjs > /tmp/srv.log 2>&1 &)
```

Then `npm test` (valuation + smoke suites — all green before committing).
Demo-cap counters (`demolk:*`) persist in `server/data/store.json` — local
test runs burn them; clear those keys (server stopped) if anonymous lookups
mysteriously 429.
