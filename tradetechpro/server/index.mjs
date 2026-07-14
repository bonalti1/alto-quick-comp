/*
 * Quick Comp backend.
 *
 * Core endpoints, each with a demo fallback so the app works with no keys:
 *   GET  /api/health  — which features are live vs demo
 *   GET  /api/places  — address autocomplete (Google Places, else mock list)
 *   POST /api/lookup  — property data + comps (Google Geocoding + RentCast,
 *                       else simulated data)
 */
import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import webpush from "web-push";
import { fromArrayBuffer } from "geotiff";
import proj4 from "proj4";
import * as db from "./db.mjs";
import { renderSite } from "./templates.mjs";
import { normalizeRentcastComps, calculateQuickCompValue } from "./valuation.mjs";

const PORT = process.env.PORT || 8787;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const RENTCAST_KEY = process.env.RENTCAST_API_KEY || "";
const REGRID_KEY = process.env.REGRID_API_KEY || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const CLOSER_KEY = process.env.CLOSER_KEY || "";
const CS_KEY = process.env.CS_KEY || "";
// Staff demo pass (ALTO pattern): ?pass=<DEMO_PASS> makes a device unlimited
// so a live sales call never dies at the anonymous-demo cap. Unset = off.
const DEMO_PASS = process.env.DEMO_PASS || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
// Cloudflare for SaaS (custom client domains). Off until configured.
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";
const CF_ZONE_ID = process.env.CF_ZONE_ID || "";
// This business's own domain. Leave it UNSET and everything serves on the
// onrender/localhost host exactly as in development. Set ROOT_DOMAIN (e.g.
// "quickcomp.com") once DNS is live to turn on: the bare-domain sales page,
// <slug>.ROOT_DOMAIN client subdomains, custom-domain CNAMEs, and canonical
// links. APP_HOST is where the app/dashboard lives (defaults to app.ROOT_DOMAIN).
const ROOT_DOMAIN = String(process.env.ROOT_DOMAIN || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const APP_HOST = String(process.env.APP_HOST || (ROOT_DOMAIN ? `app.${ROOT_DOMAIN}` : "")).toLowerCase();
const CF_CNAME_TARGET = process.env.CF_CNAME_TARGET || APP_HOST || "";
// Register a client's custom hostname with Cloudflare (auto SSL). Safe no-op
// until CF_API_TOKEN + CF_ZONE_ID are set in the environment.
async function cfAddHostname(hostname) {
  if (!CF_API_TOKEN || !CF_ZONE_ID) return { ok: false, reason: "cf_off" };
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/custom_hostnames`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ hostname, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: "cf_error", errors: j.errors };
    return { ok: true, id: j.result?.id, status: j.result?.status };
  } catch (e) { return { ok: false, reason: e.message }; }
}
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ timeout: 30000, maxRetries: 1 }) : null;
const aiLive = !!(anthropic || OPENAI_KEY);

/* Every outbound provider call MUST have a timeout. Node's fetch has none, so a
 * slow (not down) upstream — RentCast, Google, an AI endpoint — would otherwise
 * hang the request handler for the full socket lifetime; under load these pile
 * up until the process stops responding. fetchT aborts after `ms` and the
 * caller's existing catch turns it into the normal not-found/demo fallback. */
async function fetchT(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

/* One helper for both AI providers — Anthropic when ANTHROPIC_API_KEY is set,
 * else OpenAI when OPENAI_API_KEY is set. Same input, returns plain text. */
async function aiChat({ system, messages, maxTokens = 1024 }) {
  if (anthropic) {
    const msg = await anthropic.messages.create({ model: "claude-opus-4-8", max_tokens: maxTokens, system, messages });
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  const r = await fetchT("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  }, 30000); // AI is slower than data lookups
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "";
}

const app = express();
// Behind Render's proxy: trust X-Forwarded-* so req.protocol is https and
// generated links (invites, OG tags) don't come out as http://.
app.set("trust proxy", 1);
const IS_PROD = !!(process.env.RENDER || process.env.NODE_ENV === "production");

/* ── Stripe billing webhook ──
 * Registered BEFORE the JSON parser because Stripe signatures are computed
 * over the raw body. Flow: invoice paid → reactivate instantly · payment
 * failed → 7-day grace countdown · subscription canceled → pause.
 * Configure in Stripe: endpoint /api/stripe/webhook, then put the signing
 * secret in Render as STRIPE_WEBHOOK_SECRET. */
const STRIPE_WH_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
/* Map a Stripe payment amount (cents) to the plan the client bought, so
 * fulfillment, MRR, and the dashboard all know which of the three tiers it is.
 * No setup fees → the amount equals the monthly. Tolerance absorbs proration
 * and tax rounding; an unrecognized amount stays null (never guessed). */
const PLAN_BY_AMOUNT = [
  { plan: "pro", dollars: 67 },
  { plan: "widget", dollars: 197 },
  { plan: "complete", dollars: 297 },
];
function planFromCents(cents) {
  const d = Number(cents) / 100;
  if (!Number.isFinite(d) || d <= 0) return null;
  let best = null, bestDiff = Infinity;
  for (const p of PLAN_BY_AMOUNT) { const diff = Math.abs(d - p.dollars); if (diff < bestDiff) { bestDiff = diff; best = p; } }
  // accept only within $10 of a known tier — otherwise we don't know the plan
  return best && bestDiff <= 10 ? { plan: best.plan, planAmount: best.dollars } : null;
}
// Pull the paid amount out of whichever Stripe object this event carries.
function amountCentsOf(obj) {
  return obj.amount_total ?? obj.amount_paid ?? obj.amount_due ?? obj.plan?.amount ?? obj.lines?.data?.[0]?.amount ?? null;
}

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!STRIPE_WH_SECRET) return res.status(503).json({ error: "webhook not configured" });
  try {
    const sig = String(req.headers["stripe-signature"] || "");
    const t = /t=(\d+)/.exec(sig)?.[1];
    const v1s = [...sig.matchAll(/v1=([a-f0-9]+)/g)].map((m) => m[1]);
    const expected = crypto.createHmac("sha256", STRIPE_WH_SECRET).update(`${t}.${req.body}`).digest("hex");
    const ok = t && v1s.some((v) => { try { return crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)); } catch { return false; } });
    if (!ok || Math.abs(Date.now() / 1000 - Number(t)) > 600) return res.status(400).json({ error: "bad signature" });
  } catch { return res.status(400).json({ error: "bad signature" }); }

  let event;
  try { event = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).json({ error: "bad json" }); }
  // Idempotency: Stripe delivers at-least-once, so the same event can arrive
  // twice (or race itself). Process each event id only once — this alone kills
  // the duplicate self-serve accounts that retries would otherwise create.
  if (event.id) {
    const seen = await db.kvGet(`evt:${event.id}`, 7 * 24 * 3600 * 1000).catch(() => null);
    if (seen) return res.json({ ok: true, duplicate: true });
    await db.kvSet(`evt:${event.id}`, { at: new Date().toISOString(), type: event.type }).catch(() => {});
  }
  const obj = event.data?.object || {};
  const customerId = obj.customer || null;
  const planInfo = planFromCents(amountCentsOf(obj)); // {plan, planAmount} | null
  const email = String(obj.customer_email || obj.customer_details?.email || "").toLowerCase();
  const phone = String(obj.customer_phone || obj.customer_details?.phone || "").replace(/\D/g, "").replace(/^1/, "");

  // Match the Stripe customer to a contractor: stored id first, then email, then phone
  const list = await db.listContractors();
  const match =
    list.find((c) => c.data?.stripeCustomer && customerId && c.data.stripeCustomer === customerId) ||
    list.find((c) => email && String(c.data?.profile?.email || "").toLowerCase() === email) ||
    list.find((c) => phone && [c.phone, c.data?.profile?.phone].some((p) => String(p || "").replace(/\D/g, "").replace(/^1/, "") === phone));
  if (!match) {
    // Payment often arrives BEFORE the closer finishes creating the client — remember it
    // so the new account activates itself on creation.
    if (["invoice.paid", "invoice.payment_succeeded", "checkout.session.completed"].includes(event.type)) {
      const marker = { customerId, email, phone, ...(planInfo || {}) };
      if (phone) await db.kvSet(`paid:${phone}`, marker).catch(() => {});
      if (email) await db.kvSet(`paid:${email}`, marker).catch(() => {});
    }
    // Self-serve purchase from the landing page: nobody is on a call, so no
    // account will ever be created by hand. Create it NOW, active, flagged
    // self-serve — the admin table shows "mandar acceso" until an invite is
    // sent (money taken with nothing delivered must be impossible).
    if (event.type === "checkout.session.completed" && (email || phone)) {
      const name = String(obj.customer_details?.name || (email ? email.split("@")[0] : "") || phone).slice(0, 80);
      const c = await db.createContractor({ name, phone });
      await db.saveContractorData(c.id, {
        payStatus: "ok",
        selfServe: true,
        ...(planInfo || {}),
        ...(customerId ? { stripeCustomer: customerId } : {}),
        profile: { biz: name, ...(email ? { email } : {}), ...(phone ? { phone } : {}) },
      });
      console.log(`stripe webhook: self-serve signup → created ${c.slug} [${planInfo?.plan || "plan?"}] (send their access link!)`);
      await queueTask(c.slug, "💰 Enviar link de acceso", `${name} pagó ${planInfo?.plan || "plan?"} ($${planInfo?.planAmount || "?"}) por la página. Genera su link en /admin → 🆕 mandar acceso y mándaselo por WhatsApp. Contacto: ${email || phone}.`);
      notifyStaff(`💰 NEW self-serve signup: ${name} [${planInfo?.plan || "plan?"} $${planInfo?.planAmount || "?"}] — ${email || phone}. SEND THEIR ACCESS LINK from /admin → 🆕 mandar acceso.`);
      return res.json({ ok: true, created: c.slug, plan: planInfo?.plan || null });
    }
    console.log("stripe webhook: no contractor match for", event.type, customerId, email, phone);
    return res.json({ ok: true, matched: false });
  }

  const data = { ...(match.data || {}) };
  if (customerId) data.stripeCustomer = customerId;
  if (["invoice.paid", "invoice.payment_succeeded", "checkout.session.completed"].includes(event.type)) {
    delete data.status; // unpause — access back the second the card goes through
    delete data.payFailedAt;
    data.payStatus = "ok";
    if (planInfo) { data.plan = planInfo.plan; data.planAmount = planInfo.planAmount; } // remember which tier they pay for
  } else if (event.type === "invoice.payment_failed") {
    data.payStatus = "failed";
    data.payFailedAt = data.payFailedAt || new Date().toISOString();
  } else if (event.type === "customer.subscription.deleted") {
    data.status = "paused";
    data.payStatus = "canceled";
  }
  await db.saveContractorData(match.id, data);
  console.log(`stripe webhook: ${event.type} → ${match.slug} (${data.payStatus}${data.status ? ", " + data.status : ""})`);
  if (event.type === "invoice.payment_failed") notifyStaff(`⚠️ Payment FAILED: ${match.name} (${match.slug}). Grace period started — follow up.`);
  else if (event.type === "customer.subscription.deleted") notifyStaff(`🔻 Subscription canceled: ${match.name} (${match.slug}) — account paused.`);
  res.json({ ok: true });
});

app.use(express.json({ limit: "300kb" }));
app.use(express.urlencoded({ extended: false }));

// The bare brand domain shows the sales landing page; the app lives on the
// app.* host (and keeps working on the onrender.com address). No-op until
// ROOT_DOMAIN is set.
app.use((req, res, next) => {
  const h = String(req.hostname || "").toLowerCase();
  if (ROOT_DOMAIN && (h === ROOT_DOMAIN || h === `www.${ROOT_DOMAIN}`) && (req.path === "/" || req.path === "/index.html")) {
    return res.send(landingPage(req));
  }
  next();
});

/* ── Client website host-routing ──
 * A client's site lives at APP_HOST/site/<slug>. When a request arrives on a
 * client's own domain (custom .com via Cloudflare for SaaS) or on
 * <slug>.ROOT_DOMAIN, we serve that client's site by rewriting the root path
 * to /site/<slug>. Our own hosts and all non-root paths (assets, /api, /w, …)
 * pass straight through untouched. With ROOT_DOMAIN unset, only custom domains
 * registered in the DB are matched — onrender/localhost serve normally. */
const OUR_HOSTS = new Set(["localhost", "127.0.0.1", ""]);
if (ROOT_DOMAIN) { OUR_HOSTS.add(ROOT_DOMAIN); OUR_HOSTS.add(`www.${ROOT_DOMAIN}`); }
if (APP_HOST) OUR_HOSTS.add(APP_HOST);
function reqHost(req) {
  return String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].split(":")[0].trim().toLowerCase();
}
app.use(async (req, res, next) => {
  const h = reqHost(req);
  if (OUR_HOSTS.has(h) || h.endsWith(".onrender.com")) return next();
  // only take over real page navigations; let assets/api/widget pass through
  if (req.method !== "GET" || (req.path !== "/" && req.path !== "/index.html")) return next();
  try {
    let slug = null;
    if (ROOT_DOMAIN && h.endsWith(`.${ROOT_DOMAIN}`)) slug = h.slice(0, -(ROOT_DOMAIN.length + 1)); // <slug>.ROOT_DOMAIN
    else { const c = await db.getContractorByDomain(h); slug = c?.slug || null; }
    if (slug) { req.url = "/site/" + encodeURIComponent(slug); }
  } catch (e) { console.error("host routing:", e.message); }
  next();
});

// Serve the built app (run `npm run build` first) so one process can host
// everything in production; in dev, Vite serves the app and proxies /api here.
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
app.use(express.static(dist));

/* ── Demo data (mirrors the frontend's offline fallback) ── */
const PITCH_FACTORS = { 3: 1.031, 4: 1.054, 5: 1.083, 6: 1.118, 7: 1.158, 8: 1.202, 9: 1.25, 10: 1.302, 12: 1.414 };
const MOCK_PROPERTIES = [
  { addr: "456 Oak Dr, Rio Grande City, TX", roofArea: 2460, pitch: "6", stories: 1, beds: 3, baths: 2, sqft: 1850, year: 2004, segments: 4 },
  { addr: "210 Mesquite Ln, Roma, TX", roofArea: 3120, pitch: "4", stories: 1, beds: 4, baths: 2, sqft: 2400, year: 1998, segments: 6 },
  { addr: "88 Palma St, La Grulla, TX", roofArea: 1690, pitch: "5", stories: 1, beds: 2, baths: 1, sqft: 1240, year: 1987, segments: 2 },
  { addr: "1204 Cenizo Ct, Rio Grande City, TX", roofArea: 3890, pitch: "8", stories: 2, beds: 4, baths: 3, sqft: 2980, year: 2019, segments: 8 },
  { addr: "35 Rancho Viejo Rd, Garciasville, TX", noData: true },
];

const hashAddr = (s) => { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 99991; return h; };

function mockLookup(addr) {
  const known = MOCK_PROPERTIES.find((p) => p.addr.toLowerCase() === addr.toLowerCase());
  if (known) return known.noData ? null : { ...known };
  const h = hashAddr(addr.toLowerCase());
  const stories = h % 5 === 0 ? 2 : 1;
  const sqft = 1100 + (h % 1900);
  const pitch = ["4", "5", "6", "8"][h % 4];
  return {
    addr, stories, sqft, pitch,
    beds: 2 + (h % 3), baths: 1 + (h % 3 === 0 ? 1 : 0),
    year: 1975 + (h % 50), segments: 2 + (h % 7),
    roofArea: Math.round((sqft / stories) * PITCH_FACTORS[pitch] * 1.12),
  };
}

/* Convert a roof pitch in degrees to the nearest x/12 key the app uses. */
function pitchKeyFromDegrees(deg) {
  const rise = Math.tan((deg * Math.PI) / 180) * 12;
  let best = "6", bestDiff = Infinity;
  for (const k of Object.keys(PITCH_FACTORS)) {
    const d = Math.abs(rise - Number(k));
    if (d < bestDiff) { bestDiff = d; best = k; }
  }
  return best;
}

/* ── Live lookups ── */
async function geocode(address) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`;
  const j = await (await fetchT(url)).json();
  const r = j.results?.[0];
  if (!r) return null;
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, formatted: r.formatted_address };
}

/* GPS coordinates → street address (the contractor parked outside the job) */
async function reverseGeocode(lat, lng) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_KEY}`;
  const j = await (await fetchT(url)).json();
  return j.results?.[0]?.formatted_address || `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}

/* Place details give the exact building location the user picked in
 * autocomplete — more accurate than re-geocoding the address text, which can
 * land on a nearby outbuilding. */
async function placeDetails(placeId) {
  const r = await fetchT(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: { "X-Goog-Api-Key": GOOGLE_KEY, "X-Goog-FieldMask": "location,formattedAddress" },
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j.location) return null;
  return { lat: j.location.latitude, lng: j.location.longitude, formatted: j.formattedAddress || "" };
}

async function solarLookup(lat, lng) {
  const url = `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${GOOGLE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null; // 404 = no building data for this location
  const j = await res.json();
  const sp = j.solarPotential;
  if (!sp?.wholeRoofStats?.areaMeters2) return null;
  const segsRaw = sp.roofSegmentStats || [];
  // Area-weighted average pitch across roof segments
  let pitchDeg = 22, totalArea = 0, weighted = 0;
  for (const s of segsRaw) {
    const a = s.stats?.areaMeters2 || 0;
    totalArea += a;
    weighted += (s.pitchDegrees || 0) * a;
  }
  if (totalArea > 0) pitchDeg = weighted / totalArea;
  // Per-section detail for the measurement overlay (largest first, capped)
  const segs = segsRaw
    .map((s) => ({
      area: Math.round((s.stats?.areaMeters2 || 0) * 10.7639),
      pitch: Math.max(0, Math.round(Math.tan(((s.pitchDegrees || 0) * Math.PI) / 180) * 12)),
      box: s.boundingBox
        ? [s.boundingBox.sw.latitude, s.boundingBox.sw.longitude, s.boundingBox.ne.latitude, s.boundingBox.ne.longitude]
        : null,
    }))
    .filter((s) => s.area >= 25 && s.box) // skip slivers that just clutter the overlay
    .sort((a, b) => b.area - a.area)
    .slice(0, 8);
  const bb = j.boundingBox;
  return {
    roofArea: Math.round(sp.wholeRoofStats.areaMeters2 * 10.7639),
    pitch: pitchKeyFromDegrees(pitchDeg),
    segments: segsRaw.length || 1,
    segs,
    bbox: bb ? [bb.sw.latitude, bb.sw.longitude, bb.ne.latitude, bb.ne.longitude] : null,
    imageryDate: j.imageryDate ? `${j.imageryDate.month}/${j.imageryDate.year}` : null,
    imageryYear: j.imageryDate?.year || null,
    quality: j.imageryQuality || null,
  };
}

/* ── True roof outline from the Solar API building mask ──
 * dataLayers returns a GeoTIFF where roof pixels are 1. We trace the boundary
 * of the building at the center and simplify it to a clean polygon. */
function simplifyPoly(pts, eps) {
  const dseg = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (!dx && !dy) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  const dp = (seg) => {
    if (seg.length < 3) return seg;
    let maxD = 0, idx = 0;
    for (let i = 1; i < seg.length - 1; i++) {
      const d = dseg(seg[i], seg[0], seg[seg.length - 1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD <= eps) return [seg[0], seg[seg.length - 1]];
    return [...dp(seg.slice(0, idx + 1)).slice(0, -1), ...dp(seg.slice(idx))];
  };
  return dp(pts);
}

function traceMaskOutline(data, w, h) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] > 0;
  // nearest roof pixel to the image center
  const cx = w >> 1, cy = h >> 1;
  let sx = -1, sy = -1;
  outer: for (let r = 0; r < Math.max(w, h); r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (at(cx + dx, cy + dy)) { sx = cx + dx; sy = cy + dy; break outer; }
    }
  }
  if (sx < 0) return null;
  // flood-fill the building the pixel belongs to (ignore neighbors in frame)
  const comp = new Uint8Array(w * h);
  const stack = [[sx, sy]];
  comp[sy * w + sx] = 1;
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (at(nx, ny) && !comp[ny * w + nx]) { comp[ny * w + nx] = 1; stack.push([nx, ny]); }
    }
  }
  const inC = (x, y) => x >= 0 && y >= 0 && x < w && y < h && comp[y * w + x] === 1;
  // boundary start: topmost-left pixel of the component
  let bx = -1, by = -1;
  scan: for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (comp[y * w + x]) { bx = x; by = y; break scan; }
  // Moore-neighbor boundary tracing (clockwise from the backtrack direction)
  const dirs = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]]; // W NW N NE E SE S SW
  const pts = [];
  let px = bx, py = by, back = 0;
  for (let iter = 0; iter < 60000; iter++) {
    pts.push([px, py]);
    let found = -1;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      if (inC(px + dirs[d][0], py + dirs[d][1])) { found = d; break; }
    }
    if (found < 0) break; // single-pixel component
    px += dirs[found][0];
    py += dirs[found][1];
    back = (found + 6) % 8;
    if (px === bx && py === by && pts.length > 2) break;
  }
  if (pts.length < 8) return null;
  let eps = 1.5, out = simplifyPoly(pts, eps);
  while (out.length > 60 && eps < 8) { eps += 1; out = simplifyPoly(pts, eps); }
  return out;
}

/* Straighten a traced outline so it reads like a drawn roof diagram:
 * simplify, find the building's dominant orientation, snap near-axis edges
 * square, then merge collinear runs and slivers. Input/output [lat,lng]. */
function regularizeOutline(ll) {
  if (!ll || ll.length < 4) return ll;
  const k = Math.PI / 180, R = 6378137;
  const la0 = ll[0][0], ln0 = ll[0][1], c = Math.cos(la0 * k);
  let pts = ll.map(([la, ln]) => [(ln - ln0) * k * R * c, (la - la0) * k * R]); // local meters
  pts = simplifyPoly(pts, 0.6);
  if (pts.length >= 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.3) pts.pop();
  if (pts.length < 4) return ll;
  // dominant direction mod 90°, length-weighted (angle-quadrupling trick)
  let sx = 0, sy = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 4;
    sx += Math.cos(ang) * len; sy += Math.sin(ang) * len;
  }
  const theta = Math.atan2(sy, sx) / 4;
  const rot = (p, t) => [p[0] * Math.cos(t) - p[1] * Math.sin(t), p[0] * Math.sin(t) + p[1] * Math.cos(t)];
  const q = pts.map(p => rot(p, -theta));
  // relax near-axis edges square; leave true diagonals (hips, angled walls) alone
  for (let iter = 0; iter < 10; iter++) {
    for (let i = 0; i < q.length; i++) {
      const j = (i + 1) % q.length;
      const dx = q[j][0] - q[i][0], dy = q[j][1] - q[i][1];
      const a = Math.abs(Math.atan2(dy, dx)) % (Math.PI / 2);
      if (Math.min(a, Math.PI / 2 - a) > 25 * k) continue;
      if (Math.abs(dx) > Math.abs(dy)) { const m = (q[i][1] + q[j][1]) / 2; q[i][1] = m; q[j][1] = m; }
      else { const m = (q[i][0] + q[j][0]) / 2; q[i][0] = m; q[j][0] = m; }
    }
  }
  // drop collinear vertices
  let r = [];
  for (let i = 0; i < q.length; i++) {
    const prev = q[(i - 1 + q.length) % q.length], cur = q[i], nxt = q[(i + 1) % q.length];
    let d = Math.abs(Math.atan2(cur[1] - prev[1], cur[0] - prev[0]) - Math.atan2(nxt[1] - cur[1], nxt[0] - cur[0]));
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d < 6 * k) continue;
    r.push(cur);
  }
  if (r.length < 4) r = q;
  // merge sliver edges
  const r2 = [];
  for (let i = 0; i < r.length; i++) {
    const nxt = r[(i + 1) % r.length];
    if (Math.hypot(nxt[0] - r[i][0], nxt[1] - r[i][1]) < 0.9) {
      nxt[0] = (nxt[0] + r[i][0]) / 2; nxt[1] = (nxt[1] + r[i][1]) / 2;
      continue;
    }
    r2.push(r[i]);
  }
  if (r2.length >= 4) r = r2;
  return r.map(p => {
    const [X, Y] = rot(p, theta);
    return [+(la0 + Y / (R * k)).toFixed(7), +(ln0 + X / (R * k * c)).toFixed(7)];
  });
}

async function roofOutline(lat, lng, clipBbox) {
  const u = `https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${lat}&location.longitude=${lng}&radiusMeters=30&requiredQuality=LOW&key=${GOOGLE_KEY}`;
  const r = await fetch(u);
  if (!r.ok) return null;
  const j = await r.json();
  if (!j.maskUrl) return null;
  const buf = await (await fetch(`${j.maskUrl}&key=${GOOGLE_KEY}`)).arrayBuffer();
  const tiff = await fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const w = img.getWidth(), h = img.getHeight();
  const [minX, minY, maxX, maxY] = img.getBoundingBox();
  // The mask arrives in the local UTM zone (projected meters) — convert to lat/lng
  const gk = img.getGeoKeys?.() || {};
  const code = gk.ProjectedCSTypeGeoKey || gk.GeographicTypeGeoKey || 4326;
  let toLl, fromLl;
  if (code === 4326) {
    toLl = (x, y) => [y, x];
    fromLl = (la, ln) => [ln, la];
  } else {
    let def = null;
    if (code >= 32601 && code <= 32660) def = `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
    else if (code >= 32701 && code <= 32760) def = `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
    else if (code === 3857) def = "EPSG:3857";
    if (!def) return null;
    const conv = proj4(def, "WGS84");
    toLl = (x, y) => { const [ln, la] = conv.forward([x, y]); return [la, ln]; };
    fromLl = (la, ln) => conv.inverse([ln, la]);
  }
  const data = (await img.readRasters())[0];
  // Clip to the target building's bounding box (padded ~3m) so the outline
  // can't bleed into a touching neighbor's roof in the mask.
  if (clipBbox) {
    const [sLat, wLng, nLat, eLng] = clipBbox;
    const [x1, y1] = fromLl(sLat, wLng), [x2, y2] = fromLl(nLat, eLng);
    const toPx = (X, Y) => [((X - minX) / (maxX - minX)) * w, ((maxY - Y) / (maxY - minY)) * h];
    const [pxa, pya] = toPx(x1, y1), [pxb, pyb] = toPx(x2, y2);
    const pad = 12;
    const xLo = Math.min(pxa, pxb) - pad, xHi = Math.max(pxa, pxb) + pad;
    const yLo = Math.min(pya, pyb) - pad, yHi = Math.max(pya, pyb) + pad;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x < xLo || x > xHi || y < yLo || y > yHi) data[y * w + x] = 0;
    }
  }
  const px = traceMaskOutline(data, w, h);
  if (!px) return null;
  const raw = px.map(([x, y]) => {
    const [la, ln] = toLl(minX + ((x + 0.5) / w) * (maxX - minX), maxY - ((y + 0.5) / h) * (maxY - minY));
    return [+la.toFixed(7), +ln.toFixed(7)];
  });
  return regularizeOutline(raw);
}

/* ── Property-comp engine ──
 * Ported faithfully from the Quick Comp reference (_reference/quickcomp/server.js).
 * Pulls the subject property + nearby SOLD comps from RentCast's AVM endpoint,
 * dedupes them, scores each by distance / sqft / year / beds-baths / recency,
 * trims price-per-sqft outliers, takes a WEIGHTED average ppsf, and multiplies
 * by the subject's living area. Active listings are never part of this value.
 * The weighting/outlier math below MUST match Quick Comp — do not reinvent it. */

async function rcFetchJson(url, options = {}) {
  const response = await fetchT(url, options, 10000);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new Error(data.message || data.error || `Request failed with ${response.status}`);
  }
  return data;
}

/* Full county property record (owner, multi-year taxes, assessments, last
 * sale) — the AVM response doesn't carry these, the /properties endpoint does. */
async function fetchRentcastRecord(address) {
  const endpoint = new URL("https://api.rentcast.io/v1/properties");
  endpoint.searchParams.set("address", address);
  const j = await rcFetchJson(endpoint, { headers: { "X-Api-Key": RENTCAST_KEY } });
  return Array.isArray(j) ? j[0] || null : (j && typeof j === "object" && (j.id || j.formattedAddress) ? j : null);
}

async function fetchRentcastValue({ address, radius, compCount, daysOld }) {
  const endpoint = new URL("https://api.rentcast.io/v1/avm/value");
  endpoint.searchParams.set("address", address);
  endpoint.searchParams.set("maxRadius", String(radius));
  endpoint.searchParams.set("daysOld", String(daysOld));
  endpoint.searchParams.set("compCount", String(compCount));
  endpoint.searchParams.set("lookupSubjectAttributes", "true");
  return rcFetchJson(endpoint, { headers: { "X-Api-Key": RENTCAST_KEY } });
}

/* Pick the most recent year's value from a {year: {...}} map (RentCast tax /
 * assessment records). Returns { year, value } or null. */
function latestYearVal(obj, pick) {
  if (!obj || typeof obj !== "object") return null;
  const years = Object.keys(obj).filter((k) => /^\d{4}$/.test(k)).sort();
  for (let i = years.length - 1; i >= 0; i--) {
    const v = pick(obj[years[i]]);
    if (v != null) return { year: Number(years[i]), value: v };
  }
  return null;
}

/* Condensed from Quick Comp's normalizeProperty — the subject attributes the
 * scorer needs, plus a few extras handy for the result + tax cards. */
function normalizeSubjectProperty(p, fallbackAddress) {
  if (!p || typeof p !== "object") return { address: fallbackAddress || "" };
  const assess = latestYearVal(p.taxAssessments, (a) => a?.value ?? a?.total ?? null);
  const assessLand = latestYearVal(p.taxAssessments, (a) => a?.land ?? null);
  const assessImp = latestYearVal(p.taxAssessments, (a) => a?.improvements ?? null);
  const tax = latestYearVal(p.propertyTaxes, (a) => a?.total ?? a?.amount ?? null);
  const ownerNames = Array.isArray(p.owner?.names) ? p.owner.names.join(", ") : (p.owner?.name || p.ownerName || null);
  // Multi-year tax history (newest first, up to 4) — the realtor's "what did
  // they pay" answer at a glance
  const taxHistory = p.propertyTaxes && typeof p.propertyTaxes === "object"
    ? Object.keys(p.propertyTaxes).filter((k) => /^\d{4}$/.test(k)).sort().reverse().slice(0, 4)
        .map((y) => ({ year: Number(y), total: p.propertyTaxes[y]?.total ?? p.propertyTaxes[y]?.amount ?? null }))
        .filter((r) => r.total != null)
    : [];
  return {
    address: p.formattedAddress || p.address || [p.addressLine1, p.city, p.state, p.zipCode].filter(Boolean).join(", ") || fallbackAddress || "",
    propertyType: p.propertyType || p.propertyUse || p.type || null,
    bedrooms: p.bedrooms ?? p.beds ?? null,
    bathrooms: p.bathrooms ?? p.baths ?? null,
    squareFootage: p.squareFootage || p.livingArea || null,
    yearBuilt: p.yearBuilt || null,
    lotSize: p.lotSize || p.lotSquareFootage || null,
    latitude: p.latitude || p.location?.latitude || null,
    longitude: p.longitude || p.location?.longitude || null,
    // ownership + tax (present on RentCast property records; optional)
    owner: ownerNames,
    ownerOccupied: typeof p.ownerOccupied === "boolean" ? p.ownerOccupied : null,
    assessedValue: assess?.value ?? null,
    assessedYear: assess?.year ?? null,
    assessedLand: assessLand?.value ?? null,
    assessedImprovements: assessImp?.value ?? null,
    annualTax: tax?.value ?? null,
    taxYear: tax?.year ?? assess?.year ?? null,
    taxHistory,
    county: p.county || null,
    subdivision: p.subdivision || null,
    zoning: p.zoning || null,
    lastSalePrice: p.lastSalePrice ?? null,
    lastSaleDate: p.lastSaleDate || null,
  };
}

/* Primary comp data call (AVM + sold comparables). Ported from Quick Comp's
 * handleComps orchestration: auto-expands radius and sold-window when a market
 * is too thin for the AVM, then runs the weighted-ppsf valuation. Returns the
 * estimate, range, confidence label, subject, and ranked comp list. */
async function rentcastLookup(address, opts = {}) {
  if (!RENTCAST_KEY || !address) return null;
  const requestedRadius = Number(opts.radius || 2);
  const requestedDaysOld = Number(opts.daysOld || 183);
  const compCount = String(opts.compCount || 12);
  const autoExpand = opts.autoExpand !== false; // expand by default when a market is thin
  const allLookbacks = [
    { days: 183, label: "6 months" },
    { days: 365, label: "1 year" },
    { days: 730, label: "2 years" },
    { days: 1095, label: "3 years" },
  ];
  const exactLookback = allLookbacks.find((l) => l.days === requestedDaysOld) || { days: requestedDaysOld, label: `${requestedDaysOld} days` };
  const fixedRadius = Number(opts.fixedRadius) || null;
  const radii = fixedRadius ? [fixedRadius]
    : autoExpand ? [2, 5, 10].filter((r) => r >= requestedRadius) : [requestedRadius];
  const lookbacks = fixedRadius ? allLookbacks
    : autoExpand ? allLookbacks.filter((l) => l.days >= requestedDaysOld) : [exactLookback];
  let data = null;
  let usedRadius = radii[0] || 2;
  let usedLookback = lookbacks[0] || exactLookback;
  let lastError = null;

  for (const radius of radii) {
    for (const lookback of lookbacks) {
      try {
        data = await fetchRentcastValue({ address, radius, compCount, daysOld: lookback.days });
        usedRadius = radius;
        usedLookback = lookback;
        break;
      } catch (err) {
        lastError = err;
        if (!/insufficient comparables|unable to calculate avm/i.test(err.message || "")) throw err;
      }
    }
    if (data) break;
  }
  if (!data) throw lastError || new Error("No comparable sales found");

  // With lookupSubjectAttributes=true, RentCast's AVM returns the subject's
  // attributes at the TOP LEVEL of the response (not nested) — without this
  // fallback the app showed "—" for beds/baths on every live search.
  const subjSrc = data.subjectProperty || data.property
    || ((data.bedrooms != null || data.squareFootage != null || data.yearBuilt != null || data.propertyType) ? data : null);
  const subject = normalizeSubjectProperty(subjSrc, address);
  const rawComps = normalizeRentcastComps(data);
  const quick = calculateQuickCompValue({
    subject,
    comps: rawComps,
    rentcastEstimate: data.price || data.value || data.estimate || null,
    rentcastLow: data.priceRangeLow || data.valueRangeLow || null,
    rentcastHigh: data.priceRangeHigh || data.valueRangeHigh || null,
    usedRadius,
    usedDays: usedLookback.days,
  });
  return {
    subject,
    comps: quick.rankedComps || rawComps,
    value: quick.estimate,
    low: quick.low,
    high: quick.high,
    confidence: quick.confidence,
    method: quick.method,
    avgPpsf: quick.avgPpsf,
    usedCompCount: quick.usedCompCount,
    excludedOutliers: quick.excludedOutliers,
    radius: usedRadius,
    daysOld: usedLookback.days,
    lookbackLabel: usedLookback.label,
    marketDriftMo: quick.marketDriftMo ?? 0,
    rentcastEstimate: data.price || data.value || data.estimate || null,
  };
}

/* ── Routes ── */
/* Self-diagnosis: runs a live Regrid test from the server and reports the
 * raw outcome, so problems can be debugged by opening one URL. */
app.get("/api/diag", async (req, res) => {
  const out = { google: !!GOOGLE_KEY, regridKeySet: !!REGRID_KEY, rentcast: !!RENTCAST_KEY, ai: aiLive };
  const testPoint = async (label, lat, lon, radius) => {
    const t = {};
    try {
      const r = await fetchT(`https://app.regrid.com/api/v2/parcels/point?lat=${lat}&lon=${lon}&radius=${radius}&token=${REGRID_KEY}`);
      t.status = r.status;
      const body = await r.text();
      if (r.ok) {
        const j = JSON.parse(body);
        t.features = j?.parcels?.features?.length ?? null;
        t.geometryType = j?.parcels?.features?.[0]?.geometry?.type || null;
        t.sampleProps = Object.keys(j?.parcels?.features?.[0]?.properties?.fields || {}).slice(0, 6);
      } else {
        t.error = body.slice(0, 300);
      }
    } catch (e) { t.error = e.message; }
    out[label] = t;
  };
  if (REGRID_KEY) {
    await testPoint("rioGrandeCity", req.query.lat || 26.3827418, req.query.lon || -98.8196915, 10);
    await testPoint("detroitDocsExample", 42.36511, -83.073107, 10);
  }
  res.json(out);
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, db: db.dbKind(), dbError: (db.dbErrorMsg && db.dbErrorMsg()) ? "postgres unreachable (see server logs)" : null, live: { google: !!GOOGLE_KEY, parcels: !!REGRID_KEY, property: !!RENTCAST_KEY, ai: aiLive } });
});

app.get("/api/places", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 4) return res.json({ suggestions: [], source: "demo" });
  // Each call is a billed Google request — cap per connection per day. 300
  // covers a heavy legitimate day (typing ~20-30 addresses); bots hit the wall.
  const plIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`pl:${plIp}`, 300)) return res.status(429).json({ suggestions: [], error: "quota" });
  if (GOOGLE_KEY) {
    try {
      const r = await fetchT("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GOOGLE_KEY },
        body: JSON.stringify({ input: q, includedRegionCodes: ["us"] }),
      });
      if (r.ok) {
        const j = await r.json();
        const sugs = (j.suggestions || [])
          .map((s) => ({ text: s.placePrediction?.text?.text, placeId: s.placePrediction?.placeId || null }))
          .filter((s) => s.text)
          .slice(0, 5);
        return res.json({ suggestions: sugs, source: "live" });
      }
      console.error("places failed:", r.status, await r.text());
    } catch (e) {
      console.error("places failed:", e.message);
    }
  }
  const ql = q.toLowerCase();
  res.json({
    suggestions: MOCK_PROPERTIES.map((p) => p.addr).filter((a) => a.toLowerCase().includes(ql)).map((a) => ({ text: a, placeId: null })),
    source: "demo",
  });
});

/* ── Parcel boundary (Regrid) for the fence estimator ── */
function simplifyLatLng(pts, cap = 24) {
  const k = Math.PI / 180, R = 6378137;
  const [la0, ln0] = pts[0], c = Math.cos(la0 * k);
  let m = pts.map(([la, ln]) => [(ln - ln0) * k * R * c, (la - la0) * k * R]);
  let eps = 0.5, out = simplifyPoly(m, eps);
  while (out.length > cap && eps < 10) { eps += 1; out = simplifyPoly(m, eps); }
  return out.map(([x, y]) => [+(la0 + y / (R * k)).toFixed(6), +(ln0 + x / (R * k * c)).toFixed(6)]);
}

async function parcelLookup(lat, lng) {
  const u = `https://app.regrid.com/api/v2/parcels/point?lat=${lat}&lon=${lng}&radius=5&token=${REGRID_KEY}`;
  const r = await fetchT(u);
  if (!r.ok) { console.error("parcel failed:", r.status, (await r.text()).slice(0, 150)); return null; }
  const j = await r.json();
  const g = j?.parcels?.features?.[0]?.geometry;
  if (!g) return null;
  let ring = g.type === "Polygon" ? g.coordinates?.[0] : g.type === "MultiPolygon" ? g.coordinates?.[0]?.[0] : null;
  if (!ring || ring.length < 4) return null;
  let pts = ring.map(([ln, la]) => [la, ln]);
  if (pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) return null;
  return simplifyLatLng(pts);
}

app.post("/api/lookup", async (req, res) => {
  // Demo mode (no account) gets a small daily allowance per IP — enough to be
  // wowed, not enough to freeload. Clients get a high anti-runaway ceiling.
  const me = await auth(req).catch(() => null);
  const lkIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  // Staff pass: valid ?pass= (stored by the app, sent with each lookup) lifts
  // the anonymous caps so live sales demos never stall. Wrong/absent pass
  // falls through to the normal demo allowance.
  const passOk = DEMO_PASS && String(req.body?.pass || req.get("x-demo-pass") || "") === DEMO_PASS;
  if (!me && !passOk) {
    if (overQuota(`lk:${lkIp}`, 6)) return res.status(429).json({ error: "demo_limit" });
    // lifetime allowance per connection — survives incognito and browser wipes
    const lifetime = await db.incrCounter(`demolk:${lkIp}`).catch(() => 0);
    if (lifetime > 10) return res.status(429).json({ error: "demo_limit" });
  } else if (me && overQuota(`lkc:${me.id}`, 40)) { // per-account daily measure cap — low enough that a shared link is useless as a free tool
    return res.status(429).json({ error: "quota" });
  }
  const address = String(req.body?.address || "").trim();
  const placeId = req.body?.placeId || null;
  const gpsLat = parseFloat(req.body?.lat), gpsLng = parseFloat(req.body?.lng);
  const hasGps = Number.isFinite(gpsLat) && Number.isFinite(gpsLng);
  if (!address && !hasGps) return res.status(400).json({ error: "address or coordinates required" });

  try {
    // Resolve a precise location for the map (Google), when available. Comps
    // themselves come from RentCast by address, so Google is optional here.
    let geo = null;
    if (GOOGLE_KEY) {
      geo = hasGps
        ? { lat: gpsLat, lng: gpsLng, formatted: await reverseGeocode(gpsLat, gpsLng).catch(() => "") }
        : (placeId && (await placeDetails(placeId).catch(() => null))) || (await geocode(address).catch(() => null));
    }
    // Parcel flow (dual-use): location + boundary only, no comps.
    // No real parcel → no parcel at all; never show a fake boundary.
    if (req.body?.parcel) {
      if (!geo) return res.json({ found: false, source: "live" });
      const parcel = REGRID_KEY ? await parcelLookup(geo.lat, geo.lng).catch((e) => { console.error("parcel:", e.message); return null; }) : null;
      return res.json({ found: true, source: parcel ? "live" : "demo", addr: geo.formatted, lat: geo.lat, lng: geo.lng, parcel });
    }
    // Comps flow: weighted sold price-per-sqft valuation from RentCast.
    const lookupAddr = (geo && geo.formatted) || address;
    if (!lookupAddr) return res.json({ found: false, source: "live" });
    if (!RENTCAST_KEY) return res.json({ found: false, source: "demo" });
    // Optional agent-chosen radius (Auto omits it): the ring is FIXED but the
    // lookback still expands, so a tight radius can still find enough sales.
    const fixedRadius = [1, 2, 5, 10].includes(Number(req.body?.radius)) ? Number(req.body.radius) : null;
    const comp = await rentcastLookup(lookupAddr, fixedRadius ? { fixedRadius } : {}).catch((e) => { console.error("comps failed:", e.message); return null; });
    // We may know where the house is even when the market is too thin to value.
    if (!comp || !comp.value) {
      return res.json({ found: false, source: "live", addr: (geo && geo.formatted) || address, lat: geo?.lat ?? null, lng: geo?.lng ?? null });
    }
    // Enrich the subject with the full county record (owner, tax history,
    // last sale) — what a realtor actually needs on the tax screen. Best
    // effort: a missing record never blocks the valuation.
    let subject = comp.subject || {};
    try {
      const rec = await fetchRentcastRecord(subject.address || lookupAddr);
      if (rec) {
        const full = normalizeSubjectProperty(rec, lookupAddr);
        const avmKnown = Object.fromEntries(Object.entries(subject).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));
        subject = { ...full, ...avmKnown };
      }
    } catch (e) { console.error("property record:", e.message); }
    return res.json({
      found: true,
      source: "live",
      addr: subject.address || (geo && geo.formatted) || address,
      lat: geo?.lat ?? subject.latitude ?? null,
      lng: geo?.lng ?? subject.longitude ?? null,
      value: comp.value,
      valueRange: { low: comp.low, high: comp.high },
      confidence: comp.confidence,
      method: comp.method,
      subject,
      comps: comp.comps,
      compsUsed: comp.usedCompCount,
      excludedOutliers: comp.excludedOutliers,
      avgPpsf: comp.avgPpsf,
      radius: comp.radius,
      lookbackLabel: comp.lookbackLabel,
      marketDriftMo: comp.marketDriftMo ?? 0,
    });
  } catch (e) {
    console.error("lookup failed:", e.message);
    return res.status(502).json({ error: "lookup_failed" });
  }
});

/* Satellite photo of the measured roof, proxied so the key stays server-side.
 * Draws the measured roof sections (numbered orange boxes) when `boxes` is
 * provided. Requires "Maps Static API" enabled on the Google key. */
app.get("/api/roofimg", async (req, res) => {
  const { lat, lng, boxes, bbox, zoom, outline, lines } = req.query;
  if (!GOOGLE_KEY || !lat || !lng) return res.status(404).end();
  const riIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`ri:${riIp}`, 120)) return res.status(429).end();
  try {
    let url = `https://maps.googleapis.com/maps/api/staticmap?size=640x400&scale=2&maptype=satellite&key=${GOOGLE_KEY}`;
    const f = (n) => Number(n).toFixed(6);
    // Frame the shot: explicit zoom (trace view) > building bounding box > default
    let framed = false;
    if (zoom) {
      const z = Math.min(Math.max(parseInt(zoom) || 20, 15), 21);
      url += `&center=${encodeURIComponent(lat)},${encodeURIComponent(lng)}&zoom=${z}`;
      framed = true;
    } else if (bbox) {
      const [s, w, n, e] = String(bbox).split(",").map(Number);
      if ([s, w, n, e].every(Number.isFinite)) {
        const ctrLat = (s + n) / 2, ctrLng = (w + e) / 2;
        const span = Math.max(n - s, (e - w) * Math.cos((ctrLat * Math.PI) / 180), 0.00005) * 2.2;
        const zoom = Math.min(Math.max(Math.floor(Math.log2((360 * (640 / 256)) / span)), 17), 21);
        url += `&center=${f(ctrLat)},${f(ctrLng)}&zoom=${zoom}`;
        framed = true;
      }
    }
    if (!framed) url += `&center=${encodeURIComponent(lat)},${encodeURIComponent(lng)}&zoom=20`;
    // Fence runs: open polylines, white-cased orange
    if (lines) {
      for (const run of String(lines).split(";").slice(0, 12)) {
        const pts = run.split("|").map((p) => p.split(",").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
        if (pts.length < 2) continue;
        const pp = pts.map(([la, ln]) => `${f(la)},${f(ln)}`).join("|");
        url += `&path=color:0xFFFFFFCC|weight:7|${pp}`;
        url += `&path=color:0xC9973AFF|weight:4|${pp}`;
      }
    }
    // Preferred overlay: one clean traced outline of the actual roof
    if (outline) {
      const pts = String(outline).split(";").map((p) => p.split(",").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
      if (pts.length >= 3) {
        const pathPts = [...pts, pts[0]].map(([la, ln]) => `${f(la)},${f(ln)}`).join("|");
        // white casing under the orange line so it reads on any roof color
        url += `&path=color:0xFFFFFFCC|weight:6|${pathPts}`;
        url += `&path=color:0xC9973AFF|weight:3|fillcolor:0xC9973A10|${pathPts}`;
      }
    } else if (boxes) {
      const list = String(boxes).split(";").slice(0, 8);
      list.forEach((b, i) => {
        const [s, w, n, e] = b.split(",").map(Number);
        if (![s, w, n, e].every(Number.isFinite)) return;
        url += `&path=color:0xC9973AE6|weight:2|fillcolor:0xC9973A30|${f(s)},${f(w)}|${f(s)},${f(e)}|${f(n)},${f(e)}|${f(n)},${f(w)}|${f(s)},${f(w)}`;
        url += `&markers=size:mid|color:0x101B30|label:${i + 1}|${f((s + n) / 2)},${f((w + e) / 2)}`;
      });
    }
    const r = await fetch(url);
    if (!r.ok) {
      console.error("roofimg failed:", r.status, (await r.text()).slice(0, 200));
      return res.status(404).end();
    }
    res.set("Content-Type", r.headers.get("content-type") || "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error("roofimg failed:", e.message);
    res.status(404).end();
  }
});

/* House photo for a subject/comp address: a real Street View shot when
 * Google has coverage, otherwise a top-down satellite frame. Proxied so the
 * Maps key stays server-side. Demo mode (no key) returns 404 → UI hides it. */
app.get("/api/streetview", async (req, res) => {
  const { lat, lng, address } = req.query;
  // Accept either lat/lng (used for real searches, where we already geocoded
  // the address) or a free-text address — Google's Street View/Static Map
  // APIs geocode a `location`/`center` string themselves, which is more
  // reliable than us guessing coordinates (used for the fixed demo example).
  const hasCoords = lat && lng;
  if (!GOOGLE_KEY || (!hasCoords && !address)) return res.status(404).end();
  const svIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`sv:${svIp}`, 120)) return res.status(429).end();
  const loc = hasCoords ? `${encodeURIComponent(lat)},${encodeURIComponent(lng)}` : encodeURIComponent(String(address).slice(0, 200));
  try {
    // Prefer a street-level photo of the house; check coverage first.
    let hasStreet = false;
    try {
      const meta = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${loc}&key=${GOOGLE_KEY}`);
      if (meta.ok) { const j = await meta.json(); hasStreet = j.status === "OK"; }
    } catch { /* fall through to satellite */ }
    const url = hasStreet
      ? `https://maps.googleapis.com/maps/api/streetview?size=640x400&location=${loc}&fov=75&pitch=8&source=outdoor&key=${GOOGLE_KEY}`
      : `https://maps.googleapis.com/maps/api/staticmap?size=640x400&scale=2&maptype=satellite&center=${loc}&zoom=20&key=${GOOGLE_KEY}`;
    const r = await fetch(url);
    if (!r.ok) {
      console.error("streetview failed:", r.status, (await r.text()).slice(0, 200));
      return res.status(404).end();
    }
    res.set("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error("streetview failed:", e.message);
    res.status(404).end();
  }
});

/* Browser key for the in-app interactive map (Maps JavaScript API). Prefers a
 * dedicated, HTTP-referrer-restricted browser key; falls back to the main key
 * so the map works out of the box. Restrict the key by referrer in production. */
/* The key handed to browsers for the Maps JS map. Use a SEPARATE, referrer-
 * restricted key (GOOGLE_MAPS_BROWSER_KEY) — the server key can't be referrer-
 * restricted and would be extractable from any visitor's network tab. The
 * fallback to the server key exists only so the map doesn't break before the
 * browser key is configured; it logs a warning at every boot until fixed. */
app.get("/api/mapconfig", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({ key: process.env.GOOGLE_MAPS_BROWSER_KEY || GOOGLE_KEY || "" });
});
if (!process.env.GOOGLE_MAPS_BROWSER_KEY && GOOGLE_KEY) {
  console.warn("⚠️  GOOGLE_MAPS_BROWSER_KEY not set — the SERVER key is being served to browsers via /api/mapconfig. Create a second key (Maps JavaScript API only, HTTP-referrer restricted to your domain) and set it as GOOGLE_MAPS_BROWSER_KEY.");
}

/* Comparables map: a static map with markers baked in by Google (subject =
 * red "S", comps = numbered navy pins). Google auto-frames to fit all points.
 * pts = "lat,lng,LABEL;lat,lng,LABEL;..." — label is a single char or empty. */
app.get("/api/compmap", async (req, res) => {
  const { pts, maptype } = req.query;
  if (!GOOGLE_KEY || !pts) return res.status(404).end();
  const cmIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`cm:${cmIp}`, 120)) return res.status(429).end();
  try {
    const type = maptype === "roadmap" ? "roadmap" : "satellite";
    let url = `https://maps.googleapis.com/maps/api/staticmap?size=640x360&scale=2&maptype=${type}&key=${GOOGLE_KEY}`;
    for (const it of String(pts).split(";").slice(0, 30)) {
      const [la, ln, label] = it.split(",");
      const lat = Number(la), lng = Number(ln);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const isSubj = label === "S";
      const color = isSubj ? "red" : "0x1B2A5C";
      // Static Maps labels accept one alphanumeric char only; skip otherwise.
      const lbl = label && /^[A-Z0-9]$/.test(label) ? `label:${label}|` : "";
      url += `&markers=${isSubj ? "size:mid|" : ""}color:${color}|${lbl}${lat.toFixed(6)},${lng.toFixed(6)}`;
    }
    const r = await fetch(url);
    if (!r.ok) {
      console.error("compmap failed:", r.status, (await r.text()).slice(0, 200));
      return res.status(404).end();
    }
    res.set("Content-Type", r.headers.get("content-type") || "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error("compmap failed:", e.message);
    res.status(404).end();
  }
});

/* ── Accounts, login, and saved data ── */

// who is calling? (session token in the Authorization header)
async function auth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  return m ? db.getSessionContractor(m[1]) : null;
}

// Logins: the key can come from the URL once — after that it lives in an
// HttpOnly cookie for ~30 days, so bookmarked /admin and /closer just work.
const reqCookies = (req) => Object.fromEntries(
  String(req.headers.cookie || "").split(/; */).filter(Boolean).map((c) => {
    const i = c.indexOf("=");
    return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
  })
);
const setKeyCookie = (res, name, val) =>
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax${IS_PROD ? "; Secure" : ""}; Max-Age=${30 * 86400}`);
const clearKeyCookie = (res, name) => res.setHeader("Set-Cookie", `${name}=; Path=/; Max-Age=0`);
// Canonical public base for generated links: always the main https domain in
// production (never app./www. or http), so copied links work everywhere.
function canonBase(req) {
  const host = String(req.get("host") || "").split(":")[0].toLowerCase();
  if (ROOT_DOMAIN && (host === ROOT_DOMAIN || host.endsWith(`.${ROOT_DOMAIN}`))) return `https://${ROOT_DOMAIN}`;
  return `${req.protocol}://${req.get("host")}`;
}
// Display string for where a client's published site lives: a clean
// <slug>.ROOT_DOMAIN subdomain once a domain is configured, otherwise the
// real working path on this host.
function siteDisplay(req, slug) {
  if (ROOT_DOMAIN) return `${slug}.${ROOT_DOMAIN}`;
  return `${canonBase(req).replace(/^https?:\/\//, "")}/site/${slug}`;
}

// Constant-time comparison so response timing can't leak key prefixes.
const safeEq = (a, b) => {
  const A = Buffer.from(String(a || "")), B = Buffer.from(String(b || ""));
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
};
/* A human-looking password guarding /admin puts every client account at risk.
 * Weak = short, or (unless long) too little character variety — the shape of
 * a memorized personal password rather than a generated secret. */
const weakKeyReason = (k) => {
  if (!k) return null;
  if (k.length < 14) return "corta";
  const variety = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(k)).length;
  if (k.length < 20 && variety < 3) return "poca variedad";
  return null;
};

const adminOk = (req) => ADMIN_KEY && (
  safeEq(req.query.key, ADMIN_KEY) || safeEq(req.body?.key, ADMIN_KEY) || safeEq(reqCookies(req).alto_admin, ADMIN_KEY)
);
// Closers get a limited portal: create clients + the sales toolkit, nothing else
const closerOk = (req) => {
  const ks = [req.query.key, req.body?.key, reqCookies(req).alto_closer, reqCookies(req).alto_admin];
  return ks.some((k) => (CLOSER_KEY && safeEq(k, CLOSER_KEY)) || (ADMIN_KEY && safeEq(k, ADMIN_KEY)));
};
// Customer service: the command center (tasks + edit client sites), no money/MRR
const csOk = (req) => {
  const ks = [req.query.key, req.body?.key, reqCookies(req).alto_cs, reqCookies(req).alto_admin];
  return ks.some((k) => (CS_KEY && safeEq(k, CS_KEY)) || (ADMIN_KEY && safeEq(k, ADMIN_KEY)));
};

function loginPage(title, action, wrong) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick Comp · ${title}</title><link rel="icon" href="/icon-192.png"><style>
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0}
body{background:#15244C;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:22px;padding:36px 30px;width:100%;max-width:380px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.45)}
img{height:58px;margin-bottom:14px}
h1{font-size:18px;color:#15244C;margin-bottom:4px}
p{color:#6E7891;font-size:13px;font-weight:600;margin-bottom:18px}
input{width:100%;padding:14px;border-radius:12px;border:1.5px solid #DDE3EE;font-size:16px;font-weight:600;outline:none;text-align:center}
input:focus{border-color:#C9973A}
button{width:100%;margin-top:10px;padding:14px;border:none;border-radius:12px;background:#C9973A;color:#fff;font-size:16px;font-weight:800;cursor:pointer}
.err{color:#D93025;font-size:13px;font-weight:700;margin-top:10px}
</style></head><body><form class="card" method="get" action="${action}">
<img src="/brand-logo.png" alt="Quick Comp">
<h1>${title}</h1>
<p>Escribe tu clave para entrar</p>
<input name="key" type="password" placeholder="Clave / Password" autofocus autocomplete="current-password">
<button>Entrar →</button>
${wrong ? `<p class="err">Clave incorrecta — intenta de nuevo.</p>` : ""}
</form></body></html>`;
}

// Admin: create a contractor account + invite link (you run this per sale)
app.post("/api/admin/contractors", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "bad admin key" });
  const { name, phone, slug, plan } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const c = await db.createContractor({ name, phone, slug });
  // Optional plan pre-tag (the Stripe webhook overwrites it with the real one on payment)
  if (plan && PLANS[plan]) await db.saveContractorData(c.id, { ...(c.data || {}), plan, planAmount: PLANS[plan].price }).catch(() => {});
  const invite = await db.createInvite(c.id);
  const inviteUrl = `${req.protocol}://${req.get("host")}/invite/${invite}`;
  if (req.query.html) {
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cuenta creada</title>
<style>body{font-family:Inter,Arial,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#15244C}h2{margin-bottom:6px}
.link{background:#F7EFD8;border:2px solid #C9973A;border-radius:12px;padding:14px;word-break:break-all;font-size:14px;margin:14px 0}
a{color:#C9973A;font-weight:800}</style></head><body>
<h2>✓ Cuenta creada: ${c.name}</h2>
<p>Manda este enlace de invitación por texto o WhatsApp al agente. Un tap y queda dentro de su app — es su llave personal, sin App Store, con sus datos guardados para siempre:</p>
<div class="link">${inviteUrl}</div>
<a href="/admin?key=${encodeURIComponent(ADMIN_KEY)}">← Volver al admin</a></body></html>`);
  }
  res.json({ contractor: c, inviteUrl });
});

app.get("/api/admin/contractors", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "bad admin key" });
  res.json({ contractors: await db.listContractors() });
});

// Admin: fresh access link for an existing contractor (lost phone, or the
// built-in alto-ventas account where landing-page leads arrive)
app.get("/api/admin/invite", async (req, res) => {
  if (!adminOk(req)) return res.status(403).send("bad admin key");
  const c = await db.getContractor(String(req.query.id || ""));
  if (!c) return res.status(404).send("no contractor");
  const token = await db.createInvite(c.id);
  const url = `${req.protocol}://${req.get("host")}/invite/${token}`;
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link de acceso</title>
<style>body{font-family:Inter,Arial,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#15244C}
.link{background:#F7EFD8;border:2px solid #C9973A;border-radius:12px;padding:14px;word-break:break-all;font-size:14px;margin:14px 0}
a{color:#C9973A;font-weight:800}</style></head><body>
<h2>🔑 Link de acceso: ${c.name}</h2>
<p>Mándalo por texto o WhatsApp. Un tap y entra a su app con todo guardado:</p>
<div class="link">${url}</div>
<a href="/admin?key=${encodeURIComponent(ADMIN_KEY)}">← Volver al admin</a></body></html>`);
});

/* Admin: revoke ALL access to an account (leaked link, lost phone, ex-employee)
 * — kills every session and every old invite, then mints ONE fresh link. */
app.post("/api/admin/revoke", async (req, res) => {
  if (!adminOk(req)) return res.status(403).send("bad admin key");
  const c = await db.getContractor(String(req.query.id || req.body?.id || ""));
  if (!c) return res.status(404).send("no contractor");
  await db.revokeAccess(c.id);
  const token = await db.createInvite(c.id);
  const url = `${canonBase(req)}/invite/${token}`;
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acceso renovado</title>
<style>body{font-family:Inter,Arial,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#15244C}
.link{background:#F7EFD8;border:2px solid #C9973A;border-radius:12px;padding:14px;word-break:break-all;font-size:14px;margin:14px 0}
a{color:#C9973A;font-weight:800}</style></head><body>
<h2>🔒 Acceso renovado: ${String(c.name).replace(/</g, "&lt;")}</h2>
<p>Todos los links y dispositivos anteriores quedaron <b>desconectados</b>. Mándale este link nuevo — es su única llave ahora:</p>
<div class="link">${url}</div>
<a href="/admin?key=${encodeURIComponent(ADMIN_KEY)}">← Volver al admin</a></body></html>`);
});

// Admin: connect/disconnect a contractor's HighLevel webhook (empty url clears)
app.post("/api/admin/webhook", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "bad admin key" });
  const c = await db.getContractor(String(req.query.id || ""));
  if (!c) return res.status(404).json({ error: "no contractor" });
  const url = String(req.query.url || "").trim();
  if (url && !/^https:\/\//.test(url)) return res.status(400).json({ error: "url must start with https://" });
  await db.saveContractorData(c.id, { ...(c.data || {}), webhook: url || undefined });
  res.json({ ok: true, webhook: url || null });
});

// Admin: pause/reactivate a client (paused = widget + website stop taking leads;
// the app and their data stay untouched)
app.post("/api/admin/status", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "bad admin key" });
  const c = await db.getContractor(String(req.query.id || ""));
  if (!c) return res.status(404).json({ error: "no contractor" });
  const paused = req.query.status === "paused";
  const data = { ...(c.data || {}), status: paused ? "paused" : undefined };
  if (!paused && data.payStatus === "pending") data.payStatus = "ok"; // manual activation (cash/Zelle deals)
  await db.saveContractorData(c.id, data);
  res.json({ ok: true, status: paused ? "paused" : "active" });
});

/* Admin: one-click full data backup (ALTO ownership pattern) — everything the
 * business can't rebuild, in one dated JSON: clients with their app state and
 * leads, plus meetings and tasks. Session tokens and invite links are excluded
 * on purpose: a leaked backup file must never grant access to anything. */
app.get("/api/admin/backup", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "bad admin key" });
  try {
    const contractors = await db.listContractors();
    const clients = [];
    for (const c of contractors) {
      const [state, leads] = await Promise.all([
        db.getState(c.id).catch(() => null),
        db.listLeads(c.id).catch(() => []),
      ]);
      clients.push({ id: c.id, slug: c.slug, name: c.name, phone: c.phone, created_at: c.created_at, data: c.data || {}, state, leads });
    }
    const backup = {
      product: "quick-comp",
      exportedAt: new Date().toISOString(),
      counts: { clients: clients.length, leads: clients.reduce((n, c) => n + (c.leads?.length || 0), 0) },
      clients,
      meetings: await db.listMeetings(5000).catch(() => []),
      tasks: await db.listTasks(5000).catch(() => []),
    };
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="quickcomp-backup-${stamp}.json"`);
    res.send(JSON.stringify(backup, null, 1));
  } catch (e) {
    console.error("backup failed:", e.message);
    res.status(500).json({ error: "backup_failed" });
  }
});

// Operations dashboard: KPIs, funnel, clients with lead activity, latest leads
/* Month/date filtering for the closer's sales numbers.
 * period = this | last | all | custom (+ from/to YYYY-MM-DD). */
function periodRange(q, en) {
  const now = new Date();
  const period = q.period || "this";
  const iso = (d) => d.toISOString();
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const mlabel = (d) => cap(d.toLocaleDateString(en ? "en-US" : "es-MX", { month: "long", year: "numeric", timeZone: "UTC" }));
  if (period === "all") return { from: null, to: null, period: "all", label: en ? "All time" : "Todo el tiempo" };
  if (period === "custom" && q.from) {
    const from = new Date(q.from + "T00:00:00Z");
    const to = q.to ? new Date(q.to + "T23:59:59Z") : now;
    return { from: iso(from), to: iso(to), period: "custom", fromStr: q.from, toStr: q.to || "", label: `${q.from} → ${q.to || (en ? "now" : "hoy")}` };
  }
  if (period === "last") {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from: iso(d), to: iso(to), period: "last", label: mlabel(d) };
  }
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from: iso(d), to: null, period: "this", label: mlabel(d) };
}
/* Segmented month control — links reload the page with ?period=… */
function periodSeg(basePath, range, en) {
  const lang = en ? "&lang=en" : "";
  const T = en
    ? { this: "This month", last: "Last month", all: "All", apply: "View" }
    : { this: "Este mes", last: "Mes pasado", all: "Todo", apply: "Ver" };
  const seg = (p, label) => `<a class="seg${range.period === p ? " on" : ""}" href="${basePath}?period=${p}${lang}">${label}</a>`;
  return `<div class="periodbar">
    <div class="segs">${seg("this", T.this)}${seg("last", T.last)}${seg("all", T.all)}</div>
    <form class="segcustom" method="get" action="${basePath}">
      <input type="hidden" name="period" value="custom">${en ? '<input type="hidden" name="lang" value="en">' : ""}
      <input type="date" name="from" value="${range.fromStr || ""}">
      <input type="date" name="to" value="${range.toStr || ""}">
      <button class="${range.period === "custom" ? "on" : ""}">${T.apply}</button>
    </form>
    ${range.label ? `<span class="plabel">${range.label}</span>` : ""}
  </div>`;
}

/* The three tiers as the admin shows them. The Stripe webhook tags data.plan
 * from the amount paid; planOf falls back to "complete" for untagged accounts. */
const PLANS = {
  pro: { price: 67, name: "Pro · La App" },
  widget: { price: 197, name: "Widget · Su Página" },
  complete: { price: 297, name: "Completo · Todo Hecho" },
};
const planOf = (c) => (PLANS[c?.data?.plan] ? c.data.plan : "complete");

/* ── Sales-leads inbox (alto-ventas) — the setters' mini-CRM inside /admin ──
 * Everything captured on getquickcomp.com lands here: the quiz at the bottom
 * (info.src "landing", carries the 4 quiz answers) and the "Try it on your
 * phone" trial box (info.src "trial-app"). Channel DMs stay in GHL. */
function salesLeadsPanel(leads, K, opts = {}) {
  const esc = (x) => String(x || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ago = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso || 0).getTime()) / 60000));
    if (m < 60) return `hace ${m} min`;
    if (m < 1440) return `hace ${Math.round(m / 60)} h`;
    return `hace ${Math.round(m / 1440)} d`;
  };
  const SRC = { "trial-app": ["app", "🧪 Probó la app"], landing: ["quiz", "📋 Quiz anuncios"],
    whatsapp: ["chat", "💬 WhatsApp"], instagram: ["chat", "📸 Instagram"], facebook: ["chat", "💬 Messenger"], messenger: ["chat", "💬 Messenger"], chat: ["chat", "💬 Chat"] };
  const QL = { work: "", crew: "licencia: ", revenue: "ventas/año: ", marketing: "marketing: " };
  const pend = leads.filter((l) => (l.status || "new") === "new").length;
  const STAGES = [["new", "🔴 Nuevo"], ["contacted", "🟡 Contactado"], ["scheduled", "📅 Agendó"], ["closed", "🎉 Cerró"], ["not_interested", "✕ No interesado"]];
  const rows = leads.slice(0, 60).map((l, i) => {
    const [srcKey, srcLabel] = SRC[l.info?.src] || ["otro", "🌐 Otro"];
    const stage = STAGES.some(([k]) => k === l.status) ? l.status : "new";
    const st = stage === "new" ? "open" : "done";
    const digits = String(l.phone || "").replace(/\D/g, "");
    const wa = digits ? `https://wa.me/${digits.length === 10 ? "1" + digits : digits}?text=${encodeURIComponent(`Hola${l.name ? " " + l.name : ""} 👋 Soy del equipo de Quick Comp — vi que pediste info en nuestra página. ¿Te marco ahorita o prefieres que te mande la info por aquí?`)}` : "";
    const quiz = ["work", "crew", "revenue", "marketing"].filter((k) => l.info?.[k]).map((k) => `<span class="slq">${QL[k]}${esc(l.info[k])}</span>`).join("");
    return `<div class="slrow stage-${stage}" data-src="${srcKey}" data-st="${st}">
      <span class="sln">${i + 1}</span>
      <div class="slmain">
        <div><b>${esc(l.name) || "Sin nombre"}</b>${l.info?.biz ? ` <span style="color:#67718A;font-weight:700">· ${esc(l.info.biz)}</span>` : ""} <span class="slsrc ${srcKey}">${srcLabel}</span></div>
        ${quiz ? `<div class="slqs">${quiz}</div>` : ""}
        <div class="slsub">${esc(l.phone)} · ${ago(l.created_at)}</div>
        <div class="slnote" onclick="slNote('${l.id}',this)" title="Click para editar">${l.info?.crm_note ? "📝 " + esc(l.info.crm_note) : '<span style="color:#B6BCC8">📝 agregar nota…</span>'}</div>
      </div>
      <div class="slacts">
        ${wa ? `<a href="${wa}" target="_blank" title="WhatsApp">💬</a><a href="tel:+1${digits.length === 10 ? digits : digits.slice(-10)}" title="Llamar">📞</a>` : ""}
        <select class="slsel st-${stage}" onchange="slStat('${l.id}',this.value)">
          ${STAGES.map(([k, lbl]) => `<option value="${k}" ${k === stage ? "selected" : ""}>${lbl}</option>`).join("")}
        </select>
      </div>
    </div>`;
  }).join("");
  return `<style>
.slrow{display:flex;align-items:center;gap:12px;padding:11px 4px;border-bottom:1px solid #F0F2F6}
.slrow.stage-not_interested{opacity:.4}
.slrow.stage-closed{background:#F6FDF8}
.slnote{margin-top:4px;font-size:12px;font-weight:600;color:#4A5568;cursor:pointer}
.slsel{border-radius:10px;font-weight:800;font-size:12px;padding:8px 8px;cursor:pointer;border:1.5px solid #E4E7EC;background:#fff;color:#101B30;max-width:150px}
.slsel.st-new{background:#FDECEC;border-color:#F5C6C0;color:#9B1C10}
.slsel.st-contacted{background:#FEF5DC;border-color:#F4DE9A;color:#8A6D00}
.slsel.st-scheduled{background:#EAF3FE;border-color:#BBD6F7;color:#1A5CB0}
.slsel.st-closed{background:#EAF8EF;border-color:#BFE6CC;color:#1E7B3C}
.sln{width:26px;height:26px;border-radius:99px;background:#F0F2F6;color:#67718A;font-weight:800;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.slmain{flex:1;min-width:0}.slmain b{font-size:14.5px;color:#101B30}
.slsrc{font-size:11px;font-weight:800;border-radius:99px;padding:3px 9px;margin-left:6px;vertical-align:middle;white-space:nowrap;display:inline-block}
.slsrc.app{background:#EAF3FE;color:#1A5CB0}.slsrc.quiz{background:#FEF5DC;color:#8A6D00}.slsrc.chat{background:#EAF8EF;color:#1E7B3C}.slsrc.otro{background:#F0F2F6;color:#67718A}
.slqs{margin-top:4px;display:flex;flex-wrap:wrap;gap:5px}
.slq{font-size:11px;font-weight:700;background:#F7F9FC;border:1px solid #E4E7EC;border-radius:8px;padding:2px 8px;color:#4A5568}
.slsub{margin-top:3px;font-size:12px;color:#8A94A8;font-weight:600}
.slacts{display:flex;align-items:center;gap:8px;flex-shrink:0}
.slacts a{font-size:18px;text-decoration:none}
.sltabs{display:flex;gap:8px;margin:4px 0 8px;flex-wrap:wrap}
.sltab{border:1.5px solid #E4E7EC;background:#fff;border-radius:99px;font-weight:800;font-size:12px;color:#67718A;padding:7px 14px;cursor:pointer}
.sltab.on{background:#101B30;color:#fff;border-color:#101B30}
.slempty{color:#8A94A8;font-weight:600;font-size:13.5px;padding:14px 4px}
</style>
<div class="sltabs">
  <button class="sltab on" onclick="slF(this,'all')">Todos (${leads.length})</button>
  <button class="sltab" onclick="slF(this,'open')">Sin contactar (${pend})</button>
  <button class="sltab" onclick="slF(this,'app')">🧪 Probó la app</button>
  <button class="sltab" onclick="slF(this,'quiz')">📋 Quiz</button>
  <button class="sltab" onclick="slF(this,'chat')">💬 Chats</button>
  <a class="sltab" style="text-decoration:none" href="/api/sales/leads.csv?key=${K}">⬇️ Excel</a>
</div>
${rows || `<p class="slempty">Todavía no hay leads de venta — llegan solos cuando alguien llena el quiz o pide su link de prueba en getquickcomp.com.</p>`}
<p class="legend" style="font-size:11.5px;color:#8A94A8;font-weight:600;margin-top:8px">Los DMs de Instagram/Facebook viven en GHL (el bot los atiende) — aquí llega todo lo que entra por getquickcomp.com.</p>
<script>
function slF(btn,f){document.querySelectorAll(".sltab").forEach(b=>b.classList.remove("on"));btn.classList.add("on");
  document.querySelectorAll(".slrow").forEach(r=>{
    var show = f==="all" || (f==="open" ? r.dataset.st==="open" : r.dataset.src===f);
    r.style.display = show ? "" : "none";
  });}
function slNote(id,el){var cur=el.innerText.indexOf("📝 agregar")>=0?"":el.innerText.replace(/^📝 /,"");
  var t=prompt("Nota del lead:",cur);if(t===null)return;
  fetch("/api/sales/leadnote?key=${K}",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id,note:t})})
    .then(r=>r.json()).then(j=>{if(j.ok)location.reload();else alert("Error");}).catch(()=>alert("Error"));}
function slStat(id,st){fetch("/api/sales/leadstatus?key=${K}",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id,status:st})})
  .then(r=>r.json()).then(j=>{if(j.ok)location.reload();else alert("Error");}).catch(()=>alert("Error"));}
</script>`;
}

// Excel-friendly export of the sales leads (CSV with BOM so Excel shows
// accents right) — for handing the day's list to the closer.
app.get("/api/sales/leads.csv", async (req, res) => {
  if (!adminOk(req) && !closerOk(req)) return res.status(403).send("no auth");
  const av = await db.getContractorBySlug("alto-ventas");
  const leads = av ? await db.listLeads(av.id).catch(() => []) : [];
  const SRC = { "trial-app": "Probó la app", landing: "Quiz anuncios", whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Messenger", messenger: "Messenger", chat: "Chat" };
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["Nombre", "Teléfono", "Fuente", "Enfoque", "Licencia", "Ventas por año", "Marketing", "Estado", "Nota", "Fecha"],
    ...leads.map((l) => [
      l.name, l.phone, SRC[l.info?.src] || l.info?.src || "Otro",
      l.info?.work || "", l.info?.crew || "", l.info?.revenue || "", l.info?.marketing || "",
      ({ contacted: "Contactado", scheduled: "Agendó", closed: "Cerró", not_interested: "No interesado" })[l.status] || "Nuevo",
      l.info?.crm_note || "",
      new Date(l.created_at).toLocaleString("es-US", { timeZone: "America/Chicago" }),
    ]),
  ];
  const csv = "\\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads-venta-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// Quick CRM note on a sales lead (admin or closer)
app.post("/api/sales/leadnote", async (req, res) => {
  if (!adminOk(req) && !closerOk(req)) return res.status(403).json({ error: "no auth" });
  const av = await db.getContractorBySlug("alto-ventas");
  if (!av) return res.status(404).json({ error: "cuenta de ventas no existe" });
  await db.updateLeadInfo(av.id, String(req.body?.id || ""), { crm_note: String(req.body?.note || "").replace(/\s+/g, " ").trim().slice(0, 200) });
  res.json({ ok: true });
});

// Move a sales lead through the mini-pipeline (admin or closer)
app.post("/api/sales/leadstatus", async (req, res) => {
  if (!adminOk(req) && !closerOk(req)) return res.status(403).json({ error: "no auth" });
  const status = String(req.body?.status || "");
  if (!["new", "contacted", "scheduled", "closed", "not_interested"].includes(status)) return res.status(400).json({ error: "status inválido" });
  const av = await db.getContractorBySlug("alto-ventas");
  if (!av) return res.status(404).json({ error: "cuenta de ventas no existe" });
  await db.updateLeadStatus(av.id, String(req.body?.id || ""), status);
  res.json({ ok: true });
});

// Archive ALL sales leads (fresh start before launching ads) — admin only
app.post("/api/sales/clearleads", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "solo admin" });
  const av = await db.getContractorBySlug("alto-ventas");
  if (!av) return res.status(404).json({ error: "cuenta de ventas no existe" });
  const n = await db.clearLeads(av.id);
  res.json({ ok: true, archived: n });
});

// Reset all visit/funnel counters (fresh start before launching ads) — admin only
app.post("/api/sales/clearmetrics", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "solo admin" });
  const n = await db.clearMetrics();
  res.json({ ok: true, cleared: n });
});

// Wipe the closer meeting log (fresh start) — admin only
app.post("/api/admin/clearmeetings", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "solo admin" });
  const n = await db.clearMeetings();
  res.json({ ok: true, cleared: n });
});

// Restore a backup file (the /api/admin/backup format) — upsert-only, never deletes
app.post("/api/admin/restore", express.json({ limit: "25mb" }), async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "bad admin key" });
  const body = req.body || {};
  if (body.confirm !== "RESTAURAR") return res.status(400).json({ error: 'falta la confirmación (escribe "RESTAURAR")' });
  const dump = body.dump || body.backup || body;
  if (!dump || typeof dump !== "object" || (!Array.isArray(dump.clients) && !Array.isArray(dump.contractors))) {
    return res.status(400).json({ error: "el archivo no parece un respaldo de Quick Comp (falta la lista de clientes)" });
  }
  try {
    const counts = await db.importAll(dump);
    console.log("restore OK:", JSON.stringify(counts));
    res.json({ ok: true, restored: counts });
  } catch (e) {
    console.error("restore failed:", e.message);
    res.status(500).json({ error: "no se pudo restaurar: " + e.message });
  }
});

app.get("/admin", async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).send("Set ADMIN_KEY env var to enable admin.");
  if (req.query.logout != null) { clearKeyCookie(res, "alto_admin"); return res.redirect("/admin"); }
  if (safeEq(req.query.key, ADMIN_KEY)) { setKeyCookie(res, "alto_admin", ADMIN_KEY); return res.redirect("/admin"); }
  if (!adminOk(req)) return res.status(req.query.key ? 403 : 401).send(loginPage("Admin", "/admin", !!req.query.key));
  const KEY = encodeURIComponent(ADMIN_KEY);
  const base = canonBase(req);
  const range = periodRange(req.query, false);
  const [list, stats, recent, rows, mst, devCounts] = await Promise.all([
    db.listContractors(),
    db.leadStats().catch(() => []),
    db.recentLeads(12).catch(() => []),
    db.getMetricsBetween(range.from, range.to).catch(() => []),
    db.meetingStats(range).catch(() => ({ total: 0, scheduled: 0, noShow: 0, showed: 0, closed: 0 })),
    db.sessionCounts().catch(() => ({})),
  ]);
  const closeRate = mst.total ? Math.round((mst.closed / mst.total) * 100) : 0;
  const BUILTIN = new Set(["alto-demo", "alto-ventas"]);
  const realClients = list.filter((c) => !BUILTIN.has(c.slug));
  const avAcct = list.find((c) => c.slug === "alto-ventas");
  const salesLeads = avAcct ? await db.listLeads(avAcct.id).catch(() => []) : [];
  const salesPend = salesLeads.filter((l) => (l.status || "new") === "new").length;
  const tot = (e) => rows.filter((r) => r.event === e).reduce((a, r) => a + Number(r.n), 0);
  // Visitor cities (geo:* counters bumped by /api/track) — aggregated over the
  // same date range as the rest of the dashboard, sorted by volume.
  const geoTop = (() => {
    const m = {};
    rows.filter((r) => r.event.startsWith("geo:")).forEach((r) => { const k = r.event.slice(4); m[k] = (m[k] || 0) + Number(r.n); });
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 12);
  })();
  const leadsRange = await db.leadCountInRange(range).catch(() => 0);
  // real MRR = only clients confirmed paying (Stripe payment or manual
  // activation), summing each one's actual plan price (legacy/unknown → $297)
  const payCount = (s) => realClients.filter((c) => (c.data?.payStatus || "") === s).length;
  const paying = payCount("ok");
  const pendingPay = payCount("pending");
  const failedPay = payCount("failed");
  const payingClients = realClients.filter((c) => (c.data?.payStatus || "") === "ok");
  const mrr = payingClients.reduce((sum, c) => sum + (Number(c.data?.planAmount) || PLANS[planOf(c)].price), 0);
  // chart days = the days that actually have data in the selected range
  // (fallback: last 7 days), newest at the right, capped at 31 columns
  const dataDays = [...new Set(rows.map((r) => r.day))].sort();
  const days = dataDays.length ? dataDays.slice(-31)
    : [...Array(7)].map((_, i) => new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10));
  const get = (d, e) => Number(rows.find((r) => r.day === d && r.event === e)?.n || 0);
  const maxV = Math.max(1, ...days.map((d) => get(d, "visit")));
  const ago = (x) => { if (!x) return "—"; const h = (Date.now() - new Date(x).getTime()) / 36e5; return h < 1 ? "hace minutos" : h < 24 ? `hace ${Math.round(h)}h` : `hace ${Math.round(h / 24)}d`; };
  const esc = (x) => String(x || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  // Agent month tabs — "since when they've been there," newest first.
  // created_at is an ISO string from the JSON store but a Date object from
  // Postgres; normalize through Date or the tabs read "Invalid Date".
  const monthKey = (x) => { const d = new Date(x || ""); return isNaN(d) ? "" : d.toISOString().slice(0, 7); };
  const monthLabel = (mk) => { if (!/^\d{4}-\d{2}$/.test(mk)) return mk; const [y, m] = mk.split("-").map(Number); const s = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("es-MX", { month: "long", year: "numeric" }); return s.charAt(0).toUpperCase() + s.slice(1); };
  const monthsPresent = [...new Set(list.map((c) => monthKey(c.created_at)).filter(Boolean))].sort().reverse();
  // 🔐 Security panel — reports only WHETHER each piece is configured, never
  // the values, so there's no reason to open (or screenshot) Render's env page.
  const wkReason = weakKeyReason(ADMIN_KEY);
  const secPills = [
    ["Postgres (datos permanentes)", db.dbKind() !== "file", "crítico"],
    ["RentCast · comps reales", !!RENTCAST_KEY, "crítico"],
    ["Google Maps · servidor", !!GOOGLE_KEY, "crítico"],
    ["Google Maps · navegador", !!process.env.GOOGLE_MAPS_BROWSER_KEY, "recomendado"],
    [`IA${aiLive ? ` · ${anthropic ? "Anthropic" : "OpenAI"}` : ""}`, aiLive, "recomendado"],
    ["Stripe · links de pago", !!process.env.STRIPE_PAYMENT_LINK, "para vender"],
    ["Stripe · webhook", !!STRIPE_WH_SECRET, "para vender"],
    ["Notificaciones push", pushLive, "recomendado"],
    ["Pase de demo (DEMO_PASS)", !!DEMO_PASS, "para el equipo"],
    ["Meta Pixel", !!process.env.META_PIXEL_ID, "para anuncios"],
    ["Dominio propio", !!ROOT_DOMAIN, "opcional"],
  ].map(([label, on, need]) => `<span class="pill ${on ? "ok" : (need === "opcional" || need === "recomendado") ? "dim" : "warn"}" title="${need}">${on ? "✓" : "✗"} ${label}${on ? "" : ` · falta (${need})`}</span>`).join(" ");
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick Comp · Admin</title><link rel="icon" href="/icon-192.png">
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{background:#F5F6F8;color:#0B1220;letter-spacing:-0.011em}
::selection{background:rgba(201,151,58,.35)}
a{-webkit-tap-highlight-color:transparent}
header{position:sticky;top:0;z-index:30;background:rgba(16,27,48,.9);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);color:#fff;padding:15px 24px;display:flex;align-items:center;gap:13px;border-bottom:1px solid rgba(255,255,255,.07)}
header img{height:32px;background:#fff;border-radius:10px;padding:4px 7px}
header b{font-size:16px;font-weight:700;letter-spacing:-0.02em}header b em{color:#C9973A;font-style:normal}
header .tag{margin-left:auto;font-size:12.5px;color:#9DA8C4;font-weight:600}
header .tag a{color:#cdd5e5;text-decoration:none}
.wrap{max-width:1100px;margin:0 auto;padding:26px 22px 64px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(166px,1fr));gap:14px}
.card{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:20px;padding:20px 22px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 10px 26px rgba(16,27,48,.045);transition:transform .2s cubic-bezier(.2,.7,.2,1),box-shadow .2s cubic-bezier(.2,.7,.2,1)}
.card:hover{transform:translateY(-2px);box-shadow:0 2px 5px rgba(16,27,48,.06),0 20px 44px rgba(16,27,48,.10)}
.card .v{font-size:33px;font-weight:700;letter-spacing:-0.035em;line-height:1.04}
.card .l{font-size:11px;font-weight:700;color:#9097A3;letter-spacing:.55px;text-transform:uppercase;margin-top:6px}
.card.gold{background:linear-gradient(155deg,#16243f 0%,#0d1729 100%);color:#fff;border:none;box-shadow:0 1px 2px rgba(0,0,0,.25),0 20px 48px rgba(16,27,48,.30)}
.card.gold .v{color:#C9973A}
.card.gold .l{color:#9DA8C4}
.panel{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:24px;padding:24px;margin-top:18px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 12px 32px rgba(16,27,48,.05)}
.panel h2{font-size:15.5px;font-weight:700;letter-spacing:-0.015em;margin-bottom:16px}
.chart{display:flex;align-items:flex-end;gap:10px;height:114px;padding:4px 2px 0}
.chart .col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:6px;height:100%}
.chart .bar{width:100%;max-width:46px;background:linear-gradient(180deg,#E2B65C,#C9973A);border-radius:10px 10px 4px 4px;min-height:3px;box-shadow:0 5px 12px rgba(201,151,58,.28);transition:filter .15s}
.chart .bar:hover{filter:brightness(1.06)}
.chart .lbl{font-size:10.5px;color:#9097A3;font-weight:700}
.chart .num{font-size:11px;font-weight:800;color:#0B1220}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:#9097A3;font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;font-weight:700;padding:10px;border-bottom:1px solid #EEF0F4}
td{padding:14px 10px;border-bottom:1px solid #F2F4F7;font-weight:600;color:#1B2433;vertical-align:middle}
td a{color:#B07A00;font-weight:700;text-decoration:none}
td a:hover{text-decoration:underline}
.pill{display:inline-block;border-radius:99px;padding:4px 11px;font-size:11px;font-weight:700;letter-spacing:.1px;white-space:nowrap}
td .pill{margin:2px 3px 2px 0}
.pill.ok{background:#E7F7ED;color:#10803C}
.pill.warn{background:#FDECEC;color:#C5221F}
.pill.dim{background:#F0F2F6;color:#8A94A8}
.pill.gold{background:#F7EFD8;color:#946400}
/* Agent list — a calm scan, not a wall of pills: bold name, warning pills
 * ONLY when something needs attention; the whole row opens the agent page. */
.csum{color:#67718A;font-size:13px;font-weight:700;margin:0 0 12px}
.csum b{color:#101B30}
.crow{display:flex;gap:12px;align-items:center;padding:15px 10px;border-bottom:1px solid #F2F4F7;text-decoration:none;color:#101B30;transition:background .12s}
.crow:last-child{border-bottom:none}
.crow:hover{background:#F7F9FC}
.cdot{width:9px;height:9px;border-radius:50%;background:#1E9E5A;flex-shrink:0;box-shadow:0 0 0 3px rgba(30,158,90,.14)}
.cdot.off{background:#C5221F;box-shadow:0 0 0 3px rgba(197,34,31,.12)}
.cname{flex:1;min-width:0;font-weight:800;font-size:14.5px;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cplan{background:#F7EFD8;color:#946400;border-radius:99px;padding:5px 12px;font-size:11.5px;font-weight:800;letter-spacing:.2px;white-space:nowrap;flex-shrink:0}
.cplan.dim{background:#F0F2F6;color:#8A94A8}
.cflag{background:#FDECEC;color:#C5221F;border-radius:99px;padding:5px 10px;font-size:11.5px;font-weight:800;white-space:nowrap;flex-shrink:0}
.cchev{color:#C3C9D4;font-size:19px;font-weight:700;flex-shrink:0;line-height:1}
@media(max-width:560px){.cplann{display:none}.cplan{font-size:11px;padding:4px 10px}.crow{gap:9px}}
.pcount{color:#9097A3;font-weight:600;font-size:13px;margin-left:6px}
.newform{display:flex;gap:10px;flex-wrap:wrap}
.newform input{flex:1;min-width:160px;font-family:inherit;padding:13px 15px;border-radius:13px;border:1px solid #E4E7EC;background:#fff;font-size:14.5px;font-weight:500;outline:none;transition:border-color .15s,box-shadow .15s}
.newform input:focus{border-color:#C9973A;box-shadow:0 0 0 4px rgba(201,151,58,.18)}
.newform button{background:#C9973A;color:#101B30;border:none;border-radius:13px;padding:13px 24px;font-weight:700;cursor:pointer;font-size:14.5px;transition:transform .12s,filter .15s;box-shadow:0 6px 16px rgba(201,151,58,.3)}
.newform button:hover{filter:brightness(1.03)}.newform button:active{transform:scale(.97)}
.legend{color:#9097A3;font-size:12px;margin-top:12px;line-height:1.6}
.closures{border:1px solid rgba(201,151,58,.28);box-shadow:0 1px 2px rgba(16,27,48,.04),0 12px 32px rgba(201,151,58,.08)}
.periodbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:2px 0 18px}
.segs{display:inline-flex;background:#EEF0F4;border-radius:12px;padding:3px;gap:2px}
.segcustom{flex-wrap:wrap}
.segcustom input[type=date]{max-width:146px;min-width:0}
.seg{padding:8px 15px;border-radius:9px;font-size:13px;font-weight:700;color:#5A6475;text-decoration:none;white-space:nowrap}
.seg.on{background:#fff;color:#101B30;box-shadow:0 1px 3px rgba(16,27,48,.12)}
.segcustom{display:inline-flex;gap:7px;align-items:center}
.segcustom input{font-family:inherit;padding:8px 10px;border-radius:10px;border:1px solid #E4E7EC;font-size:13px;font-weight:600;color:#1B2433;outline:none}
.segcustom input:focus{border-color:#C9973A;box-shadow:0 0 0 3px rgba(201,151,58,.18)}
.segcustom button{background:#101B30;color:#fff;border:none;border-radius:10px;padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer}
.segcustom button.on{background:#C9973A;color:#101B30}
.plabel{font-size:12.5px;font-weight:700;color:#9097A3}
.subcards{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:12px}
.sub{background:#F7F8FA;border:1px solid rgba(16,27,48,.05);border-radius:16px;padding:16px 18px}
.sub .v{font-size:26px;font-weight:700;letter-spacing:-.03em;line-height:1.05}
.sub .l{font-size:10.5px;font-weight:700;color:#9097A3;letter-spacing:.5px;text-transform:uppercase;margin-top:5px}
.sub.gold{background:linear-gradient(155deg,#16243f 0%,#0d1729 100%);border:none}
.sub.gold .v{color:#C9973A}.sub.gold .l{color:#9DA8C4}
.grid2{display:grid;gap:18px;grid-template-columns:minmax(0,1fr)}
.grid2>.panel{min-width:0}
@media(min-width:900px){.grid2{grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)}}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.lrow{display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid #F3F5F9;font-size:13.5px;font-weight:600}
.lprev{width:134px;height:86px;border-radius:10px;overflow:hidden;border:1px solid #E4E7EC;flex-shrink:0;background:#0B1226;box-shadow:0 4px 12px rgba(16,27,48,.08)}
.lprev iframe{width:1100px;height:705px;border:0;transform:scale(.122);transform-origin:0 0;pointer-events:none;background:#fff;display:block}
.lprev.ph{display:flex;align-items:center;justify-content:center;font-size:24px;background:#F4F6FA;color:#9AA0AC}
.lurl{color:#9AA0AC;font-size:12px;word-break:break-all}
.lbtns{display:flex;gap:6px;flex-shrink:0}
@media(max-width:620px){.lprev{display:none}}
/* Collapsible panels — closed by default so they're out of the way until
 * you actually need them; native <details> handles the show/hide. */
summary.psum{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;font-size:15.5px;font-weight:700;letter-spacing:-0.015em}
summary.psum::-webkit-details-marker{display:none}
summary.psum::after{content:"▾";margin-left:auto;color:#9097A3;font-size:13px;transition:transform .15s}
details[open]>summary.psum::after{transform:rotate(180deg)}
.pbody{margin-top:16px}
.mtabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.mtabs a{display:inline-flex;align-items:center;gap:5px;background:#EEF0F4;color:#5A6475;text-decoration:none;font-size:13px;font-weight:700;padding:8px 14px;border-radius:99px;white-space:nowrap}
.mtabs a b{font-weight:800}
.mtabs a.on{background:#101B30;color:#fff}
.mant{border:1.5px solid #F5C6C0;background:#fff;color:#C5221F;border-radius:12px;font-weight:800;font-size:13px;padding:12px 16px;cursor:pointer}
</style></head><body>
<header><img src="/brand-logo.png" alt=""><b>QUICK <em>COMP</em> · Admin</b><span class="tag"><a href="/admin/economics?key=${KEY}" style="color:#C9973A">🧮 Calculadora</a> · <a href="/cs?key=${KEY}" style="color:#9DA8C4">🎧 Servicio</a> · <a href="/admin?logout" style="color:#9DA8C4">salir</a></span></header>
<div class="wrap">

${wkReason ? `<div class="panel" style="border:1.5px solid #D93025;margin-top:0"><h2 style="margin-bottom:6px">🔐 Cambia tu llave de admin</h2><p class="legend" style="margin-top:0">Tu llave actual es débil (${esc(wkReason)}). Genera una fuerte (<code>openssl rand -hex 24</code>) y ponla en Render → Environment → ADMIN_KEY.</p></div>` : ""}

${periodSeg("/admin", range, false)}
<div class="cards">
  <div class="card gold"><div class="v">$${mrr.toLocaleString("en-US")}</div><div class="l" style="color:#9DA8C4">MRR · agentes pagando</div></div>
  <div class="card"><div class="v">${paying}</div><div class="l">Pagando</div>${(pendingPay || failedPay) ? `<div style="font-size:11px;font-weight:700;color:#8A94A8;margin-top:4px">${pendingPay ? `${pendingPay} pendiente` : ""}${pendingPay && failedPay ? " · " : ""}${failedPay ? `<span style="color:#C5221F">${failedPay} falló</span>` : ""}</div>` : ""}</div>
  <div class="card"><div class="v">${realClients.length}</div><div class="l">Agentes total</div></div>
  <div class="card"><div class="v">${leadsRange}</div><div class="l">Leads · ${range.label}</div></div>
  <div class="card"><div class="v">${tot("visit")}</div><div class="l">Visitas · ${range.label}</div></div>
  <div class="card"><div class="v">${tot("quiz_done")}</div><div class="l">Llamadas pedidas</div></div>
</div>

<div class="panel closures"><details data-p="cierres" open>
  <summary class="psum">💰 Cierres · reuniones del closer <span style="color:#9097A3;font-weight:600;font-size:12.5px">· ${range.label}</span></summary>
  <div class="subcards" style="margin-top:16px">
    <div class="sub gold"><div class="v">${closeRate}%</div><div class="l">Tasa de cierre</div></div>
    <div class="sub"><div class="v">${mst.total}</div><div class="l">Reuniones</div></div>
    <div class="sub"><div class="v">${mst.showed}</div><div class="l">Asistieron</div></div>
    <div class="sub"><div class="v" style="color:#C5221F">${mst.noShow}</div><div class="l">No-shows</div></div>
    <div class="sub"><div class="v">${mst.closed}</div><div class="l">Cerrados</div></div>
  </div>
  <p class="legend">Lo que registra tu closer en su portal. Las cuentas activadas con pago se ven en <b>MRR</b> arriba.</p>
</details></div>

<div class="grid2">
<div class="panel"><details data-p="visitas" open>
  <summary class="psum">📈 Visitas a la página · ${range.label}</summary>
  <div class="chart" style="margin-top:16px">
    ${days.map((d) => { const v = get(d, "visit"); return `<div class="col"><span class="num">${v || ""}</span><div class="bar" style="height:${Math.round((v / maxV) * 100)}%"></div><span class="lbl">${d.slice(5)}</span></div>`; }).join("")}
  </div>
</details></div>
<div class="panel"><details data-p="embudo" open>
  <summary class="psum">🫙 Embudo · ${range.label}</summary>
  <div class="pbody">
  <div class="scroll"><table>
    <tr><th>Visitas</th><th>Widget visto</th><th>Valuó</th><th>Prueba app</th><th>Quiz inició</th><th>Agendó</th></tr>
    <tr><td>${tot("visit")}</td><td>${tot("w_view")}</td><td>${tot("w_result")}</td><td>${tot("trial_link")}</td><td>${tot("quiz_work")}</td><td>${tot("quiz_done")}</td></tr>
  </table></div>
  ${geoTop.length || tot("geo_bot") ? (() => {
    const mx = geoTop.length ? geoTop[0][1] : 1;
    const totalGeo = geoTop.reduce((a, [, n]) => a + n, 0) || 1;
    const bots = tot("geo_bot");
    return `<p style="font-size:12px;font-weight:800;letter-spacing:1px;color:#8A94A8;margin:18px 0 8px">🌎 DE DÓNDE NOS VISITAN</p>
    ${geoTop.map(([city, n]) => `<div style="display:flex;align-items:center;gap:10px;margin:5px 0">
      <span style="flex:0 0 170px;font-size:13px;font-weight:700;color:#101B30;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(city)}</span>
      <span style="flex:1;background:#F0F2F6;border-radius:6px;height:14px;overflow:hidden"><span style="display:block;height:100%;width:${Math.max(4, Math.round((n / mx) * 100))}%;background:#C9973A;border-radius:6px"></span></span>
      <span style="flex:0 0 64px;text-align:right;font-size:12.5px;font-weight:800;color:#5A6478">${n} · ${Math.round((n / totalGeo) * 100)}%</span>
    </div>`).join("")}
    ${bots ? `<p style="font-size:12px;color:#9AA3B2;font-weight:600;margin:8px 0 0">🤖 ${bots} visita${bots === 1 ? "" : "s"} de bots o proxies (datacenters, rastreadores de links, iCloud Private Relay) — no cuentan como ciudades.</p>` : ""}`;
  })() : ""}
  <p class="legend">Visitas = página de ventas · Widget visto = abrieron el valuador · Valuó = vieron el valor · Prueba app = pidieron su link de prueba · Quiz inició = 1ª pregunta · Agendó = dejaron datos. Las ciudades salen de la IP del visitante (solo totales, nunca guardamos la IP). El filtro de fechas de arriba aplica a todo el tablero.</p>
  </div>
</details></div>
</div>

<div class="panel"><details data-p="ventas" ${salesPend ? 'open data-force="1"' : ""}>
  <summary class="psum">📣 Leads de venta ${salesPend ? `· <b style="color:#C5221F">${salesPend} sin contactar</b>` : `(${salesLeads.length})`}</summary>
  <div class="pbody">${salesLeadsPanel(salesLeads, KEY)}</div>
</details></div>

<div class="panel" style="border:1.5px solid ${wkReason ? "#D93025" : "rgba(16,27,48,.05)"}"><details data-p="seguridad">
  <summary class="psum">🔐 Seguridad y configuración</summary>
  <div class="pbody">${secPills}
  <p class="legend">Solo muestra si cada pieza está configurada — nunca los valores. Las llaves viven en Render → Environment.</p></div>
</details></div>

<div class="panel"><details data-p="enlaces">
  <summary class="psum">🔗 Tus enlaces</summary>
  <div class="pbody">
  ${[
    ["⭐ TU DÍA A DÍA — LOS 3 DE SIEMPRE", [
      ["1️⃣ 🎤 Presentación de ventas (en la llamada)", `${base}/demo`],
      ["2️⃣ 🎨 Onboarding (armar/editar páginas)", `${base}/onboarding`],
      ["3️⃣ 🎧 Customer service (tickets y tareas)", `${base}/cs`],
    ]],
    ["PÚBLICO · VENTAS", [
      ["🌐 Página de ventas", `${base}/ventas`],
      ["🏡 Demo del valuador (mándalo a prospectos)", `${base}/w/alto-demo`],
      ["🏠 Página de ejemplo", `${base}/ejemplo`],
      ["🎨 Las plantillas", `${base}/plantillas`],
    ]],
    ["EQUIPO · VENTAS (closer)", [
      ["🔒 Portal del closer", `${base}/closer`],
      ["📋 Cierre / objeciones (privado)", `${base}/cierre`],
    ]],
    ["RECLUTAR", [
      ["👤 Presentación del rol (reclutar)", `${base}/equipo`],
    ]],
    ["PRIVADO · TÚ", [
      ["📊 Este tablero (admin)", `${base}/admin`],
      ["🧠 Centro de mando · números + IA", `${base}/admin/economics`],
      ["📲 La app (instalar/probar)", `${base}/`],
      ["🩺 Estado del sistema (health)", `${base}/api/health`],
    ]],
  ].map(([group, links]) => `
    <p style="font-size:11px;font-weight:800;letter-spacing:1.5px;color:#8A94A8;margin:16px 0 6px">${group}</p>
    ${links.map(([name, url]) => {
      const noPrev = /\/admin$/.test(url) || url.includes("/api/health") || url === `${base}/`;
      const keyed = /\/(closer|cierre|cs|onboarding|admin\/economics)$/.test(url);
      const psrc = keyed ? `${url}?key=${KEY}` : url;
      const thumb = noPrev
        ? `<div class="lprev ph">🔗</div>`
        : `<div class="lprev"><iframe loading="lazy" scrolling="no" tabindex="-1" src="${psrc}"></iframe></div>`;
      return `<div class="lrow">
      ${thumb}
      <span style="flex:1">${name}<br><span class="lurl">${url}</span></span>
      <span class="lbtns">
        <button onclick="cpy(this,'${url}')" style="background:#C9973A;color:#101B30;border:none;border-radius:8px;padding:7px 12px;font-weight:800;cursor:pointer;font-size:12px">Copiar</button>
        <a href="${url}" target="_blank" style="background:#101B30;color:#fff;border-radius:8px;padding:7px 12px;font-weight:800;text-decoration:none;font-size:12px">Abrir</a>
      </span>
    </div>`; }).join("")}
  `).join("")}
  <p style="color:#9AA0AC;font-size:12px;margin-top:14px">El portal del closer y el onboarding piden clave; los públicos no.</p>
  </div>
</details></div>

<div class="panel"><details data-p="nuevo">
  <summary class="psum">➕ Nuevo agente</summary>
  <div class="pbody">
  <form class="newform" method="post" action="/api/admin/contractors?html=1&key=${KEY}">
    <input name="name" placeholder="Nombre del agente o inmobiliaria" required>
    <input name="phone" placeholder="Teléfono">
    <select name="plan" style="font-family:inherit;padding:12px 14px;border-radius:12px;border:1.5px solid #E4E7EC;font-weight:600;background:#fff;color:#101B30"><option value="">Plan (opcional) — se auto-detecta con el pago</option>${Object.entries(PLANS).map(([k, p]) => `<option value="${k}">${p.name} — $${p.price}/mes</option>`).join("")}</select>
    <button>Crear cuenta</button>
  </form>
  <p class="legend">Crea la cuenta y te dará un enlace de invitación (su llave personal). Compártelo por texto/WhatsApp — no necesita App Store.</p>
  </div>
</details></div>

<div class="panel"><details data-p="agentes" open>
  <summary class="psum">👥 Agentes<span class="pcount">(${list.length})</span></summary>
  <div class="pbody">
  <p class="csum"><b>${realClients.filter((c) => !(c.data && c.data.status === "paused")).length}</b> activos · <b>${realClients.filter((c) => c.data && c.data.status === "paused").length}</b> pausados · <b>$${mrr.toLocaleString("en-US")}</b> MRR</p>
  <input id="csearch" placeholder="🔍 Buscar agente por nombre…" onkeyup="filterClients()" style="width:100%;padding:14px 16px;border:1px solid #E4E7EC;border-radius:14px;font-size:14.5px;font-weight:500;font-family:inherit;outline:none;margin-bottom:14px;transition:border-color .15s,box-shadow .15s" onfocus="this.style.borderColor='#C9973A';this.style.boxShadow='0 0 0 4px rgba(201,151,58,.18)'" onblur="this.style.borderColor='#E4E7EC';this.style.boxShadow='none'">
  <div class="mtabs" id="mtabs">
    <a href="#" class="on" data-m="all" onclick="filterMonth('all');return false">Todos <b>(${list.length})</b></a>
    ${monthsPresent.map((mk) => {
      const count = list.filter((c) => monthKey(c.created_at) === mk).length;
      return `<a href="#" data-m="${mk}" onclick="filterMonth('${mk}');return false">${monthLabel(mk)} <b>(${count})</b></a>`;
    }).join("")}
  </div>
  <div id="clist">
  ${list.map((c) => {
    const isB = BUILTIN.has(c.slug);
    const isPaused = c.data && c.data.status === "paused";
    const pay = c.data && c.data.payStatus;
    const dev = devCounts[String(c.id)] || 0;
    // The row answers one question at a glance: who is it, what plan, and is
    // anything on fire. Everything else (actions, links, payments, GHL) lives
    // on the agent page the whole row links to.
    const issues = [
      isPaused ? "pausado" : "",
      pay === "failed" ? "pago falló" : "",
      pay === "pending" ? "pago pendiente" : "",
      pay === "canceled" ? "canceló" : "",
      (!isB && dev >= 4) ? `${dev} dispositivos — posible link compartido` : "",
    ].filter(Boolean);
    return `<a class="crow" href="/admin/c/${c.slug}?key=${KEY}" data-name="${esc(c.name).toLowerCase()} ${c.slug}" data-month="${monthKey(c.created_at)}">
      <span class="cdot${isPaused ? " off" : ""}" title="${isPaused ? "Pausado" : "Activo"}"></span>
      <span class="cname">${esc(c.name)}</span>
      ${issues.length ? `<span class="cflag" title="${esc(issues.join(" · "))}">⚠ ${issues.length}</span>` : ""}
      ${isB ? '<span class="cplan dim">interno</span>' : `<span class="cplan"><span class="cplann">${PLANS[planOf(c)].name.split(" ·")[0].toUpperCase()} · </span>$${Number(c.data?.planAmount) || PLANS[planOf(c)].price}/mes</span>`}
      <span class="cchev">›</span>
    </a>`;
  }).join("")}
  </div>
  </div>
</details></div>

<div class="panel"><details data-p="ultimos">
  <summary class="psum">📥 Últimos leads (todos los agentes)</summary>
  <div class="pbody">
  <div class="scroll"><table>
  <tr><th>Cuándo</th><th>Agente</th><th>Nombre</th><th>Teléfono</th><th>Dirección / datos</th><th>Valor visto</th></tr>
  ${recent.length === 0 ? `<tr><td colspan="6" style="color:#8A94A8">Todavía no hay leads — llegarán aquí en cuanto alguien valúe su casa o llene el quiz.</td></tr>` : recent.map((l) => {
    const i = l.info || {};
    const extra = i.work ? `${esc(i.work)} · ${esc(i.crew || "")} · ${esc(i.revenue || "")}` : esc(l.address);
    const est = i.low ? `$${Number(i.low).toLocaleString("en-US")}–$${Number(i.high).toLocaleString("en-US")}` : "—";
    return `<tr><td>${ago(l.created_at)}</td><td>${esc(l.contractor_name || l.slug)}</td><td>${esc(l.name)}</td><td>${esc(l.phone)}</td><td>${extra}</td><td>${est}</td></tr>`;
  }).join("")}
  </table></div>
  </div>
</details></div>

<div class="panel"><details data-p="mant">
  <summary class="psum">⚙️ Mantenimiento · respaldo y empezar de cero</summary>
  <div class="pbody">
    <p class="legend" style="margin-bottom:12px">Respaldo mensual con 1 clic (sin tokens de sesión — un respaldo filtrado nunca abre nada). Los botones de reinicio piden confirmación — pensados para justo antes de prender anuncios. Para borrar un agente: entra a su página.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <a class="mant" style="background:#E8F4EA;border-color:#BFE3C6;color:#1E6B33;text-decoration:none;display:inline-block" href="/api/admin/backup?key=${KEY}">⬇️ Descargar respaldo (todos los datos)</a>
      <button class="mant" style="background:#EAF1FB;border-color:#BCD3F2;color:#1A5AAB" onclick="document.getElementById('restoreFile').click()">⬆️ Restaurar respaldo</button>
      <input type="file" id="restoreFile" accept="application/json,.json" style="display:none" onchange="doRestore(this)">
      <button class="mant" onclick="if(confirm('¿Archivar TODOS los leads de venta actuales? El buzón queda en cero. (Se archivan, no se destruyen.)'))fetch('/api/sales/clearleads?key=${KEY}',{method:'POST'}).then(r=>r.json()).then(j=>j.ok?location.reload():alert('Error'))">🧹 Archivar leads de venta</button>
      <button class="mant" onclick="if(confirm('¿Reiniciar TODAS las estadísticas de visitas y embudo a cero?'))fetch('/api/sales/clearmetrics?key=${KEY}',{method:'POST'}).then(r=>r.json()).then(j=>j.ok?location.reload():alert('Error'))">🧹 Reiniciar visitas y embudo</button>
      <button class="mant" onclick="if(confirm('¿Borrar TODO el historial de reuniones del closer?'))fetch('/api/admin/clearmeetings?key=${KEY}',{method:'POST'}).then(r=>r.json()).then(j=>j.ok?location.reload():alert('Error'))">🧹 Reiniciar reuniones del closer</button>
    </div>
  </div>
</details></div>

</div>
<script>
// each panel remembers open/closed per browser; alarm panels (data-force) always open
(function(){try{var st=JSON.parse(localStorage.getItem('qc_panels')||'{}');
[].forEach.call(document.querySelectorAll('details[data-p]'),function(d){
  var k=d.getAttribute('data-p');
  if(!d.hasAttribute('data-force')&&typeof st[k]==='boolean')d.open=st[k];
  d.addEventListener('toggle',function(){st[k]=d.open;try{localStorage.setItem('qc_panels',JSON.stringify(st))}catch(e){}});
});}catch(e){}})();
function cpy(btn,url){navigator.clipboard.writeText(url);var o=btn.textContent;btn.textContent='✓';setTimeout(function(){btn.textContent=o},900);}
function doRestore(inp){
  var f=inp.files&&inp.files[0]; inp.value='';
  if(!f)return;
  var rd=new FileReader();
  rd.onload=function(){
    var dump; try{dump=JSON.parse(rd.result);}catch(e){alert('Ese archivo no es un respaldo válido (no es JSON).');return;}
    var list=dump.clients||dump.contractors;
    if(!Array.isArray(list)){alert('Ese archivo no parece un respaldo de Quick Comp.');return;}
    var nL=(dump.clients?dump.clients.reduce(function(a,c){return a+((c.leads||[]).length)},0):(dump.leads||[]).length);
    if(!confirm('¿Restaurar este respaldo?\\n\\n'+list.length+' agentes y '+nL+' leads se van a AGREGAR o ACTUALIZAR. No se borra nada de lo que ya tienes.\\n\\nEscribe RESTAURAR en el siguiente paso para confirmar.'))return;
    var typed=prompt('Para confirmar, escribe: RESTAURAR');
    if(typed!=='RESTAURAR'){alert('Cancelado — no se restauró nada.');return;}
    fetch('/api/admin/restore?key=${KEY}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'RESTAURAR',dump:dump})})
      .then(function(r){return r.json();})
      .then(function(j){ if(j.ok){var n=j.restored||{};alert('Respaldo restaurado ✓\\n\\nAgentes: '+n.contractors+'\\nLeads: '+n.leads+'\\nReuniones: '+n.meetings+'\\nTareas: '+n.tasks);location.reload();} else alert('Error: '+(j.error||'?')); })
      .catch(function(){alert('No se pudo restaurar (revisa tu conexión).');});
  };
  rd.readAsText(f);
}
var currentMonth='all';
function filterMonth(m){
  currentMonth=m;
  [].forEach.call(document.querySelectorAll('#mtabs a'),function(a){a.classList.toggle('on',a.getAttribute('data-m')===m);});
  filterClients();
}
function filterClients(){
  var q=document.getElementById('csearch').value.toLowerCase().trim();
  [].forEach.call(document.querySelectorAll('.crow[data-name]'),function(row){
    var matchQ = !q || row.getAttribute('data-name').indexOf(q)>=0;
    var matchM = currentMonth==='all' || row.getAttribute('data-month')===currentMonth;
    row.style.display = (matchQ && matchM) ? '' : 'none';
  });
}
</script>
</body></html>`);
});

app.post("/api/admin/ceo", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "no auth" });
  const en = req.body?.lang === "en";
  const m = req.body?.metrics || {};
  const system = `You are a sharp, no-nonsense fractional CEO / growth advisor for Quick Comp, a bilingual SaaS sold to real-estate agents in three plans with no setup fees — $67/mo (app only), $197/mo (widget on their existing site), $297/mo (website + widget + app + AI secretary + leads). Given the numbers, write a concise, PRIORITIZED action plan in ${en ? "English" : "Spanish"}, max 160 words, plain text (no markdown headers). Be direct and specific: if close rate is low, say to fix/coach/replace closers BEFORE scaling ads; if unit economics are strong (LTV:CAC >= 3, payback < 3mo), say to scale ad spend and by roughly how much; flag churn and failed payments as fires to put out first. End with the single most important next action. No fluff.`;
  const user = `Numbers: ${JSON.stringify(m)}`;
  try {
    const text = await aiChat({ system, messages: [{ role: "user", content: user }], maxTokens: 380 });
    if (!text) return res.json({ ok: false, error: "ai_off" });
    res.json({ ok: true, text });
  } catch (e) { res.json({ ok: false, error: "ai_off" }); }
});

app.get("/admin/economics", async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).send("Set ADMIN_KEY env var to enable admin.");
  if (safeEq(req.query.key, ADMIN_KEY)) { setKeyCookie(res, "alto_admin", ADMIN_KEY); return res.redirect("/admin/economics"); }
  if (!adminOk(req)) return res.status(req.query.key ? 403 : 401).send(loginPage("Admin", "/admin/economics", !!req.query.key));
  const en = req.query.lang === "en";
  const tr = (es, eng) => (en ? eng : es);
  // pull REAL numbers from the system
  const now = new Date();
  const mFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [mst, mstMonth, list] = await Promise.all([
    db.meetingStats().catch(() => ({ total: 0, closed: 0, noShow: 0 })),
    db.meetingStats({ from: mFrom, to: null }).catch(() => ({ total: 0 })),
    db.listContractors().catch(() => []),
  ]);
  const clients = list.filter((c) => !["alto-demo", "alto-ventas"].includes(c.slug));
  const payCount = (s) => clients.filter((c) => (c.data?.payStatus || "") === s).length;
  const live = {
    realClose: mst.total ? Math.round((mst.closed / mst.total) * 100) : null,
    meetings: mst.total, closed: mst.closed, noShow: mst.noShow || 0, meetingsMonth: mstMonth.total || 0,
    clients: clients.length, paying: payCount("ok"), pending: payCount("pending"), failed: payCount("failed"), canceled: payCount("canceled"),
  };
  res.send(`<!doctype html><html lang="${en ? "en" : "es"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick Comp · ${tr("Centro de mando", "Command center")}</title><link rel="icon" href="/icon-192.png"><style>
*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body{background:#F5F6F8;color:#0B1220;letter-spacing:-0.011em}
::selection{background:rgba(201,151,58,.35)}
.appheader{position:sticky;top:0;z-index:30;background:rgba(16,27,48,.9);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);color:#fff;padding:15px 24px;display:flex;align-items:center;gap:13px;border-bottom:1px solid rgba(255,255,255,.07)}
.appheader img{height:30px;background:#fff;border-radius:9px;padding:4px 6px}
.appheader b{font-size:16px;font-weight:700;letter-spacing:-0.02em}.appheader b em{color:#C9973A;font-style:normal}
.appheader .right{margin-left:auto;display:flex;gap:8px;align-items:center}
.appheader .right a{color:#cdd5e5;text-decoration:none;font-weight:600;font-size:13px;border-radius:99px;padding:7px 14px}
.appheader .right a.dark{background:rgba(255,255,255,.1);color:#fff}
.wrap{max-width:1120px;margin:0 auto;padding:24px 22px 70px}
h1{font-size:25px;font-weight:700;letter-spacing:-0.03em}
.sub{color:#5E6675;font-weight:500;font-size:13.5px;margin:6px 0 18px;line-height:1.6;max-width:680px}
.sect{font-size:12px;color:#9097A3;letter-spacing:.6px;text-transform:uppercase;font-weight:800;margin:22px 0 10px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.card{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:16px;padding:16px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 8px 22px rgba(16,27,48,.045)}
.card .v{font-size:25px;font-weight:700;letter-spacing:-0.035em;line-height:1.04}
.card .l{font-size:10.5px;font-weight:700;color:#9097A3;letter-spacing:.4px;text-transform:uppercase;margin-top:5px}
.card .s{font-size:11px;font-weight:600;color:#8A94A8;margin-top:4px;line-height:1.4}
.card.gold{background:linear-gradient(155deg,#16243f 0%,#0d1729 100%);border:none}
.card.gold .v{color:#C9973A}.card.gold .l{color:#9DA8C4}.card.gold .s{color:#9DA8C4}
.card.good .v{color:#10803C}.card.bad .v{color:#C5221F}.card.warnc .v{color:#8A6A00}
.grid{display:grid;gap:16px;margin-top:6px}
@media(min-width:900px){.grid{grid-template-columns:360px 1fr;align-items:start}}
.panel{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:20px;padding:20px 22px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 10px 26px rgba(16,27,48,.05)}
.panel h3{font-size:12px;color:#9097A3;letter-spacing:.6px;text-transform:uppercase;font-weight:700;margin-bottom:14px}
.fld{margin-bottom:13px}
.fld label{display:block;font-weight:600;font-size:12.5px;color:#475067;margin-bottom:5px}
.fld .row{display:flex;align-items:center;gap:9px}
.fld input[type=range]{flex:1;accent-color:#C9973A}
.fld .val{min-width:78px;display:flex;align-items:center;background:#F4F6FA;border:1px solid #E4E7EC;border-radius:9px;padding:6px 9px;font-weight:800;font-size:13.5px;color:#101B30}
.fld .val .pre{color:#9097A3;font-weight:700;margin-right:2px}
.fld .val input{width:100%;border:none;background:none;outline:none;font-weight:800;font-size:13.5px;color:#101B30;text-align:right;font-family:inherit}
.fld .hint{color:#9097A3;font-size:11px;font-weight:500;margin-top:3px}
.fx{display:flex;gap:7px;align-items:center;margin-bottom:7px}
.fx input.n{flex:1;font-family:inherit;padding:8px 10px;border:1px solid #E4E7EC;border-radius:9px;font-size:13px;font-weight:600;outline:none}
.fx input.a{width:74px;font-family:inherit;padding:8px 10px;border:1px solid #E4E7EC;border-radius:9px;font-size:13px;font-weight:800;text-align:right;outline:none}
.fx button{background:#FDECEC;border:none;color:#C5221F;border-radius:8px;width:30px;height:32px;font-weight:800;cursor:pointer}
.fxadd{background:#fff;border:1px dashed #C9CDD6;border-radius:9px;padding:8px;font-weight:700;font-size:12.5px;color:#475067;cursor:pointer;width:100%}
.fxtot{display:flex;justify-content:space-between;font-weight:800;font-size:14px;margin-top:8px;padding-top:8px;border-top:1px solid #EEF0F4}
.adv{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #F2F4F7;font-size:13px;font-weight:600;line-height:1.5}
.adv:last-child{border-bottom:none}.adv .ic{flex-shrink:0;font-size:16px}
.adv.bad{color:#9B1C10}.adv.warn{color:#7a5600}.adv.good{color:#1E7B3C}
.aibtn{background:#101B30;color:#fff;border:none;border-radius:12px;padding:13px 20px;font-weight:800;cursor:pointer;font-size:14px;margin-top:4px}
.aibtn:disabled{opacity:.6}
.aibox{white-space:pre-wrap;background:#0B1226;color:#E7ECF6;border-radius:14px;padding:16px 18px;margin-top:12px;font-size:13px;line-height:1.65;font-weight:500;display:none}
.aibox.show{display:block}
.vnote{background:#FFF7E0;border:1px solid #F3D27A;border-radius:14px;padding:13px 16px;font-size:13px;font-weight:500;color:#5E6675;line-height:1.6;margin-bottom:16px}
.vnote b{color:#7a5600}
</style></head><body>
<div class="appheader">
  <img src="/brand-logo.png" alt=""><b>QUICK <em>COMP</em> · ${tr("Centro de mando", "Command center")}</b>
  <div class="right"><a href="/admin">← Admin</a><a href="/admin/economics?lang=${en ? "es" : "en"}">${en ? "🇲🇽 Español" : "🇺🇸 English"}</a><a class="dark" href="/admin?logout">${tr("salir", "log out")}</a></div>
</div>
<div class="wrap">
<h1>${tr("Centro de mando del negocio", "Business command center")}</h1>
<p class="sub">${tr("Tus números reales en vivo + tu plan. Cambia tus costos y números de adquisición y el consejero te dice qué hacer.", "Your real numbers live + your plan. Adjust your costs and acquisition numbers and the advisor tells you what to do.")}</p>

<div class="sect">📡 ${tr("En vivo · de tu sistema", "Live · from your system")}</div>
<div class="cards">
  <div class="card ${live.realClose == null ? "" : live.realClose < 25 ? "bad" : live.realClose < 35 ? "warnc" : "good"}"><div class="v">${live.realClose == null ? "—" : live.realClose + "%"}</div><div class="l">${tr("Tasa de cierre real", "Real close rate")}</div><div class="s">${live.closed}/${live.meetings} ${tr("reuniones", "meetings")}</div></div>
  <div class="card gold"><div class="v" id="o_mrr">$0</div><div class="l">MRR</div><div class="s">${live.paying} ${tr("pagando", "paying")}</div></div>
  <div class="card"><div class="v">${live.meetingsMonth}</div><div class="l">${tr("Reuniones este mes", "Meetings this month")}</div></div>
  <div class="card ${live.failed ? "bad" : ""}"><div class="v">${live.failed}</div><div class="l">${tr("Pago fallido", "Failed payments")}</div></div>
  <div class="card ${live.canceled ? "warnc" : ""}"><div class="v">${live.canceled}</div><div class="l">${tr("Cancelados", "Canceled")}</div></div>
  <div class="card"><div class="v">${live.pending}</div><div class="l">${tr("Esperando pago", "Awaiting payment")}</div></div>
</div>

<div class="grid">
  <div class="panel">
    <h3>💸 ${tr("Costos fijos / mes", "Fixed costs / month")}</h3>
    <div id="fxlist"></div>
    <button class="fxadd" onclick="fxAdd()">+ ${tr("Agregar costo", "Add cost")}</button>
    <div class="fxtot"><span>${tr("Total fijo / mes", "Total fixed / month")}</span><span id="fxtot">$0</span></div>
    <h3 style="margin-top:20px">🚀 ${tr("Plan de crecimiento", "Growth plan")}</h3>
    <div class="fld"><label>${tr("Inversión en anuncios / mes", "Ad spend / month")}</label><div class="row"><input type="range" id="r_spend" min="100" max="10000" step="100"><div class="val"><span class="pre">$</span><input id="i_spend"></div></div></div>
    <div class="fld"><label>${tr("Costo por lead (anuncio)", "Cost per lead (ads)")}</label><div class="row"><input type="range" id="r_lead" min="1" max="40" step="1"><div class="val"><span class="pre">$</span><input id="i_lead"></div></div></div>
    <div class="fld"><label>${tr("Lead → reunión", "Lead → meeting")}</label><div class="row"><input type="range" id="r_book" min="2" max="80" step="1"><div class="val"><input id="i_book"><span style="color:#9097A3;font-weight:700">%</span></div></div></div>
    <div class="fld"><label>${tr("Reunión → cierre", "Meeting → close")} <span id="closehint" style="color:#1E7B3C;font-weight:700"></span></label><div class="row"><input type="range" id="r_close" min="5" max="90" step="1"><div class="val"><input id="i_close"><span style="color:#9097A3;font-weight:700">%</span></div></div></div>
    <div class="fld"><label>${tr("Precio mensual", "Monthly price")}</label><div class="row"><input type="range" id="r_price" min="99" max="699" step="10"><div class="val"><span class="pre">$</span><input id="i_price"></div></div></div>
    <div class="fld"><label>${tr("Costo de servir / cliente (APIs, Stripe)", "Cost to serve / client (APIs, Stripe)")}</label><div class="row"><input type="range" id="r_serve" min="10" max="120" step="5"><div class="val"><span class="pre">$</span><input id="i_serve"></div></div></div>
    <div class="fld"><label>${tr("Comisión del closer (por venta)", "Closer commission (per sale)")}</label><div class="row"><input type="range" id="r_comm" min="0" max="400" step="10"><div class="val"><span class="pre">$</span><input id="i_comm"></div></div></div>
    <div class="fld"><label>${tr("Meses que se queda el cliente", "Months a client stays")}</label><div class="row"><input type="range" id="r_life" min="1" max="36" step="1"><div class="val"><input id="i_life"><span style="color:#9097A3;font-weight:700">${tr("mes", "mo")}</span></div></div></div>
  </div>
  <div>
    <div class="sect" style="margin-top:0">📉 ${tr("Tu embudo — si gastas esto en anuncios", "Your funnel — if you spend this on ads")}</div>
    <div class="cards" style="margin-bottom:12px">
      <div class="card"><div class="v" id="o_leads">0</div><div class="l">${tr("Leads / mes", "Leads / month")}</div><div class="s" id="o_leadss"></div></div>
      <div class="card"><div class="v" id="o_meet">0</div><div class="l">${tr("Reuniones / mes", "Meetings / month")}</div><div class="s" id="o_meets"></div></div>
      <div class="card"><div class="v" id="o_close">0</div><div class="l">${tr("Ventas / mes", "Sales / month")}</div><div class="s" id="o_closes"></div></div>
      <div class="card gold"><div class="v" id="o_nmrr">$0</div><div class="l">${tr("Nuevo MRR / mes", "New MRR / month")}</div><div class="s" id="o_nmrrs"></div></div>
      <div class="card good"><div class="v" id="o_coh">$0</div><div class="l">${tr("Valor total (su vida)", "Total value (lifetime)")}</div></div>
      <div class="card"><div class="v" id="o_ratio">0x</div><div class="l">${tr("Retorno (LTV:CAC)", "Return (LTV:CAC)")}</div><div class="s" id="o_ratiomsg"></div></div>
    </div>
    <div class="vnote" id="verdict"></div>
    <div class="panel">
      <h3>🧭 ${tr("El consejero — qué hacer", "The advisor — what to do")}</h3>
      <div id="advice"></div>
      <button class="aibtn" id="aibtn" onclick="genPlan()">🧠 ${tr("Generar mi plan con IA", "Generate my plan with AI")}</button>
      <div class="aibox" id="aibox"></div>
    </div>
  </div>
</div>
</div>
<script>
var EN=${en ? "true" : "false"};
var LIVE=${JSON.stringify(live)};
function mm(es,eng){return EN?eng:es;}
function money(n){return "$"+Math.round(n).toLocaleString("en-US");}
// inputs
var F=[["spend",1000],["price",297],["serve",25],["comm",100],["lead",8],["book",20],["close",${live.realClose != null ? live.realClose : 33}],["life",12]];
var S={};try{S=JSON.parse(localStorage.getItem("alto_cockpit")||"{}")||{}}catch(e){S={}}
F.forEach(function(f){if(S[f[0]]==null)S[f[0]]=f[1];});
// fixed costs
var FX=[];try{FX=JSON.parse(localStorage.getItem("alto_fixed")||"null")}catch(e){FX=null}
if(!FX)FX=EN?[{n:"Hosting (Render)",a:25},{n:"Database (Supabase)",a:25},{n:"HighLevel",a:97},{n:"Domain",a:1},{n:"Your salary",a:0}]:[{n:"Hosting (Render)",a:25},{n:"Base de datos (Supabase)",a:25},{n:"HighLevel",a:97},{n:"Dominio",a:1},{n:"Tu sueldo",a:0}];
function fxRender(){var h="";FX.forEach(function(x,i){h+='<div class="fx"><input class="n" value="'+(x.n||"").replace(/"/g,"&quot;")+'" oninput="fxSet('+i+',\\'n\\',this.value)"><input class="a" type="number" value="'+(x.a||0)+'" oninput="fxSet('+i+',\\'a\\',this.value)"><button onclick="fxDel('+i+')">×</button></div>';});document.getElementById("fxlist").innerHTML=h;}
function fxSet(i,k,v){FX[i][k]=k==="a"?(parseFloat(v)||0):v;fxSave();calc();}
function fxDel(i){FX.splice(i,1);fxSave();fxRender();calc();}
function fxAdd(){FX.push({n:"",a:0});fxSave();fxRender();}
function fxSave(){try{localStorage.setItem("alto_fixed",JSON.stringify(FX))}catch(e){}}
function fxTotal(){return FX.reduce(function(a,x){return a+(parseFloat(x.a)||0);},0);}
function clampNum(v,k){v=parseFloat(v);if(isNaN(v))v=0;if(k==="book"||k==="close")v=Math.max(1,Math.min(99,v));if(k==="life")v=Math.max(1,Math.min(60,v));if(v<0)v=0;return v;}
function bind(k){var r=document.getElementById("r_"+k),i=document.getElementById("i_"+k);r.value=S[k];i.value=S[k];
  r.addEventListener("input",function(){S[k]=clampNum(r.value,k);i.value=S[k];calc();});
  i.addEventListener("input",function(){S[k]=clampNum(i.value,k);r.value=S[k];calc();});}
var LASTM={};
function calc(){
  var spend=S.spend,cpl=S.lead,l2m=S.book/100,m2c=S.close/100,price=S.price,comm=S.comm,serve=S.serve,life=S.life;
  var leads=cpl>0?spend/cpl:0;
  var meetings=leads*l2m;
  var costPerMeeting=meetings>0?spend/meetings:0;
  var closes=meetings*m2c;
  var cac=closes>0?(spend/closes+comm):0;
  var contrib=price-serve, ltvClient=contrib*life;
  var newMRR=closes*price, cohort=closes*ltvClient;
  var ratio=cac>0?ltvClient/cac:0, payback=contrib>0?cac/contrib:99;
  var fixed=fxTotal(), beClients=contrib>0?Math.ceil(fixed/contrib):0;
  var mrrNow=LIVE.paying*price, coProfit=mrrNow-fixed-(LIVE.paying*serve);
  document.getElementById("o_mrr").textContent=money(mrrNow);
  document.getElementById("fxtot").textContent=money(fixed);
  document.getElementById("o_leads").textContent=Math.round(leads);
  document.getElementById("o_leadss").textContent=money(cpl)+"/lead";
  document.getElementById("o_meet").textContent=Math.round(meetings);
  document.getElementById("o_meets").textContent=mm("c/reunión ","/meeting ")+money(costPerMeeting);
  document.getElementById("o_close").textContent=(Math.round(closes*10)/10);
  document.getElementById("o_closes").textContent="CAC "+money(cac);
  document.getElementById("o_nmrr").textContent=money(newMRR);
  document.getElementById("o_nmrrs").textContent="≈"+money(newMRR*12)+mm("/año","/yr");
  document.getElementById("o_coh").textContent=money(cohort);
  document.getElementById("o_ratio").textContent=(ratio?ratio.toFixed(1):"0")+"x";
  document.getElementById("o_ratiomsg").textContent=ratio>=3?mm("sano","healthy"):ratio>0?mm("flojo","weak"):"";
  var ch=document.getElementById("closehint");ch.textContent=LIVE.realClose!=null?"(real: "+LIVE.realClose+"%)":"";
  document.getElementById("verdict").innerHTML=mm(
    "Con <b>"+money(spend)+"/mes</b> en anuncios: ~<b>"+Math.round(leads)+" leads</b> → <b>"+Math.round(meetings)+" reuniones</b> (a "+money(costPerMeeting)+" c/u) → <b>"+(Math.round(closes*10)/10)+" ventas</b>. Eso suma <b>"+money(newMRR)+" de MRR nuevo CADA mes</b> ("+money(cohort)+" en toda su vida). Cada cliente te cuesta <b>"+money(cac)+"</b> y vale <b>"+money(ltvClient)+"</b>.",
    "With <b>"+money(spend)+"/mo</b> in ads: ~<b>"+Math.round(leads)+" leads</b> → <b>"+Math.round(meetings)+" meetings</b> (at "+money(costPerMeeting)+" each) → <b>"+(Math.round(closes*10)/10)+" sales</b>. That adds <b>"+money(newMRR)+" new MRR EVERY month</b> ("+money(cohort)+" lifetime). Each client costs <b>"+money(cac)+"</b> and is worth <b>"+money(ltvClient)+"</b>.");
  LASTM={adSpendMonth:spend,costPerLead:cpl,leadsPerMonth:Math.round(leads),leadToMeetingPct:S.book,meetingsPerMonth:Math.round(meetings),costPerMeeting:Math.round(costPerMeeting),meetingToClosePct:S.close,realCloseRate:LIVE.realClose,salesPerMonth:+closes.toFixed(1),CAC:Math.round(cac),price:price,newMRRPerMonth:Math.round(newMRR),ltvPerClient:Math.round(ltvClient),cohortLifetimeValue:Math.round(cohort),ltvCacRatio:+ratio.toFixed(1),retentionMonths:life,fixedCostsMonth:Math.round(fixed),clientsToCoverFixed:beClients,currentMRR:Math.round(mrrNow),payingClients:LIVE.paying,failedPayments:LIVE.failed,canceled:LIVE.canceled};
  advise(cac,ltvClient,ratio,payback,(ltvClient-cac),fixed,beClients,coProfit);
  try{localStorage.setItem("alto_cockpit",JSON.stringify(S))}catch(e){}
}
function advise(cac,ltv,ratio,payback,profit,fixed,beClients,coProfit){
  var A=[];var cr=LIVE.realClose!=null?LIVE.realClose:S.close;
  if(cr<20)A.push(["bad","🛑",mm("Cierre muy bajo ("+cr+"%). El problema NO son los leads — es el cierre. Entrena o cambia al closer ANTES de gastar más en anuncios.","Close rate very low ("+cr+"%). The problem is NOT leads — it's closing. Coach or replace the closer BEFORE spending more on ads.")]);
  else if(cr<35)A.push(["warn","⚠️",mm("Cierre mejorable ("+cr+"%). Subir el cierre baja tu CAC más que cualquier otra palanca — trabaja guion y objeciones.","Close rate improvable ("+cr+"%). Lifting close rate cuts CAC more than any other lever — work the script and objections.")]);
  else A.push(["good","✅",mm("Cierre fuerte ("+cr+"%). Tus closers convierten.","Strong close rate ("+cr+"%). Your closers convert.")]);
  if(profit<=0)A.push(["bad","🛑",mm("Pierdes dinero por cliente con estos números — sube precio, baja costo por lead, o mejora cierre/retención.","You lose money per client with these numbers — raise price, lower cost per lead, or improve close/retention.")]);
  else if(ratio>=3&&payback<3&&cr>=30)A.push(["good","🚀",mm("Tus números aguantan crecer (retorno "+ratio.toFixed(1)+"x, recuperas en "+payback.toFixed(1)+" meses). Sube el presupuesto de anuncios.","Your numbers support scaling (return "+ratio.toFixed(1)+"x, payback "+payback.toFixed(1)+"mo). Increase ad spend.")]);
  else if(ratio<3)A.push(["warn","⚠️",mm("Retorno flojo ("+ratio.toFixed(1)+"x). Antes de escalar: sube precio, baja costo por lead, o mejora cierre/retención.","Weak return ("+ratio.toFixed(1)+"x). Before scaling: raise price, lower cost per lead, or improve close/retention.")]);
  if(LIVE.canceled>0&&LIVE.clients>0&&(LIVE.canceled/LIVE.clients)>0.1)A.push(["warn","🔁",mm("Cancelaciones altas ("+LIVE.canceled+"). Arregla retención — estás llenando una cubeta con hoyos.","High churn ("+LIVE.canceled+"). Fix retention — you're filling a leaky bucket.")]);
  if(LIVE.failed>0)A.push(["warn","💳",mm(LIVE.failed+" cliente(s) con pago fallido. Que servicio les recuerde HOY actualizar su tarjeta.","Cancel "+LIVE.failed+" client(s) with failed payments. Have CS remind them TODAY to update their card.")]);
  A.push([coProfit>=0?"good":"warn",coProfit>=0?"💰":"📉",LIVE.paying>=beClients?mm("Ya cubres tus costos fijos ("+LIVE.paying+" de "+beClients+" clientes). Lo demás es ganancia.","You cover your fixed costs ("+LIVE.paying+" of "+beClients+" clients). The rest is profit."):mm("Aún no cubres lo fijo: necesitas "+beClients+" clientes pagando y tienes "+LIVE.paying+".","Not covering fixed costs yet: you need "+beClients+" paying clients and have "+LIVE.paying+".")]);
  document.getElementById("advice").innerHTML=A.map(function(x){return '<div class="adv '+x[0]+'"><span class="ic">'+x[1]+'</span><span>'+x[2]+'</span></div>';}).join("");
}
function genPlan(){var b=document.getElementById("aibtn"),box=document.getElementById("aibox");b.disabled=true;b.textContent=mm("🧠 Pensando…","🧠 Thinking…");
  fetch("/api/admin/ceo",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({lang:EN?"en":"es",metrics:LASTM})}).then(function(r){return r.json()}).then(function(j){
    b.disabled=false;b.textContent=mm("🧠 Generar mi plan con IA","🧠 Generate my plan with AI");
    if(j&&j.ok){box.textContent=j.text;box.classList.add("show");}
    else{box.textContent=mm("La IA no está activa (falta API key).","AI is not active (missing API key).");box.classList.add("show");}
  }).catch(function(){b.disabled=false;b.textContent=mm("🧠 Generar mi plan con IA","🧠 Generate my plan with AI");box.textContent=mm("No se pudo — intenta de nuevo.","Couldn't generate — try again.");box.classList.add("show");});}
fxRender();F.forEach(function(f){bind(f[0]);});calc();
</script>
</body></html>`);
});

app.get("/admin/c/:slug", async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).send("Set ADMIN_KEY env var.");
  if (!adminOk(req)) return res.status(401).send(loginPage("Admin", "/admin", false));
  const c = await db.getContractorBySlug(String(req.params.slug));
  if (!c) return res.status(404).send("Cliente no encontrado. <a href='/admin'>← Volver</a>");
  const KEY = encodeURIComponent(ADMIN_KEY);
  const esc = (x) => String(x || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const d = c.data || {}, p = d.profile || {}, st = d.site || {};
  const leads = await db.listLeads(c.id).catch(() => []);
  const devCount = (await db.sessionCounts().catch(() => ({})))[String(c.id)] || 0;
  const ago = (x) => { if (!x) return "—"; const h = (Date.now() - new Date(x).getTime()) / 36e5; return h < 1 ? "hace minutos" : h < 24 ? `hace ${Math.round(h)}h` : `hace ${Math.round(h / 24)}d`; };
  const prettyPhone = (x) => { const z = String(x || "").replace(/\D/g, "").replace(/^1/, ""); return z.length === 10 ? `(${z.slice(0, 3)}) ${z.slice(3, 6)}-${z.slice(6)}` : (x || "—"); };
  const isPaused = d.status === "paused";
  const pay = d.payStatus || "—";
  const payColor = pay === "ok" ? "#1E7B3C" : pay === "failed" ? "#C5221F" : pay === "pending" ? "#9A6E00" : "#8A94A8";
  const payLabel = { ok: "✓ pagando", failed: "💳 pago falló", pending: "⏳ pendiente de pago", canceled: "canceló" }[pay] || "sin estado";
  // Embed snippet for the Widget tier — the code the team sends to clients
  // who already have a website (paste-in, works on any site builder).
  const embedCode = `<iframe src="${canonBase(req)}/w/${c.slug}" style="width:100%;max-width:420px;height:660px;border:0;border-radius:24px;box-shadow:0 12px 32px rgba(16,27,48,.15)" loading="lazy" title="Home value"></iframe>`;
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.name)} · Quick Comp Admin</title><link rel="icon" href="/icon-192.png"><style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{background:#F5F6F8;color:#0B1220;letter-spacing:-0.011em}
::selection{background:rgba(201,151,58,.35)}
header{position:sticky;top:0;z-index:30;background:rgba(16,27,48,.9);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);color:#fff;padding:15px 24px;display:flex;align-items:center;gap:13px;border-bottom:1px solid rgba(255,255,255,.07)}
header img{height:30px;background:#fff;border-radius:9px;padding:4px 6px}
header a{color:#cdd5e5;text-decoration:none;font-weight:600;font-size:13px}
.wrap{max-width:940px;margin:0 auto;padding:26px 22px 64px}
h1{font-size:28px;font-weight:700;letter-spacing:-0.03em}.slug{color:#9097A3;font-weight:600;font-size:14px;margin-top:2px}
.badges{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 4px}
.pill{border-radius:99px;padding:5px 13px;font-size:12px;font-weight:700;white-space:nowrap}
.panel{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:22px;padding:22px 24px;margin-top:18px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 12px 30px rgba(16,27,48,.05)}
.panel h2{font-size:12px;color:#9097A3;letter-spacing:.6px;text-transform:uppercase;font-weight:700;margin-bottom:14px}
.kv{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid #F2F4F7;font-weight:600;font-size:14.5px}
.kv:last-child{border-bottom:none}
.kv span:first-child{color:#67718A}
.kv a{color:#B07A00;font-weight:700;text-decoration:none}
.acts{display:flex;flex-wrap:wrap;gap:10px}
.acts a,.acts button{display:inline-flex;align-items:center;text-decoration:none;border:none;border-radius:13px;padding:12px 18px;font-weight:700;font-size:13.5px;cursor:pointer;font-family:inherit;transition:transform .12s,filter .15s}
.acts a:hover,.acts button:hover{filter:brightness(1.02);transform:translateY(-1px)}
.acts a:active,.acts button:active{transform:scale(.97)}
.b-dark{background:#101B30;color:#fff;box-shadow:0 6px 16px rgba(16,27,48,.2)}
.b-gold{background:#C9973A;color:#101B30;box-shadow:0 6px 16px rgba(201,151,58,.3)}
.b-line{background:#fff;border:1px solid #E4E7EC;color:#101B30;box-shadow:0 1px 2px rgba(16,27,48,.04)}
.b-red{background:#FDECEC;color:#C5221F}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:#9097A3;font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;font-weight:700;padding:10px;border-bottom:1px solid #EEF0F4}
td{padding:13px 10px;border-bottom:1px solid #F2F4F7;font-weight:600;color:#1B2433}
.sw{width:18px;height:18px;border-radius:6px;display:inline-block;vertical-align:middle;border:1px solid rgba(0,0,0,.1)}
</style></head><body>
<header><img src="/brand-logo.png" alt=""><a href="/admin">← Tablero</a></header>
<div class="wrap">
<h1>${esc(c.name)}</h1><div class="slug">/${c.slug}</div>
<div class="badges">
  <span class="pill" style="background:${isPaused ? "#FDECEC" : "#EAF8EF"};color:${isPaused ? "#C5221F" : "#1E7B3C"}">${isPaused ? "⏸ pausado" : "● activo"}</span>
  <span class="pill" style="background:#F0F2F6;color:${payColor}">${payLabel}</span>
  <span class="pill" style="background:#F0F2F6;color:${st.published ? "#1E7B3C" : "#9A6E00"}">${st.published ? "🌐 página publicada" : "🏗️ en construcción"}</span>
</div>

<div class="panel"><h2>Acciones</h2><div class="acts">
  ${isPaused
    ? `<button class="b-gold" onclick="act('/api/admin/status?key=${KEY}&id=${c.id}&status=active','¿Reactivar?')">▶ Reactivar</button>`
    : `<button class="b-red" onclick="act('/api/admin/status?key=${KEY}&id=${c.id}&status=paused','¿Pausar? Su sitio y valuador dejan de recibir leads.')">⏸ Pausar</button>`}
  ${(!isPaused && pay === "pending")
    ? `<button class="b-gold" onclick="act('/api/admin/status?key=${KEY}&id=${c.id}&status=active','¿Confirmas que ya pagó (efectivo, Zelle u otro medio)? Esto activa su cuenta ahora mismo.')">✓ Activar (pago manual)</button>`
    : ""}
  <button class="b-dark" onclick="pub(${st.published ? "false" : "true"})">${st.published ? "Ocultar página" : "🚀 Publicar página"}</button>
  <a class="b-line" href="/onboarding?key=${KEY}&slug=${c.slug}">🎨 Onboarding</a>
  <a class="b-line" href="/api/admin/invite?key=${KEY}&id=${c.id}">🔑 Link de acceso</a>
  <button class="b-line" onclick="revoke()">🔒 Renovar acceso</button>
  <button class="b-line" onclick="hook()">🤖 GHL ${d.webhook ? "(conectado)" : ""}</button>
</div></div>

<div class="panel"><h2>Enlaces</h2>
  <div class="kv"><span>Widget</span><a href="/w/${c.slug}" target="_blank">/w/${c.slug}</a></div>
  <div class="kv"><span>Página (pública)</span><a href="/site/${c.slug}" target="_blank">/site/${c.slug}</a></div>
  <div class="kv"><span>Borrador (preview)</span><a href="/site/${c.slug}?preview=1" target="_blank">ver borrador</a></div>
  <div class="kv"><span>Sitio</span><span>${esc(siteDisplay(req, c.slug))}</span></div>
  ${st.domain ? `<div class="kv"><span>Dominio propio</span><a href="https://${esc(st.domain)}" target="_blank">${esc(st.domain)}</a></div>` : ""}
</div>

<div class="panel"><h2>🌐 Widget en SU página (plan Widget)</h2>
  <p style="color:#67718A;font-size:13px;font-weight:600;margin:0 0 10px;line-height:1.55">Para clientes que ya tienen página: copia este código y mándaselo por WhatsApp — lo pega él (o su web developer) y listo. Funciona en WordPress, Wix, GoDaddy, cualquier sitio. Cada dueño que valúa su casa le llega como lead igual que siempre.</p>
  <textarea id="emb" readonly onclick="this.select()" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:11.5px;color:#5A6478;background:#F7F8FA;border:1px solid #E4E7EC;border-radius:12px;padding:12px;resize:none" rows="4">${esc(embedCode)}</textarea>
  <button onclick="cpEmb(this)" style="margin-top:8px;background:#C9973A;color:#101B30;border:none;border-radius:10px;padding:10px 18px;font-weight:800;cursor:pointer;font-size:13px">📋 Copiar código</button>
</div>

<div class="panel"><h2>Negocio y sitio</h2>
  <div class="kv"><span>Teléfono</span><span>${prettyPhone(p.phone || c.phone)}</span></div>
  <div class="kv"><span>Ciudad</span><span>${esc(st.city) || "—"}</span></div>
  <div class="kv"><span>Plantilla</span><span>${st.template || "1"}</span></div>
  <div class="kv"><span>Color</span><span><span class="sw" style="background:${/^#[0-9a-fA-F]{6}$/.test(st.color || "") ? st.color : "#B30F24"}"></span> ${esc(st.color) || "—"}</span></div>
  <div class="kv"><span>Creado</span><span>${String(c.created_at).slice(0, 10)}</span></div>
  <div class="kv"><span>Dispositivos / aperturas</span><span>${devCount >= 4 ? `<b style="color:#C5221F">📱 ${devCount}</b> — posible link compartido; ofrécele cuentas para su equipo` : (devCount || "—")}</span></div>
</div>

<div class="panel"><h2>Leads (${leads.length})</h2>
  <div style="overflow-x:auto"><table>
  <tr><th>Cuándo</th><th>Nombre</th><th>Teléfono</th><th>Dirección</th><th>Estimado</th><th></th></tr>
  ${leads.length ? leads.slice(0, 50).map((l) => {
    const i = l.info || {};
    const est = i.low ? `$${Number(i.low).toLocaleString("en-US")}–$${Number(i.high).toLocaleString("en-US")}` : "—";
    const wa = String(l.phone || "").replace(/\D/g, "").replace(/^1/, "");
    return `<tr><td>${ago(l.created_at)}</td><td>${esc(l.name) || "—"}</td><td>${prettyPhone(l.phone)}</td><td>${esc(l.address) || (i.work ? esc(i.work) : "—")}</td><td>${est}</td><td>${wa.length === 10 ? `<a href="https://wa.me/1${wa}" target="_blank">💬</a>` : ""}</td></tr>`;
  }).join("") : `<tr><td colspan="6" style="color:#8A94A8">Sin leads todavía.</td></tr>`}
  </table></div>
</div>
</div>
<script>
function act(url,q){ if(q&&!confirm(q))return; fetch(url,{method:'POST'}).then(r=>r.json()).then(j=>{ if(!j.ok)alert('Error: '+j.error); location.reload(); }); }
function cpEmb(b){ navigator.clipboard.writeText(document.getElementById('emb').value); var o=b.textContent; b.textContent='✓ Copiado'; setTimeout(function(){ b.textContent=o; },1200); }
function pub(v){ fetch('/api/onboarding/publish?key=${KEY}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:'${c.slug}',publish:v})}).then(r=>r.json()).then(()=>location.reload()); }
function hook(){ var u=prompt('Webhook de HighLevel (vacío = desconectar):'); if(u===null)return; fetch('/api/admin/webhook?key=${KEY}&id=${c.id}&url='+encodeURIComponent(u),{method:'POST'}).then(r=>r.json()).then(j=>{alert(j.ok?'✓ Guardado':'Error');location.reload();}); }
function revoke(){ if(!confirm('¿Renovar acceso? TODOS sus links y dispositivos actuales quedan desconectados y se genera un link nuevo (mándaselo).'))return; var f=document.createElement('form'); f.method='POST'; f.action='/api/admin/revoke?key=${KEY}&id=${c.id}'; document.body.appendChild(f); f.submit(); }
</script>
</body></html>`);
});

// Invite link: exchanges for a session and drops the user into the app.
// Accounts pending payment see a wait page instead — the same link starts
// working the moment Stripe confirms (or the admin activates manually).
app.get("/invite/:token", async (req, res) => {
  const session = await db.useInvite(req.params.token);
  if (!session) {
    // Dead link = revoked or mistyped. Don't leave them at a blank 404 —
    // tell them how to get back in.
    return res.status(404).send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick Comp</title><style>*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0}
body{background:#15244C;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:22px;padding:36px 28px;max-width:400px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.45)}
h1{font-size:19px;color:#15244C;margin-bottom:8px}p{color:#5A6478;font-size:14px;font-weight:600;line-height:1.6}</style></head>
<body><div class="card"><span style="font-size:40px">🔒</span>
<h1>Este link ya no es válido</h1>
<p>Tu link de acceso fue renovado por seguridad o el enlace está incompleto.<br><br>Escríbenos por WhatsApp y te mandamos tu link nuevo en un minuto.</p>
</div></body></html>`);
  }
  const who = await db.getSessionContractor(session).catch(() => null);
  if (who?.data?.payStatus === "pending") {
    return res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick Comp</title><style>
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0}
body{background:#15244C;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:22px;padding:36px 28px;max-width:400px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.45)}
img{height:54px;margin-bottom:12px}h1{font-size:19px;color:#15244C;margin-bottom:8px}
p{color:#5A6478;font-size:14px;font-weight:600;line-height:1.6}
a{display:inline-block;margin-top:18px;background:#C9973A;color:#fff;text-decoration:none;font-weight:800;padding:13px 24px;border-radius:12px}
</style></head><body><div class="card">
<img src="/brand-logo.png" alt="Quick Comp">
<h1>⏳ Tu cuenta se está activando</h1>
<p>Se activa sola en cuanto se confirme tu pago — normalmente toma <b>1 minuto</b>.<br><br>Guarda este link (es tu llave 🔑) y vuelve a tocarlo en un momento.</p>
<a href="">Intentar de nuevo</a>
</div></body></html>`);
  }
  res.redirect(`/#session=${session}`);
});

// The app asks: who am I, and what's my saved data?
app.get("/api/me", async (req, res) => {
  const c = await auth(req);
  if (!c) return res.status(401).json({ error: "no session" });
  const state = await db.getState(c.id);
  res.json({ contractor: { id: c.id, slug: c.slug, name: c.name, phone: c.phone, data: c.data || {} }, state });
});

// The app saves its data (customers, jobs, profile) — whole snapshot, simple and safe
app.put("/api/state", async (req, res) => {
  const c = await auth(req);
  if (!c) return res.status(401).json({ error: "no session" });
  await db.saveState(c.id, req.body?.state || {});
  // MERGE into the account's data — never replace it, and NEVER let the app
  // write server-owned billing/system keys. The client controls req.body.profile
  // entirely, so we (a) strip protected keys from what it sends and (b) force the
  // real stored values back on top — a signed-in client cannot mark itself paid,
  // unpause itself, hijack its Stripe customer, or set its webhook/site/plan.
  if (req.body?.profile && typeof req.body.profile === "object" && !Array.isArray(req.body.profile)) {
    const PROTECTED = ["payStatus", "status", "payFailedAt", "stripeCustomer", "selfServe", "plan", "planAmount", "webhook", "site", "createdAt"];
    const cur = c.data || {};
    const incoming = { ...req.body.profile };
    for (const k of PROTECTED) delete incoming[k];
    const merged = { ...cur, ...incoming };
    for (const k of PROTECTED) { if (k in cur) merged[k] = cur[k]; else delete merged[k]; }
    await db.saveContractorData(c.id, merged);
  }
  res.json({ ok: true });
});

// Forward a fresh lead to the contractor's HighLevel (or any) webhook so
// automations — AI texting, booking, notifications — fire instantly.
// Fire-and-forget: a dead webhook must never lose or delay the lead.
function forwardLead(c, lead) {
  const hook = c.data?.webhook;
  if (!hook || !/^https:\/\//.test(hook)) return;
  fetchT(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "quick-comp", contractor: c.slug, ...lead }),
  }, 6000).catch((e) => console.error(`webhook ${c.slug} failed:`, e.message));
}

/* ── Web push (the buzz): a new lead pings the realtor's phone ──
 * Dormant until VAPID keys exist (generate once: npx web-push
 * generate-vapid-keys → VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in Render).
 * Subscriptions live in the account's data.push — capped at 5 devices,
 * dead endpoints pruned on every send. See playbook/05-env.md. */
const VAPID_PUB = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIV = process.env.VAPID_PRIVATE_KEY || "";
const pushLive = !!(VAPID_PUB && VAPID_PRIV);
if (pushLive) webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:hello@getquickcomp.com", VAPID_PUB, VAPID_PRIV);

async function notifyLead(c, lead) {
  if (!pushLive) return;
  const subs = Array.isArray(c.data?.push) ? c.data.push : [];
  if (!subs.length) return;
  const es = (c.data?.profile?.lang || "") === "es";
  const payload = JSON.stringify({
    title: es ? "📥 ¡Nuevo lead de venta!" : "📥 New seller lead!",
    body: [lead.name, lead.address].filter(Boolean).join(" · ") || String(lead.phone || ""),
    url: "/?open=leads",
    tag: "qc-lead",
  });
  const dead = [];
  await Promise.all(subs.map((s) => webpush.sendNotification(s, payload).catch((e) => {
    if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint); // device gone — prune
    else console.error("push failed:", e.statusCode || e.message);
  })));
  if (dead.length) {
    const keep = subs.filter((s) => !dead.includes(s.endpoint));
    await db.saveContractorData(c.id, { ...(c.data || {}), push: keep }).catch(() => {});
  }
}

// The app asks for the public key before subscribing (404 = push not configured)
app.get("/api/push/key", (req, res) => (pushLive ? res.json({ key: VAPID_PUB }) : res.status(404).json({ error: "push_off" })));

// Signed-in realtor registers this device for the lead buzz
app.post("/api/push/subscribe", async (req, res) => {
  const c = await auth(req);
  if (!c) return res.status(401).json({ error: "no session" });
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !/^https:\/\//.test(String(sub.endpoint)) || !sub.keys?.p256dh || !sub.keys?.auth) {
    return res.status(400).json({ error: "bad subscription" });
  }
  const subs = (Array.isArray(c.data?.push) ? c.data.push : []).filter((s) => s.endpoint !== sub.endpoint);
  subs.unshift({ endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
  await db.saveContractorData(c.id, { ...(c.data || {}), push: subs.slice(0, 5) }); // newest 5 devices win
  res.json({ ok: true, devices: Math.min(subs.length, 5) });
});

/* Ping the team the moment something needs a human — a payment (send their
 * access link!) or a new sales lead. Fire-and-forget to STAFF_WEBHOOK_URL
 * (Slack/Discord-compatible {text} payload). No-op until it's configured, so
 * nothing breaks before launch. Everything worth acting on already logs too. */
function notifyStaff(text) {
  const hook = process.env.STAFF_WEBHOOK_URL || "";
  if (!/^https:\/\//.test(hook)) return;
  fetchT(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: String(text).slice(0, 500), content: String(text).slice(0, 500) }),
  }, 6000).catch(() => { /* best-effort — a dead alert must never block the flow */ });
}

/* Drop a persistent, clearable item into the /cs support inbox — the dashboard
 * the team logs into and works top-to-bottom each day. This is the PRIMARY
 * channel; notifyStaff's external webhook is optional phone-push on top. A
 * failed task write must never break the paying flow, so it's swallowed. */
function queueTask(slug, title, note) {
  return db.addTask({ slug: slug || "", title, note }).catch((e) => console.error("queue task failed:", e.message));
}

// Widget (and anything public) drops a lead for a contractor by slug
app.post("/api/widget/lead", async (req, res) => {
  const wlIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`wl:${wlIp}`, 10)) return res.status(429).json({ error: "quota" });
  const { slug, name, phone, address, info } = req.body || {};
  const c = slug && (await db.getContractorBySlug(String(slug)));
  if (!c) return res.status(404).json({ error: "unknown contractor" });
  if (c.data?.status === "paused") return res.status(403).json({ error: "paused" });
  if (!phone) return res.status(400).json({ error: "phone required" });
  const id = await db.addLead(c.id, { name, phone, address, info });
  forwardLead(c, { id, name, phone, address, ...info });
  notifyLead(c, { name, phone, address }).catch(() => {}); // buzz the realtor's phone
  // A lead on the sales/demo account is a PROSPECT AGENT (the /ventas quiz) —
  // queue a call task in /cs and ping the team; the quiz promised them a call today.
  if (c.slug === "alto-ventas" || c.slug === "alto-demo") {
    const bits = [info?.work, info?.crew, info?.revenue].filter(Boolean).join(" · ");
    await queueTask("", "📞 Llamar lead de ventas", `${name || "(sin nombre)"} · ${phone}${bits ? ` · ${bits}` : ""}. Le prometimos una llamada hoy — contáctalo.`);
    notifyStaff(`📞 NEW sales lead: ${name || "(no name)"} · ${phone}${info?.work ? ` · ${info.work}` : ""}. Promised a call today — reach out.`);
  }
  res.json({ ok: true, id });
});

app.get("/api/leads", async (req, res) => {
  const c = await auth(req);
  if (!c) return res.status(401).json({ error: "no session" });
  res.json({ leads: await db.listLeads(c.id) });
});

app.post("/api/leads/:id", async (req, res) => {
  const c = await auth(req);
  if (!c) return res.status(401).json({ error: "no session" });
  // A mini-CRM, deliberately tiny (ALTO's 5-stage pipeline): a lead is
  // new/contacted/interested/closed (won) or not-interested (out), plus one
  // optional free-text note. Either field may be sent alone.
  const ALLOWED = ["new", "contacted", "interested", "not-interested", "closed"];
  if (req.body?.status !== undefined) {
    const status = String(req.body.status).slice(0, 20);
    await db.updateLeadStatus(c.id, String(req.params.id), ALLOWED.includes(status) ? status : "contacted");
  }
  if (req.body?.note !== undefined) {
    await db.updateLeadNote(c.id, String(req.params.id), String(req.body.note).slice(0, 300));
  }
  res.json({ ok: true });
});

/* ── Instant-quote widget ──
 * Public page each client website embeds (or links to directly from an ad).
 * A homeowner types their address, leaves name + phone, and sees a satellite-
 * measured ballpark price computed from THIS contractor's saved prices.
 * Every submission becomes a lead in the contractor's app — even when the
 * roof can't be measured. */

// Cost control: daily caps per visitor IP and per contractor, plus a 24h
// per-address cache so repeat lookups don't re-bill the Solar API.
const quotaMap = new Map();
function overQuota(key, max) {
  const day = new Date().toISOString().slice(0, 10);
  const q = quotaMap.get(key);
  if (q && q.day === day) { q.n += 1; return q.n > max; }
  // New key or a new day — (re)insert and keep the map bounded on EVERY insert.
  // (The old code only evicted on the existing-key branch, so distinct keys —
  // one per IP/event — grew the map without limit and stale days never swept.)
  quotaMap.set(key, { day, n: 1 });
  if (quotaMap.size > 5000) {
    for (const [k, v] of quotaMap) { if (v.day !== day) quotaMap.delete(k); if (quotaMap.size <= 4000) break; }
    while (quotaMap.size > 5000) quotaMap.delete(quotaMap.keys().next().value);
  }
  return false;
}
const quoteCache = new Map();

/* Funnel tracking: tiny first-party counters, no cookies, no identities.
 * Only whitelisted event names are accepted. */
const TRACK_EVENTS = new Set(["visit", "quiz_work", "quiz_crew", "quiz_revenue", "quiz_marketing", "quiz_done", "w_view", "w_result", "trial_link"]);

/* Visitor-city analytics (ALTO pattern): each landing visit bumps an aggregate
 * geo:<City, ST> counter — the admin funnel shows the totals. The IP itself
 * never lands in the metrics, only city counts. Lookup uses the free no-key
 * ipwho.is API, hard-capped per day and fire-and-forget: a slow or dead geo
 * service can never slow down or break the page. Datacenter/proxy networks
 * (crawlers, iCloud Private Relay) count in their own geo_bot bucket so the
 * city list only shows real people on real networks. `google(?! fiber)` keeps
 * Google Fiber customers (a real consumer ISP) human. */
const HOSTED_ORG = /amazon|aws\b|google(?! fiber)|microsoft|azure|cloudflare|akamai|apple|icloud|digital ?ocean|linode|ovh|hetzner|oracle|vultr|fastly|facebook|meta plat|hosting|data ?cent|leaseweb|choopa|m247|colocat|server|crawl|spider|bot/i;
async function geoBump(ip) {
  try {
    if (!ip || /^(10\.|192\.168\.|127\.|::1|::ffff:127\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return;
    const ck = `geoip2:${ip}`;
    let g = await db.kvGet(ck, 30 * 864e5).catch(() => null);
    if (!g) {
      if (overQuota("geoipd:all", 800)) return; // stay well under the free tier
      const r = await fetchT(`https://ipwho.is/${encodeURIComponent(ip)}`, {}, 3500);
      const j = await r.json().catch(() => null);
      g = j && j.success !== false && j.city
        ? { c: String(j.city).slice(0, 40), r: String(j.region_code || j.region || "").slice(0, 20), cc: String(j.country_code || "").slice(0, 2), o: String(j.connection?.org || j.connection?.isp || "").slice(0, 60) }
        : { fail: 1 }; // cache failures too — don't re-ask for the same IP all day
      await db.kvSet(ck, g).catch(() => {});
    }
    if (g.fail || !g.c) return;
    if (HOSTED_ORG.test(String(g.o || ""))) { await db.bumpMetric("geo_bot"); return; }
    const label = g.cc === "US" ? `${g.c}, ${g.r}` : `${g.c}, ${g.cc}`;
    await db.bumpMetric(`geo:${label}`.slice(0, 60));
  } catch { /* analytics must never touch the page */ }
}

app.post("/api/track", (req, res) => {
  const trIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`tr:${trIp}`, 300)) return res.json({ ok: true }); // silently ignore spam
  const event = String(req.body?.event || "");
  if (!TRACK_EVENTS.has(event)) return res.status(400).json({ error: "bad event" });
  db.bumpMetric(event).catch(() => { /* counters must never break the page */ });
  if (event === "visit") geoBump(trIp); // deliberately not awaited
  res.json({ ok: true });
});

/* Live AI-secretary demo for the sales presentation: the prospect chats
 * with the same AI that will answer their own customers' texts. */
/* Site chat (ALTO pattern): every client site's floating bubble talks here.
 * With a live client slug the bot answers AS that realtor's business, using
 * ONLY staff-curated botFacts as extra truth — and a phone number typed in
 * chat becomes a real lead (saved + GHL forward + push buzz). Without a live
 * slug it stays the Casa Bella sales-demo persona the deck uses. */
app.post("/api/widget/chat", async (req, res) => {
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
  if (!msgs.length) return res.status(400).json({ error: "messages required" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`chat:${ip}`, 40) || overQuota("chat:all", 500)) return res.status(429).json({ error: "quota" });
  const slug = String(req.body?.slug || "").slice(0, 60);
  const demoSlug = slug === "alto-demo" || slug === "alto-ventas"; // sales personas — never create real leads
  const c = slug && !demoSlug ? await db.getContractorBySlug(slug).catch(() => null) : null;
  const live = c && c.data?.status !== "paused" ? c : null;

  // Staff "Probar el chat" (?preview=1) marks every message test=true —
  // same bot, same wording, but NO real lead, NO push to the real agent.
  const testMode = req.body?.test === true;

  // Lead capture: only the NEWEST visitor message is scanned (history is
  // re-sent every turn), and the client sets leadSent after the first catch.
  let captured = false;
  if (live && !req.body?.leadSent && !testMode) {
    const lastUser = [...msgs].reverse().find((m) => m.role !== "assistant");
    const userText = String(lastUser?.content || "");
    const m = userText.match(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
    const digits = m ? m[0].replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "") : "";
    if (digits.length === 10) {
      // Grab the name when they introduce themselves ("soy Pedro García…")
      let name = "";
      const nm = userText.match(/(?:me llamo|mi nombre es|soy|my name is|i am|i'm|this is)[\s:]+([a-zA-ZÀ-ſ]+(?:\s+[a-zA-ZÀ-ſ]+)?)/i);
      if (nm && !/^(de|del|la|el|un|una|cliente|yo|the|a)$/i.test(nm[1].split(/\s/)[0])) name = nm[1].slice(0, 40);
      try {
        const convo = msgs.filter((x) => x.role !== "assistant").map((x) => String(x.content || "").slice(0, 200)).join(" · ").slice(0, 600);
        const id = await db.addLead(live.id, { name, phone: digits, address: "", info: { src: "chat", chat: convo } });
        forwardLead(live, { id, name, phone: digits, src: "chat" });
        notifyLead(live, { name: name || "💬 Chat de tu página", phone: digits }).catch(() => {});
        captured = true;
      } catch (e) { console.error("chat lead failed:", e.message); }
    }
  }

  if (!aiLive) return res.json({ text: "(Demo) La IA se activa cuando el servidor tenga su API key.", source: "demo", captured });
  try {
    const inEnglish = req.body?.lang === "en";
    const tone = `Responde SIEMPRE en ${inEnglish ? "inglés" : "español"}, estilo mensaje de texto: cálido, profesional, máximo 45 palabras, sin markdown.`;
    // The one true story the bot tells: leaving a phone number notifies the
    // realtor's phone INSTANTLY (real push). It captures the lead — it does
    // NOT manage a calendar, so it never invents appointment slots.
    const playbook = ` Tu meta #1: conseguir el NOMBRE y TELÉFONO del cliente. Si piden que alguien les llame o les urge: di que SÍ — pide su nombre y teléfono, y explica que al dejarlo le llega la notificación al agente EN ESE MOMENTO, directo a su celular. NO manejas calendario: nunca inventes horarios de cita ni prometas "mañana a las 10". Si piden cita, di que con gusto la confirman cuando le marquen de regreso. NUNCA des el valor de una casa ni precios: el valuador de esta misma página da el estimado en segundos, y el análisis completo (CMA) lo prepara el agente. Cumple Fair Housing: nunca afirmes nada sobre la calidad de vecindarios, escuelas o tipos de personas — si preguntan, di que el agente les comparte datos objetivos en su llamada. Lo que no sepas, di que el agente lo confirma cuando le llame — no inventes datos.`;
    // Did the newest message include a phone number? (also true in the deck
    // demo, where no lead is saved but the mock phone dings via postMessage)
    const gaveContact = captured || /\d{3}[\s.\-()]*\d{3}[\s.\-]*\d{4}/.test(String([...msgs].reverse().find((x) => x.role !== "assistant")?.content || ""));
    const confirmLine = " El cliente ACABA de dejar su teléfono: dale las gracias por su nombre y número, y confirma que EN ESTE MOMENTO le llegó la notificación al agente a su celular y que le marcan de regreso muy pronto.";
    let system;
    if (live) {
      const p = live.data?.profile || {}, st = live.data?.site || {};
      const clean = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);
      const biz = clean(p.biz || live.name, 60) || "la agencia";
      const svc = Array.isArray(st.services) ? st.services.map((s) => clean(Array.isArray(s) ? s[1] : s, 40)).filter(Boolean).slice(0, 9) : [];
      system = `Eres el asistente virtual del sitio web de "${biz}", ${inEnglish ? "a real-estate agency" : "una agencia de bienes raíces"}${st.city ? ` en ${clean(st.city, 40)}` : ""}.`
        + (st.years ? ` Llevan ${clean(st.years, 4)} años en el negocio.` : "")
        + (svc.length ? ` Servicios: ${svc.join(", ")}.` : "")
        + (st.warranty ? ` Promesa al cliente: ${clean(st.warranty, 80)}.` : "")
        // Staff-curated facts (cs → "Entrenar bot"): the ONLY extra things
        // the bot may assert — office/address, hours, languages, FAQs…
        + (st.botFacts ? ` DATOS CONFIRMADOS del negocio — tu única fuente de verdad para dirección, horarios, idiomas, preguntas frecuentes y temas parecidos; lo que no esté aquí NO lo afirmes, di que lo confirman cuando le llamen: ${clean(st.botFacts, 1600)}.` : ` No tienes confirmados dirección de oficina ni horarios: si preguntan, di que el agente lo confirma cuando le llame.`)
        + ` ${tone} Contesta dudas de comprar, vender o rentar casa (valor de su casa, cómo funciona vender, comisiones en general sin dar cifras, tiempos del proceso).`
        + playbook
        + (gaveContact ? confirmLine : "");
    } else {
      system = `Eres el asistente virtual de valuación de bienes raíces de "Casa Bella Realty" (la agente se llama María). Estás en una DEMO en vivo frente a un agente interesado en contratar este servicio. ${tone} Contesta dudas sobre el valor estimado de una propiedad (cómo se calcula con ventas comparables recientes — comps — cercanas, ajustadas por tamaño, recámaras/baños, año y recencia de venta). El estimado de la página es preliminar y se basa SOLO en ventas cerradas. NUNCA prometas un precio de venta garantizado ni des asesoría legal o financiera; un análisis completo (CMA) afina el número.` + playbook.replace(/el agente/g, "María")
        + (gaveContact ? confirmLine.replace("al agente", "a María") : "")
        + " Si preguntan algo fuera de tema, redirige con amabilidad hacia el valor de la propiedad.";
    }
    const text = await aiChat({
      maxTokens: 180,
      system,
      messages: msgs.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 400) })),
    });
    res.json({ text, source: live ? "site" : "live", captured });
  } catch (e) {
    console.error("widget chat failed:", e.message);
    res.status(502).json({ error: "ai_failed", captured });
  }
});

app.post("/api/widget/quote", async (req, res) => {
  const { slug, name = "", phone = "", address = "", placeId = null } = req.body || {};
  const c = slug && (await db.getContractorBySlug(String(slug)));
  if (!c) return res.status(404).json({ error: "unknown contractor" });
  if (c.data?.status === "paused") return res.status(403).json({ error: "paused" });
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 11) return res.status(400).json({ error: "phone required" });
  if (!String(address).trim()) return res.status(400).json({ error: "address required" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  // The demo widgets (alto-demo/alto-ventas) are a SALES tool — the landing
  // page, the closer deck, and screen-shared live demos all run through them
  // from a single IP, so the old 2/day + 5-lifetime caps ran them dry mid-pitch
  // for exactly the highest-intent prospects. Demo gets generous headroom and
  // no lifetime cap; real client widgets keep tighter per-family limits (raised
  // from 2 so a NAT'd office or a family checking two homes isn't blocked).
  const isDemoWidget = c.slug === "alto-demo" || c.slug === "alto-ventas";
  const perIp = isDemoWidget ? 60 : 8;
  const perSlug = isDemoWidget ? 5000 : 150;
  if (overQuota(`wip:${ip}`, perIp) || overQuota(`wslug:${slug}`, perSlug)) return res.status(429).json({ error: "quota", demo: isDemoWidget });
  if (!isDemoWidget) {
    // lifetime per connection per real widget — a homeowner values 1-3 times ever
    const wqLife = await db.incrCounter(`wq:${slug}:${ip}`).catch(() => 0);
    if (wqLife > 15) return res.status(429).json({ error: "quota" });
  }

  // Value the property (best effort — the lead is saved regardless). The value
  // comes from RentCast sold comps; Google is only used to clean up the address.
  let m = null;
  try {
    const ck = String(address).toLowerCase().replace(/\s+/g, " ").trim();
    const hit = quoteCache.get(ck);
    if (hit && Date.now() - hit.at < 86400e3) m = hit.data;
    else if (RENTCAST_KEY) {
      const geo = GOOGLE_KEY
        ? ((placeId && (await placeDetails(placeId).catch(() => null))) || (await geocode(address).catch(() => null)))
        : null;
      const comp = await rentcastLookup((geo && geo.formatted) || address).catch(() => null);
      if (comp && comp.value) {
        m = {
          addr: comp.subject?.address || (geo && geo.formatted) || address,
          lat: geo?.lat ?? comp.subject?.latitude ?? null,
          lng: geo?.lng ?? comp.subject?.longitude ?? null,
          value: comp.value, low: comp.low, high: comp.high,
          confidence: comp.confidence, compsUsed: comp.usedCompCount,
          beds: comp.subject?.bedrooms ?? null, baths: comp.subject?.bathrooms ?? null,
          sqft: comp.subject?.squareFootage ?? null, built: comp.subject?.yearBuilt ?? null,
        };
        quoteCache.set(ck, { at: Date.now(), data: m });
        if (quoteCache.size > 500) quoteCache.delete(quoteCache.keys().next().value);
      } else if (geo) {
        m = { addr: geo.formatted, lat: geo.lat, lng: geo.lng };
      }
    }
  } catch (e) { console.error("widget value failed:", e.message); }

  // Homeowner sees an estimated market value + range, not a contractor bid.
  const quote = m?.value ? { value: m.value, low: m.low, high: m.high } : null;

  const leadId = await db.addLead(c.id, {
    name: String(name).slice(0, 80),
    phone: digits.slice(0, 15),
    address: String(m?.addr || address).slice(0, 160),
    info: quote ? { value: quote.value, low: quote.low, high: quote.high, confidence: m.confidence, compsUsed: m.compsUsed } : { unvalued: true },
  });
  forwardLead(c, {
    id: leadId, name: String(name).slice(0, 80), phone: digits.slice(0, 15),
    address: String(m?.addr || address).slice(0, 160),
    value: quote?.value ?? null, low: quote?.low ?? null, high: quote?.high ?? null,
  });
  notifyLead(c, { name, phone: digits, address: m?.addr || address }).catch(() => {}); // buzz the realtor's phone

  res.json({ ok: true, id: leadId, addr: m?.addr || address, measured: !!quote, value: quote?.value ?? null, low: quote?.low ?? null, high: quote?.high ?? null, lat: m?.lat ?? null, lng: m?.lng ?? null, comps: m?.compsUsed ?? null, beds: m?.beds ?? null, baths: m?.baths ?? null, sqft: m?.sqft ?? null, built: m?.built ?? null });
});

app.get("/w/:slug", async (req, res) => {
  const c = await db.getContractorBySlug(String(req.params.slug));
  if (!c) return res.status(404).send("Not found");
  if (c.data?.status === "paused") {
    const pProf = c.data?.profile || {};
    const pBiz = String(pProf.biz || c.name).replace(/[&<>"]/g, "");
    const pPhone = String(pProf.phone || c.phone || "").replace(/\D/g, "");
    return res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pBiz}</title><style>
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0}body{background:#F4F6FA;color:#101B30;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;border:1px solid #E6EBF3;border-radius:22px;padding:36px 28px;max-width:420px;text-align:center;box-shadow:0 20px 60px rgba(16,27,48,.1)}
h1{font-size:20px;margin:12px 0 8px}p{color:#5A6478;font-weight:600;font-size:14.5px;line-height:1.6}
a{display:inline-block;margin-top:18px;background:#101B30;color:#fff;text-decoration:none;font-weight:800;padding:14px 26px;border-radius:12px}
</style></head><body><div class="card">
<span style="font-size:40px">🏡</span>
<h1>${pBiz}</h1>
<p>La estimación de valor en línea no está disponible por el momento.<br>Online home valuations are temporarily unavailable.</p>
${pPhone ? `<a href="tel:+1${pPhone}">📞 Llámanos / Call us</a>` : ""}
</div></body></html>`);
  }
  const esc = (s) => String(s || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const prof = c.data?.profile || {};
  const biz = esc(prof.biz || c.name);
  const bizPhone = String(prof.phone || c.phone || "").replace(/\D/g, "");
  const logo = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(String(prof.logo || "")) ? prof.logo : null;
  const es = (req.query.lang || prof.lang || "es") !== "en";
  // ?showcase=1 (used on the sample website): opens straight on a populated
  // example result instead of the blank address bar, so a prospect sees the
  // full lead-capture experience at a glance. A ghost link lets them reset
  // to the real, blank flow if they want to try their own address.
  const showcase = req.query.showcase != null;
  const L = es ? {
    title: `¿Cuánto vale tu casa hoy?`,
    sub: "Un estimado real basado en ventas cercanas — en 10 segundos.",
    chips: ["🏡 Ventas reales", "🔒 100% gratis", "⚡ 10 segundos"],
    addr: "Dirección de tu casa", cont: "VER MI VALOR →",
    gate: "Estás a un paso 🎉", gateSub: "¿A dónde mandamos tu estimado?", name: "Tu nombre", phone: "Tu teléfono (celular)",
    smsNote: "🔒 Te mandamos tu estimado por mensaje a este número.",
    see: "VER MI VALOR AHORA →", back: "← Cambiar dirección",
    m1: "Encontramos tu propiedad", m2: "Buscando ventas recientes cercanas", m3: "Calculando tu valor…",
    range: "VALOR ESTIMADO DE TU CASA", yourHome: "TU CASA",
    bedsLbl: "Recámaras", bathsLbl: "Baños", sqftLbl: "Pie²", builtLbl: "Construida",
    basedOn: (n) => n ? `Basado en ${n} ventas recientes de casas similares cerca de ti.` : "Basado en ventas recientes de casas similares cerca de ti.",
    rangeSub: "Estimado automático — no es un avalúo.",
    exact: "¿Quieres el número exacto?", exactSub: (b) => `${b} puede sacar las comparables reales y darte un valor preciso — gratis.`,
    sent: (b) => `✓ ${b} te contacta hoy mismo.`,
    nores: "¡Listo! Recibimos tu información.", noresSub: (b) => `${b} te llama hoy con el valor de tu casa.`,
    callBtn: "📞 LLAMAR", textBtn: "💬 MENSAJE", phoneErr: "Pon un teléfono de 10 dígitos", addrErr: "Pon la dirección de tu casa",
    err: "Algo falló — intenta otra vez o llámanos.",
  } : {
    title: "What's your home worth today?",
    sub: "A real estimate from nearby sales — in 10 seconds.",
    chips: ["🏡 Real sales", "🔒 100% free", "⚡ 10 seconds"],
    addr: "Your home address", cont: "SEE MY VALUE →",
    gate: "You're one step away 🎉", gateSub: "Where should we send your estimate?", name: "Your name", phone: "Your phone (mobile)",
    smsNote: "🔒 We'll text your estimate to this number.",
    see: "SEE MY VALUE NOW →", back: "← Change address",
    m1: "Found your property", m2: "Pulling recent nearby sales", m3: "Calculating your value…",
    range: "YOUR HOME'S ESTIMATED VALUE", yourHome: "YOUR HOME",
    bedsLbl: "Beds", bathsLbl: "Baths", sqftLbl: "Sq Ft", builtLbl: "Built",
    basedOn: (n) => n ? `Based on ${n} recent sales of similar homes near you.` : "Based on recent sales of similar homes near you.",
    rangeSub: "Automated estimate — not an appraisal.",
    exact: "Want the exact number?", exactSub: (b) => `${b} can pull the real comparables and give you a precise value — free.`,
    sent: (b) => `✓ ${b} will contact you today.`,
    nores: "Done! We received your information.", noresSub: (b) => `${b} will call you today with your home's value.`,
    callBtn: "📞 CALL", textBtn: "💬 TEXT", phoneErr: "Enter a 10-digit phone", addrErr: "Enter your home address",
    err: "Something went wrong — try again or call us.",
  };
  // Synthetic example result for showcase mode — same numbers used elsewhere
  // in the demo materials, so the story is consistent across touchpoints.
  const fmtN = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const scLow = 299000, scHigh = 337000, scAddress = "9803 Sagemark Dr, Houston, TX 77089";
  const scMid = fmtN(Math.round((scLow + scHigh) / 2 / 1000) * 1000);
  const scManual = c.slug === "alto-demo" ? (es
    ? "👆 Este es el imán de leads. En tu app Quick Comp generas el CMA completo con comparables y lo compartes con tu cliente — para captar y cerrar con confianza."
    : "👆 This is the lead magnet. In your Quick Comp app you build the full CMA with comparables and share it with your client — to capture and close with confidence.") : null;
  const showcaseHtml = showcase ? `
    <img class="photo" src="/api/streetview?address=${encodeURIComponent(scAddress)}" alt="" onerror="this.style.display='none'">
    <p class="addrline">📍 ${scAddress}</p>
    <div class="specs">
      <div class="spec"><b>4</b><span>${L.bedsLbl}</span></div>
      <div class="spec"><b>3</b><span>${L.bathsLbl}</span></div>
      <div class="spec"><b>2,340</b><span>${L.sqftLbl}</span></div>
      <div class="spec"><b>2019</b><span>${L.builtLbl}</span></div>
    </div>
    <div class="range"><div class="lbl">${L.range}</div><div class="val">${fmtN(scLow)} – ${fmtN(scHigh)}</div><div class="mid">~${scMid}</div></div>
    <p class="based">${L.basedOn(6)}</p>
    <p class="note">${L.rangeSub}</p>
    <div class="ok">${L.sent(prof.biz || c.name)}</div>
    ${bizPhone ? `<div class="cta"><div class="h">${L.exact}</div><div class="x">${L.exactSub(prof.biz || c.name)}</div><div class="row"><a class="call" href="tel:+1${bizPhone}">${L.callBtn}</a><a class="text" href="sms:+1${bizPhone}">${L.textBtn}</a></div></div>` : ""}
    ${scManual ? `<div class="manual">${scManual}</div>` : ""}
    <button class="ghost" onclick="tryOwn()" style="margin-top:6px">${es ? "🔍 Prueba tu propia dirección" : "🔍 Try your own address"}</button>` : "";
  const wBase = `${req.protocol}://${req.get("host")}`;
  res.send(`<!doctype html><html lang="${es ? "es" : "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${biz}</title>
<meta property="og:title" content="${biz} — ${es ? "El valor de tu casa en 10 segundos" : "Your home's value in 10 seconds"}">
<meta property="og:description" content="${es ? "Pon tu dirección y mira el valor estimado de tu casa, basado en ventas reales cercanas. Gratis, sin compromiso." : "Type your address and see your home's estimated value from real nearby sales. Free, no obligation."}">
<meta property="og:image" content="${wBase}/landing/og-widget.png">
<meta name="twitter:card" content="summary_large_image">
<style>
*{box-sizing:border-box;font-family:Inter,-apple-system,BlinkMacSystemFont,Arial,sans-serif;-webkit-tap-highlight-color:transparent}
body{margin:0;background:linear-gradient(180deg,#EEF1F7 0%,#F4F6FA 30%);color:#101B30;min-height:100vh}
.wrap{max-width:440px;margin:0 auto;padding:22px 16px 30px}
.brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:16px;min-height:46px}
.brand img{max-height:52px;max-width:190px;object-fit:contain}
.brand .nm{font-weight:800;font-size:19px;letter-spacing:-.01em}
.card{background:#fff;border:1px solid #EAECF1;border-radius:22px;padding:24px 22px;box-shadow:0 18px 50px rgba(16,27,48,.10),0 2px 8px rgba(16,27,48,.04)}
.chips{display:flex;gap:7px;justify-content:center;flex-wrap:wrap;margin:0 0 18px}
.chip{background:#F5F1E6;color:#8A6A00;border:1px solid #EADFBE;border-radius:99px;padding:5px 11px;font-size:11.5px;font-weight:800}
h1{font-size:26px;margin:0 0 6px;line-height:1.12;letter-spacing:-.02em;text-align:center}
.sub{color:#67718A;font-size:14px;font-weight:600;margin:0 0 20px;text-align:center;line-height:1.45}
.field{position:relative;margin-bottom:12px}
label.fl{display:block;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#9098A8;margin:0 0 6px}
input{width:100%;padding:15px 14px;border:1.5px solid #E2E5EB;border-radius:13px;font-size:16px;font-weight:600;outline:none;background:#FBFBFD;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:#C9973A;box-shadow:0 0 0 4px rgba(201,151,58,.14);background:#fff}
.btn{width:100%;padding:16px;border:none;border-radius:13px;background:linear-gradient(180deg,#D4A64A,#C9973A);color:#fff;font-size:16px;font-weight:800;letter-spacing:.01em;cursor:pointer;box-shadow:0 8px 20px rgba(201,151,58,.32);transition:transform .1s,filter .15s}
.btn:hover{filter:brightness(1.04)}.btn:active{transform:scale(.985)}
.btn[disabled]{opacity:.55;box-shadow:none}
.sug{border:1.5px solid #E2E5EB;border-top:none;border-radius:0 0 13px 13px;margin:-12px 0 12px;background:#fff;overflow:hidden;box-shadow:0 10px 24px rgba(16,27,48,.08)}
.sug button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:12px 13px;border:none;background:#fff;font-size:14px;font-weight:600;cursor:pointer;border-top:1px solid #F2F4F7}
.sug button:active{background:#F7EFD8}
.ghost{display:block;width:100%;background:none;border:none;color:#9098A8;font-weight:700;font-size:13px;cursor:pointer;padding:12px 0 2px}
.addrpill{display:flex;align-items:center;gap:8px;background:#F5F7FB;border:1px solid #E8EBF1;border-radius:12px;padding:11px 13px;margin-bottom:16px;font-size:13.5px;font-weight:700;color:#3A455C}
.smsnote{display:flex;align-items:center;gap:7px;color:#67718A;font-size:12px;font-weight:600;margin:2px 0 14px;line-height:1.4}
.load{text-align:center;padding:14px 0 6px}
.pbar{height:7px;background:#EEF0F5;border-radius:99px;overflow:hidden;margin:20px 0 22px}
.pfill{height:100%;width:8%;background:linear-gradient(90deg,#D4A64A,#C9973A);border-radius:99px;transition:width .5s cubic-bezier(.4,0,.2,1)}
.lstep{display:flex;align-items:center;gap:11px;padding:9px 0;font-size:14.5px;font-weight:700;color:#C2C8D2;transition:color .3s}
.lstep .dot{width:22px;height:22px;border-radius:50%;background:#EEF0F5;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;transition:background .3s}
.lstep.on{color:#101B30}.lstep.on .dot{background:#C9973A;color:#fff}
.lstep.doing{color:#101B30}.lstep.doing .dot{background:#F7EFD8;color:#C9973A;animation:pls 1s ease-in-out infinite}
@keyframes pls{50%{transform:scale(1.12)}}
.reveal{animation:rv .6s cubic-bezier(.2,.7,.2,1)}
@keyframes rv{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.reveal-big{animation:rvb .75s cubic-bezier(.16,.8,.3,1.12)}
@keyframes rvb{from{opacity:0;transform:translateY(30px) scale(.95)}to{opacity:1;transform:none}}
.range.glow{animation:rgw 1.5s ease .4s 2}
@keyframes rgw{0%,100%{box-shadow:0 16px 40px rgba(12,22,49,.28)}50%{box-shadow:0 16px 40px rgba(12,22,49,.28),0 0 0 8px rgba(230,191,106,.30)}}
.photo{width:100%;height:190px;object-fit:cover;border-radius:14px;display:block;margin-bottom:12px;background:#EEF0F5}
.addrline{font-weight:800;font-size:14.5px;color:#101B30;text-align:center;margin:0 0 12px}
.specs{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:14px}
.spec{background:#F5F7FB;border:1px solid #E8EBF1;border-radius:12px;padding:9px 4px;text-align:center}
.spec b{display:block;font-size:15px;font-weight:900;color:#101B30;line-height:1.2}
.spec span{display:block;font-size:9px;font-weight:800;color:#8A94A8;text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.range{background:radial-gradient(120% 130% at 80% 0%,#233A6B 0%,#15224C 55%,#0C1631 100%);border-radius:18px;padding:22px 18px;text-align:center;margin-bottom:14px;box-shadow:0 16px 40px rgba(12,22,49,.28)}
.range .lbl{color:#E6BF6A;font-size:10.5px;font-weight:900;letter-spacing:.16em;text-transform:uppercase}
.range .val{color:#fff;font-size:34px;font-weight:900;margin-top:7px;letter-spacing:-.02em;line-height:1}
.range .mid{color:rgba(255,255,255,.62);font-size:12px;font-weight:700;margin-top:8px}
.based{color:#67718A;font-size:12.5px;font-weight:600;line-height:1.5;text-align:center;margin:0 0 4px}
.note{color:#9098A8;font-size:11px;font-weight:600;line-height:1.5;text-align:center}
.cta{background:#FBF7EE;border:1.5px solid #EADFBE;border-radius:16px;padding:16px;margin:16px 0 4px;text-align:center}
.cta .h{font-weight:900;font-size:16px;color:#101B30;margin-bottom:3px}
.cta .x{color:#67718A;font-size:12.5px;font-weight:600;line-height:1.45;margin-bottom:13px}
.cta .row{display:flex;gap:9px}
.cta a{flex:1;display:block;text-decoration:none;padding:14px 8px;border-radius:12px;font-weight:800;font-size:15px}
.cta a.call{background:#101B30;color:#fff}
.cta a.text{background:#25D366;color:#fff}
.ok{background:#EAF8EF;border:1px solid #A7E0BC;color:#1E7B3C;border-radius:12px;padding:12px;font-weight:800;font-size:14px;margin:12px 0 0;text-align:center}
.manual{background:#F7EFD8;border:1.5px solid #C9973A;color:#7A5A00;border-radius:12px;padding:12px;font-weight:700;font-size:13px;line-height:1.5;margin:14px 0 0}
.ft{text-align:center;color:#A6AEBD;font-size:11px;font-weight:700;margin-top:18px;letter-spacing:.02em}
.err{color:#D93025;font-size:13px;font-weight:700;margin:-6px 0 10px}
.legal{font-size:11px;color:#9098A8;line-height:1.5;margin-top:14px;text-align:center}
.legal a{color:#9098A8;text-decoration:underline}
</style></head><body><div class="wrap">
<div class="brand">${logo ? `<img src="${logo}" alt="${biz}">` : `<span class="nm">${biz}</span>`}</div>
<div class="card" id="card">
  <div id="s1">
    <div class="chips">${L.chips.map((x) => `<span class="chip">${x}</span>`).join("")}</div>
    <h1>${L.title}</h1><p class="sub">${L.sub}</p>
    <div class="field">
      <input id="addr" placeholder="${L.addr}" autocomplete="street-address">
      <div class="sug" id="sug" style="display:none"></div>
    </div>
    <p class="err" id="e1" style="display:none">${L.addrErr}</p>
    <button class="btn" onclick="toStep2()">${L.cont}</button>
  </div>
  <div id="s2" style="display:none">
    <h1 style="font-size:22px">${L.gate}</h1><p class="sub" style="margin-bottom:14px">${L.gateSub}</p>
    <div class="addrpill" id="addrEcho"></div>
    <label class="fl">${L.name}</label>
    <input id="nm" placeholder="${L.name}" autocomplete="name">
    <label class="fl" style="margin-top:4px">${L.phone}</label>
    <input id="ph" placeholder="${L.phone}" type="tel" autocomplete="tel" inputmode="numeric">
    <p class="err" id="e2" style="display:none">${L.phoneErr}</p>
    <p class="smsnote">${L.smsNote}</p>
    <button class="btn" id="go" onclick="submit()">${L.see}</button>
    <button class="ghost" onclick="back1()">${L.back}</button>
    <p class="legal">${!es
      ? `By continuing you agree that ${esc(prof.biz || c.name)} may call or text you about your home's value. Msg &amp; data rates may apply. This is an estimate, not an appraisal. <a href="/legal" target="_blank">Privacy &amp; Terms</a>.`
      : `Al continuar aceptas que ${esc(prof.biz || c.name)} te llame o mande mensajes sobre el valor de tu casa. Pueden aplicar tarifas de mensajes. Esto es un estimado, no un avalúo. <a href="/legal?lang=es" target="_blank">Privacidad y Términos</a>.`}</p>
  </div>
  <div id="s3" style="display:none" class="load">
    <div class="pbar"><div class="pfill" id="pfill"></div></div>
    <div class="lstep" id="ls0"><span class="dot">1</span><span>${L.m1}</span></div>
    <div class="lstep" id="ls1"><span class="dot">2</span><span>${L.m2}</span></div>
    <div class="lstep" id="ls2"><span class="dot">3</span><span>${L.m3}</span></div>
  </div>
  <div id="s4" style="display:none">${showcaseHtml}</div>
</div>
<div class="ft">⚡ Powered by Quick Comp</div>
</div>
<script>
var SLUG=${JSON.stringify(c.slug)},BIZ=${JSON.stringify(prof.biz || c.name)},BPH=${JSON.stringify(bizPhone)};
var L=${JSON.stringify({ range: L.range, yourHome: L.yourHome, rangeSub: L.rangeSub, based0: L.basedOn(null),
  bedsLbl: L.bedsLbl, bathsLbl: L.bathsLbl, sqftLbl: L.sqftLbl, builtLbl: L.builtLbl,
  sent: L.sent(prof.biz || c.name), nores: L.nores, noresSub: L.noresSub(prof.biz || c.name),
  exact: L.exact, exactSub: L.exactSub(prof.biz || c.name), callBtn: L.callBtn, textBtn: L.textBtn, err: L.err,
  basedPre: es ? "Basado en " : "Based on ", basedPost: es ? " ventas recientes de casas similares cerca de ti." : " recent sales of similar homes near you.",
  manual: c.slug === "alto-demo" ? (es
    ? "👆 Este es el imán de leads. En tu app Quick Comp generas el CMA completo con comparables y lo compartes con tu cliente — para captar y cerrar con confianza."
    : "👆 This is the lead magnet. In your Quick Comp app you build the full CMA with comparables and share it with your client — to capture and close with confidence.") : null })};
function track(ev){try{fetch('/api/track',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:ev})})}catch(e){}}
track('w_view');
var placeId=null,tmr=null;
var addr=document.getElementById('addr'),sug=document.getElementById('sug');
addr.addEventListener('input',function(){placeId=null;clearTimeout(tmr);var q=addr.value.trim();
  if(q.length<4){sug.style.display='none';return}
  tmr=setTimeout(function(){fetch('/api/places?q='+encodeURIComponent(q)).then(r=>r.json()).then(function(j){
    var s=(j.suggestions||[]).slice(0,4);if(!s.length){sug.style.display='none';return}
    sug.innerHTML=s.map(function(x,i){return '<button data-i="'+i+'">📍 '+x.text.replace(/</g,'&lt;')+'</button>'}).join('');
    sug.style.display='block';
    Array.prototype.forEach.call(sug.children,function(b){b.onclick=function(){var x=s[+b.dataset.i];addr.value=x.text;placeId=x.placeId;sug.style.display='none'}});
  }).catch(function(){})},250)});
addr.addEventListener('keydown',function(e){if(e.key==='Enter')toStep2()});
function show(id){['s1','s2','s3','s4'].forEach(function(s){document.getElementById(s).style.display=s===id?'block':'none'})}
function toStep2(){if(addr.value.trim().length<6){document.getElementById('e1').style.display='block';return}
  document.getElementById('e1').style.display='none';sug.style.display='none';
  document.getElementById('addrEcho').innerHTML='📍 '+addr.value.trim().replace(/</g,'&lt;');show('s2');document.getElementById('nm').focus()}
function back1(){show('s1')}
function tryOwn(){addr.value='';sug.style.display='none';show('s1');addr.focus()}
function fmt(n){return '$'+Number(n).toLocaleString('en-US',{maximumFractionDigits:0})}
function submit(){
  var ph=document.getElementById('ph').value.replace(/\\D/g,'');
  if(ph.length<10){document.getElementById('e2').style.display='block';return}
  document.getElementById('e2').style.display='none';show('s3');
  // Animated analyzing steps — builds anticipation and perceived value
  var fill=document.getElementById('pfill'),steps=['ls0','ls1','ls2'],si=0;
  function markDoing(i){steps.forEach(function(id,k){var el=document.getElementById(id);el.className='lstep'+(k<i?' on':k===i?' doing':'');if(k<i)el.querySelector('.dot').textContent='✓'});}
  markDoing(0);fill.style.width='34%';
  var pt=setTimeout(function(){markDoing(1);fill.style.width='68%'},1000);
  var pt2=setTimeout(function(){markDoing(2);fill.style.width='92%'},2000);
  var wait=new Promise(function(r){setTimeout(r,2900)});
  var req=fetch('/api/widget/quote',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({slug:SLUG,name:document.getElementById('nm').value.trim(),phone:ph,address:addr.value.trim(),placeId:placeId})
  }).then(function(r){return r.ok?r.json():null}).catch(function(){return null});
  Promise.all([req,wait]).then(function(a){clearTimeout(pt);clearTimeout(pt2);fill.style.width='100%';markDoing(3);render(a[0])})}
function render(j){track('w_result');if(window.parent!==window){try{window.parent.postMessage({qc:'lead'},'*')}catch(e){}}
  var s4=document.getElementById('s4'),h='';
  if(!j){s4.innerHTML='<p class="err">'+L.err+'</p>';show('s4');return}
  if(j.measured){
    if(j.lat!=null&&j.lng!=null)h+='<img class="photo" src="/api/streetview?lat='+j.lat+'&lng='+j.lng+'" alt="" onerror="this.style.display=\\'none\\'">';
    if(j.addr)h+='<p class="addrline">📍 '+String(j.addr).replace(/</g,'&lt;')+'</p>';
    if(j.beds||j.baths||j.sqft||j.built){
      h+='<div class="specs">';
      h+='<div class="spec"><b>'+(j.beds||'—')+'</b><span>'+L.bedsLbl+'</span></div>';
      h+='<div class="spec"><b>'+(j.baths||'—')+'</b><span>'+L.bathsLbl+'</span></div>';
      h+='<div class="spec"><b>'+(j.sqft?Number(j.sqft).toLocaleString('en-US'):'—')+'</b><span>'+L.sqftLbl+'</span></div>';
      h+='<div class="spec"><b>'+(j.built||'—')+'</b><span>'+L.builtLbl+'</span></div>';
      h+='</div>';
    }
    var mid=fmt(Math.round((j.low+j.high)/2/1000)*1000);
    h+='<div class="range"><div class="lbl">'+L.range+'</div><div class="val">'+fmt(j.low)+' – '+fmt(j.high)+'</div><div class="mid">~'+mid+'</div></div>';
    h+='<p class="based">'+(L.basedPre+(j.comps?j.comps:'')+L.basedPost).replace('  ',' ')+'</p>';
    h+='<p class="note">'+L.rangeSub+'</p>';
    h+='<div class="ok">'+L.sent+'</div>';
  }else{
    h+='<div class="ok">'+L.nores+'</div><p class="based" style="margin-top:8px">'+L.noresSub+'</p>';
  }
  // Strong CTA to talk to the agent — the whole point is the lead, then the call
  if(BPH){h+='<div class="cta"><div class="h">'+L.exact+'</div><div class="x">'+L.exactSub+'</div><div class="row">'
    +'<a class="call" href="tel:+1'+BPH+'">'+L.callBtn+'</a>'
    +'<a class="text" href="sms:+1'+BPH+'">'+L.textBtn+'</a></div></div>';}
  if(L.manual)h+='<div class="manual">'+L.manual+'</div>';
  s4.innerHTML=h;s4.className='reveal';show('s4')}
${showcase ? `
/* SHOWCASE: auto-play the whole flow (address types itself → lead gate fills →
 * analyzing steps → result reveals with a count-up) the moment the widget
 * scrolls into view, so the demo sells the experience by itself. Tapping
 * anywhere skips straight to the finished result; reduced-motion visitors
 * get the finished result immediately. */
(function(){
  var SC_ADDR=${JSON.stringify(scAddress)},SC_LOW=${scLow},SC_HIGH=${scHigh};
  var timers=[],playing=false,done=false;
  var noMotion=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function later(fn,ms){timers.push(setTimeout(fn,ms))}
  function typeInto(el,txt,speed,then){
    var i=0,iv=setInterval(function(){
      i++;el.value=txt.slice(0,i)+(i<txt.length?'|':'');
      if(i>=txt.length){clearInterval(iv);later(then,340)}
    },speed);timers.push(iv);
  }
  function countUp(){
    var el=document.querySelector('#s4 .range .val'),mid=document.querySelector('#s4 .range .mid');
    if(!el)return;
    if(mid)mid.style.opacity='0';
    var t0=null;
    function fr(ts){
      if(!t0)t0=ts;var p=Math.min(1,(ts-t0)/900);p=1-Math.pow(1-p,3);
      el.textContent=fmt(Math.round(SC_LOW*p/1000)*1000)+' – '+fmt(Math.round(SC_HIGH*p/1000)*1000);
      if(p<1)requestAnimationFrame(fr);
      else if(mid){mid.style.transition='opacity .4s';mid.style.opacity='1'}
    }
    requestAnimationFrame(fr);
  }
  function finish(instant){
    if(done)return;done=true;
    timers.forEach(function(t){clearTimeout(t);clearInterval(t)});
    ['addr','nm','ph'].forEach(function(id){var el=document.getElementById(id);if(el)el.value=''});
    ['e1','e2'].forEach(function(id){var el=document.getElementById(id);if(el)el.style.display='none'});
    show('s4');
    if(!instant){
      var s4=document.getElementById('s4');s4.className='reveal-big';
      var r=s4.querySelector('.range');if(r)r.classList.add('glow');
      countUp();
    }
  }
  function playLoading(){
    show('s3');
    var fill=document.getElementById('pfill');
    function mark(i){['ls0','ls1','ls2'].forEach(function(id,k){var el=document.getElementById(id);el.className='lstep'+(k<i?' on':k===i?' doing':'');if(k<i)el.querySelector('.dot').textContent='✓'})}
    mark(0);fill.style.width='34%';
    later(function(){mark(1);fill.style.width='68%'},1100);
    later(function(){mark(2);fill.style.width='92%'},2200);
    later(function(){mark(3);fill.style.width='100%';finish()},3100);
  }
  function playGate(){
    document.getElementById('addrEcho').innerHTML='📍 '+SC_ADDR;
    show('s2');
    typeInto(document.getElementById('nm'),${JSON.stringify(es ? "María González" : "Sarah Mitchell")},36,function(){
      typeInto(document.getElementById('ph'),'(956) 555-0143',36,function(){later(playLoading,550)});
    });
  }
  function play(){
    if(playing||done)return;playing=true;
    typeInto(addr,SC_ADDR,40,function(){later(playGate,420)});
  }
  document.getElementById('card').addEventListener('pointerdown',function(){if(playing&&!done)finish()});
  if(noMotion){finish(true);return}
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){io.disconnect();later(play,350)}})},{threshold:.35});
    io.observe(document.getElementById('card'));
  }else later(play,600);
})();
` : ""}
</script></body></html>`);
});

/* ── Sales landing page (served at the bare ROOT_DOMAIN, and at /ventas) ──
 * One bold page that sells the bundle by SHOWING it: the live widget is
 * embedded so a visitor can measure a real roof right on the page.
 * Interested realtors leave name + phone → lead in the "alto-ventas" account. */
function landingPage(req) {
  const base = canonBase(req);
  // Live app URL for the "try it yourself" embed: on the root domain the app
  // lives on APP_HOST (base serves the landing); on onrender/local, base serves
  // the app at /. ?demo=qc opens straight on the comps search, demo mode.
  const appLiveUrl = (ROOT_DOMAIN && APP_HOST) ? `https://${APP_HOST}/?demo=qc` : `${base}/?demo=qc`;
  // ?lang always wins; otherwise follow the visitor's browser language so
  // English-speaking realtors land in English without hunting for a toggle.
  const en = req.query.lang === "en"
    || (req.query.lang !== "es" && /^en/i.test(String(req.headers["accept-language"] || "")));
  const stripeLink = process.env.STRIPE_PAYMENT_LINK || "";
  // Optional per-tier Payment Links (Pro = app only, Widget = embed on their
  // existing site). An unset tier falls back to "book a call" — nothing breaks.
  const stripeLinkPro = process.env.STRIPE_PAYMENT_LINK_PRO || "";
  const stripeLinkWidget = process.env.STRIPE_PAYMENT_LINK_WIDGET || "";
  // Meta Pixel for ad tracking — only renders once META_PIXEL_ID is set
  const pixelId = (process.env.META_PIXEL_ID || "").replace(/[^0-9]/g, "");
  const pixelHead = pixelId ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixelId}');fbq('track','PageView');</script><noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1"/></noscript>` : "";
  // keep the language toggle on the same path (/ on the root domain, /ventas elsewhere)
  const langHref = `${req.path.startsWith("/ventas") ? "/ventas" : "/"}?lang=${en ? "es" : "en"}`;
  const L = en ? {
    lang: "en", langBtn: "🇲🇽 Español", langHref: "/?lang=es",
    title: "Quick Comp — Your website finds you sellers by itself",
    desc: "Website + instant home-value tool + app. Homeowners leave their phone to see their home's value and you get them as seller leads. Built for realtors.",
    ogTitle: "Quick Comp — The Perfect Realtor Tool: Comps in 10 Seconds",
    ogDesc: "Instant comps, CMAs, lending & tax — plus a website that finds you sellers 24/7. Try it live.",
    h1: "WIN MORE LISTINGS.<br>VALUE ANY HOME IN <em>10 SECONDS</em>",
    sub: "The all-in-one tool for realtors — instant comps, CMAs, lending & tax, right from your phone. Walk into any listing appointment knowing the number. <b>Plus a website that captures sellers while you sleep.</b>",
    cta1: "SEE THE LIVE DEMO ↓", cta2: "See pricing",
    chips: ["🇺🇸 Bilingual", "🏡 Built for realtors", "📲 No App Store"],
    tryT: "TRY IT <em>RIGHT NOW</em>",
    trySub: `This is what homeowners will see on YOUR website — with your logo and <b style="color:#101B30">your brand</b>. They type a real address and watch it value the home from recent comparable sales. The value shows as a <b style="color:#101B30">range</b>, and to see it they leave their name and phone — that's your seller lead.`,
    fullQ: "What about the full website?", fullSub: "See a sample realtor website, actually working — imagine your logo, your colors and your name.",
    fullBtn: "TAP TO SEE YOUR WEBSITE →",
    howT: "HOW DOES IT <em>WORK</em>?",
    s1t: "The homeowner lands on your site", s1x: "From an ad, from Google, or because someone shared your link. Your website works even while you're showing a property.",
    s2t: "They leave their phone to see the value", s2x: `<b style="color:#B07A00">No name and phone, no value.</b> The engine pulls recent comparable sales and calculates a value range for their home — instantly, branded as you.`,
    s3t: "The seller lead hits your phone", s3x: "Name, address, phone and the value they saw — instantly, in your app. One button and you're already writing them on WhatsApp with the message pre-written.",
    leadsT: "SELLERS LAND<br><em>ON YOUR PHONE</em>",
    leads: ["<b>📥</b> Every seller lead buzzes in your pocket instantly", "<b>💰</b> Real comp-based values — credible, not a guess", "<b>💬</b> WhatsApp message pre-written — one tap and you reply", "<b>🛰️</b> Instant home values in 10 seconds", "<b>🧾</b> Professional CMA reports with your logo"],
    pNew: "1 NEW", pNew2: "NEW",
    duoH: "What's my home worth?", duoBrand: "CASA BELLA REALTY", duoName: "Your name", duoPhone: "Your phone", duoBtn: "SEE MY HOME'S VALUE", duoNotif: "<b>New seller lead</b> · just now", duoEmpty: "Your seller leads land here…",
    duoKick: "FREE HOME VALUATION", duoSub: "See what your home is worth from real recent sales — in seconds.", duoNav: ["Home", "Listings", "Sell", "Contact"],
    duoValLab: "Your home's estimated value", duoValSub: "From recent comparable sales nearby", pNewTwo: "2 NEW",
    appT: "AND ON YOUR PHONE, <em>THE APP</em>",
    appSub: `You're at an open house and a neighbor asks "what's mine worth?" — you type their address (or use your GPS), pull the comps, and send a polished CMA right there.`,
    appTryT: "TRY THE APP <em>YOURSELF</em>",
    appTrySub: "This is the real tool — type any address and watch it price the home from real comps in seconds. It's yours from $67/mo.",
    phT: "Try it on your phone 📲", phSub: "It's built for your phone. Drop your number and get your trial link — no App Store needed.",
    phName: "Your name", phPhone: "Your phone (mobile)", phBtn: "GET MY TRIAL LINK →", phErr: "Enter a 10-digit phone",
    phOk: "✓ Here's your trial — tap to open Quick Comp on your phone:", phTry: "Open Quick Comp →",
    priceT: "PICK YOUR <em>PLAN</em>", priceSub: "No fine print. No long contracts. Cancel anytime.",
    mo: "/mo", buyNow: "Start now →", orBook: "Not sure which one? Book a call — we'll tell you honestly.",
    popTag: "MOST POPULAR", noSetup: "no setup fee",
    tiers: [
      { name: "PRO · THE TOOL", amt: 67, setup: null, link: stripeLinkPro,
        desc: "Just want the tool? The full Quick Comp app, self-serve.",
        inc: ["Instant values from real comparable sales", "CMA reports with your brand", "Lending, tax & seller net sheet", "AI listing writer + appraisal packet", "English y Español"] },
      { name: "WIDGET · YOUR SITE", amt: 197, setup: null, pop: true, link: stripeLinkWidget,
        desc: "Already have a website? We send you the code — you (or your web person) paste it in.",
        inc: ["Everything in Pro", "The home-value tool on YOUR website", "Seller leads straight to your WhatsApp", "Works on WordPress, Wix, GoDaddy — any site"] },
      { name: "COMPLETE · DONE FOR YOU", amt: 297, setup: null, link: stripeLink,
        desc: "No website — or want a better one? We build it for you from our templates.",
        inc: ["Everything in Widget", "Your professional website with your brand", "Live in days — you pick the template", "Your domain (yourname.com) is yours — by contract", "Bilingual support"] },
    ],
    talkT: "READY? <em>LET'S TALK</em>", talkSub: "Answer 4 quick questions and schedule a call with the team. No obligation — we answer everything and you decide.",
    q1: "What do you focus on?", q1o: ["Residential", "Luxury", "Both", "Other"],
    q2: "How long have you been licensed?", q2o: ["Just starting", "1–3 years", "3–10 years", "10+ years"],
    q3: "About how many deals per year?", q3o: ["Under 6", "6–15", "15–30", "Over 30"],
    q4: "How much do you spend on marketing monthly?", q4o: ["Nothing yet", "Under $500", "$500–$2,000", "Over $2,000"],
    q5: "Last step — where do we call you?", back: "← Back",
    fName: "Your name", fBiz: "Your brokerage", fPhone: "Your phone (mobile)", fBtn: "SCHEDULE MY CALL →", fOk: "✓ Done! The team will contact you today to set a time.",
    foot: `Quick Comp · Made in Texas 🤠`,
  } : {
    lang: "es", langBtn: "🇺🇸 English", langHref: "/?lang=en",
    title: "Quick Comp — Tu página web te consigue vendedores sola",
    desc: "Página web + valuador de casas instantáneo + app. Los dueños dejan su teléfono para ver el valor de su casa y tú los recibes como leads de venta. Para agentes de bienes raíces.",
    ogTitle: "Quick Comp — La Herramienta Perfecta: Comparables en 10 Segundos",
    ogDesc: "Comparables, CMAs, crédito e impuestos al instante — más una página que te consigue vendedores 24/7. Pruébalo en vivo.",
    h1: "GANA MÁS LISTINGS.<br>VALÚA CUALQUIER CASA EN <em>10 SEGUNDOS</em>",
    sub: "La herramienta todo-en-uno para agentes — comparables, CMAs, crédito e impuestos al instante, desde tu teléfono. Llega a cualquier cita de listing sabiendo el número. <b>Y una página que captura vendedores mientras duermes.</b>",
    cta1: "VER DEMO EN VIVO ↓", cta2: "Ver precio",
    chips: ["🇺🇸 En español", "🏡 Hecho para agentes", "📲 Sin App Store"],
    tryT: "PRUÉBALO <em>AHORA MISMO</em>",
    trySub: `Esto es lo que verán los dueños en TU página web — con tu logo y <b style="color:#101B30">tu marca</b>. Escriben una dirección de verdad y miran cómo valúa la casa con ventas comparables recientes. El valor sale en <b style="color:#101B30">rango</b>, y para verlo dejan su nombre y teléfono — ese es tu lead de venta.`,
    fullQ: "¿Y la página completa?", fullSub: "Mira una página de ejemplo de un agente, funcionando de verdad — imagina tu logo, tus colores y tu nombre.",
    fullBtn: "PRESIONA PARA VER TU PÁGINA →",
    howT: "¿CÓMO <em>FUNCIONA</em>?",
    s1t: "El dueño entra a tu página", s1x: "De un anuncio, de Google, o porque alguien le pasó tu link. Tu página trabaja aunque tú estés enseñando una propiedad.",
    s2t: "Deja su teléfono para ver el valor", s2x: `<b style="color:#B07A00">Sin nombre y teléfono, no hay valor.</b> El motor saca ventas comparables recientes y calcula un rango de valor para su casa — al instante, con tu marca.`,
    s3t: "El lead de venta te llega a tu teléfono", s3x: "Nombre, dirección, teléfono y el valor que vio — al instante, en tu app. Un botón y ya le estás escribiendo por WhatsApp con el mensaje listo.",
    leadsT: "LOS VENDEDORES LLEGAN<br><em>A TU TELÉFONO</em>",
    leads: ["<b>📥</b> Cada lead de venta suena en tu bolsillo al instante", "<b>💰</b> Valores con ventas reales — creíbles, no un estimado al azar", "<b>💬</b> Mensaje de WhatsApp ya escrito — un tap y contestas", "<b>🛰️</b> Valores de casas al instante en 10 segundos", "<b>🧾</b> Reportes CMA profesionales con tu logo"],
    pNew: "1 NUEVO", pNew2: "NUEVO",
    duoH: "¿Cuánto vale mi casa?", duoBrand: "CASA BELLA REALTY", duoName: "Tu nombre", duoPhone: "Tu teléfono", duoBtn: "VER EL VALOR DE MI CASA", duoNotif: "<b>¡Nuevo lead de venta!</b> · ahora mismo", duoEmpty: "Tus leads de venta llegan aquí…",
    duoKick: "VALUACIÓN GRATIS DE TU CASA", duoSub: "Mira cuánto vale tu casa con ventas recientes reales — en segundos.", duoNav: ["Inicio", "Propiedades", "Vender", "Contacto"],
    duoValLab: "El valor estimado de tu casa", duoValSub: "Con ventas comparables recientes de tu zona", pNewTwo: "2 NUEVOS",
    appT: "Y EN TU TELÉFONO, <em>LA APP</em>",
    appSub: `Estás en un open house y el vecino te pregunta "¿cuánto vale la mía?" — pones su dirección (o usas tu GPS), sacas las comparables, y le mandas un CMA profesional ahí mismo.`,
    appTryT: "PRUEBA LA APP <em>TÚ MISMO</em>",
    appTrySub: "Esta es la herramienta real — escribe cualquier dirección y mira cómo valúa la casa con comparables reales en segundos. Es tuya desde $67/mes.",
    phT: "Pruébala en tu teléfono 📲", phSub: "Está hecha para tu teléfono. Deja tu número y recibe tu link de prueba — sin App Store.",
    phName: "Tu nombre", phPhone: "Tu teléfono (celular)", phBtn: "QUIERO MI LINK →", phErr: "Pon un teléfono de 10 dígitos",
    phOk: "✓ Aquí está tu prueba — toca para abrir Quick Comp en tu teléfono:", phTry: "Abrir Quick Comp →",
    priceT: "ELIGE TU <em>PLAN</em>", priceSub: "Sin letras chiquitas. Sin contratos largos. Cancelas cuando quieras.",
    mo: "/mes", buyNow: "Comenzar ahora →", orBook: "¿No sabes cuál? Agenda una llamada — te decimos con honestidad.",
    popTag: "MÁS POPULAR", noSetup: "sin costo de inicio",
    tiers: [
      { name: "PRO · LA HERRAMIENTA", amt: 67, setup: null, link: stripeLinkPro,
        desc: "¿Solo quieres la herramienta? La app completa de Quick Comp, tú solo.",
        inc: ["Valores al instante con ventas comparables reales", "Reportes CMA con tu marca", "Crédito, impuestos y hoja neta del vendedor", "Redactor de listing con IA + paquete para avalúo", "English y Español"] },
      { name: "WIDGET · TU PÁGINA", amt: 197, setup: null, pop: true, link: stripeLinkWidget,
        desc: "¿Ya tienes página? Te mandamos el código — lo pegas tú (o tu web developer).",
        inc: ["Todo lo de Pro", "El valuador de casas en TU página", "Leads de venta directo a tu WhatsApp", "Funciona en WordPress, Wix, GoDaddy — cualquier sitio"] },
      { name: "COMPLETE · TODO HECHO", amt: 297, setup: null, link: stripeLink,
        desc: "¿No tienes página — o quieres una mejor? Te la hacemos con nuestras plantillas.",
        inc: ["Todo lo de Widget", "Tu página web profesional con tu marca", "Lista en días — tú eliges la plantilla", "Tu dominio (tunombre.com) es tuyo — por contrato", "Soporte en español"] },
    ],
    talkT: "¿LISTO? <em>HABLEMOS</em>", talkSub: "Contesta 4 preguntas rápidas y agenda una llamada con el equipo. Sin compromiso — resolvemos todas tus dudas y tú decides.",
    q1: "¿En qué te enfocas?", q1o: ["Residencial", "Lujo", "Ambos", "Otro"],
    q2: "¿Cuánto llevas con licencia?", q2o: ["Empezando", "1–3 años", "3–10 años", "10+ años"],
    q3: "¿Cuántos cierres al año (aprox.)?", q3o: ["Menos de 6", "6–15", "15–30", "Más de 30"],
    q4: "¿Cuánto inviertes en marketing al mes?", q4o: ["Nada todavía", "Menos de $500", "$500–$2,000", "Más de $2,000"],
    q5: "Último paso — ¿a dónde te llamamos?", back: "← Atrás",
    fName: "Tu nombre", fBiz: "Tu inmobiliaria / brokerage", fPhone: "Tu teléfono (celular)", fBtn: "AGENDAR MI LLAMADA →", fOk: "✓ ¡Listo! El equipo te contacta hoy mismo para apartar tu hora.",
    foot: `Quick Comp · Hecho en Texas 🤠`,
  };
  return `<!doctype html><html lang="${L.lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${L.title}</title>
<meta name="description" content="${L.desc}">
<meta property="og:title" content="${L.ogTitle}">
<meta property="og:description" content="${L.ogDesc}">
<meta property="og:image" content="${base}/landing/og.png">
<meta property="og:type" content="website">
<meta property="og:url" content="${base}/">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/icon-192.png">
${pixelHead}
<style>
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Inter:wght@400;600;700;800&display=swap');
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0;-webkit-tap-highlight-color:transparent}
body{background:#fff;color:#101B30}
.bc{font-family:'Barlow Condensed',sans-serif}
.wrap{max-width:1020px;margin:0 auto;padding:0 22px}
nav{display:flex;align-items:center;justify-content:center;padding:30px 0 4px}
nav .lg img{height:66px;display:block}
.langpill{position:fixed;top:14px;right:16px;z-index:50;background:#101B30;color:#fff;border-radius:99px;padding:9px 17px;font-weight:800;font-size:13px;text-decoration:none;box-shadow:0 10px 26px rgba(16,27,48,.3)}
.hero{padding:48px 0 56px;text-align:center}
.hero h1{font-family:'Barlow Condensed',sans-serif;font-size:clamp(44px,8vw,80px);line-height:1.0;font-weight:800;letter-spacing:.5px}
.hero h1 em{color:#C9973A;font-style:normal}
.hero p{color:#5A6478;font-size:clamp(15px,2.5vw,19px);font-weight:600;margin:18px auto 0;max-width:620px;line-height:1.55}
.cta{display:inline-block;margin-top:30px;background:#C9973A;color:#101B30;font-weight:800;font-size:17px;padding:17px 36px;border-radius:14px;text-decoration:none;box-shadow:0 14px 34px rgba(201,151,58,.35)}
.cta2{display:inline-block;margin-top:30px;margin-left:12px;color:#101B30;font-weight:700;font-size:15px;padding:17px 24px;text-decoration:none;border:1.5px solid #DDE3EE;border-radius:14px}
.chips{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:26px}
.chip{background:#F4F7FB;border:1px solid #E6EBF3;border-radius:99px;padding:8px 16px;font-size:13px;font-weight:700;color:#44506A}
section{padding:64px 0}
.band{background:#F7F9FC}
.dark{background:#101B30;color:#fff}
.sec-t{font-family:'Barlow Condensed',sans-serif;font-size:clamp(32px,5vw,48px);font-weight:800;text-align:center;line-height:1.05}
.sec-t em{color:#C9973A;font-style:normal}
.sec-sub{color:#5A6478;text-align:center;font-weight:600;margin:12px auto 34px;max-width:600px;font-size:15px;line-height:1.6}
.dark .sec-sub{color:#9DA8C4}
.demo-frame{background:#fff;border:1px solid #E6EBF3;border-radius:26px;padding:10px;max-width:460px;margin:0 auto;box-shadow:0 26px 70px rgba(16,27,48,.13)}
.demo-frame iframe{width:100%;height:900px;border:0;border-radius:18px;display:block}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px}
.step{background:#fff;border:1px solid #E8ECF3;border-radius:22px;padding:28px;box-shadow:0 10px 30px rgba(16,27,48,.05)}
.step .n{font-family:'Barlow Condensed',sans-serif;color:#C9973A;font-size:44px;font-weight:800}
.step h3{font-size:18px;margin:8px 0 8px}
.step p{color:#5A6478;font-size:14px;font-weight:600;line-height:1.6}
.phone-sec{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:48px}
.phone{width:280px;background:#0B1226;border:10px solid #1E2A45;border-radius:42px;padding:18px 14px 26px;box-shadow:0 36px 90px rgba(0,0,0,.45)}
.notch{width:110px;height:22px;background:#1E2A45;border-radius:0 0 14px 14px;margin:-18px auto 14px}
.papp{background:#F4F6FA;border-radius:18px;padding:12px;color:#101B30}
.phead{font-weight:800;font-size:15px;display:flex;align-items:center;gap:8px;margin-bottom:10px}
.pbadge{background:#C9973A;color:#fff;border-radius:99px;font-size:11px;font-weight:800;padding:3px 10px;margin-left:auto}
.plead{background:#fff;border:2px solid #C9973A;border-radius:14px;padding:12px;font-size:13px;line-height:1.5}
.pnew{background:#C9973A;color:#fff;border-radius:99px;font-size:10px;font-weight:800;padding:2px 8px}
.gold{color:#B07A00;font-weight:800}
.pwa{background:#25D366;color:#fff;border-radius:10px;text-align:center;font-weight:800;font-size:13px;padding:9px;margin-top:10px}
/* Website (laptop) → phone lead animation */
.lead-duo{display:flex;align-items:center;justify-content:center;gap:34px;position:relative;flex-wrap:wrap}
.duo-phone{width:252px}
.laptop{width:min(520px,92vw);flex-shrink:0}
.lap-screen{background:#fff;border:11px solid #1E2A45;border-bottom:none;border-radius:16px 16px 0 0;overflow:hidden;box-shadow:0 36px 90px rgba(0,0,0,.5)}
.lap-base{height:15px;background:linear-gradient(#33415F,#1E2A45);border-radius:2px 2px 14px 14px;box-shadow:0 28px 60px rgba(0,0,0,.45);display:flex;justify-content:center}
.lap-grip{width:88px;height:5px;background:#0E1730;border-radius:0 0 8px 8px;opacity:.85}
.site-nav{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;background:#fff;border-bottom:1px solid #ECEFF5}
.sn-logo{font-size:11px;font-weight:800;letter-spacing:.14em;color:#101B30;white-space:nowrap}
.sn-logo b{color:#B07A00}
.sn-links{display:flex;gap:13px}
.sn-links i{font-style:normal;font-size:10px;font-weight:700;color:#7A8398;white-space:nowrap}
.site-hero{background:linear-gradient(135deg,#101B30 0%,#1B2A5C 58%,#2A3E7C 100%);padding:20px 20px 22px;color:#fff}
.sh-kick{font-size:9px;font-weight:800;letter-spacing:.24em;color:#EFC36A}
.sh-h{font-size:22px;font-weight:800;margin:5px 0 4px}
.sh-sub{font-size:11.5px;font-weight:600;color:rgba(255,255,255,.72);margin-bottom:13px}
.widget-card{background:#fff;border-radius:13px;padding:13px;color:#101B30;box-shadow:0 16px 38px rgba(0,0,0,.38)}
.wc-row{display:grid;grid-template-columns:1fr 1fr;gap:9px}
/* Server-rendered finished state: the client already saw their value */
.wc-form{display:none}
.wv-lab{font-size:9px;font-weight:800;letter-spacing:.18em;color:#5A6478;text-transform:uppercase}
.wv-num{font-size:25px;font-weight:800;color:#B07A00;margin:4px 0 3px}
.wv-sub{font-size:10.5px;font-weight:600;color:#7A8398}
@keyframes valpop{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}
.wc-val.pop{animation:valpop .5s ease}
.ms-bar{background:#E8ECF3;display:flex;align-items:center;gap:5px;padding:8px 10px}
.ms-dot{width:9px;height:9px;border-radius:5px;background:#C6CEDC}
.ms-url{background:#fff;border-radius:7px;font-size:10px;font-weight:700;color:#5A6478;padding:3px 10px;margin-left:6px;flex:1;text-align:center}
.ms-addr{background:#F4F6FA;border:1px solid #E2E7F0;border-radius:8px;font-size:11.5px;font-weight:700;padding:7px 9px;margin-bottom:9px}
.papp-top{background:#101B30;color:#EFC36A;font-size:9px;font-weight:800;letter-spacing:.2em;text-align:center;padding:7px;margin:-12px -12px 10px;border-radius:16px 16px 0 0}
.ms-lab{font-size:9px;font-weight:800;letter-spacing:.1em;color:#5A6478;text-transform:uppercase;margin-bottom:3px}
.ms-in{background:#F4F6FA;border:1.5px solid #E2E7F0;border-radius:8px;min-height:31px;font-size:12.5px;font-weight:700;padding:6px 9px;margin-bottom:8px;display:flex;align-items:center}
.ms-caret{display:inline-block;width:1.5px;height:14px;background:#101B30;margin-left:1px;opacity:0}
.ms-in.typing{border-color:#C9973A}
.ms-in.typing .ms-caret{opacity:1;animation:msblink .8s steps(1) infinite}
@keyframes msblink{50%{opacity:0}}
.ms-btn{background:linear-gradient(135deg,#C9973A,#A87A24);color:#fff;border-radius:9px;text-align:center;font-weight:800;font-size:11.5px;letter-spacing:.04em;padding:11px;transition:transform .15s,background .2s}
.ms-btn.press{transform:scale(.93)}
.ms-btn.sent{background:#1C8C4E}
.duo-fly{position:absolute;left:0;top:0;font-size:26px;opacity:0;pointer-events:none;z-index:3}
.pnotif{background:#101B30;color:#fff;border-radius:11px;font-size:11px;font-weight:600;padding:8px 11px;margin-bottom:9px;box-shadow:0 8px 20px rgba(0,0,0,.35)}
.pnotif b{color:#EFC36A}
.pempty{display:none;color:#8A93A8;font-size:12px;font-weight:600;text-align:center;padding:30px 8px;border:1.5px dashed #C6CEDC;border-radius:14px}
@keyframes duobuzz{0%,100%{transform:none}20%{transform:translateX(-3px) rotate(-.5deg)}40%{transform:translateX(3px) rotate(.5deg)}60%{transform:translateX(-2px)}80%{transform:translateX(2px)}}
.duo-phone.buzz{animation:duobuzz .5s}
@keyframes leadin{from{opacity:0;transform:translateY(-10px) scale(.97)}to{opacity:1;transform:none}}
.plead.in{animation:leadin .45s ease}
.ben{max-width:430px}
.ben li{list-style:none;padding:11px 0;font-weight:600;font-size:16px;color:#E7ECF6;border-bottom:1px solid rgba(255,255,255,.09)}
.ben li b{color:#C9973A}
.apptry{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:44px}
.phone2{width:300px;flex-shrink:0;background:#0B1226;border:11px solid #1E2A45;border-radius:44px;padding:12px 10px;box-shadow:0 40px 96px rgba(0,0,0,.42)}
.phone2 .notch{width:120px;height:24px;background:#1E2A45;border-radius:0 0 15px 15px;margin:-12px auto 10px}
.phone2 iframe{width:100%;height:560px;border:0;border-radius:28px;display:block;background:#F1F4FA}
.ptrywrap{position:relative;width:100%;height:560px;border-radius:28px;overflow:hidden;background:#0B1226}
.ptrywrap iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
.ptrywrap video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;background:#0B1226;pointer-events:none}
.trybox{background:#fff;border:1px solid #E8ECF3;border-radius:22px;padding:28px;max-width:400px;box-shadow:0 18px 50px rgba(16,27,48,.10)}
.trybox .tbh{font-weight:900;font-size:21px;line-height:1.2}
.trybox .tbs{color:#5A6478;font-weight:600;font-size:14px;line-height:1.55;margin:8px 0 18px}
.trybox input{width:100%;padding:14px;border:1.5px solid #E2E5EB;border-radius:12px;font-size:16px;font-weight:600;outline:none;margin-bottom:10px;background:#FBFBFD}
.trybox input:focus{border-color:#C9973A;box-shadow:0 0 0 4px rgba(201,151,58,.14);background:#fff}
.trybox .cta{margin-top:6px}
.trybox .err{color:#D93025;font-size:13px;font-weight:700;margin:-4px 0 8px}
.price-card{background:#fff;border:1px solid #E8ECF3;border-radius:28px;max-width:440px;margin:0 auto;padding:38px;text-align:center;box-shadow:0 30px 80px rgba(16,27,48,.12)}
.price-card .amt{font-family:'Barlow Condensed',sans-serif;font-size:68px;font-weight:800;line-height:1}
.price-card .amt small{font-size:22px;color:#67718A;font-weight:700}
.price-card .setup{color:#67718A;font-weight:700;font-size:14px;margin-top:6px}
.price-card ul{text-align:left;margin:24px 0 0;padding:0}
.price-card li{list-style:none;padding:8px 0;font-weight:600;font-size:14px}
.price-card li::before{content:"✓ ";color:#34A853;font-weight:800}
.tiers{display:grid;gap:18px;align-items:stretch}
@media(min-width:880px){.tiers{grid-template-columns:repeat(3,1fr)}}
.tiers .price-card{max-width:none;margin:0;padding:30px 26px;display:flex;flex-direction:column;position:relative}
.tiers .price-card .amt{font-size:52px}
.tiers .price-card ul{flex:1}
.tiers .price-card li{font-size:13.5px}
.price-card.pop{border:2.5px solid #C9973A;box-shadow:0 34px 90px rgba(201,151,58,.22)}
.pop-tag{position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:#C9973A;color:#101B30;font-size:11px;font-weight:800;letter-spacing:1.2px;border-radius:99px;padding:5px 14px;white-space:nowrap}
.tier-name{font-weight:800;font-size:12.5px;letter-spacing:1.6px;color:#67718A}
.tier-desc{color:#5A6478;font-size:13px;font-weight:600;margin-top:10px;line-height:1.5}
.quiz{max-width:480px;margin:0 auto;position:relative}
.qbar{height:6px;background:#EDF0F5;border-radius:99px;margin-bottom:26px;overflow:hidden}
.qfill{height:100%;width:20%;background:#C9973A;border-radius:99px;transition:width .3s ease}
.qstep{display:none}
.qstep.on{display:block}
.qq{font-weight:800;font-size:19px;text-align:center;margin-bottom:18px}
.opts{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.opt{background:#fff;border:1.5px solid #DDE3EE;border-radius:14px;padding:18px 12px;font-weight:700;font-size:15px;color:#101B30;cursor:pointer;box-shadow:0 6px 18px rgba(16,27,48,.05)}
.opt:hover{border-color:#C9973A;background:#F7EFD8}
.qback{display:block;margin:18px auto 0;background:none;border:none;color:#8A94A8;font-weight:700;font-size:13px;cursor:pointer;box-shadow:none;width:auto;padding:6px 12px}
form{max-width:440px;margin:0 auto}
input{width:100%;padding:15px;border-radius:12px;border:1.5px solid #DDE3EE;background:#fff;color:#101B30;font-size:16px;font-weight:600;margin-bottom:10px;outline:none}
input:focus{border-color:#C9973A}
button{width:100%;padding:17px;border:none;border-radius:12px;background:#C9973A;color:#101B30;font-size:17px;font-weight:800;cursor:pointer;box-shadow:0 12px 30px rgba(201,151,58,.3)}
.ok-msg{display:none;background:#EAF8EF;border:1.5px solid #34A853;color:#1E7B3C;border-radius:12px;padding:14px;font-weight:700;text-align:center;margin-top:10px}
footer{padding:40px 0 54px;text-align:center;font-size:13px;color:#8A94A8;font-weight:600}
footer a{color:#8A94A8}
</style></head><body>
<a class="langpill" href="${langHref}">${L.langBtn}</a>
<div class="wrap">
<nav><span class="lg"><img src="/brand-logo.png" alt="Quick Comp"></span></nav>
<div class="hero">
  <h1>${L.h1}</h1>
  <p>${L.sub}</p>
  <a class="cta" href="#demo">${L.cta1}</a><a class="cta2" href="#precio">${L.cta2}</a>
  <div class="chips">${L.chips.map((c) => `<span class="chip">${c}</span>`).join("")}</div>
</div>
</div>

<div class="wrap"><section>
  <h2 class="sec-t">${L.appTryT}</h2>
  <p class="sec-sub">${L.appTrySub}</p>
  <div class="apptry">
    <div class="phone2"><div class="notch"></div>
      <div class="ptrywrap">
        <video id="ptryvid" src="/landing/app-trial-demo.mp4" autoplay muted playsinline loop></video>
      </div>
    </div>
    <div class="trybox">
      <p class="tbh">${L.phT}</p>
      <p class="tbs">${L.phSub}</p>
      <div id="tryform">
        <input id="tname" placeholder="${L.phName}" autocomplete="name">
        <input id="tphone" placeholder="${L.phPhone}" type="tel" inputmode="numeric" autocomplete="tel">
        <p class="err" id="terr" style="display:none">${L.phErr}</p>
        <button class="cta" style="width:100%;margin-top:6px" onclick="sendTrial()">${L.phBtn}</button>
      </div>
      <div id="tryok" style="display:none">
        <p class="tbh" style="color:#1E7B3C;font-size:16px">${L.phOk}</p>
        <a class="cta" style="width:100%;background:#101B30;color:#fff;margin-top:12px" href="${appLiveUrl}${en ? "&lang=en" : ""}" target="_blank">${L.phTry}</a>
      </div>
    </div>
  </div>
</section></div>

<div class="band"><div class="wrap"><section id="demo" style="padding-bottom:70px">
  <h2 class="sec-t">${L.tryT}</h2>
  <p class="sec-sub">${L.trySub}</p>
  <div class="demo-frame"><iframe src="/w/alto-demo?showcase=1${en ? "&lang=en" : ""}" loading="lazy" title="Demo"></iframe></div>
  <div style="text-align:center;margin-top:38px">
    <p style="font-weight:800;font-size:17px;margin-bottom:4px">${L.fullQ}</p>
    <p class="sec-sub" style="margin-bottom:18px">${L.fullSub}</p>
    <a class="cta" href="/ejemplo${en ? "?lang=en" : "?lang=es"}" target="_blank">${L.fullBtn}</a>
  </div>
</section></div></div>

<div class="wrap"><section>
  <h2 class="sec-t">${L.howT}</h2>
  <div class="steps" style="margin-top:34px">
    <div class="step"><div class="n">1</div><h3>${L.s1t}</h3><p>${L.s1x}</p></div>
    <div class="step"><div class="n">2</div><h3>${L.s2t}</h3><p>${L.s2x}</p></div>
    <div class="step"><div class="n">3</div><h3>${L.s3t}</h3><p>${L.s3x}</p></div>
  </div>
</section></div>

<div class="dark"><div class="wrap"><section>
  <div class="phone-sec">
    <!-- Cause and effect, animated on a loop: the homeowner fills the form on
         the realtor's WEBSITE (left) and the lead lands on the PHONE (right).
         Server-rendered in the finished state so no-JS / reduced-motion still
         shows a complete story. -->
    <div class="lead-duo" id="lduo">
      <div class="laptop">
        <div class="lap-screen">
          <div class="ms-bar"><span class="ms-dot"></span><span class="ms-dot"></span><span class="ms-dot"></span><span class="ms-url">maria-realty.com</span></div>
          <div class="site-nav"><span class="sn-logo">CASA BELLA <b>REALTY</b></span><span class="sn-links">${L.duoNav.map((x) => `<i>${x}</i>`).join("")}</span></div>
          <div class="site-hero">
            <div class="sh-kick">${L.duoKick}</div>
            <div class="sh-h">${L.duoH}</div>
            <div class="sh-sub">${L.duoSub}</div>
            <div class="widget-card">
              <div class="ms-addr" id="msAddr">📍 1214 Fresno Ave</div>
              <div class="wc-form" id="wcForm">
                <div class="wc-row">
                  <div><div class="ms-lab">${L.duoName}</div><div class="ms-in"><span id="msName">Ana García</span><span class="ms-caret"></span></div></div>
                  <div><div class="ms-lab">${L.duoPhone}</div><div class="ms-in"><span id="msPhone">(956) 555-0121</span><span class="ms-caret"></span></div></div>
                </div>
                <div class="ms-btn" id="msBtn">${L.duoBtn}</div>
              </div>
              <div class="wc-val" id="wcVal">
                <div class="wv-lab">${L.duoValLab}</div>
                <div class="wv-num" id="wvNum">$268,000 – $285,000</div>
                <div class="wv-sub">${L.duoValSub}</div>
              </div>
            </div>
          </div>
        </div>
        <div class="lap-base"><span class="lap-grip"></span></div>
      </div>
      <div class="duo-fly" id="duoFly">📥</div>
      <div class="phone duo-phone" id="duoPhone"><div class="notch"></div>
        <div class="papp">
          <div class="papp-top">⚡ QUICK COMP</div>
          <div class="pnotif" id="pnotif">📥 ${L.duoNotif}</div>
          <div class="phead">📥 Leads <span class="pbadge" id="pbadge" data-n1="${L.pNew}" data-n2="${L.pNewTwo}">${L.pNewTwo}</span></div>
          <div class="pempty" id="pempty">${L.duoEmpty}</div>
          <div class="plead" id="plead2" style="margin-bottom:9px"><b>Ana García</b> <span class="pnew">${L.pNew2}</span><br>📍 1214 Fresno Ave<br>(956) 555-0121 · <span class="gold">$268,000–$285,000</span>
            <div class="pwa">💬 WhatsApp</div>
          </div>
          <div class="plead" id="plead"><b>Carlos Pérez</b> <span class="pnew">${L.pNew2}</span><br>📍 502 Britton Ave<br>(956) 555-0188 · <span class="gold">$385,000–$412,000</span>
            <div class="pwa">💬 WhatsApp</div>
          </div>
        </div>
      </div>
    </div>
    <div class="ben">
      <h2 class="sec-t" style="text-align:left">${L.leadsT}</h2>
      <ul style="margin-top:20px;padding:0">${L.leads.map((x) => `<li>${x}</li>`).join("")}</ul>
    </div>
  </div>
</section></div></div>

<div class="band"><div class="wrap"><section id="precio">
  <h2 class="sec-t">${L.priceT}</h2>
  <p class="sec-sub">${L.priceSub}</p>
  <div class="tiers">
    ${L.tiers.map((t) => `<div class="price-card${t.pop ? " pop" : ""}">
      ${t.pop ? `<div class="pop-tag">${L.popTag}</div>` : ""}
      <div class="tier-name">${t.name}</div>
      <div class="amt">$${t.amt}<small>${L.mo}</small></div>
      <div class="setup">${t.setup || L.noSetup}</div>
      <p class="tier-desc">${t.desc}</p>
      <ul>${t.inc.map((x) => `<li>${x}</li>`).join("")}</ul>
      ${t.link
        ? `<a class="cta" style="margin-top:22px;width:100%;text-align:center" href="${t.link}" target="_blank" rel="noreferrer">${L.buyNow}</a>`
        : `<a class="cta" style="margin-top:22px;width:100%;text-align:center" href="#contacto">${L.cta2}</a>`}
    </div>`).join("")}
  </div>
  <p style="text-align:center;margin-top:18px"><a href="#contacto" style="color:#67718A;font-weight:700;font-size:13px;text-decoration:none">${L.orBook}</a></p>
</section></div></div>

<div class="wrap"><section id="contacto">
  <h2 class="sec-t">${L.talkT}</h2>
  <p class="sec-sub">${L.talkSub}</p>
  <div class="quiz" id="quiz">
    <div class="qbar"><div class="qfill" id="qfill"></div></div>
    <div class="qstep on" data-q="work">
      <p class="qq">${L.q1}</p>
      <div class="opts">${L.q1o.map((o) => `<button type="button" class="opt" onclick="qPick('work','${o}')">${o}</button>`).join("")}</div>
    </div>
    <div class="qstep" data-q="crew">
      <p class="qq">${L.q2}</p>
      <div class="opts">${L.q2o.map((o) => `<button type="button" class="opt" onclick="qPick('crew','${o}')">${o}</button>`).join("")}</div>
    </div>
    <div class="qstep" data-q="revenue">
      <p class="qq">${L.q3}</p>
      <div class="opts">${L.q3o.map((o) => `<button type="button" class="opt" onclick="qPick('revenue','${o}')">${o}</button>`).join("")}</div>
    </div>
    <div class="qstep" data-q="marketing">
      <p class="qq">${L.q4}</p>
      <div class="opts">${L.q4o.map((o) => `<button type="button" class="opt" onclick="qPick('marketing','${o}')">${o}</button>`).join("")}</div>
    </div>
    <div class="qstep" data-q="contact">
      <p class="qq">${L.q5}</p>
      <form id="f" onsubmit="return sendLead(event)">
        <input id="fn" placeholder="${L.fName}" required>
        <input id="fb" placeholder="${L.fBiz}">
        <input id="fp" placeholder="${L.fPhone}" type="tel" inputmode="numeric" required>
        <button>${L.fBtn}</button>
      </form>
    </div>
    <div class="ok-msg" id="okm">${L.fOk}</div>
    <button type="button" class="qback" id="qback" onclick="qBack()" style="display:none">${L.back}</button>
  </div>
</section>
<footer>${L.foot}<br><a href="/legal${en ? "" : "?lang=es"}" style="color:inherit;text-decoration:underline;opacity:.85">${en ? "Privacy &amp; Terms" : "Privacidad y Términos"}</a></footer>
</div>
<script>
function track(ev){try{fetch('/api/track',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:ev})})}catch(e){}}
track('visit');
var qAns={},qSteps=[].slice.call(document.querySelectorAll('.qstep')),qCur=0;
function qShow(i){
  qCur=Math.max(0,Math.min(qSteps.length-1,i));
  qSteps.forEach(function(st,k){st.classList.toggle('on',k===qCur)});
  document.getElementById('qfill').style.width=((qCur+1)/qSteps.length*100)+'%';
  document.getElementById('qback').style.display=qCur>0?'block':'none';
}
function qPick(key,val){qAns[key]=val;track('quiz_'+key);qShow(qCur+1)}
function qBack(){qShow(qCur-1)}
// The phone mockup plays the scripted walkthrough on a LOOP — the raw
// embedded app (demo banner, cramped layout) must never appear here. It
// starts from the top when scrolled into view (autoplay-on-load would finish
// before anyone scrolls down) and pauses off-screen. Only if the file
// genuinely can't play do we swap in the live app, so the phone is never
// an empty box.
(function(){
  var v=document.getElementById('ptryvid');
  if(!v)return;
  function fallback(){
    if(!v.parentNode)return;
    var f=document.createElement('iframe');
    f.src=${JSON.stringify(`${appLiveUrl}${en ? "&lang=en" : ""}`)};f.title='Quick Comp';
    v.parentNode.appendChild(f);v.remove();
  }
  if(v.error)fallback();else v.addEventListener('error',fallback);
  if('IntersectionObserver' in window){
    var started=false;
    new IntersectionObserver(function(es){es.forEach(function(e){
      if(!v.parentNode)return;
      if(e.isIntersecting){
        if(!started){started=true;try{v.currentTime=0}catch(x){}}
        var p=v.play();if(p&&p.catch)p.catch(function(){});
      }else v.pause();
    })},{threshold:.3}).observe(v);
  }
})();
// Lead duo: two homeowners in a row "type" into the website form on the
// laptop, the site reveals their home's VALUE (what the client sees), and
// each lead flies into the phone — notification, buzz, badge counting up,
// cards stacking in the inbox. Loops while in view. The page is
// server-rendered in the finished state (value shown, 2 leads landed), so
// no-JS and reduced-motion visitors still see the complete story.
(function(){
  var duo=document.getElementById('lduo');if(!duo)return;
  if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  var nameEl=document.getElementById('msName'),phEl=document.getElementById('msPhone');
  var in1=nameEl.parentNode,in2=phEl.parentNode;
  var btn=document.getElementById('msBtn'),fly=document.getElementById('duoFly');
  var phone=document.getElementById('duoPhone'),notif=document.getElementById('pnotif');
  var badge=document.getElementById('pbadge'),empty=document.getElementById('pempty');
  var addr=document.getElementById('msAddr'),wcForm=document.getElementById('wcForm');
  var wcVal=document.getElementById('wcVal'),wvNum=document.getElementById('wvNum');
  var BTN=btn.textContent,N1=badge.getAttribute('data-n1'),N2=badge.getAttribute('data-n2');
  var PEOPLE=[
    {name:'Carlos Pérez',ph:'(956) 555-0188',addr:'📍 502 Britton Ave',val:'$385,000 – $412,000',card:document.getElementById('plead')},
    {name:'Ana García',ph:'(956) 555-0121',addr:'📍 1214 Fresno Ave',val:'$268,000 – $285,000',card:document.getElementById('plead2')}
  ];
  var playing=false;
  function type(el,box,txt,done){
    box.classList.add('typing');var i=0;
    (function tick(){
      if(i<=txt.length){el.textContent=txt.slice(0,i);i++;setTimeout(tick,50)}
      else{box.classList.remove('typing');done&&done()}
    })();
  }
  function formReset(p){
    addr.textContent=p.addr;nameEl.textContent='';phEl.textContent='';
    btn.classList.remove('press','sent');btn.textContent=BTN;
    wcVal.style.display='none';wcVal.classList.remove('pop');wcForm.style.display='block';
    phone.classList.remove('buzz');fly.style.opacity='0';fly.style.transition='none';fly.style.transform='none';
  }
  function phoneReset(){
    notif.style.visibility='hidden';badge.style.visibility='hidden';badge.textContent=N1;
    PEOPLE.forEach(function(p){p.card.style.display='none';p.card.classList.remove('in')});
    empty.style.display='block';
  }
  function send(i,p){
    setTimeout(function(){btn.classList.add('press')},250);
    setTimeout(function(){btn.classList.remove('press');btn.classList.add('sent');btn.textContent='✓'},450);
    // the client sees the value on the website...
    setTimeout(function(){
      wvNum.textContent=p.val;wcForm.style.display='none';
      wcVal.style.display='block';wcVal.classList.add('pop');
    },1000);
    // ...and the lead flies to the realtor's phone
    setTimeout(function(){
      var a=wcVal.getBoundingClientRect(),b=phone.getBoundingClientRect(),d=duo.getBoundingClientRect();
      fly.style.left=(a.left-d.left+a.width/2-13)+'px';
      fly.style.top=(a.top-d.top+a.height/2-13)+'px';
      fly.style.opacity='1';
      requestAnimationFrame(function(){requestAnimationFrame(function(){
        fly.style.transition='transform .7s cubic-bezier(.5,-.15,.6,1),opacity .7s';
        fly.style.transform='translate('+(b.left+b.width/2-a.left-a.width/2)+'px,'+(b.top+b.height/2-a.top-a.height/2)+'px) scale(.4)';
        fly.style.opacity='0';
      })});
    },1500);
    setTimeout(function(){land(i,p)},2200);
  }
  function land(i,p){
    phone.classList.add('buzz');
    notif.style.visibility='visible';empty.style.display='none';
    badge.style.visibility='visible';badge.textContent=(i===0?N1:N2);
    p.card.style.display='block';p.card.classList.add('in');
    if(i===0){setTimeout(function(){cycle(1)},4200)}
    else{setTimeout(function(){playing=false;play()},5600)}
  }
  function cycle(i){
    var p=PEOPLE[i];
    formReset(p);
    setTimeout(function(){
      type(nameEl,in1,p.name,function(){
        setTimeout(function(){type(phEl,in2,p.ph,function(){send(i,p)})},320);
      });
    },500);
  }
  function play(){
    if(playing)return;playing=true;phoneReset();cycle(0);
  }
  if('IntersectionObserver' in window){
    new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)play()})},{threshold:.35}).observe(duo);
  }else play();
})();
// "Try it on your phone" — captures the prospect as a sales lead, then reveals
// the trial link so they can open the app on their phone right away.
function sendTrial(){
  var ph=document.getElementById('tphone').value.replace(/\\D/g,'');
  if(ph.length<10){document.getElementById('terr').style.display='block';return}
  document.getElementById('terr').style.display='none';
  fetch('/api/widget/lead',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({slug:'alto-ventas',name:document.getElementById('tname').value,phone:ph,info:{src:'trial-app'}})}).catch(function(){});
  track('trial_link');if(window.fbq)fbq('track','Lead');
  document.getElementById('tryform').style.display='none';
  document.getElementById('tryok').style.display='block';
}
function sendLead(e){e.preventDefault();
  var ph=document.getElementById('fp').value.replace(/\\D/g,'');
  if(ph.length<10){document.getElementById('fp').style.borderColor='#D93025';return false}
  fetch('/api/widget/lead',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({slug:'alto-ventas',name:document.getElementById('fn').value,phone:ph,
      info:{src:'landing',biz:document.getElementById('fb').value,work:qAns.work||'',crew:qAns.crew||'',revenue:qAns.revenue||'',marketing:qAns.marketing||''}})})
  .then(function(){track('quiz_done');if(window.fbq)fbq('track','Lead');finishQuiz()}).catch(function(){finishQuiz()});
  return false}
function finishQuiz(){
  qSteps.forEach(function(st){st.classList.remove('on')});
  document.getElementById('qback').style.display='none';
  document.getElementById('qfill').style.width='100%';
  document.getElementById('okm').style.display='block';
}
</script></body></html>`;
}

// Preview the landing on any host (and in dev) without touching DNS
app.get("/ventas", (req, res) => res.send(landingPage(req)));

/* ── Example client website (template #1, "Clásico") ──
 * A complete, working roofer site a prospect can click through — the
 * live widget is embedded, so it really quotes. Branded with honest
 * placeholders ("imagina TU logo aquí"), never fake reviews. */
app.get("/ejemplo", (req, res) => {
  // ?embed=1 (deck mockups): hide the ALTO ribbon and the back button
  const embed = req.query.embed != null;
  // English by default — this sample site is shown to prospects off the
  // (default English) sales page; ?lang=es keeps the Spanish version reachable.
  const en = req.query.lang !== "es";
  const langHref = `?${embed ? "embed=1&" : ""}lang=${en ? "es" : "en"}`;
  const T = en ? {
    title: "Casa Bella Realty — Quick Comp Example",
    ribbon: "📋 SAMPLE PAGE — imagine YOUR logo and YOUR name here. This is what your site would look like with Quick Comp.",
    langBtn: "🇲🇽 Español",
    hours: "Mon–Sat · 7am–7pm",
    kicker: "REAL ESTATE · YOUR CITY, TX",
    h1a: "Sell your home for", h1b: "what it's really worth",
    heroSub: "Find out your home's value instantly, from real nearby sales — free, with no one visiting your home.",
    ctaValue: "VALUE YOUR HOME IN 10 SECONDS", ctaCall: "Call us",
    statYears: "years", statSold: "homes sold", statDedication: "dedication",
    qEyebrow: "Instant valuation", qH: ["The value of your home, ", "no waiting"],
    qTitle: "Type your address.<br>Real sales do the rest.", qDesc: "Our system analyzes recent comparable sales and gives you an instant estimated value — free, no obligation.",
    qLi: ["The real value of YOUR home", "Estimated in 10 seconds", "Full CMA report, free"],
    svcEyebrow: "Services", svcH: ["What we do ", "well"],
    svc: [
      ["Sell your home", "We price it right from day one, with a marketing plan that brings real buyers."],
      ["Buy a home", "We represent you as the buyer — we search, negotiate, and handle every detail through closing."],
      ["Free valuation / CMA", "A comparative market analysis using real nearby sales, so you know what your home is worth today."],
      ["Market guidance", "We tell you the truth about the market — when to sell, when to wait — even if it's not today."],
    ],
    soldEyebrow: "Recent sales", soldH: ["Homes sold ", "at the best price"],
    soldSub: "Every sale starts with the right price, backed by real comparable sales — so we sell fast without leaving money on the table.",
    sold: [["Sold in 9 days", "3 bd · 2 ba · over asking"], ["Sold in 14 days", "4 bd · 3 ba · at asking"], ["Buyer represented", "Closed $12k under asking"]],
    procEyebrow: "Our process", procH: ["Simple, ", "start to finish"],
    steps: [["Valuation", "We analyze real comparable sales to know exactly what your home is worth today. Free."], ["Pricing strategy", "A clear, written price and marketing plan to sell fast and for the most money."], ["Closing", "We negotiate on your behalf and handle every detail of the paperwork until you get your check."]],
    revEyebrow: "Reviews", revH: ["What ", "our clients say"],
    revBody: "Your real Google reviews go here.<br>(We don't invent testimonials on this sample page.)",
    ctaH: ["Ready to sell for", "the best price?"], ctaSub: "Value your home in 10 seconds or send us a WhatsApp message.",
    ctaValueBtn: "VALUE NOW", ctaWa: "💬 WhatsApp",
    footBiz: "Casa Bella Realty", footLine: "Your City, TX · Lic. #00000 · Mon–Sat 9am–7pm",
    footMade: "Sample page built with ⚡ Quick Comp — ", footMadeLink: "yours could look like this",
    back: "← Back to ", backB: "QUICK COMP",
  } : {
    title: "Casa Bella Realty — Ejemplo Quick Comp",
    ribbon: "📋 PÁGINA DE EJEMPLO — imagina TU logo y TU nombre aquí. Así se vería tu página con Quick Comp.",
    langBtn: "🇺🇸 English",
    hours: "Lun–Sáb · 7am–7pm",
    kicker: "BIENES RAÍCES · TU CIUDAD, TX",
    h1a: "Vende tu casa por", h1b: "lo que de verdad vale",
    heroSub: "Descubre el valor de tu casa al instante, con ventas reales cercanas — gratis y sin que nadie te visite.",
    ctaValue: "VALÚA TU CASA EN 10 SEGUNDOS", ctaCall: "Llámanos",
    statYears: "años", statSold: "casas vendidas", statDedication: "dedicación",
    qEyebrow: "Valuación instantánea", qH: ["El valor de tu casa, ", "sin esperar"],
    qTitle: "Escribe tu dirección.<br>Las ventas reales hacen el resto.", qDesc: "Nuestro sistema analiza ventas comparables recientes y te da el valor estimado al instante — gratis y sin compromiso.",
    qLi: ["Valor real de TU casa", "Estimado en 10 segundos", "Análisis completo (CMA) gratis"],
    svcEyebrow: "Servicios", svcH: ["Lo que hacemos ", "bien"],
    svc: [
      ["Vende tu casa", "Te ponemos al precio correcto desde el día uno, con un plan de marketing que atrae compradores reales."],
      ["Compra tu casa", "Te representamos como comprador — buscamos, negociamos y cuidamos cada detalle hasta las llaves."],
      ["Valuación / CMA gratis", "Un análisis comparativo de mercado con ventas reales cercanas para saber qué vale tu casa hoy."],
      ["Asesoría de mercado", "Te decimos la verdad del mercado — cuándo vender, cuándo esperar — aunque no sea hoy."],
    ],
    soldEyebrow: "Ventas recientes", soldH: ["Casas vendidas ", "al mejor precio"],
    soldSub: "Cada venta empieza con un precio correcto, basado en ventas comparables reales — así vendemos rápido y sin dejar dinero en la mesa.",
    sold: [["Vendida en 9 días", "3 rec · 2 baños · sobre el precio de lista"], ["Vendida en 14 días", "4 rec · 3 baños · al precio de lista"], ["Comprador representado", "Cerró $12k bajo el precio de lista"]],
    procEyebrow: "Nuestro proceso", procH: ["Simple, ", "de principio a fin"],
    steps: [["Valuación", "Analizamos ventas comparables reales para saber exactamente qué vale tu casa hoy. Gratis."], ["Estrategia de precio", "Un plan claro de precio y marketing por escrito para vender rápido y al mejor valor."], ["Cierre", "Negociamos por ti y cuidamos cada detalle del papeleo hasta que recibes tu cheque."]],
    revEyebrow: "Reseñas", revH: ["Lo que dicen ", "nuestros clientes"],
    revBody: "Aquí van las reseñas reales de TUS clientes de Google.<br>(En esta página de ejemplo no inventamos testimonios.)",
    ctaH: ["¿Listo para vender", "al mejor precio?"], ctaSub: "Valúa tu casa en 10 segundos o mándanos un WhatsApp.",
    ctaValueBtn: "VALÚA AHORA", ctaWa: "💬 WhatsApp",
    footBiz: "Casa Bella Realty", footLine: "Tu Ciudad, TX · Lic. #00000 · Lun–Sáb 9am–7pm",
    footMade: "Página de ejemplo hecha con ⚡ Quick Comp — ", footMadeLink: "así puede ser la tuya",
    back: "← Volver a ", backB: "QUICK COMP",
  };
  res.send(`<!doctype html><html lang="${en ? "en" : "es"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${T.title}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0;-webkit-tap-highlight-color:transparent}
:root{--red:#B30F24;--red2:#8E0C1D;--ink:#0F1216;--mut:#5E6470;--line:#E9EAEE;--cream:#FAF8F5}
body{background:#fff;color:var(--ink)}
.serif{font-family:'Fraunces',Georgia,serif}
.wrap{max-width:1060px;margin:0 auto;padding:0 24px}
.ribbon{background:#C9973A;color:#101B30;text-align:center;font-weight:800;font-size:12.5px;padding:9px 14px;letter-spacing:.2px}
header{position:sticky;top:0;z-index:40;background:rgba(255,255,255,.82);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.hrow{display:flex;align-items:center;justify-content:space-between;padding:15px 0}
.logo-ph{border:1.5px dashed #C9CDD6;border-radius:10px;padding:9px 18px;font-weight:700;font-size:12px;color:#9AA0AC;letter-spacing:2.5px}
.hcall{display:flex;align-items:center;gap:14px}
.hcall small{font-weight:700;color:var(--mut);font-size:12px;display:none}
@media(min-width:640px){.hcall small{display:block}}
.callbtn{background:var(--red);color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;box-shadow:0 8px 22px rgba(179,15,36,.28)}
.langpill{background:#fff;border:1.5px solid var(--line);color:var(--ink);text-decoration:none;font-weight:700;font-size:13px;padding:11px 16px;border-radius:10px;white-space:nowrap}
.hero{position:relative;color:#fff;overflow:hidden;background:#1A0509}
.hero .bgimg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.5;filter:saturate(.7) contrast(1.05)}
.hero .veil{position:absolute;inset:0;background:linear-gradient(165deg,rgba(20,3,6,.92) 0%,rgba(90,8,20,.78) 60%,rgba(179,15,36,.55) 100%)}
.hero .in{position:relative;padding:108px 0 118px;text-align:center}
.kick{display:inline-block;border:1px solid rgba(255,255,255,.35);border-radius:99px;padding:8px 18px;font-size:12px;font-weight:700;letter-spacing:3px;color:#F6D9DD;margin-bottom:26px}
.hero h1{font-family:'Fraunces',Georgia,serif;font-size:clamp(42px,7.4vw,76px);line-height:1.04;font-weight:700;letter-spacing:.3px;max-width:820px;margin:0 auto}
.hero h1 em{font-style:italic;color:#FFC9D1}
.hero p{color:#EBC6CC;font-weight:500;font-size:clamp(15px,2.3vw,18px);margin:22px auto 0;max-width:540px;line-height:1.65}
.hero .cta{display:inline-block;margin:34px 7px 0;background:#fff;color:var(--red);font-weight:800;font-size:16px;padding:17px 32px;border-radius:12px;text-decoration:none;box-shadow:0 18px 44px rgba(0,0,0,.35)}
.hero .cta.ghost{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.45);box-shadow:none;font-weight:700}
.stats{position:relative;display:flex;justify-content:center;gap:clamp(26px,6vw,72px);padding:26px 18px 34px;flex-wrap:wrap}
.stat{text-align:center}
.stat b{font-family:'Fraunces',Georgia,serif;font-size:clamp(26px,4vw,38px);font-weight:700;display:block;color:#fff}
.stat span{font-size:12px;font-weight:600;letter-spacing:1.5px;color:#E0AEB6;text-transform:uppercase}
section{padding:84px 0}
.eyebrow{color:var(--red);font-weight:800;font-size:12px;letter-spacing:3.5px;text-transform:uppercase;text-align:center}
.t{font-family:'Fraunces',Georgia,serif;font-size:clamp(32px,5vw,50px);font-weight:700;text-align:center;line-height:1.08;margin-top:12px}
.t em{font-style:italic;color:var(--red)}
.sub{color:var(--mut);text-align:center;font-weight:500;margin:16px auto 0;max-width:560px;font-size:16px;line-height:1.7}
.qwrap{background:var(--cream);border-radius:32px;padding:clamp(28px,5vw,60px) clamp(18px,4vw,60px);margin-top:44px}
.qgrid{display:grid;gap:40px;align-items:center}
@media(min-width:880px){.qgrid{grid-template-columns:1fr 440px}}
.qcopy h3{font-family:'Fraunces',Georgia,serif;font-size:clamp(26px,3.4vw,36px);font-weight:700;line-height:1.15}
.qcopy p{color:var(--mut);font-size:15.5px;font-weight:500;line-height:1.7;margin-top:14px}
.qcopy ul{margin:22px 0 0;padding:0;list-style:none}
.qcopy li{padding:9px 0;font-weight:600;font-size:15px;display:flex;gap:10px;align-items:baseline}
.qcopy li::before{content:"—";color:var(--red);font-weight:800}
.qframe{background:#fff;border:1px solid var(--line);border-radius:26px;padding:10px;box-shadow:0 34px 90px rgba(15,18,22,.14)}
.qframe iframe{width:100%;height:900px;border:0;border-radius:18px;display:block}
.svc{display:grid;grid-template-columns:54px 1fr auto;gap:18px;align-items:baseline;padding:30px 6px;border-bottom:1px solid var(--line)}
.svc:first-of-type{border-top:1px solid var(--line)}
.svc .no{font-family:'Fraunces',Georgia,serif;color:#C9CDD6;font-size:20px;font-weight:700}
.svc h3{font-family:'Fraunces',Georgia,serif;font-size:clamp(20px,3vw,26px);font-weight:700}
.svc p{color:var(--mut);font-size:14.5px;font-weight:500;line-height:1.65;margin-top:6px;max-width:560px}
.svc .arr{color:var(--red);font-weight:800;font-size:20px}
.projgrid{display:grid;gap:18px;margin-top:44px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.proj{position:relative;border-radius:22px;overflow:hidden;border:1px solid var(--line);box-shadow:0 18px 50px rgba(15,18,22,.10)}
.proj img{width:100%;height:240px;object-fit:cover;display:block}
.proj .tag{position:absolute;left:14px;bottom:14px;background:rgba(15,18,22,.78);backdrop-filter:blur(8px);color:#fff;border-radius:10px;padding:9px 14px;font-size:12.5px;font-weight:700}
.proj .tag small{display:block;color:#C9CDD6;font-weight:600;font-size:11px;margin-top:2px}
.steps{display:grid;gap:0;margin-top:44px;grid-template-columns:1fr}
@media(min-width:760px){.steps{grid-template-columns:repeat(3,1fr);gap:34px}}
.pstep{padding:28px 8px;text-align:center}
.pstep .pn{width:54px;height:54px;border-radius:50%;border:1.5px solid var(--red);color:var(--red);font-family:'Fraunces',Georgia,serif;font-weight:700;font-size:20px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
.pstep h3{font-family:'Fraunces',Georgia,serif;font-size:21px;font-weight:700}
.pstep p{color:var(--mut);font-size:14px;font-weight:500;line-height:1.65;margin-top:8px}
.gband{background:var(--cream);text-align:center}
.gband .big{font-family:'Fraunces',Georgia,serif;font-size:clamp(26px,4.4vw,44px);font-weight:700;line-height:1.2;max-width:760px;margin:14px auto 0}
.gband .big em{font-style:italic;color:var(--red)}
.rev{border:1px dashed #D8DBE2;border-radius:22px;padding:36px;text-align:center;max-width:600px;margin:44px auto 0;background:#fff}
.rev .stars{color:#E8B411;font-size:24px;letter-spacing:6px}
.rev p{color:#9AA0AC;font-weight:600;margin-top:12px;font-size:14px;line-height:1.6}
.ctaband{position:relative;background:#160409;color:#fff;text-align:center;padding:96px 22px;overflow:hidden}
.ctaband .bgimg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.35;filter:saturate(.6)}
.ctaband .veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(22,4,9,.88),rgba(142,12,29,.82))}
.ctaband .in{position:relative}
.ctaband h2{font-family:'Fraunces',Georgia,serif;font-size:clamp(32px,5.4vw,54px);font-weight:700;line-height:1.08}
.ctaband h2 em{font-style:italic;color:#FFC9D1}
.ctaband p{color:#EBC6CC;font-weight:500;margin-top:14px;font-size:16px}
.ctaband a{display:inline-block;margin:30px 7px 0;font-weight:800;font-size:16px;padding:17px 30px;border-radius:12px;text-decoration:none}
.ctaband .a1{background:#fff;color:var(--red)}
.ctaband .a2{background:#25D366;color:#fff}
footer{padding:44px 22px 120px;text-align:center;color:#9AA0AC;font-size:13px;font-weight:500;line-height:2}
footer b{color:var(--ink);font-family:'Fraunces',Georgia,serif;font-size:16px}
footer a{color:#9AA0AC}
.backalto{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:50;background:#101B30;color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:13px 22px;border-radius:99px;box-shadow:0 14px 36px rgba(16,27,48,.5);display:flex;align-items:center;gap:8px;white-space:nowrap}
.backalto span{color:#C9973A}
.fade{opacity:0;transform:translateY(26px);transition:opacity .7s ease,transform .7s ease}
.fade.on{opacity:1;transform:none}
@media (prefers-reduced-motion: reduce){.fade{opacity:1;transform:none;transition:none}}
</style></head><body>
${embed ? "" : `<div class="ribbon">${T.ribbon}</div>`}
<header><div class="wrap hrow">
  <span class="logo-ph">${en ? "YOUR LOGO" : "TU LOGO"}</span>
  <span class="hcall"><small>${T.hours}</small><a class="callbtn" href="tel:+19565550100">📞 (956) 555-0100</a>${embed ? "" : `<a class="langpill" href="${langHref}">${T.langBtn}</a>`}</span>
</div></header>

<div class="hero">
  <img class="bgimg" src="/api/roofimg?lat=26.3828&lng=-98.8198&zoom=18" alt="">
  <div class="veil"></div>
  <div class="wrap in">
    <span class="kick">${T.kicker}</span>
    <h1>${T.h1a}<br><em>${T.h1b}</em></h1>
    <p>${T.heroSub}</p>
    <a class="cta" href="#cotiza">${T.ctaValue}</a><a class="cta ghost" href="tel:+19565550100">${T.ctaCall}</a>
  </div>
  <div class="wrap stats">
    <div class="stat"><b>15+</b><span>${T.statYears}</span></div>
    <div class="stat"><b>300+</b><span>${T.statSold}</span></div>
    <div class="stat"><b>100%</b><span>${T.statDedication}</span></div>
  </div>
</div>

<div class="wrap"><section id="cotiza">
  <p class="eyebrow">${T.qEyebrow}</p>
  <h2 class="t">${T.qH[0]}<em>${T.qH[1]}</em></h2>
  <div class="qwrap fade">
    <div class="qgrid">
      <div class="qcopy">
        <h3>${T.qTitle}</h3>
        <p>${T.qDesc}</p>
        <ul>${T.qLi.map((x) => `<li>${x}</li>`).join("")}</ul>
      </div>
      <div class="qframe"><iframe src="/w/alto-demo?showcase=1${en ? "&lang=en" : ""}" loading="lazy" title="${en ? "Valuator" : "Valuador"}"></iframe></div>
    </div>
  </div>
</section></div>

<div class="wrap"><section style="padding-top:10px">
  <p class="eyebrow">${T.svcEyebrow}</p>
  <h2 class="t">${T.svcH[0]}<em>${T.svcH[1]}</em></h2>
  <div style="margin-top:44px">
    ${T.svc.map(([h, p], i) => `<div class="svc fade"><span class="no">0${i + 1}</span><div><h3>${h}</h3><p>${p}</p></div><span class="arr">→</span></div>`).join("\n    ")}
  </div>
</section></div>

<div class="wrap"><section style="padding-top:10px">
  <p class="eyebrow">${T.soldEyebrow}</p>
  <h2 class="t">${T.soldH[0]}<em>${T.soldH[1]}</em></h2>
  <p class="sub">${T.soldSub}</p>
  <div class="projgrid">
    <div class="proj fade"><img loading="lazy" src="/api/roofimg?lat=26.3827418&lng=-98.8196915&zoom=20" alt=""><span class="tag">${T.sold[0][0]}<small>${T.sold[0][1]}</small></span></div>
    <div class="proj fade"><img loading="lazy" src="/api/roofimg?lat=26.3795779&lng=-98.8186812&zoom=20" alt=""><span class="tag">${T.sold[1][0]}<small>${T.sold[1][1]}</small></span></div>
    <div class="proj fade"><img loading="lazy" src="/api/roofimg?lat=26.3807212&lng=-98.8148616&zoom=20" alt=""><span class="tag">${T.sold[2][0]}<small>${T.sold[2][1]}</small></span></div>
  </div>
</section></div>

<div class="gband"><div class="wrap"><section>
  <p class="eyebrow">${T.procEyebrow}</p>
  <h2 class="t">${T.procH[0]}<em>${T.procH[1]}</em></h2>
  <div class="steps">
    <div class="pstep fade"><div class="pn">1</div><h3>${T.steps[0][0]}</h3><p>${T.steps[0][1]}</p></div>
    <div class="pstep fade"><div class="pn">2</div><h3>${T.steps[1][0]}</h3><p>${T.steps[1][1]}</p></div>
    <div class="pstep fade"><div class="pn">3</div><h3>${T.steps[2][0]}</h3><p>${T.steps[2][1]}</p></div>
  </div>
</section></div></div>

<div class="wrap"><section>
  <p class="eyebrow">${T.revEyebrow}</p>
  <h2 class="t">${T.revH[0]}<em>${T.revH[1]}</em></h2>
  <div class="rev fade">
    <div class="stars">★★★★★</div>
    <p>${T.revBody}</p>
  </div>
</section></div>

<div class="ctaband">
  <img class="bgimg" src="/api/roofimg?lat=26.3828&lng=-98.8198&zoom=17" alt="">
  <div class="veil"></div>
  <div class="in">
    <h2>${T.ctaH[0]}<br><em>${T.ctaH[1]}</em></h2>
    <p>${T.ctaSub}</p>
    <a class="a1" href="#cotiza">${T.ctaValueBtn}</a><a class="a2" href="https://wa.me/19565550100">${T.ctaWa}</a>
  </div>
</div>
<footer><b>${T.footBiz}</b><br>${T.footLine}<br>${T.footMade}<a href="/ventas${en ? "" : "?lang=es"}">${T.footMadeLink}</a></footer>
${embed ? "" : `<a class="backalto" href="/ventas${en ? "" : "?lang=es"}#precio">${T.back}<span>${T.backB}</span></a>`}
<script>
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('on');io.unobserve(e.target)}})},{threshold:.15});
document.querySelectorAll('.fade').forEach(function(el){io.observe(el)});
</script>
</body></html>`);
});

/* ── Client websites (the factory's output) ──
 * Rendered from the client's data card through template 1/2/3.
 * No code per client — improve a template, every site improves. */
function siteDataOf(c) {
  const p = c.data?.profile || {};
  const site = c.data?.site || {};
  return {
    slug: c.slug,
    lang: site.lang || p.lang || "es",
    biz: p.biz || c.name,
    phone: String(p.phone || c.phone || "").replace(/\D/g, "").replace(/^1/, ""),
    logo: /^data:image\/(png|jpeg);base64,/.test(String(p.logo || "")) ? p.logo : null,
    license: p.license || "",
    template: site.template || "1",
    color: site.color || "#B30F24",
    hero: site.hero || "",
    city: site.city || "",
    years: site.years || null,
    tagline: site.tagline || "",
    about: site.about || "",
    area: site.area || "",
    warranty: site.warranty || "",
    diff: site.diff || "",
    photos: Array.isArray(site.photos) ? site.photos : [],
    ...(Array.isArray(site.services) && site.services.length ? { services: site.services } : {}),
  };
}

app.get("/site/:slug", async (req, res) => {
  const c = await db.getContractorBySlug(String(req.params.slug));
  if (!c) return res.status(404).send("Not found");
  if (c.data?.status === "paused" || c.data?.payStatus === "pending") {
    const pProf = c.data?.profile || {};
    const pBiz = String(pProf.biz || c.name).replace(/[&<>"]/g, "");
    const pPhone = String(pProf.phone || c.phone || "").replace(/\D/g, "");
    return res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pBiz}</title><style>
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0}body{background:#F4F6FA;color:#101B30;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;border:1px solid #E6EBF3;border-radius:22px;padding:36px 28px;max-width:420px;text-align:center;box-shadow:0 20px 60px rgba(16,27,48,.1)}
h1{font-size:20px;margin:12px 0 8px}p{color:#5A6478;font-weight:600;font-size:14.5px;line-height:1.6}
a{display:inline-block;margin-top:18px;background:#101B30;color:#fff;text-decoration:none;font-weight:800;padding:14px 26px;border-radius:12px}
</style></head><body><div class="card">
<span style="font-size:40px">🏡</span><h1>${pBiz}</h1>
<p>Este sitio no está disponible por el momento.<br>This site is temporarily unavailable.</p>
${pPhone ? `<a href="tel:+1${pPhone}">📞 Llámanos / Call us</a>` : ""}
</div></body></html>`);
  }
  // Not published yet → branded "en construcción" page (the site is ready
  // internally; staff reveal it on delivery day). Staff preview with ?preview=1.
  const published = c.data?.site?.published === true;
  const preview = req.query.preview != null && closerOk(req);
  if (!published && !preview) {
    const cProf = c.data?.profile || {};
    const cBiz = String(cProf.biz || c.name).replace(/[&<>"]/g, "");
    const cLogo = /^data:image\/(png|jpeg);base64,/.test(String(cProf.logo || "")) ? cProf.logo : null;
    const cColor = /^#[0-9a-fA-F]{6}$/.test(String(c.data?.site?.color || "")) ? c.data.site.color : "#101B30";
    return res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${cBiz} — en construcción</title><style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0}
body{background:#0F1726;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:22px}
.card{background:#fff;color:#101B30;border-radius:26px;padding:40px 30px;max-width:440px;width:100%;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.4)}
.logo{max-height:60px;max-width:200px;margin-bottom:8px}
.biz{font-weight:800;font-size:22px;color:${cColor}}
h1{font-size:20px;margin:18px 0 6px}
.sub{color:#5A6478;font-weight:600;font-size:14px;line-height:1.6}
.bar{height:8px;background:#EDF0F5;border-radius:99px;margin:22px 0 8px;overflow:hidden}
.fill{height:100%;width:66%;background:${cColor};border-radius:99px}
.eta{color:#8A94A8;font-weight:700;font-size:12px;letter-spacing:1px;text-transform:uppercase}
ul{list-style:none;padding:0;margin:24px 0 0;text-align:left}
li{padding:10px 0;border-bottom:1px solid #F0F2F6;font-weight:600;font-size:14px;display:flex;gap:10px;align-items:center}
li b{margin-left:auto;font-size:12px;font-weight:800}
.done b{color:#34A853}.wip b{color:#B07A00}
.ft{color:#9AA3B2;font-size:11.5px;font-weight:600;margin-top:22px}
</style></head><body><div class="card">
${cLogo ? `<img class="logo" src="${cLogo}" alt="${cBiz}">` : `<div class="biz">${cBiz}</div>`}
<h1>🏗️ Tu página web se está armando</h1>
<p class="sub">Nuestro equipo está poniendo los últimos detalles a tu página, tu valuador de casas y tu sistema de mensajes.</p>
<div class="bar"><div class="fill"></div></div>
<p class="eta">Lista en aproximadamente 10 días</p>
<ul>
<li class="done">🎨 Diseño y tu marca <b>✓ Listo</b></li>
<li class="done">🏡 Valuador de casas <b>✓ Listo</b></li>
<li class="wip">📞 Registro de tu número <b>En proceso</b></li>
<li class="wip">🚀 Publicación de tu página <b>En proceso</b></li>
</ul>
<p class="ft">⚡ Hecho con Quick Comp</p>
</div></body></html>`);
  }
  // Staff preview carries testMode into the chat bubble: same bot, same
  // wording, but no real lead and no push to the real agent.
  res.send(renderSite({ ...siteDataOf(c), testMode: preview }));
});
// call so the client picks their look). ?embed=1 hides the demo chrome.
app.get("/plantilla/:n", (req, res) => {
  const n = ["1", "2", "3"].includes(req.params.n) ? req.params.n : "1";
  const embed = req.query.embed != null;
  // each template previews in its own signature color so the personalities
  // read instantly; every template repaints to the client's brand color
  const SIG = { 1: "#B30F24", 2: "#E8540C", 3: "#1B6FB8" };
  res.send(renderSite({
    slug: "alto-demo",
    lang: req.query.lang === "en" ? "en" : "es",
    biz: "Casa Bella Realty",
    phone: "9565550100",
    logo: null,
    template: n,
    color: req.query.color && /^#?[a-f0-9]{6}$/i.test(req.query.color) ? (req.query.color.startsWith("#") ? req.query.color : "#" + req.query.color) : SIG[n],
    city: "Tu Ciudad, TX",
    years: 15,
    license: "00000",
    about: "Empezamos hace 15 años ayudando a familias a vender y comprar su casa en la región. Hoy seguimos con la misma idea: precio honesto, ventas reales y trato de familia — cada cliente como si fuera el único.",
  }, embed ? {} : { ribbon: `PLANTILLA ${n} — imagina TU logo y TU nombre aquí.`, backAlto: true }));
});

/* ── Template chooser (/plantillas) — shown on the onboarding call ── */
app.get("/plantillas", (req, res) => {
  const T = [
    ["1", "El Clásico", "Elegante y premium — la opción cara.", "#B30F24"],
    ["2", "El Fuerte", "Energía y músculo — marca joven.", "#E8540C"],
    ["3", "El Limpio", "Suave y de confianza — el vecino honesto.", "#1B6FB8"],
  ];
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick Comp · Elige tu plantilla</title><link rel="icon" href="/icon-192.png"><style>
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0}
body{background:#101B30;color:#fff;padding:34px 20px 60px}
h1{text-align:center;font-size:clamp(24px,4.5vw,36px);font-weight:800}
h1 em{color:#C9973A;font-style:normal}
.sub{text-align:center;color:#9DA8C4;font-weight:600;font-size:14px;margin:10px auto 6px;max-width:520px;line-height:1.6}
.colorbar{display:flex;gap:10px;justify-content:center;align-items:center;margin:18px 0 30px;flex-wrap:wrap}
.colorbar label{font-weight:700;font-size:13px;color:#C9D2E5}
.colorbar input[type=color]{width:46px;height:38px;border:none;border-radius:10px;background:none;cursor:pointer}
.colorbar button{background:#C9973A;color:#101B30;border:none;border-radius:10px;padding:10px 18px;font-weight:800;cursor:pointer}
.grid{display:flex;gap:34px;justify-content:center;flex-wrap:wrap}
.card{text-align:center}
.phone{background:#0B1226;border:9px solid #1E2A45;border-radius:40px;padding:10px;box-shadow:0 26px 70px rgba(0,0,0,.5)}
.scr{width:252px;height:512px;overflow:hidden;border-radius:26px}
.scr iframe{width:390px;height:792px;border:0;transform:scale(.6462);transform-origin:0 0;background:#fff}
.nm{font-weight:800;font-size:17px;margin-top:16px}
.nm span{color:#C9973A}
.ds{color:#9DA8C4;font-weight:600;font-size:13px;margin-top:4px}
.open{display:inline-block;margin-top:12px;background:#fff;color:#101B30;text-decoration:none;font-weight:800;font-size:13px;padding:10px 20px;border-radius:99px}
</style></head><body>
<h1>¿Cuál se siente <em>más tú</em>?</h1>
<p class="sub">Tres estilos, el mismo motor: tu logo, tus colores y el valuador de casas adentro. Prueba tu color de marca — las tres se pintan al instante.</p>
<div class="colorbar">
  <label>🎨 Tu color:</label>
  <input type="color" id="col" value="#B30F24">
  <button onclick="paint()">Pintar las 3</button>
  <button onclick="reset()" style="background:#1E2A45;color:#fff">Colores originales</button>
</div>
<div class="grid">
${T.map(([n, nm, ds]) => `
  <div class="card">
    <div class="phone"><div class="scr"><iframe id="f${n}" src="/plantilla/${n}?embed=1" title="${nm}"></iframe></div></div>
    <p class="nm">${n} · <span>${nm}</span></p>
    <p class="ds">${ds}</p>
    <a class="open" id="o${n}" href="/plantilla/${n}" target="_blank">Abrir completa →</a>
  </div>`).join("")}
</div>
<script>
function paint(){
  var c = document.getElementById('col').value.replace('#','');
  [1,2,3].forEach(function(n){
    document.getElementById('f'+n).src = '/plantilla/'+n+'?embed=1&color='+c;
    document.getElementById('o'+n).href = '/plantilla/'+n+'?color='+c;
  });
}
function reset(){
  [1,2,3].forEach(function(n){
    document.getElementById('f'+n).src = '/plantilla/'+n+'?embed=1';
    document.getElementById('o'+n).href = '/plantilla/'+n;
  });
}
</script>
</body></html>`);
});

/* Realtors don't edit their own website — they ask, and the request lands
 * in the CS queue as a ticket (human or ✨AI resolves it). ALTO pattern. */
app.post("/api/change-request", async (req, res) => {
  const c = await auth(req);
  if (!c) return res.status(401).json({ error: "no session" });
  if (overQuota(`chreq:${c.id}`, 5)) return res.status(429).json({ error: "quota" });
  const text = String(req.body?.text || "").trim().slice(0, 600);
  if (!text) return res.status(400).json({ error: "text required" });
  // The realtor tags what it's about on the phone — the ticket lands in /cs
  // pre-sorted, with the right suggestion and the right buttons.
  const TITLES = {
    web: "🌐 Cliente pide cambio de su PÁGINA",
    widget: "🏡 Cliente pide cambio del VALUADOR",
    queja: "😕 QUEJA del cliente",
    any: "🙋 Solicitud del cliente",
  };
  const kind = TITLES[String(req.body?.kind || "")] ? String(req.body.kind) : "any";
  const id = await db.addTask({ slug: c.slug, title: TITLES[kind], note: text });
  res.json({ ok: true, id });
});

// The realtor's own ticket history — ONLY tickets they sent from the app
// (kind-prefixed titles), never internal CS tasks about them.
app.get("/api/my-requests", async (req, res) => {
  const c = await auth(req);
  if (!c) return res.status(401).json({ error: "no session" });
  const mine = (await db.listTasks(500))
    .filter((t) => t.slug === c.slug && /^(🌐 Cliente|🏡 Cliente|😕|🙋)/.test(String(t.title || "")))
    .slice(0, 20)
    .map((t) => ({ id: t.id, note: String(t.note || "").slice(0, 200), status: t.status, at: t.created_at }));
  res.json({ tickets: mine });
});

/* ── Customer-service command center (/cs) ──
 * Tasks + a client directory with one-click edit (the onboarding wizard).
 * Gated by CS_KEY (admin key also works). No money/MRR shown. */
app.post("/api/cs/task", async (req, res) => {
  if (!csOk(req)) return res.status(403).json({ error: "no auth" });
  const title = String(req.body?.title || "").slice(0, 160).trim();
  if (!title) return res.status(400).json({ error: "falta título" });
  const slug = String(req.body?.slug || "").slice(0, 80);
  const note = String(req.body?.note || "").slice(0, 600);
  const id = await db.addTask({ slug, title, note });
  res.json({ ok: true, id });
});
app.post("/api/cs/task/:id", async (req, res) => {
  if (!csOk(req)) return res.status(403).json({ error: "no auth" });
  const id = String(req.params.id);
  if (req.body?.delete) { await db.deleteTask(id); return res.json({ ok: true }); }
  const status = ["open", "doing", "done"].includes(req.body?.status) ? req.body.status : "open";
  await db.setTaskStatus(id, status);
  res.json({ ok: true });
});

// Plain-language names for the only fields the AI is allowed to touch —
// shown to the CS agent so "✨ Arreglar en automático" is never a black box.
const SITEFIX_CAPS = { hero: 160, tagline: 300, about: 1400, warranty: 120, area: 200, city: 80, diff: 300 };
const SITEFIX_LABELS = {
  hero: "Título grande de la página",
  tagline: "Frase debajo del título",
  about: "Historia / quiénes somos",
  warranty: "Promesa al cliente (se muestra en la página)",
  area: "Zonas que cubre",
  city: "Ciudad principal",
  diff: "Qué lo hace diferente",
};

/* ✨ Step 1 — PREVIEW: the AI proposes a patch to ONLY the whitelisted site
 * fields. Nothing is saved and the ticket isn't touched — the agent sees
 * exactly what would change, in plain language, before deciding. Anything
 * outside the whitelist (photos, domain, template, billing) comes back
 * handled=false with why, so a human takes over. */
app.post("/api/cs/aifix", async (req, res) => {
  if (!csOk(req)) return res.status(403).json({ error: "no auth" });
  const id = String(req.body?.id || "");
  const t = (await db.listTasks(500)).find((x) => String(x.id) === id);
  if (!t || !t.slug || !t.note) return res.status(400).json({ error: "la tarea necesita cliente y detalle" });
  if (t.title.startsWith("😕")) return res.json({ ok: true, handled: false, summary: "Es una queja — se arregla hablando con el cliente (WhatsApp o llamada), no editando la página." });
  const c = await db.getContractorBySlug(t.slug);
  if (!c) return res.status(404).json({ error: "cliente no encontrado" });
  if (!aiLive) return res.status(503).json({ error: "IA no configurada en el servidor" });
  const st = c.data?.site || {};
  const cur = { hero: st.hero || "", tagline: st.tagline || "", about: st.about || "", warranty: st.warranty || "", area: st.area || "", city: st.city || "", diff: st.diff || "" };
  const kindHint = t.title.startsWith("🌐") ? " El cliente marcó que la solicitud es sobre su PÁGINA web: revisa hero, tagline, about, warranty, area, city, diff."
    : t.title.startsWith("🏡") ? " El cliente marcó que es sobre su VALUADOR (el widget de valor de casa): el widget no tiene textos editables aparte — si pide otra cosa (colores, dominio, funcionamiento), handled=false para que lo vea un especialista."
    : "";
  try {
    const raw = await aiChat({
      maxTokens: 600,
      system: `Eres el editor del sitio web de un agente de bienes raíces. Te doy la SOLICITUD del cliente y sus campos editables actuales. Responde SOLO con JSON: {"handled": true/false, "summary": "en una frase, en español simple, qué cambiarías y por qué (o por qué debe hacerlo un especialista)", "patch": {…solo los campos que cambias, entre: hero, tagline, about, warranty, area, city, diff}}. Reglas: hero máximo 8 palabras. No inventes datos que el cliente no dio. Cumple Fair Housing: nunca escribas afirmaciones sobre la calidad de vecindarios, escuelas o tipos de personas. Si piden algo fuera de esos campos (fotos, dominio, plantilla, precios, facturación, logo, el valuador), handled=false.${kindHint}`,
      messages: [{ role: "user", content: `SOLICITUD DEL CLIENTE: ${String(t.note).slice(0, 600)}\n\nCAMPOS ACTUALES: ${JSON.stringify(cur)}` }],
    });
    const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
    const patch = {};
    for (const k of Object.keys(SITEFIX_CAPS)) if (j.patch && typeof j.patch[k] === "string") patch[k] = j.patch[k].slice(0, SITEFIX_CAPS[k]);
    const handled = !!j.handled && Object.keys(patch).length > 0;
    const changes = Object.keys(patch).map((k) => ({ key: k, label: SITEFIX_LABELS[k] || k, before: cur[k] || "(vacío)", after: patch[k] || "(vacío)" }));
    res.json({ ok: true, handled, summary: String(j.summary || "").slice(0, 300), changes, patch });
  } catch (e) {
    console.error("cs aifix preview failed:", e.message);
    res.status(502).json({ error: "la IA no pudo — hazlo manual con ✏️ Editar" });
  }
});

/* ✨ Step 2 — APPLY: the agent reviewed the exact patch from the preview
 * above and approved it. We re-validate it server-side (whitelist + length
 * caps) rather than trusting the client blindly, then save and close the
 * ticket. No second AI call — what you saw is exactly what gets written. */
app.post("/api/cs/aifix/apply", async (req, res) => {
  if (!csOk(req)) return res.status(403).json({ error: "no auth" });
  const id = String(req.body?.id || "");
  const t = (await db.listTasks(500)).find((x) => String(x.id) === id);
  if (!t || !t.slug) return res.status(400).json({ error: "tarea no encontrada" });
  const c = await db.getContractorBySlug(t.slug);
  if (!c) return res.status(404).json({ error: "cliente no encontrado" });
  const patch = {};
  const given = req.body?.patch;
  for (const k of Object.keys(SITEFIX_CAPS)) if (given && typeof given[k] === "string") patch[k] = given[k].slice(0, SITEFIX_CAPS[k]);
  if (!Object.keys(patch).length) return res.status(400).json({ error: "nada que aplicar" });
  await db.saveContractorData(c.id, { ...(c.data || {}), site: { ...(c.data?.site || {}), ...patch } });
  await db.setTaskStatus(id, "done");
  res.json({ ok: true });
});

/* 🔔 "Avisarle": tell the realtor their request is done — INSIDE their own
 * app (a real push notification via their lead-alert subscription), not a
 * WhatsApp text that leaves our product. Falls back to WhatsApp only for
 * realtors who never enabled push. */
app.post("/api/cs/notify", async (req, res) => {
  if (!csOk(req)) return res.status(403).json({ error: "no auth" });
  const id = String(req.body?.id || "");
  const t = (await db.listTasks(500)).find((x) => String(x.id) === id);
  if (!t || !t.slug) return res.status(400).json({ error: "tarea no encontrada" });
  const c = await db.getContractorBySlug(t.slug);
  if (!c) return res.status(404).json({ error: "cliente no encontrado" });
  const subs = Array.isArray(c.data?.push) ? c.data.push : [];
  if (pushLive && subs.length) {
    const es = (c.data?.profile?.lang || "") === "es";
    const payload = JSON.stringify({
      title: es ? "✅ Tu solicitud ya está lista" : "✅ Your request is done",
      body: String(t.note || (es ? "Hicimos el cambio que pediste" : "We made the change you asked for")).slice(0, 140),
      tag: "ticket-" + id,
      url: "/",
    });
    let sent = 0;
    await Promise.all(subs.map((s) => webpush.sendNotification(s, payload).then(() => { sent++; }).catch(() => {})));
    if (sent) return res.json({ ok: true, pushed: true });
  }
  // No push device on file — hand CS a WhatsApp link as the fallback so the
  // client still hears back, just not through the in-app channel.
  const phone = String(c.data?.profile?.phone || c.phone || "").replace(/\D/g, "").replace(/^1/, "");
  const wa = phone.length === 10 ? `https://wa.me/1${phone}?text=${encodeURIComponent("¡Listo! Ya quedó el cambio que pediste 🙌 Revísalo y me dices.")}` : null;
  res.json({ ok: true, pushed: false, waFallback: wa, error: wa ? undefined : "Sin teléfono ni notificaciones activas para este cliente" });
});

app.get("/cs", async (req, res) => {
  if (!CS_KEY && !ADMIN_KEY) return res.status(503).send("Set CS_KEY or ADMIN_KEY.");
  if (req.query.logout != null) { clearKeyCookie(res, "alto_cs"); return res.redirect("/cs"); }
  const qk = req.query.key;
  if (qk && ((CS_KEY && safeEq(qk, CS_KEY)) || (ADMIN_KEY && safeEq(qk, ADMIN_KEY)))) { setKeyCookie(res, "alto_cs", qk); return res.redirect("/cs"); }
  if (!csOk(req)) return res.status(qk ? 403 : 401).send(loginPage("Servicio al cliente", "/cs", !!qk));
  const ck = reqCookies(req);
  const K = encodeURIComponent(String(ck.alto_cs || ck.alto_admin || qk || ""));
  const esc = (x) => String(x || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const [list, stats, tasks, devCounts] = await Promise.all([
    db.listContractors(), db.leadStats().catch(() => []), db.listTasks().catch(() => []), db.sessionCounts().catch(() => ({})),
  ]);
  const BUILTIN = new Set(["alto-demo", "alto-ventas"]);
  const clients = list.filter((c) => !BUILTIN.has(c.slug));
  const statOf = (id) => stats.find((x) => String(x.contractor_id) === String(id)) || { total: 0, last7: 0 };
  const nameOf = (slug) => (clients.find((c) => c.slug === slug)?.name) || slug || "general";
  const openCount = tasks.filter((t) => t.status !== "done").length;
  const leads7 = stats.reduce((a, x) => a + Number(x.last7 || 0), 0);
  const stLabel = { open: "nueva", doing: "en proceso", done: "hecha" };
  const waOf = (ph) => { const d = String(ph || "").replace(/\D/g, "").replace(/^1/, ""); return d.length === 10 ? `https://wa.me/1${d}` : null; };
  const phoneOf = (c) => c.data?.profile?.phone || c.phone || "";
  // Auto worklist: the rep just works this top to bottom — no judgment needed.
  const attention = [];
  for (const c of clients) {
    const s = c.data?.site || {}, d = c.data || {};
    const dev = devCounts[String(c.id)] || 0;
    if (d.status === "paused" || d.payStatus === "canceled") attention.push({ slug: c.slug, name: c.name, tag: "pausada", icon: "⏸", msg: "Cuenta pausada — confirma si quiere reactivar", c });
    else if (d.payStatus === "failed") attention.push({ slug: c.slug, name: c.name, tag: "pago falló", icon: "💳", msg: "Falló su pago — recuérdale actualizar su tarjeta", c });
    else if (d.payStatus === "pending") attention.push({ slug: c.slug, name: c.name, tag: "esperando pago", icon: "⏳", msg: "Aún no activa — se activa sola al pagar", c });
    else if (!(s.template || s.about)) attention.push({ slug: c.slug, name: c.name, tag: "falta onboarding", icon: "🆕", msg: "Cliente nuevo sin página — haz su onboarding", c });
    else if (!s.published) attention.push({ slug: c.slug, name: c.name, tag: "sin publicar", icon: "🏗️", msg: "Su página está lista pero no publicada — revísala y publícala", c });
    if (dev >= 4) attention.push({ slug: c.slug, name: c.name, tag: "link compartido", icon: "📱", msg: `${dev} dispositivos — ofrécele cuentas para su equipo`, c });
  }
  // Quick-edit: the raw data behind every client's onboarding, embedded so the
  // rep can edit ANY text field in one place. Saving posts to
  // /api/onboarding/save, which merges and keeps logo/photos/publish untouched.
  const qeData = {};
  for (const c of clients) {
    const s = c.data?.site || {}, p = c.data?.profile || {};
    qeData[c.slug] = {
      name: c.name, biz: p.biz || "", phone: p.phone || c.phone || "", license: p.license || "",
      template: s.template || "1", color: s.color || "#15244C", city: s.city || "", area: s.area || "",
      years: s.years || "", services: (Array.isArray(s.services) ? s.services : []).join(", "),
      warranty: s.warranty || "", diff: s.diff || "", tagline: s.tagline || "", hero: s.hero || "",
      about: s.about || "", published: !!s.published,
    };
  }
  // Tasks: pending is the morning worklist; done is history, tucked away.
  const pendTasks = tasks.filter((t) => t.status !== "done");
  const doneTasks = tasks.filter((t) => t.status === "done");
  const taskRow = (t, badge) => {
    // Client-request tickets arrive pre-tagged from the app; each kind gets
    // its own one-line playbook and only the buttons that make sense.
    const kind = t.title.startsWith("🌐 Cliente") ? "web" : t.title.startsWith("🏡 Cliente") ? "widget" : t.title.startsWith("😕") ? "queja" : t.title.startsWith("🙋") ? "any" : "";
    const cli = kind && t.slug ? clients.find((x) => x.slug === t.slug) : null;
    const cwa = cli ? waOf(phoneOf(cli)) : "";
    const hint = kind === "web" ? "💡 Textos, zonas o datos → toca ✨ y revisa el cambio antes de aplicarlo. Fotos, plantilla o dominio → ✏️ Onboarding."
      : kind === "widget" ? "💡 El valuador no tiene textos editables — lee qué pide: si es del funcionamiento o los valores, pásalo al admin; si en realidad es de su página, toca ✨."
      : kind === "queja" ? "💡 Una queja se arregla hablando — mándale WhatsApp o llámalo hoy. Nada de botones."
      : kind === "any" ? "💡 Léelo: si es de su página, toca ✨ y revisa antes de aplicar. Si es otra cosa, hazlo con ⚡ Editar datos u ✏️ Onboarding."
      : "";
    return `<details class="task ${t.status}">
    <summary class="attsum">
      <span class="an${t.status === "done" ? " dn" : ""}">${badge}</span>
      <div class="am"><b>${esc(t.title)}</b><span class="x">${t.slug ? esc(nameOf(t.slug)) : "general"}${t.note ? ` — ${esc(String(t.note).slice(0, 90))}${String(t.note).length > 90 ? "…" : ""}` : ""}</span></div>
      <span class="tstat ${t.status}">${stLabel[t.status] || t.status}</span>
      ${t.status !== "done"
        ? `<button class="tbtn go" onclick="event.preventDefault();tStat('${t.id}','done')">✓ Hecho</button>`
        : `<button class="tbtn" onclick="event.preventDefault();tStat('${t.id}','open')">↩ Reabrir</button>`}
      <span class="achev">▾</span>
    </summary>
    <div class="abody">
      ${t.note ? `<div class="asec"><b>Lo que pidió</b><p class="qnote">${esc(t.note)}</p></div>` : ""}
      ${hint && t.status !== "done" ? `<p class="qhint">${hint}</p>` : ""}
      <div class="aacts">
        ${t.status !== "done" && t.slug && t.note && kind !== "queja" ? `<button class="tbtn" style="border-color:#C9973A" onclick="aiFix('${t.id}',this)">${kind ? "✨ Ver arreglo automático" : "✨ IA"}</button>` : ""}
        ${t.slug ? `<button class="tbtn" onclick="qeOpen('${esc(t.slug)}')">⚡ Editar datos</button>` : ""}
        ${cwa && t.status !== "done" ? `<a class="wa" href="${cwa}" target="_blank" style="padding:6px 12px;border-radius:9px;font-size:12.5px">💬 WhatsApp</a>` : ""}
        ${kind && kind !== "queja" && t.slug ? `<button class="tbtn" onclick="notifyClient('${t.id}',this)">🔔 Avisarle</button>` : ""}
        ${t.status === "open" && !kind ? `<button class="tbtn" onclick="tStat('${t.id}','doing')">▶ Empezar</button>` : ""}
        ${t.slug ? `<a class="tbtn" href="/onboarding?key=${K}&slug=${esc(t.slug)}">✏️ Onboarding</a><a class="tbtn" href="/site/${esc(t.slug)}" target="_blank">🌐 Página</a><a class="tbtn" href="/w/${esc(t.slug)}" target="_blank">🏡 Valuador</a>` : ""}
        <button class="tbtn del" onclick="tDel('${t.id}')">🗑 Borrar</button>
      </div>
      <div class="tpreview" id="pv-${t.id}" style="display:none"></div>
    </div>
  </details>`;
  };
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick Comp · Servicio</title><link rel="icon" href="/icon-192.png"><style>
*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body{background:#F5F6F8;color:#0B1220;letter-spacing:-0.011em}
::selection{background:rgba(201,151,58,.35)}
.appheader{position:sticky;top:0;z-index:30;background:rgba(16,27,48,.9);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);color:#fff;padding:15px 24px;display:flex;align-items:center;gap:13px;border-bottom:1px solid rgba(255,255,255,.07)}
.appheader img{height:30px;background:#fff;border-radius:9px;padding:4px 6px}
.appheader b{font-size:16px;font-weight:700;letter-spacing:-0.02em}.appheader b em{color:#C9973A;font-style:normal}
.appheader .right{margin-left:auto;display:flex;gap:8px}.appheader .right a{color:#cdd5e5;text-decoration:none;font-weight:600;font-size:13px;border-radius:99px;padding:7px 14px}
.wrap{max-width:1120px;margin:0 auto;padding:24px 22px 64px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:18px}
.card{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:18px;padding:18px 20px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 8px 22px rgba(16,27,48,.045)}
.card .v{font-size:28px;font-weight:700;letter-spacing:-0.035em}.card .l{font-size:11px;font-weight:700;color:#9097A3;letter-spacing:.5px;text-transform:uppercase;margin-top:6px}
.card.gold{background:linear-gradient(155deg,#16243f,#0d1729);border:none}.card.gold .v{color:#C9973A}.card.gold .l{color:#9DA8C4}
.card.cardred .v{color:#C5221F}
.panel{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:20px;padding:22px 24px;margin-bottom:18px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 10px 26px rgba(16,27,48,.05)}
.panel h2{font-size:15px;font-weight:700;margin-bottom:14px}
.tform{display:grid;gap:8px;grid-template-columns:1fr;margin-bottom:16px}
@media(min-width:760px){.tform{grid-template-columns:200px 1fr auto}}
.tform select,.tform input{font-family:inherit;padding:11px 13px;border-radius:11px;border:1px solid #E4E7EC;font-size:14px;font-weight:500;outline:none;background:#fff}
.tform select:focus,.tform input:focus{border-color:#C9973A;box-shadow:0 0 0 3px rgba(201,151,58,.18)}
.tform button{background:#C9973A;color:#101B30;border:none;border-radius:11px;padding:11px 20px;font-weight:800;cursor:pointer;white-space:nowrap}
.task{border-bottom:1px solid #F2F4F7}
.task:last-of-type{border-bottom:none}
.task.done .am b{text-decoration:line-through;color:#9097A3}
.task.done{opacity:.75}
.an.dn{background:#E7F7ED;color:#10803C}
.qnote{font-size:13px;font-weight:600;color:#3A4250;background:#fff;border:1px solid #E7EAF0;border-radius:10px;padding:9px 12px;line-height:1.6;margin:0}
.qhint{color:#9A6E00;background:#FFF8E1;border-radius:10px;padding:8px 11px;font-size:12.5px;font-weight:600;margin:10px 0 0;line-height:1.6}
.qe .qegrid{display:grid;gap:12px;grid-template-columns:1fr}
@media(min-width:820px){.qe .qegrid{grid-template-columns:1fr 1fr}}
.qe label{display:block}
.qe .qel{display:block;font-size:11px;color:#8A94A8;text-transform:uppercase;letter-spacing:.5px;font-weight:800;margin-bottom:5px}
.qe input,.qe textarea,.qe select{width:100%;font-family:inherit;padding:10px 12px;border-radius:10px;border:1px solid #E4E7EC;font-size:13.5px;font-weight:600;color:#16202E;outline:none;background:#fff}
.qe input:focus,.qe textarea:focus{border-color:#C9973A;box-shadow:0 0 0 3px rgba(201,151,58,.16)}
.qe textarea{resize:vertical}
.qe .full{grid-column:1/-1}
.qemsg{font-size:13px;font-weight:700;color:#10803C}
.tdone{margin-top:14px;border-top:1px solid #F2F4F7}
.tdsum{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:12px 4px;color:#8A94A8;font-weight:700;font-size:13px}
.tdsum::-webkit-details-marker{display:none}
.tdsum:hover{color:#5A6478}
.tdone[open] .tdsum .achev{transform:rotate(180deg)}
.tstat{border-radius:99px;padding:3px 10px;font-size:11px;font-weight:800;white-space:nowrap}
.tstat.open{background:#F7EFD8;color:#946400}.tstat.doing{background:#E5EFFE;color:#21438A}.tstat.done{background:#E7F7ED;color:#10803C}
.tbtn{border:1px solid #E4E7EC;background:#fff;border-radius:9px;padding:6px 11px;font-weight:700;font-size:12px;cursor:pointer;text-decoration:none;color:#101B30}
.tbtn.go{background:#101B30;color:#fff;border:none}.tbtn.del{color:#C5221F;border-color:#F3B4B0}
.tpreview{width:100%;order:99}
.pvbox{background:#FFFBEF;border:1.5px solid #C9973A;border-radius:14px;padding:14px 16px;margin-top:8px}
.pvbox.pvno{background:#F4F6FA;border-color:#E4E7EC}
.pvsum{font-weight:700;font-size:13.5px;color:#101B30;margin-bottom:10px;line-height:1.5}
.pvrow{border-top:1px solid #F0E4B8;padding:9px 0}
.pvrow:first-of-type{border-top:none}
.pvrow b{display:block;font-size:12.5px;color:#8A6D00;margin-bottom:4px}
.pvold{font-size:12.5px;color:#9097A3;text-decoration:line-through;margin-bottom:2px;word-break:break-word}
.pvnew{font-size:13px;color:#101B30;font-weight:600;word-break:break-word}
.pvbtns{display:flex;gap:8px;margin-top:12px}
.pvbtns .tbtn{font-size:13px;padding:8px 16px}
.search{width:100%;font-family:inherit;padding:11px 14px;border-radius:11px;border:1px solid #E4E7EC;font-size:14px;font-weight:500;outline:none;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#9097A3;font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;font-weight:700;padding:9px 8px;border-bottom:1px solid #EEF0F4}
td{padding:11px 8px;border-bottom:1px solid #F2F4F7;font-weight:600;vertical-align:middle}
td a{color:#B07A00;font-weight:700;text-decoration:none}
.edit{background:#C9973A;color:#101B30 !important;border-radius:9px;padding:6px 12px;font-weight:800;font-size:12.5px}
.empty{color:#9097A3;font-weight:600;padding:14px 0}
.att{border-bottom:1px solid #F2F4F7}
.att:last-child{border-bottom:none}
.attsum{display:flex;gap:11px;align-items:center;padding:13px 4px;cursor:pointer;list-style:none;flex-wrap:wrap}
.attsum::-webkit-details-marker{display:none}
.attsum:hover{background:#FBFBFD}
.an{width:24px;height:24px;border-radius:8px;background:#101B30;color:#fff;font-weight:800;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.achev{color:#9097A3;font-size:12px;flex-shrink:0;transition:transform .15s}
.att[open] .achev,.task[open] .achev{transform:rotate(180deg)}
.abody{background:#F7F9FC;border:1px solid #EDF0F5;border-radius:16px;padding:16px 18px 18px;margin:2px 4px 16px 39px}
.agrid{display:grid;gap:16px}
@media(min-width:920px){.agrid{grid-template-columns:1fr 1.25fr}}
.asec>b{display:block;font-size:11px;color:#8A94A8;text-transform:uppercase;letter-spacing:.6px;font-weight:800;margin-bottom:8px}
.asec ol{margin:0 0 0 18px;color:#3A4250;font-size:13px;font-weight:500;line-height:1.75}
.ckbar{display:inline-block;width:84px;height:5px;background:#E9EDF3;border-radius:99px;margin-left:8px;vertical-align:2px}
.ckbar i{display:block;height:100%;background:#C9973A;border-radius:99px}
.ck{display:flex;flex-wrap:wrap;gap:7px}
.ck span{font-size:12px;font-weight:700;border-radius:99px;padding:5px 11px;white-space:nowrap}
.ck .y{background:#E7F7ED;color:#10803C}
.ck .n{background:#fff;border:1px solid #EAD3D2;color:#A04441}
.ck .o{background:transparent;border:1px dashed #D5DAE3;color:#9097A3}
.ck .i{background:#fff;border:1px solid #E7EAF0;color:#3A4250}
.asec+.asec,.agrid+.asec{margin-top:15px}
.aacts{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:14px;border-top:1px solid #EDF0F5}
.aacts .tbtn{background:#fff}
.aacts .tbtn.go{background:#101B30}
@media(max-width:600px){.abody{margin-left:4px}}
.att .ai{font-size:20px;flex-shrink:0}
.am{flex:1;min-width:190px}
.am b{font-size:14px}.am .x{display:block;color:#67718A;font-size:12.5px;font-weight:500;margin-top:1px}
.att .atag{border-radius:99px;padding:3px 10px;font-size:11px;font-weight:800;background:#FDECEC;color:#C5221F;white-space:nowrap}
.qchips{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 12px}
.qchip{border:1px dashed #C9CDD6;background:#FBFBFD;border-radius:99px;padding:7px 13px;font-size:12.5px;font-weight:700;color:#475067;cursor:pointer}
.qchip:hover{border-color:#C9973A;background:#FFFBEF}
.wa{background:#25D366;color:#fff !important;border-radius:8px;padding:5px 11px;font-weight:800;font-size:12px;text-decoration:none;white-space:nowrap}
.slug2{color:#9097A3;font-size:11.5px}
.guide details{border:1px solid #EEF0F4;border-radius:12px;margin:8px 0;background:#FBFBFD}
.guide summary{cursor:pointer;padding:12px 14px;font-weight:700;font-size:13.5px;list-style:none}
.guide summary::-webkit-details-marker{display:none}
.guide summary::before{content:"▸ ";color:#B07A00}
.guide details[open] summary::before{content:"▾ "}
.guide .gb{padding:0 14px 13px;color:#475067;font-size:12.5px;font-weight:500;line-height:1.7}
.guide .gb ol{margin:6px 0 0 18px}.guide .gb li{margin:3px 0}
/* Collapsible panels — closed by default so nothing sits in the way. */
summary.psum{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;margin:0}
summary.psum::-webkit-details-marker{display:none}
summary.psum::after{content:"▾";margin-left:auto;color:#9097A3;font-size:13px;transition:transform .15s}
details[open]>summary.psum::after{transform:rotate(180deg)}
.pbody{margin-top:16px}
.guide summary.psum::before,.guide details[open] summary.psum::before{content:none}
</style></head><body>
<div class="appheader">
  <img src="/brand-logo.png" alt=""><b>QUICK <em>COMP</em> · Servicio al cliente</b>
  <div class="right"><a href="/cs?logout">salir</a></div>
</div>
<div class="wrap">
<div class="cards">
  <div class="card ${attention.length ? "cardred" : ""}"><div class="v">${attention.length}</div><div class="l">Necesita atención</div></div>
  <div class="card gold"><div class="v">${openCount}</div><div class="l">Tareas pendientes</div></div>
  <div class="card"><div class="v">${clients.length}</div><div class="l">Agentes</div></div>
  <div class="card"><div class="v">${leads7}</div><div class="l">Leads · 7 días</div></div>
</div>

${attention.length ? `<div class="panel"><details open><summary class="psum"><h2 style="margin:0">🚨 Necesita atención (${attention.length}) <span style="color:#9097A3;font-weight:600;font-size:13px">— trabaja de arriba a abajo; toca una para ver TODO lo del agente</span></h2></summary>
  <div class="pbody">
  ${attention.map((a, ai) => {
    const wa = waOf(phoneOf(a.c));
    const editUrl = `/onboarding?key=${K}&slug=${esc(a.slug)}`;
    const s = a.c.data?.site || {}, d = a.c.data || {};
    const devN = devCounts[String(a.c.id)] || 0;
    const nPhotos = Array.isArray(s.photos) ? s.photos.length : 0;
    const nServ = Array.isArray(s.services) ? s.services.length : 0;
    // The FULL state of the client, not just what's broken — ✓ done,
    // ✗ missing (blocks a good page), ○ optional. CS fixes any ✗ via onboarding.
    const check = [
      ["Logo / foto", !!d.profile?.logo],
      ["Teléfono", !!phoneOf(a.c)],
      ["Ciudad / área", !!(s.city || s.area)],
      ["Plantilla elegida", !!s.template],
      ["Textos (titular e historia)", !!(s.hero && s.about)],
      [`Fotos (${nPhotos}/8)`, nPhotos > 0],
      [`Servicios (${nServ})`, nServ > 0],
      ["Página publicada", !!s.published],
      ["Dominio propio", !!s.domain, true],
    ];
    const okCount = check.filter((x) => x[1]).length;
    const STEPS = {
      "pausada": ["Confírmale por WhatsApp si quiere seguir con el servicio.", "Si quiere volver: pídele al admin que la reactive en /admin.", "Si canceló de plano: no borres nada — sus datos quedan guardados por si regresa."],
      "pago falló": ["Avísale por WhatsApp: su tarjeta no pasó.", "Que actualice su tarjeta con el mismo link de pago de su plan (te lo pasa el closer o el admin).", "En cuanto pague, su cuenta se reactiva sola — no hay que tocar nada."],
      "esperando pago": ["Todavía no paga — su cuenta se activa sola al pagar; no hay nada técnico que hacer.", "¿Dice que ya pagó por Zelle o efectivo? El admin la marca como pagada en /admin y listo.", "Si no responde en 2 días, mándale un recordatorio amable por WhatsApp."],
      "falta onboarding": ["Llama al agente y abre el onboarding (botón abajo) — se llena junto con él en ~20 min.", "El checklist de abajo te dice exactamente qué le falta.", "Al terminar, revisa el borrador y publica desde el mismo onboarding."],
      "sin publicar": ["Abre el borrador (botón abajo) y revisa que todo se vea bien.", "Lo que falte, corrígelo en el onboarding — guíate con el checklist de abajo.", "Cuando esté lista, publícala desde el onboarding."],
      "link compartido": ["Su equipo entra con el mismo link — señal de que la app les gusta 💪.", "Ofrécele cuentas para su equipo (el admin las crea).", "No es urgente: es oportunidad, no problema."],
    };
    return `<details class="att">
    <summary class="attsum">
      <span class="an">${ai + 1}</span>
      <span class="ai">${a.icon}</span>
      <div class="am"><b>${esc(a.name)}</b><span class="x">${a.msg}</span></div>
      <span class="atag">${a.tag}</span>
      <span class="achev">▾</span>
    </summary>
    <div class="abody">
      <div class="agrid">
      <div class="asec"><b>Qué hacer — ${a.tag}</b><ol>${(STEPS[a.tag] || []).map((step) => `<li>${step}</li>`).join("")}</ol></div>
      <div class="asec"><b>Su página — ${okCount}/${check.length} listo<span class="ckbar"><i style="width:${Math.round((okCount / check.length) * 100)}%"></i></span></b>
        <div class="ck">${check.map(([label, ok, opt]) => `<span class="${ok ? "y" : opt ? "o" : "n"}">${ok ? "✓" : opt ? "○" : "✗"} ${label}${!ok && opt ? " · opcional" : ""}</span>`).join("")}</div>
      </div>
      </div>
      <div class="asec"><b>Datos del agente</b>
        <div class="ck">
          <span class="i">📦 ${esc(PLANS[planOf(a.c)].name)}</span>
          <span class="i">📞 ${esc(phoneOf(a.c)) || "sin teléfono"}</span>
          <span class="i">📱 ${devN} dispositivo${devN === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div class="aacts">
        <a class="tbtn go" href="${editUrl}">✏️ Abrir onboarding</a>
        <a class="tbtn" href="/site/${esc(a.slug)}?preview=1" target="_blank">👁️ Borrador</a>
        <a class="tbtn" href="/site/${esc(a.slug)}" target="_blank">🌐 Página</a>
        <a class="tbtn" href="/w/${esc(a.slug)}" target="_blank">🏡 Valuador</a>
        ${wa ? `<a class="wa" href="${wa}" target="_blank">💬 WhatsApp</a>` : ""}
        <button class="tbtn" onclick="mkTask('${esc(a.slug)}','${esc(a.tag)}: ')">＋ Crear tarea</button>
      </div>
    </div>
  </details>`; }).join("")}
  </div>
</details></div>` : `<div class="panel"><h2>🎉 Todo al día</h2><p class="empty" style="padding:4px 0">Nada necesita atención ahora mismo. Buen trabajo.</p></div>`}

<div class="panel"><details open><summary class="psum"><h2 style="margin:0">✅ Tareas${pendTasks.length ? ` (${pendTasks.length})` : ""} <span style="color:#9097A3;font-weight:600;font-size:13px">— tu trabajo del día</span></h2></summary>
  <div class="pbody">
  <div class="qchips">
    <span class="qchip" onclick="quick('Cambiar teléfono')">📞 Cambiar teléfono</span>
    <span class="qchip" onclick="quick('Subir fotos nuevas')">📷 Subir fotos</span>
    <span class="qchip" onclick="quick('Publicar la página')">🚀 Publicar página</span>
    <span class="qchip" onclick="quick('Conectar su dominio')">🌐 Conectar dominio</span>
    <span class="qchip" onclick="quick('Actualizar zonas / info')">💲 Actualizar info</span>
  </div>
  <div class="tform">
    <select id="t_slug"><option value="">— sin agente —</option>${clients.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join("")}</select>
    <input id="t_title" placeholder="¿Qué hay que hacer? (ej. cambiar teléfono, subir fotos)">
    <button onclick="addTask()">+ Agregar tarea</button>
  </div>
  ${pendTasks.length ? pendTasks.map((t, i) => taskRow(t, String(i + 1))).join("") : `<p class="empty">🎉 Nada pendiente — todo el trabajo del día está hecho.</p>`}
  ${doneTasks.length ? `<details class="tdone"><summary class="tdsum">📁 Hechas (${doneTasks.length}) — ver historial<span class="achev" style="margin-left:auto">▾</span></summary>
    <div>${doneTasks.map((t) => taskRow(t, "✓")).join("")}</div>
  </details>` : ""}
  </div>
</details></div>

<div class="panel qe"><details id="qepanel"><summary class="psum"><h2 style="margin:0">⚡ Edición rápida <span style="color:#9097A3;font-weight:600;font-size:13px">— cambia cualquier dato de un agente aquí mismo, sin pasar por el onboarding</span></h2></summary>
  <div class="pbody">
  <select id="qe_slug" onchange="qeShow()" style="max-width:340px;margin-bottom:4px"><option value="">— elige un agente —</option>${clients.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join("")}</select>
  <div id="qe_form" style="display:none">
    <div class="qegrid" style="margin-top:12px">
      <label><span class="qel">Nombre / inmobiliaria</span><input id="qe_biz"></label>
      <label><span class="qel">Teléfono</span><input id="qe_phone" inputmode="numeric"></label>
      <label><span class="qel">Ciudad</span><input id="qe_city"></label>
      <label><span class="qel">Zonas que cubre</span><input id="qe_area"></label>
      <label><span class="qel">Años de experiencia</span><input id="qe_years" inputmode="numeric"></label>
      <label><span class="qel">Licencia</span><input id="qe_license"></label>
      <label><span class="qel">Plantilla</span><select id="qe_template"><option value="1">1 · Elegante</option><option value="2">2 · Con energía</option><option value="3">3 · De confianza</option></select></label>
      <label><span class="qel">Color de la marca</span><input id="qe_color" placeholder="#15244C"></label>
      <label class="full"><span class="qel">Servicios (separados por coma)</span><input id="qe_services" placeholder="Compra, Venta, Rentas, Inversión"></label>
      <label><span class="qel">Titular de la página (hero)</span><input id="qe_hero"></label>
      <label><span class="qel">Frase de apoyo (tagline)</span><input id="qe_tagline"></label>
      <label class="full"><span class="qel">Su historia (about)</span><textarea id="qe_about" rows="3"></textarea></label>
      <label class="full"><span class="qel">Qué lo hace diferente</span><textarea id="qe_diff" rows="2"></textarea></label>
      <label><span class="qel">Promesa al cliente</span><input id="qe_warranty"></label>
    </div>
    <p style="color:#9AA3B2;font-size:12px;font-weight:600;margin:12px 0 0">📷 Logo y fotos se cambian en el onboarding (suben archivos). Todo lo demás se guarda desde aquí — y si su página ya está publicada, el cambio sale al instante.</p>
    <div class="aacts" style="border-top:none;padding-top:0">
      <button class="tbtn go" id="qe_save" onclick="qeSave(this)">💾 Guardar cambios</button>
      <a class="tbtn" id="qe_prev" href="#" target="_blank">👁️ Ver borrador</a>
      <a class="tbtn" id="qe_live" href="#" target="_blank">🌐 Ver página</a>
      <span class="qemsg" id="qe_msg"></span>
    </div>
  </div>
  </div>
</details></div>

<div class="panel"><details><summary class="psum"><h2 style="margin:0">📋 Agentes</h2></summary>
  <div class="pbody">
  <input class="search" id="csearch" placeholder="Buscar agente…" oninput="filt()">
  <div style="overflow-x:auto"><table id="ctab">
    <tr><th>Agente</th><th>Leads (7d / total)</th><th>Enlaces</th><th>Editar página</th></tr>
    ${clients.length ? clients.map((c) => {
      const s = statOf(c.id); const wa = waOf(phoneOf(c)); const sd = c.data?.site || {}, dd = c.data || {};
      const pill = dd.status === "paused" ? '<span class="tstat" style="background:#FDECEC;color:#C5221F">pausada</span>'
        : sd.published ? '<span class="tstat done">publicada</span>'
        : (sd.template || sd.about) ? '<span class="tstat open">en construcción</span>'
        : '<span class="tstat" style="background:#F0F2F6;color:#8A94A8">nueva</span>';
      return `<tr data-n="${esc(c.name).toLowerCase()} ${c.slug}">
      <td><b>${esc(c.name)}</b> ${pill}<br><span class="slug2">/${c.slug}</span></td>
      <td>${s.last7} / ${s.total}</td>
      <td><a href="/site/${c.slug}" target="_blank">🌐</a> · <a href="/w/${c.slug}" target="_blank">🏡</a>${wa ? ` · <a class="wa" href="${wa}" target="_blank">💬</a>` : ""}</td>
      <td><a class="edit" href="/onboarding?key=${K}&slug=${c.slug}">✏️ Editar</a></td>
    </tr>`; }).join("") : `<tr><td colspan="4" class="empty">Todavía no hay agentes.</td></tr>`}
  </table></div>
  </div>
</details></div>

<div class="panel guide"><details><summary class="psum"><h2 style="margin:0">📘 Guía rápida — cómo hacer cada cosa</h2></summary>
  <div class="pbody">
  <details><summary>El cliente pide un cambio de su PÁGINA (textos, zonas, datos)</summary><div class="gb"><ol><li>En la tarea, toca <b>✨ Ver arreglo automático</b> — la IA te MUESTRA qué cambiaría (antes → después), sin guardar nada todavía.</li><li>Lee el cambio. Si tiene sentido, toca <b>✅ Sí, aplicar</b>. Si no, <b>✕ Cancelar</b> y hazlo tú con ⚡ Editar datos.</li><li>Toca <b>🔔 Avisarle</b> — le llega un aviso directo a su celular (push). Marca <b>✓ Hecho</b>.</li></ol></div></details>
  <details><summary>El cliente pide algo del VALUADOR (el widget de su página)</summary><div class="gb">El valuador no tiene textos editables — funciona igual para todos. Lee qué pide: si es un dato de SU página, usa ✨ o ⚡. Si es del funcionamiento o de los valores que muestra, pásaselo al admin (es del motor, no de este cliente).</div></details>
  <details><summary>El cliente quiere cambiar su info (teléfono, nombre, color, historia)</summary><div class="gb"><ol><li>En "Agentes" o en la tarea, toca <b>✏️ Editar</b> o <b>⚡ Editar datos</b>.</li><li>Cambia lo que pide.</li><li>Guarda — si su página está publicada, el cambio sale al instante.</li><li>Marca la tarea <b>✓ Hecho</b> y <b>🔔 Avísale</b>.</li></ol></div></details>
  <details><summary>El cliente quiere subir fotos nuevas</summary><div class="gb"><ol><li>Pídele las fotos por <b>💬 WhatsApp</b>.</li><li><b>✏️ Editar</b> → paso <b>Logo y fotos</b> → súbelas.</li><li>Guarda y <b>Publica</b>. Marca <b>Hecho</b>.</li></ol></div></details>
  <details><summary>La página está "en construcción" / sin publicar</summary><div class="gb"><ol><li><b>✏️ Editar</b> y revisa que esté completa.</li><li>En el último paso toca <b>🚀 Publicar página al cliente</b>.</li></ol></div></details>
  <details><summary>Dice que su página "no aparece" en Google</summary><div class="gb">Su página ya está en línea (sitio + valuador). Salir en Google toma tiempo. Confírmale que su link funciona y que ya puede compartirlo por WhatsApp y redes.</div></details>
  <details><summary>Pago falló / cuenta pausada</summary><div class="gb">Recuérdale por <b>💬 WhatsApp</b> actualizar su tarjeta. Cuando pague, la cuenta se reactiva sola. Si pagó por otro medio, avísale al admin.</div></details>
  <details><summary>Aparece "📱 link compartido"</summary><div class="gb">Su cuenta se está abriendo en muchos teléfonos — su equipo la está compartiendo. Ofrécele por <b>💬 WhatsApp</b> cuentas para su equipo (más venta para nosotros).</div></details>
  </div>
</details></div>
</div>
<script>
var QE=${JSON.stringify(qeData)};
function quick(t){var i=document.getElementById('t_title');i.value=t;document.getElementById('t_slug').focus();}
function mkTask(slug,prefix){document.getElementById('t_slug').value=slug;var i=document.getElementById('t_title');i.value=prefix;i.focus();window.scrollTo({top:document.getElementById('t_title').getBoundingClientRect().top+window.scrollY-140,behavior:'smooth'});}
function addTask(){var s=document.getElementById('t_slug').value,t=document.getElementById('t_title').value.trim();if(!t){document.getElementById('t_title').focus();return;}
  fetch('/api/cs/task?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:s,title:t})}).then(function(){location.reload()});}
function tStat(id,st){fetch('/api/cs/task/'+encodeURIComponent(id)+'?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:st})}).then(function(){location.reload()});}
function tDel(id){if(!confirm('¿Borrar tarea?'))return;fetch('/api/cs/task/'+encodeURIComponent(id)+'?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delete:true})}).then(function(){location.reload()});}
function filt(){var q=document.getElementById('csearch').value.toLowerCase();document.querySelectorAll('#ctab tr[data-n]').forEach(function(r){r.style.display=r.getAttribute('data-n').indexOf(q)>=0?'':'none';});}
/* ✨ two-step: PREVIEW (nothing saved) → the agent reads before→after → APPLY */
function aiFix(id,btn){
  var pv=document.getElementById('pv-'+id);
  btn.disabled=true;var o=btn.textContent;btn.textContent='✨ Pensando…';
  fetch('/api/cs/aifix?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
    .then(function(r){return r.json().then(function(j){return {s:r.status,j:j}})})
    .then(function(x){
      btn.disabled=false;btn.textContent=o;
      var j=x.j;pv.style.display='block';
      if(x.s!==200){pv.innerHTML='<div class="pvbox pvno"><p class="pvsum">😕 '+(j.error||'No se pudo')+'</p></div>';return;}
      if(!j.handled){pv.innerHTML='<div class="pvbox pvno"><p class="pvsum">🙋 '+(j.summary||'Esto lo tiene que hacer una persona.')+'</p></div>';return;}
      var rows=(j.changes||[]).map(function(c){return '<div class="pvrow"><b>'+c.label+'</b><div class="pvold">'+esc2(c.before)+'</div><div class="pvnew">'+esc2(c.after)+'</div></div>'}).join('');
      pv.innerHTML='<div class="pvbox"><p class="pvsum">✨ '+esc2(j.summary||'')+'</p>'+rows+
        '<div class="pvbtns"><button class="tbtn go" onclick=\\'aiApply("'+id+'",this)\\'>✅ Sí, aplicar</button><button class="tbtn" onclick="this.closest(\\'.tpreview\\').style.display=\\'none\\'">✕ Cancelar</button></div></div>';
      pv.dataset.patch=JSON.stringify(j.patch||{});
    })
    .catch(function(){btn.disabled=false;btn.textContent=o;alert('Error de conexión');});
}
function aiApply(id,btn){
  var pv=document.getElementById('pv-'+id);
  var patch={};try{patch=JSON.parse(pv.dataset.patch||'{}')}catch(e){}
  btn.disabled=true;btn.textContent='Guardando…';
  fetch('/api/cs/aifix/apply?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,patch:patch})})
    .then(function(r){return r.json()}).then(function(j){if(j.ok)location.reload();else{alert(j.error||'Error');btn.disabled=false;btn.textContent='✅ Sí, aplicar';}})
    .catch(function(){alert('Error de conexión');btn.disabled=false;btn.textContent='✅ Sí, aplicar';});
}
function notifyClient(id,btn){
  btn.disabled=true;var o=btn.textContent;btn.textContent='🔔 Avisando…';
  fetch('/api/cs/notify?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
    .then(function(r){return r.json()}).then(function(j){
      btn.disabled=false;
      if(j.pushed){btn.textContent='✓ Avisado';setTimeout(function(){btn.textContent=o},2500);}
      else if(j.waFallback){btn.textContent=o;if(confirm('Este cliente no tiene notificaciones activas. ¿Avisarle por WhatsApp?'))window.open(j.waFallback,'_blank');}
      else{btn.textContent=o;alert(j.error||'No se pudo avisar');}
    })
    .catch(function(){btn.disabled=false;btn.textContent=o;alert('Error de conexión');});
}
function esc2(x){var d=document.createElement('div');d.textContent=String(x==null?'':x);return d.innerHTML;}
function qeOpen(slug){var p=document.getElementById('qepanel');p.open=true;document.getElementById('qe_slug').value=slug;qeShow();p.scrollIntoView({behavior:'smooth'});}
function qeShow(){
  var slug=document.getElementById('qe_slug').value,f=document.getElementById('qe_form');
  if(!slug||!QE[slug]){f.style.display='none';return;}
  var d=QE[slug];f.style.display='block';
  ['biz','phone','city','area','years','license','template','color','services','hero','tagline','about','diff','warranty'].forEach(function(k){var el=document.getElementById('qe_'+k);if(el)el.value=d[k]||'';});
  document.getElementById('qe_prev').href='/site/'+slug+'?preview=1';
  document.getElementById('qe_live').href='/site/'+slug;
  document.getElementById('qe_msg').textContent='';
}
function qeSave(btn){
  var slug=document.getElementById('qe_slug').value;if(!slug)return;
  var v=function(k){var el=document.getElementById('qe_'+k);return el?el.value:''};
  btn.disabled=true;btn.textContent='Guardando…';
  fetch('/api/onboarding/save?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    slug:slug,biz:v('biz'),phone:v('phone'),city:v('city'),area:v('area'),years:v('years'),license:v('license'),
    template:v('template'),color:v('color'),services:v('services').split(',').map(function(x){return x.trim()}).filter(Boolean),
    hero:v('hero'),tagline:v('tagline'),about:v('about'),diff:v('diff'),warranty:v('warranty')
  })}).then(function(r){return r.json()}).then(function(j){
    btn.disabled=false;btn.textContent='💾 Guardar cambios';
    document.getElementById('qe_msg').textContent=j.ok?'✓ Guardado':'Error: '+(j.error||'?');
  }).catch(function(){btn.disabled=false;btn.textContent='💾 Guardar cambios';document.getElementById('qe_msg').textContent='Error de conexión';});
}
</script>
</body></html>`);
});

/* ── Onboarding form (/onboarding) — staff fills the client's data card ──
 * Writes into c.data.site / c.data.profile. Purely additive; the site
 * renderer already reads these fields. Closer or admin key required. */
app.get("/onboarding", async (req, res) => {
  if (!CLOSER_KEY && !ADMIN_KEY) return res.status(503).send("Set CLOSER_KEY or ADMIN_KEY.");
  if (!closerOk(req) && !csOk(req)) return res.status(req.query.key ? 403 : 401).send(loginPage("Onboarding", "/onboarding", !!req.query.key));
  const ck = reqCookies(req);
  const K = encodeURIComponent(String(req.query.key || ck.alto_closer || ck.alto_cs || ck.alto_admin || ""));
  const esc = (x) => String(x || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const slug = String(req.query.slug || "").trim();

  // No client picked → show a picker
  if (!slug) {
    const list = (await db.listContractors()).filter((c) => !["alto-demo", "alto-ventas"].includes(c.slug));
    return res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick Comp · Onboarding</title><link rel="icon" href="/icon-192.png"><style>
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0}body{background:#F4F6FA;color:#101B30}
header{background:#101B30;color:#fff;padding:14px 22px;display:flex;align-items:center;gap:12px}
header img{height:32px;background:#fff;border-radius:8px;padding:4px 6px}header b em{color:#C9973A;font-style:normal}
.wrap{max-width:640px;margin:0 auto;padding:24px}
h1{font-size:20px;margin-bottom:6px}.sub{color:#67718A;font-size:14px;font-weight:600;margin-bottom:18px}
.row{display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #E8ECF3;border-radius:14px;padding:14px 16px;margin-bottom:10px}
.row b{font-size:15px}.row small{color:#9AA0AC;display:block;font-weight:600}
.row a{background:#C9973A;color:#101B30;text-decoration:none;font-weight:800;border-radius:10px;padding:9px 16px;font-size:13px}
.empty{color:#8A94A8;font-weight:600;text-align:center;padding:30px}
</style></head><body>
<header><img src="/brand-logo.png" alt=""><b>QUICK <em>COMP</em> · Onboarding</b></header>
<div class="wrap">
<h1>¿Para qué cliente es la página?</h1>
<p class="sub">Elige el cliente que ya creaste. Si no aparece, créalo primero en el portal del closer.</p>
${list.length ? list.map((c) => `<div class="row"><span><b>${esc(c.name)}</b><small>/${esc(c.slug)}</small></span><a href="/onboarding?key=${K}&slug=${esc(c.slug)}">Personalizar →</a></div>`).join("") : `<p class="empty">Todavía no hay clientes. Créalos en <a href="/closer?key=${K}">/closer</a>.</p>`}
</div></body></html>`);
  }

  const c = await db.getContractorBySlug(slug);
  if (!c) return res.status(404).send("Cliente no encontrado.");
  const p = c.data?.profile || {};
  const st = c.data?.site || {};
  const v = (x) => esc(x);
  const svc = Array.isArray(st.services) ? st.services : [];
  const chk = (x) => (svc.indexOf(x) >= 0 ? "checked" : "");
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Onboarding · ${esc(c.name)}</title><link rel="icon" href="/icon-192.png"><style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;0,9..144,700;1,9..144,600&family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0;-webkit-tap-highlight-color:transparent}
:root{--navy:#101B30;--navy2:#0B1226;--gold:#C9973A;--mut:#9DA8C4;--line:rgba(255,255,255,.1)}
body{background:var(--navy2);color:#fff;overflow:hidden}
.layout{display:flex;height:100vh;height:100dvh}
aside{width:268px;background:#fff;border-right:1px solid #E9EAEE;display:flex;flex-direction:column;flex-shrink:0}
.sb-brand{display:flex;align-items:center;gap:10px;padding:22px 20px 14px}
.sb-brand img{height:30px;background:#fff;border-radius:8px}
.sb-brand b{color:#101B30;font-weight:800;font-size:15px}.sb-brand b em{color:#B07A00;font-style:normal}
.sb-label{font-size:10px;letter-spacing:2px;color:#9AA0AC;font-weight:800;padding:8px 20px 6px;text-transform:uppercase}
nav{flex:1;overflow-y:auto;padding-bottom:10px;display:flex;flex-direction:column}
.nav-it{flex:1;display:flex;align-items:center;gap:13px;width:100%;background:none;border:none;color:#6A7384;font-weight:700;font-size:15px;padding:0 20px;cursor:pointer;text-align:left;border-left:4px solid transparent;min-height:46px}
.nav-it .no{font-family:'Fraunces',Georgia,serif;font-size:13px;color:#B6BCC8;width:20px;flex-shrink:0}
.nav-it.on{color:#101B30;background:rgba(201,151,58,.13);border-left-color:var(--gold)}
.nav-it.on .no{color:#B07A00}
.nav-it.done .no{color:#1E7B3C}
.sb-foot{padding:13px 20px;font-size:11px;color:#9AA0AC;font-weight:700;border-top:1px solid #E9EAEE}
main{flex:1;position:relative;display:flex;flex-direction:column;min-width:0}
.mtop{display:none}
.stage{flex:1;position:relative;overflow:hidden}
.slide{position:absolute;inset:0;display:none;flex-direction:column;overflow-y:auto;background:radial-gradient(120% 120% at 100% 0,rgba(16,27,48,.65),var(--navy2))}
.slide.on{display:flex}
.s-in{position:relative;flex:1;display:flex;flex-direction:column;justify-content:center;padding:clamp(26px,5vw,60px);max-width:1040px;width:100%}
.s-in.top{justify-content:flex-start;padding-top:clamp(30px,5vh,52px)}
.kick{color:var(--gold);font-weight:800;font-size:12px;letter-spacing:3px;margin-bottom:14px;text-transform:uppercase}
h1{font-family:'Fraunces',Georgia,serif;font-size:clamp(30px,4.4vw,52px);line-height:1.07;font-weight:700;max-width:760px;color:#fff}
h1 em{font-style:italic;color:var(--gold)}
h1 small{display:block;font-family:Inter;font-size:14px;color:var(--mut);font-weight:600;margin-top:10px;letter-spacing:0}
.rule{width:50px;height:4px;background:var(--gold);border-radius:2px;margin:20px 0}
.body{color:var(--mut);font-weight:500;font-size:clamp(15px,1.7vw,18px);line-height:1.7;max-width:580px}
.fcard{background:#fff;color:#0B1220;border-radius:24px;padding:24px 26px;max-width:640px;width:100%;box-shadow:0 30px 80px rgba(0,0,0,.45);margin-top:24px}
label{display:block;font-weight:600;font-size:13px;margin:16px 0 6px;color:#475067}
label:first-child{margin-top:0}
input,textarea,select{width:100%;padding:13px 15px;border-radius:13px;border:1px solid #E4E7EC;font-size:15px;font-weight:500;outline:none;font-family:inherit;color:#0B1220;background:#fff;transition:border-color .15s,box-shadow .15s}
input:focus,textarea:focus{border-color:var(--gold);box-shadow:0 0 0 4px rgba(201,151,58,.18)}
textarea{min-height:96px;resize:vertical;line-height:1.5}
input[type=file]{padding:10px;background:#F7F8FA;font-weight:600}
.hint{color:#67718A;font-size:12px;font-weight:500;margin-top:6px;line-height:1.5}
.btn-dark{background:#101B30;color:#fff;border:none;border-radius:11px;padding:12px 18px;font-weight:800;cursor:pointer}
.colorrow{display:flex;gap:12px;align-items:center;margin-top:6px}
.colorrow input[type=color]{width:54px;height:46px;padding:2px;border-radius:12px;cursor:pointer;border:1px solid #E4E7EC}
.tgrid{display:flex;gap:20px;flex-wrap:wrap;margin-top:6px}
.tpl{cursor:pointer;border-radius:30px;padding:9px;border:2px solid transparent;transition:border-color .15s,background .15s,transform .12s}
.tpl:hover{transform:translateY(-2px)}
.tpl.on{border-color:var(--gold);background:rgba(201,151,58,.1)}
.tphone{background:#0B1226;border:8px solid #1E2A45;border-radius:34px;padding:7px;box-shadow:0 22px 60px rgba(0,0,0,.5)}
.tscr{width:208px;height:420px;overflow:hidden;border-radius:24px}
.tscr iframe{width:390px;height:788px;border:0;transform:scale(.5333);transform-origin:0 0;background:#fff;pointer-events:none}
.tpl .tn{text-align:center;font-weight:800;margin-top:12px;color:#fff;font-size:15px}
.tpl .tn span{color:var(--gold)}
.tpl .td{text-align:center;color:var(--mut);font-size:12px;font-weight:600;margin-top:3px}
.tpl .pick{display:block;text-align:center;margin-top:7px;color:var(--mut);font-weight:800;font-size:11px;letter-spacing:1px;text-transform:uppercase}
.tpl.on .pick{color:var(--gold)}
.tplbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:18px 0 4px}
.tplbar label{margin:0;color:#C9D2E5;font-weight:700;font-size:13px}
.tplbar input[type=color]{width:46px;height:38px;border:1px solid var(--line);border-radius:10px;background:none;cursor:pointer;padding:2px}
.thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.thumbs .th{position:relative}
.thumbs img{width:74px;height:74px;object-fit:cover;border-radius:12px;border:1px solid #E4E7EC}
.thumbs .x{position:absolute;top:-6px;right:-6px;background:#D93025;color:#fff;border:none;border-radius:50%;width:22px;height:22px;font-weight:800;cursor:pointer}
.logoprev{max-height:54px;max-width:160px;border:1px solid #E4E7EC;border-radius:10px;padding:4px;background:#fff;margin-top:8px;display:none}
.navbar{display:flex;align-items:center;gap:16px;padding:13px 22px;background:rgba(11,18,38,.9);backdrop-filter:saturate(160%) blur(14px);-webkit-backdrop-filter:saturate(160%) blur(14px);border-top:1px solid var(--line)}
.progress{flex:1;height:6px;background:rgba(255,255,255,.12);border-radius:99px;overflow:hidden}
.progress>i{display:block;height:100%;width:14%;background:var(--gold);border-radius:99px;transition:width .3s}
.nb-btn{background:rgba(255,255,255,.08);color:#fff;border:1px solid var(--line);border-radius:11px;padding:11px 20px;font-weight:800;cursor:pointer;font-size:14px}
.nb-btn.next{background:var(--gold);color:#101B30;border:none;box-shadow:0 8px 20px rgba(201,151,58,.3)}
.nb-btn:disabled{opacity:.35;cursor:default}
.save{width:100%;padding:16px;border:none;border-radius:14px;background:var(--gold);color:#101B30;font-size:16px;font-weight:800;cursor:pointer;box-shadow:0 10px 26px rgba(201,151,58,.35);transition:transform .12s,filter .15s;margin-top:6px}
.save:hover{filter:brightness(1.03)}.save:active{transform:scale(.98)}.save:disabled{opacity:.6}
.ok{display:none;background:#E7F7ED;border:1px solid #B6E3C6;color:#10803C;border-radius:14px;padding:14px;font-weight:600;text-align:center;margin-top:12px}
.ok a{color:#10803C;font-weight:800}
.linkrow a{color:var(--gold);font-weight:700;text-decoration:none;font-size:13px}
.rev{list-style:none;padding:0;margin:0}
.rev li{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid #EDF0F5;font-size:14px}
.rev li:last-child{border-bottom:none}
.rev li b{color:#475067;font-weight:600}.rev li span{font-weight:700;color:#0B1220;text-align:right}
.wflow{display:flex;gap:14px;flex-wrap:wrap;margin-top:28px;max-width:760px}
.wflow .wf{flex:1;min-width:150px;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:18px;padding:18px 20px}
.wflow .wf .n{font-family:'Fraunces',Georgia,serif;color:var(--gold);font-size:13px;font-weight:700;letter-spacing:2px}
.wflow .wf h4{font-size:15px;margin:8px 0 5px;color:#fff;font-weight:700}
.wflow .wf p{color:var(--mut);font-size:12.5px;font-weight:500;line-height:1.55}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.chip{display:inline-flex;align-items:center;gap:6px;border:1.5px solid #E4E7EC;border-radius:99px;padding:9px 15px;font-size:13.5px;font-weight:700;color:#475067;cursor:pointer;user-select:none;transition:border-color .12s,background .12s,color .12s}
.chip input{display:none}
.chip:has(input:checked){border-color:var(--gold);background:#F7EFD8;color:#101B30}
.chip:has(input:checked)::before{content:"✓";color:#B07A00;font-weight:900}
.microw{display:flex;gap:8px;align-items:flex-start}
.micbtn{background:#fff;border:1.5px solid #E4E7EC;border-radius:12px;width:48px;height:48px;font-size:19px;cursor:pointer;flex-shrink:0;transition:border-color .15s,background .15s}
.micbtn:hover{border-color:#C9CDD6}
.micbtn.rec{border-color:#D93025;background:#FDECEC;animation:micpulse 1.1s infinite}
@keyframes micpulse{0%,100%{box-shadow:0 0 0 0 rgba(217,48,37,.35)}50%{box-shadow:0 0 0 7px rgba(217,48,37,0)}}
textarea.big{min-height:150px;font-size:16px}
.bigwrap{margin-top:26px}
.bigwrap .cap{color:var(--mut);font-weight:700;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;margin-bottom:11px}
.webframe{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.5);width:min(760px,100%)}
.webframe .wbar{display:flex;align-items:center;gap:6px;background:#E9EAEE;padding:9px 14px}
.webframe .wdot{width:10px;height:10px;border-radius:50%;background:#C9CDD6}
.webframe .wurl{flex:1;background:#fff;border-radius:8px;font-size:11.5px;color:#5E6470;font-weight:600;padding:5px 12px;margin-left:8px}
.dscr{width:100%;height:452px;overflow:hidden}
.dscr iframe{width:1180px;height:880px;border:0;transform:scale(.6441);transform-origin:0 0;display:block;background:#fff}
@media(max-width:860px){
  aside{display:none}
  .mtop{display:flex;align-items:center;gap:12px;background:rgba(16,27,48,.92);color:#fff;padding:13px 18px;border-bottom:1px solid var(--line)}
  .mtop img{height:26px;background:#fff;border-radius:7px;padding:3px 5px}
  .mtop .mstep{font-size:11px;color:var(--gold);font-weight:800;letter-spacing:1px}
  .mtop .mtitle{font-weight:800;font-size:14px}
  .s-in{padding:22px 18px 30px}
}
</style></head><body>
<div class="layout">
<aside>
  <div class="sb-brand"><img src="/brand-logo.png" alt=""><b>QUICK <em>COMP</em></b></div>
  <div class="sb-label">Onboarding · ${esc(c.name)}</div>
  <nav id="nav">
    <button class="nav-it on" onclick="go(0)"><span class="no">1</span>Bienvenida</button>
    <button class="nav-it" onclick="go(1)"><span class="no">2</span>Su negocio</button>
    <button class="nav-it" onclick="go(2)"><span class="no">3</span>Su plantilla</button>
    <button class="nav-it" onclick="go(3)"><span class="no">4</span>Su historia</button>
    <button class="nav-it" onclick="go(4)"><span class="no">5</span>Logo y fotos</button>
    <button class="nav-it" onclick="go(5)"><span class="no">6</span>Su dominio</button>
    <button class="nav-it" onclick="go(6)"><span class="no">7</span>Listo</button>
  </nav>
  <div class="sb-foot">🌐 ${esc(siteDisplay(req, c.slug))}</div>
</aside>
<main>
  <div class="mtop"><img src="/brand-logo.png" alt=""><div><div class="mstep" id="mstep">Paso 1 de 7</div><div class="mtitle" id="mtitle">Bienvenida</div></div></div>
  <div class="stage">

    <section class="slide on">
      <div class="s-in">
        <p class="kick">Onboarding · ${esc(c.name)}</p>
        <h1>Bienvenido a tu <em>onboarding.</em></h1>
        <div class="rule"></div>
        <p class="body">En esta reunión vamos a juntar todo lo que hace único a tu negocio — tu estilo, tu historia, tu logo y tus fotos. Con eso, nuestro equipo de diseño construye tu página a mano. Tú solo contesta unas preguntas; nosotros nos encargamos del resto.</p>
        <div class="wflow">
          <div class="wf"><div class="n">01</div><h4>Tus preferencias</h4><p>Juntamos tu estilo, tu historia y tus fotos en esta llamada.</p></div>
          <div class="wf"><div class="n">02</div><h4>Nuestro equipo de diseño</h4><p>Lo arma todo a mano con tu marca — no es una plantilla genérica.</p></div>
          <div class="wf"><div class="n">03</div><h4>Tu página, lista</h4><p>En 10–14 días, en ${esc(siteDisplay(req, c.slug))} o tu propio dominio.</p></div>
        </div>
      </div>
    </section>

    <section class="slide">
      <div class="s-in top">
        <p class="kick">Paso 2 · Su negocio</p>
        <h1>Cuéntanos de <em>tu negocio.</em></h1>
        <div class="fcard">
          <label>Nombre del negocio</label><input id="biz" value="${v(p.biz || c.name)}">
          <label>Teléfono</label><input id="phone" type="tel" value="${v(p.phone || c.phone)}" placeholder="(956) 555-0100">
          <label>Ciudad principal</label><input id="city" value="${v(st.city)}" placeholder="Rio Grande City, TX">
          <label>Pueblos o condados que cubre</label><input id="area" value="${v(st.area)}" placeholder="Starr, Hidalgo, Zapata…">
          <label>Años en el negocio</label><input id="years" type="number" value="${v(st.years)}" placeholder="15">
          <label>Servicios que ofrece</label>
          <div class="chips" id="services">
            <label class="chip"><input type="checkbox" value="Venta de casas (listing)" ${chk("Venta de casas (listing)")}>Venta / listing</label>
            <label class="chip"><input type="checkbox" value="Representación de compradores" ${chk("Representación de compradores")}>Compradores</label>
            <label class="chip"><input type="checkbox" value="Valuación / CMA gratis" ${chk("Valuación / CMA gratis")}>Valuación / CMA</label>
            <label class="chip"><input type="checkbox" value="Primera casa" ${chk("Primera casa")}>Primera casa</label>
            <label class="chip"><input type="checkbox" value="Inversionistas" ${chk("Inversionistas")}>Inversionistas</label>
            <label class="chip"><input type="checkbox" value="Casas de lujo" ${chk("Casas de lujo")}>Lujo</label>
            <label class="chip"><input type="checkbox" value="Comercial" ${chk("Comercial")}>Comercial</label>
            <label class="chip"><input type="checkbox" value="Renta / property management" ${chk("Renta / property management")}>Renta</label>
            <label class="chip"><input type="checkbox" value="Crédito / financiamiento" ${chk("Crédito / financiamiento")}>Crédito</label>
          </div>
          <label>Especialidad o enfoque (opcional)</label><input id="warranty" value="${v(st.warranty)}" placeholder="Ej. familias hispanas, primera casa, Starr County">
          <label>¿Qué te hace diferente? (opcional)</label><input id="diff" value="${v(st.diff)}" placeholder="Ej. agente local, atención personal en cada cierre">
          <label>Licencia / designaciones (opcional)</label><input id="license" value="${v(p.license)}" placeholder="TREC #123456 · Realtor®">
          <label>Idioma de su página</label>
          <select id="sitelang"><option value="es" ${(st.lang || "es") !== "en" ? "selected" : ""}>Español</option><option value="en" ${st.lang === "en" ? "selected" : ""}>English</option></select>
          <p class="hint">Todo su sitio y su valuador se entregan en este idioma.</p>
        </div>
      </div>
    </section>

    <section class="slide">
      <div class="s-in top">
        <p class="kick">Paso 3 · Su plantilla</p>
        <h1>¿Cuál se siente <em>más tú?</em></h1>
        <p class="body" style="margin-top:8px">Tres estilos, cada uno con su propia personalidad. Toca el que más te guste — abajo lo ves en grande, en computadora.</p>
        <div class="tgrid" id="tpls">
          <div class="tpl" data-t="1" onclick="pickTpl('1')"><div class="tphone"><div class="tscr"><iframe id="f1" src="/plantilla/1?embed=1" title="Clásico"></iframe></div></div><p class="tn">1 · <span>El Clásico</span></p><p class="td">Elegante y premium</p><span class="pick">Elegir</span></div>
          <div class="tpl" data-t="2" onclick="pickTpl('2')"><div class="tphone"><div class="tscr"><iframe id="f2" src="/plantilla/2?embed=1" title="Fuerte"></iframe></div></div><p class="tn">2 · <span>El Fuerte</span></p><p class="td">Fuerte y con energía</p><span class="pick">Elegir</span></div>
          <div class="tpl" data-t="3" onclick="pickTpl('3')"><div class="tphone"><div class="tscr"><iframe id="f3" src="/plantilla/3?embed=1" title="Limpio"></iframe></div></div><p class="tn">3 · <span>El Limpio</span></p><p class="td">Limpio y de confianza</p><span class="pick">Elegir</span></div>
        </div>
        <div class="bigwrap">
          <p class="cap">Así se vería en computadora</p>
          <div class="webframe">
            <div class="wbar"><span class="wdot"></span><span class="wdot"></span><span class="wdot"></span><span class="wurl">${esc(siteDisplay(req, c.slug))}</span></div>
            <div class="dscr"><iframe id="bigframe" src="/plantilla/1?embed=1" title="Vista de computadora"></iframe></div>
          </div>
        </div>
      </div>
    </section>

    <section class="slide">
      <div class="s-in top">
        <p class="kick">Paso 4 · Su historia</p>
        <h1>Cuéntanos <em>su historia.</em></h1>
        <div class="fcard">
          <label>Cuéntanos del negocio — habla o escribe</label>
          <textarea id="rough" class="big" placeholder="¿Cómo empezó en bienes raíces? ¿Cuántas casas ha vendido? ¿En qué se especializa? ¿Qué lo hace diferente? Puedes hablar con el micrófono — no tiene que estar bonito, la IA lo acomoda."></textarea>
          <div class="microw" style="margin-top:8px">
            <button type="button" id="aibtn" onclick="aiWrite()" class="btn-dark">✨ Escribir con IA</button>
            <button type="button" class="micbtn" onclick="dictate('rough',this)" title="Hablar en vez de escribir">🎤</button>
            <span class="hint" id="aihint" style="align-self:center"></span>
          </div>
          <hr style="border:none;border-top:1px solid #EDF0F5;margin:18px 0">
          <label>Titular (opcional)</label><input id="hero" value="${v(st.hero)}" placeholder="Déjalo vacío para usar el de la plantilla">
          <label>Frase corta</label><input id="tagline" value="${v(st.tagline)}" placeholder="Vende tu casa al mejor precio, con ventas reales de tu zona.">
          <label>Su historia (lo que va en la página)</label>
          <div class="microw">
            <textarea id="about" class="big" placeholder="2-3 oraciones sobre el negocio — la IA la llena desde tus notas de arriba.">${v(st.about)}</textarea>
            <button type="button" class="micbtn" onclick="dictate('about',this)" title="Hablar en vez de escribir">🎤</button>
          </div>
          <p class="hint">La IA llena el titular, la frase y la historia desde tus notas — <b>revísalos y edítalos</b> antes de enviar.</p>
        </div>
      </div>
    </section>

    <section class="slide">
      <div class="s-in top">
        <p class="kick">Paso 5 · Logo y fotos</p>
        <h1>Su <em>marca.</em></h1>
        <div class="fcard">
          <label>Logo del negocio</label>
          <p class="hint" style="margin-top:0">Sube el logo y de ahí sacamos los colores de tu página automáticamente.</p>
          <input type="file" id="logofile" accept="image/*">
          <img class="logoprev" id="logoprev" ${/^data:image/.test(String(p.logo || "")) ? `src="${p.logo}" style="display:block"` : ""}>
          <input type="hidden" id="color" value="${st.color && /^#[0-9a-fA-F]{6}$/.test(st.color) ? st.color : ""}">
          <label style="margin-top:18px">Fotos de trabajos terminados</label>
          <p class="hint" style="margin-top:0">📲 Pídele al cliente que mande sus mejores fotos por WhatsApp y tú las subes aquí durante la llamada. Fotos reales se ven mucho mejor que las de internet.</p>
          <input type="file" id="photofiles" accept="image/*" multiple>
          <div class="thumbs" id="thumbs"></div>
        </div>
      </div>
    </section>

    <section class="slide">
      <div class="s-in top">
        <p class="kick">Paso 6 · Su dominio</p>
        <h1>Su propio <em>dominio.</em> <small>Opcional — su página ya vive en ${esc(siteDisplay(req, c.slug))}</small></h1>
        <div class="fcard">
          <label>Buscar un dominio disponible</label>
          <div style="display:flex;gap:8px"><input id="dsearch" placeholder="Nombre del negocio o dominio" style="flex:1" onkeydown="if(event.key==='Enter'){event.preventDefault();checkDomain();}"><button type="button" onclick="checkDomain()" id="dsbtn" class="btn-dark" style="white-space:nowrap;background:var(--gold);color:#101B30">Buscar</button></div>
          <div id="dresults" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px"></div>
          <p class="hint" id="dsearchhint" style="margin-top:4px"></p>
          <hr style="border:none;border-top:1px solid #EDF0F5;margin:14px 0">
          <label>Dominio del cliente (conectar)</label>
          <div style="display:flex;gap:8px"><input id="domain" value="${v(st.domain)}" placeholder="casabellarealty.com" style="flex:1"><button type="button" onclick="connectDomain()" id="dombtn" class="btn-dark" style="white-space:nowrap">Conectar</button></div>
          <div id="dommsg" class="hint" style="margin-top:8px"></div>
        </div>
      </div>
    </section>

    <section class="slide">
      <div class="s-in top">
        <p class="kick">Paso 7 · Listo</p>
        <h1>Todo listo para <em>enviarlo.</em></h1>
        <div class="fcard">
          <div style="text-align:center"><div style="font-size:42px;line-height:1">📨</div></div>
          <p style="text-align:center;color:#475067;font-weight:600;font-size:14px;margin:8px 0 18px;line-height:1.6">Revisa que todo esté bien. Al enviar, nuestro equipo de diseño arma tu página a mano y te la entregamos lista en <b style="color:#0B1220">10–14 días</b>.</p>
          <ul class="rev">
            <li><b>Negocio</b><span id="rvbiz">—</span></li>
            <li><b>Estilo elegido</b><span id="rvtpl">—</span></li>
            <li><b>Servicios</b><span id="rvserv">—</span></li>
            <li><b>Dominio</b><span id="rvdom">su subdominio</span></li>
          </ul>
          <button class="save" id="save" onclick="save()">Enviar al equipo de diseño 🎨</button>
          <div class="ok" id="ok"></div>
          <div id="staff" style="display:${st.template || st.about ? "block" : "none"};margin-top:14px;text-align:center">
            <a href="/site/${esc(c.slug)}?preview=1" target="_blank" class="linkrow" style="margin-right:14px">👁 Ver borrador (interno)</a>
            <button onclick="publish()" id="pub" class="btn-dark" style="background:${st.published ? "#1E7B3C" : "#101B30"}">${st.published ? "✓ Publicada — clic para ocultar" : "🚀 Publicar página al cliente"}</button>
          </div>
        </div>
      </div>
    </section>

  </div>
  <div class="navbar">
    <button class="nb-btn" id="prevb" onclick="go(STEP-1)">‹ Atrás</button>
    <div class="progress"><i id="prog"></i></div>
    <button class="nb-btn next" id="nextb" onclick="go(STEP+1)">Siguiente ›</button>
  </div>
</main>
</div>
<script>
var LOGO = ${/^data:image/.test(String(p.logo || "")) ? JSON.stringify(p.logo) : "null"};
var PHOTOS = ${JSON.stringify(Array.isArray(st.photos) ? st.photos : [])};
var TPL = "${["1", "2", "3"].includes(String(st.template)) ? st.template : "1"}";
var PUBLISHED = ${st.published ? "true" : "false"};
// ── step navigation (deck-style) ──
var NAVT=["Bienvenida","Su negocio","Su plantilla","Su historia","Logo y fotos","Su dominio","Listo"];
var STEP=0;var MAX=7;
function go(i){
  if(i<0||i>=MAX)return;STEP=i;
  var sl=document.querySelectorAll('.slide');for(var s=0;s<sl.length;s++){sl[s].classList.toggle('on',s===i);}
  var nv=document.querySelectorAll('.nav-it');for(var n=0;n<nv.length;n++){nv[n].classList.toggle('on',n===i);nv[n].classList.toggle('done',n<i);}
  document.getElementById('prog').style.width=Math.round(((i+1)/MAX)*100)+'%';
  document.getElementById('mstep').textContent='Paso '+(i+1)+' de '+MAX;
  document.getElementById('mtitle').textContent=NAVT[i];
  document.getElementById('prevb').disabled=(i===0);
  document.getElementById('nextb').style.visibility=(i===MAX-1)?'hidden':'visible';
  if(i===6)review();
  if(sl[i])sl[i].scrollTop=0;
}
var TNAME={'1':'El Clásico','2':'El Fuerte','3':'El Limpio'};
function review(){
  document.getElementById('rvbiz').textContent=document.getElementById('biz').value||'—';
  document.getElementById('rvtpl').textContent=TNAME[TPL]||('Plantilla '+TPL);
  var n=document.querySelectorAll('#services input:checked').length;
  document.getElementById('rvserv').textContent=n?(n+(n===1?' servicio':' servicios')):'—';
  var d=document.getElementById('domain').value.trim();
  document.getElementById('rvdom').textContent=d||'su subdominio';
}
// ── template picker: one desktop frame swaps to the chosen template ──
function paintTpl(){[].forEach.call(document.querySelectorAll('.tpl'),function(el){el.classList.toggle('on',el.dataset.t===TPL)})}
function pickTpl(t){TPL=t;paintTpl();var bf=document.getElementById('bigframe');if(bf)bf.src='/plantilla/'+t+'?embed=1';}
// ── voice dictation (closer can speak instead of type) ──
var _rec=null,_recBtn=null;
function dictate(targetId,btn){
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){alert('Tu navegador no soporta dictado por voz. Usa Google Chrome.');return;}
  if(_rec){_rec.stop();return;}
  var ta=document.getElementById(targetId);var base=ta.value?ta.value.replace(/\\s*$/,'')+' ':'';
  _rec=new SR();_rec.lang='es-MX';_rec.interimResults=true;_rec.continuous=true;
  _recBtn=btn;btn.classList.add('rec');ta.focus();
  _rec.onresult=function(e){var interim='';for(var i=e.resultIndex;i<e.results.length;i++){var r=e.results[i];if(r.isFinal){base+=r[0].transcript+' ';}else{interim+=r[0].transcript;}}ta.value=base+interim;};
  _rec.onend=function(){if(_recBtn)_recBtn.classList.remove('rec');_rec=null;_recBtn=null;};
  _rec.onerror=function(){if(_recBtn)_recBtn.classList.remove('rec');_rec=null;_recBtn=null;};
  _rec.start();
}
// ── pull the brand color out of the uploaded logo ──
function logoColor(img){
  var w=44,h=44,cv=document.createElement('canvas');cv.width=w;cv.height=h;
  var ctx=cv.getContext('2d');ctx.drawImage(img,0,0,w,h);
  var d;try{d=ctx.getImageData(0,0,w,h).data;}catch(e){return null;}
  var buckets={},best=null,bestC=-1;
  for(var i=0;i<d.length;i+=4){
    var r=d[i],g=d[i+1],b=d[i+2],a=d[i+3];if(a<128)continue;
    var mx=Math.max(r,g,b),mn=Math.min(r,g,b);
    if(mx>238&&mn>238)continue;if(mx<24)continue;if(mx-mn<26)continue;
    var k=(r>>5)+'-'+(g>>5)+'-'+(b>>5),bk=buckets[k]||(buckets[k]={c:0,r:0,g:0,b:0});
    bk.c++;bk.r+=r;bk.g+=g;bk.b+=b;
  }
  for(var key in buckets){if(buckets[key].c>bestC){bestC=buckets[key].c;best=buckets[key];}}
  if(!best)return null;
  function hx(x){return('0'+Math.round(x).toString(16)).slice(-2);}
  return '#'+hx(best.r/best.c)+hx(best.g/best.c)+hx(best.b/best.c);
}
pickTpl(TPL);go(0);
// image compression to a data URL
function compress(file,maxW,quality){return new Promise(function(res){
  var img=new Image();img.onload=function(){
    var s=Math.min(1,maxW/img.width);var cv=document.createElement('canvas');
    cv.width=Math.round(img.width*s);cv.height=Math.round(img.height*s);
    cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
    res(cv.toDataURL('image/jpeg',quality));URL.revokeObjectURL(img.src);
  };img.src=URL.createObjectURL(file);
});}
// logo — preview it AND pull the brand color from it
document.getElementById('logofile').onchange=function(e){var f=e.target.files[0];if(!f)return;
  var im=new Image();im.onload=function(){var col=logoColor(im);if(col)document.getElementById('color').value=col;URL.revokeObjectURL(im.src);};im.src=URL.createObjectURL(f);
  compress(f,240,0.9).then(function(d){LOGO=d;var pv=document.getElementById('logoprev');pv.src=d;pv.style.display='block';});};
// photos → upload to /api/logo, store the served URL
function renderThumbs(){var t=document.getElementById('thumbs');t.innerHTML=PHOTOS.map(function(u,i){
  return '<div class="th"><img src="'+u+'"><button class="x" onclick="rmPhoto('+i+')">×</button></div>';}).join('');}
function rmPhoto(i){PHOTOS.splice(i,1);renderThumbs();}
renderThumbs();
document.getElementById('photofiles').onchange=function(e){
  var files=[].slice.call(e.target.files).slice(0,6);
  files.forEach(function(f){
    compress(f,1100,0.82).then(function(d){
      // step down quality if too big for the 150KB image store
      function tryUp(data,q){
        return fetch('/api/logo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:data})})
          .then(function(r){if(r.status===413&&q>0.4){return compress(f,900,q-0.15).then(function(d2){return tryUp(d2,q-0.15)});}return r.json();});
      }
      tryUp(d,0.82).then(function(j){if(j&&j.id&&PHOTOS.length<8){PHOTOS.push('/api/logo/'+j.id);renderThumbs();}});
    });
  });
};
function checkDomain(){
  var btn=document.getElementById('dsbtn'),box=document.getElementById('dresults'),hint=document.getElementById('dsearchhint');
  var q=document.getElementById('dsearch').value.trim();
  if(!q){hint.textContent='Escribe un nombre o dominio.';return;}
  btn.disabled=true;btn.textContent='…';box.innerHTML='';hint.style.color='#67718A';hint.textContent='Buscando…';
  fetch('/api/onboarding/domaincheck?key=${K}&name='+encodeURIComponent(q))
    .then(function(r){return r.json();}).then(function(j){
      btn.disabled=false;btn.textContent='Buscar';
      if(!j||!j.ok||!j.results){hint.textContent='No se pudo buscar — intenta de nuevo.';return;}
      hint.innerHTML='💡 Cómpralo en <b>Cloudflare Registrar</b> (precio de costo, sin sobreprecio). Cloudflare no vende dominios premium — si no te deja comprarlo, elige otro.';
      box.innerHTML=j.results.map(function(x){
        var bg=x.status==='available'?'#EAF8EF':x.status==='taken'?'#FDECEC':'#F0F2F6';
        var fg=x.status==='available'?'#1E7B3C':x.status==='taken'?'#9B1C10':'#67718A';
        var tag=x.status==='available'?'✓ disponible':x.status==='taken'?'✕ ocupado':'? sin verificar';
        var click=x.status==='available'?(' onclick="useDomain(\\''+x.domain+'\\')" style="cursor:pointer"'):'';
        return '<span'+click+' style="background:'+bg+';color:'+fg+';border-radius:10px;padding:8px 12px;font-weight:700;font-size:13px">'+x.domain+' · '+tag+'</span>';
      }).join('');
    }).catch(function(){btn.disabled=false;btn.textContent='Buscar';hint.textContent='No se pudo buscar — intenta de nuevo.';});
}
function useDomain(d){document.getElementById('domain').value=d;document.getElementById('domain').scrollIntoView({block:'center'});}
function connectDomain(){
  var btn=document.getElementById('dombtn'),msg=document.getElementById('dommsg');
  var d=document.getElementById('domain').value.trim();
  btn.disabled=true;btn.textContent='…';msg.style.color='#67718A';
  fetch('/api/onboarding/domain?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:${JSON.stringify(c.slug)},domain:d})})
    .then(function(r){return r.json();}).then(function(j){
      btn.disabled=false;btn.textContent='Conectar';
      if(!j||!j.ok){msg.style.color='#9B1C10';msg.textContent='Error: '+((j&&j.error)||'intenta de nuevo');return;}
      if(!j.domain){msg.style.color='#67718A';msg.textContent='Dominio quitado. Su página sigue en su subdominio.';return;}
      var cfNote = j.cf&&j.cf.ok ? 'Cloudflare está emitiendo el certificado SSL automáticamente.' : (j.cf&&j.cf.reason==='cf_off' ? 'Cloudflare aún no está configurado en el servidor (CF_API_TOKEN).' : 'Registro en Cloudflare pendiente — revisa el panel.');
      msg.style.color='#1E7B3C';
      msg.innerHTML='✓ Guardado. Pídele al cliente que agregue este registro en su dominio:<br><b>Tipo:</b> CNAME · <b>Nombre:</b> @ (o www) · <b>Destino:</b> '+j.cname_target+'<br><span style="color:#67718A">'+cfNote+'</span>';
    }).catch(function(){btn.disabled=false;btn.textContent='Conectar';msg.style.color='#9B1C10';msg.textContent='No se pudo — intenta de nuevo.';});
}
function aiWrite(){
  var btn=document.getElementById('aibtn'),hint=document.getElementById('aihint');
  var rough=document.getElementById('rough').value.trim();
  if(!rough){hint.textContent='Escribe unas notas primero ↑';return;}
  btn.disabled=true;btn.textContent='✨ Escribiendo…';hint.textContent='';
  fetch('/api/onboarding/ai?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    biz:document.getElementById('biz').value,city:document.getElementById('city').value,
    years:document.getElementById('years').value,rough:rough,lang:document.getElementById('sitelang').value
  })}).then(function(r){return r.json();}).then(function(j){
    btn.disabled=false;btn.textContent='✨ Escribir con IA';
    if(j&&j.source==='live'){
      if(j.hero)document.getElementById('hero').value=j.hero;
      if(j.tagline)document.getElementById('tagline').value=j.tagline;
      if(j.about)document.getElementById('about').value=j.about;
      hint.style.color='#1E7B3C';hint.textContent='✓ Listo — revisa y edita';
    } else if(j&&j.error==='ai_off'){hint.style.color='#9B1C10';hint.textContent='La IA no está activa (falta API key).';}
    else{hint.style.color='#9B1C10';hint.textContent='No se pudo — intenta de nuevo o escríbelo a mano.';}
  }).catch(function(){btn.disabled=false;btn.textContent='✨ Escribir con IA';hint.style.color='#9B1C10';hint.textContent='No se pudo — intenta de nuevo.';});
}
function save(){
  var btn=document.getElementById('save');btn.disabled=true;btn.textContent='Guardando…';
  var services=[];[].forEach.call(document.querySelectorAll('#services input:checked'),function(c){services.push(c.value);});
  fetch('/api/onboarding/save?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    slug:${JSON.stringify(c.slug)},template:TPL,color:document.getElementById('color').value,
    biz:document.getElementById('biz').value,phone:document.getElementById('phone').value,
    city:document.getElementById('city').value,area:document.getElementById('area').value,
    years:document.getElementById('years').value,services:services,
    warranty:document.getElementById('warranty').value,diff:document.getElementById('diff').value,
    lang:document.getElementById('sitelang').value,
    license:document.getElementById('license').value,hero:document.getElementById('hero').value,
    tagline:document.getElementById('tagline').value,about:document.getElementById('about').value,
    logo:LOGO,photos:PHOTOS
  })}).then(function(r){return r.json();}).then(function(j){
    btn.disabled=false;btn.textContent='Enviar al equipo de diseño 🎨';
    var ok=document.getElementById('ok');
    if(j&&j.ok){
      ok.style.background='#EAF8EF';ok.style.borderColor='#34A853';ok.style.color='#1E7B3C';
      ok.innerHTML='✓ Recibido — el equipo está armando la página. <a href="'+j.site+'?preview=1" target="_blank">Ver borrador →</a>';
      ok.style.display='block';document.getElementById('staff').style.display='block';
    }
    else{ok.style.background='#FDECEC';ok.style.borderColor='#D93025';ok.style.color='#9B1C10';ok.textContent='Error: '+((j&&j.error)||'intenta de nuevo');ok.style.display='block';}
  }).catch(function(){btn.disabled=false;btn.textContent='Enviar al equipo de diseño 🎨';});
}
function publish(){
  var pub=document.getElementById('pub');pub.disabled=true;
  fetch('/api/onboarding/publish?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:${JSON.stringify(c.slug)},publish:!PUBLISHED})})
    .then(function(r){return r.json();}).then(function(j){
      pub.disabled=false;
      if(j&&j.ok){PUBLISHED=j.published;
        pub.textContent=PUBLISHED?'✓ Publicada — clic para ocultar':'🚀 Publicar página al cliente';
        pub.style.background=PUBLISHED?'#1E7B3C':'#101B30';
      }
    }).catch(function(){pub.disabled=false;});
}
</script></body></html>`);
});

app.post("/api/onboarding/save", async (req, res) => {
  if (!closerOk(req) && !csOk(req)) return res.status(403).json({ error: "no auth" });
  const b = req.body || {};
  const c = b.slug && (await db.getContractorBySlug(String(b.slug)));
  if (!c) return res.status(404).json({ error: "cliente no encontrado" });
  const data = { ...(c.data || {}) };
  data.profile = { ...(data.profile || {}) };
  if (b.biz) data.profile.biz = String(b.biz).slice(0, 80);
  if (b.phone != null) data.profile.phone = String(b.phone).replace(/\D/g, "").replace(/^1/, "").slice(0, 15);
  if (b.license != null) data.profile.license = String(b.license).slice(0, 40);
  if (typeof b.logo === "string" && /^data:image\/(png|jpeg);base64,/.test(b.logo) && b.logo.length < 220000) data.profile.logo = b.logo;
  data.site = {
    template: ["1", "2", "3"].includes(String(b.template)) ? String(b.template) : (data.site?.template || "1"),
    color: /^#?[a-f0-9]{6}$/i.test(String(b.color || "")) ? (String(b.color).startsWith("#") ? b.color : "#" + b.color) : (data.site?.color || "#B30F24"),
    city: String(b.city || "").slice(0, 80),
    area: String(b.area || "").slice(0, 200),
    years: b.years ? Math.max(0, Math.min(99, parseInt(b.years) || 0)) : null,
    services: Array.isArray(b.services) ? b.services.map((x) => String(x).slice(0, 60)).slice(0, 12) : (data.site?.services || []),
    warranty: String(b.warranty || "").slice(0, 120),
    lang: b.lang === "en" ? "en" : "es",
    diff: String(b.diff || "").slice(0, 300),
    tagline: String(b.tagline || "").slice(0, 300),
    hero: String(b.hero || "").slice(0, 160),
    about: String(b.about || "").slice(0, 1400),
    photos: Array.isArray(b.photos) ? b.photos.filter((u) => /^\/api\/logo\/[a-f0-9]{16}\.(png|jpg)$/.test(u)).slice(0, 8) : (data.site?.photos || []),
    published: data.site?.published === true, // saving keeps current publish state
  };
  await db.saveContractorData(c.id, data);
  res.json({ ok: true, site: `/site/${c.slug}`, published: data.site.published });
});

// AI copywriter: turn the staff's rough facts + story into polished Spanish
// website copy. Suggestion only — staff reviews/edits before saving.
app.post("/api/onboarding/ai", async (req, res) => {
  if (!closerOk(req) && !csOk(req)) return res.status(403).json({ error: "no auth" });
  const b = req.body || {};
  const facts = [
    b.biz ? `Negocio: ${b.biz}` : "",
    b.city ? `Ciudad/área: ${b.city}` : "",
    b.years ? `Años en el negocio: ${b.years}` : "",
    b.rough ? `Notas del agente: ${b.rough}` : "",
  ].filter(Boolean).join("\n").slice(0, 1000);
  if (!facts) return res.status(400).json({ error: "faltan datos" });
  if (!aiLive) return res.json({ source: "demo", error: "ai_off" });
  try {
    const raw = await aiChat({
      maxTokens: 400,
      system: `Eres redactor publicitario para un agente de bienes raíces (realtor) en Texas. Con los datos que te doy, escribe el texto de su página web ${b.lang === "en" ? "EN INGLÉS (the entire output in natural, native English)" : "en español"}, cálido y confiable, enfocado en ayudar a la gente a vender o comprar su casa, sin exagerar ni inventar datos que no te dieron. Responde SOLO con un objeto JSON: {"hero": titular corto y fuerte (máx 6 palabras), "tagline": una frase de apoyo (máx 18 palabras), "about": párrafo de "nuestra historia" en 2-3 oraciones, en primera persona del agente}. Nada de markdown, nada de comillas tipográficas.`,
      messages: [{ role: "user", content: facts }],
    });
    const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
    res.json({
      source: "live",
      hero: String(j.hero || "").slice(0, 120),
      tagline: String(j.tagline || "").slice(0, 200),
      about: String(j.about || "").slice(0, 800),
    });
  } catch (e) {
    console.error("onboarding ai failed:", e.message);
    res.status(502).json({ error: "ai_failed" });
  }
});

// Check domain availability (RDAP) so clients can pick a name on the call.
function domainCandidates(input) {
  const raw = String(input || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*/, "");
  if (/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(raw)) return [raw]; // full domain given
  const base = raw.replace(/[^a-z0-9]/g, "");
  if (!base || base.length < 2) return [];
  const variations = [base + ".com", base + ".net", base + ".co", "get" + base + ".com"];
  variations.push(/realty|homes|realtor|properties/.test(base) ? base + "tx.com" : base + "realty.com");
  return variations.filter((d, i, a) => a.indexOf(d) === i).slice(0, 6);
}
async function rdapAvailable(domain) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    const r = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    if (r.status === 404) return "available";
    if (r.status === 200) return "taken";
    return "unknown";
  } catch { return "unknown"; }
}
app.get("/api/onboarding/domaincheck", async (req, res) => {
  if (!closerOk(req) && !csOk(req)) return res.status(403).json({ error: "no auth" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`dchk:${ip}`, 60)) return res.status(429).json({ error: "quota" });
  const cands = domainCandidates(req.query.name);
  if (!cands.length) return res.status(400).json({ error: "escribe un nombre" });
  const results = await Promise.all(cands.map(async (d) => ({ domain: d, status: await rdapAvailable(d) })));
  res.json({ ok: true, results });
});

// Connect a client's own domain (Cloudflare for SaaS). Saves it, registers
// the custom hostname, and returns the CNAME the client must add.
app.post("/api/onboarding/domain", async (req, res) => {
  if (!closerOk(req) && !csOk(req)) return res.status(403).json({ error: "no auth" });
  const c = req.body?.slug && (await db.getContractorBySlug(String(req.body.slug)));
  if (!c) return res.status(404).json({ error: "cliente no encontrado" });
  let domain = String(req.body.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (req.body.domain === "") { // clearing it
    const data = { ...(c.data || {}) }; data.site = { ...(data.site || {}) }; delete data.site.domain;
    await db.saveContractorData(c.id, data);
    return res.json({ ok: true, domain: null });
  }
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain) || domain.length > 80) return res.status(400).json({ error: "dominio no válido" });
  if (ROOT_DOMAIN && domain.endsWith(`.${ROOT_DOMAIN}`)) return res.status(400).json({ error: "ese es un subdominio nuestro, no un dominio propio" });
  const data = { ...(c.data || {}) };
  data.site = { ...(data.site || {}), domain };
  await db.saveContractorData(c.id, data);
  const cf = await cfAddHostname(domain);
  res.json({ ok: true, domain, cname_target: CF_CNAME_TARGET, cf });
});

// Reveal/unpublish a client's site (staff controls the "unveiling" moment)
app.post("/api/onboarding/publish", async (req, res) => {
  if (!closerOk(req) && !csOk(req)) return res.status(403).json({ error: "no auth" });
  const c = req.body?.slug && (await db.getContractorBySlug(String(req.body.slug)));
  if (!c) return res.status(404).json({ error: "cliente no encontrado" });
  const data = { ...(c.data || {}) };
  data.site = { ...(data.site || {}), published: req.body.publish !== false };
  await db.saveContractorData(c.id, data);
  res.json({ ok: true, published: data.site.published });
});

/* ── Team onboarding deck (/equipo) — shown to a new content+closer hire ──
 * Explains the offer, the audience, his two roles (closer + content), and
 * the exact content shot-list. Unlisted, no login (safe to screen-share). */
/* ── Team onboarding deck (/equipo) — shown to a new content+closer hire ──
 * Showcase version: live website mockups, live app, live cotizador — the
 * actual products he sells and films. Unlisted, no login. */
app.get("/equipo", (req, res) => {
  const base = canonBase(req);
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick Comp · Equipo</title><link rel="icon" href="/icon-192.png"><style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;0,9..144,700;1,9..144,600&family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0;-webkit-tap-highlight-color:transparent}
:root{--navy:#101B30;--navy2:#0B1226;--gold:#C9973A;--mut:#9DA8C4;--line:rgba(255,255,255,.1)}
body{background:var(--navy2);color:#fff;overflow:hidden}
.layout{display:flex;height:100vh;height:100dvh}
aside{width:260px;background:#fff;border-right:1px solid #E9EAEE;display:flex;flex-direction:column;flex-shrink:0}
.sb-brand{display:flex;justify-content:center;padding:24px 18px 14px}.sb-brand img{height:54px}
.sb-label{font-size:10px;letter-spacing:2.5px;color:#9AA0AC;font-weight:800;padding:8px 18px 6px}
nav{flex:1;overflow-y:auto;display:flex;flex-direction:column}
.nav-it{flex:1;display:flex;align-items:center;gap:12px;background:none;border:none;color:#6A7384;font-weight:700;font-size:14.5px;padding:0 20px;cursor:pointer;text-align:left;border-left:4px solid transparent;min-height:42px}
.nav-it .no{font-family:'Fraunces',Georgia,serif;font-size:12px;color:#B6BCC8;width:20px}
.nav-it.on{color:#101B30;background:rgba(201,151,58,.13);border-left-color:var(--gold)}
.nav-it.on .no{color:#B07A00}
.sb-foot{padding:13px 18px;font-size:11px;color:#9AA0AC;font-weight:700;border-top:1px solid #E9EAEE}
main{flex:1;position:relative;display:flex;flex-direction:column;min-width:0}
.stage{flex:1;position:relative;overflow:hidden}
.slide{position:absolute;inset:0;display:none;flex-direction:column;overflow-y:auto}
.slide.on{display:flex}
.s-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.32;filter:saturate(.6)}
.s-veil{position:absolute;inset:0;background:linear-gradient(160deg,rgba(11,18,38,.96) 0%,rgba(16,27,48,.85) 55%,rgba(16,27,48,.6) 100%)}
.s-in{position:relative;flex:1;display:flex;flex-direction:column;justify-content:center;padding:clamp(26px,5vw,70px);max-width:1180px}
.kick{color:var(--gold);font-weight:800;font-size:12px;letter-spacing:3.5px;margin-bottom:16px;text-transform:uppercase}
h1{font-family:'Fraunces',Georgia,serif;font-size:clamp(30px,4.6vw,56px);line-height:1.05;font-weight:700;max-width:760px}
h1 em{font-style:italic;color:var(--gold)}
.rule{width:54px;height:4px;background:var(--gold);border-radius:2px;margin:20px 0}
.body{color:var(--mut);font-weight:500;font-size:clamp(15px,1.8vw,18px);line-height:1.7;max-width:580px}
ul.pts{list-style:none;padding:0;margin:20px 0 0;max-width:720px}
ul.pts li{padding:12px 0;border-bottom:1px solid var(--line);font-weight:600;font-size:clamp(14px,1.8vw,17px);line-height:1.55;color:#E7ECF6;display:flex;gap:14px}
ul.pts li b{color:var(--gold);flex-shrink:0}
.grid{display:grid;gap:14px;margin-top:22px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));max-width:920px}
.card{background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:18px;padding:20px}
.card .ic{font-size:28px}.card h3{font-family:'Fraunces',Georgia,serif;font-size:18px;margin:8px 0 6px}
.card p{color:var(--mut);font-size:13px;font-weight:500;line-height:1.55}
.glass{display:flex;gap:clamp(18px,4vw,52px);background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:18px;padding:18px 26px;margin-top:26px;width:fit-content;flex-wrap:wrap}
.glass b{font-family:'Fraunces',Georgia,serif;font-size:clamp(22px,2.6vw,32px);color:var(--gold);display:block;font-weight:700}
.glass span{font-size:11px;letter-spacing:1.5px;color:#C9D2E5;font-weight:700;text-transform:uppercase}
.link{display:inline-block;margin:8px 8px 0 0;background:var(--gold);color:var(--navy);font-weight:800;font-size:14px;padding:12px 20px;border-radius:11px;text-decoration:none}
.link.ghost{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.3)}
.duo{display:grid;gap:38px;align-items:center;margin-top:8px}
@media(min-width:980px){.duo{grid-template-columns:1fr auto}}
.devices{display:flex;align-items:center;gap:30px;flex-wrap:wrap;margin-top:10px}
.webframe{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.5);width:min(560px,100%)}
.webframe .bar{display:flex;align-items:center;gap:6px;background:#E9EAEE;padding:8px 12px}
.webframe .dot{width:9px;height:9px;border-radius:50%;background:#C9CDD6}
.webframe .url{flex:1;background:#fff;border-radius:7px;font-size:11px;color:#5E6470;font-weight:600;padding:4px 10px;margin-left:8px}
.dscr{width:100%;height:400px;overflow:hidden}
.dscr iframe{width:1180px;height:846px;border:0;transform:scale(.474);transform-origin:0 0;display:block;background:#fff}
.iphone{position:relative;background:#0B1226;border:9px solid #1E2A45;border-radius:44px;padding:10px;box-shadow:0 30px 80px rgba(0,0,0,.55)}
.inotch{position:absolute;top:10px;left:50%;transform:translateX(-50%);width:100px;height:20px;background:#1E2A45;border-radius:0 0 12px 12px;z-index:2}
.mscr{width:300px;height:600px;overflow:hidden;border-radius:30px}
.mscr iframe{width:390px;height:780px;border:0;transform:scale(.769);transform-origin:0 0;background:#fff}
.frame{background:#fff;border-radius:20px;padding:8px;width:min(380px,100%);box-shadow:0 30px 80px rgba(0,0,0,.5)}
.frame iframe{width:100%;height:min(54vh,500px);border:0;border-radius:14px;display:block;background:#F4F6FA}
.bbar{display:flex;align-items:center;justify-content:space-between;padding:14px clamp(16px,3vw,30px);border-top:1px solid var(--line);background:var(--navy)}
.bbar button{border-radius:11px;font-weight:800;font-size:14px;padding:12px 22px;cursor:pointer}
.bbar .prev{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.25)}
.bbar .next{background:var(--gold);color:var(--navy);border:none}
.bbar .ct{font-family:'Fraunces',Georgia,serif;font-size:15px;color:var(--mut)}
.mtop{display:none;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--navy);border-bottom:1px solid var(--line)}
.mtop button{background:none;border:1.5px solid rgba(255,255,255,.25);color:#fff;border-radius:10px;padding:8px 14px;font-weight:800;font-size:13px;cursor:pointer}
@media(max-width:899px){aside{position:fixed;z-index:60;left:0;top:0;bottom:0;transform:translateX(-100%);transition:.25s;width:250px}aside.open{transform:none}.mtop{display:flex}.scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:55;display:none}.scrim.on{display:block}}
</style></head><body>
<div class="layout">
<aside id="sb"><div class="sb-brand"><img src="/brand-logo.png" alt=""></div><div class="sb-label">QUICK COMP</div><nav id="nav"></nav><div class="sb-foot">Presentación del rol</div></aside>
<div class="scrim" id="scrim" onclick="sb(false)"></div>
<main>
<div class="mtop"><button onclick="sb(true)">☰ Menú</button><b style="font-weight:800">QUICK <span style="color:#C9973A">COMP</span></b><span style="width:64px"></span></div>
<div class="stage" id="stage">

<section class="slide" data-t="El rol">
  <img class="s-bg" src="/api/roofimg?lat=26.3828&lng=-98.8198&zoom=17" alt=""><div class="s-veil"></div>
  <div class="s-in">
    <p class="kick">QUICK COMP · MARKETING Y TECNOLOGÍA PARA AGENTES DE BIENES RAÍCES</p>
    <h1>Dos trabajos, <em>un solo rol.</em></h1>
    <div class="rule"></div>
    <p class="body">El rol combina dos cosas: <b style="color:#fff">cerrar ventas</b> y <b style="color:#fff">crear el contenido</b> que trae esos clientes. En esta presentación vas a ver, en vivo, los productos que venderías y grabarías.</p>
  </div>
</section>

<section class="slide" data-t="A quién le vendes">
  <div class="s-veil"></div>
  <div class="s-in">
    <p class="kick">01 · A QUIÉN LE VENDES</p>
    <h1>Agentes hispanos <em>de bienes raíces.</em></h1>
    <div class="rule"></div>
    <ul class="pts">
      <li><b>🇲🇽</b> Hablan español, trabajan por relación, odian la tecnología complicada</li>
      <li><b>📞</b> Consiguen clientes por recomendación — pero pierden vendedores que no saben que su casa ya subió de valor</li>
      <li><b>💵</b> Una comisión les deja miles de dólares — tienen con qué pagar</li>
      <li><b>🎯</b> Empezamos SOLO con agentes hispanos — enfocados</li>
    </ul>
    <p class="body" style="margin-top:16px"><b style="color:var(--gold)">Háblales como un amigo que entiende su negocio — no como vendedor de tecnología.</b></p>
  </div>
</section>

<section class="slide" data-t="Qué vendemos">
  <div class="s-veil"></div>
  <div class="s-in">
    <p class="kick">02 · QUÉ VENDEMOS</p>
    <h1>Una máquina que <em>trae clientes.</em></h1>
    <div class="rule"></div>
    <div class="grid">
      <div class="card"><div class="ic">🌐</div><h3>Página web</h3><p>Profesional, con su marca. Lista en 10-14 días.</p></div>
      <div class="card"><div class="ic">🏡</div><h3>Valuador de casas</h3><p>El dueño pone su dirección y ve el valor de su casa en 10 seg.</p></div>
      <div class="card"><div class="ic">📲</div><h3>La app Quick Comp</h3><p>Valúa casas, arma el CMA, recibe los leads.</p></div>
      <div class="card"><div class="ic">🤖</div><h3>Secretaria IA</h3><p>Contesta y agenda citas a cualquier hora.</p></div>
    </div>
    <div class="glass"><div><b>desde $67</b><span>al mes</span></div><div><b>$0</b><span>costo de inicio</span></div></div>
  </div>
</section>

<section class="slide" data-t="La página (en vivo)">
  <div class="s-veil"></div>
  <div class="s-in">
    <p class="kick">03 · SU PÁGINA WEB · EN VIVO</p>
    <h1>Esto es lo que <em>reciben.</em></h1>
    <p class="body" style="margin-top:12px">Se ve perfecta en computadora y celular. Esto es lo que vas a mostrar en tus videos — haz scroll, está viva.</p>
    <div class="devices">
      <div class="webframe"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">tunegocio.com</span></div><div class="dscr"><iframe data-src="/ejemplo?embed=1" title="Web"></iframe></div></div>
      <div class="iphone"><div class="inotch"></div><div class="mscr"><iframe data-src="/ejemplo?embed=1" title="Móvil"></iframe></div></div>
    </div>
  </div>
</section>

<section class="slide" data-t="El valuador (wow)">
  <div class="s-veil"></div>
  <div class="s-in" style="max-width:1000px">
    <p class="kick">04 · EL VALUADOR · EL WOW</p>
    <h1>Pon una <em>dirección.</em></h1>
    <div class="duo">
      <div>
        <p class="body">El momento "wow" de toda la venta. Escribe una dirección real y mira cómo aparece el valor de la casa con ventas comparables reales. ESTO es lo que grabas para los anuncios.</p>
        <a class="link" href="/demo" target="_blank">Ver la presentación de venta →</a>
      </div>
      <div class="frame"><iframe data-src="/w/alto-demo" title="Valuador"></iframe></div>
    </div>
  </div>
</section>

<section class="slide" data-t="La app (en vivo)">
  <div class="s-veil"></div>
  <div class="s-in" style="max-width:1000px">
    <p class="kick">05 · LA APP · EN VIVO</p>
    <h1>Su oficina, <em>en el bolsillo.</em></h1>
    <div class="duo">
      <div>
        <ul class="pts" style="margin-top:0">
          <li><b>🏡</b> Valúa casas: dirección o GPS, con ventas comparables reales</li>
          <li><b>📥</b> Los leads le llegan con botón de WhatsApp</li>
          <li><b>🧾</b> Reportes CMA profesionales con su marca</li>
        </ul>
        <p class="body" style="font-size:14px;margin-top:14px">👉 La app de la derecha está EN VIVO — tócala.</p>
      </div>
      <div class="iphone"><div class="inotch"></div><div class="mscr"><iframe data-src="/?demo=app" title="App"></iframe></div></div>
    </div>
  </div>
</section>

<section class="slide" data-t="Tu rol: Closer">
  <div class="s-veil"></div>
  <div class="s-in">
    <p class="kick">06 · TU PRIMER TRABAJO · CERRAR</p>
    <h1>Cómo <em>cierras.</em></h1>
    <div class="rule"></div>
    <ul class="pts">
      <li><b>1</b> El prospecto agenda una llamada (de los anuncios que TÚ grabas)</li>
      <li><b>2</b> Compartes pantalla y caminas la presentación: <b style="color:#fff">/demo</b></li>
      <li><b>3</b> En vivo pones SU dirección y le valúas SU casa — ahí cambia todo</li>
      <li><b>4</b> Le mandas el link de pago y cierras en la misma llamada</li>
    </ul>
    <p class="body" style="margin-top:14px">Tu portal privado tiene el guion, los links y las respuestas a objeciones:</p>
    <a class="link" href="/closer" target="_blank">Abrir el portal del closer →</a>
  </div>
</section>

<section class="slide" data-t="Tu rol: Contenido">
  <div class="s-veil"></div>
  <div class="s-in" style="max-width:1000px">
    <p class="kick">07 · TU SEGUNDO TRABAJO · CONTENIDO</p>
    <h1>El contenido que <em>trae clientes.</em></h1>
    <div class="rule"></div>
    <p class="body">Corremos anuncios en WhatsApp e Instagram/Facebook, en español, para agentes. Tu contenido es el motor del negocio.</p>
    <div class="grid">
      <div class="card"><div class="ic">🎬</div><h3>Anuncios cortos (9:16)</h3><p>15-40 seg para WhatsApp/Reels. Hook fuerte en los primeros 3 seg.</p></div>
      <div class="card"><div class="ic">🎥</div><h3>VSL (1-2 min)</h3><p>Video para la página explicando la oferta — tú a cámara, directo.</p></div>
      <div class="card"><div class="ic">📱</div><h3>Grabación de pantalla</h3><p>Valuando una casa en 10 seg — el wow en video.</p></div>
      <div class="card"><div class="ic">📸</div><h3>Fotos del equipo</h3><p>Tú y el equipo con la camisa Quick Comp, profesionales.</p></div>
    </div>
  </div>
</section>

<section class="slide" data-t="Lista de contenido">
  <div class="s-veil"></div>
  <div class="s-in" style="max-width:1000px">
    <p class="kick">08 · TUS PRIMEROS VIDEOS</p>
    <h1>Lista para <em>grabar ya.</em></h1>
    <ul class="pts">
      <li><b>🎯</b> "¿Cuántos vendedores pierdes porque no saben lo que vale su casa?" — hook de dolor, a cámara</li>
      <li><b>🏡</b> "Mira cómo valúo una casa en 10 segundos con ventas reales" — grabación de pantalla</li>
      <li><b>💬</b> "Tus clientes te llegan directo al WhatsApp" — muestra el lead llegando</li>
      <li><b>🌐</b> "Tu página web vende sola, 24/7" — muestra la página de ejemplo</li>
      <li><b>🤖</b> "Una secretaria con IA que nunca duerme" — muestra el chat contestando</li>
    </ul>
    <p class="body" style="margin-top:12px">Regla de oro: <b style="color:#fff">habla como agente, no como tecnología.</b></p>
  </div>
</section>

<section class="slide" data-t="Empecemos">
  <img class="s-bg" src="/api/roofimg?lat=26.3828&lng=-98.8198&zoom=18" alt=""><div class="s-veil"></div>
  <div class="s-in">
    <p class="kick">09 · EMPECEMOS</p>
    <h1>Manos a la <em>obra.</em></h1>
    <div class="rule"></div>
    <ul class="pts">
      <li><b>1</b> Explora la presentación de venta y el portal del closer</li>
      <li><b>2</b> Graba los primeros 3 anuncios de la lista esta semana</li>
      <li><b>3</b> Agenda la foto del equipo con la camisa Quick Comp</li>
    </ul>
    <div style="margin-top:20px">
      <a class="link" href="/demo" target="_blank">/demo · venta</a>
      <a class="link ghost" href="/closer" target="_blank">/closer · portal</a>
      <a class="link ghost" href="/ventas" target="_blank">/ventas · la página</a>
      <a class="link ghost" href="/plantillas" target="_blank">/plantillas</a>
    </div>
  </div>
</section>

</div>
<div class="bbar"><div><button class="prev" onclick="go(-1)">‹ Anterior</button> <button class="next" onclick="go(1)">Siguiente ›</button></div><span class="ct" id="ct">1 / 10</span></div>
</main></div>
<script>
var slides=[].slice.call(document.querySelectorAll('.slide')),cur=0,nav=document.getElementById('nav');
slides.forEach(function(s,i){var b=document.createElement('button');b.className='nav-it';b.innerHTML='<span class="no">'+String(i+1).padStart(2,'0')+'</span>'+s.dataset.t;b.onclick=function(){show(i);sb(false)};nav.appendChild(b);});
function show(i){cur=Math.max(0,Math.min(slides.length-1,i));slides.forEach(function(s,k){s.classList.toggle('on',k===cur)});[].slice.call(nav.children).forEach(function(b,k){b.classList.toggle('on',k===cur)});document.getElementById('ct').textContent=(cur+1)+' / '+slides.length;[].slice.call(slides[cur].querySelectorAll('iframe[data-src]')).forEach(function(f){if(!f.src)f.src=f.dataset.src});location.hash=cur+1;}
function go(d){show(cur+d)}
function sb(o){document.getElementById('sb').classList.toggle('open',o);document.getElementById('scrim').classList.toggle('on',o)}
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight')go(1);if(e.key==='ArrowLeft')go(-1)});
show(parseInt(location.hash.slice(1))-1||0);
</script>
</body></html>`);
});


/* ── Sales presentation (/demo — used AFTER a call is booked) ──
 * Full-screen slides the closer walks through with the prospect: who we
 * are → the problem → live demo → the app → what's included → price →
 * close, ending with copy-paste links to send during the call. */
// Closer: crear cliente nuevo + access link (no other admin powers)
// Closer logs a meeting / marks its outcome (visible to admin too)
app.post("/api/closer/meeting", async (req, res) => {
  if (!closerOk(req)) return res.status(403).json({ error: "no auth" });
  const name = String(req.body?.name || "").slice(0, 80);
  const phone = String(req.body?.phone || "").replace(/\D/g, "").slice(0, 15);
  if (!name && !phone) return res.status(400).json({ error: "falta nombre o teléfono" });
  const id = await db.addMeeting({ name, phone });
  res.json({ ok: true, id });
});
app.post("/api/closer/meeting/:id", async (req, res) => {
  if (!closerOk(req)) return res.status(403).json({ error: "no auth" });
  const id = String(req.params.id);
  if (typeof req.body?.outcome === "string") {
    const outcome = ["scheduled", "no_show", "showed", "closed"].includes(req.body.outcome) ? req.body.outcome : "scheduled";
    await db.setMeetingOutcome(id, outcome);
  }
  if (typeof req.body?.note === "string") {
    await db.setMeetingNote(id, req.body.note.slice(0, 500));
  }
  res.json({ ok: true });
});

/* Inbound lead from the sales WhatsApp bot (HighLevel webhook).
 * Secured by HL_WEBHOOK_SECRET so only your HighLevel can post.
 * Auto-creates a meeting so the closer never re-types a lead by hand. */
app.post("/api/hl/lead", async (req, res) => {
  const secret = process.env.HL_WEBHOOK_SECRET || "";
  const got = String(req.query.key || req.get("x-alto-key") || req.body?.key || "");
  if (!secret || got !== secret) return res.status(403).json({ error: "no auth" });
  const b = req.body || {};
  const name = String(b.name || b.full_name || b.first_name || "").slice(0, 80);
  const phone = String(b.phone || b.phone_number || b.number || "").replace(/\D/g, "").slice(0, 15);
  // Which GHL channel the lead was born on (whatsapp | instagram | facebook) —
  // set as custom data on the GHL workflow's webhook action (see playbook/03-ghl).
  const CHANNELS = { whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Messenger", messenger: "Messenger" };
  const channel = CHANNELS[String(b.channel || "").toLowerCase()] || "";
  const note = String(b.note || b.message || (channel ? `Came in via ${channel}` : "Came in via GHL")).slice(0, 500);
  if (!name && !phone) return res.status(400).json({ error: "missing name/phone" });
  // de-dupe: same phone (last 10 digits) in the last 24h → don't create a twin.
  // GHL fires Contact Created + channel events for the same person minutes or
  // hours apart; 24h is the ALTO-proven window that kills the twins without
  // ever hiding a genuinely new conversation the next day.
  try {
    const recent = await db.listMeetings(200);
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const p10 = phone.slice(-10);
    const dup = recent.find((m) => {
      const mp = String(m.phone || "").replace(/\D/g, "").slice(-10);
      return p10 && mp === p10 && new Date(m.created_at).getTime() > cutoff;
    });
    if (dup) return res.json({ ok: true, deduped: true, id: dup.id });
  } catch { /* if the lookup fails, fall through and just create it */ }
  const id = await db.addMeeting({ name, phone, note: channel && !b.note && !b.message ? note : (channel ? `[${channel}] ${note}` : note) });
  res.json({ ok: true, id, ...(channel ? { channel } : {}) });
});

app.post("/api/closer/contractors", async (req, res) => {
  if (!closerOk(req)) return res.status(403).send("Clave incorrecta.");
  const { name, phone } = req.body || {};
  if (!name) return res.status(400).send("Falta el nombre del negocio.");
  const c = await db.createContractor({ name, phone });
  // Closer accounts activate only with money: a Stripe payment in the last
  // 48h matching this phone activates now; otherwise the access link waits.
  const digits = String(phone || "").replace(/\D/g, "").replace(/^1/, "");
  const paid = digits ? await db.kvGet(`paid:${digits}`, 48 * 3600 * 1000).catch(() => null) : null;
  const cData = paid
    ? { payStatus: "ok", ...(paid.customerId ? { stripeCustomer: paid.customerId } : {}), ...(paid.plan ? { plan: paid.plan, planAmount: paid.planAmount } : {}) }
    : { payStatus: "pending" };
  await db.saveContractorData(c.id, cData);
  const invite = await db.createInvite(c.id);
  const base = canonBase(req);
  const K = encodeURIComponent(String(req.query.key || req.body?.key || ""));
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cliente creado</title>
<style>body{font-family:Arial;max-width:560px;margin:40px auto;padding:0 16px;color:#101B30}h2{margin-bottom:6px}
.link{background:#F7EFD8;border:2px solid #C9973A;border-radius:12px;padding:13px;word-break:break-all;font-size:14px;margin:10px 0;display:flex;gap:10px;align-items:center}
.link button{margin-left:auto;background:#C9973A;color:#101B30;border:none;border-radius:8px;padding:8px 14px;font-weight:800;cursor:pointer;flex-shrink:0}
a{color:#B57E00;font-weight:800}small{color:#67718A}</style></head><body>
<h2>✓ Cliente creado: ${String(c.name).replace(/</g, "&lt;")}</h2>
${paid
  ? `<p style="background:#EAF8EF;border:1.5px solid #34A853;color:#1E7B3C;border-radius:12px;padding:10px 14px;font-weight:700">✅ Pago confirmado — la cuenta está ACTIVA.</p>`
  : `<p style="background:#F7EFD8;border:1.5px solid #C9973A;color:#7A5A00;border-radius:12px;padding:10px 14px;font-weight:700">⏳ El link de acceso se ACTIVA solo cuando Stripe confirme su pago (≈1 min después de pagar). Si pagó por otro medio, el admin la activa desde su tablero.</p>`}
<p><b>1.</b> Copia su <b>link de acceso</b> y pégalo en el mensaje de bienvenida (tecla B en la presentación):</p>
<div class="link"><span><b>🔑 Acceso a su app</b><br><small>${base}/invite/${invite}</small></span><button onclick="navigator.clipboard.writeText('${base}/invite/${invite}');this.textContent='✓'">Copiar</button></div>
<p><b>2.</b> Su valuador (va dentro de su página web):</p>
<div class="link"><span><b>🏡 Widget</b><br><small>${base}/w/${c.slug}</small></span><button onclick="navigator.clipboard.writeText('${base}/w/${c.slug}');this.textContent='✓'">Copiar</button></div>
<p><b>3.</b> Personaliza su página web (plantilla, color, fotos):</p>
<div class="link"><span><b>🎨 Onboarding de su página</b></span><a href="/onboarding?key=${K}&slug=${c.slug}" style="margin-left:auto;background:#C9973A;color:#101B30;border-radius:8px;padding:8px 14px;font-weight:800;text-decoration:none">Abrir →</a></div>
<a href="/closer?key=${K}">← Volver al portal del closer</a></body></html>`);
});

/* ── Closer portal (/closer) — crear cliente nuevo + toolkit, nothing else ── */
app.get("/closer", async (req, res) => {
  if (!CLOSER_KEY && !ADMIN_KEY) return res.status(503).send("Set CLOSER_KEY env var to enable.");
  if (req.query.logout != null) { clearKeyCookie(res, "alto_closer"); return res.redirect("/closer"); }
  const qk = req.query.key;
  if (qk && ((CLOSER_KEY && safeEq(qk, CLOSER_KEY)) || (ADMIN_KEY && safeEq(qk, ADMIN_KEY)))) {
    setKeyCookie(res, "alto_closer", qk);
    return res.redirect("/closer" + (req.query.lang === "en" ? "?lang=en" : ""));
  }
  if (!closerOk(req)) return res.status(qk ? 403 : 401).send(loginPage("Portal del closer", "/closer", !!qk));
  const base = canonBase(req);
  const ck = reqCookies(req);
  const K = encodeURIComponent(String(ck.alto_closer || ck.alto_admin || qk || ""));
  const en = req.query.lang === "en";
  // meeting stats + log (closer's dashboard numbers), filtered by month/range
  const range = periodRange(req.query, en);
  const mst = await db.meetingStats(range).catch(() => ({ total: 0, scheduled: 0, noShow: 0, showed: 0, closed: 0 }));
  const meetings = await db.listMeetings(40, range).catch(() => []);
  const clientCount = (await db.listContractors().catch(() => [])).filter((c) => !["alto-demo", "alto-ventas"].includes(c.slug)).length;
  const closeRate = mst.total ? Math.round((mst.closed / mst.total) * 100) : 0;
  const stripeLink = process.env.STRIPE_PAYMENT_LINK || "";
  // All three plan links so a closer can charge the plan they actually sold —
  // not just Complete. Unconfigured tiers are simply omitted.
  const payTiers = [
    ["Pro", 67, process.env.STRIPE_PAYMENT_LINK_PRO || ""],
    ["Widget", 197, process.env.STRIPE_PAYMENT_LINK_WIDGET || ""],
    ["Complete", 297, stripeLink],
  ].filter(([, , lnk]) => lnk);
  const wMsg = en
    ? `Check this out 👀 — type your address and see what your customers would see on YOUR website:\n${base}/w/alto-demo`
    : `Mira esto 👀 — escribe tu dirección y ve lo que tus clientes verían en TU página web:\n${base}/w/alto-demo`;
  const welcome = en
    ? `Congratulations and welcome to Quick Comp! 🎉 Tap this link from your phone and save it — it's your personal key to your app: [PASTE THEIR ACCESS LINK HERE]. You can value homes and build CMAs starting today. See you at your onboarding call 💪`
    : `¡Felicidades y bienvenido a Quick Comp! 🎉 Toca este link desde tu teléfono y guárdalo — es tu llave personal a tu app: [PEGA AQUÍ SU LINK DE ACCESO]. Hoy mismo puedes valuar casas y armar CMAs. Nos vemos en tu llamada de onboarding 💪`;
  const esc = (x) => String(x).replace(/</g, "&lt;");
  const L = en ? {
    title: "Closer portal", langBtn: "🇲🇽 Español", langQ: "",
    warn: "⚠️ Private page — NEVER screen-share it. The client-facing presentation is /demo.",
    altaT: "➕ Create new client (while they pay)",
    altaName: "Business name", altaPhone: "Phone (the SAME one they use in Stripe)", altaBtn: "Create account",
    altaTip: "💡 Use the same phone the client enters at checkout — their payments connect to their account automatically.",
    playT: "The close, step by step (all on the same call)",
    play: ["Press <b>P</b> in the presentation → payment link copied → send it on WhatsApp.", "While they pay: <b>create their account above</b> and copy their access link.", "Press <b>B</b> → welcome message copied → paste their access link → send it.", "Book their <b>onboarding</b> before hanging up."],
    linksT: "Links & messages",
    payT: "💳 Payment link — $297/mo (Complete) · no setup fee", payMissing: "Not configured yet (STRIPE_PAYMENT_LINK in Render).",
    welT: "👋 Welcome (paste their access link)", demoT: "🏡 Valuator demo", demoMsgT: "👀 Demo message",
    open: "Open", copy: "Copy",
    scriptT: "🎤 Talk track — what you say on each slide",
    script: [
      ["01 · Welcome", "“Thanks for booking. In 10 minutes you'll see a home valued from real comparable sales. If it's not for you, no problem. Sound good?”"],
      ["02 · Who we are", "“Before I show you anything: the owner runs construction and tech companies in Texas. He built this tool for his own deals — and uses it today for his own company. We're not an agency reselling software.”"],
      ["03 · The problem", "“Quick question: how many sellers do you lose because they don't know their home already went up in value? … Most list with whoever shows them a number first. You don't lack contacts — you lack a system that brings sellers to you.”"],
      ["04 · Your website", "“This is what YOUR site would look like — phone and computer. Now the good part: type YOUR address in the valuator. (wait for the wow — say nothing) That feeling? That's what your sellers will feel.”"],
      ["05 · Your app", "“This app is your office. The one on the right is LIVE — tap VALUE A HOME. Every lead hits your phone with WhatsApp ready. Neighbor asks what theirs is worth? You value it standing right there and send a CMA.”"],
      ["06 · AI secretary", "“Text it like you're a homeowner thinking of selling. (let them try) This same AI answers YOUR leads at 11pm and books the appointment. You just show up.”"],
      ["07 · Investment", "“Separately this runs $1,500 plus monthlies. With us there are three plans and ZERO setup fees: 67 for the app, 197 if you already have a website — we put the valuator in it — or 297 and we build the whole site for you. One commission is thousands of dollars — ONE extra deal pays your whole year. (silence — let them talk first)”"],
      ["08 · Let's begin", "“This starts today: you pay, I send your app by WhatsApp before we hang up, and we book your onboarding. Want me to send the payment link?”"],
    ],
    keysT: "⌨️ Secret shortcuts in the presentation (/demo)",
    keys: ["<b>Double-click the counter</b> or press <b>C</b> → closer panel", "<b>P</b> payment link · <b>B</b> welcome · <b>D</b> demo message · <b>O</b> open checkout"],
    keysWarn: "⚠️ If you share your FULL SCREEN, the Stripe tab is visible. Share only the /demo tab.",
    objT: "Objections & comebacks",
    obj: [
      ["\"It's expensive\"", "“One commission is thousands of dollars in your pocket. ONE extra deal a year and this paid for itself.”"],
      ["\"I already have a website\"", "“Does it put sellers' phone numbers in your pocket with their home already valued? Your current site is the business card; this one sells.”"],
      ["\"Let me think about it\"", "“What do you want to think over — the price, or whether it works? (resolve it). I'll hold today's price for you.”"],
      ["\"I need to talk to my wife/partner\"", "“Perfect. Let's book 10 minutes tomorrow with both of you and I'll show them the same demo. What time works?”"],
      ["\"My clients come from referrals\"", "“And what do people do with a referral? They Google you before calling. This turns your referrals into appointments.”"],
      ["\"I'm not good with technology\"", "“If you can send a WhatsApp, you can use Quick Comp. We do the onboarding with you, step by step.”"],
      ["\"What if it doesn't work for me?\"", "“No long contracts: cancel anytime and your domain leaves with you — it's in the contract.”"],
      ["\"It's slow season / no money right now\"", "“That's exactly why: your site gets built NOW so you're positioned when listings pick up. Building it mid-season is too late.”"],
      ["\"I already have a marketing agency\"", "“We don't compete with them — we give them somewhere to send people. Does their website value homes by itself?”"],
      ["\"Why so cheap?\"", "“It's software we already built — we don't bill agency hours. We win when you stay for months.”"],
      ["\"Internet leads are garbage\"", "“Bought leads, yes. These typed THEIR address and THEIR phone to value THEIR home. It doesn't get warmer than that.”"],
    ],
  } : {
    title: "Portal del closer", langBtn: "🇺🇸 English", langQ: "&lang=en",
    warn: "⚠️ Página privada — NUNCA la compartas en pantalla. La presentación para el cliente es /demo.",
    altaT: "➕ Crear cliente nuevo (mientras paga)",
    altaName: "Nombre del negocio", altaPhone: "Teléfono (el MISMO que usa en Stripe)", altaBtn: "Crear cuenta",
    altaTip: "💡 Usa el mismo teléfono que el cliente pone al pagar — así sus pagos se conectan solos a su cuenta.",
    playT: "El cierre, paso a paso (todo en la misma llamada)",
    play: ["Tecla <b>P</b> en la presentación → link de pago copiado → mándalo por WhatsApp.", "Mientras paga: <b>crea su cuenta aquí arriba</b> y copia su link de acceso.", "Tecla <b>B</b> → bienvenida copiada → pega su link de acceso → envíala.", "Agenda su <b>onboarding</b> antes de colgar."],
    linksT: "Links y mensajes",
    payT: "💳 Link de pago — $297/mes (Complete) · sin costo de inicio", payMissing: "Aún no configurado (STRIPE_PAYMENT_LINK en Render).",
    welT: "👋 Bienvenida (pega su link de acceso)", demoT: "🏡 Demo del valuador", demoMsgT: "👀 Mensaje de demo",
    open: "Abrir", copy: "Copiar",
    scriptT: "🎤 Guion — qué dices en cada slide",
    script: [
      ["01 · Bienvenida", "“Gracias por agendar. En 10 minutos vas a ver una casa valuada con ventas comparables reales. Si no es para ti, no pasa nada. ¿Te parece?”"],
      ["02 · Quiénes somos", "“Antes de enseñarte nada: el dueño tiene compañías de construcción y tecnología en Texas. Esta herramienta la hizo para sus propios negocios — y hoy la usa para su propia compañía. No somos una agencia revendiendo software.”"],
      ["03 · El problema", "“Te pregunto algo: ¿cuántos vendedores pierdes porque no saben que su casa ya subió de valor? … La mayoría lista con el primero que les enseña un número. No te faltan contactos — te falta un sistema que te traiga vendedores.”"],
      ["04 · Tu página", "“Así se vería TU página — en celular y computadora. Ahora lo bueno: pon TU dirección en el valuador. (espera el wow — no digas nada) ¿Eso que sentiste? Eso van a sentir tus vendedores.”"],
      ["05 · Tu app", "“Esta app es tu oficina. La de la derecha está VIVA — toca VALUAR CASA. Cada lead te llega con WhatsApp listo. ¿El vecino te pregunta cuánto vale la suya? La valúas ahí parado y le mandas un CMA.”"],
      ["06 · Secretaria IA", "“Escríbele como si fueras un dueño pensando en vender. (déjalo probar) Esta misma IA le contesta a TUS leads a las 11 de la noche y agenda la cita. Tú solo llegas.”"],
      ["07 · Inversión", "“Por separado esto cuesta $1,500 más mensualidades. Con nosotros hay tres planes y CERO costo de inicio: 67 por la app, 197 si ya tienes página — le ponemos el valuador — o 297 y te hacemos la página completa. Una comisión son miles de dólares — UN cierre extra paga tu año entero. (silencio — deja que hable él primero)”"],
      ["08 · Empecemos", "“Esto empieza hoy: pagas, te mando tu app por WhatsApp antes de colgar, y agendamos tu onboarding. ¿Te mando el link de pago?”"],
    ],
    keysT: "⌨️ Atajos secretos en la presentación (/demo)",
    keys: ["<b>Doble clic en el contador</b> o tecla <b>C</b> → panel del closer", "<b>P</b> link de pago · <b>B</b> bienvenida · <b>D</b> mensaje demo · <b>O</b> abrir el pago"],
    keysWarn: "⚠️ Si compartes la PANTALLA completa, la pestaña de Stripe se ve. Comparte solo la pestaña de /demo.",
    objT: "Objeciones y cómo regresar",
    obj: [
      ["\"Está caro\"", "“Una comisión son miles de dólares en tu bolsillo. Con UN cierre extra al año, esto ya se pagó.”"],
      ["\"Ya tengo página\"", "“¿Y te manda los teléfonos de los vendedores al bolsillo, con su casa ya valuada? Tu página de hoy es la tarjeta; esta es la que vende.”"],
      ["\"Déjame pensarlo\"", "“¿Qué quieres pensar — el precio, o si funciona? (resuélvelo). Te aparto el precio de hoy.”"],
      ["\"Lo hablo con mi esposa/socio\"", "“Perfecto. Agendemos 10 minutos mañana con los dos y les enseño la misma demo. ¿A qué hora pueden?”"],
      ["\"Mis clientes llegan por recomendación\"", "“¿Y qué hace la gente cuando le recomiendan a alguien? Lo busca en Google antes de llamar. Esto convierte tus recomendaciones en citas.”"],
      ["\"No soy bueno con la tecnología\"", "“Si sabes mandar un WhatsApp, sabes usar Quick Comp. El onboarding lo hacemos contigo, paso a paso.”"],
      ["\"¿Y si no me funciona?\"", "“Sin contratos largos: cancelas cuando quieras y tu dominio se va contigo — está en el contrato.”"],
      ["\"Es temporada baja / no hay dinero\"", "“Justo por eso: tu página se construye AHORA para que cuando se mueva el mercado ya estés posicionado. Montarla en plena temporada es llegar tarde.”"],
      ["\"Ya tengo agencia de marketing\"", "“No competimos con ella — le damos a dónde mandar a la gente. ¿Su página valúa casas sola?”"],
      ["\"¿Por qué tan barato?\"", "“Es software que ya construimos — no cobramos horas de agencia. Ganamos cuando te quedas meses.”"],
      ["\"Los leads de internet son basura\"", "“Los comprados, sí. Estos pusieron SU dirección y SU teléfono para ver el valor de SU casa. Más caliente no existe.”"],
    ],
  };
  res.send(`<!doctype html><html lang="${en ? "en" : "es"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick Comp · ${L.title}</title><link rel="icon" href="/icon-192.png"><style>
*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
html{background:#F5F6F8}
body{max-width:680px;margin:0 auto;padding:34px 20px 72px;color:#0B1220;line-height:1.55;letter-spacing:-0.011em}
::selection{background:rgba(201,151,58,.35)}
h1{font-size:26px;font-weight:700;letter-spacing:-0.025em;margin-bottom:18px}
h1 span{color:#B07A00}
h2{font-size:12.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#9097A3;margin:34px 0 12px}
.lang{position:fixed;top:14px;right:16px;background:rgba(16,27,48,.9);backdrop-filter:saturate(180%) blur(14px);-webkit-backdrop-filter:saturate(180%) blur(14px);color:#fff;border-radius:99px;padding:9px 17px;font-weight:700;font-size:13px;text-decoration:none;box-shadow:0 6px 18px rgba(16,27,48,.25)}
.warn{background:#FFF4F4;border:1px solid #F6D5D5;color:#B42318;border-radius:16px;padding:14px 16px;font-weight:600;font-size:13.5px;box-shadow:0 1px 2px rgba(180,35,24,.05)}
.alta{display:flex;gap:10px;flex-wrap:wrap;background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:20px;padding:18px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 12px 30px rgba(16,27,48,.05)}
.alta input{flex:1;min-width:150px;font-family:inherit;padding:13px 15px;border-radius:13px;border:1px solid #E4E7EC;font-size:14.5px;font-weight:500;outline:none;transition:border-color .15s,box-shadow .15s}
.alta input:focus{border-color:#C9973A;box-shadow:0 0 0 4px rgba(201,151,58,.18)}
.alta button{background:#C9973A;color:#101B30;border:none;border-radius:13px;padding:13px 24px;font-weight:700;cursor:pointer;font-size:14.5px;box-shadow:0 6px 16px rgba(201,151,58,.3);transition:transform .12s,filter .15s}
.alta button:hover{filter:brightness(1.03)}.alta button:active{transform:scale(.97)}
ol{padding-left:22px;margin-top:4px}ol li{margin-bottom:10px;font-weight:500;color:#1B2433}
ul{padding-left:22px}ul li{margin-bottom:7px;font-weight:500;color:#1B2433}
small{color:#9097A3}
.sc{background:#fff;border:1px solid rgba(16,27,48,.05);border-left:3px solid #C9973A;border-radius:16px;padding:16px 18px;margin:10px 0;box-shadow:0 1px 2px rgba(16,27,48,.04),0 8px 22px rgba(16,27,48,.045)}
.sc b{display:block;font-size:11px;color:#B07A00;letter-spacing:.8px;text-transform:uppercase;margin-bottom:6px;font-weight:700}
.sc p{font-size:15px;font-style:italic;color:#1B2433;line-height:1.6}
.link{background:#fff;border:1px solid rgba(16,27,48,.06);border-radius:16px;padding:13px 16px;word-break:break-all;font-size:14px;margin:9px 0;display:flex;gap:10px;align-items:center;box-shadow:0 1px 2px rgba(16,27,48,.04),0 8px 22px rgba(16,27,48,.04);transition:box-shadow .18s,transform .18s}
.link:hover{transform:translateY(-1px);box-shadow:0 2px 4px rgba(16,27,48,.06),0 14px 32px rgba(16,27,48,.08)}
.link>span{flex:1;min-width:0}
.link b{font-weight:700}
.link small{color:#9097A3}
.link button{background:#C9973A;color:#101B30;border:none;border-radius:11px;padding:9px 15px;font-weight:700;cursor:pointer;flex-shrink:0;font-size:13px;transition:filter .15s}
.link button:hover{filter:brightness(1.03)}
.ob{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:16px;padding:14px 16px;margin:10px 0;box-shadow:0 1px 2px rgba(16,27,48,.04),0 8px 20px rgba(16,27,48,.04)}
.ob b{font-size:14px;font-weight:700;color:#0B1220}
.ob p{font-size:14px;color:#475067;font-style:italic;margin-top:5px;line-height:1.55}
.lang{position:static}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:14px}
.topbar h1{margin:0}
.topactions{display:flex;gap:8px}
.lang.dark{background:rgba(16,27,48,.92);color:#fff;border:none}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 8px}
.navbtn{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid rgba(16,27,48,.06);border-radius:14px;padding:13px 20px;font-weight:700;font-size:14.5px;color:#0B1220;text-decoration:none;box-shadow:0 1px 2px rgba(16,27,48,.04),0 8px 22px rgba(16,27,48,.05);transition:transform .15s,box-shadow .15s}
.navbtn:hover{transform:translateY(-1px);box-shadow:0 2px 4px rgba(16,27,48,.06),0 14px 30px rgba(16,27,48,.09)}
.navbtn.primary{background:#C9973A;border:none;box-shadow:0 6px 18px rgba(201,151,58,.35)}
.cols{display:grid;gap:24px}
.col>h2:first-child{margin-top:6px}
body{max-width:none;margin:0;padding:0}
.appheader{position:sticky;top:0;z-index:30;background:rgba(16,27,48,.9);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);color:#fff;padding:15px 24px;display:flex;align-items:center;gap:13px;border-bottom:1px solid rgba(255,255,255,.07)}
.appheader img{height:30px;background:#fff;border-radius:9px;padding:4px 6px}
.appheader b{font-size:16px;font-weight:700;letter-spacing:-0.02em}.appheader b em{color:#C9973A;font-style:normal}
.appheader .right{margin-left:auto;display:flex;gap:8px;align-items:center}
.appheader .right a{color:#cdd5e5;text-decoration:none;font-weight:600;font-size:13px;border-radius:99px;padding:7px 14px}
.appheader .right a.dark{background:rgba(255,255,255,.1);color:#fff}
.wrap{max-width:1180px;margin:0 auto;padding:24px 22px 64px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:14px;margin-bottom:8px}
.card{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:20px;padding:18px 20px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 10px 26px rgba(16,27,48,.045)}
.card .v{font-size:30px;font-weight:700;letter-spacing:-0.035em;line-height:1.04}
.card .l{font-size:11px;font-weight:700;color:#9097A3;letter-spacing:.55px;text-transform:uppercase;margin-top:6px}
.card .sub{font-size:11px;font-weight:700;color:#8A94A8;margin-top:4px}
.card.gold{background:linear-gradient(155deg,#16243f 0%,#0d1729 100%);color:#fff;border:none;box-shadow:0 1px 2px rgba(0,0,0,.25),0 20px 48px rgba(16,27,48,.3)}
.card.gold .v{color:#C9973A}.card.gold .l{color:#9DA8C4}
.panel{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:22px;padding:22px 24px;margin:18px 0;box-shadow:0 1px 2px rgba(16,27,48,.04),0 12px 30px rgba(16,27,48,.05)}
.panel>h3{font-size:13px;color:#9097A3;letter-spacing:.6px;text-transform:uppercase;font-weight:700;margin-bottom:14px}
.mform{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.mform input{flex:1;min-width:140px;font-family:inherit;padding:12px 14px;border-radius:12px;border:1px solid #E4E7EC;font-size:14px;font-weight:500;outline:none;transition:border-color .15s,box-shadow .15s}
.mform input:focus{border-color:#C9973A;box-shadow:0 0 0 4px rgba(201,151,58,.18)}
.mform button{background:#101B30;color:#fff;border:none;border-radius:12px;padding:12px 20px;font-weight:700;cursor:pointer;font-size:14px}
.mrow{display:flex;align-items:center;gap:9px;padding:11px 0;border-bottom:1px solid #F2F4F7;font-size:14px;font-weight:600;flex-wrap:wrap}
.mrow:last-child{border-bottom:none}
.mrow .nm{flex:1;min-width:120px}
.mrow .nm small{color:#9097A3;font-weight:500}
.mbtn{border:none;border-radius:9px;padding:7px 11px;font-weight:700;font-size:12px;cursor:pointer}
.mbtn.show{background:#E7F7ED;color:#10803C}.mbtn.no{background:#FDECEC;color:#C5221F}.mbtn.win{background:#C9973A;color:#101B30}
.mtag{border-radius:99px;padding:4px 11px;font-size:11px;font-weight:700;white-space:nowrap}
.mtag.showed{background:#E7F7ED;color:#10803C}.mtag.no_show{background:#FDECEC;color:#C5221F}.mtag.closed{background:#F7EFD8;color:#8A6A00}.mtag.scheduled{background:#F0F2F6;color:#8A94A8}
.mnote{flex-basis:100%;font-family:inherit;margin-top:4px;padding:9px 12px;border-radius:10px;border:1px solid #E4E7EC;font-size:13px;font-weight:500;color:#1B2433;outline:none;transition:border-color .2s,box-shadow .15s}
.mnote::placeholder{color:#B6BCC8;font-weight:500}
.mnote:focus{border-color:#C9973A;box-shadow:0 0 0 3px rgba(201,151,58,.16)}
.periodbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:2px 0 16px}
.segs{display:inline-flex;background:#EEF0F4;border-radius:12px;padding:3px;gap:2px}
.seg{padding:8px 15px;border-radius:9px;font-size:13px;font-weight:700;color:#5A6475;text-decoration:none;white-space:nowrap}
.seg.on{background:#fff;color:#101B30;box-shadow:0 1px 3px rgba(16,27,48,.12)}
.segcustom{display:inline-flex;gap:7px;align-items:center}
.segcustom input{font-family:inherit;padding:8px 10px;border-radius:10px;border:1px solid #E4E7EC;font-size:13px;font-weight:600;color:#1B2433;outline:none}
.segcustom input:focus{border-color:#C9973A;box-shadow:0 0 0 3px rgba(201,151,58,.18)}
.segcustom button{background:#101B30;color:#fff;border:none;border-radius:10px;padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer}
.segcustom button.on{background:#C9973A;color:#101B30}
.plabel{font-size:12.5px;font-weight:700;color:#9097A3}
@media(min-width:920px){.cols{grid-template-columns:1fr 1fr;align-items:start}}
</style></head><body>
<div class="appheader">
  <img src="/brand-logo.png" alt="">
  <b>QUICK <em>COMP</em> · ${en ? "Closer" : "Closer"}</b>
  <div class="right">
    <a href="/closer?logout">${en ? "log out" : "salir"}</a>
    <a class="dark" href="/closer${en ? "" : "?lang=en"}">${L.langBtn}</a>
  </div>
</div>
<div class="wrap">
<div class="cards">
  <div class="card gold"><div class="v">${closeRate}%</div><div class="l">${en ? "Close rate" : "Tasa de cierre"}</div></div>
  <div class="card"><div class="v">${mst.total}</div><div class="l">${en ? "Meetings" : "Reuniones"}</div></div>
  <div class="card"><div class="v">${mst.showed}</div><div class="l">${en ? "Showed up" : "Asistieron"}</div>${mst.total ? `<div class="sub">${Math.round((mst.showed / mst.total) * 100)}%</div>` : ""}</div>
  <div class="card"><div class="v">${mst.noShow}</div><div class="l">No-shows</div>${mst.total ? `<div class="sub" style="color:#C5221F">${Math.round((mst.noShow / mst.total) * 100)}%</div>` : ""}</div>
  <div class="card"><div class="v">${mst.closed}</div><div class="l">${en ? "Closed" : "Cerrados"}</div></div>
  <div class="card"><div class="v">${clientCount}</div><div class="l">${en ? "Clients" : "Clientes"}</div></div>
</div>
${periodSeg("/closer", range, en)}
<div class="toolbar">
  <a class="navbtn primary" href="/demo" target="_blank">🎤 ${en ? "Open presentation" : "Abrir presentación"}</a>
  <a class="navbtn" href="/w/alto-demo${en ? "?lang=en" : ""}" target="_blank">🏡 ${en ? "Valuator demo" : "Demo del valuador"}</a>
  <a class="navbtn" href="/ejemplo${en ? "?lang=en" : "?lang=es"}" target="_blank">🏠 ${en ? "Example site" : "Página de ejemplo"}</a>
  <a class="navbtn" href="/plantillas" target="_blank">🎨 ${en ? "Templates" : "Las 3 plantillas"}</a>
</div>
<div class="panel">
  <h3>📅 ${en ? "My meetings" : "Mis reuniones"}</h3>
  <div class="mform">
    <input id="mname" placeholder="${en ? "Prospect name" : "Nombre del prospecto"}">
    <input id="mphone" placeholder="${en ? "Phone" : "Teléfono"}" inputmode="numeric">
    <button onclick="addMeeting()">${en ? "Log meeting" : "Agendar reunión"}</button>
  </div>
  ${meetings.length ? meetings.map((m) => {
    const pp = String(m.phone || "").replace(/\D/g, "").replace(/^1/, "");
    const phoneTxt = pp.length === 10 ? `(${pp.slice(0, 3)}) ${pp.slice(3, 6)}-${pp.slice(6)}` : (m.phone || "");
    const oc = m.outcome || "scheduled";
    const tagTxt = { scheduled: en ? "agendada" : "agendada", showed: en ? "asistió" : "asistió", no_show: "no-show", closed: en ? "cerró ✓" : "cerró ✓" }[oc];
    return `<div class="mrow"><span class="nm">${esc(m.name) || "—"}${phoneTxt ? ` <small>· ${phoneTxt}</small>` : ""}</span>
      <span class="mtag ${oc}">${tagTxt}</span>
      <button class="mbtn show" onclick="mOutcome('${m.id}','showed')">${en ? "Showed" : "Asistió"}</button>
      <button class="mbtn no" onclick="mOutcome('${m.id}','no_show')">No-show</button>
      <button class="mbtn win" onclick="mOutcome('${m.id}','closed')">${en ? "Closed 💰" : "Cerró 💰"}</button>
      <input class="mnote" id="note_${m.id}" placeholder="${en ? "note (saves when you click away)…" : "nota (se guarda al salir del campo)…"}" value="${esc(m.note || "")}" onblur="saveNote('${m.id}')"></div>`;
  }).join("") : `<p style="color:#9097A3;font-weight:500">${en ? "No meetings logged yet — add them above to track your show & close rate." : "Aún no hay reuniones — agrégalas arriba para ver tu % de asistencia y cierre."}</p>`}
</div>
<p class="warn">${L.warn}</p>
<div class="cols">
  <div class="col">
    <h2>${L.altaT}</h2>
    <form class="alta" method="post" action="/api/closer/contractors?key=${K}">
      <input name="name" placeholder="${L.altaName}" required>
      <input name="phone" placeholder="${L.altaPhone}">
      <button>${L.altaBtn}</button>
    </form>
    <p><small>${L.altaTip}</small></p>
    <h2>${L.playT}</h2>
    <ol>${L.play.map((x) => `<li>${x}</li>`).join("")}</ol>
    <h2>${L.linksT}</h2>
    ${payTiers.length
      ? payTiers.map(([nm, amt, lnk]) => `<div class="link"><span><b>💳 ${nm} — $${amt}/${en ? "mo" : "mes"}</b><br><small>${esc(lnk)}</small></span><a href="${lnk}" target="_blank" rel="noreferrer" style="background:#101B30;color:#fff;border-radius:11px;padding:9px 15px;font-weight:700;text-decoration:none;flex-shrink:0;font-size:13px">${L.open}</a><button onclick="cp(this,'${lnk}')">${L.copy}</button></div>`).join("")
      : `<div class="link" style="border-style:dashed"><span><b>💳</b><br><small>${L.payMissing}</small></span></div>`}
    <div class="link"><span><b>${L.welT}</b><br><small>${esc(welcome.slice(0, 70))}…</small></span><button onclick='cp(this,${JSON.stringify(welcome)})'>${L.copy}</button></div>
    <div class="link"><span><b>${L.demoT}</b><br><small>${base}/w/alto-demo</small></span><button onclick="cp(this,'${base}/w/alto-demo')">${L.copy}</button></div>
    <div class="link"><span><b>${L.demoMsgT}</b><br><small>${esc(wMsg.slice(0, 70))}…</small></span><button onclick='cp(this,${JSON.stringify(wMsg)})'>${L.copy}</button></div>
    <h2>${L.keysT}</h2>
    <ul style="font-size:14px;line-height:1.8">${L.keys.map((x) => `<li>${x}</li>`).join("")}</ul>
    <p><small>${L.keysWarn}</small></p>
  </div>
  <div class="col">
    <h2>${L.scriptT}</h2>
    ${L.script.map(([t, x]) => `<div class="sc"><b>${t}</b><p>${x}</p></div>`).join("")}
    <h2>${L.objT}</h2>
    ${L.obj.map(([o, r]) => `<div class="ob"><b>${o}</b><p>→ ${r}</p></div>`).join("")}
  </div>
</div>
</div>
<script>
function cp(b,t){navigator.clipboard.writeText(t);b.textContent='✓'}
function addMeeting(){var n=document.getElementById('mname'),p=document.getElementById('mphone');var nm=n.value.trim(),ph=p.value.trim();if(!nm&&!ph)return;fetch('/api/closer/meeting?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:nm,phone:ph})}).then(function(r){return r.json()}).then(function(){location.reload()}).catch(function(){alert('Error')});}
function mOutcome(id,o){var el=document.getElementById('note_'+id);var note=el?el.value:'';fetch('/api/closer/meeting/'+encodeURIComponent(id)+'?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({outcome:o,note:note})}).then(function(r){return r.json()}).then(function(){location.reload()}).catch(function(){alert('Error')});}
function saveNote(id){var el=document.getElementById('note_'+id);if(!el)return;fetch('/api/closer/meeting/'+encodeURIComponent(id)+'?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({note:el.value})}).then(function(){el.style.borderColor='#10803C';setTimeout(function(){el.style.borderColor='';},900);}).catch(function(){});}
</script>
</body></html>`);
});

/* ── Closer's private toolkit (/cierre — NEVER screen-shared) ──
 * The client-facing deck is /demo; this page holds the script,
 * payment link, ready messages, and objection answers. */
/* ── Legal: Terms, Privacy, Refund ──
 * Public, bilingual, self-contained. Linked from the landing footer and the
 * widget consent line. Written to cover the actual product: a home-value
 * estimate (not an appraisal), lead capture with call/text consent, monthly
 * plans with no setup fee and cancel-anytime, and the domain-portability
 * promise the sales script makes. Company placeholders are env-overridable. */
app.get("/legal", (req, res) => {
  const es = req.query.lang === "es";
  const company = process.env.LEGAL_COMPANY || "Quick Comp";
  const contact = process.env.LEGAL_CONTACT || (ROOT_DOMAIN ? `support@${ROOT_DOMAIN}` : "your support email (set LEGAL_CONTACT)");
  const esc = (s) => String(s || "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
  const S = es ? {
    title: "Términos, Privacidad y Reembolsos",
    updated: "Última actualización: julio 2026",
    toc: "Al usar Quick Comp aceptas lo siguiente. Escrito en lenguaje claro a propósito.",
    secs: [
      ["1. Qué es Quick Comp", `${esc(company)} ofrece a agentes de bienes raíces una herramienta de valuación, un valuador de casas para su sitio web, y una app. Los valores que mostramos son <b>estimados automáticos basados en ventas comparables — no son un avalúo</b> ni una garantía del precio de venta. No somos un corredor, tasador ni asesor financiero.`],
      ["2. Planes y pagos", `Los planes son mensuales: Pro $67, Widget $197, Complete $297. <b>Sin costo de inicio.</b> Se cobran por adelantado cada mes vía Stripe. Puedes <b>cancelar cuando quieras</b> desde tu cuenta o escribiéndonos; el servicio sigue activo hasta el fin del período ya pagado.`],
      ["3. Reembolsos", `Si cancelas, no se cobra el siguiente mes. No hay reembolsos parciales de un mes ya comenzado, salvo que la ley lo exija o que haya un error de cobro nuestro — en ese caso lo corregimos sin demora.`],
      ["4. Tu dominio y tus datos", `Si compras un dominio a través nuestro, <b>es tuyo</b> y te lo transferimos si te vas. Tus leads y tu contenido son tuyos; puedes exportarlos o pedir que los borremos.`],
      ["5. Leads, llamadas y mensajes", `Cuando un dueño de casa deja su teléfono en el valuador, da su consentimiento para que el agente lo contacte por llamada o mensaje sobre el valor de su casa. <b>El agente (cliente de ${esc(company)}) es responsable</b> de cumplir con las leyes de contacto (TCPA y estatales), incluyendo respetar solicitudes de no contactar. Quick Comp solo transmite el lead.`],
      ["6. Privacidad", `Recopilamos lo necesario para operar: datos de la cuenta del agente, y de los leads (nombre, teléfono, dirección, valor mostrado). No vendemos datos personales. Usamos proveedores (Stripe para pagos, Google/RentCast para datos de propiedades, y píxeles de anuncios cuando el agente los activa). Puedes pedir acceso o borrado escribiéndonos.`],
      ["7. Contacto", `Escríbenos a ${esc(contact)} para cualquier duda, cancelación o solicitud sobre tus datos.`],
    ],
    back: "← Volver",
  } : {
    title: "Terms, Privacy & Refunds",
    updated: "Last updated: July 2026",
    toc: "By using Quick Comp you agree to the following. Written in plain language on purpose.",
    secs: [
      ["1. What Quick Comp is", `${esc(company)} gives real-estate agents a valuation tool, a home-value widget for their website, and an app. The values we show are <b>automated estimates based on comparable sales — they are not an appraisal</b> or a guarantee of sale price. We are not a broker, appraiser, or financial advisor.`],
      ["2. Plans & payments", `Plans are monthly: Pro $67, Widget $197, Complete $297. <b>No setup fee.</b> Billed in advance each month via Stripe. You may <b>cancel anytime</b> from your account or by contacting us; service stays active through the end of the period already paid.`],
      ["3. Refunds", `If you cancel, the next month isn't charged. We don't prorate a month already started unless required by law or where we made a billing error — in which case we fix it promptly.`],
      ["4. Your domain & your data", `If you buy a domain through us, <b>it's yours</b> and we transfer it to you if you leave. Your leads and content are yours; you can export them or ask us to delete them.`],
      ["5. Leads, calls & texts", `When a homeowner leaves their phone in the widget, they consent to be contacted by the agent by call or text about their home's value. <b>The agent (${esc(company)}'s customer) is responsible</b> for complying with contact laws (TCPA and state equivalents), including honoring do-not-contact requests. Quick Comp only relays the lead.`],
      ["6. Privacy", `We collect what's needed to operate: the agent's account details, and lead details (name, phone, address, value shown). We don't sell personal data. We use processors (Stripe for payments, Google/RentCast for property data, and ad pixels when the agent enables them). You may request access or deletion by contacting us.`],
      ["7. Contact", `Reach us at ${esc(contact)} for any question, cancellation, or data request.`],
    ],
    back: "← Back",
  };
  res.send(`<!doctype html><html lang="${es ? "es" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${company} · ${S.title}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;font-family:Inter,Arial,sans-serif}
body{background:#F1F4FA;color:#1B2433;line-height:1.65}
.wrap{max-width:720px;margin:0 auto;padding:40px 22px 80px}
.top{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.top img{height:34px}
h1{font-size:26px;font-weight:800;color:#15244C;margin-bottom:4px}
.upd{color:#6E7891;font-size:13px;font-weight:600;margin-bottom:18px}
.intro{color:#4a5a7a;font-weight:600;margin-bottom:24px}
h2{font-size:16px;font-weight:800;color:#15244C;margin:26px 0 6px}
p{color:#3A455C;font-size:14.5px}
a.back{display:inline-block;margin-top:30px;color:#B07A00;font-weight:800;text-decoration:none}
.lang{margin-left:auto;font-size:13px;font-weight:700}
.lang a{color:#6E7891;text-decoration:none}
</style></head><body><div class="wrap">
<div class="top"><img src="/quick-comp-lockup-navy.png" alt="Quick Comp" onerror="this.style.display='none'"><span class="lang"><a href="/legal${es ? "" : "?lang=es"}">${es ? "English" : "Español"}</a></span></div>
<h1>${S.title}</h1><p class="upd">${S.updated}</p>
<p class="intro">${S.toc}</p>
${S.secs.map(([h, body]) => `<h2>${h}</h2><p>${body}</p>`).join("")}
<a class="back" href="/">${S.back}</a>
</div></body></html>`);
});

/* ── Post-payment thank-you (Stripe Payment Link success URL points here) ──
 * The app takes no Stripe secret key, so we can't identify the buyer here — but
 * the webhook already created/activated their account and pinged the team, so
 * this page reassures the buyer their access is coming and keeps them warm.
 * Set each Payment Link's "after payment" redirect to https://APP/bienvenida. */
app.get("/bienvenida", (req, res) => {
  const es = req.query.lang !== "en";
  const S = es ? {
    t: "¡Pago recibido! 🎉", h: "Bienvenido a Quick Comp",
    p: "Ya estás dentro. Te enviaremos tu <b>link de acceso personal</b> por WhatsApp o mensaje de texto en los próximos minutos — ábrelo desde tu teléfono y guárdalo.",
    p2: "¿No te llega en 15 minutos? Escríbenos y te lo mandamos al instante.",
    demo: "Mientras tanto, así se ve tu valuador 👇", demoBtn: "Ver el valuador", legal: "Términos y Privacidad",
  } : {
    t: "Payment received! 🎉", h: "Welcome to Quick Comp",
    p: "You're in. We'll send your <b>personal access link</b> by WhatsApp or text within the next few minutes — open it from your phone and save it.",
    p2: "Don't see it within 15 minutes? Message us and we'll send it right over.",
    demo: "Meanwhile, here's your valuator 👇", demoBtn: "See the valuator", legal: "Terms & Privacy",
  };
  res.send(`<!doctype html><html lang="${es ? "es" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${S.t}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@600;700;800&display=swap');
*{box-sizing:border-box;margin:0;font-family:Inter,Arial,sans-serif}
body{background:#15244C;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:22px}
.card{background:#fff;border-radius:24px;padding:38px 30px;max-width:440px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.4)}
.em{font-size:46px}
h1{color:#15244C;font-size:22px;font-weight:800;margin:10px 0 4px}
.k{color:#C9973A;font-size:12px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase}
p{color:#4a5a7a;font-size:14.5px;font-weight:600;line-height:1.6;margin-top:14px}
a.btn{display:inline-block;margin-top:22px;background:#15244C;color:#fff;border-radius:12px;padding:13px 22px;font-weight:800;text-decoration:none;font-size:14px}
a.leg{display:block;margin-top:18px;color:#8A94A8;font-size:12px;font-weight:700;text-decoration:none}
</style></head><body><div class="card">
<div class="em">🎉</div>
<p class="k">${S.t}</p>
<h1>${S.h}</h1>
<p>${S.p}</p>
<p style="font-size:13px">${S.p2}</p>
<a class="btn" href="/w/alto-demo?lang=${es ? "es" : "en"}" target="_blank">${S.demoBtn} →</a>
<a class="leg" href="/legal${es ? "?lang=es" : ""}">${S.legal}</a>
</div></body></html>`);
});

app.get("/cierre", (req, res) => {
  // Private closer playbook — gate it like /closer. Key in query sets the cookie
  // then redirects (so the key doesn't linger in history), matching /closer.
  if (safeEq(req.query.key, CLOSER_KEY) || safeEq(req.query.key, ADMIN_KEY)) { setKeyCookie(res, "alto_closer", req.query.key); return res.redirect("/cierre"); }
  if (!closerOk(req)) return res.status(req.query.key ? 403 : 401).send(loginPage("Cierre (privado)", "/cierre", !!req.query.key));
  const base = canonBase(req);
  const stripeLink = process.env.STRIPE_PAYMENT_LINK || "";
  const wMsg = `Mira esto 👀 — escribe tu dirección y ve lo que tus clientes verían en TU página web:\n${base}/w/alto-demo`;
  const welcome = `¡Felicidades y bienvenido a Quick Comp! 🎉 Toca este link desde tu teléfono y guárdalo — es tu llave personal a tu app: [PEGA AQUÍ SU LINK DE ACCESO]. Hoy mismo puedes valuar casas y armar CMAs. Nos vemos en tu llamada de onboarding 💪`;
  const esc = (s) => String(s).replace(/</g, "&lt;");
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Quick Comp · Cierre (privado)</title><style>
body{font-family:Arial;max-width:640px;margin:30px auto;padding:0 18px;color:#101B30;line-height:1.55}
h1{font-size:22px}h2{font-size:16px;margin-top:24px}
.warn{background:#FDECEC;border:1.5px solid #D93025;color:#9B1C10;border-radius:12px;padding:10px 14px;font-weight:700;font-size:13px}
.link{background:#F7EFD8;border:2px solid #C9973A;border-radius:12px;padding:12px;word-break:break-all;font-size:14px;margin:8px 0;display:flex;gap:10px;align-items:center}
.link button{margin-left:auto;background:#C9973A;color:#101B30;border:none;border-radius:8px;padding:8px 14px;font-weight:800;cursor:pointer;flex-shrink:0}
.link small{color:#67718A}
ol li{margin-bottom:10px}small{color:#67718A}
</style></head><body>
<h1>🔒 Cierre · QUICK <span style="color:#B07A00">COMP</span></h1>
<p class="warn">⚠️ Página privada del closer — NUNCA la compartas en pantalla. La presentación para el cliente es /demo.</p>
<h2>El cierre, paso a paso (todo en la misma llamada)</h2>
<ol>
<li>Mándale el <b>link de pago</b> por WhatsApp — paga desde su teléfono, aquí mismo.</li>
<li>Mientras paga: crea su cuenta en <a href="/closer">/closer</a> y copia su <b>link de acceso</b>.</li>
<li>Mándale la <b>bienvenida</b> con su acceso — ya tiene su app hoy mismo.</li>
<li>Agenda su <b>onboarding</b> antes de colgar.</li>
</ol>
<h2>Links y mensajes</h2>
<div class="link"><span><b>💳 Link de pago — $297/mes (Complete) · sin costo de inicio</b><br><small>${esc(stripeLink || "buy.stripe.com/… (ejemplo — aún sin configurar)")}</small></span><a href="${stripeLink || "#"}" ${stripeLink ? `target="_blank" rel="noreferrer"` : `onclick="alert('Aún no está configurado: crea el Payment Link en Stripe y agrégalo en Render como STRIPE_PAYMENT_LINK');return false"`} style="background:#101B30;color:#fff;border-radius:8px;padding:8px 14px;font-weight:800;text-decoration:none;flex-shrink:0">Abrir</a><button onclick="${stripeLink ? `cp(this,'${stripeLink}')` : `alert('Aún no está configurado: crea el Payment Link en Stripe y agrégalo en Render como STRIPE_PAYMENT_LINK')`}">Copiar</button></div>
<p style="font-size:12px;color:#67718A;margin:-2px 0 10px"><b>Copiar</b> → se lo mandas por WhatsApp y paga desde su teléfono. <b>Abrir</b> → si te da la tarjeta por teléfono, la escribes tú aquí mismo.${stripeLink ? "" : ` <b style="color:#D93025">⚠️ Link de ejemplo — falta configurar STRIPE_PAYMENT_LINK en Render.</b>`}</p>
<div class="link"><span><b>👋 Bienvenida (pega su link de acceso)</b><br><small>${esc(welcome.slice(0, 70))}…</small></span><button onclick='cp(this,${JSON.stringify(welcome)})'>Copiar</button></div>
<div class="link"><span><b>🏡 Demo del valuador</b><br><small>${base}/w/alto-demo</small></span><button onclick="cp(this,'${base}/w/alto-demo')">Copiar</button></div>
<div class="link"><span><b>👀 Mensaje de demo</b><br><small>${esc(wMsg.slice(0, 70))}…</small></span><button onclick='cp(this,${JSON.stringify(wMsg)})'>Copiar</button></div>
<h2>⌨️ Atajos secretos en la presentación (/demo)</h2>
<p><small>El cliente nunca los ve. Funcionan en cualquier slide:</small></p>
<ul style="font-size:14px;line-height:1.8">
<li><b>Doble clic en el contador</b> (el "8 / 8" de abajo) o tecla <b>C</b> → abre/cierra el panel del closer</li>
<li>Tecla <b>P</b> → copia el link de pago (solo verás una palomita verde ✓)</li>
<li>Tecla <b>B</b> → copia el mensaje de bienvenida</li>
<li>Tecla <b>D</b> → copia el mensaje de demo</li>
<li>Tecla <b>O</b> → abre el checkout de Stripe en otra pestaña</li>
</ul>
<p><small>⚠️ Si compartes la PANTALLA completa, la pestaña de Stripe se ve. Comparte solo la pestaña de /demo y usa las teclas — el cliente no nota nada.</small></p>
<h2>Objeciones y cómo regresar</h2>
<p><small>
<b>"Está caro"</b> → "Una comisión son miles de dólares en tu bolsillo. Con UN cierre extra al año, esto ya se pagó. La pregunta no es si cuesta — es cuántos vendedores se te están yendo hoy."<br><br>
<b>"Ya tengo página"</b> → "Qué bueno — ¿y te manda los teléfonos de los vendedores al bolsillo, con su casa ya valuada? Eso es lo que hace la diferencia. Tu página de hoy es la tarjeta; esta es la que vende."<br><br>
<b>"Déjame pensarlo"</b> → "Claro. ¿Qué es lo que quieres pensar — el precio, o si te va a funcionar? (espera la respuesta y resuélvela). Te aparto el precio hoy y la demo queda abierta."<br><br>
<b>"Lo tengo que hablar con mi esposa / mi socio"</b> → "Perfecto, así debe ser. ¿Qué te va a preguntar? … Mejor aún: agendemos 10 minutos mañana con los dos y le enseño la demo igual que a ti — que lo vea con sus propios ojos. ¿Mañana a qué hora pueden?"<br><br>
<b>"Mis clientes llegan por recomendación, no por internet"</b> → "Exacto — ¿y qué hace la gente cuando le recomiendan a alguien? Lo busca en Google antes de llamar. Si no encuentra nada, la recomendación se enfría. Esto convierte tus recomendaciones en citas."<br><br>
<b>"No soy bueno con la tecnología"</b> → "Por eso lo hicimos así: si sabes mandar un WhatsApp, sabes usar Quick Comp. Y el onboarding lo hacemos contigo, en español, paso a paso. No estás solo."<br><br>
<b>"¿Y si no me funciona?"</b> → "Sin contratos largos: cancelas cuando quieras y tu dominio se va contigo — está en el contrato. El riesgo lo cargamos nosotros, no tú."<br><br>
<b>"Ahorita no hay dinero / es temporada baja"</b> → "Justo por eso es el momento: tu página se construye AHORA, para que cuando se mueva el mercado ya estés posicionado. El que la monta en plena temporada, llega tarde."<br><br>
<b>"Ya trabajo con una agencia de marketing"</b> → "No competimos con tu agencia — le damos a dónde mandar a la gente. ¿Su página te valúa casas sola y te manda el teléfono al bolsillo? Eso es lo nuestro; lo demás lo puede seguir haciendo ella."<br><br>
<b>"Suena demasiado bueno / ¿por qué tan barato?"</b> → "Porque es software que ya construimos — no te cobramos horas de agencia. Y ganamos cuando te quedas meses, así que nos conviene más que a nadie que te funcione."<br><br>
<b>"Los leads de internet son basura"</b> → "Los leads comprados, sí. Estos no son comprados: es gente que puso SU dirección y SU teléfono para ver el valor de SU casa. Más caliente que eso no existe."
</small></p>
<script>function cp(b,t){navigator.clipboard.writeText(t);b.textContent='✓'}</script>
</body></html>`);
});

app.get("/demo", (req, res) => {
  const base = canonBase(req);
  const en = req.query.lang === "en";
  // Staff (closer/admin key or cookie) get the unlimited pass injected into
  // the embedded app so the valuation cap never interrupts a sales call.
  // The public deck stays capped on purpose — that cap is a conversion moment.
  const appPass = DEMO_PASS && closerOk(req) ? `&pass=${encodeURIComponent(DEMO_PASS)}` : "";
  const wMsg = en
    ? `Check this out 👀 — type your address and see what your customers would see on YOUR website:\n${base}/w/alto-demo`
    : `Mira esto 👀 — escribe tu dirección y ve lo que tus clientes verían en TU página web:\n${base}/w/alto-demo`;
  const stripeLink = process.env.STRIPE_PAYMENT_LINK || "";
  const welcome = en
    ? `Congratulations and welcome to Quick Comp! 🎉 Tap this link from your phone and save it — it's your personal key to your app: [PASTE THEIR ACCESS LINK HERE]. You can value homes and build CMAs starting today. See you at your onboarding call 💪`
    : `¡Felicidades y bienvenido a Quick Comp! 🎉 Toca este link desde tu teléfono y guárdalo — es tu llave personal a tu app: [PEGA AQUÍ SU LINK DE ACCESO]. Hoy mismo puedes valuar casas y armar CMAs. Nos vemos en tu llamada de onboarding 💪`;
  // marketing photos appear automatically once the files exist in public/landing/
  const hasAsset = (name) =>
    fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "landing", name))
    || fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "landing", name));
  const teamPhoto = hasAsset("team.jpg");
  const founderBg = hasAsset("founder-bg.jpg");

  // Every visible string in both languages
  const L = en ? {
    title: "Quick Comp · Presentation", presentation: "PRESENTATION", forClients: "Client presentation",
    menu: "☰ Menu", prev: "‹ Previous", next: "Next ›", langBtn: "🇲🇽 Español", langHref: "?lang=es",
    t1: "Welcome", t2: "Who we are", t3: "The problem", t4: "Your website", t5: "Your app", t6: "Your AI secretary", t7: "Your investment", t8: "Let's begin",
    k1: "QUICK COMP · MARKETING & TECHNOLOGY FOR REALTORS", h1a: "More sellers,", h1b: "without chasing them.",
    b1: "Thanks for booking. In the next 10 minutes you'll see a home valued from real comparable sales — and how your website can bring you sellers 24 hours a day.",
    g1: "10 sec", g1s: "home valuation", g2: "24/7", g2s: "your site working", g3: "100%", g3s: "bilingual support", tag: "Your business, on top",
    k2: "02 · WHO WE ARE", h2a: "Built by a Texas builder,", h2b: "for realtors.",
    b2: "Rolando, our founder, owns residential construction and technology companies in Texas. Buying and valuing his own properties, he lived how hard it was to get an accurate number fast — so he built this tool for himself. It worked so well he opened it to the public, and today he uses this same system to get leads for his own company.",
    p2a: "Builder-founder: he buys and sells real property, not just software", p2b: "20+ people on the Quick Comp team working behind your account", p2c: "We use our own tools, every single day",
    cap2: "Rolando · Founder of Quick Comp", ph2a: "Photo of Rolando and the team", ph2b: "in Quick Comp shirts",
    k3: "03 · WHY IT MATTERS", h3a: "Sellers slip away", h3b: "without a number.",
    p3a: 'When you\'re showing a house, you can\'t answer. And most sellers list with <b style="color:#fff">whoever responds first</b>.',
    p3b: 'Every CMA you build by hand costs you: the research, the comps, the time. <b style="color:#fff">And many of those never turn into a listing.</b>',
    p3c: 'A pretty website with no system behind it is <b style="color:#fff">an expensive business card</b>.',
    p3d: 'Big companies already answer with artificial intelligence — in seconds, around the clock. <b style="color:#fff">The question isn\'t whether this is coming. It\'s which side you\'ll be on.</b>',
    c3: "You work hard. What you're missing is a system that works when you can't.",
    k4: "04 · YOUR WEBSITE", h4a: "This is what", h4b: "your site would look like.",
    b4: "It looks excellent on the phone and on the computer — with your logo, your colors and the home-value tool inside. This one is a sample; yours is delivered in 10–14 days. Both are live: scroll, and type YOUR address into the valuator.",
    k5: "05 · YOUR APP", h5a: "Your office,", h5b: "in your pocket.",
    p5a: "Value any home wherever you are: address or GPS, from real comparable sales", p5b: "Every lead hits your phone with a WhatsApp button and the message pre-written", p5c: "An AI texts your lead instantly and books the appointment for you", p5d: "Professional CMA reports with your brand",
    live5: '🔴 <b style="color:#fff">The app on the right is LIVE</b> — explore it: tap VALUE A HOME, type a real address and value it right here, with the client.',
    k6: "06 · ARTIFICIAL INTELLIGENCE", h6a: "Your own secretary,", h6b: "who never sleeps.",
    b6: "We all know artificial intelligence is here — what better way than starting now? Your own secretary answers the messages from customers landing on your website, at any hour of the day.",
    p6a: "Replies instantly — even at 11 at night", p6b: "Books the appointment for you. You just show up.", p6c: "You can read every conversation whenever you want", p6d: "Ready in 10–14 days — carrier registration of your number takes a few days",
    chHead: "🔴 LIVE DEMO — text it like you're the homeowner", chGreet: "Hi! 👋 I'm the assistant at Casa Bella Realty. How can I help you buy or sell a home?",
    chPh: "Type as the homeowner… (e.g., I want to sell my house)", chFoot: "This same AI will answer YOUR leads' texts", chRetry: "Give me one moment 🙏 (try again)",
    k7: "07 · YOUR INVESTMENT", h7a: "Pick your plan,", h7b: "no setup fees.",
    b7: "What this would cost separately (typical market prices):",
    s7a: "🌐 Professional website with your brand", s7b: "🏡 Home-value tool on your site", s7c: "🤖 AI secretary that texts and books", s7d: "📲 Values, CMAs & leads app", s7e: "🇺🇸 Domain, hosting & bilingual support",
    s7tot: "Separately", roi7: '💰 <b style="color:#fff">One commission is thousands of dollars.</b> One single extra deal pays for your whole year.',
    pk7: "WITH QUICK COMP · PICK YOUR PLAN", mo: "/mo", setup7: "No setup fees — just the monthly.",
    tiers7: [["PRO — just the app", 67, 0], ["WIDGET — on the site you already have", 197, 1], ["COMPLETE — website + everything", 297, 0]],
    pr7a: "✓ No long contracts", pr7b: "✓ Cancel anytime", pr7c: "✓ Your domain is YOURS — by contract",
    k8: "08 · LET'S BEGIN", h8a: "Let's start", h8b: "today.",
    b8: "Getting started is this easy — everything begins on this very call:",
    d8a: "STEP 1", t8a: "Secure your spot", x8a: "We send a secure payment link to your WhatsApp. You pay by card, protected by Stripe 🔒.",
    d8b: "STEP 2 · TODAY", t8b: "Your app, today", x8b: "Your access arrives by WhatsApp before we hang up. You're valuing homes today.",
    d8c: "STEP 3", t8c: "Your onboarding", x8c: "We book your call right now: your logo, your colors, your prices and your photos.",
    d8d: "DAY 10–14", t8d: "Everything live", x8d: "Your website, your home-value tool and your AI secretary — 24/7. Carriers take a few days to approve your number; we use that time to make everything perfect.",
    c8: "🤝 Ready? I'll send you the link right now.",
  } : {
    title: "Quick Comp · Presentación", presentation: "PRESENTACIÓN", forClients: "Presentación para clientes",
    menu: "☰ Menú", prev: "‹ Anterior", next: "Siguiente ›", langBtn: "🇺🇸 English", langHref: "?lang=en",
    t1: "Bienvenida", t2: "Quiénes somos", t3: "El problema", t4: "Tu página", t5: "Tu app", t6: "Tu secretaria IA", t7: "Tu inversión", t8: "Empecemos",
    k1: "QUICK COMP · MARKETING Y TECNOLOGÍA PARA AGENTES", h1a: "Más vendedores,", h1b: "sin perseguirlos.",
    b1: "Gracias por agendar. En los próximos 10 minutos vas a ver una casa valuada con ventas comparables reales — y cómo tu página puede traerte vendedores las 24 horas.",
    g1: "10 seg", g1s: "valuación de casa", g2: "24/7", g2s: "tu página trabajando", g3: "100%", g3s: "en español", tag: "Tu negocio, en alto",
    k2: "02 · QUIÉNES SOMOS", h2a: "Construido por un constructor de Texas,", h2b: "para agentes.",
    b2: "Rolando, nuestro fundador, tiene compañías de construcción residencial y de tecnología en Texas. Comprando y valuando sus propias propiedades vivió lo difícil que era sacar un número correcto rápido — así que construyó esta herramienta para él mismo. Funcionó tan bien que la abrió al público, y hoy usa este mismo sistema para conseguir leads para su propia compañía.",
    p2a: "Fundador constructor: compra y vende propiedades, no solo software", p2b: "Más de 20 personas del equipo Quick Comp trabajando detrás de tu cuenta", p2c: "Usamos nuestras propias herramientas, todos los días",
    cap2: "Rolando · Fundador de Quick Comp", ph2a: "Foto de Rolando y el equipo", ph2b: "con la camisa Quick Comp",
    k3: "03 · POR QUÉ IMPORTA", h3a: "Los vendedores se pierden", h3b: "sin un número.",
    p3a: 'Cuando estás enseñando una casa, no puedes contestar. Y la mayoría de los vendedores lista con <b style="color:#fff">el primero que les responde</b>.',
    p3b: 'Cada CMA que haces a mano cuesta: la investigación, las comparables, el tiempo. <b style="color:#fff">Y muchas nunca se vuelven un listing.</b>',
    p3c: 'Una página bonita sin un sistema detrás es <b style="color:#fff">una tarjeta de presentación cara</b>.',
    p3d: 'Las compañías grandes ya responden con inteligencia artificial — en segundos, a toda hora. <b style="color:#fff">La pregunta no es si esto llega. Es de qué lado vas a estar.</b>',
    c3: "Trabajas duro. Lo que te falta es un sistema que trabaje cuando tú no puedes.",
    k4: "04 · TU PÁGINA WEB", h4a: "Así se vería", h4b: "tu página.",
    b4: "Se mira excelente en el celular y en la computadora — con tu logo, tus colores y el valuador adentro. Esta es de ejemplo; la tuya se entrega en 10–14 días. Las dos están vivas: haz scroll, y pon TU dirección en el valuador.",
    k5: "05 · TU APP", h5a: "Tu oficina,", h5b: "en tu bolsillo.",
    p5a: "Valúa cualquier casa donde estés: dirección o GPS, con ventas comparables reales", p5b: "Cada lead llega a tu teléfono con botón de WhatsApp y el mensaje ya escrito", p5c: "Una IA le textea a tu lead al momento y agenda la cita por ti", p5d: "Reportes CMA profesionales con tu marca",
    live5: '🔴 <b style="color:#fff">La app de la derecha está EN VIVO</b> — explórala: toca VALUAR CASA, pon una dirección real y valúala aquí mismo, con el cliente.',
    k6: "06 · INTELIGENCIA ARTIFICIAL", h6a: "Tu propia secretaria,", h6b: "que nunca duerme.",
    b6: "Todos sabemos que la inteligencia artificial ya viene — ¿qué mejor que empezar desde ahora? Tu propia secretaria contesta los mensajes de los clientes que llegan de tu página, a cualquier hora del día.",
    p6a: "Contesta al momento — aunque sean las 11 de la noche", p6b: "Agenda la cita por ti. Tú solo llegas a hacerla.", p6c: "Puedes ver cada conversación cuando quieras", p6d: "Lista en 10–14 días — el registro de tu número con las telefónicas tarda unos días",
    chHead: "🔴 DEMO EN VIVO — escríbele como si fueras el dueño", chGreet: "¡Hola! 👋 Soy la asistente de Casa Bella Realty. ¿Le puedo ayudar a comprar o vender una casa?",
    chPh: "Escribe como dueño… (ej. quiero vender mi casa)", chFoot: "Esta misma IA contestará los textos de TUS leads", chRetry: "Dame un momentito y te contesto 🙏 (intenta de nuevo)",
    k7: "07 · TU INVERSIÓN", h7a: "Elige tu plan,", h7b: "sin costo de inicio.",
    b7: "Lo que esto costaría por separado (precios típicos del mercado):",
    s7a: "🌐 Página web profesional con tu marca", s7b: "🏡 Valuador de casas en tu página", s7c: "🤖 Secretaria IA que textea y agenda", s7d: "📲 App de valores, CMAs y leads", s7e: "🇺🇸 Dominio, hosting y soporte en español",
    s7tot: "Por separado", roi7: '💰 <b style="color:#fff">Una comisión son miles de dólares.</b> Un solo cierre extra paga tu año entero.',
    pk7: "CON QUICK COMP · ELIGE TU PLAN", mo: "/mes", setup7: "Sin costo de inicio — solo la mensualidad.",
    tiers7: [["PRO — solo la app", 67, 0], ["WIDGET — en la página que ya tienes", 197, 1], ["COMPLETE — página web + todo", 297, 0]],
    pr7a: "✓ Sin contratos largos", pr7b: "✓ Cancelas cuando quieras", pr7c: "✓ Tu dominio es TUYO — por contrato",
    k8: "08 · EMPECEMOS", h8a: "Empecemos", h8b: "hoy mismo.",
    b8: "Así de fácil es arrancar — todo empieza en esta misma llamada:",
    d8a: "PASO 1", t8a: "Asegura tu lugar", x8a: "Te mandamos un link de pago seguro a tu WhatsApp. Pagas con tarjeta, protegido por Stripe 🔒.",
    d8b: "PASO 2 · HOY", t8b: "Tu app, hoy mismo", x8b: "Tu acceso te llega por WhatsApp antes de colgar. Hoy mismo ya estás valuando casas.",
    d8c: "PASO 3", t8c: "Tu onboarding", x8c: "Agendamos tu llamada ahorita: tu logo, tus colores, tu especialidad y tus fotos.",
    d8d: "DÍA 10–14", t8d: "Todo funcionando", x8d: "Tu página, tu valuador y tu secretaria IA — 24/7. Las telefónicas tardan unos días en aprobar tu número; usamos ese tiempo para dejar todo perfecto.",
    c8: "🤝 ¿Listo? Te mando el link ahora mismo.",
  };

  res.send(`<!doctype html><html lang="${en ? "en" : "es"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${L.title}</title><link rel="icon" href="/icon-192.png">
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;0,9..144,700;1,9..144,600&family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0;-webkit-tap-highlight-color:transparent}
:root{--navy:#101B30;--navy2:#0B1226;--gold:#C9973A;--mut:#9DA8C4;--line:rgba(255,255,255,.1)}
body{background:var(--navy2);color:#fff;overflow:hidden}
.layout{display:flex;height:100vh;height:100dvh}
aside{width:268px;background:#fff;border-right:1px solid #E9EAEE;display:flex;flex-direction:column;flex-shrink:0}
.sb-brand{display:flex;justify-content:center;padding:26px 18px 16px}
.sb-brand img{height:58px;display:block}
.sb-label{font-size:10px;letter-spacing:2.5px;color:#9AA0AC;font-weight:800;padding:10px 18px 6px}
nav{flex:1;overflow-y:auto;padding-bottom:10px;display:flex;flex-direction:column}
.nav-it{flex:1;display:flex;align-items:center;gap:14px;width:100%;background:none;border:none;color:#6A7384;font-weight:700;font-size:16px;padding:0 20px;cursor:pointer;text-align:left;border-left:4px solid transparent;min-height:48px}
.nav-it .no{font-family:'Fraunces',Georgia,serif;font-size:13px;color:#B6BCC8;width:22px}
.nav-it.on{color:#101B30;background:rgba(201,151,58,.13);border-left-color:var(--gold)}
.nav-it.on .no{color:#B07A00}
.sb-foot{padding:14px 18px;font-size:11px;color:#9AA0AC;font-weight:700;border-top:1px solid #E9EAEE}
main{flex:1;position:relative;display:flex;flex-direction:column;min-width:0}
.stage{flex:1;position:relative;overflow:hidden}
.slide{position:absolute;inset:0;display:none;flex-direction:column;overflow-y:auto}
.slide.on{display:flex}
.s-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.38;filter:saturate(.65)}
.s-veil{position:absolute;inset:0;background:linear-gradient(160deg,rgba(11,18,38,.95) 0%,rgba(16,27,48,.82) 55%,rgba(16,27,48,.55) 100%)}
.s-in{position:relative;flex:1;display:flex;flex-direction:column;justify-content:center;padding:clamp(26px,5vw,72px);max-width:980px}
.kick{color:var(--gold);font-weight:800;font-size:12px;letter-spacing:3.5px;margin-bottom:18px;text-transform:uppercase}
h1{font-family:'Fraunces',Georgia,serif;font-size:clamp(34px,5.2vw,64px);line-height:1.06;font-weight:700;max-width:740px}
h1 em{font-style:italic;color:var(--gold)}
.rule{width:54px;height:4px;background:var(--gold);border-radius:2px;margin:22px 0}
.body{color:var(--mut);font-weight:500;font-size:clamp(15px,1.8vw,18px);line-height:1.7;max-width:560px}
.glass{display:flex;gap:clamp(18px,4vw,52px);background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:18px;padding:20px 26px;margin-top:34px;width:fit-content;flex-wrap:wrap;backdrop-filter:blur(8px)}
.glass .g b{font-family:'Fraunces',Georgia,serif;font-size:clamp(22px,2.6vw,32px);color:var(--gold);display:block;font-weight:700}
.glass .g span{font-size:11px;letter-spacing:1.8px;color:#C9D2E5;font-weight:700;text-transform:uppercase}
ul.pts{list-style:none;padding:0;margin:26px 0 0;max-width:580px}
ul.pts li{padding:13px 0;border-bottom:1px solid var(--line);font-weight:600;font-size:clamp(14px,1.7vw,17px);line-height:1.55;color:#E7ECF6;display:flex;gap:12px}
ul.pts li b{color:var(--gold);flex-shrink:0}
ul.pts.big{max-width:940px}
ul.pts.big li{font-size:clamp(16px,2.2vw,22px);padding:19px 0;line-height:1.6;gap:16px}
.devices{display:flex;align-items:center;gap:36px;flex-wrap:wrap;margin-top:30px}
.webframe{background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.5);width:min(600px,100%)}
.webframe .bar{display:flex;align-items:center;gap:6px;background:#E9EAEE;padding:9px 14px}
.webframe .dot{width:10px;height:10px;border-radius:50%;background:#C9CDD6}
.webframe .url{flex:1;background:#fff;border-radius:8px;font-size:11.5px;color:#5E6470;font-weight:600;padding:5px 12px;margin-left:8px}
.dscr{width:100%;height:430px;overflow:hidden}
.dscr iframe{width:1180px;height:846px;border:0;transform:scale(.508);transform-origin:0 0;display:block;background:#fff}
.iphone{position:relative;background:#0B1226;border:10px solid #1E2A45;border-radius:48px;padding:11px;box-shadow:0 30px 80px rgba(0,0,0,.55)}
.inotch{position:absolute;top:11px;left:50%;transform:translateX(-50%);width:110px;height:22px;background:#1E2A45;border-radius:0 0 13px 13px;z-index:2}
.mscr{width:234px;height:464px;overflow:hidden;border-radius:26px}
.mscr iframe{width:390px;height:776px;border:0;transform:scale(.6);transform-origin:0 0;background:#fff}
.iphone.big .mscr{width:330px;height:660px}
.iphone.big .mscr iframe{transform:scale(.846);height:780px}
.tl{display:grid;gap:22px;margin-top:32px}
@media(min-width:760px){.tl{grid-template-columns:repeat(3,1fr)}}
@media(min-width:980px){.tl.four{grid-template-columns:repeat(4,1fr);gap:18px}}
.tl .ph{background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:20px;padding:26px}
.tl .ph .ic{font-size:36px;display:block;margin-bottom:12px}
.tl .ph .d{color:var(--gold);font-weight:800;font-size:12px;letter-spacing:2.5px}
.tl .ph h3{font-family:'Fraunces',Georgia,serif;font-size:22px;margin:8px 0 8px;font-weight:700}
.tl .ph p{color:var(--mut);font-size:14px;font-weight:500;line-height:1.65}
.tl .ph.hot{border:1.5px solid var(--gold);background:rgba(201,151,58,.1);box-shadow:0 18px 48px rgba(201,151,58,.14)}
.amt{font-family:'Fraunces',Georgia,serif;font-size:clamp(72px,11vw,130px);font-weight:700;line-height:1;color:#fff;margin-top:6px}
.amt small{font-size:clamp(20px,2.8vw,30px);color:var(--mut)}
.stack{border:1px solid var(--line);border-radius:18px;overflow:hidden;max-width:560px}
.srow{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:13px 18px;border-bottom:1px solid var(--line);font-weight:600;font-size:14.5px;color:#E7ECF6}
.srow s{color:#8E99B5;font-weight:700;white-space:nowrap}
.srow.tot{background:rgba(255,255,255,.05);border-bottom:none;font-weight:800}
.srow.tot s{color:#C9D2E5}
.pcard{background:#fff;color:#101B30;border-radius:26px;padding:34px 32px;text-align:center;box-shadow:0 34px 90px rgba(201,151,58,.18),0 30px 70px rgba(0,0,0,.45);width:min(340px,100%)}
.pcard .pk{color:#B07A00;font-weight:800;font-size:11px;letter-spacing:2.5px}
.pcard .pamt{font-family:'Fraunces',Georgia,serif;font-size:74px;font-weight:700;line-height:1;margin-top:10px}
.pcard .pamt small{font-size:24px;color:#67718A}
.pcard .psetup{color:#67718A;font-weight:700;font-size:14px;margin-top:8px}
.pcard .trow{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid #F0F2F6;text-align:left}
.pcard .trow span{font-weight:700;font-size:13px;color:#3A455C;line-height:1.35}
.pcard .trow b{font-family:'Fraunces',Georgia,serif;font-size:30px;font-weight:700;white-space:nowrap}
.pcard .trow b small{font-size:14px;color:#67718A;font-family:Inter,Arial,sans-serif;font-weight:700}
.pcard .trow.star{background:#F7EFD8;border:1.5px solid #C9973A;border-radius:14px;padding:11px 12px;margin:4px -12px}
.pcard .pdiv{height:1px;background:#E9EAEE;margin:20px 0}
.pcard .prow{font-weight:700;font-size:14px;padding:5px 0;text-align:left}
.chat{background:#fff;border-radius:22px;padding:16px;width:min(350px,100%);box-shadow:0 30px 70px rgba(0,0,0,.5)}
.ch-head{color:#5E6470;font-weight:800;font-size:12px;text-align:center;padding-bottom:10px;border-bottom:1px solid #EDF0F5;margin-bottom:12px}
.bub{max-width:85%;border-radius:16px;padding:10px 14px;font-size:13.5px;font-weight:600;line-height:1.5;margin-bottom:8px}
.bub.them{background:#F0F2F6;color:#16202E;border-bottom-left-radius:5px}
.bub.me{background:#101B30;color:#fff;margin-left:auto;border-bottom-right-radius:5px}
.ch-foot{color:#9AA0AC;font-weight:700;font-size:11.5px;text-align:center;padding-top:8px}
#chatlog{max-height:300px;overflow-y:auto;display:flex;flex-direction:column}
.ch-in{display:flex;gap:8px;margin-top:10px}
.ch-in input{flex:1;border:1.5px solid #E2E6ED;border-radius:11px;padding:11px 13px;font-size:13.5px;font-weight:600;outline:none;color:#16202E;min-width:0}
.ch-in input:focus{border-color:#C9973A}
.ch-in button{background:#C9973A;color:#101B30;border:none;border-radius:11px;padding:0 18px;font-weight:800;font-size:17px;cursor:pointer}
.bub.typing{color:#9AA0AC;background:#F0F2F6;font-weight:800;letter-spacing:2px}
.duo{display:grid;gap:44px;align-items:start;margin-top:6px}
@media(min-width:980px){.duo{grid-template-columns:1fr 350px}}
.photocard{background:#fff;border-radius:6px;padding:12px 12px 0;box-shadow:0 30px 70px rgba(0,0,0,.5);transform:rotate(2deg);width:min(350px,100%)}
.photocard img{width:100%;border-radius:3px;display:block}
.photocard .cap{display:block;text-align:center;color:#3A4252;font-weight:700;font-size:13px;padding:13px 0;font-family:'Fraunces',Georgia,serif}
.photocard.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;border:2px dashed rgba(255,255,255,.3);background:rgba(255,255,255,.04);box-shadow:none;min-height:300px;padding:24px;transform:none}
.photocard.empty span{font-size:40px}
.photocard.empty p{color:var(--mut);font-weight:700;font-size:13.5px;text-align:center;line-height:1.6;margin-top:10px}
.bbar{display:flex;align-items:center;justify-content:space-between;padding:14px clamp(16px,3vw,30px);border-top:1px solid var(--line);background:var(--navy)}
.bbar .pn{display:flex;gap:10px}
.bbar button{border-radius:11px;font-weight:800;font-size:14px;padding:12px 22px;cursor:pointer}
.bbar .prev{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.25)}
.bbar .next{background:var(--gold);color:var(--navy);border:none}
.bbar .ct{font-family:'Fraunces',Georgia,serif;font-size:15px;color:var(--mut)}
.langpill{position:fixed;top:16px;right:18px;z-index:45;background:rgba(255,255,255,.95);color:#101B30;border-radius:99px;padding:9px 18px;font-weight:800;font-size:13px;text-decoration:none;box-shadow:0 10px 28px rgba(0,0,0,.35)}
@media(max-width:899px){
  aside{position:fixed;z-index:60;left:0;top:0;bottom:0;transform:translateX(-100%);transition:transform .25s ease;width:260px}
  aside.open{transform:none}
  .mtop{display:flex !important}
  .scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:55;display:none}
  .scrim.on{display:block}
  .langpill{top:auto;bottom:74px;right:14px}
}
.mtop{display:none;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--navy);border-bottom:1px solid var(--line)}
.mtop .mt-b{background:none;border:1.5px solid rgba(255,255,255,.25);color:#fff;border-radius:10px;padding:8px 14px;font-weight:800;font-size:13px;cursor:pointer}
.mtop b em{color:var(--gold);font-style:normal}
#ckit{display:none;position:fixed;right:18px;bottom:70px;z-index:80;background:#fff;color:#101B30;border-radius:16px;padding:14px 16px;box-shadow:0 24px 60px rgba(0,0,0,.5);width:280px}
#ckit.on{display:block}
#ckit .ck-t{font-weight:800;font-size:13px;margin-bottom:10px}
#ckit .ck-t small{color:#9AA0AC;font-weight:600;font-size:10.5px}
#ckit .ck-row{display:flex;align-items:center;gap:8px;padding:6px 0;font-weight:700;font-size:13px}
#ckit .ck-row span{flex:1}
#ckit button{background:#C9973A;color:#101B30;border:none;border-radius:8px;padding:6px 12px;font-weight:800;font-size:12px;cursor:pointer}
#ckit .ck-k{color:#9AA0AC;font-size:10.5px;font-weight:600;margin-top:8px}
#ktoast{display:none;position:fixed;left:18px;bottom:70px;z-index:80;background:#34A853;color:#fff;border-radius:99px;width:34px;height:34px;align-items:center;justify-content:center;font-weight:800}
#ktoast.on{display:flex}
.ct{cursor:default;user-select:none}
</style></head><body>
<a class="langpill" href="${L.langHref}">${L.langBtn}</a>
<div class="layout">
<aside id="sb">
  <div class="sb-brand"><img src="/brand-logo.png" alt="Quick Comp"></div>
  <div class="sb-label">${L.presentation}</div>
  <nav id="nav"></nav>
  <div class="sb-foot">${L.forClients}</div>
</aside>
<div class="scrim" id="scrim" onclick="toggleSb(false)"></div>
<main>
<div class="mtop"><button class="mt-b" onclick="toggleSb(true)">${L.menu}</button><b>QUICK <em>COMP</em></b><span style="width:64px"></span></div>
<div class="stage" id="stage">

<section class="slide" data-t="${L.t1}">
  <img class="s-bg" src="/api/roofimg?lat=26.3828&lng=-98.8198&zoom=17" alt=""><div class="s-veil"></div>
  <div class="s-in">
    <p class="kick">${L.k1}</p>
    <h1>${L.h1a}<br><em>${L.h1b}</em></h1>
    <div class="rule"></div>
    <p class="body">${L.b1}</p>
    <div class="glass">
      <div class="g"><b>${L.g1}</b><span>${L.g1s}</span></div>
      <div class="g"><b>${L.g2}</b><span>${L.g2s}</span></div>
      <div class="g"><b>${L.g3}</b><span>${L.g3s}</span></div>
    </div>
  </div>
</section>

<section class="slide" data-t="${L.t2}">
  ${founderBg ? `<img class="s-bg" src="/landing/founder-bg.jpg" alt="" style="opacity:.16">` : ""}
  <div class="s-veil"></div>
  <div class="s-in" style="max-width:1120px">
    <p class="kick">${L.k2}</p>
    <h1>${L.h2a}<br><em>${L.h2b}</em></h1>
    <div class="rule"></div>
    <div class="duo">
      <div>
        <p class="body">${L.b2}</p>
        <ul class="pts">
          <li><b>—</b><span>${L.p2a}</span></li>
          <li><b>—</b><span>${L.p2b}</span></li>
          <li><b>—</b><span>${L.p2c}</span></li>
        </ul>
      </div>
      ${teamPhoto
        ? `<div class="photocard"><img src="/landing/team.jpg" alt=""><span class="cap">${L.cap2}</span></div>`
        : `<div class="photocard empty"><span>📸</span><p>${L.ph2a}<br>${L.ph2b}</p></div>`}
    </div>
  </div>
</section>

<section class="slide" data-t="${L.t3}">
  <div class="s-veil"></div>
  <div class="s-in" style="max-width:1150px">
    <p class="kick">${L.k3}</p>
    <h1>${L.h3a}<br><em>${L.h3b}</em></h1>
    <div class="rule"></div>
    <ul class="pts big">
      <li><b>📵</b><span>${L.p3a}</span></li>
      <li><b>🕐</b><span>${L.p3b}</span></li>
      <li><b>🌐</b><span>${L.p3c}</span></li>
      <li><b>🤖</b><span>${L.p3d}</span></li>
    </ul>
    <p class="body" style="margin-top:28px;font-size:clamp(17px,2.3vw,23px);max-width:940px"><b style="color:#C9973A">${L.c3}</b></p>
  </div>
</section>

<section class="slide" data-t="${L.t4}">
  <div class="s-veil"></div>
  <div class="s-in" style="max-width:1180px">
    <p class="kick">${L.k4}</p>
    <h1>${L.h4a} <em>${L.h4b}</em></h1>
    <p class="body" style="margin-top:14px">${L.b4}</p>
    <div class="devices">
      <div class="webframe"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">tunegocio.com</span></div><div class="dscr"><iframe data-src="/ejemplo?embed=1" title="Web"></iframe></div></div>
      <div class="iphone"><div class="inotch"></div><div class="mscr"><iframe data-src="/ejemplo?embed=1" title="Mobile"></iframe></div></div>
    </div>
  </div>
</section>

<section class="slide" data-t="${L.t5}">
  <div class="s-veil"></div>
  <div class="s-in" style="max-width:1120px">
    <p class="kick">${L.k5}</p>
    <h1>${L.h5a}<br><em>${L.h5b}</em></h1>
    <div class="rule"></div>
    <div class="duo">
      <div>
        <ul class="pts" style="margin-top:0">
          <li><b>🛰️</b><span>${L.p5a}</span></li>
          <li><b>📥</b><span>${L.p5b}</span></li>
          <li><b>🤖</b><span>${L.p5c}</span></li>
          <li><b>🧾</b><span>${L.p5d}</span></li>
        </ul>
        <p class="body" style="margin-top:22px;font-size:14px">${L.live5}</p>
      </div>
      <div class="iphone big"><div class="inotch"></div><div class="mscr"><iframe data-src="/?demo=app${appPass}" title="App"></iframe></div></div>
    </div>
  </div>
</section>

<section class="slide" data-t="${L.t6}">
  <div class="s-veil"></div>
  <div class="s-in" style="max-width:1120px">
    <p class="kick">${L.k6}</p>
    <h1>${L.h6a}<br><em>${L.h6b}</em></h1>
    <div class="rule"></div>
    <div class="duo">
      <div>
        <p class="body">${L.b6}</p>
        <ul class="pts">
          <li><b>🤖</b><span>${L.p6a}</span></li>
          <li><b>📅</b><span>${L.p6b}</span></li>
          <li><b>👀</b><span>${L.p6c}</span></li>
          <li><b>⚙️</b><span>${L.p6d}</span></li>
        </ul>
      </div>
      <div class="chat">
        <div class="ch-head">${L.chHead}</div>
        <div id="chatlog">
          <div class="bub me">${L.chGreet}</div>
        </div>
        <div class="ch-in">
          <input id="chq" placeholder="${L.chPh}" onkeydown="if(event.key==='Enter')sendChat()">
          <button onclick="sendChat()">→</button>
        </div>
        <div class="ch-foot">${L.chFoot}</div>
      </div>
    </div>
  </div>
</section>

<section class="slide" data-t="${L.t7}">
  <div class="s-veil"></div>
  <div class="s-in" style="max-width:1150px">
    <p class="kick">${L.k7}</p>
    <h1>${L.h7a} <em>${L.h7b}</em></h1>
    <div class="rule"></div>
    <div class="duo" style="align-items:center">
      <div>
        <p class="body" style="font-size:13.5px;margin-bottom:14px">${L.b7}</p>
        <div class="stack">
          <div class="srow"><span>${L.s7a}</span><s>$1,500+</s></div>
          <div class="srow"><span>${L.s7b}</span><s>$250${L.mo}</s></div>
          <div class="srow"><span>${L.s7c}</span><s>$300${L.mo}</s></div>
          <div class="srow"><span>${L.s7d}</span><s>$99${L.mo}</s></div>
          <div class="srow"><span>${L.s7e}</span><s>$50${L.mo}</s></div>
          <div class="srow tot"><span>${L.s7tot}</span><s>$1,500+</s></div>
        </div>
        <p class="body" style="margin-top:20px;font-size:14px">${L.roi7}</p>
      </div>
      <div class="pcard">
        <p class="pk">${L.pk7}</p>
        ${L.tiers7.map(([nm, amt, star]) => `<div class="trow${star ? " star" : ""}"><span>${star ? "⭐ " : ""}${nm}</span><b>$${amt}<small>${L.mo}</small></b></div>`).join("")}
        <p class="psetup">${L.setup7}</p>
        <div class="pdiv"></div>
        <p class="prow">${L.pr7a}</p>
        <p class="prow">${L.pr7b}</p>
        <p class="prow">${L.pr7c}</p>
      </div>
    </div>
  </div>
</section>

<section class="slide" data-t="${L.t8}">
  <img class="s-bg" src="/api/roofimg?lat=26.3828&lng=-98.8198&zoom=18" alt=""><div class="s-veil"></div>
  <div class="s-in" style="max-width:1150px">
    <p class="kick">${L.k8}</p>
    <h1>${L.h8a} <em>${L.h8b}</em></h1>
    <div class="rule"></div>
    <p class="body">${L.b8}</p>
    <div class="tl four">
      <div class="ph hot"><span class="ic">💳</span><span class="d">${L.d8a}</span><h3>${L.t8a}</h3><p>${L.x8a}</p></div>
      <div class="ph"><span class="ic">📲</span><span class="d">${L.d8b}</span><h3>${L.t8b}</h3><p>${L.x8b}</p></div>
      <div class="ph"><span class="ic">🤝</span><span class="d">${L.d8c}</span><h3>${L.t8c}</h3><p>${L.x8c}</p></div>
      <div class="ph"><span class="ic">🚀</span><span class="d">${L.d8d}</span><h3>${L.t8d}</h3><p>${L.x8d}</p></div>
    </div>
    <p class="body" style="margin-top:26px;font-size:15px"><b style="color:#fff">${L.c8}</b></p>
  </div>
</section>

</div>
<div class="bbar">
  <div class="pn"><button class="prev" onclick="go(-1)">${L.prev}</button><button class="next" onclick="go(1)">${L.next}</button></div>
  <span class="ct" id="ct">1 / 8</span>
</div>
</main>
</div>
<div id="ckit">
  <p class="ck-t">🔒 Closer · <small>doble clic en el contador o tecla C</small></p>
  <div class="ck-row"><span>💳 Pago</span><button onclick="kCopy(K.pay,this)">Copiar</button><button onclick="kOpen()">Abrir</button></div>
  <div class="ck-row"><span>👋 Bienvenida</span><button onclick="kCopy(K.wel,this)">Copiar</button></div>
  <div class="ck-row"><span>👀 Msj demo</span><button onclick="kCopy(K.dem,this)">Copiar</button></div>
  <p class="ck-k">Teclas rápidas: <b>P</b> pago · <b>B</b> bienvenida · <b>D</b> demo · <b>O</b> abrir pago</p>
</div>
<div id="ktoast">✓</div>
<script>
var EN=${en ? "true" : "false"};
var slides=[].slice.call(document.querySelectorAll('.slide')),cur=0,nav=document.getElementById('nav');
slides.forEach(function(s,i){
  var b=document.createElement('button');b.className='nav-it';
  b.innerHTML='<span class="no">'+String(i+1).padStart(2,'0')+'</span>'+s.dataset.t;
  b.onclick=function(){show(i);toggleSb(false)};nav.appendChild(b);
});
function show(i){
  cur=Math.max(0,Math.min(slides.length-1,i));
  slides.forEach(function(s,k){s.classList.toggle('on',k===cur)});
  [].slice.call(nav.children).forEach(function(b,k){b.classList.toggle('on',k===cur)});
  document.getElementById('ct').textContent=(cur+1)+' / '+slides.length;
  [].slice.call(slides[cur].querySelectorAll('iframe[data-src]')).forEach(function(f){if(!f.src)f.src=f.dataset.src});
  location.hash=cur+1;
}
function go(d){show(cur+d)}
function cp(btn,t){navigator.clipboard.writeText(t);btn.textContent='✓'}
/* hidden closer kit: double-click the counter or press C */
var K={pay:${JSON.stringify(stripeLink)},wel:${JSON.stringify(welcome)},dem:${JSON.stringify(wMsg)}};
function kToast(){var t=document.getElementById('ktoast');t.classList.add('on');setTimeout(function(){t.classList.remove('on')},700)}
function kCopy(v,btn){
  if(!v){alert('Falta configurar STRIPE_PAYMENT_LINK en Render');return}
  navigator.clipboard.writeText(v);kToast();
  if(btn){btn.textContent='✓';setTimeout(function(){btn.textContent='Copiar'},900)}
}
function kOpen(){if(!K.pay){alert('Falta configurar STRIPE_PAYMENT_LINK en Render');return}window.open(K.pay,'_blank')}
document.getElementById('ct').addEventListener('dblclick',function(){document.getElementById('ckit').classList.toggle('on')});
document.addEventListener('keydown',function(e){
  if(/INPUT|TEXTAREA/.test(e.target.tagName))return;
  var k=e.key.toLowerCase();
  if(k==='c')document.getElementById('ckit').classList.toggle('on');
  if(k==='p')kCopy(K.pay);
  if(k==='b')kCopy(K.wel);
  if(k==='d')kCopy(K.dem);
  if(k==='o')kOpen();
});
var chatHist=[{role:'assistant',content:${JSON.stringify(en ? "Hi! 👋 I'm the assistant at Casa Bella Realty. How can I help you buy or sell a home?" : "¡Hola! 👋 Soy la asistente de Casa Bella Realty. ¿Le puedo ayudar a comprar o vender una casa?")}}],chatBusy=false;
function addBub(cls,txt){var log=document.getElementById('chatlog'),d=document.createElement('div');d.className='bub '+cls;d.textContent=txt;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
function sendChat(){
  if(chatBusy)return;
  var inp=document.getElementById('chq'),q=inp.value.trim();
  if(!q)return;
  inp.value='';chatBusy=true;
  addBub('them',q);chatHist.push({role:'user',content:q});
  var ty=addBub('me typing','● ● ●');
  fetch('/api/widget/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:chatHist,lang:EN?'en':'es'})})
    .then(function(r){return r.ok?r.json():null})
    .then(function(j){
      ty.remove();chatBusy=false;
      if(j&&j.text){addBub('me',j.text);chatHist.push({role:'assistant',content:j.text})}
      else{addBub('me',${JSON.stringify(en ? "Give me one moment 🙏 (try again)" : "Dame un momentito y te contesto 🙏 (intenta de nuevo)")})}
    })
    .catch(function(){ty.remove();chatBusy=false;addBub('me',${JSON.stringify(en ? "Give me one moment 🙏 (try again)" : "Dame un momentito y te contesto 🙏 (intenta de nuevo)")})});
}
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight')go(1);if(e.key==='ArrowLeft')go(-1)});
show(parseInt(location.hash.slice(1))-1||0);
</script>
</body></html>`);
});

/* ── Contractor logos ──
 * Stored by content hash; the app re-uploads automatically whenever it shares,
 * so logos self-heal after server restarts. */
const logosDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "logos");
fs.mkdirSync(logosDir, { recursive: true });

app.post("/api/logo", (req, res) => {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.data || ""));
  if (!m) return res.status(400).json({ error: "bad image" });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 150000) return res.status(413).json({ error: "too large" });
  const id = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16) + (m[1] === "png" ? ".png" : ".jpg");
  try { fs.writeFileSync(path.join(logosDir, id), buf); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ id });
});

app.get("/api/logo/:id", (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-f0-9]{16}\.(png|jpg)$/.test(id)) return res.status(404).end();
  const p = path.join(logosDir, id);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.set("Content-Type", id.endsWith(".png") ? "image/png" : "image/jpeg");
  res.set("Cache-Control", "public, max-age=604800");
  res.send(fs.readFileSync(p));
});

/* ── Shared client CMA report ──
 * The realtor taps "Share report" and the client gets this page by WhatsApp.
 * Like /i, ALL data travels in the link (base64url JSON in ?d=) — nothing is
 * stored server-side, so links survive restarts and redeploys. The page is the
 * agent's deliverable: their brand, the value, the comps, optionally the
 * seller net sheet, and one-tap ways to reach them. */
app.get("/r", (req, res) => {
  let d;
  try {
    const raw = String(req.query.d || "");
    if (!raw || raw.length > 12000) return res.status(400).send("Invalid link");
    d = JSON.parse(Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return res.status(400).send("Invalid link"); }
  const es = d.l !== "en";
  const esc = (x) => String(x || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const N = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
  const fmt = (n) => (N(n) == null ? "—" : "$" + Math.round(N(n)).toLocaleString("en-US"));
  const v = N(d.v), lo = N(d.lo), hi = N(d.hi), ppsf = N(d.ppsf);
  if (!v) return res.status(400).send("Invalid link");
  const g = d.g || {};
  const sub = d.s || {};
  const comps = (Array.isArray(d.c) ? d.c : []).slice(0, 8).map((c) => [String(c[0] || ""), N(c[1])]).filter((c) => c[0] && c[1]);
  const n = N(d.n) || comps.length;
  const logoOk = /^[a-f0-9]{16}\.(png|jpg)$/.test(String(g.lg || ""));
  const phone = String(g.p || "").replace(/\D/g, "");
  const ll = Array.isArray(d.ll) && Number.isFinite(Number(d.ll[0])) && Number.isFinite(Number(d.ll[1])) ? [Number(d.ll[0]), Number(d.ll[1])] : null;
  const drYr = N(d.dr) != null ? N(d.dr) * 12 * 100 : null; // market drift, %/yr
  const pay = d.pay && N(d.pay.mo) ? d.pay : null;
  const rid = /^[a-z0-9]{8,20}$/.test(String(d.rid || "")) ? String(d.rid) : null;
  const hasRange = lo != null && hi != null;
  const narrative = es
    ? `El conjunto de comparables respalda un valor de mercado cercano a ${fmt(v)}${hasRange ? `, dentro de un rango de ${fmt(lo)}–${fmt(hi)}` : ""}. El mayor respaldo proviene de ${n} ${n === 1 ? "venta cercana" : "ventas cercanas"} de tamaño y condición similares${ppsf ? `, con un promedio de ${fmt(ppsf)} por pie²` : ""}.${d.cu ? " Comparables seleccionadas personalmente por su agente." : ""}`
    : `The comparable set supports an indicated market value near ${fmt(v)}${hasRange ? `, within a ${fmt(lo)}–${fmt(hi)} range` : ""}. The strongest support comes from ${n} nearby ${n === 1 ? "sale" : "sales"} of similar size and condition${ppsf ? `, averaging ${fmt(ppsf)} per square foot` : ""}.${d.cu ? " Comparables hand-selected by your agent." : ""}`;
  const ns = d.ns && N(d.ns.net) != null ? d.ns : null;
  // The realtor's brand color drives the whole page — the platform's palette
  // never appears on a client-facing report.
  const B = /^#[0-9a-fA-F]{6}$/.test(String(g.bc || "")) ? g.bc : "#1B2A5C";
  const shade = (hex, f) => {
    const nn = parseInt(hex.slice(1), 16);
    const t = f < 0 ? 0 : 255, p = Math.abs(f);
    const r = Math.round(((nn >> 16) & 255) + (t - ((nn >> 16) & 255)) * p);
    const gg = Math.round(((nn >> 8) & 255) + (t - ((nn >> 8) & 255)) * p);
    const b = Math.round((nn & 255) + (t - (nn & 255)) * p);
    return "#" + ((r << 16) | (gg << 8) | b).toString(16).padStart(6, "0");
  };
  const Bd = shade(B, -0.38), Bt = shade(B, 0.72);
  const L = es
    ? { title: "Informe de valor", pres: "PRESENTADO POR", cma: "Informe CMA", val: "VALOR ESTIMADO DE MERCADO", range: "rango sugerido", sup: "Apoyo de ventas comparables", ai: "RESUMEN ASISTIDO POR IA", disc: "Estimado basado en ventas comparables recientes — no es un avalúo.", nsT: "HOJA NETA DEL VENDEDOR", nsPrice: "Precio de venta", nsComm: "Comisión", nsClose: "Gastos de cierre (est.)", nsPay: "Saldo de hipoteca", nsNet: "TU NETO ESTIMADO", trend: "Tendencia del mercado", yr: "año", payT: "PAGO MENSUAL ESTIMADO", payNote: "incluye impuestos, seguro y seguro hipotecario (est.)", down: "de enganche", call: "📞 Llamar", wa: "💬 WhatsApp", mail: "✉️ Email", print: "🖨️ Imprimir / Guardar PDF", made: [g.n, g.b].filter(Boolean).map(esc).join(" · ") || "", facts: [["Recámaras", sub.bd], ["Baños", sub.ba], ["Pies²", sub.sf ? Number(sub.sf).toLocaleString("en-US") : null], ["Año", sub.yr]] }
    : { title: "Home value report", pres: "PRESENTED BY", cma: "Client CMA Report", val: "ESTIMATED MARKET VALUE", range: "suggested range", sup: "Sold Comparable Support", ai: "AI-ASSISTED SUMMARY", disc: "Estimate based on recent comparable sales — not an appraisal.", nsT: "SELLER NET SHEET", nsPrice: "Sale price", nsComm: "Commission", nsClose: "Closing costs (est.)", nsPay: "Mortgage payoff", nsNet: "YOUR ESTIMATED NET", trend: "Market trend", yr: "yr", payT: "ESTIMATED MONTHLY PAYMENT", payNote: "includes taxes, insurance & mortgage insurance (est.)", down: "down", call: "📞 Call", wa: "💬 WhatsApp", mail: "✉️ Email", print: "🖨️ Print / Save PDF", made: [g.n, g.b].filter(Boolean).map(esc).join(" · ") || "", facts: [["Bedrooms", sub.bd], ["Baths", sub.ba], ["Sq ft", sub.sf ? Number(sub.sf).toLocaleString("en-US") : null], ["Built", sub.yr]] };
  const base = canonBase(req);
  res.send(`<!doctype html><html lang="${es ? "es" : "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.a)} · ${L.title}</title>
<meta property="og:title" content="${esc(d.a)} — ${fmt(v)}">
<meta property="og:description" content="${esc(L.title)}${g.n ? ` · ${esc(g.n)}${g.b ? ", " + esc(g.b) : ""}` : ""}">
<meta property="og:image" content="${base}/icon-512.png">
<meta name="robots" content="noindex">
<link rel="icon" href="/icon-192.png">
<style>
*{box-sizing:border-box;font-family:Inter,-apple-system,Arial,sans-serif;margin:0}
body{background:#EEF1F7;color:#15244C;padding:18px 14px 40px}
.doc{max-width:560px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 18px 44px rgba(17,27,66,.14)}
.head{background:linear-gradient(135deg,${B},${Bd});color:#fff;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.head img{height:40px;max-width:110px;object-fit:contain;background:#fff;border-radius:8px;padding:3px}
.head .who{min-width:0;flex:1}
.head .k{color:${Bt};font-size:8px;font-weight:700;letter-spacing:2px}
.head .nm{font-weight:800;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.head .sub{color:rgba(255,255,255,.72);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.head .cma{font-weight:800;font-size:12px;flex-shrink:0}
.photo{width:100%;height:190px;object-fit:cover;display:block;background:#EDF0F6}
.trend{display:inline-block;background:#EAF4EC;border:1px solid #BFE0C8;color:#1E7B3C;border-radius:20px;padding:5px 12px;font-size:11.5px;font-weight:800;margin-top:10px}
.trend.down{background:#FDF1F0;border-color:#F0CBC6;color:#B3261E}
.paytot{display:flex;justify-content:space-between;font-size:14px;font-weight:900;padding-top:4px}
.paysub{color:#66759D;font-size:10.5px;font-weight:600;margin-top:5px;line-height:1.4}
.body{padding:18px}
.klabel{color:${B};font-size:10px;font-weight:900;letter-spacing:2px}
.val{font-size:38px;font-weight:900;margin:6px 0 2px}
.rng{color:#66759D;font-size:13px;font-weight:600}
.addr{font-weight:700;font-size:14px;margin-top:6px}
.facts{display:flex;gap:8px;margin:14px 0}
.facts div{flex:1;background:#F2F4FA;border:1px solid #E3E8F2;border-radius:12px;text-align:center;padding:9px 4px}
.facts b{display:block;font-size:15px}
.facts span{font-size:9px;color:#66759D;font-weight:700;letter-spacing:1px;text-transform:uppercase}
.sec{background:#F7F8FC;border:1px solid #E3E8F2;border-radius:14px;padding:13px 15px;margin-top:12px}
.sec h3{font-size:12px;font-weight:800;margin-bottom:8px}
.row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid #E9EDF5;font-size:12.5px;font-weight:600}
.row:first-of-type{border-top:none}
.row b{font-weight:800;white-space:nowrap}
.ai{background:linear-gradient(135deg,${B},${Bd});color:#fff;border:none}
.ai h3{color:${Bt};letter-spacing:2px;font-size:9px}
.ai p{font-size:12.5px;line-height:1.6;font-weight:500}
.net{border:2px solid ${B};background:#F8F9FC}
.net .tot{display:flex;justify-content:space-between;border-top:2px solid ${B};margin-top:6px;padding-top:9px;font-size:14px;font-weight:900}
.disc{color:#8A94AC;font-size:10px;font-weight:600;margin-top:12px;line-height:1.5}
.ctas{display:flex;gap:8px;margin-top:16px}
.ctas a{flex:1;text-align:center;text-decoration:none;font-weight:800;font-size:13px;padding:12px 6px;border-radius:12px;background:${B};color:#fff}
.ctas a.wa{background:#25D366}
.printbtn{display:block;width:100%;margin-top:10px;background:#fff;color:${B};border:1.5px solid #D8DFEC;border-radius:12px;padding:12px;font-weight:800;font-size:13px;cursor:pointer}
.made{text-align:center;color:#9AA3B8;font-size:11px;font-weight:700;margin-top:16px}
.made a{color:#9AA3B8}
@media print{body{background:#fff;padding:0}.doc,.doc *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}.doc{box-shadow:none;border-radius:0}.ctas,.printbtn,.made{display:none}}
</style></head><body>
<div class="doc">
  <div class="head">
    ${logoOk ? `<img src="/api/logo/${g.lg}" alt="">` : ""}
    <div class="who">
      <div class="k">${L.pres}</div>
      <div class="nm">${esc(g.n) || "—"}</div>
      ${g.b ? `<div class="sub">${esc(g.b)}</div>` : ""}
      ${g.lic ? `<div class="sub">Lic. ${esc(g.lic)}</div>` : ""}
    </div>
    <div class="cma">${L.cma}</div>
  </div>
  ${ll ? `<img class="photo" src="/api/streetview?lat=${ll[0]}&lng=${ll[1]}" alt="" onerror="this.style.display='none'">` : ""}
  <div class="body">
    <div class="klabel">${L.val}</div>
    <div class="val">${fmt(v)}</div>
    ${hasRange ? `<div class="rng">${fmt(lo)} – ${fmt(hi)} ${L.range}</div>` : ""}
    <div class="addr">${esc(d.a)}</div>
    ${drYr != null && Math.abs(drYr) >= 1 ? `<div class="trend${drYr < 0 ? " down" : ""}">📈 ${L.trend}: ${drYr > 0 ? "↑" : "↓"} ~${Math.abs(drYr).toFixed(1)}%/${L.yr}</div>` : ""}
    ${L.facts.some(([, x]) => x != null) ? `<div class="facts">${L.facts.filter(([, x]) => x != null).map(([k, x]) => `<div><b>${esc(x)}</b><span>${k}</span></div>`).join("")}</div>` : ""}
    ${comps.length ? `<div class="sec"><h3>${L.sup}</h3>${comps.map((c, i) => `<div class="row"><span>${i + 1}. ${esc(c[0])}</span><b>${fmt(c[1])}</b></div>`).join("")}</div>` : ""}
    <div class="sec ai"><h3>${L.ai}</h3><p>${esc(narrative)}</p></div>
    ${pay ? `<div class="sec net"><h3>💳 ${L.payT}</h3>
      <div class="paytot"><span>${esc(pay.tp || "")} · ${esc(N(pay.dp) ?? "")}% ${L.down}</span><span>${fmt(pay.mo)}/${es ? "mes" : "mo"}</span></div>
      <p class="paysub">${esc(N(pay.rt) ?? "")}% · ${esc(N(pay.yr) ?? "")} ${es ? "años" : "yr"} — ${L.payNote}</p>
    </div>` : ""}
    ${ns ? `<div class="sec net"><h3>💰 ${L.nsT}</h3>
      <div class="row"><span>${L.nsPrice}</span><b>${fmt(v)}</b></div>
      <div class="row"><span>${L.nsComm} (${esc(N(ns.cm) ?? "—")}%)</span><b>−${fmt(v * (N(ns.cm) || 0) / 100)}</b></div>
      <div class="row"><span>${L.nsClose} (${esc(N(ns.cl) ?? "—")}%)</span><b>−${fmt(v * (N(ns.cl) || 0) / 100)}</b></div>
      ${N(ns.po) ? `<div class="row"><span>${L.nsPay}</span><b>−${fmt(ns.po)}</b></div>` : ""}
      <div class="tot"><span>${L.nsNet}</span><span>${fmt(ns.net)}</span></div>
    </div>` : ""}
    <p class="disc">⚠️ ${L.disc}</p>
    <div class="ctas">
      ${phone ? `<a href="tel:+1${phone}">${L.call}</a><a class="wa" href="https://wa.me/1${phone}">${L.wa}</a>` : ""}
      ${g.e ? `<a href="mailto:${esc(g.e)}">${L.mail}</a>` : ""}
    </div>
    <button class="printbtn" onclick="window.print()">${L.print}</button>
  </div>
</div>
${L.made ? `<p class="made">${L.made}</p>` : ""}
${rid ? `<img src="/api/r/open?rid=${rid}" alt="" width="1" height="1" style="position:absolute;opacity:0" aria-hidden="true">` : ""}
</body></html>`);
});

/* Report-open beacon: the shared page loads a 1px image pointing here, so the
 * agent can see "your client opened the report". GET so no JS is needed;
 * harmless counter, quota'd, opaque random ids only. */
app.get("/api/r/open", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const rid = String(req.query.rid || "");
  if (!/^[a-z0-9]{8,20}$/.test(rid)) return res.status(204).end();
  const roIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`ro:${roIp}`, 120)) return res.status(204).end();
  try {
    const cur = (await db.kvGet(`ropen:${rid}`)) || { n: 0 };
    await db.kvSet(`ropen:${rid}`, { n: (Number(cur.n) || 0) + 1, last: new Date().toISOString() });
  } catch { /* counter is best-effort */ }
  res.status(204).end();
});

/* ── AI listing writer ──
 * The agent's most-hated chore, done in one tap: property facts (from a comp
 * or typed in from anywhere) + the agent's own highlights → an MLS-ready
 * description AND a social caption, in the chosen language. Fair-Housing
 * constraints are enforced in the prompt; the agent reviews before posting. */
app.post("/api/listing", async (req, res) => {
  const me = await auth(req).catch(() => null);
  const lwIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (!me && overQuota(`lst:${lwIp}`, 3)) return res.status(429).json({ error: "demo_limit" });
  if (me && overQuota(`lstc:${me.id}`, 30)) return res.status(429).json({ error: "quota" });
  const b = req.body || {};
  const lang = b.lang === "es" ? "es" : "en";
  const facts = {
    address: String(b.address || "").slice(0, 140),
    beds: Number(b.beds) || null,
    baths: Number(b.baths) || null,
    sqft: Number(b.sqft) || null,
    yearBuilt: Number(b.year) || null,
    lotSizeSqft: Number(b.lot) || null,
    propertyType: String(b.type || "").slice(0, 60) || null,
    schools: String(b.schools || "").slice(0, 220) || null,
    agentHighlights: String(b.highlights || "").slice(0, 900),
  };
  if (!facts.address && !facts.agentHighlights) return res.status(400).json({ error: "facts required" });
  if (!aiLive) {
    // Demo fallback so the button always works
    const es = lang === "es";
    const bits = [facts.beds && `${facts.beds} ${es ? "recámaras" : "bedrooms"}`, facts.baths && `${facts.baths} ${es ? "baños" : "baths"}`, facts.sqft && `${Number(facts.sqft).toLocaleString("en-US")} ${es ? "pies²" : "sq ft"}`, facts.yearBuilt && (es ? `construida en ${facts.yearBuilt}` : `built in ${facts.yearBuilt}`), facts.lotSizeSqft && `${Number(facts.lotSizeSqft).toLocaleString("en-US")} ${es ? "pie² de terreno" : "sq ft lot"}`].filter(Boolean).join(", ");
    return res.json({
      source: "demo",
      mls: es
        ? `Bienvenido a ${facts.address || "esta propiedad"} — una casa de ${bits}. ${facts.agentHighlights ? facts.agentHighlights + ". " : ""}${facts.schools ? `Cerca de: ${facts.schools}. ` : ""}Agenda tu cita hoy: propiedades así no duran en el mercado.`
        : `Welcome to ${facts.address || "this property"} — a ${bits} home. ${facts.agentHighlights ? facts.agentHighlights + ". " : ""}${facts.schools ? `Zoned to ${facts.schools}. ` : ""}Schedule your showing today — homes like this don't last.`,
      social: es
        ? `🏡 ¡NUEVO LISTING! ${facts.address || ""} · ${bits} ✨ Manda mensaje para verla 📲`
        : `🏡 JUST LISTED! ${facts.address || ""} · ${bits} ✨ DM to see it 📲`,
    });
  }
  try {
    const raw = await aiChat({
      maxTokens: 700,
      system: `You are an expert US real-estate listing copywriter. Write in ${lang === "es" ? "natural, native SPANISH" : "natural, native ENGLISH"}. STRICT RULES: (1) Fair Housing — never mention or imply race, religion, national origin, familial status, disability, sex, or describe the "ideal buyer" or neighborhood demographics; describe the PROPERTY only. (2) Use ONLY the facts provided — never invent features, schools, or conditions. If schools are provided, mention them factually (school names only, no quality claims). (3) Weave the agent's highlights in naturally. Respond with ONLY a JSON object: {"mls": "an MLS-ready description, 110-170 words, engaging but professional, no emojis, ending with a showing call-to-action", "social": "a short social-media caption, max 45 words, with tasteful emojis and a DM call-to-action"}. No markdown.`,
      messages: [{ role: "user", content: JSON.stringify(facts) }],
    });
    const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
    if (!j.mls) throw new Error("empty");
    res.json({ source: "live", mls: String(j.mls).slice(0, 1600), social: String(j.social || "").slice(0, 500) });
  } catch (e) {
    console.error("listing writer failed:", e.message);
    res.status(502).json({ error: "ai_failed" });
  }
});

/* ── Social media writer — the agent types ONLY an address; the server pulls
 * the county property record itself (a /properties call, no AVM spend) and
 * writes a ready-to-post caption for the chosen announcement type. The client
 * renders it in a textarea, so the agent edits before publishing. ── */
app.post("/api/social", async (req, res) => {
  const me = await auth(req).catch(() => null);
  const scIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (!me && overQuota(`soc:${scIp}`, 3)) return res.status(429).json({ error: "demo_limit" });
  if (me && overQuota(`socc:${me.id}`, 30)) return res.status(429).json({ error: "quota" });
  const b = req.body || {};
  const lang = b.lang === "es" ? "es" : "en";
  const kind = ["listed", "sold", "open", "price"].includes(b.kind) ? b.kind : "listed";
  const address = String(b.address || "").slice(0, 140).trim();
  const notes = String(b.notes || "").slice(0, 500).trim();
  if (!address) return res.status(400).json({ error: "address required" });
  // Best effort: the record fills in beds/baths/size; a miss never blocks the post.
  let facts = null;
  if (RENTCAST_KEY) {
    try {
      const rec = await fetchRentcastRecord(address);
      if (rec) {
        const n = normalizeSubjectProperty(rec, address);
        facts = { address: n.address, beds: n.bedrooms, baths: n.bathrooms, sqft: n.squareFootage, yearBuilt: n.yearBuilt, propertyType: n.propertyType, lotSize: n.lotSize };
      }
    } catch { /* optional */ }
  }
  const es = lang === "es";
  const tag = { listed: es ? "¡NUEVO LISTING!" : "JUST LISTED!", sold: es ? "¡VENDIDA!" : "JUST SOLD!", open: "OPEN HOUSE", price: es ? "¡NUEVO PRECIO!" : "NEW PRICE!" }[kind];
  if (!aiLive) {
    // Demo fallback so the button always works
    const bits = facts ? [facts.beds && `${facts.beds} ${es ? "rec" : "bd"}`, facts.baths && `${facts.baths} ${es ? "baños" : "ba"}`, facts.sqft && `${Number(facts.sqft).toLocaleString("en-US")} ${es ? "pie²" : "sq ft"}`].filter(Boolean).join(" · ") : "";
    return res.json({
      source: "demo",
      facts,
      post: `🏡 ${tag}\n📍 ${address}${bits ? `\n✨ ${bits}` : ""}${notes ? `\n${notes}` : ""}\n${es ? "Manda DM para más información 📲" : "DM me for details 📲"}\n\n#realestate ${es ? "#bienesraices" : "#realtor"} #home #newlisting`,
    });
  }
  const KIND_ANGLE = {
    listed: "a JUST LISTED announcement — build excitement about the new listing",
    sold: "a JUST SOLD celebration — congratulate the (unnamed) clients and invite followers thinking of selling to reach out",
    open: "an OPEN HOUSE invitation — create urgency to attend; include date/time ONLY if the agent's notes provide one",
    price: "a NEW PRICE announcement — frame it as a fresh opportunity, never as desperation",
  };
  try {
    const raw = await aiChat({
      maxTokens: 500,
      system: `You are an expert real-estate social media copywriter (Instagram/Facebook). Write in ${es ? "natural, native SPANISH" : "natural, native ENGLISH"}. STRICT RULES: (1) Fair Housing — never mention or imply race, religion, national origin, familial status, disability, sex, or describe the "ideal buyer" or neighborhood demographics; describe the PROPERTY only. (2) Use ONLY the facts provided — never invent features, prices, dates, schools, or conditions. (3) Write ${KIND_ANGLE[kind]}. Respond with ONLY a JSON object: {"post": "a ready-to-post caption, 50-100 words, short punchy lines separated by line breaks, tasteful emojis, a clear call-to-action, and 4-6 relevant hashtags at the end"}. No markdown.`,
      messages: [{ role: "user", content: JSON.stringify({ address, agentNotes: notes || undefined, facts: facts || undefined }) }],
    });
    const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
    if (!j.post) throw new Error("empty");
    res.json({ source: "live", facts, post: String(j.post).slice(0, 1200) });
  } catch (e) {
    console.error("social writer failed:", e.message);
    res.status(502).json({ error: "ai_failed" });
  }
});

// The app asks how often its sent reports were opened (ids are opaque)
app.get("/api/r/opens", async (req, res) => {
  const rsIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`ros:${rsIp}`, 200)) return res.status(429).json({ error: "quota" });
  const rids = String(req.query.rids || "").split(",").filter((r) => /^[a-z0-9]{8,20}$/.test(r)).slice(0, 30);
  const opens = {};
  for (const rid of rids) {
    const v = await db.kvGet(`ropen:${rid}`).catch(() => null);
    if (v) opens[rid] = { n: Number(v.n) || 0, last: v.last || null };
  }
  res.json({ opens });
});

/* ── Public invoice/estimate page ──
 * All data travels in the link itself (base64url JSON in ?d=) — nothing is
 * stored server-side, so links survive restarts and redeploys. */
app.get("/i", (req, res) => {
  let d;
  try {
    const b64 = String(req.query.d || "").replace(/-/g, "+").replace(/_/g, "/");
    d = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return res.status(400).send("Invalid link");
  }
  const es = d.lang !== "en";
  const L = es
    ? { inv: "FACTURA", est: "COTIZACIÓN", for: "Preparado para", item: "Concepto", subtotal: "Subtotal", deposit: "Depósito recibido", due: "SALDO PENDIENTE", paid: "PAGADO", how: "CÓMO PAGAR", zelle: "Zelle", cash: "Efectivo o cheque aceptado", print: "🖨️ Imprimir / Guardar PDF", made: "Hecho con Quick Comp", meas: "Medición satelital del techo", date: "Fecha", area: "Área del techo", pitch: "Inclinación", sqs: "Cuadros (squares)", imgOf: "Imagen satelital", valid: "Esta cotización es válida por 30 días.", sig: "Autorizado por (firma del cliente)", sigDate: "Fecha" }
    : { inv: "INVOICE", est: "QUOTE", for: "Prepared for", item: "Item", subtotal: "Subtotal", deposit: "Deposit received", due: "BALANCE DUE", paid: "PAID", how: "HOW TO PAY", zelle: "Zelle", cash: "Cash or check accepted", print: "🖨️ Print / Save PDF", made: "Made with Quick Comp", meas: "Satellite roof measurement", date: "Date", area: "Roof area", pitch: "Pitch", sqs: "Squares", imgOf: "Satellite imagery", valid: "This quote is valid for 30 days.", sig: "Authorized by (client signature)", sigDate: "Date" };
  const fmtM = (n) => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const esc = (s) => String(s || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const bal = (d.tot || 0) - (d.dep || 0);
  const img = d.m && d.m.la != null
    ? `/api/roofimg?lat=${d.m.la}&lng=${d.m.ln}` +
      (d.m.bb ? `&bbox=${d.m.bb.join(",")}` : "") +
      (!d.m.bb && d.m.l ? "&zoom=19" : "") +
      (d.m.o ? `&outline=${d.m.o.map((p) => p.join(",")).join(";")}` : "") +
      (d.m.l ? `&lines=${d.m.l.map((run) => run.map((p) => p.join(",")).join("|")).join(";")}` : "")
    : null;
  res.send(`<!doctype html><html lang="${es ? "es" : "en"}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.biz)} · ${d.k === "inv" ? L.inv : L.est} #${esc(d.inv)}</title>
<style>
  body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#F4F5F7;color:#101B30}
  .page{max-width:560px;margin:0 auto;background:#fff;min-height:100vh}
  .hd{background:#101B30;color:#fff;padding:22px 24px}
  .hd .biz{font-size:22px;font-weight:800;letter-spacing:.02em}
  .hd .sub{color:#9DA8C4;font-size:13px;margin-top:2px}
  .tag{display:inline-block;background:#C9973A;color:#fff;font-size:12px;font-weight:800;border-radius:99px;padding:3px 12px;margin-top:10px;letter-spacing:.06em}
  .tag.paid{background:#1E9E5A}
  .sec{padding:18px 24px;border-bottom:1px solid #E6E8EC}
  .lbl{font-size:11px;font-weight:700;letter-spacing:.1em;color:#67718A;margin-bottom:6px}
  .cust{font-size:17px;font-weight:700}.addr{font-size:14px;color:#67718A}
  img.roof{width:100%;border-radius:12px;display:block}
  .cap{font-size:11px;color:#67718A;margin-top:6px}
  table{width:100%;border-collapse:collapse;font-size:15px}
  td{padding:7px 0}td:last-child{text-align:right;font-weight:700}
  .tot td{border-top:2px solid #E6E8EC;font-size:15px}
  .due td{font-size:20px;font-weight:800}
  .due .amt{color:${d.paid ? "#1E9E5A" : "#C9973A"}}
  .pay{background:#F7EFD8;border-radius:12px;padding:14px 16px;font-size:15px}
  .pay b{display:block;font-size:11px;letter-spacing:.1em;color:#C9973A;margin-bottom:6px}
  .btn{display:block;width:calc(100% - 48px);margin:18px 24px;background:#C9973A;color:#fff;border:none;border-radius:12px;padding:15px;font-size:16px;font-weight:800;cursor:pointer}
  .ft{text-align:center;color:#9DA8C4;font-size:12px;padding:14px 0 26px}
  @media print{.btn{display:none}body{background:#fff}.page,.page *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}}
</style></head><body><div class="page">
<div class="hd">
  ${d.lg ? `<img src="/api/logo/${esc(d.lg)}" alt="" style="max-height:46px;max-width:220px;display:block;margin-bottom:8px" onerror="this.style.display='none'">` : ""}
  <div class="biz">${esc(d.biz).toUpperCase()}</div>
  <div class="sub">${d.k === "inv" ? L.inv : L.est} #${esc(d.inv)} · ${L.date}: ${esc(d.dt)}${d.ph ? " · " + esc(d.ph) : ""}</div>
  ${d.em || d.lic ? `<div class="sub">${[d.em && esc(d.em), d.lic && (es ? "Licencia: " : "License: ") + esc(d.lic)].filter(Boolean).join(" · ")}</div>` : ""}
  ${d.paid ? `<span class="tag paid">✓ ${L.paid}</span>` : `<span class="tag">${d.k === "inv" ? L.inv : L.est}</span>`}
</div>
<div class="sec"><div class="lbl">${L.for}</div><div class="cust">${esc(d.cn)}</div><div class="addr">${esc(d.ca)}</div></div>
${img ? `<div class="sec"><div class="lbl">${L.meas}</div><img class="roof" src="${img}" alt="">
${d.ms ? `<table style="margin-top:10px;font-size:13px">
<tr><td style="color:#67718A">${L.area}</td><td>${Number(d.ms.ra).toLocaleString()} sq ft</td></tr>
<tr><td style="color:#67718A">${L.pitch}</td><td>${esc(d.ms.pi)}/12</td></tr>
<tr><td style="color:#67718A">${L.sqs}</td><td>${esc(d.ms.sq)}</td></tr>
${d.ms.id ? `<tr><td style="color:#67718A">${L.imgOf}</td><td>Google · ${esc(d.ms.id)}</td></tr>` : ""}
</table>` : `<div class="cap">🛰️ ${esc(d.ti)}</div>`}</div>` : `<div class="sec"><div class="cust">${esc(d.ti)}</div></div>`}
<div class="sec"><table>
${(d.li || []).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmtM(v)}</td></tr>`).join("")}
<tr class="tot"><td>${L.subtotal}</td><td>${fmtM(d.tot)}</td></tr>
${d.dep ? `<tr><td>${L.deposit}</td><td style="color:#1E9E5A">–${fmtM(d.dep)}</td></tr>` : ""}
<tr class="due"><td>${d.paid ? L.paid : L.due}</td><td class="amt">${d.paid ? "✓" : fmtM(bal)}</td></tr>
</table></div>
<div class="sec"><div class="pay"><b>${L.how}</b>${d.zelle ? `💜 ${L.zelle}: <strong>${esc(d.zelle)}</strong><br>` : ""}💵 ${L.cash}</div></div>
${d.k === "est" && !d.paid ? `<div class="sec" style="font-size:12px;color:#67718A">
<p>${L.valid}</p>
<div style="display:flex;gap:24px;margin-top:34px">
  <div style="flex:2;border-top:1.5px solid #101B30;padding-top:5px">${L.sig}</div>
  <div style="flex:1;border-top:1.5px solid #101B30;padding-top:5px">${L.sigDate}</div>
</div></div>` : ""}
<button class="btn" onclick="window.print()">${L.print}</button>
<div class="ft">${esc(d.biz)}</div>
</div></body></html>`);
});

await db.initDb();

/* Grace period: a failed payment older than 7 days pauses the client
 * automatically. Reactivation happens instantly via the Stripe webhook. */
async function graceSweep() {
  try {
    const list = await db.listContractors();
    for (const c of list) {
      const d = c.data || {};
      if (d.payStatus === "failed" && d.payFailedAt && d.status !== "paused"
        && Date.now() - new Date(d.payFailedAt).getTime() > 7 * 864e5) {
        await db.saveContractorData(c.id, { ...d, status: "paused" });
        console.log(`grace expired → paused ${c.slug}`);
      }
    }
  } catch (e) { console.error("grace sweep failed:", e.message); }
}
graceSweep();
setInterval(graceSweep, 6 * 3600 * 1000);

// Accounts the landing page depends on: the live demo widget and the inbox
// where the landing's own leads land. Created once, then left alone.
async function ensureAccount(slug, name, profile) {
  let c = await db.getContractorBySlug(slug);
  if (!c) {
    c = await db.createContractor({ name, slug });
    await db.saveContractorData(c.id, { profile });
    console.log(`created built-in account: ${slug}`);
  } else {
    // Built-in demo accounts are app-owned, not a real client's — keep their
    // branding synced to the code (e.g. after a product pivot leaves a stale
    // name/biz in the db) and backfill any missing contact info.
    const curProfile = c.data?.profile || {};
    const next = { ...curProfile };
    let changed = false;
    if (profile.biz && curProfile.biz !== profile.biz) { next.biz = profile.biz; changed = true; }
    if (profile.phone && !curProfile.phone) { next.phone = profile.phone; changed = true; }
    if (changed) await db.saveContractorData(c.id, { ...(c.data || {}), profile: next });
  }
  return c;
}
await ensureAccount("alto-demo", "Casa Bella Realty (Demo)", { biz: "Casa Bella Realty (Demo)", phone: "9565550142", lang: "es", trade: "realtor" });
await ensureAccount("alto-ventas", "Quick Comp Ventas", { biz: "Quick Comp", lang: "es", trade: "realtor" });

app.listen(PORT, () => {
  console.log(`Quick Comp server on http://localhost:${PORT}`);
  console.log(`  google: ${GOOGLE_KEY ? "LIVE" : "demo"} · parcels: ${REGRID_KEY ? "LIVE" : "demo"} · property: ${RENTCAST_KEY ? "LIVE" : "demo"} · ai: ${aiLive ? `LIVE (${anthropic ? "anthropic" : "openai"})` : "demo"}`);
  if (weakKeyReason(ADMIN_KEY)) console.warn("  ⚠️ ADMIN_KEY looks like a personal password (short/guessable). Generate a strong one from the banner in /admin — or `openssl rand -hex 24` — and set it in Render → Environment.");
});
