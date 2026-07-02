/*
 * End-to-end smoke test: boots the real server and walks the money path.
 *
 *   create account → Stripe webhook activates it → invite redeems to a
 *   session → the app saves state → payStatus/site MUST survive (the C1
 *   state-wipe regression) → self-serve checkout auto-creates an account →
 *   revoke kills sessions and old invites.
 *
 * Run: npm test   (no keys needed — uses the file store + a test secret)
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const PORT = 4517;
const BASE = `http://localhost:${PORT}`;
const ADMIN = "smoke-admin-key";
const WH = "whsec_smoke";
const uniq = Date.now().toString(36);

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

function signedWebhook(body) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", WH).update(`${t}.${body}`).digest("hex");
  return fetch(`${BASE}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
    body,
  });
}

const server = spawn("node", ["server/index.mjs"], {
  env: { ...process.env, PORT: String(PORT), ADMIN_KEY: ADMIN, STRIPE_WEBHOOK_SECRET: WH, DATABASE_URL: "", RENDER: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(d));

try {
  // wait for boot
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  }
  if (!up) throw new Error("server did not boot");

  console.log("health + public routes");
  const health = await fetch(`${BASE}/api/health`).then(j);
  ok(health.ok === true, "/api/health ok");
  for (const p of ["/", "/ventas", "/w/alto-demo"]) {
    const s = (await fetch(`${BASE}${p}`)).status;
    ok(s === 200, `GET ${p} -> 200`);
  }
  ok((await fetch(`${BASE}/admin`)).status === 401, "/admin without key -> 401");

  console.log("closer-led flow: create → pay → invite → app save (C1 regression)");
  const phone = `956555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const created = await fetch(`${BASE}/api/admin/contractors?key=${ADMIN}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `Smoke Realty ${uniq}`, phone }),
  }).then(j);
  const slug = created.contractor?.slug;
  ok(!!slug && !!created.inviteUrl, "account created with invite link");

  const wh1 = await signedWebhook(JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { customer: `cus_${uniq}`, customer_details: { phone: `+1${phone}`, email: `${uniq}@smoke.test` } } },
  })).then(j);
  ok(wh1.ok === true, "signed checkout.session.completed accepted");

  const badSig = await fetch(`${BASE}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=deadbeef` },
    body: "{}",
  });
  ok(badSig.status === 400, "forged webhook signature -> 400");

  const inviteToken = created.inviteUrl.split("/invite/")[1];
  const red = await fetch(`${BASE}/invite/${inviteToken}`, { redirect: "manual" });
  const session = /session=([^&]+)/.exec(red.headers.get("location") || "")?.[1];
  ok(!!session, "invite redeems to a session");

  const put = await fetch(`${BASE}/api/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
    body: JSON.stringify({ state: { customers: [], jobs: [] }, profile: { profile: { name: "Smoke", biz: "Smoke Realty" } } }),
  });
  ok(put.ok, "app state save accepted");

  const after = (await fetch(`${BASE}/api/admin/contractors?key=${ADMIN}`).then(j)).contractors.find((c) => c.slug === slug);
  ok(after?.data?.payStatus === "ok", "C1 REGRESSION: payStatus survives an app save");
  ok(after?.data?.stripeCustomer === `cus_${uniq}`, "C1 REGRESSION: stripeCustomer survives an app save");
  ok(after?.data?.profile?.name === "Smoke", "profile still updated by the save");

  console.log("self-serve flow (C2): unmatched payment auto-creates an account");
  const ssPhone = `956777${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const wh2 = await signedWebhook(JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { customer: `cus_ss_${uniq}`, customer_details: { name: `SelfServe ${uniq}`, phone: `+1${ssPhone}`, email: `ss${uniq}@smoke.test` } } },
  })).then(j);
  ok(typeof wh2.created === "string" && wh2.created.length > 0, "unmatched checkout auto-creates an account");
  const ss = (await fetch(`${BASE}/api/admin/contractors?key=${ADMIN}`).then(j)).contractors.find((c) => c.slug === wh2.created);
  ok(ss?.data?.payStatus === "ok" && ss?.data?.selfServe === true, "self-serve account is active and flagged");

  console.log("revocation: old sessions and invites die");
  const rev = await fetch(`${BASE}/api/admin/revoke?key=${ADMIN}&id=${created.contractor.id}`, { method: "POST" });
  ok(rev.ok, "revoke endpoint responds");
  ok((await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${session}` } })).status === 401, "old session is dead after revoke");
  ok((await fetch(`${BASE}/invite/${inviteToken}`, { redirect: "manual" })).status === 404, "old invite link is dead after revoke");

  console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED ✅" : `\n${failures} FAILURE(S) ❌`);
} catch (e) {
  console.error("SMOKE CRASHED:", e.message);
  failures++;
} finally {
  server.kill();
}
process.exit(failures ? 1 : 0);
