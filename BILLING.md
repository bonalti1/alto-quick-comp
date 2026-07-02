# Quick Comp — Billing setup (Stripe)

Billing is **Payment Links + webhook** (no Stripe secret key needed in the app).
A realtor pays → Stripe calls our webhook → their account activates on its own.
Three plans, **no setup fees on any of them**:

| Plan | Price | What they get |
| --- | --- | --- |
| **Pro** | $67/mo | The Quick Comp app only |
| **Widget** | $197/mo | App + the valuator embedded in their existing website |
| **Complete** | $297/mo | App + widget + we build their website |

## How activation works (already built)

1. A realtor pays via the Stripe Payment Link (from the landing page "Start now"
   button, or sent by a closer during the call).
2. Stripe POSTs to `/api/stripe/webhook` (HMAC-verified with `STRIPE_WEBHOOK_SECRET`).
3. The app matches the payment to an account by **Stripe customer id → email → phone**,
   sets `payStatus: "ok"`, and the account/site/widget go live.
4. If the payment lands *before* the account exists, it's remembered (`paid:<phone|email>`)
   and the account auto-activates the moment it's created (closer flow).
   **Self-serve:** if the payment came from the landing page (no closer on a call),
   the account is **auto-created on the spot**, active and flagged — the admin
   clients table shows a "🆕 mandar acceso" pill until you send their invite link
   (click the pill to generate it). Money can never be taken with nothing created.
5. Later: `invoice.payment_failed` flags the account; `customer.subscription.deleted`
   pauses it. Cash/Zelle deals: activate manually from `/admin`.

## One-time Stripe configuration

### 1. Create the Payment Links (one per plan)
Stripe Dashboard → **Payment Links → New**, three times — each is just a
recurring subscription, **no one-time line items**:
- **Complete:** $297/month → set as `STRIPE_PAYMENT_LINK` in Render
- **Widget:** $197/month → set as `STRIPE_PAYMENT_LINK_WIDGET`
- **Pro:** $67/month → set as `STRIPE_PAYMENT_LINK_PRO`

On every link, under options, **collect customer phone number** (so
phone-matching works) and leave email collection on (default). A tier whose
link isn't set yet simply shows "book a call" on the sales page — safe to
roll them out one at a time.

### 2. Add the webhook endpoint
Stripe Dashboard → **Developers → Webhooks → Add endpoint**:
- **URL:** `https://YOUR-APP.onrender.com/api/stripe/webhook`
  (or `https://app.ROOT_DOMAIN/api/stripe/webhook` once your domain is live)
- **Events to send:**
  - `checkout.session.completed`
  - `invoice.paid` (and/or `invoice.payment_succeeded`)
  - `invoice.payment_failed`
  - `customer.subscription.deleted`
- Copy the **Signing secret** (`whsec_…`) → set it as `STRIPE_WEBHOOK_SECRET` in Render.

### 3. Render env vars
| Var | Value |
| --- | --- |
| `STRIPE_PAYMENT_LINK` | Complete ($297/mo) Payment Link URL |
| `STRIPE_PAYMENT_LINK_WIDGET` | Widget ($197/mo) Payment Link URL |
| `STRIPE_PAYMENT_LINK_PRO` | Pro ($67/mo) Payment Link URL |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_…` signing secret from step 2 |

All are already declared in `render.yaml` (as `sync: false`) — just fill them in.

## Verifying
- In Stripe → Webhooks, use **Send test event** (`checkout.session.completed`) — you
  should see a `200` and a log line `stripe webhook: checkout.session.completed → <slug> (ok)`.
- Or run a real test-mode payment with a Stripe test card (`4242 4242 4242 4242`).
- The account shows **Pagando** in `/admin` once activated.

## Notes
- The app makes **no outbound Stripe API calls** and stores **no card data** — it only
  verifies the webhook signature and reads the customer's email/phone. Lightweight and safe.
- To let clients update their card / cancel themselves, enable the Stripe **Billing Portal**
  in the Stripe dashboard and share that portal link — no app changes required.
