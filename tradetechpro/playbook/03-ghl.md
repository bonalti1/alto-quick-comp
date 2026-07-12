# 🔌 GoHighLevel — exact recipes

GHL is the phone/SMS/WhatsApp rails and the setters' board. The engine sends
and receives leads over two bridges. **Rule:** the website ALWAYS lives in
the engine (never copy pages into GHL — they become dead copies); GHL
provides the number, A2P and the automations.

## Bridge 1 — OUT: site leads → GHL

Every engine account has an optional webhook (`data.webhook`). On the
**alto-ventas** account that webhook sends ALL sales leads (quiz, "get my
trial link", forms) to GHL.

**Recipe (workflow "LANDING PAGE WEBHOOK"):**
1. GHL → Automations → Create Workflow → trigger **Inbound Webhook** → copy
   the URL.
2. Engine admin → Quick Comp Ventas → **🤖 GHL** button → paste the URL (must
   start `https://`) → it must say "✓ Saved" and show "(connected)".
3. Fire a test lead from the landing → in GHL, Mapping Reference → "Check for
   new requests" → select the request → Save trigger.
4. Actions, in this order:
   - **Create/Update Contact** — fields FROM THE TRIGGER PAYLOAD (the
     "Inbound Webhook Trigger" section of the 🏷️ picker; if it doesn't
     appear, type the exact tag): First name =
     `{{inboundWebhookRequest.name}}`, Phone =
     `{{inboundWebhookRequest.phone}}`, Company =
     `{{inboundWebhookRequest.biz}}` (the brokerage). ⚠️ NEVER `{{user.*}}`
     (that's the assigned employee) nor `{{contact.*}}` inside the step that
     creates the contact (circular = empty).
   - **Add Tag** `quickcomp-landing`.
   - **Assign to user** (setters, round-robin).
   - **Internal Notification** — here `{{contact.name}}` / `{{contact.phone}}`
     DO work (the contact exists now) + the quiz lines:
     `Source: {{inboundWebhookRequest.src}}` ·
     `Focus: {{inboundWebhookRequest.work}}` ·
     `Licensed: {{inboundWebhookRequest.crew}}` ·
     `Deals/yr: {{inboundWebhookRequest.revenue}}` ·
     `Marketing: {{inboundWebhookRequest.marketing}}`.
   - **Send SMS** = the M1 message (see 02-team).
5. **Publish** (the classic miss: in Draft it receives and does nothing).

**Payload the engine sends:** `{source:"quick-comp", contractor:"alto-ventas",
id, name, phone, address, src:"landing"|"trial-app", biz, work, crew,
revenue, marketing}` (quiz fields only come with src=landing). If a new field
is added to the payload, GHL won't show it in the picker until you re-select
a new request as Mapping Reference (or type the tag by hand).

## Bridge 2 — IN: GHL channels → engine panel

WhatsApp / IG / Messenger are born in GHL; a workflow pushes them to the
panel:
- Trigger: Contact Created (or the channel's event).
- Action: **Webhook POST** to `https://YOUR-DOMAIN/api/hl/lead` with the
  secret `HL_WEBHOOK_SECRET` (query `?key=`, header `x-alto-key`, or body
  `key`) and custom data `channel` = whatsapp|instagram|facebook.
- The engine dedupes by phone (last 10 digits, 24h) and logs the channel.
- These leads are NOT re-forwarded to GHL (no loop, by design).

## Calendar

- `GHL_BOOKING_URL` (env) = the calendar's Scheduling Link → the landing
  shows it after the quiz, prefilled with name and phone.
- Availability wide or the bot/calendar offers silly hours: Mon–Sat 8–18,
  30-min slots, 1h minimum notice.
- Historic gotcha: if the bot goes quiet after booking → bot settings:
  uncheck "pause after appointment" and re-enable the conversation bot.

## The bot's leash (paste into the GHL bot instructions)

> You are the Quick Comp assistant. The team ALREADY has the agent's phone
> number and WILL CALL them — your only job is to keep them interested until
> that call. RULES: (1) You may only state this: Quick Comp gives a realtor
> instant comps and professional CMAs from their phone in seconds, plus a
> website with a home-value tool that captures seller leads 24/7 and sends
> them straight to their phone; plans from $67/mo, no setup fee. (2) For ANY
> other question (exact pricing, details, comparisons): answer that exactly
> that gets shown on the call with a live demo, and ask what time we should
> call. (3) Never invent data, never promise dates, never give the full demo
> by chat. (4) If they ask to self-book, send the calendar link. (5) Max 40
> words per reply, texting tone, warm and direct.

Extra proven blocks (Central time zone and convert for the client; "IF THEY
WANT TODAY" offer same day when there's a slot; accuracy objection → in
non-disclosure states the app gives a defensible RANGE with confidence and
the county record — no tool has Texas sold prices, not even Zillow) — keep
them in the sales bot prompt.

## SMS / A2P for clients (vision)

- **Today:** GHL subaccount per client who wants SMS; their A2P lives in GHL;
  the per-client webhook (🤖 GHL button on their account) feeds their
  automations.
- **Phase 2:** a "Messages" tab inside our app using the GHL API (our UI,
  their rails).
- **Phase 3 (100+ SMS clients):** Twilio Trust Hub direct. Not before —
  being the A2P compliance department is not a business at low scale.
