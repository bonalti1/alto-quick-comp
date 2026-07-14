# 👥 The team of 4 and their scripts

Minimum structure to operate the brand: **closer, appointment setter,
onboarding, customer service.** Everyone works inside the engine's tools —
nothing lives in loose spreadsheets.

## 1) Appointment setter (speed = everything)

**Their board:** GHL (contacts + conversations) and the sales-leads panel in
/admin. Every new lead arrives via GHL notification with name, phone,
brokerage and quiz answers.

**The golden rule: call within 5 minutes.** The lead already left their
number — the bot does NOT sell; the bot only keeps the lead warm until a
human calls.

**Cadence (messages fire automatically from the workflow; the setter calls):**
- **M1 · instant (automatic):**
  > Hi {{name}} 👋 This is the Quick Comp team. I saw you asked for info for
  > {{brokerage}}. We'll be calling you in a few minutes from this number 📞 —
  > pick up and in 5 minutes we'll show you how sellers land on your phone
  > from your own website. 🏡📲
- **Call 1 (setter, ≤5 min).** Goal: book the demo with the closer (or hand
  off hot if the closer is free).
- **M2 · after a missed call (automatic or manual):**
  > Just tried you 📞 It's Quick Comp (the comps app + your seller-lead
  > website). I'll try again in a bit — or tell me what time works and I'll
  > call you then. 👍
- **Call 2 · ~1 hour later.**
- **M3 · next morning:**
  > Hi {{name}}, so you can see it with your own eyes meanwhile: type any
  > address here and watch it value the home 👉 [your-domain]/w/alto-demo —
  > should I call you this afternoon or tomorrow morning? (Prefer to grab
  > your own slot? [calendar link])
- **Call 3 · day 2.** Then weekly nurture.

**Rules:** every message ends in a binary or concrete question ("afternoon or
morning?"). The calendar is a side door, never the pitch. If the lead says
they're not interested: stop the cadence (workflow goal) — never text after a
no.

## 2) Closer

**Their board:** /closer (create clients, deck, payment links, toolkit).

**Call flow:** open `/demo` from the portal (logged in = unlimited
valuations via DEMO_PASS) → run the 8 slides (see 04-sales.md) → close with
the payment link (P key) → create the account → send the access link (B key)
→ book the onboarding BEFORE hanging up.

**Rescue if $297 stings:** "Start with just the app at $67 and we add your
website when you're ready." A $67 rescued > a $297 lost; the upgrade is
natural once leads start landing.

## 3) Onboarding

**Their board:** /onboarding (pick the client → guided wizard).

**Call script (30–45 min):**
1. Business data: name, brokerage, license #, market/service area.
2. Brand: logo + brand color (the app shows a live preview of their documents
   re-skinned in their color — let them see it).
3. "Tell me your story" → ✨ Write with AI → review together.
4. Choose template (all live, on phone and computer).
5. Ask for 3–5 REAL photos by WhatsApp (headshot, sold listings — never stock
   photos posing as their work).
6. Train the site bot: hours, markets, FAQs (✨ generate with AI).
7. Domain: search + one-click buy, or connect theirs.
8. In the client's app: confirm their first name (the greeting uses it),
   and **install it together** — 📲 INSTALL button (Android native; iPhone
   step-by-step guide; if they opened from WhatsApp: first "Open in Safari").
9. Publish in 24–48h ("you watched it get born on the call; tomorrow it's on
   your domain") — never promise same-call publication.

## 4) Customer service

**Their board:** /cs — tickets drop in on their own when a client asks for a
change from the app (🌐 page / 🏡 widget / 😕 complaint / 🙋 other), plus
payment-event tasks (send access link after self-serve signups). Check the
board 2× a day.

**The loop per ticket:** read what they asked → **✨ Ver arreglo automático**
(the AI SHOWS before→after, nothing saved yet) → **✅ Sí, aplicar** if it
makes sense (or ⚡ Editar datos to do it by hand) → **🔔 Avisarle** (push
straight to their phone; WhatsApp fallback if they never enabled
notifications) → **✓ Hecho**. Complaints get a call or WhatsApp, never
buttons. The 🚨 attention list above the tickets is the morning worklist —
work it top to bottom.

## The conversation bot (the leash)

The GHL bot NEVER sells or books on its own. Full instructions to paste into
GHL: see **03-ghl.md → "The bot's leash"**.
