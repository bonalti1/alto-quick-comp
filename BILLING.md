# Quick Comp — Billing setup (Stripe)

Billing is **Payment Links + webhook** (no Stripe secret key needed in the app).
A realtor pays → Stripe calls our webhook → their account activates on its own.
Price: **$297/mo + $297 one-time setup**.

## How activation works (already built)

1. A realtor pays via the Stripe Payment Link (from the landing page "Start now"
   button, or sent by a closer during the call).
2. Stripe POSTs to `/api/stripe/webhook` (HMAC-verified with `STRIPE_WEBHOOK_SECRET`).
3. The app matches the payment to an account by **Stripe customer id → email → phone**,
   sets `payStatus: "ok"`, and the account/site/widget go live.
4. If the payment lands *before* the account exists, it's remembered (`paid:<phone|email>`)
   and the account auto-activates the moment it's created (closer flow).
5. Later: `invoice.payment_failed` flags the account; `customer.subscription.deleted`
   pauses it. Cash/Zelle deals: activate manually from `/admin`.

## One-time Stripe configuration

### 1. Create the Payment Link
Stripe Dashboard → **Payment Links → New**:
- **Setup fee:** one-time **$297** (add as a one-time line item)
- **Subscription:** **$297 / month** (recurring price)
- Under options, **collect customer phone number** (so phone-matching works) and
  leave email collection on (default).
- Copy the link URL → set it as `STRIPE_PAYMENT_LINK` in Render.

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
| `STRIPE_PAYMENT_LINK` | the Payment Link URL from step 1 |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_…` signing secret from step 2 |

Both are already declared in `render.yaml` (as `sync: false`) — just fill them in.

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
