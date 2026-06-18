/*
 * Quick Comp website factory — the 3 realtor client templates.
 *
 * Every client site is RENDERED FROM DATA through these battle-tested
 * templates; no code is ever generated per client. Improve a template
 * here and every client site improves instantly.
 *
 *   1 · Clásico  — elegant serif, photographic, premium
 *   2 · Fuerte   — bold condensed, dark, high energy
 *   3 · Limpio   — white, soft, rounded, family trust
 */

const esc = (s) => String(s || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

const pretty = (d) => (String(d).length === 10 ? `(${String(d).slice(0, 3)}) ${String(d).slice(3, 6)}-${String(d).slice(6)}` : d);

// darken/lighten a hex color (f < 0 darkens)
function shade(hex, f) {
  const m = /^#?([a-f0-9]{6})$/i.exec(String(hex).trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (x) => Math.max(0, Math.min(255, Math.round(x + (f < 0 ? x * f : (255 - x) * f))));
  const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

const DEFAULT_SERVICES = [
  ["🏡", "Vende tu casa", "Te ponemos al precio correcto desde el día uno, con un plan de marketing que atrae compradores reales."],
  ["🔑", "Compra tu casa", "Te representamos como comprador — buscamos, negociamos y cuidamos cada detalle hasta las llaves."],
  ["📊", "Valuación / CMA gratis", "Un análisis comparativo de mercado con ventas reales cercanas para saber qué vale tu casa hoy."],
  ["🤝", "Asesoría de mercado", "Te decimos la verdad del mercado — cuándo vender, cuándo esperar — aunque no sea hoy."],
];

/* Shared pieces */
function headBase(d, css) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.biz)}${d.city ? " · " + esc(d.city) : ""}</title>
<meta name="description" content="${esc(d.biz)} — bienes raíces${d.city ? " en " + esc(d.city) : ""}. Conoce el valor de tu casa en 60 segundos, con ventas reales cercanas.">
<style>${css}</style></head><body>`;
}

function ribbonHtml(opts) {
  if (!opts.ribbon) return "";
  return `<div style="background:#F8B408;color:#101B30;text-align:center;font-weight:800;font-size:12.5px;padding:9px 14px;font-family:Inter,Arial,sans-serif">📋 ${esc(opts.ribbon)}</div>`;
}

function backAltoHtml(opts) {
  if (!opts.backAlto) return "";
  return `<a style="position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:50;background:#15244C;color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:13px 22px;border-radius:99px;box-shadow:0 14px 36px rgba(16,27,48,.5);font-family:Inter,Arial,sans-serif;white-space:nowrap" href="/ventas#precio">← Volver a <span style="color:#C9973A">QUICK COMP</span></a>`;
}

function footerBits(d) {
  return `<b>${esc(d.biz)}</b>${d.city ? ` · ${esc(d.city)}` : ""}${d.license ? ` · Lic. ${esc(d.license)}` : ""}<br>Página hecha con ⚡ Quick Comp`;
}

const statsCells = (d) => [
  d.years ? [`${d.years}+`, "años de experiencia"] : null,
  ["100%", "dedicación"],
  ["ES/EN", "hablamos los dos"],
].filter(Boolean);

/* ── Template 1 · Clásico ── */
function t1(d, opts) {
  const c1 = d.color, c2 = shade(d.color, -0.45), cream = "#FAF8F5";
  const css = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;0,9..144,700;1,9..144,600&family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0;-webkit-tap-highlight-color:transparent}
body{background:#fff;color:#0F1216}
.wrap{max-width:1060px;margin:0 auto;padding:0 24px}
header{position:sticky;top:0;z-index:40;background:rgba(255,255,255,.85);backdrop-filter:blur(14px);border-bottom:1px solid #E9EAEE}
.hrow{display:flex;align-items:center;justify-content:space-between;padding:13px 0}
.hbrand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:16px}
.hbrand img{max-height:42px;max-width:140px}
.callbtn{background:${c1};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;box-shadow:0 8px 22px ${c1}44}
.hero{position:relative;color:#fff;overflow:hidden;background:${c2}}
.hero .veil{position:absolute;inset:0;background:linear-gradient(165deg,${shade(d.color, -0.72)} 0%,${c2} 60%,${c1} 100%)}
.hero .in{position:relative;padding:96px 0 84px;text-align:center}
.kick{display:inline-block;border:1px solid rgba(255,255,255,.35);border-radius:99px;padding:8px 18px;font-size:12px;font-weight:700;letter-spacing:3px;margin-bottom:24px}
.hero h1{font-family:'Fraunces',Georgia,serif;font-size:clamp(40px,7vw,72px);line-height:1.04;font-weight:700;max-width:820px;margin:0 auto}
.hero h1 em{font-style:italic;opacity:.92}
.hero p{opacity:.85;font-weight:500;font-size:clamp(15px,2.3vw,18px);margin:20px auto 0;max-width:540px;line-height:1.65}
.hero .cta{display:inline-block;margin:32px 7px 0;background:#fff;color:${c1};font-weight:800;font-size:16px;padding:16px 32px;border-radius:12px;text-decoration:none;box-shadow:0 18px 44px rgba(0,0,0,.35)}
.hero .cta.ghost{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.45);box-shadow:none;font-weight:700}
.stats{position:relative;display:flex;justify-content:center;gap:clamp(26px,6vw,72px);padding:22px 18px 32px;flex-wrap:wrap}
.stat{text-align:center}
.stat b{font-family:'Fraunces',Georgia,serif;font-size:clamp(24px,3.6vw,34px);font-weight:700;display:block}
.stat span{font-size:11px;letter-spacing:1.5px;opacity:.75;font-weight:700;text-transform:uppercase}
.trust{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;padding:20px;background:${shade(d.color, 0.92)}}
.trust span{font-size:13px;font-weight:700;color:${shade(d.color, -0.55)}}
section{padding:74px 0}
.eyebrow{color:${c1};font-weight:800;font-size:12px;letter-spacing:3.5px;text-transform:uppercase;text-align:center}
.t{font-family:'Fraunces',Georgia,serif;font-size:clamp(30px,4.8vw,46px);font-weight:700;text-align:center;line-height:1.08;margin-top:12px}
.t em{font-style:italic;color:${c1}}
.sub{color:#5E6470;text-align:center;font-weight:500;margin:14px auto 0;max-width:560px;font-size:15.5px;line-height:1.7}
.qframe{background:#fff;border:1px solid #E9EAEE;border-radius:24px;padding:10px;max-width:450px;margin:38px auto 0;box-shadow:0 30px 80px rgba(15,18,22,.13)}
.qframe iframe{width:100%;height:530px;border:0;border-radius:16px;display:block}
.svc{display:grid;grid-template-columns:54px 1fr;gap:18px;align-items:baseline;padding:28px 6px;border-bottom:1px solid #E9EAEE}
.svc:first-of-type{border-top:1px solid #E9EAEE}
.svc .ic{font-size:30px}
.svc h3{font-family:'Fraunces',Georgia,serif;font-size:clamp(20px,2.8vw,25px);font-weight:700}
.svc p{color:#5E6470;font-size:14.5px;font-weight:500;line-height:1.65;margin-top:6px;max-width:560px}
.about{background:${cream}}
.about .bx{max-width:680px;margin:0 auto;text-align:center}
.about p.body{color:#3A4252;font-size:16.5px;font-weight:500;line-height:1.85;margin-top:22px}
.gal{display:grid;gap:16px;margin-top:38px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.gal img{width:100%;height:230px;object-fit:cover;border-radius:18px;border:1px solid #E9EAEE;box-shadow:0 16px 44px rgba(15,18,22,.10)}
.ctaband{position:relative;background:${shade(d.color, -0.7)};color:#fff;text-align:center;padding:86px 22px}
.ctaband h2{font-family:'Fraunces',Georgia,serif;font-size:clamp(30px,5vw,50px);font-weight:700;line-height:1.1}
.ctaband a{display:inline-block;margin:28px 7px 0;font-weight:800;font-size:16px;padding:16px 28px;border-radius:12px;text-decoration:none}
.ctaband .a1{background:#fff;color:${c1}}
.ctaband .a2{background:#25D366;color:#fff}
footer{padding:40px 22px ${opts.backAlto ? "110px" : "44px"};text-align:center;color:#9AA0AC;font-size:13px;font-weight:500;line-height:2}
footer b{color:#0F1216;font-family:'Fraunces',Georgia,serif;font-size:16px}`;
  return `${headBase(d, css)}
${ribbonHtml(opts)}
<header><div class="wrap hrow">
  <span class="hbrand">${d.logo ? `<img src="${d.logo}" alt="${esc(d.biz)}">` : esc(d.biz)}</span>
  ${d.phone ? `<a class="callbtn" href="tel:+1${d.phone}">📞 ${pretty(d.phone)}</a>` : ""}
</div></header>
<div class="hero"><div class="veil"></div>
  <div class="wrap in">
    <span class="kick">BIENES RAÍCES${d.city ? ` · ${esc(d.city).toUpperCase()}` : ""}</span>
    <h1>${d.hero || `Vende tu casa por<br>lo que <em>de verdad vale</em>`}</h1>
    <p>${esc(d.tagline) || "Conoce el valor de tu casa al instante, con ventas reales cercanas — gratis y sin que nadie te visite."}</p>
    <a class="cta" href="#cotiza">VALÚA TU CASA EN 60 SEGUNDOS</a>${d.phone ? `<a class="cta ghost" href="tel:+1${d.phone}">Llámanos</a>` : ""}
  </div>
  <div class="wrap stats">${statsCells(d).map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join("")}</div>
</div>
<div class="trust"><span>✓ ${d.license ? "Agente licenciado" : "Agente local"}</span><span>✓ Ventas reales comparables</span><span>✓ Valuación gratis</span><span>✓ Hablamos español</span></div>

<div class="wrap"><section id="cotiza">
  <p class="eyebrow">Valuación instantánea</p>
  <h2 class="t">El valor de tu casa, <em>sin esperar</em></h2>
  <p class="sub">Escribe tu dirección y mira el valor de tu casa con ventas reales cercanas. Gratis y sin compromiso.</p>
  <div class="qframe"><iframe src="/w/${esc(d.slug)}" loading="lazy" title="Valuador"></iframe></div>
</section></div>

<div class="wrap"><section style="padding-top:6px">
  <p class="eyebrow">Servicios</p>
  <h2 class="t">Lo que hacemos <em>bien</em></h2>
  <div style="margin-top:38px">
    ${d.services.map(([ic, t, x]) => `<div class="svc"><span class="ic">${ic}</span><div><h3>${esc(t)}</h3><p>${esc(x)}</p></div></div>`).join("")}
  </div>
</section></div>

${d.about ? `<div class="about"><div class="wrap"><section><div class="bx">
  <p class="eyebrow">Quiénes somos</p>
  <h2 class="t">Nuestra <em>historia</em></h2>
  <p class="body">${esc(d.about)}</p>
