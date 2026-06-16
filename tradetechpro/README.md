# Trade Tech Pro

Mobile-first estimating + invoicing app for Latino contractors. Bilingual (ES/EN),
with trade-specific calculators (concrete, roofing), measure-roof-by-address,
estimates, invoices, payment tracking, and an AI assistant.

## Run it

Two processes — the app and its small backend:

```bash
cd tradetechpro
npm install

# terminal 1 — backend (port 8787)
npm run server

# terminal 2 — app (port 5173)
npm run dev
```

The app also works with only `npm run dev` (no backend): it falls back to
built-in simulated data for the roof lookup, and the AI tab shows a
"couldn't connect" message.

## Demo mode vs live mode

The backend starts in **demo mode** — no API keys needed, all data simulated
(labeled "DEMO" in the UI). To go live, copy `server/.env.example` to
`server/.env` and fill in whichever keys you have. Each key independently
switches its feature from demo to live:

| Key | Unlocks | Where to get it |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | Real address autocomplete + automatic roof measurement (Places, Geocoding, Solar APIs) | console.cloud.google.com — enable Places API, Geocoding API, Solar API |
| `RENTCAST_API_KEY` | Real property data: beds, baths, sq ft, year built (50 free lookups/month) | app.rentcast.io/app/api |
| `ANTHROPIC_API_KEY` | The "Pregúntale a TTP" AI assistant | platform.claude.com |

Restart `npm run server` after editing `.env` — the startup log shows which
features are live.

## Architecture

- `src/TradeTechPro.jsx` — the whole app (single React component for now).
  Styling is Tailwind via CDN (loaded in `index.html`) plus inline brand tokens.
- `server/index.mjs` — Express backend: `/api/places` (autocomplete),
  `/api/lookup` (roof + property data), `/api/ai` (assistant). Every endpoint
  has a demo fallback, and the frontend additionally falls back to local
  simulated data if the backend isn't running at all.
- In dev, Vite proxies `/api/*` to the backend (see `vite.config.js`).

## Still simulated regardless of keys

- Sends (SMS/email) and payments are toasts — wiring Twilio/Stripe is a
  future step.
- Roof lookup in live mode depends on Google Solar API coverage; addresses
  without coverage fall back to a sq-ft-based estimate (when property data
  exists) or to the manual calculator.
