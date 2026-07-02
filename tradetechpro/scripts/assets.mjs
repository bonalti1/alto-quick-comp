/*
 * Regenerates the landing marketing assets from the REAL app:
 *   app-measure.png — comps result (value + range)
 *   app-trace.png   — comparable sales list
 *   app-quote.png   — branded client CMA report
 *   og.png          — 1200×630 social share image (live widget in a phone)
 * Run: node scripts/assets.mjs   (boots the server itself, demo mode)
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4700;
const BASE = `http://localhost:${PORT}`;
const OUT = "public/landing";

const server = spawn("node", ["server/index.mjs"], {
  env: { ...process.env, PORT: String(PORT), DATABASE_URL: "", RENDER: "" },
  stdio: ["ignore", "pipe", "pipe"],
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await wait(250); up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false); }
  if (!up) throw new Error("server did not boot");

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    localStorage.setItem("qc_welcomed", "1");
    localStorage.setItem("ttp_profile", JSON.stringify({
      name: "María Torres", biz: "Casa Bella Realty", lang: "en",
      email: "maria@casabellarealty.com", license: "TREC #741852", phone: "9565550142",
    }));
  });
  const page = await ctx.newPage();
  // Force the app's built-in demo comps (server demo answers found:false;
  // the rich simulated data lives client-side and needs the API "unreachable").
  await page.route("**/api/lookup", (r) => r.abort());

  // ── Walk the app: search → comps result ──
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  // marketing shots: drop the demo-mode banner
  const hideBanner = () => page.evaluate(() => {
    document.querySelectorAll("span").forEach((el) => {
      if (el.textContent.trim().startsWith("🧪")) el.closest("div")?.remove();
    });
  });
  await hideBanner();
  const input = page.locator('input[placeholder*="address" i], input[placeholder*="dirección" i]').first();
  await input.waitFor({ timeout: 10000 });
  await input.fill("456 Oak Dr");
  await wait(700); // debounce + suggestions
  const sug = page.locator("button", { hasText: "Oak Dr" }).first();
  if (await sug.count()) await sug.click();
  else await input.press("Enter");
  // measuring animation → result
  await page.waitForSelector("text=/\\$\\d/", { timeout: 20000 });
  await wait(1200);
  await page.screenshot({ path: `${OUT}/app-measure.png` });
  console.log("✓ app-measure.png (comps result)");

  // ── Scroll to the Sold Comparables list (the app scrolls an inner container) ──
  await hideBanner();
  const scrollApp = (px) => page.evaluate((y) => {
    // the app scrolls at document level on these screens
    document.scrollingElement.scrollTop = y;
    document.querySelectorAll("div").forEach((el) => {
      const st = getComputedStyle(el).overflowY;
      if ((st === "auto" || st === "scroll") && el.scrollHeight > el.clientHeight + 60) el.scrollTop = y;
    });
  }, px);
  await scrollApp(660);
  await wait(600);
  await page.screenshot({ path: `${OUT}/app-trace.png` });
  console.log("✓ app-trace.png (comparables)");

  // ── The branded client report ──
  await scrollApp(99999);
  await wait(300);
  const repBtn = page.locator("button", { hasText: /client report|informe/i }).first();
  await repBtn.scrollIntoViewIfNeeded().catch(() => {});
  if (await repBtn.count()) { await repBtn.click(); await wait(1000); }
  await hideBanner();
  await scrollApp(0);
  await wait(400);
  await page.screenshot({ path: `${OUT}/app-quote.png` });
  console.log("✓ app-quote.png (CMA report)");

  // ── OG image: composed 1200×630 with the LIVE widget in a phone frame ──
  const og = await ctx.newPage();
  await og.setViewportSize({ width: 1200, height: 630 });
  await og.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@800&family=Inter:wght@600;700;800&display=swap');
  *{margin:0;box-sizing:border-box;font-family:Inter,Arial,sans-serif}
  body{width:1200px;height:630px;background:radial-gradient(120% 140% at 85% 0%,#24396B 0%,#15244C 55%,#0D1730 100%);display:flex;align-items:center;overflow:hidden;position:relative}
  .left{padding:0 40px 0 70px;width:660px}
  .left img{height:74px;margin-bottom:34px}
  h1{font-family:'Barlow Condensed',sans-serif;font-size:76px;line-height:.95;color:#fff;font-weight:800;letter-spacing:.5px}
  h1 em{color:#E5A33D;font-style:normal}
  .sub{color:#B9C4DE;font-size:23px;font-weight:700;margin-top:26px;line-height:1.5}
  .phone{position:absolute;right:64px;top:44px;width:340px;background:#0B1226;border:9px solid #2A3A5E;border-radius:44px;padding:10px;box-shadow:0 40px 90px rgba(0,0,0,.55)}
  .scr{width:100%;height:640px;overflow:hidden;border-radius:32px;background:#F4F6FA}
  .scr iframe{width:405px;height:800px;border:0;transform:scale(.7877);transform-origin:0 0}
  </style></head><body>
  <div class="left">
    <img src="${BASE}/quick-comp-lockup-white.png" alt="Quick Comp">
    <h1>YOUR WEBSITE<br>FINDS YOU<br><em>SELLERS 24/7</em></h1>
    <p class="sub">Instant home values from real sales<br>Leads straight to your phone · English y Español</p>
  </div>
  <div class="phone"><div class="scr"><iframe src="${BASE}/w/alto-demo?lang=en"></iframe></div></div>
  </body></html>`, { waitUntil: "networkidle" });
  await wait(1800);
  for (const f of og.frames()) {
    if (f.url().includes("/w/alto-demo")) {
      await f.evaluate(() => {
        const nm = document.querySelector(".brand .nm");
        if (nm) nm.textContent = nm.textContent.replace(/\s*\(Demo\)\s*/i, "");
      }).catch(() => {});
    }
  }
  await wait(200);
  await og.screenshot({ path: `${OUT}/og.png` });
  console.log("✓ og.png (social share)");

  await browser.close();
} catch (e) {
  console.error("ASSET CAPTURE FAILED:", e.message);
  process.exitCode = 1;
} finally {
  server.kill();
}
