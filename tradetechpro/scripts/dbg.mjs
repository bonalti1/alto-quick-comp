import { spawn } from "node:child_process";
import { chromium } from "playwright";
const PORT = 4713, BASE = `http://localhost:${PORT}`;
const server = spawn("node", ["server/index.mjs"], { env: { ...process.env, PORT: String(PORT), DATABASE_URL: "", RENDER: "" }, stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 40; i++) { await wait(250); if (await fetch(`${BASE}/api/health`).then(r=>r.ok).catch(()=>false)) break; }
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => { localStorage.setItem("qc_welcomed","1"); localStorage.setItem("ttp_profile", JSON.stringify({name:"M",biz:"CB",lang:"en"})); });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE ERROR:", m.text().slice(0, 400)); });
  page.on("pageerror", (e) => console.log("PAGE ERROR:", String(e).slice(0, 500)));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await wait(1500);
  console.log("body text head:", (await page.locator("body").textContent() || "").slice(0, 150));
} finally { server.kill(); }
