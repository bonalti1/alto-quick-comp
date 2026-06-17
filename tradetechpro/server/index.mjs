/*
 * Trade Tech Pro backend.
 *
 * Three endpoints, each with a demo fallback so the app works with no keys:
 *   GET  /api/health  — which features are live vs demo
 *   GET  /api/places  — address autocomplete (Google Places, else mock list)
 *   POST /api/lookup  — roof + property data (Google Geocoding + Solar API +
 *                       RentCast, else simulated data)
 *   POST /api/ai      — the "Pregúntale a TTP" assistant (Anthropic API)
 */
import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { fromArrayBuffer } from "geotiff";
import proj4 from "proj4";
import * as db from "./db.mjs";
import { renderSite } from "./templates.mjs";

const PORT = process.env.PORT || 8787;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
const RENTCAST_KEY = process.env.RENTCAST_API_KEY || "";
const REGRID_KEY = process.env.REGRID_API_KEY || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const CLOSER_KEY = process.env.CLOSER_KEY || "";
const CS_KEY = process.env.CS_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
// Cloudflare for SaaS (custom client domains). Off until configured.
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";
const CF_ZONE_ID = process.env.CF_ZONE_ID || "";
const CF_CNAME_TARGET = process.env.CF_CNAME_TARGET || "app.alto-pro.com";
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
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const aiLive = !!(anthropic || OPENAI_KEY);

/* One helper for both AI providers — Anthropic when ANTHROPIC_API_KEY is set,
 * else OpenAI when OPENAI_API_KEY is set. Same input, returns plain text. */
async function aiChat({ system, messages, maxTokens = 1024 }) {
  if (anthropic) {
    const msg = await anthropic.messages.create({ model: "claude-opus-4-8", max_tokens: maxTokens, system, messages });
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "";
}

const app = express();

/* ── Stripe billing webhook ──
 * Registered BEFORE the JSON parser because Stripe signatures are computed
 * over the raw body. Flow: invoice paid → reactivate instantly · payment
 * failed → 7-day grace countdown · subscription canceled → pause.
 * Configure in Stripe: endpoint /api/stripe/webhook, then put the signing
 * secret in Render as STRIPE_WEBHOOK_SECRET. */
const STRIPE_WH_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
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
  const obj = event.data?.object || {};
  const customerId = obj.customer || null;
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
      if (phone) await db.kvSet(`paid:${phone}`, { customerId, email, phone }).catch(() => {});
      if (email) await db.kvSet(`paid:${email}`, { customerId, email, phone }).catch(() => {});
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
  } else if (event.type === "invoice.payment_failed") {
    data.payStatus = "failed";
    data.payFailedAt = data.payFailedAt || new Date().toISOString();
  } else if (event.type === "customer.subscription.deleted") {
    data.status = "paused";
    data.payStatus = "canceled";
  }
  await db.saveContractorData(match.id, data);
  console.log(`stripe webhook: ${event.type} → ${match.slug} (${data.payStatus}${data.status ? ", " + data.status : ""})`);
  res.json({ ok: true });
});

app.use(express.json({ limit: "300kb" }));
app.use(express.urlencoded({ extended: false }));

// The bare brand domain shows the sales landing page; the app lives on
// app.alto-pro.com (and keeps working on the onrender.com address).
app.use((req, res, next) => {
  const h = String(req.hostname || "").toLowerCase();
  if ((h === "alto-pro.com" || h === "www.alto-pro.com") && (req.path === "/" || req.path === "/index.html")) {
    return res.send(landingPage(req));
  }
  next();
});

/* ── Client website host-routing ──
 * A client's site lives at app.alto-pro.com/site/<slug>. When a request
 * arrives on a client's own domain (custom .com via Cloudflare for SaaS) or
 * on <slug>.alto-pro.com, we serve that client's site by rewriting the root
 * path to /site/<slug>. Our own hosts and all non-root paths (assets, /api,
 * /w, …) pass straight through untouched. */
const OUR_HOSTS = new Set(["app.alto-pro.com", "alto-pro.com", "www.alto-pro.com", "localhost", "127.0.0.1", ""]);
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
    if (h.endsWith(".alto-pro.com")) slug = h.slice(0, -13); // <slug>.alto-pro.com
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
  const j = await (await fetch(url)).json();
  const r = j.results?.[0];
  if (!r) return null;
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, formatted: r.formatted_address };
}

/* GPS coordinates → street address (the contractor parked outside the job) */
async function reverseGeocode(lat, lng) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_KEY}`;
  const j = await (await fetch(url)).json();
  return j.results?.[0]?.formatted_address || `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}

/* Place details give the exact building location the user picked in
 * autocomplete — more accurate than re-geocoding the address text, which can
 * land on a nearby outbuilding. */
async function placeDetails(placeId) {
  const r = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
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
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new Error(data.message || data.error || `Request failed with ${response.status}`);
  }
  return data;
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

function normalizeRentcastComps(data) {
  const raw = data.comparables || data.comps || data.saleComparables || [];
  const comps = raw.map((c) => ({
    address: c.formattedAddress || c.address || [c.addressLine1, c.city, c.state, c.zipCode].filter(Boolean).join(", ") || "Comparable property",
    soldPrice: c.price || c.soldPrice || c.lastSalePrice || c.salePrice || c.value || null,
    sqft: c.squareFootage || c.livingArea || c.size || null,
    beds: c.bedrooms ?? c.beds ?? null,
    baths: c.bathrooms ?? c.baths ?? null,
    soldDate: c.soldDate || c.lastSaleDate || c.saleDate || c.listedDate || null,
    yearBuilt: c.yearBuilt || null,
    distance: c.distance || null,
    latitude: c.latitude || null,
    longitude: c.longitude || null,
  })).filter((c) => c.soldPrice);
  return dedupeComparableProperties(comps);
}

function dedupeComparableProperties(comps) {
  const byKey = new Map();
  for (const comp of comps) {
    const key = comparableIdentityKey(comp);
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, comp); continue; }
    byKey.set(key, mergeComparable(existing, comp));
  }
  return [...byKey.values()];
}

function comparableIdentityKey(comp) {
  const addressKey = normalizeComparableAddress(comp.address);
  if (/\d/.test(addressKey) && /[a-z]/.test(addressKey)) return `addr:${addressKey}`;
  const lat = Number(comp.latitude);
  const lng = Number(comp.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `geo:${lat.toFixed(4)},${lng.toFixed(4)}`;
  }
  return `addr:${addressKey}`;
}

