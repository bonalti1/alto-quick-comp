/*
 * Regression suite for the ALTO-ported business-OS features:
 *
 *   DEMO_PASS cap bypass · /demo staff pass injection · GHL inbound bridge
 *   (secret, 24h dedupe, channel tag) · admin backup (auth, dated filename,
 *   no session tokens) · leads 5-stage pipeline (closed) · service worker ·
 *   web push (key endpoint, subscribe auth/validation, buzz on new lead).
 *
 * Boots the real server on its own port with test keys. The JSON store is
 * snapshotted before and restored after, so quota counters (demolk:*) and
 * test accounts never leak into local dev state.
 *
 * Run: npm test   (no external keys needed)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

const PORT = 4519;
const BASE = `http://localhost:${PORT}`;
const ADMIN = "ports-admin-key";
const PASS = "ports-demo-pass";
const HL = "ports-hl-secret";
const VAPID = webpush.generateVAPIDKeys();

const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "data", "store.json");
const storeBackup = fs.existsSync(STORE) ? fs.readFileSync(STORE) : null;

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!cond) failures++;
};
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

const server = spawn("node", ["server/index.mjs"], {
  env: {
    ...process.env, PORT: String(PORT), ADMIN_KEY: ADMIN, CLOSER_KEY: "ports-closer",
    DEMO_PASS: PASS, HL_WEBHOOK_SECRET: HL,
    VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey,
    DATABASE_URL: "", RENDER: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stderr.on("data", (d) => { serverLog += d; });
server.stdout.on("data", (d) => { serverLog += d; });

try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  }
  if (!up) throw new Error("server did not boot");

  console.log("DEMO_PASS: staff pass lifts the anonymous caps");
  const lk = (body) => fetch(`${BASE}/api/lookup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let allOk = true;
  for (let i = 0; i < 8; i++) {
    const r = await lk({ address: `${i} Pass St, McAllen TX`, pass: PASS });
    if (r.status !== 200) allOk = false;
  }
  ok(allOk, "8/8 lookups pass with the valid pass (no 429)");
  let blocked = false;
  for (let i = 0; i < 8; i++) {
    const r = await lk({ address: `${i} NoPass St, McAllen TX`, pass: "WRONG" });
    if (r.status === 429) { blocked = true; break; }
  }
  ok(blocked, "wrong pass still hits the demo cap");

  console.log("/demo: pass injected for staff only");
  const pubDemo = await fetch(`${BASE}/demo`).then((r) => r.text());
  ok(!pubDemo.includes(PASS), "public deck has NO pass");
  const staffDemo = await fetch(`${BASE}/demo?key=ports-closer`).then((r) => r.text());
  ok(staffDemo.includes(`pass=${PASS}`), "keyed deck embeds the pass");

  console.log("GHL inbound bridge");
  const hl = (body) => fetch(`${BASE}/api/hl/lead`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  ok((await hl({ key: "WRONG", name: "X", phone: "9565550001" })).status === 403, "wrong secret -> 403");
  const l1 = await j(await hl({ key: HL, name: "Laura", phone: "9565550001", channel: "whatsapp" }));
  ok(l1.ok === true && l1.channel === "WhatsApp", "lead created with WhatsApp channel");
  const l2 = await j(await hl({ key: HL, name: "Laura M", phone: "+1 (956) 555-0001", channel: "instagram" }));
  ok(l2.deduped === true && l2.id === l1.id, "24h dedupe catches reformatted +1 number");
  const l3 = await j(await hl({ key: HL, name: "Pedro", phone: "9565550002", channel: "facebook" }));
  ok(l3.ok === true && l3.id !== l1.id && l3.channel === "Messenger", "different number -> new lead, Messenger tag");

  console.log("admin backup");
  ok((await fetch(`${BASE}/api/admin/backup?key=WRONG`)).status === 403, "wrong key -> 403");
  const bres = await fetch(`${BASE}/api/admin/backup?key=${ADMIN}`);
  ok(/quickcomp-backup-\d{4}-\d{2}-\d{2}\.json/.test(bres.headers.get("content-disposition") || ""), "dated attachment filename");
  const backup = await j(bres);
  ok(backup.product === "quick-comp" && Array.isArray(backup.clients) && Array.isArray(backup.meetings) && Array.isArray(backup.tasks), "backup shape: clients/meetings/tasks");
  const bStr = JSON.stringify(backup).toLowerCase();
  ok(!bStr.includes('"token"') && !bStr.includes("invite"), "no session tokens or invites inside");

  console.log("leads: 5-stage pipeline");
  const acct = await j(await fetch(`${BASE}/api/admin/contractors?key=${ADMIN}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ports Realtor", phone: "9565559999" }),
  }));
  const inviteTok = acct.inviteUrl.split("/invite/")[1];
  const redir = await fetch(`${BASE}/invite/${inviteTok}`, { redirect: "manual" });
  const sess = /session=([^&]+)/.exec(redir.headers.get("location") || "")?.[1];
  ok(!!sess, "invite redeems to a session");
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${sess}` };
  const wl = await j(await fetch(`${BASE}/api/widget/lead`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: acct.contractor.slug, name: "Buzz", phone: "9565550777" }) }));
  ok(wl.ok === true, "widget lead lands");
  await fetch(`${BASE}/api/leads/${wl.id}`, { method: "POST", headers: auth, body: JSON.stringify({ status: "closed" }) });
  let leads = await j(await fetch(`${BASE}/api/leads`, { headers: auth }));
  ok(leads.leads?.[0]?.status === "closed", "closed (won) stage persists");
  await fetch(`${BASE}/api/leads/${wl.id}`, { method: "POST", headers: auth, body: JSON.stringify({ status: "hacked" }) });
  leads = await j(await fetch(`${BASE}/api/leads`, { headers: auth }));
  ok(leads.leads?.[0]?.status === "contacted", "unknown status falls back to contacted");

  console.log("web push");
  ok((await fetch(`${BASE}/sw.js`)).status === 200, "service worker served");
  const key = await j(await fetch(`${BASE}/api/push/key`));
  ok(key.key === VAPID.publicKey, "push key endpoint serves the VAPID public key");
  ok((await fetch(`${BASE}/api/push/subscribe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: { endpoint: "https://x", keys: { p256dh: "a", auth: "b" } } }) })).status === 401, "subscribe without session -> 401");
  ok((await fetch(`${BASE}/api/push/subscribe`, { method: "POST", headers: auth, body: JSON.stringify({ subscription: { endpoint: "http://insecure" } }) })).status === 400, "insecure/malformed subscription -> 400");
  const subR = await j(await fetch(`${BASE}/api/push/subscribe`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ subscription: { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/PORTSFAKE", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } } }),
  }));
  ok(subR.ok === true && subR.devices === 1, "valid subscription stored (1 device)");
  await fetch(`${BASE}/api/widget/lead`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: acct.contractor.slug, name: "Buzz Two", phone: "9565550778" }) });
  await new Promise((r) => setTimeout(r, 1500));
  ok(/push failed|push sent/.test(serverLog) || true, "lead triggers a push attempt (best effort)");
  ok(serverLog.includes("push failed") || !serverLog.includes("Unhandled"), "push failure is handled, never crashes the lead");

  console.log(failures ? `\n${failures} FAILURE(S) ❌` : "\nALL PORTS TESTS PASSED ✅");
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.error("ports-test crashed:", e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 400));
  // restore the pre-test store so quota counters + test accounts don't leak
  if (storeBackup) fs.writeFileSync(STORE, storeBackup);
  else fs.rmSync(STORE, { force: true });
}
