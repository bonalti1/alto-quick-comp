# 🎤 The presentation (/demo) and the close

## Before the call

- Open `/demo` **from the closer portal** (logged in): the app mockup carries
  the unlimited pass (`DEMO_PASS`) so the valuation cap never interrupts the
  call. The public /demo (no login) stays capped on purpose — that cap is a
  conversion moment for prospects.
- Language with the EN/ES button.

## The 9 slides (what each one is)

1. **Welcome** — "the tools that will work FOR you… any home valued from
   real comparable sales right here in 10 seconds."
2. **Who we are** — the origin story: Quick Comp was born inside **Alto
   Realty Group**, a South Texas real estate company tired of comping all
   the time; built for its own agents, opened to the public. (The team photo
   appears automatically once `landing/team.jpg` exists.)
3. **The problem** — listings are won at the kitchen table; walking in
   without the number loses them.
4. **Your app** — LIVE mockup, app-first for the wow: value the prospect's
   own address right there, in silence, and wait for the reaction.
5. **Your AI secretary** — LIVE: let them text it like a homeowner; a phone
   number typed in chat lands as a lead on the mockup phone in front of
   them. The strongest moment of the call.
6. **Your link on social** — LIVE Instagram-profile phone: tap the bio link
   and the real valuator opens. "Every post you make becomes a seller-lead
   machine."
7. **Your website** — the sample site LIVE (real scroll, real valuator).
   "Everybody has a website; almost nobody has one that sells."
8. **Your investment** — what it would cost separately → the plans.
9. **Let's begin** — the 4 steps, closing TODAY on the call.

## Closer hotkeys

- **P** → copies the $297 payment link (send by WhatsApp at close step 1).
- **B** → copies the welcome message (paste the client's access link in).
- **D** → copies the valuator-demo message to send prospects.
- **O** → opens the COMPLETE payment link.
- **C** → toggles the closer kit panel.
- Arrows ← → to navigate slides.

## The pricing ladder

| Plan | Price | What's included | For whom |
|---|---|---|---|
| PRO | $67/mo | Just the app (comps, CMAs, lending, tax, AI writers) | Any agent |
| WIDGET | $197/mo | App + the home-value tool on THEIR existing site | Agents with a site |
| COMPLETE | $297/mo | Everything done: site + AI + domain + app + valuator | Agents without a site (or wanting better) |

No setup fee on any plan. Stripe tags the plan by the exact amount — a new
price = new Payment Link + amount in the webhook's `PLAN_BY_AMOUNT` map.

## Closing plays

- **ROI:** "One listing commission is $6,000–$9,000 — ONE extra listing pays
  for years of this."
- **Rescue the $297:** drop to PRO $67 ("and we add your website when the
  leads justify it") instead of losing the sale.
- **Objection "how accurate is it?" (real feedback):** in full-disclosure
  states, values come from REAL recorded sold prices. In Texas nobody has
  sold prices — not even Zillow — so the app gives a defensible RANGE with a
  confidence score plus the county tax record; the agent's own MLS comps can
  be hand-picked for the final CMA. Honesty here WINS trust.
- **Silence after the price.** Say the investment and shut up — whoever
  speaks first loses.

## After the yes (same call)

1. P → payment link by WhatsApp → they pay with Stripe.
2. Create the account in /closer → copy the access link.
3. B → welcome + access link → "you're valuing homes today."
4. Book the onboarding before hanging up.