function normalizeComparableAddress(address) {
  return String(address || "")
    .toLowerCase()
    .replace(/\b(street|st|drive|dr|lane|ln|avenue|ave|road|rd|court|ct|boulevard|blvd|circle|cir|place|pl|trail|trl|north|south|east|west)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function mergeComparable(a, b) {
  const merged = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (merged[key] === null || merged[key] === undefined || merged[key] === "") merged[key] = value;
  }
  const aDistance = Number(a.distance);
  const bDistance = Number(b.distance);
  if (Number.isFinite(aDistance) && Number.isFinite(bDistance)) merged.distance = Math.min(aDistance, bDistance);
  if (b.soldDate && (!a.soldDate || new Date(b.soldDate) > new Date(a.soldDate))) merged.soldDate = b.soldDate;
  return merged;
}

function calculateQuickCompValue({ subject, comps, rentcastEstimate, rentcastLow, rentcastHigh }) {
  const subjectSqft = readNumber(subject, ["squareFootage", "livingArea", "buildingArea", "livingSize"]);
  const subjectYear = readNumber(subject, ["yearBuilt"]);
  const subjectBeds = readNumber(subject, ["bedrooms", "beds"]);
  const subjectBaths = readNumber(subject, ["bathrooms", "baths"]);
  const validComps = comps
    .map((comp, index) => {
      const ppsf = comp.soldPrice && comp.sqft ? comp.soldPrice / comp.sqft : null;
      return { ...comp, originalRank: index, ppsf };
    })
    .filter((comp) => comp.soldPrice && comp.sqft && comp.ppsf);

  if (!subjectSqft || validComps.length < 3) {
    const estimate = rentcastEstimate || null;
    return {
      method: estimate ? "rentcast_avm_fallback" : "insufficient_data",
      estimate,
      low: rentcastLow || (estimate ? Math.round(estimate * 0.95 / 1000) * 1000 : null),
      high: rentcastHigh || (estimate ? Math.round(estimate * 1.05 / 1000) * 1000 : null),
      avgPpsf: null,
      lowPpsf: null,
      highPpsf: null,
      subjectSqft: subjectSqft || null,
      usedCompCount: validComps.length,
      excludedOutliers: 0,
      confidence: validComps.length ? "limited" : "low",
      rankedComps: comps,
    };
  }

  const ppsfs = validComps.map((comp) => comp.ppsf).sort((a, b) => a - b);
  const medianPpsf = median(ppsfs);
  const filtered = validComps.length >= 5
    ? validComps.filter((comp) => comp.ppsf >= medianPpsf * 0.75 && comp.ppsf <= medianPpsf * 1.25)
    : validComps;
  const used = filtered.length >= 3 ? filtered : validComps;
  const scored = used.map((comp) => {
    const distanceWeight = scoreCloseness(Number(comp.distance), 0, 10, 0.55, 1.4);
    const sqftDiff = subjectSqft && comp.sqft ? Math.abs(comp.sqft - subjectSqft) / subjectSqft : null;
    const sqftWeight = sqftDiff === null ? 0.85 : clamp(1.35 - sqftDiff * 1.6, 0.45, 1.35);
    const yearDiff = subjectYear && comp.yearBuilt ? Math.abs(comp.yearBuilt - subjectYear) : null;
    const yearWeight = yearDiff === null ? 0.9 : clamp(1.2 - yearDiff / 45, 0.55, 1.2);
    const bedWeight = subjectBeds && comp.beds ? clamp(1.08 - Math.abs(comp.beds - subjectBeds) * 0.12, 0.72, 1.08) : 0.95;
    const bathWeight = subjectBaths && comp.baths ? clamp(1.08 - Math.abs(comp.baths - subjectBaths) * 0.12, 0.72, 1.08) : 0.95;
    const recencyWeight = scoreRecency(comp.soldDate);
    const weight = distanceWeight * sqftWeight * yearWeight * bedWeight * bathWeight * recencyWeight;
    const matchScore = Math.round(clamp(weight / 2.6, 0.45, 0.98) * 100);
    return { ...comp, weight, matchScore };
  }).sort((a, b) => b.weight - a.weight);

  const totalWeight = scored.reduce((sum, comp) => sum + comp.weight, 0);
  const avgPpsf = totalWeight
    ? scored.reduce((sum, comp) => sum + comp.ppsf * comp.weight, 0) / totalWeight
    : medianPpsf;
  const confidenceSpread = scored.length >= 8 ? 0.06 : scored.length >= 5 ? 0.08 : 0.1;
  const estimate = roundToNearest(subjectSqft * avgPpsf, 1000);
  const lowPpsf = avgPpsf * (1 - confidenceSpread);
  const highPpsf = avgPpsf * (1 + confidenceSpread);
  const low = roundToNearest(subjectSqft * lowPpsf, 1000);
  const high = roundToNearest(subjectSqft * highPpsf, 1000);
  const excludedAddresses = new Set(validComps.filter((comp) => !used.includes(comp)).map((comp) => comp.address));
  const rankedComps = [
    ...scored,
    ...comps.filter((comp) => !scored.some((ranked) => ranked.address === comp.address)),
  ].map((comp) => ({
    ...comp,
    excludedAsOutlier: excludedAddresses.has(comp.address) || undefined,
    ppsf: comp.ppsf ? Math.round(comp.ppsf) : undefined,
  })).slice(0, 12);

  return {
    method: "weighted_sold_price_per_sqft",
    estimate,
    low,
    high,
    avgPpsf: Math.round(avgPpsf),
    lowPpsf: Math.round(lowPpsf),
    highPpsf: Math.round(highPpsf),
    subjectSqft,
    subjectYear: subjectYear || null,
    usedCompCount: scored.length,
    excludedOutliers: validComps.length - used.length,
    confidence: scored.length >= 8 ? "strong" : scored.length >= 5 ? "good" : "limited",
    rankedComps,
  };
}

function readNumber(source, keys) {
  if (!source) return null;
  for (const key of keys) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function median(values) {
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scoreCloseness(value, min, max, low, high) {
  if (!Number.isFinite(value)) return (low + high) / 2;
  const normalized = 1 - clamp((value - min) / (max - min), 0, 1);
  return low + normalized * (high - low);
}

function scoreRecency(soldDate) {
  if (!soldDate) return 0.95;
  const date = new Date(soldDate);
  if (Number.isNaN(date.getTime())) return 0.95;
  const days = Math.max(0, (Date.now() - date.getTime()) / 86400000);
  return clamp(1.18 - days / 1600, 0.65, 1.18);
}

function roundToNearest(value, nearest) {
  return Math.round(value / nearest) * nearest;
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
  const tax = latestYearVal(p.propertyTaxes, (a) => a?.total ?? a?.amount ?? null);
  const ownerNames = Array.isArray(p.owner?.names) ? p.owner.names.join(", ") : (p.owner?.name || p.ownerName || null);
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
    assessedValue: assess?.value ?? null,
    assessedYear: assess?.year ?? null,
    annualTax: tax?.value ?? null,
    taxYear: tax?.year ?? assess?.year ?? null,
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
  const radii = autoExpand ? [2, 5, 10].filter((r) => r >= requestedRadius) : [requestedRadius];
  const lookbacks = autoExpand ? allLookbacks.filter((l) => l.days >= requestedDaysOld) : [exactLookback];
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

  const subject = normalizeSubjectProperty(data.subjectProperty || data.property || null, address);
  const rawComps = normalizeRentcastComps(data);
  const quick = calculateQuickCompValue({
    subject,
    comps: rawComps,
    rentcastEstimate: data.price || data.value || data.estimate || null,
    rentcastLow: data.priceRangeLow || data.valueRangeLow || null,
    rentcastHigh: data.priceRangeHigh || data.valueRangeHigh || null,
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
      const r = await fetch(`https://app.regrid.com/api/v2/parcels/point?lat=${lat}&lon=${lon}&radius=${radius}&token=${REGRID_KEY}`);
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
  res.json({ ok: true, db: db.dbKind(), live: { google: !!GOOGLE_KEY, parcels: !!REGRID_KEY, property: !!RENTCAST_KEY, ai: aiLive } });
});

app.get("/api/places", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ suggestions: [], source: "demo" });
  if (GOOGLE_KEY) {
    try {
      const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
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
  const r = await fetch(u);
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
  if (!me) {
    if (overQuota(`lk:${lkIp}`, 6)) return res.status(429).json({ error: "demo_limit" });
    // lifetime allowance per connection — survives incognito and browser wipes
    const lifetime = await db.incrCounter(`demolk:${lkIp}`).catch(() => 0);
    if (lifetime > 10) return res.status(429).json({ error: "demo_limit" });
  } else if (overQuota(`lkc:${me.id}`, 40)) { // per-account daily measure cap — low enough that a shared link is useless as a free tool
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
    const comp = await rentcastLookup(lookupAddr).catch((e) => { console.error("comps failed:", e.message); return null; });
    // We may know where the house is even when the market is too thin to value.
    if (!comp || !comp.value) {
      return res.json({ found: false, source: "live", addr: (geo && geo.formatted) || address, lat: geo?.lat ?? null, lng: geo?.lng ?? null });
    }
    return res.json({
      found: true,
      source: "live",
      addr: comp.subject?.address || (geo && geo.formatted) || address,
      lat: geo?.lat ?? comp.subject?.latitude ?? null,
      lng: geo?.lng ?? comp.subject?.longitude ?? null,
      value: comp.value,
      valueRange: { low: comp.low, high: comp.high },
      confidence: comp.confidence,
      method: comp.method,
      subject: comp.subject,
      comps: comp.comps,
      compsUsed: comp.usedCompCount,
      excludedOutliers: comp.excludedOutliers,
      avgPpsf: comp.avgPpsf,
      radius: comp.radius,
      lookbackLabel: comp.lookbackLabel,
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
        url += `&path=color:0xF8B408FF|weight:4|${pp}`;
      }
    }
    // Preferred overlay: one clean traced outline of the actual roof
    if (outline) {
      const pts = String(outline).split(";").map((p) => p.split(",").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
      if (pts.length >= 3) {
        const pathPts = [...pts, pts[0]].map(([la, ln]) => `${f(la)},${f(ln)}`).join("|");
        // white casing under the orange line so it reads on any roof color
        url += `&path=color:0xFFFFFFCC|weight:6|${pathPts}`;
        url += `&path=color:0xF8B408FF|weight:3|fillcolor:0xF8B40810|${pathPts}`;
      }
    } else if (boxes) {
      const list = String(boxes).split(";").slice(0, 8);
      list.forEach((b, i) => {
        const [s, w, n, e] = b.split(",").map(Number);
        if (![s, w, n, e].every(Number.isFinite)) return;
        url += `&path=color:0xF8B408E6|weight:2|fillcolor:0xF8B40830|${f(s)},${f(w)}|${f(s)},${f(e)}|${f(n)},${f(e)}|${f(n)},${f(w)}|${f(s)},${f(w)}`;
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
  const { lat, lng } = req.query;
  if (!GOOGLE_KEY || !lat || !lng) return res.status(404).end();
  const svIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`sv:${svIp}`, 120)) return res.status(429).end();
  const loc = `${encodeURIComponent(lat)},${encodeURIComponent(lng)}`;
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
app.get("/api/mapconfig", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({ key: process.env.GOOGLE_MAPS_BROWSER_KEY || GOOGLE_KEY || "" });
});

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
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
const clearKeyCookie = (res, name) => res.setHeader("Set-Cookie", `${name}=; Path=/; Max-Age=0`);
// Canonical public base for generated links: always the main https domain in
// production (never app./www. or http), so copied links work everywhere.
function canonBase(req) {
  const host = String(req.get("host") || "").split(":")[0];
  if (/(^|\.)alto-pro\.com$/.test(host)) return "https://alto-pro.com";
  return `${req.protocol}://${req.get("host")}`;
}

const adminOk = (req) => ADMIN_KEY && (
  req.query.key === ADMIN_KEY || req.body?.key === ADMIN_KEY || reqCookies(req).alto_admin === ADMIN_KEY
);
// Closers get a limited portal: create clients + the sales toolkit, nothing else
const closerOk = (req) => {
  const k = req.query.key || req.body?.key || reqCookies(req).alto_closer || reqCookies(req).alto_admin;
  return (CLOSER_KEY && k === CLOSER_KEY) || (ADMIN_KEY && k === ADMIN_KEY);
};
// Customer service: the command center (tasks + edit client sites), no money/MRR
const csOk = (req) => {
  const k = req.query.key || req.body?.key || reqCookies(req).alto_cs || reqCookies(req).alto_admin;
  return (CS_KEY && k === CS_KEY) || (ADMIN_KEY && k === ADMIN_KEY);
};

function loginPage(title, action, wrong) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ALTO Pro · ${title}</title><link rel="icon" href="/icon-192.png"><style>
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0}
body{background:#101B30;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:22px;padding:36px 30px;width:100%;max-width:380px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.45)}
img{height:52px;margin-bottom:14px}
h1{font-size:18px;color:#101B30;margin-bottom:4px}
p{color:#67718A;font-size:13px;font-weight:600;margin-bottom:18px}
input{width:100%;padding:14px;border-radius:12px;border:1.5px solid #DDE3EE;font-size:16px;font-weight:600;outline:none;text-align:center}
input:focus{border-color:#F8B408}
button{width:100%;margin-top:10px;padding:14px;border:none;border-radius:12px;background:#F8B408;color:#101B30;font-size:16px;font-weight:800;cursor:pointer}
.err{color:#D93025;font-size:13px;font-weight:700;margin-top:10px}
</style></head><body><form class="card" method="get" action="${action}">
<img src="/brand-logo.png" alt="ALTO Pro">
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
  const { name, phone, slug } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const c = await db.createContractor({ name, phone, slug });
  const invite = await db.createInvite(c.id);
  const inviteUrl = `${req.protocol}://${req.get("host")}/invite/${invite}`;
  if (req.query.html) {
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cuenta creada</title>
<style>body{font-family:Arial;max-width:560px;margin:40px auto;padding:0 16px;color:#101B30}h2{margin-bottom:6px}
.link{background:#FEF5DC;border:2px solid #F8B408;border-radius:12px;padding:14px;word-break:break-all;font-size:14px;margin:14px 0}
a{color:#F8B408;font-weight:800}</style></head><body>
<h2>✓ Cuenta creada: ${c.name}</h2>
<p>Manda este link por WhatsApp al contratista. Un tap y queda dentro de su app, con sus datos guardados para siempre:</p>
<div class="link">${inviteUrl}</div>
<p><b>Su widget de cotización</b> (link directo para anuncios, o para probar):</p>
<div class="link">${req.protocol}://${req.get("host")}/w/${c.slug}</div>
<p>Código para pegar en su página web:</p>
<div class="link">&lt;iframe src="${req.protocol}://${req.get("host")}/w/${c.slug}" style="width:100%;max-width:430px;height:560px;border:0;border-radius:18px" loading="lazy"&gt;&lt;/iframe&gt;</div>
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
<style>body{font-family:Arial;max-width:560px;margin:40px auto;padding:0 16px;color:#101B30}
.link{background:#FEF5DC;border:2px solid #F8B408;border-radius:12px;padding:14px;word-break:break-all;font-size:14px;margin:14px 0}
a{color:#F8B408;font-weight:800}</style></head><body>
<h2>🔑 Link de acceso: ${c.name}</h2>
<p>Mándalo por WhatsApp. Un tap y entra a su app con todo guardado:</p>
<div class="link">${url}</div>
<a href="/admin?key=${encodeURIComponent(ADMIN_KEY)}">← Volver al admin</a></body></html>`);
});

// Admin: connect/disconnect a contractor's HighLevel webhook (empty url clears)
app.get("/api/admin/webhook", async (req, res) => {
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
app.get("/api/admin/status", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "bad admin key" });
  const c = await db.getContractor(String(req.query.id || ""));
  if (!c) return res.status(404).json({ error: "no contractor" });
  const paused = req.query.status === "paused";
  const data = { ...(c.data || {}), status: paused ? "paused" : undefined };
  if (!paused && data.payStatus === "pending") data.payStatus = "ok"; // manual activation (cash/Zelle deals)
  await db.saveContractorData(c.id, data);
  res.json({ ok: true, status: paused ? "paused" : "active" });
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

app.get("/admin", async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).send("Set ADMIN_KEY env var to enable admin.");
  if (req.query.logout != null) { clearKeyCookie(res, "alto_admin"); return res.redirect("/admin"); }
  if (req.query.key === ADMIN_KEY) { setKeyCookie(res, "alto_admin", ADMIN_KEY); return res.redirect("/admin"); }
  if (!adminOk(req)) return res.status(req.query.key ? 403 : 401).send(loginPage("Admin", "/admin", !!req.query.key));
  const KEY = encodeURIComponent(ADMIN_KEY);
  const base = canonBase(req);
  const range = periodRange(req.query, false);
  const [list, stats, recent, rows, mst, devCounts] = await Promise.all([
    db.listContractors(),
    db.leadStats().catch(() => []),
    db.recentLeads(12).catch(() => []),
    db.getMetrics(7).catch(() => []),
    db.meetingStats(range).catch(() => ({ total: 0, scheduled: 0, noShow: 0, showed: 0, closed: 0 })),
    db.sessionCounts().catch(() => ({})),
  ]);
  const closeRate = mst.total ? Math.round((mst.closed / mst.total) * 100) : 0;
  const BUILTIN = new Set(["alto-demo", "alto-ventas"]);
  const realClients = list.filter((c) => !BUILTIN.has(c.slug));
  const statOf = (id) => stats.find((x) => String(x.contractor_id) === String(id)) || { total: 0, last7: 0, last_at: null };
  const tot = (e) => rows.filter((r) => r.event === e).reduce((a, r) => a + Number(r.n), 0);
  const leads7 = stats.reduce((a, x) => a + Number(x.last7 || 0), 0);
  // real MRR = only clients confirmed paying (Stripe payment or manual activation)
  const payCount = (s) => realClients.filter((c) => (c.data?.payStatus || "") === s).length;
  const paying = payCount("ok");
  const pendingPay = payCount("pending");
  const failedPay = payCount("failed");
  const mrr = paying * 297;
  // last-7-days series for the chart (visits per day)
  const days = [...Array(7)].map((_, i) => new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10));
  const get = (d, e) => Number(rows.find((r) => r.day === d && r.event === e)?.n || 0);
  const maxV = Math.max(1, ...days.map((d) => get(d, "visit")));
  const fmtD = (x) => (x ? String(x).slice(5, 10) : "—");
  const ago = (x) => { if (!x) return "—"; const h = (Date.now() - new Date(x).getTime()) / 36e5; return h < 1 ? "hace minutos" : h < 24 ? `hace ${Math.round(h)}h` : `hace ${Math.round(h / 24)}d`; };
  const esc = (x) => String(x || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ALTO Pro · Admin</title><link rel="icon" href="/icon-192.png">
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{background:#F5F6F8;color:#0B1220;letter-spacing:-0.011em}
::selection{background:rgba(248,180,8,.35)}
a{-webkit-tap-highlight-color:transparent}
header{position:sticky;top:0;z-index:30;background:rgba(16,27,48,.9);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);color:#fff;padding:15px 24px;display:flex;align-items:center;gap:13px;border-bottom:1px solid rgba(255,255,255,.07)}
header img{height:32px;background:#fff;border-radius:10px;padding:4px 7px}
header b{font-size:16px;font-weight:700;letter-spacing:-0.02em}header b em{color:#F8B408;font-style:normal}
header .tag{margin-left:auto;font-size:12.5px;color:#9DA8C4;font-weight:600}
header .tag a{color:#cdd5e5;text-decoration:none}
.wrap{max-width:1100px;margin:0 auto;padding:26px 22px 64px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(166px,1fr));gap:14px}
.card{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:20px;padding:20px 22px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 10px 26px rgba(16,27,48,.045);transition:transform .2s cubic-bezier(.2,.7,.2,1),box-shadow .2s cubic-bezier(.2,.7,.2,1)}
.card:hover{transform:translateY(-2px);box-shadow:0 2px 5px rgba(16,27,48,.06),0 20px 44px rgba(16,27,48,.10)}
.card .v{font-size:33px;font-weight:700;letter-spacing:-0.035em;line-height:1.04}
.card .l{font-size:11px;font-weight:700;color:#9097A3;letter-spacing:.55px;text-transform:uppercase;margin-top:6px}
.card.gold{background:linear-gradient(155deg,#16243f 0%,#0d1729 100%);color:#fff;border:none;box-shadow:0 1px 2px rgba(0,0,0,.25),0 20px 48px rgba(16,27,48,.30)}
.card.gold .v{color:#F8B408}
.card.gold .l{color:#9DA8C4}
.panel{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:24px;padding:24px;margin-top:18px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 12px 32px rgba(16,27,48,.05)}
.panel h2{font-size:15.5px;font-weight:700;letter-spacing:-0.015em;margin-bottom:16px}
.chart{display:flex;align-items:flex-end;gap:10px;height:114px;padding:4px 2px 0}
.chart .col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:6px;height:100%}
.chart .bar{width:100%;max-width:46px;background:linear-gradient(180deg,#FFC83D,#F0A500);border-radius:10px 10px 4px 4px;min-height:3px;box-shadow:0 5px 12px rgba(240,165,0,.28);transition:filter .15s}
.chart .bar:hover{filter:brightness(1.06)}
.chart .lbl{font-size:10.5px;color:#9097A3;font-weight:700}
.chart .num{font-size:11px;font-weight:800;color:#0B1220}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:#9097A3;font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;font-weight:700;padding:10px;border-bottom:1px solid #EEF0F4}
td{padding:14px 10px;border-bottom:1px solid #F2F4F7;font-weight:600;color:#1B2433;vertical-align:middle}
tr[data-name]{transition:background .12s}
tr[data-name]:hover{background:#F8F9FB}
td a{color:#B07A00;font-weight:700;text-decoration:none}
td a:hover{text-decoration:underline}
.pill{display:inline-block;border-radius:99px;padding:4px 11px;font-size:11px;font-weight:700;letter-spacing:.1px;white-space:nowrap}
td .pill{margin:2px 3px 2px 0}
.pill.ok{background:#E7F7ED;color:#10803C}
.pill.warn{background:#FDECEC;color:#C5221F}
.pill.dim{background:#F0F2F6;color:#8A94A8}
.pill.gold{background:#FEF3D6;color:#946400}
.newform{display:flex;gap:10px;flex-wrap:wrap}
.newform input{flex:1;min-width:160px;font-family:inherit;padding:13px 15px;border-radius:13px;border:1px solid #E4E7EC;background:#fff;font-size:14.5px;font-weight:500;outline:none;transition:border-color .15s,box-shadow .15s}
.newform input:focus{border-color:#F8B408;box-shadow:0 0 0 4px rgba(248,180,8,.18)}
.newform button{background:#F8B408;color:#101B30;border:none;border-radius:13px;padding:13px 24px;font-weight:700;cursor:pointer;font-size:14.5px;transition:transform .12s,filter .15s;box-shadow:0 6px 16px rgba(248,180,8,.3)}
.newform button:hover{filter:brightness(1.03)}.newform button:active{transform:scale(.97)}
.legend{color:#9097A3;font-size:12px;margin-top:12px;line-height:1.6}
.closures{border:1px solid rgba(248,180,8,.28);box-shadow:0 1px 2px rgba(16,27,48,.04),0 12px 32px rgba(248,180,8,.08)}
.periodbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:2px 0 18px}
.segs{display:inline-flex;background:#EEF0F4;border-radius:12px;padding:3px;gap:2px}
.seg{padding:8px 15px;border-radius:9px;font-size:13px;font-weight:700;color:#5A6475;text-decoration:none;white-space:nowrap}
.seg.on{background:#fff;color:#101B30;box-shadow:0 1px 3px rgba(16,27,48,.12)}
.segcustom{display:inline-flex;gap:7px;align-items:center}
.segcustom input{font-family:inherit;padding:8px 10px;border-radius:10px;border:1px solid #E4E7EC;font-size:13px;font-weight:600;color:#1B2433;outline:none}
.segcustom input:focus{border-color:#F8B408;box-shadow:0 0 0 3px rgba(248,180,8,.18)}
.segcustom button{background:#101B30;color:#fff;border:none;border-radius:10px;padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer}
.segcustom button.on{background:#F8B408;color:#101B30}
.plabel{font-size:12.5px;font-weight:700;color:#9097A3}
.subcards{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:12px}
.sub{background:#F7F8FA;border:1px solid rgba(16,27,48,.05);border-radius:16px;padding:16px 18px}
.sub .v{font-size:26px;font-weight:700;letter-spacing:-.03em;line-height:1.05}
.sub .l{font-size:10.5px;font-weight:700;color:#9097A3;letter-spacing:.5px;text-transform:uppercase;margin-top:5px}
.sub.gold{background:linear-gradient(155deg,#16243f 0%,#0d1729 100%);border:none}
.sub.gold .v{color:#F8B408}.sub.gold .l{color:#9DA8C4}
.grid2{display:grid;gap:18px}
@media(min-width:900px){.grid2{grid-template-columns:1.1fr 1fr}}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.lrow{display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid #F3F5F9;font-size:13.5px;font-weight:600}
.lprev{width:134px;height:86px;border-radius:10px;overflow:hidden;border:1px solid #E4E7EC;flex-shrink:0;background:#0B1226;box-shadow:0 4px 12px rgba(16,27,48,.08)}
.lprev iframe{width:1100px;height:705px;border:0;transform:scale(.122);transform-origin:0 0;pointer-events:none;background:#fff;display:block}
.lprev.ph{display:flex;align-items:center;justify-content:center;font-size:24px;background:#F4F6FA;color:#9AA0AC}
.lurl{color:#9AA0AC;font-size:12px;word-break:break-all}
.lbtns{display:flex;gap:6px;flex-shrink:0}
@media(max-width:620px){.lprev{display:none}}
</style></head><body>
<header><img src="/brand-logo.png" alt=""><b>ALTO <em>PRO</em> · Admin</b><span class="tag"><a href="/admin/economics" style="color:#F8B408">🧮 Calculadora</a> · <a href="/cs" style="color:#9DA8C4">🎧 Servicio</a> · <a href="/admin?logout" style="color:#9DA8C4">salir</a></span></header>
<div class="wrap">

<div class="cards">
  <div class="card gold"><div class="v">$${mrr.toLocaleString("en-US")}</div><div class="l" style="color:#9DA8C4">MRR · clientes pagando</div></div>
  <div class="card"><div class="v">${paying}</div><div class="l">Pagando</div>${(pendingPay || failedPay) ? `<div style="font-size:11px;font-weight:700;color:#8A94A8;margin-top:4px">${pendingPay ? `${pendingPay} pendiente` : ""}${pendingPay && failedPay ? " · " : ""}${failedPay ? `<span style="color:#C5221F">${failedPay} falló</span>` : ""}</div>` : ""}</div>
  <div class="card"><div class="v">${realClients.length}</div><div class="l">Clientes total</div></div>
  <div class="card"><div class="v">${leads7}</div><div class="l">Leads · 7 días</div></div>
  <div class="card"><div class="v">${tot("visit")}</div><div class="l">Visitas · 7 días</div></div>
  <div class="card"><div class="v">${tot("quiz_done")}</div><div class="l">Llamadas pedidas</div></div>
</div>

<div class="panel closures">
  <h2>💰 Cierres · reuniones del closer</h2>
  ${periodSeg("/admin", range, false)}
  <div class="subcards">
    <div class="sub gold"><div class="v">${closeRate}%</div><div class="l">Tasa de cierre</div></div>
    <div class="sub"><div class="v">${mst.total}</div><div class="l">Reuniones</div></div>
    <div class="sub"><div class="v">${mst.showed}</div><div class="l">Asistieron</div></div>
    <div class="sub"><div class="v" style="color:#C5221F">${mst.noShow}</div><div class="l">No-shows</div></div>
    <div class="sub"><div class="v">${mst.closed}</div><div class="l">Cerrados</div></div>
  </div>
  <p class="legend">Lo que registra tu closer en su portal. Las cuentas activadas con pago se ven en <b>MRR</b> arriba.</p>
</div>

<div class="grid2">
<div class="panel">
  <h2>📈 Visitas a la página · últimos 7 días</h2>
  <div class="chart">
    ${days.map((d) => { const v = get(d, "visit"); return `<div class="col"><span class="num">${v || ""}</span><div class="bar" style="height:${Math.round((v / maxV) * 100)}%"></div><span class="lbl">${d.slice(5)}</span></div>`; }).join("")}
  </div>
</div>
<div class="panel">
  <h2>🫙 Embudo · totales 7 días</h2>
  <div class="scroll"><table>
    <tr><th>Visitas</th><th>Widget visto</th><th>Cotizó</th><th>Quiz inició</th><th>Agendó</th></tr>
    <tr><td>${tot("visit")}</td><td>${tot("w_view")}</td><td>${tot("w_result")}</td><td>${tot("quiz_work")}</td><td>${tot("quiz_done")}</td></tr>
  </table></div>
  <p class="legend">Visitas = página de ventas · Widget visto = abrieron el cotizador · Cotizó = vieron precio · Quiz inició = 1ª pregunta · Agendó = dejaron datos.</p>
</div>
</div>

<div class="panel">
  <h2>🔗 Tus enlaces</h2>
  ${[
    ["PÚBLICO · VENTAS", [
      ["🌐 Página de ventas", "https://alto-pro.com"],
      ["🛰️ Demo del cotizador (mándalo a prospectos)", `${base}/w/alto-demo`],
      ["🏠 Página de ejemplo", `${base}/ejemplo`],
      ["🎨 Las 3 plantillas", `${base}/plantillas`],
    ]],
    ["EQUIPO · VENTAS (closer)", [
      ["🎤 Presentación de venta (en la llamada)", `${base}/demo`],
      ["🔒 Portal del closer", `${base}/closer`],
      ["📋 Cierre / objeciones (privado)", `${base}/cierre`],
    ]],
    ["EQUIPO · SERVICIO", [
      ["🎧 Centro de servicio al cliente (tareas)", `${base}/cs`],
      ["🎨 Onboarding / editar páginas", `${base}/onboarding`],
    ]],
    ["RECLUTAR", [
      ["👤 Presentación del rol (reclutar)", `${base}/equipo`],
    ]],
    ["PRIVADO · TÚ", [
      ["📊 Este tablero (admin)", `${base}/admin`],
      ["🧠 Centro de mando · números + IA", `${base}/admin/economics`],
      ["📲 La app (instalar/probar)", "https://app.alto-pro.com"],
      ["🩺 Estado del sistema (health)", `${base}/api/health`],
    ]],
  ].map(([group, links]) => `
    <p style="font-size:11px;font-weight:800;letter-spacing:1.5px;color:#8A94A8;margin:16px 0 6px">${group}</p>
    ${links.map(([name, url]) => {
      const noPrev = /\/admin$/.test(url) || url.includes("/api/health") || url.includes("app.alto-pro.com");
      const keyed = /\/(closer|cierre|cs|onboarding|admin\/economics)$/.test(url);
      const psrc = keyed ? `${url}?key=${KEY}` : url;
      const thumb = noPrev
        ? `<div class="lprev ph">🔗</div>`
        : `<div class="lprev"><iframe loading="lazy" scrolling="no" tabindex="-1" src="${psrc}"></iframe></div>`;
      return `<div class="lrow">
      ${thumb}
      <span style="flex:1">${name}<br><span class="lurl">${url}</span></span>
      <span class="lbtns">
        <button onclick="cpy(this,'${url}')" style="background:#F8B408;color:#101B30;border:none;border-radius:8px;padding:7px 12px;font-weight:800;cursor:pointer;font-size:12px">Copiar</button>
        <a href="${url}" target="_blank" style="background:#101B30;color:#fff;border-radius:8px;padding:7px 12px;font-weight:800;text-decoration:none;font-size:12px">Abrir</a>
      </span>
    </div>`; }).join("")}
  `).join("")}
  <p style="color:#9AA0AC;font-size:12px;margin-top:14px">El portal del closer y el onboarding piden clave; los públicos no.</p>
</div>

<div class="panel">
  <h2>➕ Nuevo cliente</h2>
  <form class="newform" method="post" action="/api/admin/contractors?html=1&key=${KEY}">
    <input name="name" placeholder="Nombre del negocio" required>
    <input name="phone" placeholder="Teléfono">
    <button>Crear cuenta</button>
  </form>
</div>

<div class="panel">
  <h2>👷 Clientes</h2>
  <input id="csearch" placeholder="🔍 Buscar cliente por nombre…" onkeyup="filterClients()" style="width:100%;padding:14px 16px;border:1px solid #E4E7EC;border-radius:14px;font-size:14.5px;font-weight:500;font-family:inherit;outline:none;margin-bottom:14px;transition:border-color .15s,box-shadow .15s" onfocus="this.style.borderColor='#F8B408';this.style.boxShadow='0 0 0 4px rgba(248,180,8,.18)'" onblur="this.style.borderColor='#E4E7EC';this.style.boxShadow='none'">
  <div class="scroll"><table>
  <tr><th>Negocio</th><th>Estado</th><th>Leads 7d</th><th>Total</th><th>Último lead</th><th>Widget</th><th>Acceso</th><th>IA / GHL</th><th>Creado</th></tr>
  ${list.map((c) => {
    const st = statOf(c.id);
    const hook = !!(c.data && c.data.webhook);
    const isB = BUILTIN.has(c.slug);
    const act = st.last7 > 0 ? `<span class="pill ok">${st.last7}</span>` : `<span class="pill dim">0</span>`;
    const isPaused = c.data && c.data.status === "paused";
    const pay = c.data && c.data.payStatus;
    const payTag = pay === "failed" ? ' <span class="pill warn">💳 falló</span>'
      : pay === "canceled" ? ' <span class="pill dim">canceló</span>'
      : pay === "pending" ? ' <span class="pill gold" title="Clic en «activo» para activar tras confirmar el pago">💳 pendiente</span>' : "";
    const dev = devCounts[String(c.id)] || 0;
    const devTag = (!isB && dev >= 4) ? ` <span class="pill warn" title="${dev} dispositivos/aperturas — posible link compartido. Ofrécele cuentas para su equipo.">📱 ${dev}</span>` : "";
    return `<tr data-name="${esc(c.name).toLowerCase()} ${c.slug}">
      <td><a href="/admin/c/${c.slug}" style="color:#101B30;font-weight:800">${esc(c.name)}</a>${isB ? ' <span class="pill gold">interno</span>' : ""}</td>
      <td>${isPaused
        ? `<a href="#" onclick="setStatus('${c.id}','active','${esc(c.name).replace(/'/g, "")}');return false"><span class="pill warn">⏸ pausado</span></a>`
        : `<a href="#" onclick="setStatus('${c.id}','paused','${esc(c.name).replace(/'/g, "")}');return false"><span class="pill ok">activo</span></a>`}${payTag}${devTag}</td>
      <td>${act}</td><td>${st.total}</td><td>${ago(st.last_at)}</td>
      <td><a href="/w/${c.slug}" target="_blank">/w/${c.slug}</a> · <a href="/site/${c.slug}" target="_blank">🌐</a> · <a href="/onboarding?key=${KEY}&slug=${c.slug}">🎨</a></td>
      <td><a href="/api/admin/invite?key=${KEY}&id=${c.id}">🔑 link</a></td>
      <td>${hook ? '<span class="pill ok">✓ conectado</span>' : `<a href="#" onclick="setHook('${c.id}','${esc(c.name).replace(/'/g, "")}');return false"><span class="pill warn">conectar</span></a>`}</td>
      <td>${fmtD(c.created_at)}</td></tr>`;
  }).join("")}
  </table></div>
</div>

<div class="panel">
  <h2>📥 Últimos leads (todos los clientes)</h2>
  <div class="scroll"><table>
  <tr><th>Cuándo</th><th>Cliente</th><th>Nombre</th><th>Teléfono</th><th>Dirección / datos</th><th>Estimado</th></tr>
  ${recent.length === 0 ? `<tr><td colspan="6" style="color:#8A94A8">Todavía no hay leads — llegarán aquí en cuanto alguien cotice o llene el quiz.</td></tr>` : recent.map((l) => {
    const i = l.info || {};
    const extra = i.work ? `${esc(i.work)} · ${esc(i.crew || "")} · ${esc(i.revenue || "")}` : esc(l.address);
    const est = i.low ? `$${Number(i.low).toLocaleString("en-US")}–$${Number(i.high).toLocaleString("en-US")}` : "—";
    return `<tr><td>${ago(l.created_at)}</td><td>${esc(l.contractor_name || l.slug)}</td><td>${esc(l.name)}</td><td>${esc(l.phone)}</td><td>${extra}</td><td>${est}</td></tr>`;
  }).join("")}
  </table></div>
</div>

</div>
<script>
function cpy(btn,url){navigator.clipboard.writeText(url);var o=btn.textContent;btn.textContent='✓';setTimeout(function(){btn.textContent=o},900);}
function filterClients(){
  var q=document.getElementById('csearch').value.toLowerCase().trim();
  [].forEach.call(document.querySelectorAll('tr[data-name]'),function(tr){
    tr.style.display = !q || tr.getAttribute('data-name').indexOf(q)>=0 ? '' : 'none';
  });
}
function setStatus(id, status, name){
  var q = status === 'paused'
    ? '¿Pausar a ' + name + '? Su cotizador y su página dejan de recibir leads. Su app y sus datos NO se tocan.'
    : '¿Reactivar a ' + name + '? Su cotizador vuelve a recibir leads al instante.';
  if (!confirm(q)) return;
  fetch('/api/admin/status?key=${KEY}&id=' + id + '&status=' + status)
    .then(r => r.json()).then(j => { if (!j.ok) alert('Error: ' + j.error); location.reload(); });
}
function setHook(id, name){
  var u = prompt('Webhook de HighLevel para ' + name + ' (vacío = desconectar):');
  if (u === null) return;
  fetch('/api/admin/webhook?key=${KEY}&id=' + id + '&url=' + encodeURIComponent(u))
    .then(r => r.json()).then(j => { alert(j.ok ? (j.webhook ? '✓ Conectado' : '✓ Desconectado') : 'Error: ' + j.error); location.reload(); });
}
</script>
</body></html>`);
});

// Per-client control page — everything about one client + every action
/* Unit-economics calculator (/admin/economics) — private, admin-only.
 * Plug in the 5 funnel numbers → live CAC, payback, LTV, profit/client. */
// AI "CEO briefing": turns the cockpit numbers into a short prioritized plan.
app.post("/api/admin/ceo", async (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "no auth" });
  const en = req.body?.lang === "en";
  const m = req.body?.metrics || {};
  const system = `You are a sharp, no-nonsense fractional CEO / growth advisor for ALTO Pro, a Spanish-first SaaS sold to Hispanic roofing contractors at about $297-349/month (website + roof-quote widget + app + AI secretary + leads). Given the numbers, write a concise, PRIORITIZED action plan in ${en ? "English" : "Spanish"}, max 160 words, plain text (no markdown headers). Be direct and specific: if close rate is low, say to fix/coach/replace closers BEFORE scaling ads; if unit economics are strong (LTV:CAC >= 3, payback < 3mo), say to scale ad spend and by roughly how much; flag churn and failed payments as fires to put out first. End with the single most important next action. No fluff.`;
  const user = `Numbers: ${JSON.stringify(m)}`;
  try {
    const text = await aiChat({ system, messages: [{ role: "user", content: user }], maxTokens: 380 });
    if (!text) return res.json({ ok: false, error: "ai_off" });
    res.json({ ok: true, text });
  } catch (e) { res.json({ ok: false, error: "ai_off" }); }
});

app.get("/admin/economics", async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).send("Set ADMIN_KEY env var to enable admin.");
  if (req.query.key === ADMIN_KEY) { setKeyCookie(res, "alto_admin", ADMIN_KEY); return res.redirect("/admin/economics"); }
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
<title>ALTO Pro · ${tr("Centro de mando", "Command center")}</title><link rel="icon" href="/icon-192.png"><style>
*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body{background:#F5F6F8;color:#0B1220;letter-spacing:-0.011em}
::selection{background:rgba(248,180,8,.35)}
.appheader{position:sticky;top:0;z-index:30;background:rgba(16,27,48,.9);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);color:#fff;padding:15px 24px;display:flex;align-items:center;gap:13px;border-bottom:1px solid rgba(255,255,255,.07)}
.appheader img{height:30px;background:#fff;border-radius:9px;padding:4px 6px}
.appheader b{font-size:16px;font-weight:700;letter-spacing:-0.02em}.appheader b em{color:#F8B408;font-style:normal}
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
.card.gold .v{color:#F8B408}.card.gold .l{color:#9DA8C4}.card.gold .s{color:#9DA8C4}
.card.good .v{color:#10803C}.card.bad .v{color:#C5221F}.card.warnc .v{color:#946400}
.grid{display:grid;gap:16px;margin-top:6px}
@media(min-width:900px){.grid{grid-template-columns:360px 1fr;align-items:start}}
.panel{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:20px;padding:20px 22px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 10px 26px rgba(16,27,48,.05)}
.panel h3{font-size:12px;color:#9097A3;letter-spacing:.6px;text-transform:uppercase;font-weight:700;margin-bottom:14px}
.fld{margin-bottom:13px}
.fld label{display:block;font-weight:600;font-size:12.5px;color:#475067;margin-bottom:5px}
.fld .row{display:flex;align-items:center;gap:9px}
.fld input[type=range]{flex:1;accent-color:#F8B408}
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
  <img src="/brand-logo.png" alt=""><b>ALTO <em>PRO</em> · ${tr("Centro de mando", "Command center")}</b>
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
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.name)} · ALTO Pro Admin</title><link rel="icon" href="/icon-192.png"><style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{background:#F5F6F8;color:#0B1220;letter-spacing:-0.011em}
::selection{background:rgba(248,180,8,.35)}
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
.b-gold{background:#F8B408;color:#101B30;box-shadow:0 6px 16px rgba(248,180,8,.3)}
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
    : `<button class="b-red" onclick="act('/api/admin/status?key=${KEY}&id=${c.id}&status=paused','¿Pausar? Su sitio y cotizador dejan de recibir leads.')">⏸ Pausar</button>`}
  <button class="b-dark" onclick="pub(${st.published ? "false" : "true"})">${st.published ? "Ocultar página" : "🚀 Publicar página"}</button>
  <a class="b-line" href="/onboarding?key=${KEY}&slug=${c.slug}">🎨 Onboarding</a>
  <a class="b-line" href="/api/admin/invite?key=${KEY}&id=${c.id}">🔑 Link de acceso</a>
  <button class="b-line" onclick="hook()">🤖 GHL ${d.webhook ? "(conectado)" : ""}</button>
</div></div>

<div class="panel"><h2>Enlaces</h2>
  <div class="kv"><span>Widget</span><a href="/w/${c.slug}" target="_blank">/w/${c.slug}</a></div>
  <div class="kv"><span>Página (pública)</span><a href="/site/${c.slug}" target="_blank">/site/${c.slug}</a></div>
  <div class="kv"><span>Borrador (preview)</span><a href="/site/${c.slug}?preview=1" target="_blank">ver borrador</a></div>
  <div class="kv"><span>Subdominio</span><span>${c.slug}.alto-pro.com</span></div>
  ${st.domain ? `<div class="kv"><span>Dominio propio</span><a href="https://${esc(st.domain)}" target="_blank">${esc(st.domain)}</a></div>` : ""}
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
function act(url,q){ if(q&&!confirm(q))return; fetch(url).then(r=>r.json()).then(j=>{ if(!j.ok)alert('Error: '+j.error); location.reload(); }); }
function pub(v){ fetch('/api/onboarding/publish?key=${KEY}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:'${c.slug}',publish:v})}).then(r=>r.json()).then(()=>location.reload()); }
function hook(){ var u=prompt('Webhook de HighLevel (vacío = desconectar):'); if(u===null)return; fetch('/api/admin/webhook?key=${KEY}&id=${c.id}&url='+encodeURIComponent(u)).then(r=>r.json()).then(j=>{alert(j.ok?'✓ Guardado':'Error');location.reload();}); }
</script>
</body></html>`);
});

// Invite link: exchanges for a session and drops the user into the app.
// Accounts pending payment see a wait page instead — the same link starts
// working the moment Stripe confirms (or the admin activates manually).
app.get("/invite/:token", async (req, res) => {
  const session = await db.useInvite(req.params.token);
  if (!session) return res.status(404).send("Invitación no válida.");
  const who = await db.getSessionContractor(session).catch(() => null);
  if (who?.data?.payStatus === "pending") {
    return res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ALTO Pro</title><style>
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0}
body{background:#101B30;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:22px;padding:36px 28px;max-width:400px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.45)}
img{height:48px;margin-bottom:12px}h1{font-size:19px;color:#101B30;margin-bottom:8px}
p{color:#5A6478;font-size:14px;font-weight:600;line-height:1.6}
a{display:inline-block;margin-top:18px;background:#F8B408;color:#101B30;text-decoration:none;font-weight:800;padding:13px 24px;border-radius:12px}
</style></head><body><div class="card">
<img src="/brand-logo.png" alt="ALTO Pro">
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
  if (req.body?.profile) await db.saveContractorData(c.id, req.body.profile);
  res.json({ ok: true });
});

// Forward a fresh lead to the contractor's HighLevel (or any) webhook so
// automations — AI texting, booking, notifications — fire instantly.
// Fire-and-forget: a dead webhook must never lose or delay the lead.
function forwardLead(c, lead) {
  const hook = c.data?.webhook;
  if (!hook || !/^https:\/\//.test(hook)) return;
  fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "alto-pro", contractor: c.slug, ...lead }),
  }).catch((e) => console.error(`webhook ${c.slug} failed:`, e.message));
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
  const status = String(req.body?.status || "contacted").slice(0, 20);
  await db.updateLeadStatus(c.id, String(req.params.id), status);
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
  if (!q || q.day !== day) { quotaMap.set(key, { day, n: 1 }); return false; }
  q.n += 1;
  if (quotaMap.size > 5000) quotaMap.delete(quotaMap.keys().next().value);
  return q.n > max;
}
const quoteCache = new Map();

/* Funnel tracking: tiny first-party counters, no cookies, no identities.
 * Only whitelisted event names are accepted. */
const TRACK_EVENTS = new Set(["visit", "quiz_work", "quiz_crew", "quiz_revenue", "quiz_marketing", "quiz_done", "w_view", "w_result"]);
app.post("/api/track", (req, res) => {
  const trIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`tr:${trIp}`, 300)) return res.json({ ok: true }); // silently ignore spam
  const event = String(req.body?.event || "");
  if (!TRACK_EVENTS.has(event)) return res.status(400).json({ error: "bad event" });
  db.bumpMetric(event).catch(() => { /* counters must never break the page */ });
  res.json({ ok: true });
});

/* Live AI-secretary demo for the sales presentation: the prospect chats
 * with the same AI that will answer their own customers' texts. */
app.post("/api/widget/chat", async (req, res) => {
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
  if (!msgs.length) return res.status(400).json({ error: "messages required" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (overQuota(`chat:${ip}`, 40) || overQuota("chat:all", 500)) return res.status(429).json({ error: "quota" });
  if (!aiLive) return res.json({ text: "(Demo) La IA se activa cuando el servidor tenga su API key.", source: "demo" });
  try {
    const inEnglish = req.body?.lang === "en";
    const text = await aiChat({
      maxTokens: 180,
      system: `Eres el asistente virtual de valuación de bienes raíces de un agente inmobiliario. Estás en una DEMO en vivo frente a un agente interesado en contratar este servicio. Responde SIEMPRE en ${inEnglish ? "inglés" : "español"}, estilo mensaje de texto: cálido, profesional, máximo 45 palabras, sin markdown. Tu meta: contestar dudas sobre el valor estimado de una propiedad (cómo se calcula con ventas comparables recientes — comps — cercanas, ajustadas por tamaño, recámaras/baños, año y recencia de venta) y AGENDAR una valuación detallada o consulta ofreciendo dos horarios concretos (por ejemplo "¿mañana 10am o 2pm?"). El estimado de la página es preliminar y se basa SOLO en ventas cerradas; las propiedades activas en el mercado son solo contexto, nunca el valor. NUNCA prometas un precio de venta garantizado ni des asesoría legal o financiera; un análisis de mercado completo (CMA) afina el número. Si confirman un horario, confirma con ✓ y menciona que les llegará un recordatorio. Si preguntan algo fuera de tema, redirige con amabilidad hacia el valor de la propiedad.`,
      messages: msgs.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 400) })),
    });
    res.json({ text, source: "live" });
  } catch (e) {
    console.error("widget chat failed:", e.message);
    res.status(502).json({ error: "ai_failed" });
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
  if (overQuota(`wip:${ip}`, 2) || overQuota(`wslug:${slug}`, 150)) return res.status(429).json({ error: "quota" });
  // lifetime per connection per widget: homeowners quote a roof 1-3 times
  // ever; only freeloaders and price-spies get anywhere near 20
  const wqLife = await db.incrCounter(`wq:${slug}:${ip}`).catch(() => 0);
  if (wqLife > 5) return res.status(429).json({ error: "quota" });

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

  res.json({ ok: true, id: leadId, addr: m?.addr || address, measured: !!quote, value: quote?.value ?? null, low: quote?.low ?? null, high: quote?.high ?? null, img: null });
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
<span style="font-size:40px">🛠️</span>
<h1>${pBiz}</h1>
<p>La cotización en línea no está disponible por el momento.<br>Online quotes are temporarily unavailable.</p>
${pPhone ? `<a href="tel:+1${pPhone}">📞 Llámanos / Call us</a>` : ""}
</div></body></html>`);
  }
  const esc = (s) => String(s || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const prof = c.data?.profile || {};
  const biz = esc(prof.biz || c.name);
  const bizPhone = String(prof.phone || c.phone || "").replace(/\D/g, "");
  const logo = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(String(prof.logo || "")) ? prof.logo : null;
  const es = (req.query.lang || prof.lang || "es") !== "en";
  const L = es ? {
    title: `Precio de tu techo en 60 segundos`,
    sub: "Medido por satélite · 100% gratis · Sin compromiso",
    addr: "Dirección de tu casa", cont: "CONTINUAR →",
    who: "¿A dónde mandamos tu precio?", name: "Tu nombre", phone: "Tu teléfono (celular)",
    see: "VER MI PRECIO →", back: "← Cambiar dirección",
    m1: "Buscando imagen satelital…", m2: "Midiendo tu techo…", m3: "Calculando tu precio…",
    range: "PRECIO ESTIMADO", rangeSub: "Teja arquitectónica, instalada. Precio preliminar — inspección gratis para precio exacto.",
    sent: "✓ Recibimos tus datos", call: (b) => `${b} te contacta hoy mismo.`,
    nores: "¡Listo! Recibimos tu información.", noresSub: (b) => `${b} te llama hoy con tu precio.`,
    callBtn: "📞 LLAMAR AHORA", phoneErr: "Pon un teléfono de 10 dígitos", addrErr: "Pon la dirección de tu casa",
    err: "Algo falló — intenta otra vez o llámanos.",
  } : {
    title: "Your roof price in 60 seconds",
    sub: "Measured by satellite · 100% free · No obligation",
    addr: "Your home address", cont: "CONTINUE →",
    who: "Where do we send your price?", name: "Your name", phone: "Your phone (mobile)",
    see: "SEE MY PRICE →", back: "← Change address",
    m1: "Finding satellite imagery…", m2: "Measuring your roof…", m3: "Calculating your price…",
    range: "ESTIMATED PRICE", rangeSub: "Architectural shingle, installed. Preliminary price — free inspection for an exact quote.",
    sent: "✓ We got your info", call: (b) => `${b} will contact you today.`,
    nores: "Done! We received your information.", noresSub: (b) => `${b} will call you today with your price.`,
    callBtn: "📞 CALL NOW", phoneErr: "Enter a 10-digit phone", addrErr: "Enter your home address",
    err: "Something went wrong — try again or call us.",
  };
  const wBase = `${req.protocol}://${req.get("host")}`;
  res.send(`<!doctype html><html lang="${es ? "es" : "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${biz}</title>
<meta property="og:title" content="${biz} — ${es ? "Precio de tu techo en 60 segundos" : "Your roof price in 60 seconds"}">
<meta property="og:description" content="${es ? "Pon tu dirección y mira tu techo medido por satélite. Gratis, sin compromiso." : "Type your address and see your roof measured by satellite. Free, no obligation."}">
<meta property="og:image" content="${wBase}/landing/og.png">
<meta name="twitter:card" content="summary_large_image">
<style>
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;-webkit-tap-highlight-color:transparent}
body{margin:0;background:#F4F6FA;color:#101B30}
.wrap{max-width:430px;margin:0 auto;padding:18px 16px 28px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.brand img{max-height:44px;max-width:140px;border-radius:8px}
.brand .nm{font-weight:800;font-size:18px}
.card{background:#fff;border:1.5px solid #E6E8EC;border-radius:18px;padding:20px;box-shadow:0 6px 22px rgba(16,27,48,.06)}
h1{font-size:24px;margin:0 0 4px;line-height:1.15}
.sub{color:#67718A;font-size:13px;font-weight:600;margin:0 0 16px}
input{width:100%;padding:14px;border:1.5px solid #E6E8EC;border-radius:12px;font-size:16px;font-weight:600;outline:none;margin-bottom:10px}
input:focus{border-color:#F8B408}
.btn{width:100%;padding:15px;border:none;border-radius:12px;background:#F8B408;color:#fff;font-size:16px;font-weight:800;cursor:pointer}
.btn:active{transform:scale(.98)}
.btn[disabled]{opacity:.5}
.sug{border:1.5px solid #E6E8EC;border-top:none;border-radius:0 0 12px 12px;margin:-12px 0 10px;background:#fff;overflow:hidden}
.sug button{display:block;width:100%;text-align:left;padding:11px 13px;border:none;background:#fff;font-size:14px;font-weight:600;cursor:pointer;border-top:1px solid #F0F2F6}
.sug button:active{background:#FEF5DC}
.ghost{background:none;border:none;color:#67718A;font-weight:700;font-size:13px;cursor:pointer;padding:10px 0}
.load{text-align:center;padding:30px 0}
.spin{width:46px;height:46px;border:5px solid #FEF5DC;border-top-color:#F8B408;border-radius:50%;margin:0 auto 14px;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.lmsg{font-weight:700;color:#67718A;font-size:14px}
.photo{width:100%;border-radius:14px;display:block;margin-bottom:12px}
.range{background:#101B30;border-radius:14px;padding:16px;text-align:center;margin-bottom:12px}
.range .lbl{color:#F8B408;font-size:11px;font-weight:800;letter-spacing:2px}
.range .val{color:#fff;font-size:30px;font-weight:800;margin-top:4px}
.note{color:#67718A;font-size:12px;font-weight:600;line-height:1.5}
.ok{background:#EAF8EF;border:1.5px solid #34A853;color:#1E7B3C;border-radius:12px;padding:12px;font-weight:700;font-size:14px;margin:12px 0}
.manual{background:#FEF5DC;border:1.5px solid #F8B408;color:#7A5A00;border-radius:12px;padding:12px;font-weight:700;font-size:13px;line-height:1.5;margin:12px 0}
.call{display:block;text-align:center;text-decoration:none;margin-top:12px;padding:15px;border-radius:12px;background:#101B30;color:#fff;font-weight:800;font-size:16px}
.ft{text-align:center;color:#9AA3B5;font-size:11px;font-weight:600;margin-top:18px}
.err{color:#D93025;font-size:13px;font-weight:700;margin:-4px 0 8px}
</style></head><body><div class="wrap">
<div class="brand">${logo ? `<img src="${logo}" alt="">` : ""}<span class="nm">${biz}</span></div>
<div class="card" id="card">
  <div id="s1">
    <h1>${L.title}</h1><p class="sub">${L.sub}</p>
    <input id="addr" placeholder="${L.addr}" autocomplete="street-address">
    <div class="sug" id="sug" style="display:none"></div>
    <p class="err" id="e1" style="display:none">${L.addrErr}</p>
    <button class="btn" onclick="toStep2()">${L.cont}</button>
  </div>
  <div id="s2" style="display:none">
    <h1>${L.who}</h1><p class="sub" id="addrEcho"></p>
    <input id="nm" placeholder="${L.name}" autocomplete="name">
    <input id="ph" placeholder="${L.phone}" type="tel" autocomplete="tel" inputmode="numeric">
    <p class="err" id="e2" style="display:none">${L.phoneErr}</p>
    <button class="btn" id="go" onclick="submit()">${L.see}</button>
    <button class="ghost" onclick="back1()">${L.back}</button>
  </div>
  <div id="s3" style="display:none" class="load"><div class="spin"></div><p class="lmsg" id="lmsg">${L.m1}</p></div>
  <div id="s4" style="display:none"></div>
</div>
<div class="ft">⚡ ALTO Pro</div>
</div>
<script>
var SLUG=${JSON.stringify(c.slug)},BIZ=${JSON.stringify(prof.biz || c.name)},BPH=${JSON.stringify(bizPhone)};
var L=${JSON.stringify({ m1: L.m1, m2: L.m2, m3: L.m3, range: L.range, rangeSub: L.rangeSub, sent: L.sent, callTxt: L.call(prof.biz || c.name), nores: L.nores, noresSub: L.noresSub(prof.biz || c.name), callBtn: L.callBtn, err: L.err,
  // contractor-facing note, demo widget only — homeowners on client sites get the free-inspection line instead
  manual: c.slug === "alto-demo" ? (es
    ? "👆 ¿La línea no quedó perfecta? En tu app ALTO Pro tú mismo trazas el techo con el dedo y sacas la medida exacta — para que cotices con confianza."
    : "👆 Outline not perfect? In your ALTO Pro app you trace the roof with your finger and get the exact measurement — so you quote with confidence.") : null })};
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
function show(id){['s1','s2','s3','s4'].forEach(function(s){document.getElementById(s).style.display=s===id?'block':'none'})}
function toStep2(){if(addr.value.trim().length<6){document.getElementById('e1').style.display='block';return}
  document.getElementById('e1').style.display='none';
  document.getElementById('addrEcho').textContent='📍 '+addr.value.trim();show('s2');document.getElementById('nm').focus()}
function back1(){show('s1')}
function submit(){
  var ph=document.getElementById('ph').value.replace(/\\D/g,'');
  if(ph.length<10){document.getElementById('e2').style.display='block';return}
  document.getElementById('e2').style.display='none';show('s3');
  var msgs=[L.m1,L.m2,L.m3],mi=0,lm=document.getElementById('lmsg');
  var mt=setInterval(function(){mi=(mi+1)%msgs.length;lm.textContent=msgs[mi]},1600);
  var wait=new Promise(function(r){setTimeout(r,2800)});
  var req=fetch('/api/widget/quote',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({slug:SLUG,name:document.getElementById('nm').value.trim(),phone:ph,address:addr.value.trim(),placeId:placeId})
  }).then(function(r){return r.ok?r.json():null}).catch(function(){return null});
  Promise.all([req,wait]).then(function(a){clearInterval(mt);render(a[0])})}
function fmt(n){return '$'+Number(n).toLocaleString('en-US',{maximumFractionDigits:0})}
function render(j){track('w_result');var s4=document.getElementById('s4'),h='';
  if(!j){s4.innerHTML='<p class="err">'+L.err+'</p>';show('s4');return}
  if(j.measured){
    if(j.img)h+='<img class="photo" src="'+j.img+'" alt="">';
    h+='<div class="range"><div class="lbl">'+L.range+'</div><div class="val">'+fmt(j.low)+' – '+fmt(j.high)+'</div></div>';
    h+='<p class="note">'+L.rangeSub+'</p>';
    h+='<div class="ok">'+L.sent+' — '+L.callTxt+'</div>';
  }else{
    h+='<div class="ok">'+L.nores+'</div><p class="note">'+L.noresSub+'</p>';
  }
  if(L.manual)h+='<div class="manual">'+L.manual+'</div>';
  if(BPH)h+='<a class="call" href="tel:+1'+BPH+'">'+L.callBtn+'</a>';
  s4.innerHTML=h;show('s4')}
</script></body></html>`);
});

/* ── Sales landing page (alto-pro.com) ──
 * One bold page that sells the bundle by SHOWING it: the live widget is
 * embedded so a visitor can measure a real roof right on the page.
 * Interested roofers leave name + phone → lead in the "alto-ventas" account. */
function landingPage(req) {
  const base = canonBase(req);
  const en = req.query.lang === "en";
  // Meta Pixel for ad tracking — only renders once META_PIXEL_ID is set
  const pixelId = (process.env.META_PIXEL_ID || "").replace(/[^0-9]/g, "");
  const pixelHead = pixelId ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixelId}');fbq('track','PageView');</script><noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1"/></noscript>` : "";
  // keep the language toggle on the same path (/ on the root domain, /ventas elsewhere)
  const langHref = `${req.path.startsWith("/ventas") ? "/ventas" : "/"}?lang=${en ? "es" : "en"}`;
  const L = en ? {
    lang: "en", langBtn: "🇲🇽 Español", langHref: "/?lang=es",
    title: "ALTO Pro — Your website quotes roofs by itself",
    desc: "Website + satellite quote tool + app. Customers leave their phone number and you get them on WhatsApp. Built for roofers.",
    ogTitle: "ALTO Pro — Your website quotes roofs by itself",
    ogDesc: "The customer types their address, the satellite measures their roof, and their phone number lands in your WhatsApp. Try it live.",
    h1: "LET YOUR WEBSITE<br>BRING YOU CUSTOMERS &<br>QUOTE FOR YOU <em>24/7</em>",
    sub: "The customer types their address, leaves their phone number and sees their roof price measured by <b>satellite</b> — and that customer lands straight in your WhatsApp. Even while you're asleep or up on a roof.",
    cta1: "SEE THE LIVE DEMO ↓", cta2: "See pricing",
    chips: ["🇺🇸 Bilingual", "🏠 Built for roofers", "📲 No App Store"],
    tryT: "TRY IT <em>RIGHT NOW</em>",
    trySub: `This is what customers will see on YOUR website — with your logo and <b style="color:#101B30">YOUR prices</b>: you set them in the app and change them anytime. The price shows as a <b style="color:#101B30">range</b>, leaving you room to adjust (or raise) at inspection. Type a real address and watch it measure the roof.`,
    fullQ: "What about the full website?", fullSub: "See a sample website, actually working — imagine your logo, your colors and your name.",
    fullBtn: "TAP TO SEE YOUR WEBSITE →",
    howT: "HOW DOES IT <em>WORK</em>?",
    s1t: "The customer lands on your site", s1x: "From an ad, from Google, or because someone shared your link. Your website works even while you're up on a roof.",
    s2t: "They leave their phone to see the price", s2x: `<b style="color:#D99E00">No name and phone, no price.</b> The satellite measures their roof and calculates a range with YOUR prices — you edit them in the app anytime, and the quote tool uses them instantly.`,
    s3t: "The lead hits your phone", s3x: "Name, address, phone and the price they saw — instantly, in your app. One button and you're already writing them on WhatsApp with the message pre-written.",
    leadsT: "CUSTOMERS LAND<br><em>ON YOUR PHONE</em>",
    leads: ["<b>📥</b> Every lead buzzes in your pocket instantly", "<b>💰</b> Your prices, your range — raise them whenever you want", "<b>💬</b> WhatsApp message pre-written — one tap and you reply", "<b>🛰️</b> Satellite estimates in 60 seconds", "<b>🧾</b> Professional invoices with your logo"],
    pNew: "1 NEW", pNew2: "NEW",
    appT: "AND ON YOUR PHONE, <em>THE APP</em>",
    appSub: `You're on a job and the neighbor asks "how much for mine?" — you type their address (or use your GPS), the satellite measures it, and you send the formal quote right there.`,
    cap1: "Measured by satellite<br>in 60 seconds", cap2: "Want to be sure?<br>Trace it yourself with your finger", cap3: "Formal quote with your<br>brand, ready to send",
    priceT: "ONE <em>PRICE</em>", priceSub: "No fine print. No long contracts. Cancel anytime and your domain is yours.",
    mo: "/mo", setup: "+ $297 to start (one time)",
    inc: ["Your professional website with your brand", "Satellite quote tool on your site", "The ALTO Pro app: estimates, invoices, leads", "Leads straight to your WhatsApp", "Your domain (yourbusiness.com) is yours — by contract", "Bilingual support"],
    talkT: "READY? <em>LET'S TALK</em>", talkSub: "Answer 4 quick questions and schedule a call with the team. No obligation — we answer everything and you decide.",
    q1: "What type of work do you do?", q1o: ["Residential", "Commercial", "Both", "Other"],
    q2: "How big is your crew?", q2o: ["Just me", "2–5", "6–10", "More than 10"],
    q3: "About how much revenue per month?", q3o: ["Under $10k", "$10k–$30k", "$30k–$80k", "Over $80k"],
    q4: "How much do you spend on marketing monthly?", q4o: ["Nothing yet", "Under $500", "$500–$2,000", "Over $2,000"],
    q5: "Last step — where do we call you?", back: "← Back",
    fName: "Your name", fBiz: "Your business name", fPhone: "Your phone (mobile)", fBtn: "SCHEDULE MY CALL →", fOk: "✓ Done! The team will contact you today to set a time.",
    foot: `ALTO Pro · Made in Texas 🤠 · <a href="https://app.alto-pro.com">app.alto-pro.com</a>`,
  } : {
    lang: "es", langBtn: "🇺🇸 English", langHref: "/?lang=en",
    title: "ALTO Pro — Tu página web cotiza techos sola",
    desc: "Página web + cotizador por satélite + app. Los clientes dejan su teléfono y tú los recibes en WhatsApp. Para roferos.",
    ogTitle: "ALTO Pro — Tu página web cotiza techos sola",
    ogDesc: "El cliente pone su dirección, el satélite mide su techo, y su teléfono te llega a tu WhatsApp. Pruébalo en vivo.",
    h1: "DEJA QUE TU PÁGINA<br>TE GENERE CLIENTES Y<br>COTICE POR TI <em>24/7</em>",
    sub: "El cliente escribe su dirección, deja su teléfono y ve el precio de su techo medido por <b>satélite</b> — y ese cliente te llega directo a tu WhatsApp. Aunque estés dormido o arriba de un techo.",
    cta1: "VER DEMO EN VIVO ↓", cta2: "Ver precio",
    chips: ["🇺🇸 En español", "🏠 Hecho para roferos", "📲 Sin App Store"],
    tryT: "PRUÉBALO <em>AHORA MISMO</em>",
    trySub: `Esto es lo que verán los clientes en TU página web — con tu logo y <b style="color:#101B30">TUS precios</b>: tú los pones en la app y los cambias cuando quieras. El precio sale en <b style="color:#101B30">rango</b>, así te queda espacio para ajustar (o subir) cuando inspecciones. Escribe una dirección de verdad y mira cómo mide el techo.`,
    fullQ: "¿Y la página completa?", fullSub: "Mira una página de ejemplo, funcionando de verdad — imagina tu logo, tus colores y tu nombre.",
    fullBtn: "PRESIONA PARA VER TU PÁGINA →",
    howT: "¿CÓMO <em>FUNCIONA</em>?",
    s1t: "El cliente entra a tu página", s1x: "De un anuncio, de Google, o porque alguien le pasó tu link. Tu página trabaja aunque tú estés arriba de un techo.",
    s2t: "Deja su teléfono para ver su precio", s2x: `<b style="color:#D99E00">Sin nombre y teléfono, no hay precio.</b> El satélite mide su techo y calcula un rango con TUS precios — los editas en la app cuando quieras, y el cotizador los usa al instante.`,
    s3t: "El lead te llega a tu teléfono", s3x: "Nombre, dirección, teléfono y el precio que vio — al instante, en tu app. Un botón y ya le estás escribiendo por WhatsApp con el mensaje listo.",
    leadsT: "LOS CLIENTES LLEGAN<br><em>A TU TELÉFONO</em>",
    leads: ["<b>📥</b> Cada lead suena en tu bolsillo al instante", "<b>💰</b> Tus precios, tu rango — los subes cuando quieras", "<b>💬</b> Mensaje de WhatsApp ya escrito — un tap y contestas", "<b>🛰️</b> Estimados por satélite en 60 segundos", "<b>🧾</b> Facturas profesionales con tu logo"],
    pNew: "1 NUEVO", pNew2: "NUEVO",
    appT: "Y EN TU TELÉFONO, <em>LA APP</em>",
    appSub: `Estás en un trabajo y el vecino te pregunta "¿cuánto por el mío?" — pones su dirección (o usas tu GPS), el satélite lo mide, y le mandas la cotización formal ahí mismo.`,
    cap1: "Medido por satélite<br>en 60 segundos", cap2: "¿Quieres estar seguro?<br>Trázalo tú mismo con el dedo", cap3: "Cotización formal con tu<br>marca, lista para mandar",
    priceT: "UN SOLO <em>PRECIO</em>", priceSub: "Sin letras chiquitas. Sin contratos largos. Cancelas cuando quieras y tu dominio es tuyo.",
    mo: "/mes", setup: "+ $297 para empezar (una sola vez)",
    inc: ["Tu página web profesional con tu marca", "Cotizador por satélite en tu página", "La app ALTO Pro: estimados, facturas, leads", "Leads directo a tu WhatsApp", "Tu dominio (tupágina.com) es tuyo — por contrato", "Soporte en español"],
    talkT: "¿LISTO? <em>HABLEMOS</em>", talkSub: "Contesta 4 preguntas rápidas y agenda una llamada con el equipo. Sin compromiso — resolvemos todas tus dudas y tú decides.",
    q1: "¿Qué tipo de trabajos haces?", q1o: ["Residencial", "Comercial", "Ambos", "Otro"],
    q2: "¿De qué tamaño es tu equipo?", q2o: ["Solo yo", "2–5", "6–10", "Más de 10"],
    q3: "¿Cuánto facturas al mes (aprox.)?", q3o: ["Menos de $10k", "$10k–$30k", "$30k–$80k", "Más de $80k"],
    q4: "¿Cuánto inviertes en marketing al mes?", q4o: ["Nada todavía", "Menos de $500", "$500–$2,000", "Más de $2,000"],
    q5: "Último paso — ¿a dónde te llamamos?", back: "← Atrás",
    fName: "Tu nombre", fBiz: "Nombre de tu negocio", fPhone: "Tu teléfono (celular)", fBtn: "AGENDAR MI LLAMADA →", fOk: "✓ ¡Listo! El equipo te contacta hoy mismo para apartar tu hora.",
    foot: `ALTO Pro · Hecho en Texas 🤠 · <a href="https://app.alto-pro.com">app.alto-pro.com</a>`,
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
.hero h1 em{color:#F8B408;font-style:normal}
.hero p{color:#5A6478;font-size:clamp(15px,2.5vw,19px);font-weight:600;margin:18px auto 0;max-width:620px;line-height:1.55}
.cta{display:inline-block;margin-top:30px;background:#F8B408;color:#101B30;font-weight:800;font-size:17px;padding:17px 36px;border-radius:14px;text-decoration:none;box-shadow:0 14px 34px rgba(248,180,8,.35)}
.cta2{display:inline-block;margin-top:30px;margin-left:12px;color:#101B30;font-weight:700;font-size:15px;padding:17px 24px;text-decoration:none;border:1.5px solid #DDE3EE;border-radius:14px}
.chips{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:26px}
.chip{background:#F4F7FB;border:1px solid #E6EBF3;border-radius:99px;padding:8px 16px;font-size:13px;font-weight:700;color:#44506A}
section{padding:64px 0}
.band{background:#F7F9FC}
.dark{background:#101B30;color:#fff}
.sec-t{font-family:'Barlow Condensed',sans-serif;font-size:clamp(32px,5vw,48px);font-weight:800;text-align:center;line-height:1.05}
.sec-t em{color:#F8B408;font-style:normal}
.sec-sub{color:#5A6478;text-align:center;font-weight:600;margin:12px auto 34px;max-width:600px;font-size:15px;line-height:1.6}
.dark .sec-sub{color:#9DA8C4}
.demo-frame{background:#fff;border:1px solid #E6EBF3;border-radius:26px;padding:10px;max-width:460px;margin:0 auto;box-shadow:0 26px 70px rgba(16,27,48,.13)}
.demo-frame iframe{width:100%;height:540px;border:0;border-radius:18px;display:block}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px}
.step{background:#fff;border:1px solid #E8ECF3;border-radius:22px;padding:28px;box-shadow:0 10px 30px rgba(16,27,48,.05)}
.step .n{font-family:'Barlow Condensed',sans-serif;color:#F8B408;font-size:44px;font-weight:800}
.step h3{font-size:18px;margin:8px 0 8px}
.step p{color:#5A6478;font-size:14px;font-weight:600;line-height:1.6}
.phone-sec{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:48px}
.phone{width:280px;background:#0B1226;border:10px solid #1E2A45;border-radius:42px;padding:18px 14px 26px;box-shadow:0 36px 90px rgba(0,0,0,.45)}
.notch{width:110px;height:22px;background:#1E2A45;border-radius:0 0 14px 14px;margin:-18px auto 14px}
.papp{background:#F4F6FA;border-radius:18px;padding:12px;color:#101B30}
.phead{font-weight:800;font-size:15px;display:flex;align-items:center;gap:8px;margin-bottom:10px}
.pbadge{background:#F8B408;color:#fff;border-radius:99px;font-size:11px;font-weight:800;padding:3px 10px;margin-left:auto}
.plead{background:#fff;border:2px solid #F8B408;border-radius:14px;padding:12px;font-size:13px;line-height:1.5}
.pnew{background:#F8B408;color:#fff;border-radius:99px;font-size:10px;font-weight:800;padding:2px 8px}
.gold{color:#D99E00;font-weight:800}
.pwa{background:#25D366;color:#fff;border-radius:10px;text-align:center;font-weight:800;font-size:13px;padding:9px;margin-top:10px}
.ben{max-width:430px}
.ben li{list-style:none;padding:11px 0;font-weight:600;font-size:16px;color:#E7ECF6;border-bottom:1px solid rgba(255,255,255,.09)}
.ben li b{color:#F8B408}
.shots{display:flex;gap:28px;justify-content:center;flex-wrap:wrap;margin-bottom:10px}
.shot img{width:240px;border-radius:26px;border:1px solid #E6EBF3;display:block;box-shadow:0 22px 56px rgba(16,27,48,.14)}
.shot p{text-align:center;color:#5A6478;font-size:13px;font-weight:700;margin-top:13px;line-height:1.45}
.price-card{background:#fff;border:1px solid #E8ECF3;border-radius:28px;max-width:440px;margin:0 auto;padding:38px;text-align:center;box-shadow:0 30px 80px rgba(16,27,48,.12)}
.price-card .amt{font-family:'Barlow Condensed',sans-serif;font-size:68px;font-weight:800;line-height:1}
.price-card .amt small{font-size:22px;color:#67718A;font-weight:700}
.price-card .setup{color:#67718A;font-weight:700;font-size:14px;margin-top:6px}
.price-card ul{text-align:left;margin:24px 0 0;padding:0}
.price-card li{list-style:none;padding:8px 0;font-weight:600;font-size:14px}
.price-card li::before{content:"✓ ";color:#34A853;font-weight:800}
.quiz{max-width:480px;margin:0 auto;position:relative}
.qbar{height:6px;background:#EDF0F5;border-radius:99px;margin-bottom:26px;overflow:hidden}
.qfill{height:100%;width:20%;background:#F8B408;border-radius:99px;transition:width .3s ease}
.qstep{display:none}
.qstep.on{display:block}
.qq{font-weight:800;font-size:19px;text-align:center;margin-bottom:18px}
.opts{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.opt{background:#fff;border:1.5px solid #DDE3EE;border-radius:14px;padding:18px 12px;font-weight:700;font-size:15px;color:#101B30;cursor:pointer;box-shadow:0 6px 18px rgba(16,27,48,.05)}
.opt:hover{border-color:#F8B408;background:#FFFBEF}
.qback{display:block;margin:18px auto 0;background:none;border:none;color:#8A94A8;font-weight:700;font-size:13px;cursor:pointer;box-shadow:none;width:auto;padding:6px 12px}
form{max-width:440px;margin:0 auto}
input{width:100%;padding:15px;border-radius:12px;border:1.5px solid #DDE3EE;background:#fff;color:#101B30;font-size:16px;font-weight:600;margin-bottom:10px;outline:none}
input:focus{border-color:#F8B408}
button{width:100%;padding:17px;border:none;border-radius:12px;background:#F8B408;color:#101B30;font-size:17px;font-weight:800;cursor:pointer;box-shadow:0 12px 30px rgba(248,180,8,.3)}
.ok-msg{display:none;background:#EAF8EF;border:1.5px solid #34A853;color:#1E7B3C;border-radius:12px;padding:14px;font-weight:700;text-align:center;margin-top:10px}
footer{padding:40px 0 54px;text-align:center;font-size:13px;color:#8A94A8;font-weight:600}
footer a{color:#8A94A8}
</style></head><body>
<a class="langpill" href="${langHref}">${L.langBtn}</a>
<div class="wrap">
<nav><span class="lg"><img src="/brand-logo.png" alt="ALTO Pro"></span></nav>
<div class="hero">
  <h1>${L.h1}</h1>
  <p>${L.sub}</p>
  <a class="cta" href="#demo">${L.cta1}</a><a class="cta2" href="#precio">${L.cta2}</a>
  <div class="chips">${L.chips.map((c) => `<span class="chip">${c}</span>`).join("")}</div>
</div>
</div>

<div class="band"><div class="wrap"><section id="demo" style="padding-bottom:70px">
  <h2 class="sec-t">${L.tryT}</h2>
  <p class="sec-sub">${L.trySub}</p>
  <div class="demo-frame"><iframe src="/w/alto-demo${en ? "?lang=en" : ""}" loading="lazy" title="Demo"></iframe></div>
  <div style="text-align:center;margin-top:38px">
    <p style="font-weight:800;font-size:17px;margin-bottom:4px">${L.fullQ}</p>
    <p class="sec-sub" style="margin-bottom:18px">${L.fullSub}</p>
    <a class="cta" href="/ejemplo" target="_blank">${L.fullBtn}</a>
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
    <div class="phone"><div class="notch"></div>
      <div class="papp">
        <div class="phead">📥 Leads <span class="pbadge">${L.pNew}</span></div>
        <div class="plead"><b>Carlos Pérez</b> <span class="pnew">${L.pNew2}</span><br>📍 502 Britton Ave<br>(956) 555-0188 · <span class="gold">$7,700–$9,850</span>
          <div class="pwa">💬 WhatsApp</div>
        </div>
      </div>
    </div>
    <div class="ben">
      <h2 class="sec-t" style="text-align:left">${L.leadsT}</h2>
      <ul style="margin-top:20px;padding:0">${L.leads.map((x) => `<li>${x}</li>`).join("")}</ul>
    </div>
  </div>
</section></div></div>

<div class="wrap"><section>
  <h2 class="sec-t">${L.appT}</h2>
  <p class="sec-sub">${L.appSub}</p>
  <div class="shots">
    <div class="shot"><img src="/landing/app-measure.png" alt="" loading="lazy"><p>${L.cap1}</p></div>
    <div class="shot"><img src="/landing/app-trace.png" alt="" loading="lazy"><p>${L.cap2}</p></div>
    <div class="shot"><img src="/landing/app-quote.png" alt="" loading="lazy"><p>${L.cap3}</p></div>
  </div>
</section></div>

<div class="band"><div class="wrap"><section id="precio">
  <h2 class="sec-t">${L.priceT}</h2>
  <p class="sec-sub">${L.priceSub}</p>
  <div class="price-card">
    <div class="amt">$297<small>${L.mo}</small></div>
    <div class="setup">${L.setup}</div>
    <ul>${L.inc.map((x) => `<li>${x}</li>`).join("")}</ul>
  </div>
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
<footer>${L.foot}</footer>
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
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Techos García — Ejemplo ALTO Pro</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0;-webkit-tap-highlight-color:transparent}
:root{--red:#B30F24;--red2:#8E0C1D;--ink:#0F1216;--mut:#5E6470;--line:#E9EAEE;--cream:#FAF8F5}
body{background:#fff;color:var(--ink)}
.serif{font-family:'Fraunces',Georgia,serif}
.wrap{max-width:1060px;margin:0 auto;padding:0 24px}
.ribbon{background:#F8B408;color:#101B30;text-align:center;font-weight:800;font-size:12.5px;padding:9px 14px;letter-spacing:.2px}
header{position:sticky;top:0;z-index:40;background:rgba(255,255,255,.82);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.hrow{display:flex;align-items:center;justify-content:space-between;padding:15px 0}
.logo-ph{border:1.5px dashed #C9CDD6;border-radius:10px;padding:9px 18px;font-weight:700;font-size:12px;color:#9AA0AC;letter-spacing:2.5px}
.hcall{display:flex;align-items:center;gap:14px}
.hcall small{font-weight:700;color:var(--mut);font-size:12px;display:none}
@media(min-width:640px){.hcall small{display:block}}
.callbtn{background:var(--red);color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;box-shadow:0 8px 22px rgba(179,15,36,.28)}
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
.qframe iframe{width:100%;height:530px;border:0;border-radius:18px;display:block}
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
.backalto span{color:#F8B408}
.fade{opacity:0;transform:translateY(26px);transition:opacity .7s ease,transform .7s ease}
.fade.on{opacity:1;transform:none}
@media (prefers-reduced-motion: reduce){.fade{opacity:1;transform:none;transition:none}}
</style></head><body>
${embed ? "" : `<div class="ribbon">📋 PÁGINA DE EJEMPLO — imagina TU logo y TU nombre aquí. Así se vería tu página con ALTO Pro.</div>`}
<header><div class="wrap hrow">
  <span class="logo-ph">TU LOGO</span>
  <span class="hcall"><small>Lun–Sáb · 7am–7pm</small><a class="callbtn" href="tel:+19565550100">📞 (956) 555-0100</a></span>
</div></header>

<div class="hero">
  <img class="bgimg" src="/api/roofimg?lat=26.3828&lng=-98.8198&zoom=18" alt="">
  <div class="veil"></div>
  <div class="wrap in">
    <span class="kick">TECHOS RESIDENCIALES · TU CIUDAD, TX</span>
    <h1>Un techo que protege<br>lo que <em>más importa</em></h1>
    <p>Reemplazo y reparación de techos con garantía por escrito. Cotiza el tuyo ahora mismo, medido por satélite — sin que nadie te visite.</p>
    <a class="cta" href="#cotiza">COTIZA EN 60 SEGUNDOS</a><a class="cta ghost" href="tel:+19565550100">Llámanos</a>
  </div>
  <div class="wrap stats">
    <div class="stat"><b>15+</b><span>años</span></div>
    <div class="stat"><b>500+</b><span>techos</span></div>
    <div class="stat"><b>100%</b><span>garantía escrita</span></div>
  </div>
</div>

<div class="wrap"><section id="cotiza">
  <p class="eyebrow">Cotización instantánea</p>
  <h2 class="t">Tu precio, <em>sin esperar</em></h2>
  <div class="qwrap fade">
    <div class="qgrid">
      <div class="qcopy">
        <h3>Escribe tu dirección.<br>El satélite hace el resto.</h3>
        <p>Nuestro sistema mide tu techo desde imágenes satelitales y te da un precio estimado al instante — gratis y sin compromiso.</p>
        <ul><li>Medición real de TU casa</li><li>Precio en menos de un minuto</li><li>Inspección gratis para el precio exacto</li></ul>
      </div>
      <div class="qframe"><iframe src="/w/alto-demo" loading="lazy" title="Cotizador"></iframe></div>
    </div>
  </div>
</section></div>

<div class="wrap"><section style="padding-top:10px">
  <p class="eyebrow">Servicios</p>
  <h2 class="t">Lo que hacemos <em>bien</em></h2>
  <div style="margin-top:44px">
    <div class="svc fade"><span class="no">01</span><div><h3>Reemplazo de techo</h3><p>Teja arquitectónica, metal o teja de barro. Trabajo limpio, rápido y con garantía por escrito.</p></div><span class="arr">→</span></div>
    <div class="svc fade"><span class="no">02</span><div><h3>Reparaciones</h3><p>Goteras, tejas voladas por el viento, flasheo. Respuesta el mismo día cuando es posible.</p></div><span class="arr">→</span></div>
    <div class="svc fade"><span class="no">03</span><div><h3>Reclamos de seguro</h3><p>Te acompañamos en la inspección y el papeleo después de granizo o tormenta.</p></div><span class="arr">→</span></div>
    <div class="svc fade"><span class="no">04</span><div><h3>Inspección gratuita</h3><p>Revisamos tu techo y te decimos la verdad — aunque no necesites nada todavía.</p></div><span class="arr">→</span></div>
  </div>
</section></div>

<div class="wrap"><section style="padding-top:10px">
  <p class="eyebrow">Proyectos recientes</p>
  <h2 class="t">Techos medidos <em>desde el cielo</em></h2>
  <p class="sub">Cada proyecto empieza con una medición satelital exacta — así cotizamos justo, sin sorpresas.</p>
  <div class="projgrid">
    <div class="proj fade"><img loading="lazy" src="/api/roofimg?lat=26.3827418&lng=-98.8196915&zoom=20" alt=""><span class="tag">Reemplazo completo<small>Teja arquitectónica · 24 sq</small></span></div>
    <div class="proj fade"><img loading="lazy" src="/api/roofimg?lat=26.3795779&lng=-98.8186812&zoom=20" alt=""><span class="tag">Techo nuevo<small>Teja arquitectónica · 31 sq</small></span></div>
    <div class="proj fade"><img loading="lazy" src="/api/roofimg?lat=26.3807212&lng=-98.8148616&zoom=20" alt=""><span class="tag">Reparación mayor<small>Después de granizo · seguro</small></span></div>
  </div>
</section></div>

<div class="gband"><div class="wrap"><section>
  <p class="eyebrow">Nuestro proceso</p>
  <h2 class="t">Simple, <em>de principio a fin</em></h2>
  <div class="steps">
    <div class="pstep fade"><div class="pn">1</div><h3>Inspección</h3><p>Confirmamos la medida satelital en sitio y revisamos la condición real de tu techo. Gratis.</p></div>
    <div class="pstep fade"><div class="pn">2</div><h3>Propuesta clara</h3><p>Precio por escrito, materiales y fechas. Sin letras chiquitas ni cargos sorpresa.</p></div>
    <div class="pstep fade"><div class="pn">3</div><h3>Instalación</h3><p>Equipo propio, limpieza total al terminar y garantía por escrito en tu mano.</p></div>
  </div>
</section></div></div>

<div class="wrap"><section>
  <p class="eyebrow">Reseñas</p>
  <h2 class="t">Lo que dicen <em>nuestros clientes</em></h2>
  <div class="rev fade">
    <div class="stars">★★★★★</div>
    <p>Aquí van las reseñas reales de TUS clientes de Google.<br>(En esta página de ejemplo no inventamos testimonios.)</p>
  </div>
</section></div>

<div class="ctaband">
  <img class="bgimg" src="/api/roofimg?lat=26.3828&lng=-98.8198&zoom=17" alt="">
  <div class="veil"></div>
  <div class="in">
    <h2>¿Listo para un techo<br><em>hecho bien?</em></h2>
    <p>Cotiza en 60 segundos o mándanos un WhatsApp.</p>
    <a class="a1" href="#cotiza">COTIZA AHORA</a><a class="a2" href="https://wa.me/19565550100">💬 WhatsApp</a>
  </div>
</div>
<footer><b>Techos García</b><br>Tu Ciudad, TX · Lic. #00000 · Lun–Sáb 7am–7pm<br>Página de ejemplo hecha con ⚡ ALTO Pro — <a href="/ventas">así puede ser la tuya</a></footer>
${embed ? "" : `<a class="backalto" href="/ventas#precio">← Volver a <span>ALTO PRO</span></a>`}
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
<span style="font-size:40px">🛠️</span><h1>${pBiz}</h1>
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
.done b{color:#34A853}.wip b{color:#D99E00}
.ft{color:#9AA3B2;font-size:11.5px;font-weight:600;margin-top:22px}
</style></head><body><div class="card">
${cLogo ? `<img class="logo" src="${cLogo}" alt="${cBiz}">` : `<div class="biz">${cBiz}</div>`}
<h1>🏗️ Tu página web se está armando</h1>
<p class="sub">Nuestro equipo está poniendo los últimos detalles a tu página, tu cotizador por satélite y tu sistema de mensajes.</p>
<div class="bar"><div class="fill"></div></div>
<p class="eta">Lista en aproximadamente 10 días</p>
<ul>
<li class="done">🎨 Diseño y tu marca <b>✓ Listo</b></li>
<li class="done">🛰️ Cotizador por satélite <b>✓ Listo</b></li>
<li class="wip">📞 Registro de tu número <b>En proceso</b></li>
<li class="wip">🚀 Publicación de tu página <b>En proceso</b></li>
</ul>
<p class="ft">⚡ Hecho con ALTO Pro</p>
</div></body></html>`);
  }
  res.send(renderSite(siteDataOf(c)));
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
    biz: "Techos García",
    phone: "9565550100",
    logo: null,
    template: n,
    color: req.query.color && /^#?[a-f0-9]{6}$/i.test(req.query.color) ? (req.query.color.startsWith("#") ? req.query.color : "#" + req.query.color) : SIG[n],
    city: "Tu Ciudad, TX",
    years: 15,
    license: "00000",
    about: "Empezamos hace 15 años con una troca y muchas ganas. Hoy somos un equipo que ha hecho cientos de techos en la región — y seguimos tratando cada casa como si fuera la nuestra.",
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
<title>ALTO Pro · Elige tu plantilla</title><link rel="icon" href="/icon-192.png"><style>
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0}
body{background:#101B30;color:#fff;padding:34px 20px 60px}
h1{text-align:center;font-size:clamp(24px,4.5vw,36px);font-weight:800}
h1 em{color:#F8B408;font-style:normal}
.sub{text-align:center;color:#9DA8C4;font-weight:600;font-size:14px;margin:10px auto 6px;max-width:520px;line-height:1.6}
.colorbar{display:flex;gap:10px;justify-content:center;align-items:center;margin:18px 0 30px;flex-wrap:wrap}
.colorbar label{font-weight:700;font-size:13px;color:#C9D2E5}
.colorbar input[type=color]{width:46px;height:38px;border:none;border-radius:10px;background:none;cursor:pointer}
.colorbar button{background:#F8B408;color:#101B30;border:none;border-radius:10px;padding:10px 18px;font-weight:800;cursor:pointer}
.grid{display:flex;gap:34px;justify-content:center;flex-wrap:wrap}
.card{text-align:center}
.phone{background:#0B1226;border:9px solid #1E2A45;border-radius:40px;padding:10px;box-shadow:0 26px 70px rgba(0,0,0,.5)}
.scr{width:252px;height:512px;overflow:hidden;border-radius:26px}
.scr iframe{width:390px;height:792px;border:0;transform:scale(.6462);transform-origin:0 0;background:#fff}
.nm{font-weight:800;font-size:17px;margin-top:16px}
.nm span{color:#F8B408}
.ds{color:#9DA8C4;font-weight:600;font-size:13px;margin-top:4px}
.open{display:inline-block;margin-top:12px;background:#fff;color:#101B30;text-decoration:none;font-weight:800;font-size:13px;padding:10px 20px;border-radius:99px}
</style></head><body>
<h1>¿Cuál se siente <em>más tú</em>?</h1>
<p class="sub">Tres estilos, el mismo motor: tu logo, tus colores y el cotizador por satélite adentro. Prueba tu color de marca — las tres se pintan al instante.</p>
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

app.get("/cs", async (req, res) => {
  if (!CS_KEY && !ADMIN_KEY) return res.status(503).send("Set CS_KEY or ADMIN_KEY.");
  if (req.query.logout != null) { clearKeyCookie(res, "alto_cs"); return res.redirect("/cs"); }
  const qk = req.query.key;
  if (qk && ((CS_KEY && qk === CS_KEY) || (ADMIN_KEY && qk === ADMIN_KEY))) { setKeyCookie(res, "alto_cs", qk); return res.redirect("/cs"); }
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
    if (d.status === "paused" || d.payStatus === "canceled") attention.push({ slug: c.slug, name: c.name, tag: "pausada", icon: "⏸", msg: "Cuenta pausada — confirma si quiere reactivar", act: "site", c });
    else if (d.payStatus === "failed") attention.push({ slug: c.slug, name: c.name, tag: "pago falló", icon: "💳", msg: "Falló su pago — recuérdale actualizar su tarjeta", act: "site", c });
    else if (d.payStatus === "pending") attention.push({ slug: c.slug, name: c.name, tag: "esperando pago", icon: "⏳", msg: "Aún no activa — se activa sola al pagar", act: "site", c });
    else if (!(s.template || s.about)) attention.push({ slug: c.slug, name: c.name, tag: "falta onboarding", icon: "🆕", msg: "Cliente nuevo sin página — haz su onboarding", act: "edit", c });
    else if (!s.published) attention.push({ slug: c.slug, name: c.name, tag: "sin publicar", icon: "🏗️", msg: "Su página está lista pero no publicada — revísala y publícala", act: "edit", c });
    if (dev >= 4) attention.push({ slug: c.slug, name: c.name, tag: "link compartido", icon: "📱", msg: `${dev} dispositivos — ofrécele cuentas para su equipo`, act: "site", c });
  }
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ALTO Pro · Servicio</title><link rel="icon" href="/icon-192.png"><style>
*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body{background:#F5F6F8;color:#0B1220;letter-spacing:-0.011em}
::selection{background:rgba(248,180,8,.35)}
.appheader{position:sticky;top:0;z-index:30;background:rgba(16,27,48,.9);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);color:#fff;padding:15px 24px;display:flex;align-items:center;gap:13px;border-bottom:1px solid rgba(255,255,255,.07)}
.appheader img{height:30px;background:#fff;border-radius:9px;padding:4px 6px}
.appheader b{font-size:16px;font-weight:700;letter-spacing:-0.02em}.appheader b em{color:#F8B408;font-style:normal}
.appheader .right{margin-left:auto;display:flex;gap:8px}.appheader .right a{color:#cdd5e5;text-decoration:none;font-weight:600;font-size:13px;border-radius:99px;padding:7px 14px}
.wrap{max-width:1120px;margin:0 auto;padding:24px 22px 64px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:18px}
.card{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:18px;padding:18px 20px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 8px 22px rgba(16,27,48,.045)}
.card .v{font-size:28px;font-weight:700;letter-spacing:-0.035em}.card .l{font-size:11px;font-weight:700;color:#9097A3;letter-spacing:.5px;text-transform:uppercase;margin-top:6px}
.card.gold{background:linear-gradient(155deg,#16243f,#0d1729);border:none}.card.gold .v{color:#F8B408}.card.gold .l{color:#9DA8C4}
.panel{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:20px;padding:22px 24px;margin-bottom:18px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 10px 26px rgba(16,27,48,.05)}
.panel h2{font-size:15px;font-weight:700;margin-bottom:14px}
.tform{display:grid;gap:8px;grid-template-columns:1fr;margin-bottom:16px}
@media(min-width:760px){.tform{grid-template-columns:200px 1fr auto}}
.tform select,.tform input{font-family:inherit;padding:11px 13px;border-radius:11px;border:1px solid #E4E7EC;font-size:14px;font-weight:500;outline:none;background:#fff}
.tform select:focus,.tform input:focus{border-color:#F8B408;box-shadow:0 0 0 3px rgba(248,180,8,.18)}
.tform button{background:#F8B408;color:#101B30;border:none;border-radius:11px;padding:11px 20px;font-weight:800;cursor:pointer;white-space:nowrap}
.task{display:flex;gap:12px;align-items:flex-start;padding:13px 0;border-bottom:1px solid #F2F4F7;flex-wrap:wrap}
.task.done{opacity:.55}
.task .tmain{flex:1;min-width:200px}
.task .tt{font-weight:700;font-size:14.5px}
.task.done .tt{text-decoration:line-through}
.task .tc{display:inline-block;margin-left:8px;font-size:12.5px;font-weight:700;color:#B07A00;text-decoration:none}
.task .tn{color:#67718A;font-size:12.5px;font-weight:500;margin-top:3px}
.task .tact{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.tstat{border-radius:99px;padding:3px 10px;font-size:11px;font-weight:800;white-space:nowrap}
.tstat.open{background:#FEF3D6;color:#946400}.tstat.doing{background:#E5EFFE;color:#21438A}.tstat.done{background:#E7F7ED;color:#10803C}
.tbtn{border:1px solid #E4E7EC;background:#fff;border-radius:9px;padding:6px 11px;font-weight:700;font-size:12px;cursor:pointer;text-decoration:none;color:#101B30}
.tbtn.go{background:#101B30;color:#fff;border:none}.tbtn.del{color:#C5221F;border-color:#F3B4B0}
.search{width:100%;font-family:inherit;padding:11px 14px;border-radius:11px;border:1px solid #E4E7EC;font-size:14px;font-weight:500;outline:none;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#9097A3;font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;font-weight:700;padding:9px 8px;border-bottom:1px solid #EEF0F4}
td{padding:11px 8px;border-bottom:1px solid #F2F4F7;font-weight:600;vertical-align:middle}
td a{color:#B07A00;font-weight:700;text-decoration:none}
.edit{background:#F8B408;color:#101B30 !important;border-radius:9px;padding:6px 12px;font-weight:800;font-size:12.5px}
.empty{color:#9097A3;font-weight:600;padding:14px 0}
.card.cardred .v{color:#C5221F}
.att{display:flex;gap:11px;align-items:center;padding:12px 0;border-bottom:1px solid #F2F4F7;flex-wrap:wrap}
.att:last-child{border-bottom:none}
.att .ai{font-size:20px;flex-shrink:0}
.att .am{flex:1;min-width:190px}
.att .am b{font-size:14px}.att .am .x{display:block;color:#67718A;font-size:12.5px;font-weight:500;margin-top:1px}
.att .atag{border-radius:99px;padding:3px 10px;font-size:11px;font-weight:800;background:#FDECEC;color:#C5221F;white-space:nowrap}
.qchips{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 12px}
.qchip{border:1px dashed #C9CDD6;background:#FBFBFD;border-radius:99px;padding:7px 13px;font-size:12.5px;font-weight:700;color:#475067;cursor:pointer}
.qchip:hover{border-color:#F8B408;background:#FFFBEF}
.wa{background:#25D366;color:#fff !important;border-radius:8px;padding:5px 11px;font-weight:800;font-size:12px;text-decoration:none;white-space:nowrap}
.slug2{color:#9097A3;font-size:11.5px}
.guide details{border:1px solid #EEF0F4;border-radius:12px;margin:8px 0;background:#FBFBFD}
.guide summary{cursor:pointer;padding:12px 14px;font-weight:700;font-size:13.5px;list-style:none}
.guide summary::-webkit-details-marker{display:none}
.guide summary::before{content:"▸ ";color:#D99E00}
.guide details[open] summary::before{content:"▾ "}
.guide .gb{padding:0 14px 13px;color:#475067;font-size:12.5px;font-weight:500;line-height:1.7}
.guide .gb ol{margin:6px 0 0 18px}.guide .gb li{margin:3px 0}
</style></head><body>
<div class="appheader">
  <img src="/brand-logo.png" alt=""><b>ALTO <em>PRO</em> · Servicio al cliente</b>
  <div class="right"><a href="/cs?logout">salir</a></div>
</div>
<div class="wrap">
<div class="cards">
  <div class="card ${attention.length ? "cardred" : ""}"><div class="v">${attention.length}</div><div class="l">Necesita atención</div></div>
  <div class="card gold"><div class="v">${openCount}</div><div class="l">Tareas pendientes</div></div>
  <div class="card"><div class="v">${clients.length}</div><div class="l">Clientes</div></div>
  <div class="card"><div class="v">${leads7}</div><div class="l">Leads · 7 días</div></div>
</div>

${attention.length ? `<div class="panel">
  <h2>🚨 Necesita atención <span style="color:#9097A3;font-weight:600;font-size:13px">— trabaja esta lista de arriba a abajo</span></h2>
  ${attention.map((a) => { const wa = waOf(phoneOf(a.c)); const editUrl = `/onboarding?key=${K}&slug=${esc(a.slug)}`; return `<div class="att">
    <span class="ai">${a.icon}</span>
    <div class="am"><b>${esc(a.name)}</b><span class="x">${a.msg}</span></div>
    <span class="atag">${a.tag}</span>
    <a class="tbtn go" href="${editUrl}">✏️ Editar</a>
    <a class="tbtn" href="/site/${esc(a.slug)}" target="_blank">🌐</a>
    ${wa ? `<a class="wa" href="${wa}" target="_blank">💬 WhatsApp</a>` : ""}
  </div>`; }).join("")}
</div>` : `<div class="panel"><h2>🎉 Todo al día</h2><p class="empty" style="padding:4px 0">Nada necesita atención ahora mismo. Buen trabajo.</p></div>`}

<div class="panel">
  <h2>✅ Tareas</h2>
  <div class="qchips">
    <span class="qchip" onclick="quick('Cambiar teléfono')">📞 Cambiar teléfono</span>
    <span class="qchip" onclick="quick('Subir fotos nuevas')">📷 Subir fotos</span>
    <span class="qchip" onclick="quick('Publicar la página')">🚀 Publicar página</span>
    <span class="qchip" onclick="quick('Conectar su dominio')">🌐 Conectar dominio</span>
    <span class="qchip" onclick="quick('Actualizar precios / info')">💲 Actualizar info</span>
  </div>
  <div class="tform">
    <select id="t_slug"><option value="">— sin cliente —</option>${clients.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join("")}</select>
    <input id="t_title" placeholder="¿Qué hay que hacer? (ej. cambiar teléfono, subir fotos)">
    <button onclick="addTask()">+ Agregar tarea</button>
  </div>
  ${tasks.length ? tasks.map((t) => `<div class="task ${t.status}">
    <div class="tmain"><span class="tt">${esc(t.title)}</span>${t.slug ? `<a class="tc" href="/onboarding?key=${K}&slug=${esc(t.slug)}">✏️ ${esc(nameOf(t.slug))}</a>` : `<span class="tc" style="color:#9097A3">general</span>`}${t.note ? `<p class="tn">${esc(t.note)}</p>` : ""}</div>
    <div class="tact">
      <span class="tstat ${t.status}">${stLabel[t.status] || t.status}</span>
      ${t.status === "open" ? `<button class="tbtn" onclick="tStat('${t.id}','doing')">▶ Empezar</button>` : ""}
      ${t.status !== "done" ? `<button class="tbtn go" onclick="tStat('${t.id}','done')">✓ Hecho</button>` : `<button class="tbtn" onclick="tStat('${t.id}','open')">↩ Reabrir</button>`}
      ${t.slug ? `<a class="tbtn" href="/onboarding?key=${K}&slug=${esc(t.slug)}">✏️ Editar</a><a class="tbtn" href="/site/${esc(t.slug)}" target="_blank">🌐</a>` : ""}
      <button class="tbtn del" onclick="tDel('${t.id}')">🗑</button>
    </div>
  </div>`).join("") : `<p class="empty">Sin tareas. Agrega una arriba.</p>`}
</div>

<div class="panel">
  <h2>📋 Clientes</h2>
  <input class="search" id="csearch" placeholder="Buscar cliente…" oninput="filt()">
  <div style="overflow-x:auto"><table id="ctab">
    <tr><th>Negocio</th><th>Leads (7d / total)</th><th>Enlaces</th><th>Editar página</th></tr>
    ${clients.length ? clients.map((c) => {
      const s = statOf(c.id); const wa = waOf(phoneOf(c)); const sd = c.data?.site || {}, dd = c.data || {};
      const pill = dd.status === "paused" ? '<span class="tstat" style="background:#FDECEC;color:#C5221F">pausada</span>'
        : sd.published ? '<span class="tstat done">publicada</span>'
        : (sd.template || sd.about) ? '<span class="tstat open">en construcción</span>'
        : '<span class="tstat" style="background:#F0F2F6;color:#8A94A8">nueva</span>';
      return `<tr data-n="${esc(c.name).toLowerCase()} ${c.slug}">
      <td><b>${esc(c.name)}</b> ${pill}<br><span class="slug2">/${c.slug}</span></td>
      <td>${s.last7} / ${s.total}</td>
      <td><a href="/site/${c.slug}" target="_blank">🌐</a> · <a href="/w/${c.slug}" target="_blank">🛰️</a>${wa ? ` · <a class="wa" href="${wa}" target="_blank">💬</a>` : ""}</td>
      <td><a class="edit" href="/onboarding?key=${K}&slug=${c.slug}">✏️ Editar</a></td>
    </tr>`; }).join("") : `<tr><td colspan="4" class="empty">Todavía no hay clientes.</td></tr>`}
  </table></div>
</div>

<div class="panel guide">
  <h2>📘 Guía rápida — cómo hacer cada cosa</h2>
  <details><summary>El cliente quiere cambiar su info (teléfono, nombre, color, historia)</summary><div class="gb"><ol><li>En "Clientes" o en la tarea, toca <b>✏️ Editar</b>.</li><li>Cambia lo que pide en los pasos.</li><li>En el último paso toca <b>Enviar / Guardar</b> y luego <b>🚀 Publicar página</b>.</li><li>Marca la tarea <b>✓ Hecho</b>.</li></ol></div></details>
  <details><summary>El cliente quiere subir fotos nuevas</summary><div class="gb"><ol><li>Pídele las fotos por <b>💬 WhatsApp</b>.</li><li><b>✏️ Editar</b> → paso <b>Logo y fotos</b> → súbelas.</li><li>Guarda y <b>Publica</b>. Marca <b>Hecho</b>.</li></ol></div></details>
  <details><summary>La página está "en construcción" / sin publicar</summary><div class="gb"><ol><li><b>✏️ Editar</b> y revisa que esté completa.</li><li>En el último paso toca <b>🚀 Publicar página al cliente</b>.</li></ol></div></details>
  <details><summary>El cliente quiere su propio dominio (ej. sutecho.com)</summary><div class="gb"><ol><li><b>✏️ Editar</b> → paso <b>Su dominio</b> → buscar/conectar.</li><li>Pásale el registro <b>CNAME</b> para que lo ponga en su dominio.</li></ol></div></details>
  <details><summary>Dice que su página "no aparece" en Google</summary><div class="gb">Su página ya está en línea (sitio + cotizador). Salir en Google toma tiempo. Confírmale que su link funciona y que ya puede compartirlo por WhatsApp y redes.</div></details>
  <details><summary>Pago falló / cuenta pausada</summary><div class="gb">Recuérdale por <b>💬 WhatsApp</b> actualizar su tarjeta. Cuando pague, la cuenta se reactiva sola. Si pagó por otro medio, avísale al admin.</div></details>
  <details><summary>Aparece "📱 link compartido"</summary><div class="gb">Su cuenta se está abriendo en muchos teléfonos — su equipo la está compartiendo. Ofrécele por <b>💬 WhatsApp</b> cuentas para su equipo (más venta para nosotros).</div></details>
</div>
</div>
<script>
function quick(t){var i=document.getElementById('t_title');i.value=t;document.getElementById('t_slug').focus();}
function addTask(){var s=document.getElementById('t_slug').value,t=document.getElementById('t_title').value.trim();if(!t){document.getElementById('t_title').focus();return;}
  fetch('/api/cs/task?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:s,title:t})}).then(function(r){return r.json()}).then(function(){location.reload()}).catch(function(){alert('Error')});}
function tStat(id,st){fetch('/api/cs/task/'+encodeURIComponent(id)+'?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:st})}).then(function(){location.reload()});}
function tDel(id){if(!confirm('¿Borrar tarea?'))return;fetch('/api/cs/task/'+encodeURIComponent(id)+'?key=${K}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delete:true})}).then(function(){location.reload()});}
function filt(){var q=document.getElementById('csearch').value.toLowerCase();document.querySelectorAll('#ctab tr[data-n]').forEach(function(r){r.style.display=r.getAttribute('data-n').indexOf(q)>=0?'':'none';});}
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
<title>ALTO Pro · Onboarding</title><link rel="icon" href="/icon-192.png"><style>
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0}body{background:#F4F6FA;color:#101B30}
header{background:#101B30;color:#fff;padding:14px 22px;display:flex;align-items:center;gap:12px}
header img{height:32px;background:#fff;border-radius:8px;padding:4px 6px}header b em{color:#F8B408;font-style:normal}
.wrap{max-width:640px;margin:0 auto;padding:24px}
h1{font-size:20px;margin-bottom:6px}.sub{color:#67718A;font-size:14px;font-weight:600;margin-bottom:18px}
.row{display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #E8ECF3;border-radius:14px;padding:14px 16px;margin-bottom:10px}
.row b{font-size:15px}.row small{color:#9AA0AC;display:block;font-weight:600}
.row a{background:#F8B408;color:#101B30;text-decoration:none;font-weight:800;border-radius:10px;padding:9px 16px;font-size:13px}
.empty{color:#8A94A8;font-weight:600;text-align:center;padding:30px}
</style></head><body>
<header><img src="/brand-logo.png" alt=""><b>ALTO <em>PRO</em> · Onboarding</b></header>
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
:root{--navy:#101B30;--navy2:#0B1226;--gold:#F8B408;--mut:#9DA8C4;--line:rgba(255,255,255,.1)}
body{background:var(--navy2);color:#fff;overflow:hidden}
.layout{display:flex;height:100vh;height:100dvh}
aside{width:268px;background:#fff;border-right:1px solid #E9EAEE;display:flex;flex-direction:column;flex-shrink:0}
.sb-brand{display:flex;align-items:center;gap:10px;padding:22px 20px 14px}
.sb-brand img{height:30px;background:#fff;border-radius:8px}
.sb-brand b{color:#101B30;font-weight:800;font-size:15px}.sb-brand b em{color:#D99E00;font-style:normal}
.sb-label{font-size:10px;letter-spacing:2px;color:#9AA0AC;font-weight:800;padding:8px 20px 6px;text-transform:uppercase}
nav{flex:1;overflow-y:auto;padding-bottom:10px;display:flex;flex-direction:column}
.nav-it{flex:1;display:flex;align-items:center;gap:13px;width:100%;background:none;border:none;color:#6A7384;font-weight:700;font-size:15px;padding:0 20px;cursor:pointer;text-align:left;border-left:4px solid transparent;min-height:46px}
.nav-it .no{font-family:'Fraunces',Georgia,serif;font-size:13px;color:#B6BCC8;width:20px;flex-shrink:0}
.nav-it.on{color:#101B30;background:rgba(248,180,8,.13);border-left-color:var(--gold)}
.nav-it.on .no{color:#D99E00}
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
input:focus,textarea:focus{border-color:var(--gold);box-shadow:0 0 0 4px rgba(248,180,8,.18)}
textarea{min-height:96px;resize:vertical;line-height:1.5}
input[type=file]{padding:10px;background:#F7F8FA;font-weight:600}
.hint{color:#67718A;font-size:12px;font-weight:500;margin-top:6px;line-height:1.5}
.btn-dark{background:#101B30;color:#fff;border:none;border-radius:11px;padding:12px 18px;font-weight:800;cursor:pointer}
.colorrow{display:flex;gap:12px;align-items:center;margin-top:6px}
.colorrow input[type=color]{width:54px;height:46px;padding:2px;border-radius:12px;cursor:pointer;border:1px solid #E4E7EC}
.tgrid{display:flex;gap:20px;flex-wrap:wrap;margin-top:6px}
.tpl{cursor:pointer;border-radius:30px;padding:9px;border:2px solid transparent;transition:border-color .15s,background .15s,transform .12s}
.tpl:hover{transform:translateY(-2px)}
.tpl.on{border-color:var(--gold);background:rgba(248,180,8,.1)}
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
.nb-btn.next{background:var(--gold);color:#101B30;border:none;box-shadow:0 8px 20px rgba(248,180,8,.3)}
.nb-btn:disabled{opacity:.35;cursor:default}
.save{width:100%;padding:16px;border:none;border-radius:14px;background:var(--gold);color:#101B30;font-size:16px;font-weight:800;cursor:pointer;box-shadow:0 10px 26px rgba(248,180,8,.35);transition:transform .12s,filter .15s;margin-top:6px}
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
.chip:has(input:checked){border-color:var(--gold);background:#FFFBEF;color:#101B30}
.chip:has(input:checked)::before{content:"✓";color:#D99E00;font-weight:900}
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
  <div class="sb-brand"><img src="/brand-logo.png" alt=""><b>ALTO <em>PRO</em></b></div>
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
  <div class="sb-foot">🌐 ${esc(c.slug)}.alto-pro.com</div>
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
          <div class="wf"><div class="n">03</div><h4>Tu página, lista</h4><p>En 10–14 días, en ${esc(c.slug)}.alto-pro.com o tu propio dominio.</p></div>
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
            <label class="chip"><input type="checkbox" value="Reparación de techos" ${chk("Reparación de techos")}>Reparación</label>
            <label class="chip"><input type="checkbox" value="Techo nuevo / reemplazo" ${chk("Techo nuevo / reemplazo")}>Techo nuevo</label>
            <label class="chip"><input type="checkbox" value="Inspección gratis" ${chk("Inspección gratis")}>Inspección gratis</label>
            <label class="chip"><input type="checkbox" value="Daño por granizo / seguro" ${chk("Daño por granizo / seguro")}>Granizo / seguro</label>
            <label class="chip"><input type="checkbox" value="Techo de metal" ${chk("Techo de metal")}>Metal</label>
            <label class="chip"><input type="checkbox" value="Shingle / asfalto" ${chk("Shingle / asfalto")}>Shingle</label>
            <label class="chip"><input type="checkbox" value="Teja" ${chk("Teja")}>Teja</label>
            <label class="chip"><input type="checkbox" value="Emergencias 24/7" ${chk("Emergencias 24/7")}>Emergencias 24/7</label>
            <label class="chip"><input type="checkbox" value="Financiamiento" ${chk("Financiamiento")}>Financiamiento</label>
          </div>
          <label>Garantía que ofrece</label><input id="warranty" value="${v(st.warranty)}" placeholder="Ej. 10 años por escrito en mano de obra">
          <label>¿Qué los hace diferentes? (opcional)</label><input id="diff" value="${v(st.diff)}" placeholder="Ej. familia local, mismo dueño en cada trabajo">
          <label>Licencia / seguro (opcional)</label><input id="license" value="${v(p.license)}" placeholder="RCAT-12345 · asegurado">
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
            <div class="wbar"><span class="wdot"></span><span class="wdot"></span><span class="wdot"></span><span class="wurl">${esc(c.slug)}.alto-pro.com</span></div>
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
          <textarea id="rough" class="big" placeholder="¿Cómo empezó? ¿Cuántos techos han hecho? ¿Qué los hace diferentes? ¿Su garantía? Puedes hablar con el micrófono — no tiene que estar bonito, la IA lo acomoda."></textarea>
          <div class="microw" style="margin-top:8px">
            <button type="button" id="aibtn" onclick="aiWrite()" class="btn-dark">✨ Escribir con IA</button>
            <button type="button" class="micbtn" onclick="dictate('rough',this)" title="Hablar en vez de escribir">🎤</button>
            <span class="hint" id="aihint" style="align-self:center"></span>
          </div>
          <hr style="border:none;border-top:1px solid #EDF0F5;margin:18px 0">
          <label>Titular (opcional)</label><input id="hero" value="${v(st.hero)}" placeholder="Déjalo vacío para usar el de la plantilla">
          <label>Frase corta</label><input id="tagline" value="${v(st.tagline)}" placeholder="Techos con garantía por escrito en toda la región.">
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
        <h1>Su propio <em>dominio.</em> <small>Opcional — su página ya vive en ${esc(c.slug)}.alto-pro.com</small></h1>
        <div class="fcard">
          <label>Buscar un dominio disponible</label>
          <div style="display:flex;gap:8px"><input id="dsearch" placeholder="Nombre del negocio o dominio" style="flex:1" onkeydown="if(event.key==='Enter'){event.preventDefault();checkDomain();}"><button type="button" onclick="checkDomain()" id="dsbtn" class="btn-dark" style="white-space:nowrap;background:var(--gold);color:#101B30">Buscar</button></div>
          <div id="dresults" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px"></div>
          <p class="hint" id="dsearchhint" style="margin-top:4px"></p>
          <hr style="border:none;border-top:1px solid #EDF0F5;margin:14px 0">
          <label>Dominio del cliente (conectar)</label>
          <div style="display:flex;gap:8px"><input id="domain" value="${v(st.domain)}" placeholder="mirandaroofing.com" style="flex:1"><button type="button" onclick="connectDomain()" id="dombtn" class="btn-dark" style="white-space:nowrap">Conectar</button></div>
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
    years:document.getElementById('years').value,rough:rough
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
    b.rough ? `Notas del contratista: ${b.rough}` : "",
  ].filter(Boolean).join("\n").slice(0, 1000);
  if (!facts) return res.status(400).json({ error: "faltan datos" });
  if (!aiLive) return res.json({ source: "demo", error: "ai_off" });
  try {
    const raw = await aiChat({
      maxTokens: 400,
      system: `Eres redactor publicitario de una compañía de techos (roofing) hispana en Texas. Con los datos que te doy, escribe el texto de su página web en español, cálido y confiable, sin exagerar ni inventar datos que no te dieron. Responde SOLO con un objeto JSON: {"hero": titular corto y fuerte (máx 6 palabras), "tagline": una frase de apoyo (máx 18 palabras), "about": párrafo de "nuestra historia" en 2-3 oraciones, en primera persona del negocio}. Nada de markdown, nada de comillas tipográficas.`,
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
  variations.push(base.includes("roofing") ? base + "tx.com" : base + "roofing.com");
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
  if (domain.endsWith(".alto-pro.com")) return res.status(400).json({ error: "ese es un subdominio nuestro, no un dominio propio" });
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
<title>ALTO Pro · Equipo</title><link rel="icon" href="/icon-192.png"><style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;0,9..144,700;1,9..144,600&family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0;-webkit-tap-highlight-color:transparent}
:root{--navy:#101B30;--navy2:#0B1226;--gold:#F8B408;--mut:#9DA8C4;--line:rgba(255,255,255,.1)}
body{background:var(--navy2);color:#fff;overflow:hidden}
.layout{display:flex;height:100vh;height:100dvh}
aside{width:260px;background:#fff;border-right:1px solid #E9EAEE;display:flex;flex-direction:column;flex-shrink:0}
.sb-brand{display:flex;justify-content:center;padding:24px 18px 14px}.sb-brand img{height:54px}
.sb-label{font-size:10px;letter-spacing:2.5px;color:#9AA0AC;font-weight:800;padding:8px 18px 6px}
nav{flex:1;overflow-y:auto;display:flex;flex-direction:column}
.nav-it{flex:1;display:flex;align-items:center;gap:12px;background:none;border:none;color:#6A7384;font-weight:700;font-size:14.5px;padding:0 20px;cursor:pointer;text-align:left;border-left:4px solid transparent;min-height:42px}
.nav-it .no{font-family:'Fraunces',Georgia,serif;font-size:12px;color:#B6BCC8;width:20px}
.nav-it.on{color:#101B30;background:rgba(248,180,8,.13);border-left-color:var(--gold)}
.nav-it.on .no{color:#D99E00}
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
<aside id="sb"><div class="sb-brand"><img src="/brand-logo.png" alt=""></div><div class="sb-label">ALTO PRO</div><nav id="nav"></nav><div class="sb-foot">Presentación del rol</div></aside>
<div class="scrim" id="scrim" onclick="sb(false)"></div>
<main>
<div class="mtop"><button onclick="sb(true)">☰ Menú</button><b style="font-weight:800">ALTO <span style="color:#F8B408">PRO</span></b><span style="width:64px"></span></div>
<div class="stage" id="stage">

<section class="slide" data-t="El rol">
  <img class="s-bg" src="/api/roofimg?lat=26.3828&lng=-98.8198&zoom=17" alt=""><div class="s-veil"></div>
  <div class="s-in">
    <p class="kick">ALTO PRO · MARKETING Y TECNOLOGÍA PARA ROFEROS</p>
    <h1>Dos trabajos, <em>un solo rol.</em></h1>
    <div class="rule"></div>
    <p class="body">El rol combina dos cosas: <b style="color:#fff">cerrar ventas</b> y <b style="color:#fff">crear el contenido</b> que trae esos clientes. En esta presentación vas a ver, en vivo, los productos que venderías y grabarías.</p>
  </div>
</section>

<section class="slide" data-t="A quién le vendes">
  <div class="s-veil"></div>
  <div class="s-in">
    <p class="kick">01 · A QUIÉN LE VENDES</p>
    <h1>Contratistas hispanos <em>de techos.</em></h1>
    <div class="rule"></div>
    <ul class="pts">
      <li><b>🇲🇽</b> Hablan español, trabajan con las manos, odian la tecnología complicada</li>
      <li><b>📞</b> Consiguen trabajo por recomendación — pero pierden llamadas cuando están en un techo</li>
      <li><b>💵</b> Un techo les deja $2,000–$4,000 de ganancia — tienen con qué pagar</li>
      <li><b>🎯</b> Empezamos SOLO con roferos — enfocados</li>
    </ul>
    <p class="body" style="margin-top:16px"><b style="color:var(--gold)">Háblales como un amigo que entiende su negocio — no como vendedor de tecnología.</b></p>
  </div>
</section>

<section class="slide" data-t="Qué vendemos">
  <div class="s-veil"></div>
  <div class="s-in">
    <p class="kick">02 · QUÉ VENDEMOS</p>
    <h1>Una máquina que <em>trae trabajos.</em></h1>
    <div class="rule"></div>
    <div class="grid">
      <div class="card"><div class="ic">🌐</div><h3>Página web</h3><p>Profesional, con su marca. Lista en 10-14 días.</p></div>
      <div class="card"><div class="ic">🛰️</div><h3>Cotizador satelital</h3><p>El cliente pone su dirección y ve su precio en 60 seg.</p></div>
      <div class="card"><div class="ic">📲</div><h3>La app ALTO Pro</h3><p>Mide techos, hace facturas, recibe los leads.</p></div>
      <div class="card"><div class="ic">🤖</div><h3>Secretaria IA</h3><p>Contesta y agenda citas a cualquier hora.</p></div>
    </div>
    <div class="glass"><div><b>$297</b><span>para empezar</span></div><div><b>$297</b><span>al mes</span></div></div>
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

<section class="slide" data-t="El cotizador (wow)">
  <div class="s-veil"></div>
  <div class="s-in" style="max-width:1000px">
    <p class="kick">04 · EL COTIZADOR · EL WOW</p>
    <h1>Pon una <em>dirección.</em></h1>
    <div class="duo">
      <div>
        <p class="body">El momento "wow" de toda la venta. Escribe una dirección real y mira cómo el satélite mide el techo y da un precio. ESTO es lo que grabas para los anuncios.</p>
        <a class="link" href="/demo" target="_blank">Ver la presentación de venta →</a>
      </div>
      <div class="frame"><iframe data-src="/w/alto-demo" title="Cotizador"></iframe></div>
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
          <li><b>🛰️</b> Mide techos: dirección, GPS, o con el dedo</li>
          <li><b>📥</b> Los leads le llegan con botón de WhatsApp</li>
          <li><b>🧾</b> Cotizaciones y facturas con su marca</li>
        </ul>
        <p class="body" style="font-size:14px;margin-top:14px">👉 La app de la derecha está EN VIVO — tócala.</p>
      </div>
      <div class="iphone"><div class="inotch"></div><div class="mscr"><iframe data-src="/?demo=roof" title="App"></iframe></div></div>
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
      <li><b>3</b> En vivo pones SU dirección y le mides SU techo — ahí cambia todo</li>
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
    <p class="body">Corremos anuncios en WhatsApp e Instagram/Facebook, en español, para roferos. Tu contenido es el motor del negocio.</p>
    <div class="grid">
      <div class="card"><div class="ic">🎬</div><h3>Anuncios cortos (9:16)</h3><p>15-40 seg para WhatsApp/Reels. Hook fuerte en los primeros 3 seg.</p></div>
      <div class="card"><div class="ic">🎥</div><h3>VSL (1-2 min)</h3><p>Video para la página explicando la oferta — tú a cámara, directo.</p></div>
      <div class="card"><div class="ic">📱</div><h3>Grabación de pantalla</h3><p>Midiendo un techo en 60 seg — el wow en video.</p></div>
      <div class="card"><div class="ic">📸</div><h3>Fotos del equipo</h3><p>Tú y el equipo con la camisa ALTO en un techo real.</p></div>
    </div>
  </div>
</section>

<section class="slide" data-t="Lista de contenido">
  <div class="s-veil"></div>
  <div class="s-in" style="max-width:1000px">
    <p class="kick">08 · TUS PRIMEROS VIDEOS</p>
    <h1>Lista para <em>grabar ya.</em></h1>
    <ul class="pts">
      <li><b>🎯</b> "¿Cuántos trabajos pierdes mientras estás arriba de un techo?" — hook de dolor, a cámara</li>
      <li><b>🛰️</b> "Mira cómo cotizo un techo en 60 segundos sin subirme" — grabación de pantalla</li>
      <li><b>💬</b> "Tus clientes te llegan directo al WhatsApp" — muestra el lead llegando</li>
      <li><b>🌐</b> "Tu página web vende sola, 24/7" — muestra la página de ejemplo</li>
      <li><b>🤖</b> "Una secretaria con IA que nunca duerme" — muestra el chat contestando</li>
    </ul>
    <p class="body" style="margin-top:12px">Regla de oro: <b style="color:#fff">habla como rofero, no como tecnología.</b></p>
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
      <li><b>3</b> Agenda la foto del equipo con la camisa ALTO</li>
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
  const note = String(b.note || b.message || "Vino de WhatsApp").slice(0, 500);
  if (!name && !phone) return res.status(400).json({ error: "missing name/phone" });
  // de-dupe: same phone logged in the last 10 minutes → don't create a twin
  try {
    const recent = await db.listMeetings(40);
    const cutoff = Date.now() - 10 * 60 * 1000;
    const dup = recent.find((m) => {
      const mp = String(m.phone || "").replace(/\D/g, "");
      return phone && mp === phone && new Date(m.created_at).getTime() > cutoff;
    });
    if (dup) return res.json({ ok: true, deduped: true, id: dup.id });
  } catch { /* if the lookup fails, fall through and just create it */ }
  const id = await db.addMeeting({ name, phone, note });
  res.json({ ok: true, id });
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
    ? { payStatus: "ok", ...(paid.customerId ? { stripeCustomer: paid.customerId } : {}) }
    : { payStatus: "pending" };
  await db.saveContractorData(c.id, cData);
  const invite = await db.createInvite(c.id);
  const base = canonBase(req);
  const K = encodeURIComponent(String(req.query.key || req.body?.key || ""));
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cliente creado</title>
<style>body{font-family:Arial;max-width:560px;margin:40px auto;padding:0 16px;color:#101B30}h2{margin-bottom:6px}
.link{background:#FEF5DC;border:2px solid #F8B408;border-radius:12px;padding:13px;word-break:break-all;font-size:14px;margin:10px 0;display:flex;gap:10px;align-items:center}
.link button{margin-left:auto;background:#F8B408;color:#101B30;border:none;border-radius:8px;padding:8px 14px;font-weight:800;cursor:pointer;flex-shrink:0}
a{color:#B57E00;font-weight:800}small{color:#67718A}</style></head><body>
<h2>✓ Cliente creado: ${String(c.name).replace(/</g, "&lt;")}</h2>
${paid
  ? `<p style="background:#EAF8EF;border:1.5px solid #34A853;color:#1E7B3C;border-radius:12px;padding:10px 14px;font-weight:700">✅ Pago confirmado — la cuenta está ACTIVA.</p>`
  : `<p style="background:#FEF5DC;border:1.5px solid #F8B408;color:#7A5A00;border-radius:12px;padding:10px 14px;font-weight:700">⏳ El link de acceso se ACTIVA solo cuando Stripe confirme su pago (≈1 min después de pagar). Si pagó por otro medio, el admin la activa desde su tablero.</p>`}
<p><b>1.</b> Copia su <b>link de acceso</b> y pégalo en el mensaje de bienvenida (tecla B en la presentación):</p>
<div class="link"><span><b>🔑 Acceso a su app</b><br><small>${base}/invite/${invite}</small></span><button onclick="navigator.clipboard.writeText('${base}/invite/${invite}');this.textContent='✓'">Copiar</button></div>
<p><b>2.</b> Su cotizador (va dentro de su página web):</p>
<div class="link"><span><b>🛰️ Widget</b><br><small>${base}/w/${c.slug}</small></span><button onclick="navigator.clipboard.writeText('${base}/w/${c.slug}');this.textContent='✓'">Copiar</button></div>
<p><b>3.</b> Personaliza su página web (plantilla, color, fotos):</p>
<div class="link"><span><b>🎨 Onboarding de su página</b></span><a href="/onboarding?key=${K}&slug=${c.slug}" style="margin-left:auto;background:#F8B408;color:#101B30;border-radius:8px;padding:8px 14px;font-weight:800;text-decoration:none">Abrir →</a></div>
<a href="/closer?key=${K}">← Volver al portal del closer</a></body></html>`);
});

/* ── Closer portal (/closer) — crear cliente nuevo + toolkit, nothing else ── */
app.get("/closer", async (req, res) => {
  if (!CLOSER_KEY && !ADMIN_KEY) return res.status(503).send("Set CLOSER_KEY env var to enable.");
  if (req.query.logout != null) { clearKeyCookie(res, "alto_closer"); return res.redirect("/closer"); }
  const qk = req.query.key;
  if (qk && ((CLOSER_KEY && qk === CLOSER_KEY) || (ADMIN_KEY && qk === ADMIN_KEY))) {
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
  const wMsg = en
    ? `Check this out 👀 — type your address and see what your customers would see on YOUR website:\n${base}/w/alto-demo`
    : `Mira esto 👀 — escribe tu dirección y ve lo que tus clientes verían en TU página web:\n${base}/w/alto-demo`;
  const welcome = en
    ? `Congratulations and welcome to ALTO Pro! 🎉 Tap this link from your phone and save it — it's your personal key to your app: [PASTE THEIR ACCESS LINK HERE]. You can measure roofs and quote starting today. See you at your onboarding call 💪`
    : `¡Felicidades y bienvenido a ALTO Pro! 🎉 Toca este link desde tu teléfono y guárdalo — es tu llave personal a tu app: [PEGA AQUÍ SU LINK DE ACCESO]. Hoy mismo puedes medir techos y cotizar. Nos vemos en tu llamada de onboarding 💪`;
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
    payT: "💳 Payment link — $297 today + $297/mo", payMissing: "Not configured yet (STRIPE_PAYMENT_LINK in Render).",
    welT: "👋 Welcome (paste their access link)", demoT: "🛰️ Quote tool demo", demoMsgT: "👀 Demo message",
    open: "Open", copy: "Copy",
    scriptT: "🎤 Talk track — what you say on each slide",
    script: [
      ["01 · Welcome", "“Thanks for booking. In 10 minutes you'll see your own roof measured by satellite. If it's not for you, no problem. Sound good?”"],
      ["02 · Who we are", "“Before I show you anything: the owner is a contractor. He builds houses in Texas. He built this tool for himself — and uses it today for his own company. We're not an agency reselling software.”"],
      ["03 · The problem", "“Quick question: how many calls do you miss when you're up on a roof? … Most customers go with whoever answers first. You don't lack work — you lack a system that works when you can't.”"],
      ["04 · Your website", "“This is what YOUR site would look like — phone and computer. Now the good part: type YOUR address in the quote tool. (wait for the wow — say nothing) That feeling? That's what your customers will feel.”"],
      ["05 · Your app", "“This app is your office. The one on the right is LIVE — tap MEASURE ROOF. Every lead hits your phone with WhatsApp ready. Neighbor asks how much? You measure it standing right there.”"],
      ["06 · AI secretary", "“Text it like you're a customer with a leak. (let them try) This same AI answers YOUR customers at 11pm and books the appointment. You just show up.”"],
      ["07 · Investment", "“Separately this runs $1,500 plus monthlies. With us: 297 a month, 297 to start. One average roof leaves you $2,000–$4,000 — ONE extra job pays your whole year. (silence — let them talk first)”"],
      ["08 · Let's begin", "“This starts today: you pay, I send your app by WhatsApp before we hang up, and we book your onboarding. Want me to send the payment link?”"],
    ],
    keysT: "⌨️ Secret shortcuts in the presentation (/demo)",
    keys: ["<b>Double-click the counter</b> or press <b>C</b> → closer panel", "<b>P</b> payment link · <b>B</b> welcome · <b>D</b> demo message · <b>O</b> open checkout"],
    keysWarn: "⚠️ If you share your FULL SCREEN, the Stripe tab is visible. Share only the /demo tab.",
    objT: "Objections & comebacks",
    obj: [
      ["\"It's expensive\"", "“An average roof leaves you $2,000–$4,000 profit. ONE extra job a year and this paid for itself.”"],
      ["\"I already have a website\"", "“Does it put customers' phone numbers in your pocket with their roof already quoted? Your current site is the business card; this one sells.”"],
      ["\"Let me think about it\"", "“What do you want to think over — the price, or whether it works? (resolve it). I'll hold today's price for you.”"],
      ["\"I need to talk to my wife/partner\"", "“Perfect. Let's book 10 minutes tomorrow with both of you and I'll show them the same demo. What time works?”"],
      ["\"My clients come from referrals\"", "“And what do people do with a referral? They Google you before calling. This turns your referrals into appointments.”"],
      ["\"I'm not good with technology\"", "“If you can send a WhatsApp, you can use ALTO. We do the onboarding with you, step by step.”"],
      ["\"What if it doesn't work for me?\"", "“No long contracts: cancel anytime and your domain leaves with you — it's in the contract.”"],
      ["\"It's slow season / no money right now\"", "“That's exactly why: your site gets built NOW so you're positioned when the season hits. Building it mid-season is too late.”"],
      ["\"I already have a marketing agency\"", "“We don't compete with them — we give them somewhere to send people. Does their website quote roofs by itself?”"],
      ["\"Why so cheap?\"", "“It's software we already built — we don't bill agency hours. We win when you stay for months.”"],
      ["\"Internet leads are garbage\"", "“Bought leads, yes. These typed THEIR address and THEIR phone to price THEIR roof. It doesn't get warmer than that.”"],
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
    payT: "💳 Link de pago — $297 hoy + $297/mes", payMissing: "Aún no configurado (STRIPE_PAYMENT_LINK en Render).",
    welT: "👋 Bienvenida (pega su link de acceso)", demoT: "🛰️ Demo del cotizador", demoMsgT: "👀 Mensaje de demo",
    open: "Abrir", copy: "Copiar",
    scriptT: "🎤 Guion — qué dices en cada slide",
    script: [
      ["01 · Bienvenida", "“Gracias por agendar. En 10 minutos vas a ver tu propio techo medido por satélite. Si no es para ti, no pasa nada. ¿Te parece?”"],
      ["02 · Quiénes somos", "“Antes de enseñarte nada: el dueño es contratista. Construye casas en Texas. Esta herramienta la hizo para él mismo — y hoy la usa para su propia compañía. No somos una agencia revendiendo software.”"],
      ["03 · El problema", "“Te pregunto algo: ¿cuántas llamadas pierdes cuando estás arriba del techo? … La mayoría se queda con el primero que contesta. No te falta trabajo — te falta un sistema que trabaje cuando tú no puedes.”"],
      ["04 · Tu página", "“Así se vería TU página — en celular y computadora. Ahora lo bueno: pon TU dirección en el cotizador. (espera el wow — no digas nada) ¿Eso que sentiste? Eso van a sentir tus clientes.”"],
      ["05 · Tu app", "“Esta app es tu oficina. La de la derecha está VIVA — toca MEDIR TECHO. Cada lead te llega con WhatsApp listo. ¿El vecino te pregunta cuánto? Lo mides ahí parado.”"],
      ["06 · Secretaria IA", "“Escríbele como si fueras un cliente con gotera. (déjalo probar) Esta misma IA le contesta a TUS clientes a las 11 de la noche y agenda la cita. Tú solo llegas.”"],
      ["07 · Inversión", "“Por separado esto cuesta $1,500 más mensualidades. Con nosotros: 297 al mes y 297 para empezar. Un techo promedio te deja $2,000–$4,000 — UN trabajo extra paga tu año entero. (silencio — deja que hable él primero)”"],
      ["08 · Empecemos", "“Esto empieza hoy: pagas, te mando tu app por WhatsApp antes de colgar, y agendamos tu onboarding. ¿Te mando el link de pago?”"],
    ],
    keysT: "⌨️ Atajos secretos en la presentación (/demo)",
    keys: ["<b>Doble clic en el contador</b> o tecla <b>C</b> → panel del closer", "<b>P</b> link de pago · <b>B</b> bienvenida · <b>D</b> mensaje demo · <b>O</b> abrir el pago"],
    keysWarn: "⚠️ Si compartes la PANTALLA completa, la pestaña de Stripe se ve. Comparte solo la pestaña de /demo.",
    objT: "Objeciones y cómo regresar",
    obj: [
      ["\"Está caro\"", "“Un techo promedio te deja $2,000–$4,000 de ganancia. Con UN trabajo extra al año, esto ya se pagó.”"],
      ["\"Ya tengo página\"", "“¿Y te manda los teléfonos de los clientes al bolsillo, con su techo ya cotizado? Tu página de hoy es la tarjeta; esta es la que vende.”"],
      ["\"Déjame pensarlo\"", "“¿Qué quieres pensar — el precio, o si funciona? (resuélvelo). Te aparto el precio de hoy.”"],
      ["\"Lo hablo con mi esposa/socio\"", "“Perfecto. Agendemos 10 minutos mañana con los dos y les enseño la misma demo. ¿A qué hora pueden?”"],
      ["\"Mis clientes llegan por recomendación\"", "“¿Y qué hace la gente cuando le recomiendan a alguien? Lo busca en Google antes de llamar. Esto convierte tus recomendaciones en citas.”"],
      ["\"No soy bueno con la tecnología\"", "“Si sabes mandar un WhatsApp, sabes usar ALTO. El onboarding lo hacemos contigo, paso a paso.”"],
      ["\"¿Y si no me funciona?\"", "“Sin contratos largos: cancelas cuando quieras y tu dominio se va contigo — está en el contrato.”"],
      ["\"Es temporada baja / no hay dinero\"", "“Justo por eso: tu página se construye AHORA para que cuando venga la temporada ya estés posicionado. Montarla en plena temporada es llegar tarde.”"],
      ["\"Ya tengo agencia de marketing\"", "“No competimos con ella — le damos a dónde mandar a la gente. ¿Su página cotiza techos sola?”"],
      ["\"¿Por qué tan barato?\"", "“Es software que ya construimos — no cobramos horas de agencia. Ganamos cuando te quedas meses.”"],
      ["\"Los leads de internet son basura\"", "“Los comprados, sí. Estos pusieron SU dirección y SU teléfono para ver el precio de SU techo. Más caliente no existe.”"],
    ],
  };
  res.send(`<!doctype html><html lang="${en ? "en" : "es"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ALTO Pro · ${L.title}</title><link rel="icon" href="/icon-192.png"><style>
*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
html{background:#F5F6F8}
body{max-width:680px;margin:0 auto;padding:34px 20px 72px;color:#0B1220;line-height:1.55;letter-spacing:-0.011em}
::selection{background:rgba(248,180,8,.35)}
h1{font-size:26px;font-weight:700;letter-spacing:-0.025em;margin-bottom:18px}
h1 span{color:#D99E00}
h2{font-size:12.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#9097A3;margin:34px 0 12px}
.lang{position:fixed;top:14px;right:16px;background:rgba(16,27,48,.9);backdrop-filter:saturate(180%) blur(14px);-webkit-backdrop-filter:saturate(180%) blur(14px);color:#fff;border-radius:99px;padding:9px 17px;font-weight:700;font-size:13px;text-decoration:none;box-shadow:0 6px 18px rgba(16,27,48,.25)}
.warn{background:#FFF4F4;border:1px solid #F6D5D5;color:#B42318;border-radius:16px;padding:14px 16px;font-weight:600;font-size:13.5px;box-shadow:0 1px 2px rgba(180,35,24,.05)}
.alta{display:flex;gap:10px;flex-wrap:wrap;background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:20px;padding:18px;box-shadow:0 1px 2px rgba(16,27,48,.04),0 12px 30px rgba(16,27,48,.05)}
.alta input{flex:1;min-width:150px;font-family:inherit;padding:13px 15px;border-radius:13px;border:1px solid #E4E7EC;font-size:14.5px;font-weight:500;outline:none;transition:border-color .15s,box-shadow .15s}
.alta input:focus{border-color:#F8B408;box-shadow:0 0 0 4px rgba(248,180,8,.18)}
.alta button{background:#F8B408;color:#101B30;border:none;border-radius:13px;padding:13px 24px;font-weight:700;cursor:pointer;font-size:14.5px;box-shadow:0 6px 16px rgba(248,180,8,.3);transition:transform .12s,filter .15s}
.alta button:hover{filter:brightness(1.03)}.alta button:active{transform:scale(.97)}
ol{padding-left:22px;margin-top:4px}ol li{margin-bottom:10px;font-weight:500;color:#1B2433}
ul{padding-left:22px}ul li{margin-bottom:7px;font-weight:500;color:#1B2433}
small{color:#9097A3}
.sc{background:#fff;border:1px solid rgba(16,27,48,.05);border-left:3px solid #F8B408;border-radius:16px;padding:16px 18px;margin:10px 0;box-shadow:0 1px 2px rgba(16,27,48,.04),0 8px 22px rgba(16,27,48,.045)}
.sc b{display:block;font-size:11px;color:#B07A00;letter-spacing:.8px;text-transform:uppercase;margin-bottom:6px;font-weight:700}
.sc p{font-size:15px;font-style:italic;color:#1B2433;line-height:1.6}
.link{background:#fff;border:1px solid rgba(16,27,48,.06);border-radius:16px;padding:13px 16px;word-break:break-all;font-size:14px;margin:9px 0;display:flex;gap:10px;align-items:center;box-shadow:0 1px 2px rgba(16,27,48,.04),0 8px 22px rgba(16,27,48,.04);transition:box-shadow .18s,transform .18s}
.link:hover{transform:translateY(-1px);box-shadow:0 2px 4px rgba(16,27,48,.06),0 14px 32px rgba(16,27,48,.08)}
.link>span{flex:1;min-width:0}
.link b{font-weight:700}
.link small{color:#9097A3}
.link button{background:#F8B408;color:#101B30;border:none;border-radius:11px;padding:9px 15px;font-weight:700;cursor:pointer;flex-shrink:0;font-size:13px;transition:filter .15s}
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
.navbtn.primary{background:#F8B408;border:none;box-shadow:0 6px 18px rgba(248,180,8,.35)}
.cols{display:grid;gap:24px}
.col>h2:first-child{margin-top:6px}
body{max-width:none;margin:0;padding:0}
.appheader{position:sticky;top:0;z-index:30;background:rgba(16,27,48,.9);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);color:#fff;padding:15px 24px;display:flex;align-items:center;gap:13px;border-bottom:1px solid rgba(255,255,255,.07)}
.appheader img{height:30px;background:#fff;border-radius:9px;padding:4px 6px}
.appheader b{font-size:16px;font-weight:700;letter-spacing:-0.02em}.appheader b em{color:#F8B408;font-style:normal}
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
.card.gold .v{color:#F8B408}.card.gold .l{color:#9DA8C4}
.panel{background:#fff;border:1px solid rgba(16,27,48,.05);border-radius:22px;padding:22px 24px;margin:18px 0;box-shadow:0 1px 2px rgba(16,27,48,.04),0 12px 30px rgba(16,27,48,.05)}
.panel>h3{font-size:13px;color:#9097A3;letter-spacing:.6px;text-transform:uppercase;font-weight:700;margin-bottom:14px}
.mform{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.mform input{flex:1;min-width:140px;font-family:inherit;padding:12px 14px;border-radius:12px;border:1px solid #E4E7EC;font-size:14px;font-weight:500;outline:none;transition:border-color .15s,box-shadow .15s}
.mform input:focus{border-color:#F8B408;box-shadow:0 0 0 4px rgba(248,180,8,.18)}
.mform button{background:#101B30;color:#fff;border:none;border-radius:12px;padding:12px 20px;font-weight:700;cursor:pointer;font-size:14px}
.mrow{display:flex;align-items:center;gap:9px;padding:11px 0;border-bottom:1px solid #F2F4F7;font-size:14px;font-weight:600;flex-wrap:wrap}
.mrow:last-child{border-bottom:none}
.mrow .nm{flex:1;min-width:120px}
.mrow .nm small{color:#9097A3;font-weight:500}
.mbtn{border:none;border-radius:9px;padding:7px 11px;font-weight:700;font-size:12px;cursor:pointer}
.mbtn.show{background:#E7F7ED;color:#10803C}.mbtn.no{background:#FDECEC;color:#C5221F}.mbtn.win{background:#F8B408;color:#101B30}
.mtag{border-radius:99px;padding:4px 11px;font-size:11px;font-weight:700;white-space:nowrap}
.mtag.showed{background:#E7F7ED;color:#10803C}.mtag.no_show{background:#FDECEC;color:#C5221F}.mtag.closed{background:#FEF3D6;color:#946400}.mtag.scheduled{background:#F0F2F6;color:#8A94A8}
.mnote{flex-basis:100%;font-family:inherit;margin-top:4px;padding:9px 12px;border-radius:10px;border:1px solid #E4E7EC;font-size:13px;font-weight:500;color:#1B2433;outline:none;transition:border-color .2s,box-shadow .15s}
.mnote::placeholder{color:#B6BCC8;font-weight:500}
.mnote:focus{border-color:#F8B408;box-shadow:0 0 0 3px rgba(248,180,8,.16)}
.periodbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:2px 0 16px}
.segs{display:inline-flex;background:#EEF0F4;border-radius:12px;padding:3px;gap:2px}
.seg{padding:8px 15px;border-radius:9px;font-size:13px;font-weight:700;color:#5A6475;text-decoration:none;white-space:nowrap}
.seg.on{background:#fff;color:#101B30;box-shadow:0 1px 3px rgba(16,27,48,.12)}
.segcustom{display:inline-flex;gap:7px;align-items:center}
.segcustom input{font-family:inherit;padding:8px 10px;border-radius:10px;border:1px solid #E4E7EC;font-size:13px;font-weight:600;color:#1B2433;outline:none}
.segcustom input:focus{border-color:#F8B408;box-shadow:0 0 0 3px rgba(248,180,8,.18)}
.segcustom button{background:#101B30;color:#fff;border:none;border-radius:10px;padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer}
.segcustom button.on{background:#F8B408;color:#101B30}
.plabel{font-size:12.5px;font-weight:700;color:#9097A3}
@media(min-width:920px){.cols{grid-template-columns:1fr 1fr;align-items:start}}
</style></head><body>
<div class="appheader">
  <img src="/brand-logo.png" alt="">
  <b>ALTO <em>PRO</em> · ${en ? "Closer" : "Closer"}</b>
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
  <a class="navbtn" href="/w/alto-demo" target="_blank">🛰️ ${en ? "Quote demo" : "Demo del cotizador"}</a>
  <a class="navbtn" href="/ejemplo" target="_blank">🏠 ${en ? "Example site" : "Página de ejemplo"}</a>
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
    ${stripeLink
      ? `<div class="link"><span><b>${L.payT}</b><br><small>${esc(stripeLink)}</small></span><a href="${stripeLink}" target="_blank" rel="noreferrer" style="background:#101B30;color:#fff;border-radius:11px;padding:9px 15px;font-weight:700;text-decoration:none;flex-shrink:0;font-size:13px">${L.open}</a><button onclick="cp(this,'${stripeLink}')">${L.copy}</button></div>`
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
app.get("/cierre", (req, res) => {
  const base = canonBase(req);
  const stripeLink = process.env.STRIPE_PAYMENT_LINK || "";
  const wMsg = `Mira esto 👀 — escribe tu dirección y ve lo que tus clientes verían en TU página web:\n${base}/w/alto-demo`;
  const welcome = `¡Felicidades y bienvenido a ALTO Pro! 🎉 Toca este link desde tu teléfono y guárdalo — es tu llave personal a tu app: [PEGA AQUÍ SU LINK DE ACCESO]. Hoy mismo puedes medir techos y cotizar. Nos vemos en tu llamada de onboarding 💪`;
  const esc = (s) => String(s).replace(/</g, "&lt;");
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ALTO Pro · Cierre (privado)</title><style>
body{font-family:Arial;max-width:640px;margin:30px auto;padding:0 18px;color:#101B30;line-height:1.55}
h1{font-size:22px}h2{font-size:16px;margin-top:24px}
.warn{background:#FDECEC;border:1.5px solid #D93025;color:#9B1C10;border-radius:12px;padding:10px 14px;font-weight:700;font-size:13px}
.link{background:#FEF5DC;border:2px solid #F8B408;border-radius:12px;padding:12px;word-break:break-all;font-size:14px;margin:8px 0;display:flex;gap:10px;align-items:center}
.link button{margin-left:auto;background:#F8B408;color:#101B30;border:none;border-radius:8px;padding:8px 14px;font-weight:800;cursor:pointer;flex-shrink:0}
.link small{color:#67718A}
ol li{margin-bottom:10px}small{color:#67718A}
</style></head><body>
<h1>🔒 Cierre · ALTO <span style="color:#D99E00">PRO</span></h1>
<p class="warn">⚠️ Página privada del closer — NUNCA la compartas en pantalla. La presentación para el cliente es /demo.</p>
<h2>El cierre, paso a paso (todo en la misma llamada)</h2>
<ol>
<li>Mándale el <b>link de pago</b> por WhatsApp — paga desde su teléfono, aquí mismo.</li>
<li>Mientras paga: crea su cuenta en <a href="/closer">/closer</a> y copia su <b>link de acceso</b>.</li>
<li>Mándale la <b>bienvenida</b> con su acceso — ya tiene su app hoy mismo.</li>
<li>Agenda su <b>onboarding</b> antes de colgar.</li>
</ol>
<h2>Links y mensajes</h2>
<div class="link"><span><b>💳 Link de pago — $297 hoy + $297/mes</b><br><small>${esc(stripeLink || "buy.stripe.com/… (ejemplo — aún sin configurar)")}</small></span><a href="${stripeLink || "#"}" ${stripeLink ? `target="_blank" rel="noreferrer"` : `onclick="alert('Aún no está configurado: crea el Payment Link en Stripe y agrégalo en Render como STRIPE_PAYMENT_LINK');return false"`} style="background:#101B30;color:#fff;border-radius:8px;padding:8px 14px;font-weight:800;text-decoration:none;flex-shrink:0">Abrir</a><button onclick="${stripeLink ? `cp(this,'${stripeLink}')` : `alert('Aún no está configurado: crea el Payment Link en Stripe y agrégalo en Render como STRIPE_PAYMENT_LINK')`}">Copiar</button></div>
<p style="font-size:12px;color:#67718A;margin:-2px 0 10px"><b>Copiar</b> → se lo mandas por WhatsApp y paga desde su teléfono. <b>Abrir</b> → si te da la tarjeta por teléfono, la escribes tú aquí mismo.${stripeLink ? "" : ` <b style="color:#D93025">⚠️ Link de ejemplo — falta configurar STRIPE_PAYMENT_LINK en Render.</b>`}</p>
<div class="link"><span><b>👋 Bienvenida (pega su link de acceso)</b><br><small>${esc(welcome.slice(0, 70))}…</small></span><button onclick='cp(this,${JSON.stringify(welcome)})'>Copiar</button></div>
<div class="link"><span><b>🛰️ Demo del cotizador</b><br><small>${base}/w/alto-demo</small></span><button onclick="cp(this,'${base}/w/alto-demo')">Copiar</button></div>
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
<b>"Está caro"</b> → "Un techo promedio te deja $2,000–$4,000 de ganancia. Con UN trabajo extra al año, esto ya se pagó. La pregunta no es si cuesta — es cuántos trabajos se te están yendo hoy."<br><br>
<b>"Ya tengo página"</b> → "Qué bueno — ¿y te manda los teléfonos de los clientes al bolsillo, con su techo ya cotizado? Eso es lo que hace la diferencia. Tu página de hoy es la tarjeta; esta es la que vende."<br><br>
<b>"Déjame pensarlo"</b> → "Claro. ¿Qué es lo que quieres pensar — el precio, o si te va a funcionar? (espera la respuesta y resuélvela). Te aparto el precio hoy y la demo queda abierta."<br><br>
<b>"Lo tengo que hablar con mi esposa / mi socio"</b> → "Perfecto, así debe ser. ¿Qué te va a preguntar? … Mejor aún: agendemos 10 minutos mañana con los dos y le enseño la demo igual que a ti — que lo vea con sus propios ojos. ¿Mañana a qué hora pueden?"<br><br>
<b>"Mis clientes llegan por recomendación, no por internet"</b> → "Exacto — ¿y qué hace la gente cuando le recomiendan a alguien? Lo busca en Google antes de llamar. Si no encuentra nada, la recomendación se enfría. Esto convierte tus recomendaciones en citas."<br><br>
<b>"No soy bueno con la tecnología"</b> → "Por eso lo hicimos así: si sabes mandar un WhatsApp, sabes usar ALTO. Y el onboarding lo hacemos contigo, en español, paso a paso. No estás solo."<br><br>
<b>"¿Y si no me funciona?"</b> → "Sin contratos largos: cancelas cuando quieras y tu dominio se va contigo — está en el contrato. El riesgo lo cargamos nosotros, no tú."<br><br>
<b>"Ahorita no hay dinero / es temporada baja"</b> → "Justo por eso es el momento: tu página se construye AHORA, para que cuando venga la temporada de lluvias y granizo ya estés posicionado. El que la monta en plena temporada, llega tarde."<br><br>
<b>"Ya trabajo con una agencia de marketing"</b> → "No competimos con tu agencia — le damos a dónde mandar a la gente. ¿Su página te cotiza techos sola y te manda el teléfono al bolsillo? Eso es lo nuestro; lo demás lo puede seguir haciendo ella."<br><br>
<b>"Suena demasiado bueno / ¿por qué tan barato?"</b> → "Porque es software que ya construimos — no te cobramos horas de agencia. Y ganamos cuando te quedas meses, así que nos conviene más que a nadie que te funcione."<br><br>
<b>"Los leads de internet son basura"</b> → "Los leads comprados, sí. Estos no son comprados: es gente que puso SU dirección y SU teléfono para ver el precio de SU techo. Más caliente que eso no existe."
</small></p>
<script>function cp(b,t){navigator.clipboard.writeText(t);b.textContent='✓'}</script>
</body></html>`);
});

app.get("/demo", (req, res) => {
  const base = canonBase(req);
  const en = req.query.lang === "en";
  const wMsg = en
    ? `Check this out 👀 — type your address and see what your customers would see on YOUR website:\n${base}/w/alto-demo`
    : `Mira esto 👀 — escribe tu dirección y ve lo que tus clientes verían en TU página web:\n${base}/w/alto-demo`;
  const stripeLink = process.env.STRIPE_PAYMENT_LINK || "";
  const welcome = en
    ? `Congratulations and welcome to ALTO Pro! 🎉 Tap this link from your phone and save it — it's your personal key to your app: [PASTE THEIR ACCESS LINK HERE]. You can measure roofs and quote starting today. See you at your onboarding call 💪`
    : `¡Felicidades y bienvenido a ALTO Pro! 🎉 Toca este link desde tu teléfono y guárdalo — es tu llave personal a tu app: [PEGA AQUÍ SU LINK DE ACCESO]. Hoy mismo puedes medir techos y cotizar. Nos vemos en tu llamada de onboarding 💪`;
  // marketing photos appear automatically once the files exist in public/landing/
  const hasAsset = (name) =>
    fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "landing", name))
    || fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "landing", name));
  const teamPhoto = hasAsset("team.jpg");
  const founderBg = hasAsset("founder-bg.jpg");

  // Every visible string in both languages
  const L = en ? {
    title: "ALTO Pro · Presentation", presentation: "PRESENTATION", forClients: "Client presentation",
    menu: "☰ Menu", prev: "‹ Previous", next: "Next ›", langBtn: "🇲🇽 Español", langHref: "?lang=es",
    t1: "Welcome", t2: "Who we are", t3: "The problem", t4: "Your website", t5: "Your app", t6: "Your AI secretary", t7: "Your investment", t8: "Let's begin",
    k1: "ALTO PRO · MARKETING & TECHNOLOGY FOR ROOFERS", h1a: "More customers,", h1b: "without chasing them.",
    b1: "Thanks for booking. In the next 10 minutes you'll see your own roof measured by satellite — and how your website can sell for you 24 hours a day.",
    g1: "60 sec", g1s: "satellite quote", g2: "24/7", g2s: "your site selling", g3: "100%", g3s: "bilingual support", tag: "Your business, on top",
    k2: "02 · WHO WE ARE", h2a: "Built by a contractor,", h2b: "for contractors.",
    b2: "Rolando, our founder, owns residential construction and technology companies in Texas. Measuring the roofs of his own houses, he lived how hard it was to get the measurement right to order materials — so he built this tool for himself. It worked so well he opened it to the public, and today he uses this same system to get leads for his own company.",
    p2a: "Contractor founder: he builds houses, not just software", p2b: "20+ people on the ALTO team working behind your account", p2c: "We use our own tools, every single day",
    cap2: "Rolando · Founder of ALTO", ph2a: "Photo of Rolando and the team", ph2b: "in ALTO shirts",
    k3: "03 · WHY IT MATTERS", h3a: "Work gets lost", h3b: "up on the roof.",
    p3a: 'When you\'re working, you can\'t answer. And most customers go with <b style="color:#fff">whoever responds first</b>.',
    p3b: 'Every estimate costs you: the visit, the gas, the time. <b style="color:#fff">And many of those visits never turn into work.</b>',
    p3c: 'A pretty website with no system behind it is <b style="color:#fff">an expensive business card</b>.',
    p3d: 'Big companies already answer with artificial intelligence — in seconds, around the clock. <b style="color:#fff">The question isn\'t whether this is coming. It\'s which side you\'ll be on.</b>',
    c3: "You work hard. What you're missing is a system that works when you can't.",
    k4: "04 · YOUR WEBSITE", h4a: "This is what", h4b: "your site would look like.",
    b4: "It looks excellent on the phone and on the computer — with your logo, your colors and the quote tool inside. This one is a sample; yours is delivered in 10–14 days. Both are live: scroll, and type YOUR address into the quote tool.",
    k5: "05 · YOUR APP", h5a: "Your office,", h5b: "in your pocket.",
    p5a: "Quote wherever you are: address or GPS, and trace it with your finger if you want", p5b: "Every lead hits your phone with a WhatsApp button and the message pre-written", p5c: "An AI texts your customer instantly and books the appointment for you", p5d: "Formal quotes and invoices with your brand",
    live5: '🔴 <b style="color:#fff">The app on the right is LIVE</b> — explore it: tap MEASURE ROOF, type a real address and measure it right here, with the client.',
    k6: "06 · ARTIFICIAL INTELLIGENCE", h6a: "Your own secretary,", h6b: "who never sleeps.",
    b6: "We all know artificial intelligence is here — what better way than starting now? Your own secretary answers the messages from customers landing on your website, at any hour of the day.",
    p6a: "Replies instantly — even at 11 at night", p6b: "Books the appointment for you. You just show up.", p6c: "You can read every conversation whenever you want", p6d: "Ready in 10–14 days — carrier registration of your number takes a few days",
    chHead: "🔴 LIVE DEMO — text it like you're the customer", chGreet: "Hi! 👋 I'm the assistant at Techos García. How can I help you with your roof?",
    chPh: "Type as the customer… (e.g., I have a leak)", chFoot: "This same AI will answer YOUR customers' texts", chRetry: "Give me one moment 🙏 (try again)",
    k7: "07 · YOUR INVESTMENT", h7a: "All of this,", h7b: "one single price.",
    b7: "What this would cost separately (typical market prices):",
    s7a: "🌐 Professional website with your brand", s7b: "🛰️ Satellite quote tool on your site", s7c: "🤖 AI secretary that texts and books", s7d: "📲 Estimates, invoices & leads app", s7e: "🇺🇸 Domain, hosting & bilingual support",
    s7tot: "Separately", roi7: '💰 <b style="color:#fff">An average roof leaves you $2,000–$4,000 in profit.</b> One single extra job pays for your whole year.',
    pk7: "WITH ALTO PRO · ALL INCLUDED", mo: "/mo", setup7: "+ $297 to start, one time only",
    pr7a: "✓ No long contracts", pr7b: "✓ Cancel anytime", pr7c: "✓ Your domain is YOURS — by contract",
    k8: "08 · LET'S BEGIN", h8a: "Let's start", h8b: "today.",
    b8: "Getting started is this easy — everything begins on this very call:",
    d8a: "STEP 1", t8a: "Secure your spot", x8a: "We send a secure payment link to your WhatsApp. You pay by card, protected by Stripe 🔒.",
    d8b: "STEP 2 · TODAY", t8b: "Your app, today", x8b: "Your access arrives by WhatsApp before we hang up. You're measuring roofs today.",
    d8c: "STEP 3", t8c: "Your onboarding", x8c: "We book your call right now: your logo, your colors, your prices and your photos.",
    d8d: "DAY 10–14", t8d: "Everything live", x8d: "Your website, your quote tool and your AI secretary — 24/7. Carriers take a few days to approve your number; we use that time to make everything perfect.",
    c8: "🤝 Ready? I'll send you the link right now.",
  } : {
    title: "ALTO Pro · Presentación", presentation: "PRESENTACIÓN", forClients: "Presentación para clientes",
    menu: "☰ Menú", prev: "‹ Anterior", next: "Siguiente ›", langBtn: "🇺🇸 English", langHref: "?lang=en",
    t1: "Bienvenida", t2: "Quiénes somos", t3: "El problema", t4: "Tu página", t5: "Tu app", t6: "Tu secretaria IA", t7: "Tu inversión", t8: "Empecemos",
    k1: "ALTO PRO · MARKETING Y TECNOLOGÍA PARA ROFEROS", h1a: "Más clientes,", h1b: "sin perseguirlos.",
    b1: "Gracias por agendar. En los próximos 10 minutos vas a ver tu propio techo medido por satélite — y cómo tu página puede vender por ti las 24 horas.",
    g1: "60 seg", g1s: "cotización satelital", g2: "24/7", g2s: "tu página vendiendo", g3: "100%", g3s: "en español", tag: "Tu negocio, en alto",
    k2: "02 · QUIÉNES SOMOS", h2a: "Construido por un contratista,", h2b: "para contratistas.",
    b2: "Rolando, nuestro fundador, tiene compañías de construcción residencial y de tecnología en Texas. Midiendo los techos de sus propias casas vivió lo difícil que era sacar la medida correcta para pedir el material — así que construyó esta herramienta para él mismo. Funcionó tan bien que la abrió al público, y hoy usa este mismo sistema para conseguir leads para su propia compañía.",
    p2a: "Fundador contratista: construye casas, no solo software", p2b: "Más de 20 personas del equipo ALTO trabajando detrás de tu cuenta", p2c: "Usamos nuestras propias herramientas, todos los días",
    cap2: "Rolando · Fundador de ALTO", ph2a: "Foto de Rolando y el equipo", ph2b: "con la camisa ALTO",
    k3: "03 · POR QUÉ IMPORTA", h3a: "Los trabajos se pierden", h3b: "arriba del techo.",
    p3a: 'Cuando estás trabajando, no puedes contestar. Y la mayoría de los clientes se queda con <b style="color:#fff">el primero que les responde</b>.',
    p3b: 'Cada estimado cuesta: la visita, la gasolina, el tiempo. <b style="color:#fff">Y muchas de esas visitas nunca se vuelven trabajo.</b>',
    p3c: 'Una página bonita sin un sistema detrás es <b style="color:#fff">una tarjeta de presentación cara</b>.',
    p3d: 'Las compañías grandes ya responden con inteligencia artificial — en segundos, a toda hora. <b style="color:#fff">La pregunta no es si esto llega. Es de qué lado vas a estar.</b>',
    c3: "Trabajas duro. Lo que te falta es un sistema que trabaje cuando tú no puedes.",
    k4: "04 · TU PÁGINA WEB", h4a: "Así se vería", h4b: "tu página.",
    b4: "Se mira excelente en el celular y en la computadora — con tu logo, tus colores y el cotizador adentro. Esta es de ejemplo; la tuya se entrega en 10–14 días. Las dos están vivas: haz scroll, y pon TU dirección en el cotizador.",
    k5: "05 · TU APP", h5a: "Tu oficina,", h5b: "en tu bolsillo.",
    p5a: "Cotiza donde estés: dirección o GPS, y si quieres lo trazas con el dedo", p5b: "Cada lead llega a tu teléfono con botón de WhatsApp y el mensaje ya escrito", p5c: "Una IA le textea a tu cliente al momento y agenda la cita por ti", p5d: "Cotizaciones y facturas formales con tu marca",
    live5: '🔴 <b style="color:#fff">La app de la derecha está EN VIVO</b> — explórala: toca MEDIR TECHO, pon una dirección real y mídelo aquí mismo, con el cliente.',
    k6: "06 · INTELIGENCIA ARTIFICIAL", h6a: "Tu propia secretaria,", h6b: "que nunca duerme.",
    b6: "Todos sabemos que la inteligencia artificial ya viene — ¿qué mejor que empezar desde ahora? Tu propia secretaria contesta los mensajes de los clientes que llegan de tu página, a cualquier hora del día.",
    p6a: "Contesta al momento — aunque sean las 11 de la noche", p6b: "Agenda la cita por ti. Tú solo llegas a hacerla.", p6c: "Puedes ver cada conversación cuando quieras", p6d: "Lista en 10–14 días — el registro de tu número con las telefónicas tarda unos días",
    chHead: "🔴 DEMO EN VIVO — escríbele como si fueras el cliente", chGreet: "¡Hola! 👋 Soy la asistente de Techos García. ¿En qué le puedo ayudar con su techo?",
    chPh: "Escribe como cliente… (ej. tengo una gotera)", chFoot: "Esta misma IA contestará los textos de TUS clientes", chRetry: "Dame un momentito y te contesto 🙏 (intenta de nuevo)",
    k7: "07 · TU INVERSIÓN", h7a: "Todo esto,", h7b: "un solo precio.",
    b7: "Lo que esto costaría por separado (precios típicos del mercado):",
    s7a: "🌐 Página web profesional con tu marca", s7b: "🛰️ Cotizador por satélite en tu página", s7c: "🤖 Secretaria IA que textea y agenda", s7d: "📲 App de estimados, facturas y leads", s7e: "🇺🇸 Dominio, hosting y soporte en español",
    s7tot: "Por separado", roi7: '💰 <b style="color:#fff">Un techo promedio te deja $2,000–$4,000 de ganancia.</b> Un solo trabajo extra paga tu año entero.',
    pk7: "CON ALTO PRO · TODO INCLUIDO", mo: "/mes", setup7: "+ $297 para empezar, una sola vez",
    pr7a: "✓ Sin contratos largos", pr7b: "✓ Cancelas cuando quieras", pr7c: "✓ Tu dominio es TUYO — por contrato",
    k8: "08 · EMPECEMOS", h8a: "Empecemos", h8b: "hoy mismo.",
    b8: "Así de fácil es arrancar — todo empieza en esta misma llamada:",
    d8a: "PASO 1", t8a: "Asegura tu lugar", x8a: "Te mandamos un link de pago seguro a tu WhatsApp. Pagas con tarjeta, protegido por Stripe 🔒.",
    d8b: "PASO 2 · HOY", t8b: "Tu app, hoy mismo", x8b: "Tu acceso te llega por WhatsApp antes de colgar. Hoy mismo ya estás midiendo techos.",
    d8c: "PASO 3", t8c: "Tu onboarding", x8c: "Agendamos tu llamada ahorita: tu logo, tus colores, tus precios y tus fotos.",
    d8d: "DÍA 10–14", t8d: "Todo funcionando", x8d: "Tu página, tu cotizador y tu secretaria IA — 24/7. Las telefónicas tardan unos días en aprobar tu número; usamos ese tiempo para dejar todo perfecto.",
    c8: "🤝 ¿Listo? Te mando el link ahora mismo.",
  };

  res.send(`<!doctype html><html lang="${en ? "en" : "es"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${L.title}</title><link rel="icon" href="/icon-192.png">
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;0,9..144,700;1,9..144,600&family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0;-webkit-tap-highlight-color:transparent}
:root{--navy:#101B30;--navy2:#0B1226;--gold:#F8B408;--mut:#9DA8C4;--line:rgba(255,255,255,.1)}
body{background:var(--navy2);color:#fff;overflow:hidden}
.layout{display:flex;height:100vh;height:100dvh}
aside{width:268px;background:#fff;border-right:1px solid #E9EAEE;display:flex;flex-direction:column;flex-shrink:0}
.sb-brand{display:flex;justify-content:center;padding:26px 18px 16px}
.sb-brand img{height:58px;display:block}
.sb-label{font-size:10px;letter-spacing:2.5px;color:#9AA0AC;font-weight:800;padding:10px 18px 6px}
nav{flex:1;overflow-y:auto;padding-bottom:10px;display:flex;flex-direction:column}
.nav-it{flex:1;display:flex;align-items:center;gap:14px;width:100%;background:none;border:none;color:#6A7384;font-weight:700;font-size:16px;padding:0 20px;cursor:pointer;text-align:left;border-left:4px solid transparent;min-height:48px}
.nav-it .no{font-family:'Fraunces',Georgia,serif;font-size:13px;color:#B6BCC8;width:22px}
.nav-it.on{color:#101B30;background:rgba(248,180,8,.13);border-left-color:var(--gold)}
.nav-it.on .no{color:#D99E00}
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
.tl .ph.hot{border:1.5px solid var(--gold);background:rgba(248,180,8,.1);box-shadow:0 18px 48px rgba(248,180,8,.14)}
.amt{font-family:'Fraunces',Georgia,serif;font-size:clamp(72px,11vw,130px);font-weight:700;line-height:1;color:#fff;margin-top:6px}
.amt small{font-size:clamp(20px,2.8vw,30px);color:var(--mut)}
.stack{border:1px solid var(--line);border-radius:18px;overflow:hidden;max-width:560px}
.srow{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:13px 18px;border-bottom:1px solid var(--line);font-weight:600;font-size:14.5px;color:#E7ECF6}
.srow s{color:#8E99B5;font-weight:700;white-space:nowrap}
.srow.tot{background:rgba(255,255,255,.05);border-bottom:none;font-weight:800}
.srow.tot s{color:#C9D2E5}
.pcard{background:#fff;color:#101B30;border-radius:26px;padding:34px 32px;text-align:center;box-shadow:0 34px 90px rgba(248,180,8,.18),0 30px 70px rgba(0,0,0,.45);width:min(340px,100%)}
.pcard .pk{color:#D99E00;font-weight:800;font-size:11px;letter-spacing:2.5px}
.pcard .pamt{font-family:'Fraunces',Georgia,serif;font-size:74px;font-weight:700;line-height:1;margin-top:10px}
.pcard .pamt small{font-size:24px;color:#67718A}
.pcard .psetup{color:#67718A;font-weight:700;font-size:14px;margin-top:8px}
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
.ch-in input:focus{border-color:#F8B408}
.ch-in button{background:#F8B408;color:#101B30;border:none;border-radius:11px;padding:0 18px;font-weight:800;font-size:17px;cursor:pointer}
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
#ckit button{background:#F8B408;color:#101B30;border:none;border-radius:8px;padding:6px 12px;font-weight:800;font-size:12px;cursor:pointer}
#ckit .ck-k{color:#9AA0AC;font-size:10.5px;font-weight:600;margin-top:8px}
#ktoast{display:none;position:fixed;left:18px;bottom:70px;z-index:80;background:#34A853;color:#fff;border-radius:99px;width:34px;height:34px;align-items:center;justify-content:center;font-weight:800}
#ktoast.on{display:flex}
.ct{cursor:default;user-select:none}
</style></head><body>
<a class="langpill" href="${L.langHref}">${L.langBtn}</a>
<div class="layout">
<aside id="sb">
  <div class="sb-brand"><img src="/brand-logo.png" alt="ALTO Pro"></div>
  <div class="sb-label">${L.presentation}</div>
  <nav id="nav"></nav>
  <div class="sb-foot">${L.forClients}</div>
</aside>
<div class="scrim" id="scrim" onclick="toggleSb(false)"></div>
<main>
<div class="mtop"><button class="mt-b" onclick="toggleSb(true)">${L.menu}</button><b>ALTO <em>PRO</em></b><span style="width:64px"></span></div>
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
    <p class="body" style="margin-top:28px;font-size:clamp(17px,2.3vw,23px);max-width:940px"><b style="color:#F8B408">${L.c3}</b></p>
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
      <div class="iphone big"><div class="inotch"></div><div class="mscr"><iframe data-src="/?demo=roof" title="App"></iframe></div></div>
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
        <div class="pamt">$297<small>${L.mo}</small></div>
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
var chatHist=[{role:'assistant',content:${JSON.stringify(en ? "Hi! 👋 I'm the assistant at Techos García. How can I help you with your roof?" : "¡Hola! 👋 Soy la asistente de Techos García. ¿En qué le puedo ayudar con su techo?")}}],chatBusy=false;
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
    ? { inv: "FACTURA", est: "COTIZACIÓN", for: "Preparado para", item: "Concepto", subtotal: "Subtotal", deposit: "Depósito recibido", due: "SALDO PENDIENTE", paid: "PAGADO", how: "CÓMO PAGAR", zelle: "Zelle", cash: "Efectivo o cheque aceptado", print: "🖨️ Imprimir / Guardar PDF", made: "Hecho con ALTO Pro", meas: "Medición satelital del techo", date: "Fecha", area: "Área del techo", pitch: "Inclinación", sqs: "Cuadros (squares)", imgOf: "Imagen satelital", valid: "Esta cotización es válida por 30 días.", sig: "Autorizado por (firma del cliente)", sigDate: "Fecha" }
    : { inv: "INVOICE", est: "QUOTE", for: "Prepared for", item: "Item", subtotal: "Subtotal", deposit: "Deposit received", due: "BALANCE DUE", paid: "PAID", how: "HOW TO PAY", zelle: "Zelle", cash: "Cash or check accepted", print: "🖨️ Print / Save PDF", made: "Made with ALTO Pro", meas: "Satellite roof measurement", date: "Date", area: "Roof area", pitch: "Pitch", sqs: "Squares", imgOf: "Satellite imagery", valid: "This quote is valid for 30 days.", sig: "Authorized by (client signature)", sigDate: "Date" };
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
  .tag{display:inline-block;background:#F8B408;color:#fff;font-size:12px;font-weight:800;border-radius:99px;padding:3px 12px;margin-top:10px;letter-spacing:.06em}
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
  .due .amt{color:${d.paid ? "#1E9E5A" : "#F8B408"}}
  .pay{background:#FEF5DC;border-radius:12px;padding:14px 16px;font-size:15px}
  .pay b{display:block;font-size:11px;letter-spacing:.1em;color:#F8B408;margin-bottom:6px}
  .btn{display:block;width:calc(100% - 48px);margin:18px 24px;background:#F8B408;color:#fff;border:none;border-radius:12px;padding:15px;font-size:16px;font-weight:800;cursor:pointer}
  .ft{text-align:center;color:#9DA8C4;font-size:12px;padding:14px 0 26px}
  @media print{.btn{display:none}body{background:#fff}}
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
<div class="ft">⚡ ${L.made}</div>
</div></body></html>`);
});

app.post("/api/ai", async (req, res) => {
  const { messages, lang = "es", trade = "concrete", bizName = "", data = {} } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "messages required" });

  if (!aiLive) {
    return res.json({
      text: lang === "es"
        ? "(Demo) El asistente se activa cuando agregues tu OPENAI_API_KEY o ANTHROPIC_API_KEY en el servidor. Todo lo demás de la app ya funciona."
        : "(Demo) The assistant turns on once you add your OPENAI_API_KEY or ANTHROPIC_API_KEY on the server. Everything else in the app already works.",
      source: "demo",
    });
  }

  try {
    const text = await aiChat({
      maxTokens: 1024,
      system: `You are the AI assistant inside ALTO Pro, an app for Latino contractors. The contractor is a ${trade} contractor${bizName ? ` (business: ${bizName})` : ""}. Reply in ${lang === "es" ? "Spanish" : "English"}, max 90 words, plain text only (no markdown). Concrete math: cubic yards = (L ft × W ft × thickness in/12) / 27, add waste %, trucks hold 10 yd³. Roofing math: roof area = footprint sq ft × pitch factor (6/12 = 1.118), squares = area/100 rounded up, add 10% material waste. NEVER invent prices from the contractor's data; if asked about market rates, give a clearly-labeled rough range and say to verify locally. Contractor's current data: ${JSON.stringify(data)}`,
      messages,
    });
    res.json({ text, source: "live" });
  } catch (e) {
    console.error("ai failed:", e.message);
    res.status(502).json({ error: "ai_failed" });
  }
});

/* Parse a spoken phrase like "factura para María García, reparación de techo,
 * 450 dólares" into draft invoice fields. Claude when a key is set, simple
 * pattern matching otherwise. Always returns a draft for human review. */
function parseInvoiceFallback(text) {
  const amounts = [...String(text).matchAll(/\$?\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => parseFloat(m[1].replace(/,/g, "")));
  const amount = amounts.length ? Math.max(...amounts) : null;
  const nm = String(text).match(/(?:para|for)\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ'-]*(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ'-]*){0,2})/i);
  return { name: nm ? nm[1].trim() : "", concept: String(text).trim(), amount };
}

app.post("/api/parse", async (req, res) => {
  const { text, lang = "es" } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });
  if (aiLive) {
    try {
      const raw = await aiChat({
        maxTokens: 300,
        system: `Extract invoice fields from a contractor's spoken phrase (may be Spanish or English, transcribed by speech recognition). Reply with ONLY a JSON object: {"name": customer full name or "", "concept": short description of the work in ${lang === "es" ? "Spanish" : "English"} (clean it up, no customer name or amount in it), "amount": number or null}. Numbers may be spoken as words ("cuatrocientos cincuenta" = 450).`,
        messages: [{ role: "user", content: String(text) }],
      });
      const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
      return res.json({ name: j.name || "", concept: j.concept || String(text), amount: typeof j.amount === "number" ? j.amount : null, source: "live" });
    } catch (e) {
      console.error("parse failed:", e.message);
    }
  }
  res.json({ ...parseInvoiceFallback(text), source: "demo" });
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
  }
  return c;
}
await ensureAccount("alto-demo", "Techos García (Demo)", { biz: "Techos García (Demo)", lang: "es", trade: "roofing" });
await ensureAccount("alto-ventas", "ALTO Pro Ventas", { biz: "ALTO Pro", lang: "es", trade: "roofing" });

app.listen(PORT, () => {
  console.log(`ALTO Pro server on http://localhost:${PORT}`);
  console.log(`  google: ${GOOGLE_KEY ? "LIVE" : "demo"} · parcels: ${REGRID_KEY ? "LIVE" : "demo"} · property: ${RENTCAST_KEY ? "LIVE" : "demo"} · ai: ${aiLive ? `LIVE (${anthropic ? "anthropic" : "openai"})` : "demo"}`);
});