</div></section></div></div>` : ""}

${d.photos.length ? `<div class="wrap"><section style="padding-top:10px">
  <p class="eyebrow">Trabajos recientes</p>
  <h2 class="t">Hecho con <em>orgullo</em></h2>
  <div class="gal">${d.photos.map((p) => `<img loading="lazy" src="${esc(p)}" alt="">`).join("")}</div>
</section></div>` : ""}

<div class="ctaband">
  <h2>¿Listo para vender<br><em>al mejor precio?</em></h2>
  <a class="a1" href="#cotiza">VALÚA AHORA</a>${d.phone ? `<a class="a2" href="https://wa.me/1${d.phone}">💬 WhatsApp</a>` : ""}
</div>
<footer>${footerBits(d)}</footer>
${backAltoHtml(opts)}
</body></html>`;
}

/* ── Template 2 · Fuerte (industrial · oversized · dark) ── */
function t2(d, opts) {
  const c1 = d.color, ink = "#0B0E13", panel = "#11151C";
  const ghost = esc(String(d.biz || "Casa").split(" ")[0].toUpperCase());
  const css = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,800&family=Inter:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0;-webkit-tap-highlight-color:transparent}
body{background:${ink};color:#fff;padding-bottom:70px}
.bc{font-family:'Barlow Condensed',sans-serif}
.wrap{max-width:1140px;margin:0 auto;padding:0 26px}
header{position:sticky;top:0;z-index:40;background:${ink}E8;backdrop-filter:blur(12px);border-bottom:1px solid #ffffff12}
.hrow{display:flex;align-items:center;justify-content:space-between;padding:15px 0}
.hbrand{display:flex;align-items:center;gap:11px;font-weight:800;font-size:16px;text-transform:uppercase;letter-spacing:1px}
.hbrand img{max-height:42px;max-width:150px;background:#fff;border-radius:9px;padding:4px 7px}
.callbtn{background:${c1};color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:13px 22px;border-radius:7px;text-transform:uppercase;letter-spacing:.5px}
.hero{position:relative;min-height:90vh;display:flex;align-items:center;overflow:hidden;background:radial-gradient(125% 100% at 82% 4%,${shade(d.color, -0.34)}33,${ink} 56%)}
.ghostword{position:absolute;right:-3%;bottom:-9%;font-size:33vw;font-weight:800;line-height:.8;color:#ffffff07;text-transform:uppercase;pointer-events:none;white-space:nowrap;letter-spacing:-4px}
.hero .in{position:relative;padding:64px 0}
.hk{display:inline-flex;align-items:center;gap:10px;color:#fff;font-weight:800;letter-spacing:4px;font-size:12px;text-transform:uppercase}
.hk::before{content:"";width:32px;height:3px;background:${c1}}
.hero h1{font-family:'Barlow Condensed',sans-serif;font-size:clamp(62px,13vw,150px);line-height:.88;font-weight:800;text-transform:uppercase;margin-top:18px;letter-spacing:-1px}
.hero h1 em{color:${c1};font-style:normal}
.hero .lede{color:#ffffffC2;font-weight:600;font-size:clamp(16px,2.1vw,19px);margin-top:24px;max-width:540px;line-height:1.6}
.ctas{margin-top:36px;display:flex;gap:12px;flex-wrap:wrap}
.btn{display:inline-block;font-weight:800;font-size:16px;padding:18px 36px;border-radius:7px;text-decoration:none;text-transform:uppercase;letter-spacing:.8px}
.btn.p{background:${c1};color:#fff;box-shadow:0 16px 40px ${c1}40}
.btn.g{background:transparent;color:#fff;border:2px solid #ffffff33}
.strip{background:${c1}}
.strip .in{display:flex;flex-wrap:wrap;justify-content:space-between;gap:22px;padding:28px 0}
.strip .num b{font-family:'Barlow Condensed',sans-serif;font-size:clamp(40px,6vw,62px);font-weight:800;line-height:1;display:block}
.strip .num span{font-size:12px;letter-spacing:2px;font-weight:800;text-transform:uppercase;opacity:.9}
.quote{padding:88px 0}
.qgrid{display:grid;gap:46px;align-items:center}
@media(min-width:900px){.qgrid{grid-template-columns:1fr 440px}}
.lab{color:${c1};font-weight:800;letter-spacing:4px;font-size:12px;text-transform:uppercase}
.t{font-family:'Barlow Condensed',sans-serif;font-size:clamp(44px,7vw,76px);font-weight:800;text-transform:uppercase;line-height:.95;margin-top:10px}
.t em{color:${c1};font-style:normal}
.lead{color:#ffffffB0;font-weight:600;margin-top:16px;font-size:16px;line-height:1.65;max-width:520px}
.qframe{background:#000;border:1px solid #ffffff14;border-radius:12px;padding:10px;box-shadow:0 40px 90px rgba(0,0,0,.55)}
.qframe iframe{width:100%;height:540px;border:0;border-radius:7px;display:block}
.svcwrap{border-top:1px solid #ffffff12}
.svc{display:grid;grid-template-columns:auto 1fr auto;gap:clamp(16px,4vw,44px);align-items:center;padding:34px 0;border-bottom:1px solid #ffffff12}
.svc .no{font-family:'Barlow Condensed',sans-serif;font-size:clamp(40px,6vw,66px);font-weight:800;color:${c1};line-height:1}
.svc h3{font-family:'Barlow Condensed',sans-serif;font-size:clamp(25px,3.6vw,37px);font-weight:800;text-transform:uppercase;line-height:1}
.svc p{color:#ffffffA8;font-weight:600;font-size:15px;line-height:1.6;margin-top:8px;max-width:640px}
.svc .ic{font-size:30px;opacity:.5}
.about{background:${panel};padding:86px 0}
.about .qm{font-family:'Barlow Condensed',sans-serif;font-size:96px;color:${c1};line-height:.5;height:48px}
.about p{color:#fff;font-size:clamp(18px,2.4vw,25px);font-weight:600;line-height:1.55;max-width:780px;margin-top:8px}
.gal{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));padding:72px 0}
.gal img{width:100%;height:262px;object-fit:cover;border-radius:4px}
.bar{position:fixed;left:0;right:0;bottom:0;z-index:45;display:flex}
.bar a{flex:1;text-align:center;color:#fff;text-decoration:none;font-weight:800;font-size:15px;padding:18px 10px;text-transform:uppercase;letter-spacing:1px;background:${c1}}
.bar a+a{background:#1FAF52}
footer{padding:54px 26px ${opts.backAlto ? "120px" : "50px"};text-align:center;color:#ffffff70;font-size:13px;font-weight:600;line-height:2}
footer b{color:#fff;font-family:'Barlow Condensed',sans-serif;font-size:19px;text-transform:uppercase}`;
  return `${headBase(d, css)}
${ribbonHtml(opts)}
<header><div class="wrap hrow">
  <span class="hbrand">${d.logo ? `<img src="${d.logo}" alt="${esc(d.biz)}">` : esc(d.biz)}</span>
  ${d.phone ? `<a class="callbtn" href="tel:+1${d.phone}">📞 ${pretty(d.phone)}</a>` : ""}
</div></header>
<div class="hero">
  <div class="ghostword bc">${ghost}</div>
  <div class="wrap in">
    <p class="hk">Bienes raíces${d.city ? ` · ${esc(d.city).toUpperCase()}` : ""}</p>
    <h1>${d.hero || `Vende <em>al mejor</em><br>precio.`}</h1>
    <p class="lede">${esc(d.tagline) || "Conoce el valor de tu casa en 60 segundos — con ventas reales cercanas, sin visitas y sin compromiso."}</p>
    <div class="ctas"><a class="btn p" href="#cotiza">Valúa ya</a>${d.phone ? `<a class="btn g" href="tel:+1${d.phone}">Llámanos</a>` : ""}</div>
  </div>
</div>
<div class="strip"><div class="wrap in">${statsCells(d).map(([b, s]) => `<div class="num"><b>${b}</b><span>${s}</span></div>`).join("")}</div></div>
<div class="quote" id="cotiza"><div class="wrap"><div class="qgrid">
  <div>
    <p class="lab">Valuación instantánea</p>
    <h2 class="t">Tu valor <em>en 60 segundos</em></h2>
    <p class="lead">Escribe tu dirección. Analizamos ventas comparables reales y te damos el valor estimado al instante. Gratis, sin compromiso, sin esperar a nadie.</p>
  </div>
  <div class="qframe"><iframe src="/w/${esc(d.slug)}" loading="lazy" title="Valuador"></iframe></div>
</div></div></div>
<div class="wrap"><div class="svcwrap">
  ${d.services.map(([ic, t, x], i) => `<div class="svc"><div class="no">${String(i + 1).padStart(2, "0")}</div><div><h3>${esc(t)}</h3><p>${esc(x)}</p></div><div class="ic">${ic}</div></div>`).join("")}
</div></div>
${d.about ? `<div class="about"><div class="wrap"><div class="qm bc">&ldquo;</div><p>${esc(d.about)}</p></div></div>` : ""}
${d.photos.length ? `<div class="wrap"><div class="gal">${d.photos.map((p) => `<img loading="lazy" src="${esc(p)}" alt="">`).join("")}</div></div>` : ""}
<footer>${footerBits(d)}</footer>
<div class="bar"><a href="#cotiza">🏡 Valúa gratis</a>${d.phone ? `<a href="https://wa.me/1${d.phone}">💬 WhatsApp</a>` : ""}</div>
${backAltoHtml(opts)}
</body></html>`;
}

/* ── Template 3 · Limpio (warm · trust · quote-in-hero) ── */
function t3(d, opts) {
  const c1 = d.color, warm = "#FBFAF7", tint = shade(d.color, 0.92), ink = "#1B2330", soft = "#5C6675";
  const css = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
*{box-sizing:border-box;font-family:Inter,Arial,sans-serif;margin:0;-webkit-tap-highlight-color:transparent}
body{background:${warm};color:${ink}}
.wrap{max-width:1140px;margin:0 auto;padding:0 24px}
header{position:sticky;top:0;z-index:40;background:${warm}E6;backdrop-filter:blur(12px)}
.hrow{display:flex;align-items:center;justify-content:space-between;padding:15px 0}
.hbrand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:16px}
.hbrand img{max-height:44px;max-width:150px}
.callbtn{background:${c1};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:99px;box-shadow:0 10px 26px ${c1}3D}
.hero{padding:46px 0 64px}
.hgrid{display:grid;gap:46px;align-items:center}
@media(min-width:920px){.hgrid{grid-template-columns:1.04fr 432px}}
.pill{display:inline-block;background:#fff;border-radius:99px;padding:9px 18px;font-size:12.5px;font-weight:700;color:${shade(d.color, -0.4)};box-shadow:0 8px 22px rgba(27,35,48,.08);margin-bottom:20px}
.hero h1{font-size:clamp(38px,5.4vw,60px);line-height:1.05;font-weight:800;letter-spacing:-1.5px;max-width:620px}
.hero h1 em{color:${c1};font-style:normal}
.hero .lede{color:${soft};font-weight:500;font-size:clamp(16px,2vw,18px);margin-top:18px;max-width:480px;line-height:1.7}
.hcta{margin-top:28px;display:flex;gap:10px;flex-wrap:wrap}
.btn{display:inline-block;font-weight:800;font-size:16px;padding:16px 30px;border-radius:99px;text-decoration:none}
.btn.p{background:${c1};color:#fff;box-shadow:0 16px 40px ${c1}45}
.btn.g{background:#fff;color:${ink};box-shadow:0 8px 22px rgba(27,35,48,.09)}
.qcard{background:#fff;border-radius:30px;padding:12px;box-shadow:0 44px 100px rgba(27,35,48,.16);border:1px solid #00000008}
.qcard .qtag{display:flex;align-items:center;gap:8px;font-weight:800;font-size:13px;color:${ink};padding:8px 8px 12px}
.qcard .qtag .dot{width:9px;height:9px;border-radius:50%;background:#22C55E;box-shadow:0 0 0 4px #22C55E22}
.qcard iframe{width:100%;height:512px;border:0;border-radius:22px;display:block}
.trust{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;padding:0}
.trust span{background:#fff;border-radius:99px;padding:9px 16px;font-size:13px;font-weight:700;color:#465060;box-shadow:0 6px 18px rgba(27,35,48,.06)}
section{padding:64px 0}
.head{text-align:center}
.eye{color:${c1};font-weight:800;font-size:12px;letter-spacing:3px;text-transform:uppercase}
.t{font-size:clamp(28px,4.4vw,42px);font-weight:800;letter-spacing:-.8px;line-height:1.12;margin-top:10px}
.t em{color:${c1};font-style:normal}
.sub{color:${soft};text-align:center;font-weight:500;margin:12px auto 0;max-width:560px;font-size:15.5px;line-height:1.7}
.svcs{display:grid;gap:18px;margin-top:40px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.svc{background:#fff;border-radius:26px;padding:28px;box-shadow:0 16px 44px rgba(27,35,48,.07);border:1px solid #0000000a;transition:transform .2s}
.svc:hover{transform:translateY(-4px)}
.svc .ic{width:56px;height:56px;border-radius:18px;background:${tint};display:flex;align-items:center;justify-content:center;font-size:27px}
.svc h3{font-size:18px;font-weight:800;margin:16px 0 7px;letter-spacing:-.3px}
.svc p{color:${soft};font-size:14px;font-weight:500;line-height:1.65}
.about{background:#fff;border-radius:36px;padding:48px clamp(24px,5vw,60px);box-shadow:0 24px 70px rgba(27,35,48,.08);display:grid;gap:30px;align-items:center}
@media(min-width:820px){.about{grid-template-columns:auto 1fr}}
.about .badge{width:118px;height:118px;border-radius:30px;background:${tint};display:flex;align-items:center;justify-content:center;font-size:52px;margin:0 auto}
.about .eye{text-align:left}
.about h2{text-align:left;margin-top:8px}
.about p.body{color:#3A4252;font-size:16px;font-weight:500;line-height:1.85;margin-top:14px}
.gal{display:grid;gap:16px;margin-top:38px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.gal img{width:100%;height:236px;object-fit:cover;border-radius:24px;box-shadow:0 16px 44px rgba(27,35,48,.1)}
.ctacard{background:linear-gradient(135deg,${c1},${shade(d.color, -0.28)});border-radius:40px;color:#fff;text-align:center;padding:64px clamp(24px,6vw,70px)}
.ctacard h2{font-size:clamp(28px,4.6vw,44px);font-weight:800;letter-spacing:-.5px;line-height:1.12}
.ctacard p{opacity:.92;font-weight:500;margin-top:12px;font-size:16px}
.ctacard a{display:inline-block;margin:26px 6px 0;font-weight:800;font-size:16px;padding:16px 30px;border-radius:99px;text-decoration:none}
.ctacard .a1{background:#fff;color:${c1}}
.ctacard .a2{background:#1FAF52;color:#fff}
footer{padding:42px 22px ${opts.backAlto ? "115px" : "46px"};text-align:center;color:#9AA3B2;font-size:13px;font-weight:500;line-height:2}
footer b{color:${ink};font-size:15px}`;
  return `${headBase(d, css)}
${ribbonHtml(opts)}
<header><div class="wrap hrow">
  <span class="hbrand">${d.logo ? `<img src="${d.logo}" alt="${esc(d.biz)}">` : esc(d.biz)}</span>
  ${d.phone ? `<a class="callbtn" href="tel:+1${d.phone}">📞 ${pretty(d.phone)}</a>` : ""}
</div></header>
<div class="hero"><div class="wrap"><div class="hgrid">
  <div>
    <span class="pill">🏡 Bienes raíces${d.city ? ` · ${esc(d.city)}` : ""}</span>
    <h1>${d.hero || `Vende tu casa.<br><em>Sin estrés.</em>`}</h1>
    <p class="lede">${esc(d.tagline) || "Conoce el valor de tu casa con ventas reales cercanas — aquí mismo, gratis y sin que nadie te visite."}</p>
    <div class="hcta"><a class="btn p" href="#cotiza">Valúa gratis</a>${d.phone ? `<a class="btn g" href="tel:+1${d.phone}">📞 Llámanos</a>` : ""}</div>
  </div>
  <div class="qcard" id="cotiza">
    <div class="qtag"><span class="dot"></span> Valúa tu casa aquí — gratis</div>
    <iframe src="/w/${esc(d.slug)}" loading="lazy" title="Valuador"></iframe>
  </div>
</div>
<div class="trust" style="margin-top:36px">${statsCells(d).map(([b, s]) => `<span>✓ ${b} ${s}</span>`).join("")}<span>✓ Valuación gratis</span></div>
</div></div>
<div class="wrap"><section>
  <div class="head"><p class="eye">Servicios</p><h2 class="t">¿Cómo te <em>ayudamos</em>?</h2></div>
  <div class="svcs">${d.services.map(([ic, t, x]) => `<div class="svc"><div class="ic">${ic}</div><h3>${esc(t)}</h3><p>${esc(x)}</p></div>`).join("")}</div>
</section></div>
${d.about ? `<div class="wrap"><section style="padding-top:6px"><div class="about">
  <div class="badge">🏡</div>
  <div><p class="eye">Quiénes somos</p><h2 class="t">Nuestra <em>historia</em></h2><p class="body">${esc(d.about)}</p></div>
</div></section></div>` : ""}
${d.photos.length ? `<div class="wrap"><section style="padding-top:6px">
  <div class="head"><p class="eye">Galería</p><h2 class="t">Trabajos <em>recientes</em></h2></div>
  <div class="gal">${d.photos.map((p) => `<img loading="lazy" src="${esc(p)}" alt="">`).join("")}</div>
</section></div>` : ""}
<div class="wrap"><section style="padding-top:6px"><div class="ctacard">
  <h2>¿Listo para empezar?</h2>
  <p>Tu valuación está a 60 segundos de distancia.</p>
  <a class="a1" href="#cotiza">Valúa ahora</a>${d.phone ? `<a class="a2" href="https://wa.me/1${d.phone}">💬 WhatsApp</a>` : ""}
</div></section></div>
<footer>${footerBits(d)}</footer>
${backAltoHtml(opts)}
</body></html>`;
}

const TEMPLATES = { 1: t1, 2: t2, 3: t3 };

export function renderSite(data, opts = {}) {
  const d = {
    services: DEFAULT_SERVICES,
    photos: [],
    color: "#B30F24",
    ...data,
  };
  const fn = TEMPLATES[String(d.template || "1")] || t1;
  return fn(d, opts);
}
