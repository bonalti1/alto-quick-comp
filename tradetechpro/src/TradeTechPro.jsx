import React, { useState, useMemo, useRef, useEffect } from "react";

/* ─── Brand tokens (Quick Comp: navy + gold) ─── */
const C = {
  navy: "#15244C",      // primary navy — header bar, dark cards, headings
  navyDeep: "#0B1733",  // deepest navy — gradients, deep panels
  orange: "#C9973A",    // gold accent — section labels, $/sf, highlights
  orangeSoft: "#F7EFD8",// soft gold tint — accent card backgrounds
  bg: "#F1F4FA",        // app background
  card: "#FFFFFF",
  line: "#E4E8F0",
  slate: "#6E7891",
  green: "#1E9E5A",
  greenSoft: "#E6F5EC",
  red: "#D64545",
  redSoft: "#FBEAEA",
  yellow: "#C9973A",    // align legacy "yellow" to brand gold
  yellowSoft: "#F7EFD8",
};

/* ─── Quick Comp visual language — scoped to the comps screens ───
   Module-scope (static) so components that use it can live at module scope too
   and not remount their children on every parent render. */
const QC = {
  navy: "#1B2A5C", navyDeep: "#111B42",
  cardGrad: "linear-gradient(135deg,#162655,#223B72)",
  headGrad: "linear-gradient(135deg,#07162D 0%,#111B42 62%,#1D2F5A 100%)",
  gold: "#D7B665", goldHi: "#E6BF6A", goldLine: "#E3B54E",
  bg: "#F0F4FA", line: "#dde4f0", line2: "#D9E1EF",
  muted: "#9aaac8", muted2: "#6b7db3", body: "#4a5a7a",
  green: "#1E9E5A", red: "#E8442E",
};

/* Range slider — MUST be module-scope: when it was defined inside TradeTechPro
   its function identity changed every render, so React remounted the <input>
   mid-drag and the gesture died after one step. */
const Slider = ({ label, value, display, min, max, step, onChange }) => {
  // Tap the value to type an exact number — the slider stays for coarse moves
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => {
    setEditing(false);
    const n = parseFloat(String(draft).replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
  };
  return (
    <div className="mb-3.5">
      <div className="flex justify-between items-baseline mb-1.5">
        <span style={{ color: QC.muted2, fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>{label}</span>
        {editing ? (
          <input autoFocus inputMode="decimal" value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
            className="text-right font-extrabold outline-none"
            style={{ color: QC.navy, fontSize: 15, width: 110, background: "#fff", border: `1.5px solid ${QC.goldLine}`, borderRadius: 8, padding: "2px 8px" }} />
        ) : (
          <button onClick={() => { setDraft(String(value)); setEditing(true); }} title="Edit"
            className="font-extrabold active:opacity-70" style={{ color: QC.navy, fontSize: 15, background: "none", border: "none", cursor: "pointer", padding: 0, borderBottom: `1.5px dashed ${QC.goldLine}` }}>
            {display}
          </button>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full" style={{ accentColor: QC.gold, height: 4 }} />
    </div>
  );
};

/* ─── Consulting-document primitives (CMA report + appraisal packet) ───
 * Serif display, hairline rules, numbered small-caps sections — the visual
 * language of a top-tier advisory deliverable, not a phone screenshot. */
const DOC = { serif: "Georgia, 'Times New Roman', serif", hair: "#DCE1EA", ink: "#0F1B33", mut: "#5A6478", body: "#2A3550" };
/* Blend a hex color toward black (f<0) or white (f>0) — derives the darker
 * band and the light tint from the realtor's single brand color. */
const shadeHex = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const t = f < 0 ? 0 : 255, p = Math.abs(f);
  const r = Math.round(((n >> 16) & 255) + (t - ((n >> 16) & 255)) * p);
  const g = Math.round(((n >> 8) & 255) + (t - ((n >> 8) & 255)) * p);
  const b = Math.round((n & 255) + (t - (n & 255)) * p);
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
};
const DocSect = ({ n, title, children, accent }) => (
  <div className="mt-4">
    <div className="doc-h flex items-baseline gap-2 pb-1.5 mb-2.5" style={{ borderBottom: `1px solid ${DOC.hair}` }}>
      <span style={{ color: accent || QC.gold, fontSize: 11, fontWeight: 700, fontFamily: DOC.serif }}>{n}</span>
      <span style={{ color: DOC.ink, fontSize: 10, fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase" }}>{title}</span>
    </div>
    {children}
  </div>
);
const DocStat = ({ label, value, sub, big, first }) => (
  <div className="flex-1 min-w-0" style={{ borderLeft: first ? "none" : `1px solid ${DOC.hair}`, paddingLeft: first ? 0 : 12, paddingRight: 8 }}>
    <p style={{ color: DOC.mut, fontSize: 7.5, fontWeight: 800, letterSpacing: "0.16em", textTransform: "uppercase" }}>{label}</p>
    <p style={{ color: DOC.ink, fontSize: big ? 21 : 13.5, fontWeight: big ? 400 : 700, fontFamily: DOC.serif, marginTop: 3, lineHeight: 1.15 }}>{value}</p>
    {sub && <p style={{ color: DOC.mut, fontSize: 9, fontWeight: 600, marginTop: 2 }}>{sub}</p>}
  </div>
);
const DocFoot = ({ left, right }) => (
  <div className="flex items-center justify-between gap-3 px-5 py-2.5" style={{ borderTop: `1px solid ${DOC.hair}` }}>
    <span className="truncate" style={{ color: DOC.mut, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" }}>{left}</span>
    <span className="shrink-0" style={{ color: DOC.mut, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" }}>{right}</span>
  </div>
);
/* Cover page: the street photo with the address set over it. If the photo
 * can't load it degrades to a clean navy cover — never a broken layout. */
const DocCover = ({ ll, kicker, title, grad, tint }) => (
  <div className="relative overflow-hidden" style={{ background: grad || QC.headGrad }}>
    {ll && (
      <img src={`/api/streetview?lat=${ll.lat}&lng=${ll.lng}`} alt=""
        onError={(e) => { e.currentTarget.style.display = "none"; }}
        className="absolute inset-0 w-full h-full" style={{ objectFit: "cover" }} />
    )}
    <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(11,23,51,0.10) 25%, rgba(11,23,51,0.60) 60%, rgba(9,18,40,0.92) 100%)" }} />
    <div className="doc-cover relative px-5 pb-4" style={{ paddingTop: 78 }}>
      <p style={{ color: tint || QC.goldHi, fontSize: 8.5, fontWeight: 800, letterSpacing: "0.24em", textTransform: "uppercase" }}>{kicker}</p>
      <h1 style={{ fontFamily: DOC.serif, color: "#fff", fontSize: 23, lineHeight: 1.25, marginTop: 4, fontWeight: 400 }}>{title}</h1>
    </div>
  </div>
);

/* ─── Logo (Quick Comp QC monogram) ───
   color="#fff" (or any light value) renders the white mark for navy backgrounds;
   default renders the navy mark for light backgrounds. */
const Logo = ({ size = 44, color = null }) => {
  const light = !!color && color.toLowerCase() !== C.navy.toLowerCase();
  return (
    <img
      src={light ? "/quick-comp-mark-white.png" : "/quick-comp-mark-navy.png"}
      alt="Quick Comp"
      width={size}
      height={size}
      draggable={false}
      style={{ display: "block", objectFit: "contain" }}
    />
  );
};

/* ─── Google Maps JS loader (loaded once, key fetched from the server) ─── */
let _gmapsPromise = null;
let _gmapsAuthFailed = false;
const _authFailListeners = new Set();
if (typeof window !== "undefined") {
  // Google calls this globally when the key is invalid/unauthorized.
  window.gm_authFailure = () => { _gmapsAuthFailed = true; _authFailListeners.forEach((fn) => fn()); };
}
function loadGoogleMaps() {
  if (_gmapsPromise) return _gmapsPromise;
  _gmapsPromise = fetch("/api/mapconfig")
    .then((r) => r.json())
    .then(({ key }) => {
      if (!key) throw new Error("no-map-key");
      if (window.google?.maps) return window.google.maps;
      return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=quarterly`;
        s.async = true;
        s.onload = () => (window.google?.maps ? resolve(window.google.maps) : reject(new Error("gmaps-load")));
        s.onerror = () => reject(new Error("gmaps-load"));
        document.head.appendChild(s);
      });
    });
  return _gmapsPromise;
}

/* ─── Interactive in-app comparables map (stays inside Quick Comp) ─── */
function CompMap({ subjectLL, comps, satellite, focus, lang, fallbackSrc }) {
  const elRef = useRef(null);
  const st = useRef({ map: null, maps: null, markers: [], info: null, dirSvc: null, dirRend: null });
  const [failed, setFailed] = useState(_gmapsAuthFailed);

  useEffect(() => {
    // Fall back to the static map if Google rejects the key (auth failure).
    const onAuthFail = () => setFailed(true);
    _authFailListeners.add(onAuthFail);
    return () => { _authFailListeners.delete(onAuthFail); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps().then((maps) => {
      if (cancelled || !elRef.current) return;
      const s = st.current;
      s.maps = maps;
      const map = new maps.Map(elRef.current, {
        mapTypeId: satellite ? "hybrid" : "roadmap",
        disableDefaultUI: true, zoomControl: true, gestureHandling: "greedy", clickableIcons: false,
      });
      s.map = map;
      s.info = new maps.InfoWindow();
      s.dirRend = new maps.DirectionsRenderer({ map, suppressMarkers: true, preserveViewport: true, polylineOptions: { strokeColor: "#1B2A5C", strokeWeight: 5 } });
      s.dirSvc = new maps.DirectionsService();
      const bounds = new maps.LatLngBounds();
      if (subjectLL) {
        new maps.Marker({ position: subjectLL, map, zIndex: 999, title: lang === "es" ? "Propiedad" : "Subject",
          label: { text: "S", color: "#fff", fontWeight: "700", fontSize: "12px" },
          icon: { path: maps.SymbolPath.CIRCLE, scale: 13, fillColor: "#E8442E", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 3 } });
        bounds.extend(subjectLL);
      }
      comps.forEach((c, i) => {
        if (c.latitude == null || c.longitude == null) return;
        const pos = { lat: c.latitude, lng: c.longitude };
        const mk = new maps.Marker({ position: pos, map,
          label: { text: String(i + 1), color: "#fff", fontWeight: "700", fontSize: "11px" },
          icon: { path: maps.SymbolPath.CIRCLE, scale: 11, fillColor: "#1B2A5C", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 } });
        const price = c.soldPrice ? "$" + Number(c.soldPrice).toLocaleString("en-US") : "";
        const facts = [
          c.beds != null ? `${c.beds} ${lang === "es" ? "rec" : "bd"}` : null,
          c.baths != null ? `${c.baths} ${lang === "es" ? "baños" : "ba"}` : null,
          c.sqft ? `${Number(c.sqft).toLocaleString("en-US")} ${lang === "es" ? "pie²" : "sqft"}` : null,
        ].filter(Boolean).join(" · ");
        const html = `<div style="font-family:Inter,sans-serif;min-width:180px;max-width:210px">`
          + `<img src="/api/streetview?lat=${c.latitude}&lng=${c.longitude}" alt="" style="width:100%;height:104px;object-fit:cover;border-radius:8px;margin-bottom:6px;display:block;background:#eef1f7" onerror="this.style.display='none'">`
          + `<div style="font-weight:800;color:#15244C;font-size:13px">${c.address || ""}</div>`
          + `<div style="color:#1B2A5C;font-weight:800;font-size:15px;margin-top:2px">${price}</div>`
          + (facts ? `<div style="color:#6E7891;font-size:11px;margin-top:2px">${facts}</div>` : "")
          + (subjectLL ? `<button id="qc-dir-${i}" style="margin-top:8px;background:#15244C;color:#fff;border:none;border-radius:8px;padding:7px 12px;font-weight:700;font-size:12px;cursor:pointer">${lang === "es" ? "Cómo llegar" : "Directions"}</button>` : "")
          + `</div>`;
        mk.addListener("click", () => {
          s.info.setContent(html); s.info.open(map, mk); map.panTo(pos);
          if (subjectLL) maps.event.addListenerOnce(s.info, "domready", () => {
            const b = document.getElementById(`qc-dir-${i}`);
            if (b) b.onclick = () => s.dirSvc.route({ origin: subjectLL, destination: pos, travelMode: maps.TravelMode.DRIVING },
              (res, status) => { if (status === "OK") s.dirRend.setDirections(res); });
          });
        });
        s.markers[i] = mk;
        bounds.extend(pos);
      });
      if (!bounds.isEmpty()) map.fitBounds(bounds, 48);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []); // initialize once

  useEffect(() => {
    const s = st.current;
    if (s.map && s.maps) s.map.setMapTypeId(satellite ? "hybrid" : "roadmap");
  }, [satellite]);

  useEffect(() => {
    const s = st.current;
    if (!focus || !s.map || !s.maps) return;
    const mk = s.markers[focus.i];
    if (mk) { s.map.panTo(mk.getPosition()); s.map.setZoom(Math.max(s.map.getZoom() || 0, 17)); s.maps.event.trigger(mk, "click"); }
  }, [focus]);

  if (failed) {
    return <img src={fallbackSrc} alt="" className="absolute inset-0 w-full h-full" style={{ objectFit: "cover" }} onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  }
  return <div ref={elRef} className="absolute inset-0 w-full h-full" />;
}

/* ─── Translations ─── */
const TR = {
  es: {
    accepted: "Aceptado",
    estimateSt: "Estimado", inProgress: "En Progreso",
    done: "Terminado", paid: "Pagado",
    demoBanner: "🧪 Modo demo — tus datos no se guardan en la nube. ¿Cliente? Entra con tu link de WhatsApp.",
    demoLimit: "El modo demo incluye 10 valuaciones de prueba y ya las usaste. Los clientes de Quick Comp valúan sin límite.",
    measuring1: "Buscando la propiedad…", measuring2: "Analizando ventas comparables…", measuring3: "Calculando el valor…",
    beds: "Recámaras", baths: "Baños", builtIn: "Construida",
    useMyLocation: "Usar mi ubicación", myLocation: "Mi ubicación", locating: "Buscando tu ubicación…",
    cmpValue: "Valor estimado de mercado", cmpDone: "Valor listo",
    cmpConfStrong: "Confianza alta", cmpConfGood: "Confianza buena", cmpConfLimited: "Confianza limitada", cmpConfLow: "Confianza baja",
    cmpSubject: "Propiedad evaluada", cmpComps: "Ventas comparables", cmpSold: "Vendida", cmpPerSqft: "/pie²",
    cmpMatch: "coincidencia", cmpMap: "Mapa de comparables",
    cmpDisc: "Estimado basado en ventas recientes comparables — no es un avalúo.",
    cmpNone: "No se encontraron ventas comparables cerca. Prueba otra dirección.",
    cmpNew: "Nueva búsqueda", cmpExcluded: "Atípico", cmpSqft: "pie²",
    cmpStart: "Empieza con una dirección. Buscaremos ventas cercanas y te daremos un valor de mercado.",
    locErr: "No pude obtener tu ubicación. Activa el GPS y permite el acceso.",
    fenceDrawn: "Cerca medida",
    noParcel: "Sin línea de propiedad para esta dirección — dibuja la cerca en la foto",
  },
  en: {
    accepted: "Accepted",
    estimateSt: "Estimate", inProgress: "In Progress",
    done: "Done", paid: "Paid",
    demoBanner: "🧪 Demo mode — your data isn't saved to the cloud. Client? Enter with your WhatsApp link.",
    demoLimit: "The demo includes 10 trial valuations and you've used them. Quick Comp clients value with no limits.",
    measuring1: "Finding the property…", measuring2: "Analyzing comparable sales…", measuring3: "Calculating the value…",
    beds: "Bedrooms", baths: "Baths", builtIn: "Built",
    useMyLocation: "Use my location", myLocation: "My location", locating: "Finding your location…",
    cmpValue: "Estimated Market Value", cmpDone: "Value ready",
    cmpConfStrong: "High confidence", cmpConfGood: "Good confidence", cmpConfLimited: "Limited confidence", cmpConfLow: "Low confidence",
    cmpSubject: "Subject Property", cmpComps: "Sold Comparables", cmpSold: "Sold", cmpPerSqft: "/sq ft",
    cmpMatch: "match", cmpMap: "Comparable Map",
    cmpDisc: "Estimate based on recent comparable sales — not an appraisal.",
    cmpNone: "No comparable sales found nearby. Try another address.",
    cmpNew: "New search", cmpExcluded: "Outlier", cmpSqft: "sq ft",
    cmpStart: "Start with a property address. We'll find nearby sales and shape a market value.",
    locErr: "Couldn't get your location. Turn on GPS and allow access.",
    fenceDrawn: "Fence measured",
    noParcel: "No property line for this address — draw the fence on the photo",
  },
};

/* ─── Seed data ─── */
const seedCustomers = [
  { id: 1, name: "María Garza", phone: "(956) 555-0143", addr: "456 Oak Dr, Rio Grande City, TX" },
  { id: 2, name: "José Pérez", phone: "(956) 555-0188", addr: "210 Mesquite Ln, Roma, TX" },
  { id: 3, name: "Ana Ríos", phone: "(956) 555-0102", addr: "88 Palma St, La Grulla, TX" },
];
const seedJobs = [];

/* Demo-mode seller leads — shows what the Leads inbox looks like before an
 * account exists. Real accounts fetch their actual leads from the server. */
const DEMO_LEADS = [
  { id: "demo1", name: "Carlos Pérez", phone: "(956) 555-0188", address: "502 Britton Ave, Rio Grande City, TX", info: { low: 385000, high: 412000 }, status: "new", created_at: new Date(Date.now() - 2 * 36e5).toISOString() },
  { id: "demo2", name: "Ana Salinas", phone: "(956) 555-0121", address: "118 Palm Blvd, Roma, TX", info: { low: 214000, high: 236000 }, status: "contacted", created_at: new Date(Date.now() - 26 * 36e5).toISOString() },
  { id: "demo3", name: "Rogelio Treviño", phone: "(956) 555-0177", address: "44 Encino Dr, Rio Grande City, TX", info: { low: 305000, high: 332000, note: "Quiere vender en agosto — mandarle el CMA." }, status: "interested", created_at: new Date(Date.now() - 40 * 864e5).toISOString() },
];

const fmt = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

/* ─── Property lookup (DEMO — simulated data; swap for a property data API) ─── */
const MAT_PRICES = { three: 95, arch: 110, metal: 250, tile: 350 };
const FENCE_PRICES = { cedar: 28, vinyl: 38, chain: 18, alum: 45, custom: 30 };

// Address pool for the built-in suggestion list (only `addr` is consumed by the live screens).
const MOCK_PROPERTIES = [
  { addr: "456 Oak Dr, Rio Grande City, TX", beds: 3, baths: 2, sqft: 1850, year: 2004 },
  { addr: "210 Mesquite Ln, Roma, TX", beds: 4, baths: 2, sqft: 2400, year: 1998 },
  { addr: "88 Palma St, La Grulla, TX", beds: 2, baths: 1, sqft: 1240, year: 1987 },
  { addr: "1204 Cenizo Ct, Rio Grande City, TX", beds: 4, baths: 3, sqft: 2980, year: 2019 },
  { addr: "35 Rancho Viejo Rd, Garciasville, TX", noData: true },
];

const hashAddr = (s) => { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 99991; return h; };

/* ─── Trace geometry ───
 * The trace image is a 640×400 static map at scale 2 (1280×800 natural px).
 * Traced points are stored as [lat, lng] so they survive zooming and panning;
 * they're projected to image pixels for display via Web Mercator. */
const TRACE_W = 1280, TRACE_H = 800;
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const llToPx = ([lat, lng], v) => {
  const worldN = 256 * Math.pow(2, v.zoom) * 2; // natural px per 360°
  return [
    ((lng - v.lng) / 360) * worldN + TRACE_W / 2,
    ((mercY(v.lat) - mercY(lat)) / (2 * Math.PI)) * worldN + TRACE_H / 2,
  ];
};
const pxToLl = (x, y, v) => {
  const worldN = 256 * Math.pow(2, v.zoom) * 2;
  const lng = v.lng + ((x - TRACE_W / 2) * 360) / worldN;
  const my = mercY(v.lat) - ((y - TRACE_H / 2) * 2 * Math.PI) / worldN;
  const lat = ((2 * Math.atan(Math.exp(my)) - Math.PI / 2) * 180) / Math.PI;
  return [lat, lng];
};
const traceAreaSqft = (pts) => {
  if (pts.length < 3) return 0;
  const R = 6378137, k = Math.PI / 180;
  const [lat0, lng0] = pts[0];
  const xy = pts.map(([la, ln]) => [(ln - lng0) * k * R * Math.cos(lat0 * k), (la - lat0) * k * R]);
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    a += x1 * y2 - x2 * y1;
  }
  return (Math.abs(a) / 2) * 10.7639;
};
const distFt = (a, b) => {
  const k = Math.PI / 180, R = 6378137;
  return Math.hypot((b[1] - a[1]) * k * R * Math.cos(a[0] * k), (b[0] - a[0]) * k * R) * 3.28084;
};
const zoomForBbox = (b) => {
  const [s, w, n, e] = b;
  const ctr = (s + n) / 2;
  const span = Math.max(n - s, (e - w) * Math.cos((ctr * Math.PI) / 180), 0.00005) * 2.2;
  return Math.min(Math.max(Math.floor(Math.log2((360 * (640 / 256)) / span)), 17), 21);
};

// Offline/demo comps: a believable subject + ranked sold comps and a weighted
// value, shaped exactly like the live /api/lookup comp response.
const mockLookup = (addr) => new Promise((resolve) => {
  setTimeout(() => {
    const h = hashAddr(addr.toLowerCase());
    const baseLat = 26.21 + ((h % 200) / 10000), baseLng = -98.23 - ((h % 200) / 10000);
    const subjSqft = 1400 + (h % 1600);
    const subjYear = 1985 + (h % 38);
    const beds = 3 + (h % 3), baths = 2 + (h % 2);
    const psf = 150 + (h % 90); // market $/sq ft
    const comps = Array.from({ length: 6 }, (_, i) => {
      const g = (h >> (i + 1)) % 100;
      const sqft = subjSqft + (g - 50) * 6;
      const ppsf = psf + (g % 25) - 12;
      const soldPrice = Math.round((sqft * ppsf) / 1000) * 1000;
      const dt = new Date(2026, 0, 1); dt.setDate(dt.getDate() - (20 + g * 2));
      return {
        address: `${100 + g} ${["Oak", "Pecan", "Cenizo", "Mesquite", "Palm", "Sabal"][i]} ${["Dr", "Ln", "Ct", "Blvd"][g % 4]}, TX`,
        soldPrice, sqft, beds: beds + ((g % 3) - 1), baths,
        soldDate: dt.toISOString().slice(0, 10), yearBuilt: Math.min(subjYear + ((g % 20) - 10), new Date().getFullYear()),
        distance: +((0.2 + (g % 18) / 10)).toFixed(2),
        latitude: +(baseLat + (g - 50) / 4000).toFixed(5), longitude: +(baseLng + (g - 50) / 4000).toFixed(5),
        matchScore: Math.max(45, 98 - i * 6), ppsf: Math.round(ppsf),
      };
    });
    const value = Math.round((subjSqft * psf) / 1000) * 1000;
    resolve({
      found: true, source: "demo", addr, lat: baseLat, lng: baseLng,
      value, low: Math.round(value * 0.94 / 1000) * 1000, high: Math.round(value * 1.06 / 1000) * 1000,
      confidence: "good", method: "weighted_sold_price_per_sqft", avgPpsf: psf,
      compsUsed: comps.length, radius: 2, lookbackLabel: "6 months",
      subject: {
        address: addr, beds, baths, sqft: subjSqft, yearBuilt: subjYear, latitude: baseLat, longitude: baseLng,
        // county-record extras so the demo shows the full tax report
        owner: ["M. & L. García", "R. Treviño", "J. & A. Salinas", "The Martínez Family Trust"][h % 4],
        ownerOccupied: h % 3 !== 0,
        assessedValue: Math.round(value * 0.86 / 1000) * 1000, assessedYear: 2025,
        assessedLand: Math.round(value * 0.18 / 1000) * 1000, assessedImprovements: Math.round(value * 0.68 / 1000) * 1000,
        annualTax: Math.round(value * 0.017 / 10) * 10, taxYear: 2025,
        taxHistory: [2025, 2024, 2023].map((y, i) => ({ year: y, total: Math.round(value * 0.017 * (1 - i * 0.06) / 10) * 10 })),
        county: "Starr County", subdivision: ["Las Lomas", "El Sabino", "Vista Real"][h % 3],
        propertyType: "Single Family", lotSize: 6000 + (h % 5000),
        lastSalePrice: Math.round(value * 0.72 / 1000) * 1000, lastSaleDate: `${2015 + (h % 8)}-0${1 + (h % 9)}-15`,
      },
      comps,
    });
  }, 2600);
});

/* ─── Shared UI ─── */
const Btn = ({ children, onClick, color = C.orange, textColor = "#fff", style = {}, disabled }) => (
  <button onClick={onClick} disabled={disabled} className="w-full rounded-xl font-bold text-base tracking-wide active:scale-95 transition-transform"
    style={{ background: disabled ? C.line : color, color: disabled ? C.slate : textColor, padding: "16px", fontFamily: "'Inter', sans-serif", fontSize: 19, letterSpacing: "0.04em", border: "none", ...style }}>
    {children}
  </button>
);

const Field = ({ label, value, onChange, type = "text", suffix, placeholder }) => (
  <label className="block mb-3">
    <span className="block text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: C.slate }}>{label}</span>
    <div className="flex items-center rounded-xl px-4" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
      <input type={type} inputMode={type === "number" ? "decimal" : undefined} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 py-3 text-lg font-semibold outline-none bg-transparent" style={{ color: C.navy }} />
      {suffix && <span className="text-sm font-semibold" style={{ color: C.slate }}>{suffix}</span>}
    </div>
  </label>
);

const Sel = ({ label, value, onChange, options }) => (
  <label className="block mb-3">
    <span className="block text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: C.slate }}>{label}</span>
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="w-full py-3 px-4 text-lg font-semibold rounded-xl outline-none"
      style={{ color: C.navy, background: "#fff", border: `1.5px solid ${C.line}`, WebkitAppearance: "none" }}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </label>
);

const StatusPill = ({ status, t }) => {
  const map = {
    estimate: [C.yellowSoft, C.yellow, t.estimateSt],
    accepted: [C.orangeSoft, C.orange, t.accepted],
    inprogress: [C.orangeSoft, C.orange, t.inProgress],
    done: [C.yellowSoft, C.yellow, t.done],
    paid: [C.greenSoft, C.green, t.paid],
  };
  const [bg, fg, label] = map[status] || map.estimate;
  return <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: bg, color: fg }}>{label}</span>;
};

/* Saved contractor profile — survives closing the app */
const savedProfile = (() => {
  try { return JSON.parse(localStorage.getItem("ttp_profile") || "null") || {}; } catch { return {}; }
})();

/* Demo entrance for the sales deck (/?demo=roof): open straight on the
 * quote screen with an ephemeral demo profile — nothing is saved, and a
 * real signed-in user's data is never touched. */
const WANT_ROOF = /[?&]demo=(roof|app|qc)/.test(window.location.search);
const DEMO_ROOF = WANT_ROOF && !savedProfile.biz;

/* ─── Main App ─── */
/* Maps a /api/lookup comps response to the app's lookup shape — shared by the
 * initial search and the radius re-search so both produce identical state. */
function mapCompsLookup(j, addr) {
  return {
    addr: j.addr || addr, lat: j.lat ?? null, lng: j.lng ?? null,
    parcel: j.parcel || null, // fence flow still uses the parcel boundary
    value: j.value ?? null,
    low: j.valueRange?.low ?? null, high: j.valueRange?.high ?? null,
    confidence: j.confidence || null, method: j.method || null,
    avgPpsf: j.avgPpsf ?? null, compsUsed: j.compsUsed ?? null, marketDriftMo: j.marketDriftMo ?? 0,
    radius: j.radius ?? null, lookbackLabel: j.lookbackLabel || null,
    subject: j.subject ? {
      address: j.subject.address || j.addr || addr,
      beds: j.subject.bedrooms ?? null, baths: j.subject.bathrooms ?? null,
      sqft: j.subject.squareFootage ?? null, yearBuilt: j.subject.yearBuilt ?? null,
      latitude: j.subject.latitude ?? null, longitude: j.subject.longitude ?? null,
      owner: j.subject.owner ?? null, assessedValue: j.subject.assessedValue ?? null,
      annualTax: j.subject.annualTax ?? null, taxYear: j.subject.taxYear ?? null,
      // full county record extras (owner/tax report on the Tax screen)
      assessedYear: j.subject.assessedYear ?? null,
      assessedLand: j.subject.assessedLand ?? null,
      assessedImprovements: j.subject.assessedImprovements ?? null,
      taxHistory: Array.isArray(j.subject.taxHistory) ? j.subject.taxHistory : [],
      ownerOccupied: j.subject.ownerOccupied ?? null,
      county: j.subject.county ?? null, subdivision: j.subject.subdivision ?? null,
      propertyType: j.subject.propertyType ?? null, lotSize: j.subject.lotSize ?? null,
      lastSalePrice: j.subject.lastSalePrice ?? null, lastSaleDate: j.subject.lastSaleDate ?? null,
    } : null,
    comps: Array.isArray(j.comps) ? j.comps : [],
    source: j.source || "live",
  };
}

/* Approximate average EFFECTIVE property-tax rates by state (share of market
 * value, statewide averages). Used only for the "(est.)" fallback when the
 * county record isn't available — real county data always wins. */
const TAX_RATE_BY_STATE = {
  NJ: 0.022, IL: 0.021, CT: 0.019, NH: 0.019, VT: 0.018, TX: 0.017, NE: 0.016, WI: 0.016,
  OH: 0.015, IA: 0.015, RI: 0.015, PA: 0.014, NY: 0.014, KS: 0.013, MI: 0.013, ME: 0.0125,
  SD: 0.012, AK: 0.012, MA: 0.0115, MN: 0.011, MD: 0.0105, MO: 0.01, ND: 0.01, OR: 0.0095,
  GA: 0.009, WA: 0.009, OK: 0.009, FL: 0.0085, VA: 0.0085, KY: 0.0085, IN: 0.0085, NC: 0.008,
  MS: 0.008, MT: 0.0075, NM: 0.0075, CA: 0.0075, TN: 0.0065, ID: 0.0065, AZ: 0.006, AR: 0.006,
  DE: 0.006, WY: 0.006, UT: 0.0055, NV: 0.0055, SC: 0.0055, LA: 0.0055, WV: 0.0055, DC: 0.0055,
  CO: 0.005, AL: 0.004, HI: 0.003,
};
const stateFromAddress = (addr) => (/\b([A-Z]{2})\s*\d{5}(?:-\d{4})?\b/.exec(String(addr || "")) || /,\s*([A-Z]{2})\s*$/.exec(String(addr || "").trim()) || [])[1] || null;

export default function TradeTechPro() {
  // Saved choice wins; first-ever open follows the phone's language (the
  // product serves English-speaking realtors as fully as Spanish-speaking).
  const [lang, setLang] = useState(savedProfile.lang || (/^es/i.test(navigator.language || "") ? "es" : "en"));
  const t = TR[lang];
  const welcomedInit = (() => { try { return !!localStorage.getItem("qc_welcomed"); } catch { return false; } })();
  const [screen, setScreen] = useState(WANT_ROOF ? "comps" : (welcomedInit ? "comps" : "welcome"));
  const [trade, setTrade] = useState(savedProfile.trade || "roofing");
  const [userName, setUserName] = useState(savedProfile.name || (DEMO_ROOF ? "María" : ""));
  const [bizName, setBizName] = useState(savedProfile.biz || (DEMO_ROOF ? "Casa Bella Realty (Demo)" : ""));
  const [userPhone, setUserPhone] = useState(savedProfile.phone || "");
  const [logo, setLogo] = useState(savedProfile.logo || null);
  const [bizEmail, setBizEmail] = useState(savedProfile.email || "");
  const [license, setLicense] = useState(savedProfile.license || "");
  const [market, setMarket] = useState(savedProfile.market || ""); // the realtor's city/area, from onboarding
  // The realtor's brand color — drives every client-facing document, so the
  // app's own navy/gold never appears on a client deliverable.
  const [brandColor, setBrandColor] = useState(savedProfile.brandColor || "");
  const [zelle, setZelle] = useState(savedProfile.zelle || "");
  const [myPrices, setMyPrices] = useState(savedProfile.prices || {});
  const logoIdRef = useRef(null); // server id for the currently uploaded logo

  // contractor's saved price beats the default
  const priceOf = (k) => (myPrices[k] != null && myPrices[k] !== "" ? Number(myPrices[k]) : MAT_PRICES[k]);

  const saveProfile = (patch) => {
    try {
      const cur = JSON.parse(localStorage.getItem("ttp_profile") || "{}");
      localStorage.setItem("ttp_profile", JSON.stringify({ ...cur, ...patch }));
    } catch { /* private mode */ }
  };

  const onLogoFile = (file) => {
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 240 / img.width, 120 / img.height);
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      let data = cv.toDataURL("image/png");
      if (data.length > 120000) data = cv.toDataURL("image/jpeg", 0.82);
      setLogo(data);
      logoIdRef.current = null;
      saveProfile({ logo: data });
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  };

  // Upload the logo (by content) so shared invoice pages can show it.
  // Re-uploads transparently if the server has restarted since last time.
  const ensureLogoId = async () => {
    if (!logo) return null;
    if (logoIdRef.current) return logoIdRef.current;
    try {
      const r = await fetch("/api/logo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: logo }),
      });
      if (r.ok) { const j = await r.json(); logoIdRef.current = j.id; return j.id; }
    } catch { /* backend unreachable — share without logo */ }
    return null;
  };
  const [customers, setCustomers] = useState(seedCustomers);
  const [jobs, setJobs] = useState(seedJobs);
  const [toast, setToast] = useState(null);

  /* ── Cloud account (invite link → everything saved on the server) ── */
  const [session, setSession] = useState(() => {
    const m = /[#&]session=([^&]+)/.exec(window.location.hash || "");
    if (m) {
      try { localStorage.setItem("alto_session", m[1]); } catch { /* private mode */ }
      window.history.replaceState(null, "", window.location.pathname);
      return m[1];
    }
    try { return localStorage.getItem("alto_session"); } catch { return null; }
  });
  const [cloudReady, setCloudReady] = useState(false);
  const [mySlug, setMySlug] = useState(null); // the account's widget slug (for the embed code)
  // sent client reports (rid -> open tracking); declared BEFORE the cloud-sync
  // effects below, which read them
  const [sentReports, setSentReports] = useState(() => { try { return JSON.parse(localStorage.getItem("qc_reports") || "[]"); } catch { return []; } });
  const [reportOpens, setReportOpens] = useState({});
  // "new views" dot on the Workspace tab: total opens the agent has already seen
  const [seenViews, setSeenViews] = useState(() => { try { return parseInt(localStorage.getItem("qc_seenviews") || "0", 10) || 0; } catch { return 0; } });
  const opensFetched = useRef(false);
  // Seller-lead inbox — surfaced by the navy "Leads" launcher on the front page,
  // whose badge shows how many are still pending (not yet contacted)
  const [leads, setLeads] = useState([]);
  const [hideInstall, setHideInstall] = useState(() => {
    try { return !!localStorage.getItem("alto_inst"); } catch { return true; }
  });
  const showInstallHint = !hideInstall
    && /iphone|ipad/i.test(navigator.userAgent || "")
    && !(window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone);

  const api = (path, opts = {}) => fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
      ...(opts.headers || {}),
    },
  });

  // On startup with a session: load my account and my saved data.
  // Cloud SAVING is enabled only after a successful load — otherwise a transient
  // offline-at-open would let a blind save push local data over newer cloud data.
  // So if the load fails (offline), we RETRY with backoff rather than giving up
  // for the whole session.
  useEffect(() => {
    if (!session) return;
    let cancelled = false, attempts = 0;
    const load = async () => {
      try {
        const r = await api("/api/me");
        if (r.status === 401) { try { localStorage.removeItem("alto_session"); } catch { /* ignore */ } setSession(null); return; }
        if (!r.ok) throw new Error("me " + r.status);
        const j = await r.json();
        if (cancelled) return;
        setMySlug(j.contractor?.slug || null);
        const p = j.contractor?.data?.profile || {};
        setBizName(p.biz || j.contractor.name || "");
        setUserName(p.name || "");
        setUserPhone(p.phone || j.contractor.phone || "");
        if (p.logo) setLogo(p.logo);
        if (p.lang) setLang(p.lang);
        if (p.trade) setTrade(p.trade);
        if (p.email) setBizEmail(p.email);
        if (p.license) setLicense(p.license);
        if (p.market) setMarket(p.market);
        if (p.brandColor) setBrandColor(p.brandColor);
        if (p.zelle) setZelle(p.zelle);
        if (p.prices) setMyPrices(p.prices);
        // Real accounts start clean — no demo data
        setCustomers(j.state?.customers || []);
        if (Array.isArray(j.state?.reports)) setSentReports(j.state.reports);
        setJobs(j.state?.jobs || []);
        if (!WANT_ROOF && welcomedInit) setScreen("comps");
        setCloudReady(true);
      } catch {
        // offline/transient — local data keeps working; retry so sync recovers
        if (!cancelled && attempts < 6) { attempts += 1; setTimeout(load, Math.min(3000 * attempts, 15000)); }
      }
    };
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Save to the cloud shortly after anything changes. The latest payload and a
  // "unsaved" flag live in refs so the background/close flush below can send them.
  const savePayloadRef = useRef(null);
  const saveDirtyRef = useRef(false);
  const warnedSaveRef = useRef(false);
  useEffect(() => {
    if (!session || !cloudReady) return;
    const payload = JSON.stringify({
      state: { customers, jobs, reports: sentReports.slice(0, 30) },
      profile: { profile: { name: userName, biz: bizName, phone: userPhone, logo, lang, trade, email: bizEmail, license, market, zelle, brandColor, prices: myPrices } },
    });
    savePayloadRef.current = payload;
    saveDirtyRef.current = true;
    const id = setTimeout(async () => {
      try {
        const r = await api("/api/state", { method: "PUT", body: payload });
        if (r.status === 401) { try { localStorage.removeItem("alto_session"); } catch { /* ignore */ } setSession(null); return; }
        if (r.ok) { saveDirtyRef.current = false; warnedSaveRef.current = false; return; }
        // Non-ok (e.g. 413 payload too large): tell the agent ONCE — silent
        // failure here is how a day's work quietly disappears.
        if (!warnedSaveRef.current) {
          warnedSaveRef.current = true;
          showToast("⚠️ " + (lang === "es" ? "No se pudo guardar en la nube" + (r.status === 413 ? " (imagen muy grande)" : "") : "Couldn't save to the cloud" + (r.status === 413 ? " (image too large)" : "")));
        }
      } catch { /* offline — stays dirty, retried on next change and on close */ }
    }, 1500);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, cloudReady, customers, jobs, sentReports, userName, bizName, userPhone, logo, lang, trade, bizEmail, license, market, zelle, brandColor, myPrices]);

  // Flush an unsaved change when the app is backgrounded or closed — the normal
  // mobile gesture (swipe away within the 1.5s debounce) otherwise loses the edit.
  useEffect(() => {
    const flush = () => {
      if (!session || !saveDirtyRef.current || !savePayloadRef.current) return;
      try {
        fetch("/api/state", {
          method: "PUT", keepalive: true,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
          body: savePayloadRef.current,
        });
        saveDirtyRef.current = false;
      } catch { /* nothing more we can do on unload */ }
    };
    const onVis = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // address lookup state (demo data for now)
  const [addrQ, setAddrQ] = useState("");
  const [measuring, setMeasuring] = useState(false);
  const [measurePhase, setMeasurePhase] = useState(0);
  const [lookup, setLookup] = useState(null);
  const [excludedComps, setExcludedComps] = useState({}); // address -> true (realtor curates the comp set)
  const [priceOverrides, setPriceOverrides] = useState({}); // address -> true MLS sold price entered by the realtor
  const [manualComps, setManualComps] = useState([]);       // comps the realtor added from their own MLS
  const [addComp, setAddComp] = useState(null);             // null | draft {address, price, sqft, beds, baths, soldDate}
  const [radiusPref, setRadiusPref] = useState("auto");     // comp search ring: "auto" (expands as needed) | 1 | 2 | 5 mi
  const [radiusBusy, setRadiusBusy] = useState(false);
  const [netCommPct, setNetCommPct] = useState(6);          // seller net sheet: commission %
  const [netClosePct, setNetClosePct] = useState(2);        // seller closing costs %
  const [netPayoff, setNetPayoff] = useState("");           // seller's mortgage payoff $
  const [netInclude, setNetInclude] = useState(false);      // include the net sheet in the shared report/PDF
  const [payInclude, setPayInclude] = useState(false);      // include the buyer payment estimate in the report
  const [shareLangPref, setShareLangPref] = useState(null); // null = client link follows the app language
  const [placeSugs, setPlaceSugs] = useState(null); // null = use built-in list
  const placesSeq = useRef(0);

  const [taxLookup, setTaxLookup] = useState(null); // Tax tab has its own independent search
  const [mapSat, setMapSat] = useState(true); // comparables map: satellite vs roadmap
  const [mapFocus, setMapFocus] = useState(null); // {i, t} — focus a comp on the in-app map
  // Tapping any property photo expands it full-screen (tap again to close)
  const [photoView, setPhotoView] = useState(null); // null | { src, label }
  // Workspace: the Realtor-profile card collapses so it doesn't dominate the tab
  const [profileOpen, setProfileOpen] = useState(false);
  // Derived brand palette for the client-facing documents
  const brand = /^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : "#1B2A5C";
  const brandGrad = `linear-gradient(135deg, ${brand} 0%, ${shadeHex(brand, -0.38)} 100%)`;
  const brandTint = shadeHex(brand, 0.72);
  // Workspace: past searches — one collapsed row that expands into month groups
  const [searchesOpen, setSearchesOpen] = useState(false);
  const [searchMonths, setSearchMonths] = useState(null); // per-month overrides; latest open by default

  /* Quick Comp tabs: lending calculator inputs + saved-work history */
  const [lendPrice, setLendPrice] = useState(null); // null = follow the comp value
  const [lendDownPct, setLendDownPct] = useState(20);
  const [lendRate, setLendRate] = useState(7.0);
  const [lendTerm, setLendTerm] = useState(30);
  const [lendTaxPct, setLendTaxPct] = useState(1.1);
  const [lendInsYr, setLendInsYr] = useState(1500);
  const [lendType, setLendType] = useState("conv"); // conv | fha | va
  const [lendHoa, setLendHoa] = useState(0);        // $/mo
  const [savedWork, setSavedWork] = useState(() => {
    try { return JSON.parse(localStorage.getItem("qc_saved") || "[]"); } catch { return []; }
  });
  const recordWork = (res) => {
    if (!res || !res.value) return;
    setSavedWork((prev) => {
      const addr = (res.subject && res.subject.address) || res.addr || "";
      const item = { ...res, addr, ts: Date.now() };
      const next = [item, ...prev.filter((p) => p.addr !== addr)].slice(0, 40); // months of history for the Workspace archive
      try { localStorage.setItem("qc_saved", JSON.stringify(next)); } catch {}
      return next;
    });
  };
  /* Load a saved search exactly as it was — no re-search, no wait. Curation
   * state is reset so edits from a previous property never bleed in. */
  const loadSaved = (it) => {
    setExcludedComps({}); setPriceOverrides({}); setManualComps([]); setAddComp(null);
    setRadiusPref("auto");
    setLookup(it);
    setLendPrice(null);
  };
  const reopenSaved = (it) => {
    loadSaved(it);
    setScreen("comps");
  };

  /* ── AI listing writer — prefilled from a search, editable, works standalone ── */
  const [listingDraft, setListingDraft] = useState({ address: "", beds: "", baths: "", sqft: "", year: "", highlights: "" });
  const [listingOut, setListingOut] = useState(null);   // {mls, social, source}
  const [listingBusy, setListingBusy] = useState(false);
  const openListing = (subj) => {
    const addr = (subj && subj.address) || "";
    // A new property prefills fresh facts; reopening the same one (or entering
    // standalone) keeps whatever the agent already typed.
    if (subj && addr !== listingDraft.address) {
      setListingDraft({ address: addr, beds: subj.beds ?? "", baths: subj.baths ?? "", sqft: subj.sqft ?? "", year: subj.yearBuilt ?? "", highlights: "" });
      setListingOut(null);
    }
    setScreen("listing");
  };
  const generateListing = async () => {
    const d = listingDraft;
    if (!String(d.address).trim() && !String(d.highlights).trim()) {
      showToast(lang === "es" ? "Pon la dirección o los datos de la propiedad" : "Enter the address or the property facts");
      return;
    }
    setListingBusy(true);
    setListingOut(null);
    try {
      const r = await api("/api/listing", {
        method: "POST",
        body: JSON.stringify({ lang, address: d.address, beds: d.beds, baths: d.baths, sqft: d.sqft, year: d.year, highlights: d.highlights }),
      });
      if (r.status === 429) {
        setListingBusy(false);
        showToast("🔒 " + (lang === "es" ? "Límite de hoy alcanzado" : "Daily limit reached"));
        return;
      }
      const j = r.ok ? await r.json() : null;
      if (j?.mls) { setListingOut(j); setListingBusy(false); return; }
    } catch { /* backend unreachable — compose locally below */ }
    // Offline/demo fallback — the button always answers with something usable
    const es = lang === "es";
    const bits = [
      d.beds && `${d.beds} ${es ? "recámaras" : "bedrooms"}`,
      d.baths && `${d.baths} ${es ? "baños" : "baths"}`,
      d.sqft && `${Number(String(d.sqft).replace(/[^0-9.]/g, "")).toLocaleString("en-US")} ${es ? "pies²" : "sq ft"}`,
      d.year && (es ? `construida en ${d.year}` : `built in ${d.year}`),
    ].filter(Boolean).join(", ");
    const hl = String(d.highlights || "").trim().replace(/[.\s]+$/, "");
    setListingOut({
      source: "demo",
      mls: es
        ? `Bienvenido a ${d.address || "esta propiedad"} — una casa de ${bits || "gran potencial"}. ${hl ? hl + ". " : ""}Agenda tu cita hoy: propiedades así no duran en el mercado.`
        : `Welcome to ${d.address || "this property"} — a ${bits || "wonderful"} home. ${hl ? hl + ". " : ""}Schedule your showing today — homes like this don't last.`,
      social: es
        ? `🏡 ¡NUEVO LISTING! ${d.address || ""}${bits ? " · " + bits : ""} ✨ Manda mensaje para verla 📲`
        : `🏡 JUST LISTED! ${d.address || ""}${bits ? " · " + bits : ""} ✨ DM to see it 📲`,
    });
    setListingBusy(false);
  };
  const copyText = async (txt) => {
    try { await navigator.clipboard.writeText(txt); showToast(lang === "es" ? "Copiado ✓" : "Copied ✓"); } catch { /* ignore */ }
  };

  /* ── Appraisal defense packet — contract price being defended + agent notes ── */
  const [apprPrice, setApprPrice] = useState("");
  const [apprNote, setApprNote] = useState("");

  const [showDetails, setShowDetails] = useState(false); // shared with the fence estimator
  const [dragOff, setDragOff] = useState([0, 0]);        // live pan offset (fence map drag)
  const tracePtr = useRef(null);                          // pointer drag tracking (fence map)

  // fence estimator state
  const [fenceBase, setFenceBase] = useState(null); // {lat, lng, zoom, addr}
  const [fRuns, setFRuns] = useState([]);           // completed fence lines (lat/lng)
  const [fCur, setFCur] = useState([]);             // line being drawn
  const [gWalk, setGWalk] = useState(0);
  const [gDbl, setGDbl] = useState(0);
  const [fType, setFType] = useState("cedar");
  const [fLF, setFLF] = useState(String(FENCE_PRICES.cedar));
  const [fWalkP, setFWalkP] = useState("250");
  const [fDblP, setFDblP] = useState("450");
  const [fMk, setFMk] = useState("0");
  const [fNoImg, setFNoImg] = useState(false);
  const [fExcl, setFExcl] = useState(new Set()); // excluded parcel-boundary edges

  const openFence = (base) => {
    setFenceBase(base);
    setFRuns([]); setFCur([]); setGWalk(0); setGDbl(0); setFNoImg(false);
    setFExcl(new Set());
    setShowDetails(false);
    setScreen("fenceDraw");
  };

  // voice input for the address (works on phones that support speech recognition)
  const [listening, setListening] = useState(false);
  const hasVoice = typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const startVoice = (onResult) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.lang = lang === "es" ? "es-US" : "en-US";
    r.onresult = (e) => { setListening(false); onResult(e.results[0][0].transcript); };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    setListening(true);
    r.start();
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) { showToast("⚠️ " + t.locErr); return; }
    showToast("📍 " + t.locating);
    navigator.geolocation.getCurrentPosition(
      (pos) => startLookup(t.myLocation, null, { lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => showToast("⚠️ " + t.locErr),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  };

  const onAddrInput = (v) => {
    setAddrQ(v);
    const q = v.trim();
    placesSeq.current += 1;
    const seq = placesSeq.current;
    if (!q) { setPlaceSugs(null); return; }
    fetch(`/api/places?q=${encodeURIComponent(q)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (seq === placesSeq.current && j && Array.isArray(j.suggestions)) setPlaceSugs(j.suggestions);
      })
      .catch(() => {}); // backend not running — keep the built-in list
  };

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2400); };
  useEffect(() => { try { localStorage.setItem("qc_reports", JSON.stringify(sentReports.slice(0, 30))); } catch { /* private mode */ } }, [sentReports]);
  useEffect(() => {
    // Refresh open counts on every Workspace visit, plus once at launch so the
    // "new views" dot can appear without opening the tab first.
    if (!sentReports.length) return;
    if (screen !== "workspace" && opensFetched.current) return;
    opensFetched.current = true;
    const rids = sentReports.slice(0, 30).map((r) => r.rid).filter(Boolean).join(",");
    if (!rids) return;
    api(`/api/r/opens?rids=${rids}`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.opens) setReportOpens(j.opens); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);
  useEffect(() => {
    // Visiting the Workspace marks every report open as seen — the dot clears.
    if (screen !== "workspace") return;
    const total = Object.values(reportOpens).reduce((s, o) => s + (o?.n || 0), 0);
    if (total > seenViews) {
      setSeenViews(total);
      try { localStorage.setItem("qc_seenviews", String(total)); } catch { /* private mode */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, reportOpens]);
  useEffect(() => {
    // Leads inbox: demo data without an account. Real accounts pull at launch,
    // on every screen change, and every 60s in between — so when a client fills
    // the form, the pending badge on the front page lights up by itself.
    if (!session) { setLeads((cur) => (cur.length ? cur : DEMO_LEADS)); return; } // seed once — keep demo edits
    const pull = () => api("/api/leads").then((r) => (r.ok ? r.json() : null)).then((j) => { if (Array.isArray(j?.leads)) setLeads(j.leads); }).catch(() => {});
    pull();
    const iv = setInterval(pull, 60000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, session]);
  const pendingLeads = leads.filter((l) => (l.status || "new") === "new").length;
  const markLead = (id, status) => {
    // Optimistic — the tap must feel instant; the server catches up behind it.
    setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, status } : l)));
    if (session) api(`/api/leads/${id}`, { method: "POST", body: JSON.stringify({ status }) }).catch(() => { /* refetch on next visit heals it */ });
  };
  const noteLead = (id, note) => {
    setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, info: { ...(l.info || {}), note } } : l)));
    if (session) api(`/api/leads/${id}`, { method: "POST", body: JSON.stringify({ note }) }).catch(() => { /* refetch heals it */ });
  };
  // Which lead months are expanded — null = default (latest month open, rest collapsed)
  const [monthsOpen, setMonthsOpen] = useState(null);
  /* The phone's back button/gesture navigates the app instead of exiting it:
   * every screen change (and comps search→result) pushes a history entry, and
   * popstate walks back through them. Skipped inside embeds (the landing-page
   * demo iframes) where pushing would pollute the host page's history. */
  const navPop = useRef(false);
  const navFirst = useRef(true);
  useEffect(() => {
    if (window.parent !== window) return;
    if (navPop.current) { navPop.current = false; return; }
    const st = { qcScreen: screen, qcRes: !!(screen === "comps" && lookup) };
    try {
      if (navFirst.current) { navFirst.current = false; window.history.replaceState(st, ""); }
      else window.history.pushState(st, "");
    } catch { /* sandboxed */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, !!lookup]);
  useEffect(() => {
    if (window.parent !== window) return;
    const onPop = (e) => {
      const st = e.state;
      if (!st || !st.qcScreen) return;
      navPop.current = true;
      setScreen(st.qcScreen);
      if (st.qcScreen === "comps" && !st.qcRes) setLookup(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* The realtor's shareable lead form (their widget) — one tap sends it to a
   * client via the phone's share sheet (or WhatsApp on desktop). */
  const leadFormUrl = `${window.location.origin}/w/${mySlug || "alto-demo"}`;
  const shareLeadForm = () => {
    const msg = lang === "es"
      ? `Mira cuánto vale tu casa hoy — gratis y en 10 segundos 🏡👇\n${leadFormUrl}`
      : `See what your home is worth today — free, in 10 seconds 🏡👇\n${leadFormUrl}`;
    if (navigator.share) { navigator.share({ text: msg }).catch(() => { /* user closed the sheet */ }); return; }
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
  };
  /* Monthly payment from the Lending tab's current settings, for the report's
   * optional buyer card — same PMI/MIP/fee math as the Lending screen. */
  const paymentFor = (price) => {
    const principal = Math.max(price - price * lendDownPct / 100, 0);
    const miRate = lendType === "fha" ? 0.0055 : lendDownPct < 20 ? 0.007 : 0;
    const fee = lendType === "fha" ? principal * 0.0175 : lendType === "va" ? principal * 0.0215 : 0;
    const loan = principal + fee;
    const rr = lendRate / 100 / 12, nn = lendTerm * 12;
    const pi = rr > 0 ? loan * rr / (1 - Math.pow(1 + rr, -nn)) : loan / nn;
    const monthly = pi + price * (lendTaxPct / 100) / 12 + lendInsYr / 12 + loan * (lendType === "va" ? 0 : miRate) / 12 + lendHoa;
    return { monthly: Math.round(monthly), typeLabel: lendType === "fha" ? "FHA" : lendType === "va" ? "VA" : lang === "es" ? "Convencional" : "Conventional" };
  };

  const startLookup = async (addr, placeId = null, gps = null, target = "comps") => {
    // Demo mode gets 10 measurements TOTAL (not per day) — a taste, not a tool.
    // The counter lives next to the demo data itself, so wiping it to cheat
    // also wipes everything the freeloader saved.
    if (!session) {
      let used = 0;
      try { used = parseInt(localStorage.getItem("alto_demo_meas") || "0", 10) || 0; } catch { /* private mode */ }
      if (used >= 10) { showToast("🔒 " + t.demoLimit); return; }
    }
    setAddrQ(addr);
    setExcludedComps({});
    setPriceOverrides({});
    setManualComps([]);
    setAddComp(null);
    setRadiusPref("auto");
    setNetPayoff("");
    setNetInclude(false);
    setPayInclude(false);
    setMeasuring(true);
    setMeasurePhase(0);
    const t0 = Date.now();
    const p1 = setTimeout(() => setMeasurePhase(1), 1000);
    const p2 = setTimeout(() => setMeasurePhase(2), 1900);
    // Ask the backend first (real APIs or server-side demo); if it's not
    // running, fall back to the in-app simulated lookup.
    let res = null;
    let answered = false;
    let noDataCoords = null;
    try {
      const r = await fetch("/api/lookup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session}` } : {}),
        },
        body: JSON.stringify(gps
          ? { lat: gps.lat, lng: gps.lng, parcel: trade === "fence" }
          : { address: addr, placeId, parcel: trade === "fence" }),
      });
      if (r.status === 429) {
        clearTimeout(p1); clearTimeout(p2);
        setMeasuring(false);
        showToast("🔒 " + t.demoLimit);
        return;
      }
      if (r.ok) {
        const j = await r.json();
        answered = true;
        if (!session && j.found) {
          try { localStorage.setItem("alto_demo_meas", String((parseInt(localStorage.getItem("alto_demo_meas") || "0", 10) || 0) + 1)); } catch { /* private mode */ }
        }
        if (!j.found && j.lat != null) noDataCoords = { lat: j.lat, lng: j.lng, addr: j.addr || addr };
        res = j.found ? mapCompsLookup(j, addr) : null;
      }
    } catch { /* backend unreachable */ }
    // The simulated fallback is DEMO-ONLY. A signed-in agent must never get
    // fabricated comps they could unknowingly share/print under their license —
    // if the server was unreachable, tell them, don't invent data.
    if (!answered && !session) res = await mockLookup(addr);
    if (!answered && session) {
      await new Promise(rs => setTimeout(rs, Math.max(0, 900 - (Date.now() - t0))));
      clearTimeout(p1); clearTimeout(p2);
      setMeasuring(false);
      showToast("📡 " + (lang === "es" ? "Sin conexión al servidor — intenta de nuevo" : "Couldn't reach the server — try again"));
      return;
    }
    // Keep the measuring animation on screen long enough to read
    await new Promise(rs => setTimeout(rs, Math.max(0, 2400 - (Date.now() - t0))));
    clearTimeout(p1); clearTimeout(p2);
    setMeasuring(false);
    if (trade === "fence") {
      // Fences only need the location — go straight to drawing
      const j = answered && res ? res : null;
      const base = (j && j.lat != null && { lat: j.lat, lng: j.lng, addr: j.addr, parcel: j.parcel || null })
        || noDataCoords
        || { lat: 26.3827418, lng: -98.8196915, addr }; // demo fallback
      if (base.parcel && base.parcel.length >= 3) {
        // frame the whole property
        let s = 90, w = 180, nn = -90, e = -180;
        base.parcel.forEach(([la, ln]) => { s = Math.min(s, la); nn = Math.max(nn, la); w = Math.min(w, ln); e = Math.max(e, ln); });
        const ctrLat = (s + nn) / 2, ctrLng = (w + e) / 2;
        const span = Math.max(nn - s, (e - w) * Math.cos(ctrLat * Math.PI / 180), 0.0001) * 1.6;
        const z = Math.min(Math.max(Math.floor(Math.log2((360 * (640 / 256)) / span)), 15), 20);
        openFence({ lat: ctrLat, lng: ctrLng, zoom: z, addr: base.addr, parcel: base.parcel });
      } else {
        openFence({ lat: base.lat, lng: base.lng, addr: base.addr, zoom: 19, parcel: null });
      }
      showToast(base.parcel && base.parcel.length >= 3 ? "🛰️ " + t.fenceDrawn : "✏️ " + t.noParcel);
      return;
    }
    if (target === "tax") {
      // Tax only needs the property record (facts + assessment), not a comp value.
      if (!res || !(res.subject || res.value)) {
        setTaxLookup(null);
        showToast("🏠 " + t.cmpNone);
        return;
      }
      setTaxLookup(res);
      setScreen("tax");
      showToast("🧾 " + (lang === "es" ? "Datos fiscales listos ✓" : "Tax record ready ✓"));
      return;
    }
    if (!res || !res.value) {
      // Found the place but the market was too thin to value, or nothing found.
      setLookup(null);
      setScreen("comps");
      showToast("🏠 " + t.cmpNone);
      return;
    }
    setLookup(res);
    setLendPrice(null); // lending follows the new comp value until the user overrides
    // Tune the lending defaults to THIS property: real county tax when we have
    // it, else the state's average rate; insurance scaled to price and state
    // risk (TX/FL/LA/OK hail+wind run roughly half again the national cost).
    {
      const st = stateFromAddress(res.subject?.address || res.addr);
      const realTaxPct = res.subject?.annualTax && res.value ? (res.subject.annualTax / res.value) * 100 : null;
      const stTaxPct = (TAX_RATE_BY_STATE[st] || 0.011) * 100;
      setLendTaxPct(Math.min(3, Math.max(0.3, +(realTaxPct ?? stTaxPct).toFixed(2))));
      const insFactor = ["TX", "FL", "LA", "OK", "KS", "NE", "MS", "AL"].includes(st) ? 0.005 : 0.0035;
      setLendInsYr(Math.min(6000, Math.max(800, Math.round((res.value * insFactor) / 100) * 100)));
    }
    recordWork(res);
    setScreen("comps");
    showToast("🏠 " + t.cmpDone + " ✓");
  };

  /* ── Shell pieces ──
   * Language is chosen at onboarding and changeable in the Workspace profile —
   * the top bars stay clean. */
  const Header = ({ title, back }) => (
    <div className="flex items-center gap-3 px-5 pt-4 pb-3" style={{ background: C.navy }}>
      {back && <button onClick={back} className="text-2xl font-bold" style={{ color: "#fff", background: "none", border: "none" }}>‹</button>}
      <Logo size={28} color="#fff" />
      <span className="flex-1 font-bold text-lg truncate" style={{ color: "#fff", fontWeight: 800, letterSpacing: 0.3 }}>{title}</span>
    </div>
  );

  /* Quick Comp brand bar shown atop the primary tab screens */
  const BrandHeader = () => (
    <div className="relative flex items-center justify-center px-5 pt-4 pb-3" style={{ background: C.navy }}>
      <img src="/quick-comp-lockup-white.png" alt="Quick Comp" draggable={false} style={{ height: 46, objectFit: "contain", display: "block" }} />
    </div>
  );

  const BottomNav = () => {
    const items = [
      ["comps", lang === "es" ? "Comps" : "Comps"],
      ["lending", lang === "es" ? "Crédito" : "Lending"],
      ["tax", lang === "es" ? "Impuestos" : "Tax"],
      ["workspace", lang === "es" ? "Trabajo" : "Workspace"],
    ];
    // Unseen report opens light a small gold dot on the Workspace tab
    const totalViews = Object.values(reportOpens).reduce((s, o) => s + (o?.n || 0), 0);
    return (
      <div className="flex justify-around items-center gap-1.5 px-2 py-2" style={{ background: "#fff", borderTop: `1px solid ${C.line}` }}>
        {items.map(([s, label], i) => {
          const on = screen === s;
          return (
            <button key={s} onClick={() => setScreen(s)}
              className="relative flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-2xl"
              style={{ background: on ? C.navy : "transparent", border: "none" }}>
              <span className="text-xs font-extrabold" style={{ color: on ? C.orange : C.slate, letterSpacing: 0.5 }}>{`0${i + 1}`}</span>
              <span className="text-[11px] font-bold uppercase truncate" style={{ color: on ? "#fff" : C.slate, letterSpacing: 0.5 }}>{label}</span>
              {s === "workspace" && totalViews > seenViews && (
                <span className="absolute" style={{ top: 5, right: "24%", width: 9, height: 9, borderRadius: 5, background: "#E3B54E", boxShadow: `0 0 0 2px ${on ? C.navy : "#fff"}` }} />
              )}
            </button>
          );
        })}
      </div>
    );
  };

  /* ── Screens ── */
  // Quick Comp visual language — scoped to the comps screens (search + result) only.
  const CompsSearch = () => {
    if (measuring) {
      const phases = [t.measuring1, t.measuring2, t.measuring3];
      return (
        <div className="flex-1 flex flex-col items-center justify-center px-7 text-center" style={{ background: QC.bg }}>
          <span className="text-5xl mb-4" style={{ animation: "ttpPulse 1.2s ease-in-out infinite" }}>🏠</span>
          <p className="font-extrabold mb-1" style={{ color: QC.navyDeep, fontSize: 20 }}>{addrQ}</p>
          <p className="mb-6" style={{ color: QC.gold, fontSize: 11, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Analizando comparables" : "Analyzing comparables"}</p>
          <div className="text-left">
            {phases.map((ph, i) => (
              <p key={ph} className="py-1 font-semibold" style={{ color: i < measurePhase ? QC.green : i === measurePhase ? QC.navy : QC.line }}>
                {i < measurePhase ? "✓ " : i === measurePhase ? "● " : "○ "}{ph}
              </p>
            ))}
          </div>
        </div>
      );
    }
    const q = addrQ.trim().toLowerCase();
    // Only REAL address suggestions from Google as they type — no built-in demo
    // addresses. A fresh account starts clean; the "Recent" list below is the
    // only pre-filled thing, and it's the agent's own past searches.
    const matches = placeSugs !== null ? placeSugs : [];
    const custom = addrQ.trim() && !matches.some(m => m.text.toLowerCase() === q) ? addrQ.trim() : null;
    const go = () => { if (custom) startLookup(custom); else if (matches[0]) startLookup(matches[0].text, matches[0].placeId); };
    return (
      <div className="flex-1 overflow-y-auto" style={{ background: QC.bg }}>
        <div className="px-5 py-4" style={{ background: QC.headGrad, borderBottom: `2px solid ${QC.gold}` }}>
          <p className="text-center" style={{ color: QC.goldHi, fontSize: 11, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Valuación de propiedad" : "Property Valuation"}</p>
          <p className="text-center font-extrabold text-white mt-0.5" style={{ fontSize: 18 }}>{lang === "es" ? "Pon precio con confianza" : "Price the property with confidence"}</p>
        </div>
        <div className="px-5 pt-3">
          <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <p className="mb-2" style={{ color: QC.muted2, fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Dirección de la propiedad" : "Property Address"}</p>
            <div className="flex gap-2">
              <button onClick={useMyLocation} title={t.useMyLocation} className="flex items-center justify-center shrink-0 active:scale-95 transition-transform"
                style={{ width: 48, height: 48, background: QC.bg, border: `1.5px solid ${QC.line}`, borderRadius: 12, color: QC.navy, fontSize: 18 }}>📍</button>
              <div className="flex-1 flex items-center gap-2 rounded-xl px-3" style={{ background: QC.bg, border: `1.5px solid ${QC.line}` }}>
                <input value={addrQ} onChange={(e) => onAddrInput(e.target.value)} placeholder={lang === "es" ? "Escribe una dirección…" : "Enter a property address…"} autoFocus
                  onKeyDown={(e) => e.key === "Enter" && go()}
                  className="flex-1 py-3 text-base font-semibold outline-none bg-transparent" style={{ color: QC.navy }} />
                {hasVoice && (
                  <button onClick={() => startVoice(onAddrInput)} className="text-xl active:scale-90 transition-transform"
                    style={{ background: "none", border: "none", opacity: listening ? 1 : 0.6 }}>{listening ? "🔴" : "🎤"}</button>
                )}
              </div>
            </div>
            {(custom || matches.length > 0) && (
              <div className="rounded-xl mt-2 overflow-hidden" style={{ border: `1.5px solid ${QC.line}` }}>
                {custom && (
                  <button onClick={() => startLookup(custom)} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left active:opacity-80"
                    style={{ background: "#fff", borderBottom: matches.length ? `1px solid ${QC.bg}` : "none" }}>
                    <span style={{ color: QC.navy }}>📍</span>
                    <span className="font-bold truncate" style={{ color: QC.navy, fontSize: 13 }}>{custom}</span>
                  </button>
                )}
                {matches.map((m, i) => (
                  <button key={m.text} onClick={() => startLookup(m.text, m.placeId)} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left active:opacity-80"
                    style={{ background: "#fff", borderBottom: i < matches.length - 1 ? `1px solid ${QC.bg}` : "none" }}>
                    <span style={{ color: QC.navy }}>📍</span>
                    <span className="font-semibold truncate" style={{ color: QC.navy, fontSize: 13 }}>{m.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={go} className="w-full active:translate-y-px transition-transform"
            style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 12, padding: 15, fontSize: 16, fontWeight: 700, letterSpacing: "0.02em", boxShadow: "0 4px 14px rgba(27,42,92,0.3)" }}>
            {lang === "es" ? "Ver valor de mercado" : "Get Market Value"}
          </button>
          <p className="text-center mt-3" style={{ color: QC.muted, fontSize: 11, fontWeight: 600 }}>{lang === "es" ? "Ventas comparables cercanas · 100% gratis" : "Nearby comparable sales · 100% free"}{session ? "" : " · DEMO"}</p>
          {/* Leads — a navy launcher right up top (Get Market Value style), with a
              pending badge that lights up on its own when a client fills the form */}
          <button onClick={() => setScreen("leads")} className="w-full flex items-center gap-3 mt-3 text-left active:translate-y-px transition-transform"
            style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 12, padding: "12px 16px", boxShadow: "0 4px 14px rgba(27,42,92,0.3)", cursor: "pointer" }}>
            <span style={{ fontSize: 20 }}>📥</span>
            <span className="flex-1 min-w-0">
              <span className="block font-extrabold" style={{ fontSize: 15, letterSpacing: "0.01em" }}>Leads</span>
              <span className="block" style={{ color: "rgba(255,255,255,0.75)", fontSize: 10.5, fontWeight: 600 }}>{lang === "es" ? "Mándale tu formulario a un cliente — su info te llega aquí" : "Send your lead form to a client — their info lands here"}</span>
            </span>
            {pendingLeads > 0
              ? <span className="shrink-0 rounded-full px-2.5 py-1 font-extrabold" style={{ background: QC.gold, color: QC.navyDeep, fontSize: 12 }}>{pendingLeads} {lang === "es" ? (pendingLeads === 1 ? "NUEVO" : "NUEVOS") : "NEW"}</span>
              : <span className="shrink-0" style={{ color: QC.goldHi, fontSize: 18 }}>›</span>}
          </button>
          {/* Last searches — one tap re-opens the full result instantly */}
          {savedWork.length > 0 && (
            <div className="rounded-2xl px-4 py-3 mt-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
              <p className="mb-0.5" style={{ color: QC.muted2, fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Recientes" : "Recent"}</p>
              {savedWork.slice(0, 4).map((it, i) => {
                const la = it.subject?.latitude ?? it.lat, ln = it.subject?.longitude ?? it.lng;
                return (
                  <button key={it.addr + i} onClick={() => reopenSaved(it)} className="w-full flex items-center gap-3 py-2.5 text-left active:opacity-80"
                    style={{ background: "none", border: "none", borderTop: i ? `1px solid ${QC.line}` : "none", cursor: "pointer" }}>
                    {/* real Street View photo of the property so they remember which one */}
                    <span className="relative shrink-0 flex items-center justify-center" style={{ width: 46, height: 46, borderRadius: 10, background: QC.bg, overflow: "hidden", fontSize: 18, border: `1px solid ${QC.line}` }}>
                      🏠
                      {la != null && ln != null && (
                        <img src={`/api/streetview?lat=${la}&lng=${ln}`} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }}
                          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                      )}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-bold truncate" style={{ color: QC.navyDeep, fontSize: 13 }}>{it.addr}</span>
                      {it.value != null && <span className="block" style={{ color: QC.muted2, fontSize: 10.5, fontWeight: 600 }}>{fmt(it.value)}</span>}
                    </span>
                    <span style={{ color: QC.gold, fontSize: 16 }}>›</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  /* Re-price from the comps the realtor kept, corrected, or added — the same
   * math the server ran (weighted mean of each comp's adjusted value), so any
   * edit recomputes the value live. The agent's MLS knowledge (true sold
   * prices, missing sales) flows straight into the number. Untouched search =
   * untouched result. */
  const curatedView = (base) => {
    if (!base || !base.value) return base;
    const all = Array.isArray(base.comps) ? base.comps : [];
    const hasEdits = manualComps.length > 0 || all.some((c) => excludedComps[c.address] || priceOverrides[c.address] != null);
    if (!hasEdits) return base;
    const round1k = (v) => Math.round(v / 1000) * 1000;
    const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const sqft = base.subject?.sqft || null;
    const drift = Number(base.marketDriftMo) || 0;
    // corrected feed comps: re-run the exact per-comp math with the true price
    const effectiveServer = all.map((c) => {
      const oP = priceOverrides[c.address];
      if (oP == null || !c.sqft) return c;
      const t = Number(c.timeAdjPct) || 0;
      const ppsf = oP / c.sqft;
      const adjPpsf = ppsf * (1 + t);
      const adjValue = sqft ? Math.round(oP * (1 + t) + (sqft - c.sqft) * 0.45 * adjPpsf) : undefined;
      return { ...c, soldPrice: oP, ppsf: Math.round(ppsf), adjPpsf: Math.round(adjPpsf), adjValue, corrected: true };
    });
    // agent-added MLS comps: time-indexed with the same market drift
    const ws = effectiveServer.filter((c) => c.weight && !c.excludedAsOutlier).map((c) => c.weight).sort((a, b) => a - b);
    const midWeight = ws.length ? ws[Math.floor(ws.length / 2)] : 1;
    const effectiveManual = manualComps.map((c) => {
      const months = c.soldDate ? Math.max(0, (Date.now() - new Date(c.soldDate).getTime()) / (30.44 * 86400000)) : 0;
      const t = clampN(drift * months, -0.25, 0.25);
      const ppsf = c.sqft ? c.soldPrice / c.sqft : null;
      const adjPpsf = ppsf ? ppsf * (1 + t) : null;
      const adjValue = sqft && adjPpsf ? Math.round(c.soldPrice * (1 + t) + (sqft - c.sqft) * 0.45 * adjPpsf) : undefined;
      return { ...c, ppsf: ppsf ? Math.round(ppsf) : undefined, adjValue, weight: midWeight, manual: true };
    });
    const effective = [...effectiveServer, ...effectiveManual];
    const inc = effective.filter((c) => !c.excludedAsOutlier && !excludedComps[c.address]);
    const withVals = inc.filter((c) => c.adjValue && c.weight);
    let out = { ...base, comps: effective, curated: true };
    if (withVals.length >= 2) {
      const tw = withVals.reduce((sum, c) => sum + c.weight, 0);
      const est = withVals.reduce((sum, c) => sum + c.adjValue * c.weight, 0) / tw;
      const varr = withVals.reduce((sum, c) => sum + c.weight * (c.adjValue - est) ** 2, 0) / tw;
      const spread = Math.min(0.12, Math.max(0.04, Math.sqrt(varr) / est || 0.08));
      out = { ...out, value: round1k(est), low: round1k(est * (1 - spread)), high: round1k(est * (1 + spread)), compsUsed: withVals.length, avgPpsf: sqft ? Math.round(est / sqft) : base.avgPpsf };
    } else {
      const ppsfs = inc.map((c) => (c.soldPrice && c.sqft ? c.soldPrice / c.sqft : null)).filter(Boolean);
      if (sqft && ppsfs.length >= 2) {
        const avg = ppsfs.reduce((sum, v) => sum + v, 0) / ppsfs.length;
        const est = sqft * avg;
        out = { ...out, value: round1k(est), low: round1k(est * 0.94), high: round1k(est * 1.06), compsUsed: ppsfs.length, avgPpsf: Math.round(avg) };
      }
    }
    return out;
  };
  const toggleComp = (base, address) => {
    if (manualComps.some((c) => c.address === address)) { setManualComps((l) => l.filter((c) => c.address !== address)); return; }
    if (!excludedComps[address]) {
      const left = (base.comps || []).filter((c) => !c.excludedAsOutlier && !excludedComps[c.address]);
      if (left.length <= 2) { showToast(lang === "es" ? "Deja al menos 2 comparables" : "Keep at least 2 comparables"); return; }
    }
    setExcludedComps((m) => ({ ...m, [address]: !m[address] }));
  };
  /* The agent knows the real MLS number — let them type it. Empty = restore. */
  const editCompPrice = (c) => {
    const raw = window.prompt(lang === "es" ? "Precio real de venta (de tu MLS):" : "True sold price (from your MLS):", String(priceOverrides[c.address] ?? c.soldPrice ?? ""));
    if (raw === null) return;
    const v = Math.round(Number(String(raw).replace(/[^0-9.]/g, "")));
    if (c.manual) { if (v >= 1000) setManualComps((l) => l.map((m) => (m.address === c.address ? { ...m, soldPrice: v } : m))); return; }
    if (!v || v < 1000) { setPriceOverrides((m) => { const n = { ...m }; delete n[c.address]; return n; }); return; }
    setPriceOverrides((m) => ({ ...m, [c.address]: v }));
  };
  const confirmAddComp = () => {
    const f = addComp || {};
    const price = Math.round(Number(String(f.price || "").replace(/[^0-9.]/g, "")));
    const cSqft = Math.round(Number(String(f.sqft || "").replace(/[^0-9.]/g, "")));
    if (!String(f.address || "").trim() || !price || price < 1000) { showToast(lang === "es" ? "Pon la dirección y el precio de venta" : "Enter the address and sold price"); return; }
    setManualComps((l) => [...l, {
      address: String(f.address).trim().slice(0, 120),
      soldPrice: price,
      sqft: cSqft || null,
      beds: Number(f.beds) || null,
      baths: Number(f.baths) || null,
      soldDate: /^\d{4}-\d{2}-\d{2}$/.test(String(f.soldDate || "").trim()) ? String(f.soldDate).trim() : null,
    }]);
    setAddComp(null);
  };
  /* Re-run the comp search with a fixed ring (or back to Auto). Keeps the
   * current result if the tighter ring has too few sales. */
  const changeRadius = async (r) => {
    if (radiusBusy || !lookup || radiusPref === r) return;
    const prev = radiusPref;
    setRadiusPref(r);
    setRadiusBusy(true);
    try {
      const resp = await api("/api/lookup", {
        method: "POST",
        body: JSON.stringify({ address: lookup.subject?.address || lookup.addr, ...(r === "auto" ? {} : { radius: r }) }),
      });
      const j = resp.ok ? await resp.json() : null;
      if (j?.found && j.value) {
        setExcludedComps({}); setPriceOverrides({}); setManualComps([]); setAddComp(null);
        setLookup(mapCompsLookup(j, lookup.addr));
      } else {
        setRadiusPref(prev);
        showToast(resp?.status === 429 ? "🔒 " + t.demoLimit : (lang === "es" ? "Sin ventas suficientes en ese radio" : "Not enough sales at that radius"));
      }
    } catch {
      setRadiusPref(prev);
      showToast(lang === "es" ? "Sin conexión — intenta de nuevo" : "Offline — try again");
    }
    setRadiusBusy(false);
  };

  const CompsResult = () => {
    const R = curatedView(lookup);
    if (!R || !R.value) {
      return (
        <div className="flex-1 px-5 pt-4" style={{ background: QC.bg }}>
          <div className="rounded-2xl text-center" style={{ background: "#fff", border: "1px dashed #CAD5E7", padding: "34px 22px" }}>
            <span className="text-5xl block mb-3">🏘️</span>
            <p className="font-extrabold mb-2" style={{ color: QC.navyDeep, fontSize: 18 }}>{lang === "es" ? "Listo para tu informe de valor" : "Ready to build a clear value story"}</p>
            <p className="mx-auto" style={{ color: "#66759D", fontSize: 13, lineHeight: 1.6, maxWidth: 320 }}>{t.cmpStart}</p>
            <button onClick={() => { setAddrQ(""); setPlaceSugs(null); setLookup(null); setScreen("comps"); }} className="mt-4 active:translate-y-px transition-transform"
              style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 12, padding: "13px 22px", fontSize: 15, fontWeight: 700 }}>
              {lang === "es" ? "Ver valor de mercado" : "Get Market Value"}
            </button>
          </div>
        </div>
      );
    }
    const subj = R.subject || {};
    const conf = {
      strong: { txt: t.cmpConfStrong, bg: "rgba(30,158,90,0.20)", fg: "#9be8bf" },
      good: { txt: t.cmpConfGood, bg: "rgba(231,191,106,0.18)", fg: QC.goldHi },
      limited: { txt: t.cmpConfLimited, bg: "rgba(231,191,106,0.16)", fg: "#f0d49a" },
      low: { txt: t.cmpConfLow, bg: "rgba(232,68,46,0.20)", fg: "#ffb3a6" },
    }[R.confidence] || null;
    const comps = Array.isArray(R.comps) ? R.comps : [];
    const num = (n) => Number(n).toLocaleString("en-US");
    const soldDate = (d) => { if (!d) return "—"; const dt = new Date(d); return Number.isNaN(dt.getTime()) ? "—" : dt.toLocaleDateString(lang === "es" ? "es-MX" : "en-US", { month: "short", day: "numeric", year: "numeric" }); };
    const reasons = lang === "es"
      ? ["Señal más cercana", "Apoyo fuerte", "Apoyo secundario", "Evidencia de mercado"]
      : ["Closest signal", "Strong support", "Secondary support", "Market evidence"];
    // Map: subject (S) + numbered comps over a satellite tile, framed to fit every point.
    const pts = [];
    const sLat = subj.latitude ?? R.lat, sLng = subj.longitude ?? R.lng;
    if (sLat != null && sLng != null) pts.push([sLat, sLng]);
    comps.forEach((c) => { if (c.latitude != null && c.longitude != null) pts.push([c.latitude, c.longitude]); });
    let mapView = null;
    if (pts.length >= 1) {
      let s = 90, w = 180, n = -90, e = -180;
      pts.forEach(([la, ln]) => { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, ln); e = Math.max(e, ln); });
      if (pts.length === 1) { s -= 0.004; n += 0.004; w -= 0.004; e += 0.004; }
      mapView = { lat: (s + n) / 2, lng: (w + e) / 2, zoom: zoomForBbox([s, w, n, e]) };
    }
    return (
      <div className="flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        {/* Pinned top bar: the searched address + instant New search — stays put
            while you scroll the comps, so starting over never means scrolling to
            the bottom of the page */}
        <div className="sticky top-0 z-10 flex items-center gap-2 px-5 py-2.5" style={{ background: QC.bg, borderBottom: `1px solid ${QC.line}` }}>
          <p className="flex-1 min-w-0 truncate" style={{ color: QC.muted2, fontSize: 12, fontWeight: 700 }}>📍 {subj.address || addrQ}</p>
          <button onClick={() => { setAddrQ(""); setPlaceSugs(null); setLookup(null); setScreen("comps"); }} className="shrink-0 active:translate-y-px transition-transform"
            style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 99, padding: "8px 14px", fontSize: 12, fontWeight: 800, cursor: "pointer", boxShadow: "0 2px 8px rgba(27,42,92,0.25)" }}>
            🔍 {t.cmpNew}
          </button>
        </div>
        <div className="px-5 pt-3">
          {/* Hero value card */}
          <div className="rounded-2xl p-5 mb-3" style={{ background: QC.cardGrad, boxShadow: "0 18px 38px rgba(17,27,66,0.18)" }}>
            <div className="flex items-start justify-between gap-2">
              <p style={{ color: QC.goldHi, fontSize: 11, fontWeight: 900, letterSpacing: "0.11em", textTransform: "uppercase" }}>{t.cmpValue}</p>
              {conf && <span className="shrink-0" style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", padding: "3px 10px", borderRadius: 20, background: conf.bg, color: conf.fg, border: `1px solid ${conf.fg}55` }}>{conf.txt}</span>}
            </div>
            <p className="text-white" style={{ fontSize: 42, lineHeight: 1, fontWeight: 900, margin: "8px 0" }}>{fmt(R.value)}</p>
            {(R.low != null && R.high != null) && (
              <div className="rounded-xl mt-1 mb-2.5" style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.10)", padding: "10px 14px" }}>
                <p style={{ color: QC.goldHi, fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", marginBottom: 3 }}>{lang === "es" ? "Rango estimado de mercado" : "Estimated Market Range"}</p>
                <p className="text-white" style={{ fontSize: 20, fontWeight: 800 }}>{fmt(R.low)} – {fmt(R.high)}</p>
              </div>
            )}
            <p style={{ color: "rgba(255,255,255,0.76)", fontSize: 13, lineHeight: 1.55, fontWeight: 600 }}>
              {lang === "es"
                ? `Basado en ${(R.compsUsed || comps.length)} ventas comparables cercanas dentro de ${R.radius || 2} mi`
                : `Based on ${(R.compsUsed || comps.length)} nearby comparable sales within ${R.radius || 2} mi`}
              {R.lookbackLabel ? ` · ${R.lookbackLabel}` : ""}{R.avgPpsf ? ` · ${fmt(R.avgPpsf)}${t.cmpPerSqft}` : ""}{R.curated ? (lang === "es" ? " · tu selección" : " · your selection") : ""}.
            </p>
          </div>

          {/* Comp search radius — Auto expands only as far as needed */}
          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            <span style={{ color: QC.muted2, fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", marginRight: 2 }}>{lang === "es" ? "Radio" : "Radius"}</span>
            {["auto", 1, 2, 5].map((r) => {
              const on = radiusPref === r;
              return (
                <button key={String(r)} onClick={() => changeRadius(r)} disabled={radiusBusy}
                  style={{ background: on ? QC.navy : "#fff", color: on ? "#fff" : QC.navy, border: `1.5px solid ${on ? QC.navy : QC.line}`, borderRadius: 20, padding: "5px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer", opacity: radiusBusy ? 0.6 : 1 }}>
                  {r === "auto" ? "Auto" : `${r} mi`}
                </button>
              );
            })}
            {radiusBusy && <span style={{ color: QC.muted, fontSize: 11, fontWeight: 700 }}>…</span>}
          </div>

          {/* Subject card */}
          <div className="rounded-2xl overflow-hidden mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            {sLat != null && sLng != null && (
              <img
                src={`/api/streetview?lat=${sLat}&lng=${sLng}`}
                alt={subj.address || R.addr}
                onError={(e) => { e.currentTarget.style.display = "none"; }}
                onClick={() => setPhotoView({ src: `/api/streetview?lat=${sLat}&lng=${sLng}`, label: subj.address || R.addr })}
                style={{ width: "100%", height: 170, objectFit: "cover", display: "block", background: QC.bg, cursor: "pointer" }}
              />
            )}
            <div className="p-4">
              <p style={{ color: QC.muted2, fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 5 }}>{t.cmpSubject}</p>
              <p className="font-extrabold mb-3" style={{ color: QC.navyDeep, fontSize: 16, lineHeight: 1.3 }}>{subj.address || R.addr}</p>
              <div className="grid grid-cols-4 gap-2">
                {[["🛏️", subj.beds ?? "—", t.beds], ["🛁", subj.baths ?? "—", t.baths], ["📐", subj.sqft ? num(subj.sqft) : "—", t.cmpSqft], ["📅", subj.yearBuilt ?? "—", t.builtIn]].map(([icon, v, label]) => (
                  <div key={label} style={{ background: QC.bg, border: `1px solid ${QC.line}`, borderRadius: 10, padding: "10px 6px", textAlign: "center" }}>
                    <p className="font-extrabold" style={{ color: QC.navy, fontSize: 15 }}>{v}</p>
                    <p style={{ color: QC.muted, fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 3 }}>{icon} {label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Comps */}
          <div className="flex items-center justify-between mb-2">
            <p style={{ color: QC.navy, fontSize: 15, fontWeight: 800 }}>{t.cmpComps}</p>
            <span style={{ color: QC.muted, fontSize: 11, fontWeight: 700 }}>{comps.length} {lang === "es" ? "propiedades" : "properties"}</span>
          </div>
          {comps.map((c, i) => {
            const ppsf = c.ppsf || (c.soldPrice && c.sqft ? Math.round(c.soldPrice / c.sqft) : null);
            const out = !!c.excludedAsOutlier;
            const manualOut = !!excludedComps[c.address];
            const rankBg = i === 0 ? "linear-gradient(135deg,#E6BF6A,#C9973A)" : i === 1 ? "linear-gradient(135deg,#C0C0C0,#A0A0A0)" : i === 2 ? "linear-gradient(135deg,#CD7F32,#8B5A00)" : QC.bg;
            const rankTxt = i <= 2 ? QC.navy : QC.muted;
            const barColor = i === 0 ? QC.goldLine : i <= 2 ? QC.navy : QC.line;
            const belowMkt = c.soldPrice && c.soldPrice < R.value * 0.95;
            return (
              <div key={i} className="rounded-2xl p-4 mb-2.5" style={{ background: "#fff", border: i === 0 ? `2px solid ${QC.goldLine}` : `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)", opacity: out || manualOut ? 0.5 : 1 }}>
                <div className="flex items-start gap-3 mb-2.5">
                  {c.latitude != null && c.longitude != null && (
                    <button onClick={() => setPhotoView({ src: `/api/streetview?lat=${c.latitude}&lng=${c.longitude}`, label: c.address })} title={lang === "es" ? "Ver foto" : "View photo"}
                      className="relative shrink-0 active:scale-95 transition-transform" style={{ padding: 0, border: "none", background: "none", lineHeight: 0 }}>
                      <img
                        src={`/api/streetview?lat=${c.latitude}&lng=${c.longitude}`}
                        alt={c.address}
                        onError={(e) => { e.currentTarget.style.display = "none"; }}
                        style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 12, display: "block", background: QC.bg }}
                      />
                      <span className="absolute flex items-center justify-center" style={{ right: -5, bottom: -5, width: 20, height: 20, borderRadius: 10, background: QC.navy, color: "#fff", fontSize: 10, border: "2px solid #fff" }}>⤢</span>
                    </button>
                  )}
                  <div className="flex items-start justify-between gap-2 flex-1 min-w-0">
                    <div className="flex items-start gap-2 min-w-0">
                      <span className="flex items-center justify-center shrink-0" style={{ width: 26, height: 26, borderRadius: 8, fontSize: 11, fontWeight: 800, background: rankBg, color: rankTxt }}>{i + 1}</span>
                      <div className="min-w-0">
                        <p className="font-bold" style={{ color: QC.navy, fontSize: 13, lineHeight: 1.4 }}>{c.address}</p>
                        <p style={{ color: QC.muted, fontSize: 10, fontWeight: 500, marginTop: 2 }}>{c.manual ? (lang === "es" ? "Tu comparable" : "Your comparable") : reasons[Math.min(i, 3)]} · {t.cmpSold} {soldDate(c.soldDate)}{c.distance != null ? ` · ${Number(c.distance).toFixed(2)} mi` : ""}</p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p style={{ color: i === 0 ? "#8A6A00" : QC.navyDeep, fontSize: 20, fontWeight: 800 }}>{fmt(c.soldPrice)}</p>
                      {ppsf && <p style={{ color: QC.muted, fontSize: 10, fontWeight: 500 }}>{fmt(ppsf)}{t.cmpPerSqft}</p>}
                      {!out && (
                        <button onClick={() => editCompPrice(c)}
                          style={{ background: "none", border: "none", color: c.corrected ? "#1E7B3C" : QC.muted, fontSize: 10, fontWeight: 800, cursor: "pointer", padding: "2px 0" }}>
                          ✎ {lang === "es" ? "corregir" : "edit"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2.5">
                  {[c.sqft ? `${num(c.sqft)} ${t.cmpSqft}` : null, c.beds != null ? `${c.beds} ${t.beds}` : null, c.baths != null ? `${c.baths} ${t.baths}` : null, c.yearBuilt ? `${t.builtIn} ${c.yearBuilt}` : null].filter(Boolean).map((tag, k) => (
                    <span key={k} style={{ background: QC.bg, border: `1px solid ${QC.line}`, borderRadius: 8, padding: "4px 10px", fontSize: 11, fontWeight: 700, color: QC.body }}>{tag}</span>
                  ))}
                  {!out && (
                    <button onClick={() => toggleComp(R, c.address)}
                      style={{ background: manualOut ? "#EAF8EF" : "#fff", border: `1px solid ${manualOut ? "#9fd8b0" : QC.line}`, borderRadius: 8, padding: "4px 10px", fontSize: 11, fontWeight: 800, color: manualOut ? "#1E7B3C" : QC.red, cursor: "pointer" }}>
                      {manualOut ? (lang === "es" ? "+ Incluir" : "+ Include") : (lang === "es" ? "− Quitar" : "− Remove")}
                    </button>
                  )}
                  {c.corrected && <span style={{ background: "#EAF8EF", border: "1px solid #9fd8b0", borderRadius: 6, padding: "3px 8px", fontSize: 9, fontWeight: 700, color: "#1E7B3C" }}>MLS ✓</span>}
                  {c.manual && <span style={{ background: "#FFFBEA", border: "1px solid #ffe08a", borderRadius: 6, padding: "3px 8px", fontSize: 9, fontWeight: 700, color: "#8A6A00" }}>{lang === "es" ? "Agregada por ti" : "Added by you"}</span>}
                  {out
                    ? <span style={{ background: "#FBEAEA", border: "1px solid #f3c7c2", borderRadius: 6, padding: "3px 8px", fontSize: 9, fontWeight: 700, color: QC.red }}>{t.cmpExcluded}</span>
                    : i === 0
                      ? <span style={{ background: "#FFFBEA", border: "1px solid #ffe08a", borderRadius: 6, padding: "3px 8px", fontSize: 9, fontWeight: 700, color: "#8A6A00" }}>{lang === "es" ? "Comp más cercana" : "Closest Comp"}</span>
                      : belowMkt
                        ? <span style={{ background: "#EEF6FF", border: "1px solid #c0d4f0", borderRadius: 6, padding: "3px 8px", fontSize: 9, fontWeight: 700, color: QC.navy }}>{lang === "es" ? "Bajo el mercado" : "Below Market"}</span>
                        : null}
                </div>
                {c.matchScore != null && !out && !manualOut && (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 overflow-hidden" style={{ height: 6, borderRadius: 20, background: QC.bg }}>
                      <div style={{ width: `${c.matchScore}%`, height: "100%", borderRadius: 20, background: barColor }} />
                    </div>
                    <span style={{ color: QC.muted, fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>{c.matchScore}% {t.cmpMatch}</span>
                  </div>
                )}
              </div>
            );
          })}

          {/* Add a comparable from the agent's own MLS */}
          {addComp ? (
            <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `2px dashed ${QC.goldLine}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
              <p className="font-extrabold mb-2.5" style={{ color: QC.navyDeep, fontSize: 13 }}>{lang === "es" ? "Agregar comparable (de tu MLS)" : "Add comparable (from your MLS)"}</p>
              {[["address", lang === "es" ? "Dirección" : "Address", "text"], ["price", lang === "es" ? "Precio de venta $" : "Sold price $", "text"], ["sqft", "Sq ft", "text"], ["soldDate", lang === "es" ? "Fecha de venta (AAAA-MM-DD)" : "Sold date (YYYY-MM-DD)", "text"]].map(([k, ph]) => (
                <input key={k} value={addComp[k] || ""} onChange={(e) => setAddComp((f) => ({ ...f, [k]: e.target.value }))} placeholder={ph} inputMode={k === "address" ? "text" : "numeric"}
                  className="w-full rounded-xl px-3 py-2.5 mb-2 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 13 }} />
              ))}
              <div className="flex gap-2 mb-2">
                {[["beds", t.beds], ["baths", t.baths]].map(([k, ph]) => (
                  <input key={k} value={addComp[k] || ""} onChange={(e) => setAddComp((f) => ({ ...f, [k]: e.target.value }))} placeholder={ph} inputMode="numeric"
                    className="flex-1 rounded-xl px-3 py-2.5 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 13, minWidth: 0 }} />
                ))}
              </div>
              <div className="flex gap-2">
                <button onClick={confirmAddComp} className="flex-1" style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 10, padding: 11, fontWeight: 800, fontSize: 13 }}>{lang === "es" ? "Agregar" : "Add"}</button>
                <button onClick={() => setAddComp(null)} style={{ background: "#fff", color: QC.navy, border: `1.5px solid ${QC.line}`, borderRadius: 10, padding: "11px 16px", fontWeight: 800, fontSize: 13 }}>{lang === "es" ? "Cancelar" : "Cancel"}</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAddComp({})} className="w-full rounded-2xl p-3.5 mb-3 active:opacity-80"
              style={{ background: "#fff", border: `2px dashed ${QC.line}`, color: QC.navy, fontWeight: 800, fontSize: 13, cursor: "pointer" }}>
              ＋ {lang === "es" ? "Agregar comparable de tu MLS" : "Add a comparable from your MLS"}
            </button>
          )}

          {/* Map */}
          {mapView && (() => {
            const markerPts = [];
            if (sLat != null && sLng != null) markerPts.push(`${sLat},${sLng},S`);
            comps.forEach((c, i) => {
              if (c.latitude == null || c.longitude == null) return;
              markerPts.push(`${c.latitude},${c.longitude},${i + 1 <= 9 ? i + 1 : ""}`);
            });
            const ptsParam = encodeURIComponent(markerPts.join(";"));
            return (
              <div className="rounded-2xl p-3.5 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line2}` }}>
                <div className="flex items-center justify-between mb-2.5">
                  <p style={{ color: QC.navyDeep, fontSize: 14, fontWeight: 900 }}>{t.cmpMap}</p>
                  <div className="flex rounded-full overflow-hidden" style={{ border: `1.5px solid ${QC.line2}` }}>
                    {[["sat", lang === "es" ? "Satélite" : "Satellite"], ["map", lang === "es" ? "Mapa" : "Map"]].map(([k, lbl]) => {
                      const on = (k === "sat") === mapSat;
                      return <button key={k} onClick={() => setMapSat(k === "sat")} className="px-3 py-1 text-xs font-bold"
                        style={{ background: on ? QC.navy : "#fff", color: on ? "#fff" : QC.muted2, border: "none" }}>{lbl}</button>;
                    })}
                  </div>
                </div>
                <div id="qc-compmap" className="relative w-full overflow-hidden" style={{ aspectRatio: "640/360", background: QC.bg, borderRadius: 10, border: `1px solid ${QC.line2}` }}>
                  <CompMap
                    subjectLL={sLat != null && sLng != null ? { lat: sLat, lng: sLng } : null}
                    comps={comps}
                    satellite={mapSat}
                    focus={mapFocus}
                    lang={lang}
                    fallbackSrc={`/api/compmap?maptype=${mapSat ? "satellite" : "roadmap"}&pts=${ptsParam}`}
                  />
                </div>
                <p className="text-center mt-2" style={{ color: QC.muted, fontSize: 10, fontWeight: 600 }}>{lang === "es" ? "Toca un pin (o una comparable) para ver detalles y cómo llegar" : "Tap a pin (or a comparable) for details and directions"}</p>
              </div>
            );
          })()}

          <p className="mb-3" style={{ color: "#66759D", fontSize: 11, fontWeight: 600, lineHeight: 1.5 }}>⚠️ {t.cmpDisc}</p>
          <button onClick={() => setScreen("report")} className="w-full active:translate-y-px transition-transform mb-2.5"
            style={{ background: `linear-gradient(135deg,${QC.gold},#BD8426)`, color: QC.navyDeep, border: "none", borderRadius: 12, padding: 15, fontSize: 16, fontWeight: 800, letterSpacing: "0.01em", boxShadow: "0 4px 14px rgba(189,132,38,0.35)" }}>
            📄 {lang === "es" ? "Crear informe para el cliente" : "Create client report"}
          </button>
          <button onClick={() => openListing({ ...subj, address: subj.address || R.addr })} className="w-full active:translate-y-px transition-transform mb-2.5"
            style={{ background: "#fff", color: QC.navy, border: `2px solid ${QC.goldLine}`, borderRadius: 12, padding: 14, fontSize: 15, fontWeight: 800 }}>
            ✨ {lang === "es" ? "Escribir el listing (IA)" : "Write the listing (AI)"}
          </button>
          <button onClick={() => { setAddrQ(""); setPlaceSugs(null); setLookup(null); setScreen("comps"); }} className="w-full active:translate-y-px transition-transform"
            style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 12, padding: 15, fontSize: 16, fontWeight: 700, boxShadow: "0 4px 14px rgba(27,42,92,0.3)" }}>
            {t.cmpNew}
          </button>
        </div>
      </div>
    );
  };

  /* Shared empty-state for tabs that need a searched property first */
  const NeedProperty = ({ title, sub }) => (
    <div className="flex-1 px-5 pt-4" style={{ background: QC.bg }}>
      <div className="rounded-2xl text-center" style={{ background: "#fff", border: "1px dashed #CAD5E7", padding: "34px 22px" }}>
        <span className="text-5xl block mb-3">🏠</span>
        <p className="font-extrabold mb-2" style={{ color: QC.navyDeep, fontSize: 18 }}>{title}</p>
        <p className="mx-auto mb-4" style={{ color: "#66759D", fontSize: 13, lineHeight: 1.6, maxWidth: 320 }}>{sub}</p>
        <button onClick={() => { setAddrQ(""); setPlaceSugs(null); setLookup(null); setScreen("comps"); }}
          style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 12, padding: "13px 22px", fontSize: 15, fontWeight: 700 }}>
          {lang === "es" ? "Buscar una dirección" : "Search an address"}
        </button>
      </div>
    </div>
  );

  /* ── 02 · LENDING — monthly payment estimate ── */
  const Lending = () => {
    const m = (v) => "$" + Math.round(v).toLocaleString("en-US");
    const price = lendPrice != null ? lendPrice : (lookup?.value || 350000);
    const down = Math.round(price * lendDownPct / 100);
    const principal = Math.max(price - down, 0);
    // Mortgage insurance, the way lenders actually charge it: conventional PMI
    // below 20% down (~0.7%/yr, drops at 20%), FHA annual MIP 0.55% plus a
    // financed 1.75% upfront, VA no monthly MI but a financed ~2.15% funding fee.
    const miRate = lendType === "fha" ? 0.0055 : lendDownPct < 20 ? 0.007 : 0;
    const financedFee = lendType === "fha" ? principal * 0.0175 : lendType === "va" ? principal * 0.0215 : 0;
    const loanAmt = principal + financedFee;
    const r = lendRate / 100 / 12;
    const n = lendTerm * 12;
    const pi = r > 0 ? loanAmt * r / (1 - Math.pow(1 + r, -n)) : loanAmt / n;
    const taxMo = price * (lendTaxPct / 100) / 12;
    const insMo = lendInsYr / 12;
    const miMo = loanAmt * (lendType === "va" ? 0 : miRate) / 12;
    const monthly = pi + taxMo + insMo + miMo + lendHoa;
    const cashToClose = down + price * 0.03; // down + ~3% typical closing costs
    const presets = [
      ["conv20", "Conv 20%", "conv", 20], ["conv5", "Conv 5%", "conv", 5],
      ["fha", "FHA 3.5%", "fha", 3.5], ["va", "VA 0%", "va", 0],
    ];
    return (
      <div className="flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          <div className="rounded-2xl p-5 mb-3" style={{ background: QC.cardGrad, boxShadow: "0 18px 38px rgba(17,27,66,0.18)" }}>
            <p style={{ color: QC.goldHi, fontSize: 11, fontWeight: 900, letterSpacing: "0.16em", textTransform: "uppercase" }}>{lang === "es" ? "Pago mensual estimado" : "Monthly payment estimate"}</p>
            <p className="text-white" style={{ fontSize: 42, lineHeight: 1, fontWeight: 900, margin: "8px 0" }}>{m(monthly)}<span style={{ fontSize: 18, fontWeight: 700, color: "rgba(255,255,255,.7)" }}>/{lang === "es" ? "mes" : "mo"}</span></p>
            <p style={{ color: "rgba(255,255,255,0.76)", fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>
              {lang === "es" ? "Ajusta precio, enganche, tasa, impuestos y seguro para responder al instante." : "Slide price, down payment, rate, taxes, and insurance to answer buyer questions fast."}
            </p>
            <p className="mt-2" style={{ color: "rgba(255,255,255,0.72)", fontSize: 12, fontWeight: 700 }}>
              {lang === "es" ? "Efectivo estimado para cerrar" : "Est. cash to close"}: {m(cashToClose)} <span style={{ fontWeight: 500, opacity: 0.8 }}>({lang === "es" ? "enganche + ~3% de gastos" : "down + ~3% closing costs"})</span>
            </p>
            <div className="flex gap-2 mt-3">
              {[["P&I", m(pi)], [lang === "es" ? "Impuesto" : "Tax", m(taxMo)], [lang === "es" ? "Seguro" : "Insurance", m(insMo)], ...(miMo > 0 ? [[lendType === "fha" ? "MIP" : "PMI", m(miMo)]] : []), ...(lendHoa > 0 ? [["HOA", m(lendHoa)]] : [])].map(([l, v]) => (
                <div key={l} className="flex-1 rounded-xl text-center" style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.10)", padding: "8px 4px" }}>
                  <p className="text-white font-extrabold" style={{ fontSize: 13 }}>{v}</p>
                  <p style={{ color: QC.goldHi, fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginTop: 2 }}>{l}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl p-4" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 10 }}>{lang === "es" ? "Calculadora de financiamiento" : "Lending calculator"}</p>
            <div className="flex gap-1.5 mb-4 flex-wrap">
              {presets.map(([key, label, type, dp]) => {
                const on = lendType === type && lendDownPct === dp;
                return (
                  <button key={key} onClick={() => { setLendType(type); setLendDownPct(dp); }}
                    style={{ background: on ? QC.navy : "#fff", color: on ? "#fff" : QC.navy, border: `1.5px solid ${on ? QC.navy : QC.line}`, borderRadius: 20, padding: "6px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                    {label}
                  </button>
                );
              })}
            </div>
            <Slider label={lang === "es" ? "Precio" : "Home price"} value={price} display={m(price)} min={50000} max={2000000} step={5000} onChange={setLendPrice} />
            <Slider label={lang === "es" ? "Enganche" : "Down payment"} value={lendDownPct} display={`${lendDownPct}% · ${m(down)}`} min={0} max={50} step={1} onChange={setLendDownPct} />
            <Slider label={lang === "es" ? "Tasa de interés" : "Interest rate"} value={lendRate} display={`${lendRate.toFixed(2)}%`} min={2} max={12} step={0.05} onChange={setLendRate} />
            <Slider label={lang === "es" ? "Plazo" : "Loan term"} value={lendTerm} display={`${lendTerm} ${lang === "es" ? "años" : "yr"}`} min={10} max={30} step={5} onChange={setLendTerm} />
            <Slider label={lang === "es" ? "Impuesto predial / año" : "Property tax / yr"} value={lendTaxPct} display={`${lendTaxPct.toFixed(2)}%`} min={0} max={3} step={0.05} onChange={setLendTaxPct} />
            <Slider label={lang === "es" ? "Seguro / año" : "Insurance / yr"} value={lendInsYr} display={m(lendInsYr)} min={0} max={6000} step={100} onChange={setLendInsYr} />
            <Slider label="HOA / mo" value={lendHoa} display={`${m(lendHoa)}/${lang === "es" ? "mes" : "mo"}`} min={0} max={600} step={25} onChange={setLendHoa} />
            {lookup?.value
              ? <p className="mt-1" style={{ color: QC.muted, fontSize: 11, fontWeight: 600 }}>{lang === "es" ? "Precio inicial tomado del valor de mercado estimado." : "Starting price taken from the estimated market value."}</p>
              : <p className="mt-1" style={{ color: QC.muted, fontSize: 11, fontWeight: 600 }}>{lang === "es" ? "Busca una propiedad para empezar con su valor de mercado." : "Search a property to start from its market value."}</p>}
            <p className="mt-2" style={{ color: "#66759D", fontSize: 10.5, fontWeight: 600, lineHeight: 1.5 }}>⚠️ {lang === "es" ? "Estimado — no es una oferta de préstamo. Tasas, PMI y cargos varían según crédito y prestamista." : "Estimate — not a loan offer. Rates, PMI and fees vary by credit and lender."}</p>
          </div>
        </div>
      </div>
    );
  };

  /* ── 03 · TAX — independent tax lookup (its own search) ── */
  const Tax = () => {
    const num = (n) => Number(n).toLocaleString("en-US");

    // A tax search is running
    if (measuring && !taxLookup) {
      const phases = [t.measuring1, lang === "es" ? "Buscando registro fiscal…" : "Pulling tax record…", lang === "es" ? "Preparando resumen…" : "Preparing summary…"];
      return (
        <div className="flex-1 flex flex-col items-center justify-center px-7 text-center" style={{ background: QC.bg }}>
          <span className="text-5xl mb-4" style={{ animation: "ttpPulse 1.2s ease-in-out infinite" }}>🧾</span>
          <p className="font-extrabold mb-1" style={{ color: QC.navyDeep, fontSize: 20 }}>{addrQ}</p>
          <p className="mb-6" style={{ color: QC.gold, fontSize: 11, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Buscando impuestos" : "Looking up tax"}</p>
          <div className="text-left">
            {phases.map((ph, i) => (
              <p key={ph} className="py-1 font-semibold" style={{ color: i < measurePhase ? QC.green : i === measurePhase ? QC.navy : QC.line }}>{i < measurePhase ? "✓ " : i === measurePhase ? "● " : "○ "}{ph}</p>
            ))}
          </div>
        </div>
      );
    }

    // No tax record yet → the Tax tab's own address search
    if (!taxLookup) {
      const q = addrQ.trim().toLowerCase();
      const matches = placeSugs !== null ? placeSugs : []; // live suggestions only — no built-in demo addresses
      const custom = addrQ.trim() && !matches.some(m => m.text.toLowerCase() === q) ? addrQ.trim() : null;
      const go = () => { if (custom) startLookup(custom, null, null, "tax"); else if (matches[0]) startLookup(matches[0].text, matches[0].placeId, null, "tax"); };
      return (
        <div className="flex-1" style={{ background: QC.bg }}>
          <div className="px-5 py-4" style={{ background: QC.headGrad, borderBottom: `2px solid ${QC.gold}` }}>
            <p className="text-center" style={{ color: QC.goldHi, fontSize: 11, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Impuestos de propiedad" : "Property Tax"}</p>
            <p className="text-center font-extrabold text-white mt-0.5" style={{ fontSize: 18 }}>{lang === "es" ? "Busca impuestos por dirección" : "Look up property tax by address"}</p>
          </div>
          <div className="px-5 pt-3">
            <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
              <p className="mb-2" style={{ color: QC.muted2, fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Dirección de la propiedad" : "Property Address"}</p>
              <div className="flex gap-2">
                <button onClick={useMyLocation} title={t.useMyLocation} className="flex items-center justify-center shrink-0 active:scale-95 transition-transform"
                  style={{ width: 48, height: 48, background: QC.bg, border: `1.5px solid ${QC.line}`, borderRadius: 12, color: QC.navy, fontSize: 18 }}>📍</button>
                <div className="flex-1 flex items-center gap-2 rounded-xl px-3" style={{ background: QC.bg, border: `1.5px solid ${QC.line}` }}>
                  <input value={addrQ} onChange={(e) => onAddrInput(e.target.value)} placeholder={lang === "es" ? "Escribe una dirección…" : "Enter a property address…"} autoFocus
                    onKeyDown={(e) => e.key === "Enter" && go()}
                    className="flex-1 py-3 text-base font-semibold outline-none bg-transparent" style={{ color: QC.navy }} />
                  {hasVoice && (
                    <button onClick={() => startVoice(onAddrInput)} className="text-xl active:scale-90 transition-transform" style={{ background: "none", border: "none", opacity: listening ? 1 : 0.6 }}>{listening ? "🔴" : "🎤"}</button>
                  )}
                </div>
              </div>
              {(custom || matches.length > 0) && (
                <div className="rounded-xl mt-2 overflow-hidden" style={{ border: `1.5px solid ${QC.line}` }}>
                  {custom && (
                    <button onClick={() => startLookup(custom, null, null, "tax")} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left active:opacity-80" style={{ background: "#fff", borderBottom: matches.length ? `1px solid ${QC.bg}` : "none" }}>
                      <span style={{ color: QC.navy }}>📍</span><span className="font-bold truncate" style={{ color: QC.navy, fontSize: 13 }}>{custom}</span>
                    </button>
                  )}
                  {matches.map((mm, i) => (
                    <button key={mm.text} onClick={() => startLookup(mm.text, mm.placeId, null, "tax")} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left active:opacity-80" style={{ background: "#fff", borderBottom: i < matches.length - 1 ? `1px solid ${QC.bg}` : "none" }}>
                      <span style={{ color: QC.navy }}>📍</span><span className="font-semibold truncate" style={{ color: QC.navy, fontSize: 13 }}>{mm.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={go} className="w-full active:translate-y-px transition-transform"
              style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 12, padding: 15, fontSize: 16, fontWeight: 700, boxShadow: "0 4px 14px rgba(27,42,92,0.3)" }}>
              {lang === "es" ? "Ver impuestos" : "Get Tax Info"}
            </button>
            <p className="text-center mt-3" style={{ color: QC.muted, fontSize: 11, fontWeight: 600 }}>{lang === "es" ? "Solo impuestos — no necesitas correr comparables" : "Tax only — no need to run comps"}{session ? "" : " · DEMO"}</p>
          </div>
        </div>
      );
    }

    // We have a tax record — the realtor's complete county-record report
    const R = taxLookup;
    const subj = R.subject || {};
    const hasRealAssess = subj.assessedValue != null;
    const assessed = hasRealAssess ? subj.assessedValue : (R.value ? Math.round(R.value * 0.86) : null);
    const hasRealTax = subj.annualTax != null;
    const stateRate = TAX_RATE_BY_STATE[stateFromAddress(subj.address || R.addr)] || 0.011;
    const annualTax = hasRealTax ? subj.annualTax : (R.value ? Math.round(R.value * stateRate) : assessed ? Math.round(assessed * 0.011) : null);
    const taxYear = subj.taxYear || new Date().getFullYear();
    const effRate = annualTax && assessed ? ((annualTax / assessed) * 100).toFixed(2) + "%" : null;
    const saleDate = subj.lastSaleDate ? new Date(subj.lastSaleDate) : null;
    const saleDateTxt = saleDate && !Number.isNaN(saleDate.getTime()) ? saleDate.toLocaleDateString(lang === "es" ? "es-MX" : "en-US", { month: "short", year: "numeric" }) : null;
    const taxHist = Array.isArray(subj.taxHistory) ? subj.taxHistory.filter((r) => r.total != null) : [];
    const facts = [["🛏️", subj.beds ?? "—", t.beds], ["🛁", subj.baths ?? "—", t.baths], ["📐", subj.sqft ? num(subj.sqft) : "—", t.cmpSqft], ["📅", subj.yearBuilt ?? "—", t.builtIn]];
    const Sect = ({ label, children }) => (
      <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
        <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 6 }}>{label}</p>
        {children}
      </div>
    );
    const KV = ({ rows }) => rows.filter(([, v]) => v != null && v !== "—").map(([k, v], i) => (
      <div key={k} className="flex justify-between gap-3 py-2" style={{ borderTop: i ? `1px solid ${QC.line}` : "none" }}>
        <span style={{ color: QC.muted2, fontSize: 13, fontWeight: 600 }}>{k}</span>
        <span className="font-extrabold text-right" style={{ color: QC.navy, fontSize: 13 }}>{v}</span>
      </div>
    ));
    return (
      <div className="flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          {/* Ownership — who the realtor is actually talking to */}
          <Sect label={lang === "es" ? "Dueño y registro" : "Ownership & record"}>
            <p className="font-extrabold mb-1" style={{ color: QC.navyDeep, fontSize: 16, lineHeight: 1.3 }}>{subj.address || R.addr}</p>
            <KV rows={[
              [lang === "es" ? "Dueño registrado" : "Owner of record", subj.owner || (lang === "es" ? "Según registro público" : "Per public record")],
              [lang === "es" ? "¿Vive el dueño ahí?" : "Owner-occupied", subj.ownerOccupied == null ? null : (subj.ownerOccupied ? (lang === "es" ? "Sí" : "Yes") : "No")],
              [lang === "es" ? "Condado" : "County", subj.county],
              [lang === "es" ? "Colonia / subdivisión" : "Subdivision", subj.subdivision],
            ]} />
          </Sect>

          {/* Taxes — what they pay, and the trail of what they've paid */}
          <Sect label={lang === "es" ? "Impuestos" : "Property taxes"}>
            <KV rows={[
              [lang === "es" ? (hasRealTax ? "Impuesto anual" : "Impuesto anual (est.)") : (hasRealTax ? "Annual tax" : "Annual tax (est.)"), annualTax ? "$" + num(annualTax) : null],
              [lang === "es" ? "Año fiscal" : "Tax year", String(taxYear)],
              [lang === "es" ? "Valor catastral" : "Assessed value", assessed ? "$" + num(assessed) + (hasRealAssess ? "" : " (est.)") : null],
              [lang === "es" ? "· Terreno" : "· Land", subj.assessedLand ? "$" + num(subj.assessedLand) : null],
              [lang === "es" ? "· Construcción" : "· Improvements", subj.assessedImprovements ? "$" + num(subj.assessedImprovements) : null],
              [lang === "es" ? "Tasa efectiva" : "Effective rate", effRate],
            ]} />
            {taxHist.length >= 2 && (
              <div className="rounded-xl mt-2 px-3 py-2.5" style={{ background: QC.bg, border: `1px solid ${QC.line}` }}>
                <p style={{ color: QC.muted2, fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 4 }}>{lang === "es" ? "Historial de impuestos" : "Tax history"}</p>
                {taxHist.map((r, i) => (
                  <div key={r.year} className="flex justify-between py-1" style={{ borderTop: i ? `1px solid ${QC.line}` : "none", fontSize: 12.5, fontWeight: 700 }}>
                    <span style={{ color: QC.muted2 }}>{r.year}</span>
                    <span style={{ color: QC.navy }}>${num(r.total)}{i < taxHist.length - 1 && taxHist[i + 1].total ? <span style={{ color: r.total >= taxHist[i + 1].total ? "#C0392B" : "#1E7B3C", fontSize: 10.5, marginLeft: 6 }}>{r.total >= taxHist[i + 1].total ? "▲" : "▼"}{Math.abs(((r.total - taxHist[i + 1].total) / taxHist[i + 1].total) * 100).toFixed(1)}%</span> : null}</span>
                  </div>
                ))}
              </div>
            )}
          </Sect>

          {/* Sale history — what they paid tells the realtor their equity story */}
          {(subj.lastSalePrice || saleDateTxt) && (
            <Sect label={lang === "es" ? "Última venta" : "Last sale"}>
              <KV rows={[
                [lang === "es" ? "Precio de compra" : "Sale price", subj.lastSalePrice ? "$" + num(subj.lastSalePrice) : null],
                [lang === "es" ? "Fecha" : "Date", saleDateTxt],
                ...(subj.lastSalePrice && R.value ? [[lang === "es" ? "Plusvalía estimada" : "Est. equity gained", "$" + num(Math.max(0, R.value - subj.lastSalePrice))]] : []),
              ]} />
            </Sect>
          )}

          {/* Property facts */}
          <Sect label={lang === "es" ? "Datos de la propiedad" : "Property facts"}>
            <div className="grid grid-cols-4 gap-2 mb-1">
              {facts.map(([icon, v, label]) => (
                <div key={label} style={{ background: QC.bg, border: `1px solid ${QC.line}`, borderRadius: 10, padding: "10px 6px", textAlign: "center" }}>
                  <p className="font-extrabold" style={{ color: QC.navy, fontSize: 15 }}>{v}</p>
                  <p style={{ color: QC.muted, fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 3 }}>{icon} {label}</p>
                </div>
              ))}
            </div>
            <KV rows={[
              [lang === "es" ? "Tipo" : "Type", subj.propertyType],
              [lang === "es" ? "Terreno" : "Lot size", subj.lotSize ? num(subj.lotSize) + " " + (lang === "es" ? "pie²" : "sq ft") : null],
            ]} />
          </Sect>
          <div className="flex items-center gap-2 rounded-xl px-3 py-2.5 mb-3" style={{ background: QC.bg, border: `1px solid ${QC.line}` }}>
            <span style={{ color: QC.green }}>✓</span>
            <span style={{ color: QC.body, fontSize: 12, fontWeight: 600 }}>{lang === "es" ? "Resumen fiscal listo para el cliente" : "Client-ready tax summary available"}</span>
          </div>
          <button onClick={() => { setAddrQ(""); setPlaceSugs(null); setTaxLookup(null); }} className="w-full active:translate-y-px transition-transform"
            style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 12, padding: 15, fontSize: 16, fontWeight: 700, boxShadow: "0 4px 14px rgba(27,42,92,0.3)" }}>
            {lang === "es" ? "Nueva búsqueda" : "New search"}
          </button>
          {(!hasRealAssess || !hasRealTax) && <p className="mt-3" style={{ color: "#66759D", fontSize: 11, fontWeight: 600, lineHeight: 1.5 }}>⚠️ {lang === "es" ? "Valores catastrales estimados — confirma con el condado." : "Assessed values are estimates — confirm with the county."}</p>}
          <p className="mt-2" style={{ color: "#66759D", fontSize: 11, fontWeight: 600, lineHeight: 1.5 }}>ℹ️ {lang === "es" ? "Al venderse, el impuesto suele recalcularse — las exenciones del dueño actual no se transfieren al comprador." : "After a sale, taxes are usually recalculated — the current owner's exemptions don't transfer to the buyer."}</p>
        </div>
      </div>
    );
  };

  /* ── 04 · WORKSPACE — the agent's tools + Realtor branding ── */
  const Workspace = () => {
    return (
      <div className="flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          {/* Listing writer — standalone entry: type the facts from anywhere */}
          <button onClick={() => openListing(null)} className="w-full flex items-center gap-3 rounded-2xl p-4 mb-3 text-left active:scale-[0.99] transition-transform"
            style={{ background: "#fff", border: `2px solid ${QC.goldLine}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)", cursor: "pointer" }}>
            <span style={{ fontSize: 22 }}>✨</span>
            <span className="flex-1 min-w-0">
              <span className="block font-extrabold" style={{ color: QC.navyDeep, fontSize: 14 }}>{lang === "es" ? "Redactor de listing (IA)" : "Listing writer (AI)"}</span>
              <span className="block" style={{ color: QC.muted2, fontSize: 11, fontWeight: 600 }}>{lang === "es" ? "Escribe los datos de donde sea — descripción MLS + post social al instante." : "Type the facts from anywhere — instant MLS description + social caption."}</span>
            </span>
            <span style={{ color: QC.gold, fontSize: 18 }}>›</span>
          </button>

          {/* Appraisal defense — send the appraiser your comps as a clean PDF */}
          <button onClick={() => setScreen("appraisal")} className="w-full flex items-center gap-3 rounded-2xl p-4 mb-3 text-left active:scale-[0.99] transition-transform"
            style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)", cursor: "pointer" }}>
            <span style={{ fontSize: 22 }}>🛡️</span>
            <span className="flex-1 min-w-0">
              <span className="block font-extrabold" style={{ color: QC.navyDeep, fontSize: 14 }}>{lang === "es" ? "Paquete para avalúo" : "Appraisal defense packet"}</span>
              <span className="block" style={{ color: QC.muted2, fontSize: 11, fontWeight: 600 }}>{lang === "es" ? "¿Avalúo bajo? Manda tus comparables al valuador en un PDF limpio." : "Low appraisal? Send the appraiser your comps as a clean PDF."}</span>
            </span>
            <span style={{ color: QC.gold, fontSize: 18 }}>›</span>
          </button>

          {/* Widget embed code — paste it into their own website (Widget tier) */}
          {session && mySlug && (() => {
            const embedCode = `<iframe src="${window.location.origin}/w/${mySlug}" style="width:100%;max-width:420px;height:660px;border:0;border-radius:24px;box-shadow:0 12px 32px rgba(16,27,48,.15)" loading="lazy" title="Home value"></iframe>`;
            return (
              <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
                <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 4 }}>{lang === "es" ? "Tu valuador, en tu página" : "Your widget, on your website"}</p>
                <p className="font-extrabold mb-1" style={{ color: QC.navyDeep, fontSize: 14 }}>🌐 {lang === "es" ? "Pega este código en tu sitio" : "Paste this code into your site"}</p>
                <p className="mb-2" style={{ color: QC.muted2, fontSize: 11, fontWeight: 600, lineHeight: 1.5 }}>{lang === "es" ? "Pégalo en tu página — o mándaselo a quien te la maneja. Funciona en WordPress, Wix, GoDaddy, cualquier sitio. Cada dueño que valúa su casa te llega como lead." : "Paste it into your website — or send it to whoever manages it. Works on WordPress, Wix, GoDaddy, any site. Every homeowner who checks their value lands in your phone as a lead."}</p>
                <textarea readOnly rows={3} value={embedCode} onFocus={(e) => e.target.select()}
                  className="w-full rounded-xl px-3 py-2.5 mb-2 outline-none resize-none"
                  style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.muted2, fontSize: 10.5, fontFamily: "monospace", lineHeight: 1.5 }} />
                <div className="flex gap-2">
                  <button onClick={() => copyText(embedCode)} className="flex-1 active:translate-y-px transition-transform"
                    style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 10, padding: 11, fontWeight: 800, fontSize: 13, cursor: "pointer" }}>📋 {lang === "es" ? "Copiar código" : "Copy code"}</button>
                  <a href={`/w/${mySlug}`} target="_blank" rel="noreferrer" className="flex items-center justify-center"
                    style={{ background: "#fff", color: QC.navy, border: `1.5px solid ${QC.line}`, borderRadius: 10, padding: "11px 16px", fontWeight: 800, fontSize: 13, textDecoration: "none" }}>{lang === "es" ? "Ver mi valuador" : "See my widget"}</a>
                </div>
              </div>
            );
          })()}

          {sentReports.length > 0 && (
            <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
              <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 8 }}>{lang === "es" ? "Informes enviados" : "Reports sent"}</p>
              {sentReports.slice(0, 8).map((rp) => {
                const op = reportOpens[rp.rid];
                return (
                  <div key={rp.rid} className="flex items-center justify-between gap-2 py-2" style={{ borderTop: `1px solid ${QC.line}` }}>
                    <span className="min-w-0">
                      <span className="block font-bold truncate" style={{ color: QC.navyDeep, fontSize: 13 }}>{rp.addr}</span>
                      <span className="block" style={{ color: QC.muted2, fontSize: 10.5, fontWeight: 600 }}>{rp.v ? "$" + Number(rp.v).toLocaleString("en-US") : ""} · {new Date(rp.at).toLocaleDateString(lang === "es" ? "es-MX" : "en-US", { month: "short", day: "numeric" })}</span>
                    </span>
                    <span className="shrink-0 rounded-full px-2.5 py-1" style={{ background: op?.n ? "#EAF8EF" : QC.bg, border: `1px solid ${op?.n ? "#9fd8b0" : QC.line}`, color: op?.n ? "#1E7B3C" : QC.muted2, fontSize: 11, fontWeight: 800 }}>
                      👀 {op?.n || 0} {lang === "es" ? (op?.n === 1 ? "vista" : "vistas") : (op?.n === 1 ? "view" : "views")}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {/* Past searches — one collapsed row; expands into month groups so a
              search from months ago is three taps away without owning the screen */}
          {savedWork.length > 0 && (
            <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
              <button onClick={() => setSearchesOpen((o) => !o)} className="w-full flex items-center gap-3 text-left active:opacity-80"
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}>
                <span style={{ fontSize: 20 }}>🕘</span>
                <span className="flex-1 min-w-0">
                  <span className="block font-extrabold" style={{ color: QC.navyDeep, fontSize: 14 }}>{lang === "es" ? "Búsquedas anteriores" : "Past searches"}</span>
                  <span className="block" style={{ color: QC.muted2, fontSize: 11, fontWeight: 600 }}>{savedWork.length} {lang === "es" ? "propiedades — toca para reabrir" : "properties — tap any to reopen"}</span>
                </span>
                <span style={{ color: QC.gold, fontSize: 14 }}>{searchesOpen ? "▾" : "▸"}</span>
              </button>
              {searchesOpen && (() => {
                const groups = [];
                savedWork.forEach((it) => {
                  const d = new Date(it.ts || 0);
                  const known = it.ts != null && !Number.isNaN(d.getTime());
                  const k = known ? `${d.getFullYear()}-${d.getMonth()}` : "old";
                  const label = known ? d.toLocaleDateString(lang === "es" ? "es-MX" : "en-US", { month: "long", year: "numeric" }) : (lang === "es" ? "Anteriores" : "Earlier");
                  const g = groups[groups.length - 1];
                  if (g && g.k === k) g.items.push(it); else groups.push({ k, label, items: [it] });
                });
                return groups.map((g, gi) => {
                  const open = searchMonths?.[g.k] ?? (gi === 0);
                  return (
                    <div key={g.k} className="mt-3">
                      <button onClick={() => setSearchMonths((m) => ({ ...(m || {}), [g.k]: !open }))}
                        className="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-left active:opacity-80"
                        style={{ background: QC.bg, border: `1px solid ${QC.line}`, cursor: "pointer" }}>
                        <span style={{ color: QC.gold, fontSize: 11 }}>{open ? "▾" : "▸"}</span>
                        <span className="flex-1 font-extrabold capitalize" style={{ color: QC.navyDeep, fontSize: 12.5 }}>{g.label}</span>
                        <span style={{ color: QC.muted2, fontSize: 11, fontWeight: 700 }}>{g.items.length}</span>
                      </button>
                      {open && g.items.map((it, i) => (
                        <button key={(it.addr || "") + i} onClick={() => reopenSaved(it)} className="w-full flex items-center gap-2.5 py-2.5 px-1 text-left active:opacity-80"
                          style={{ background: "none", border: "none", borderBottom: `1px solid ${QC.line}`, cursor: "pointer" }}>
                          <span className="flex-1 min-w-0">
                            <span className="block font-bold truncate" style={{ color: QC.navyDeep, fontSize: 13 }}>{it.addr || "—"}</span>
                            <span className="block" style={{ color: QC.muted2, fontSize: 10.5, fontWeight: 600 }}>{it.value ? fmt(it.value) : "—"}{it.ts ? ` · ${new Date(it.ts).toLocaleDateString(lang === "es" ? "es-MX" : "en-US", { month: "short", day: "numeric" })}` : ""}</span>
                          </span>
                          <span style={{ color: QC.gold, fontSize: 15 }}>›</span>
                        </button>
                      ))}
                    </div>
                  );
                });
              })()}
            </div>
          )}

          {/* Realtor profile — collapsed by default; tap to edit branding */}
          <div className="rounded-2xl p-4" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <button onClick={() => setProfileOpen((o) => !o)} className="w-full flex items-center gap-3 text-left active:opacity-80"
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}>
              <span className="shrink-0 flex items-center justify-center rounded-xl font-extrabold" style={{ width: 38, height: 38, background: QC.headGrad, color: QC.goldHi, fontSize: 16 }}>{(userName || "R")[0].toUpperCase()}</span>
              <span className="flex-1 min-w-0">
                <span className="block" style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Perfil del agente" : "Realtor profile"}</span>
                <span className="block font-extrabold truncate" style={{ color: QC.navyDeep, fontSize: 14 }}>{userName || (lang === "es" ? "Tu nombre" : "Your name")}{bizName ? ` · ${bizName}` : ""}</span>
              </span>
              <span style={{ color: QC.gold, fontSize: 14 }}>{profileOpen ? "▾" : "▸"}</span>
            </button>
            {profileOpen && (<div className="mt-3">
            <div className="flex items-center gap-2 rounded-xl px-3 py-2.5 mb-3" style={{ background: QC.bg, border: `1px solid ${QC.line}` }}>
              <span style={{ color: QC.gold }}>✦</span>
              <span style={{ color: QC.body, fontSize: 12, fontWeight: 600 }}>{lang === "es" ? "Marca personal activa — tus informes la usan." : "Personal branding is active — reports use it."}</span>
            </div>
            <div className="flex items-center gap-2 mb-3">
              <span style={{ color: QC.muted2, fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase" }}>{lang === "es" ? "Idioma" : "Language"}</span>
              {[["en", "English"], ["es", "Español"]].map(([code, label]) => {
                const on = lang === code;
                return (
                  <button key={code} onClick={() => { setLang(code); saveProfile({ lang: code }); }}
                    style={{ background: on ? QC.navy : "#fff", color: on ? "#fff" : QC.navy, border: `1.5px solid ${on ? QC.navy : QC.line}`, borderRadius: 20, padding: "6px 14px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>{label}</button>
                );
              })}
            </div>
            <input value={userName} onChange={(e) => { setUserName(e.target.value); saveProfile({ name: e.target.value }); }} placeholder={lang === "es" ? "Nombre del agente" : "Realtor name"}
              className="w-full rounded-xl px-3.5 py-3 mb-2 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
            <input value={bizName} onChange={(e) => { setBizName(e.target.value); saveProfile({ biz: e.target.value }); }} placeholder={lang === "es" ? "Inmobiliaria / Brokerage" : "Brokerage"}
              className="w-full rounded-xl px-3.5 py-3 mb-2 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
            <input value={userPhone} onChange={(e) => { setUserPhone(e.target.value); saveProfile({ phone: e.target.value }); }} placeholder={lang === "es" ? "Teléfono" : "Phone"} inputMode="tel"
              className="w-full rounded-xl px-3.5 py-3 mb-2 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
            <input value={bizEmail} onChange={(e) => { setBizEmail(e.target.value); saveProfile({ email: e.target.value }); }} placeholder={lang === "es" ? "Email" : "Email"} inputMode="email"
              className="w-full rounded-xl px-3.5 py-3 mb-2 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
            <input value={license} onChange={(e) => { setLicense(e.target.value); saveProfile({ license: e.target.value }); }} placeholder={lang === "es" ? "Licencia # (opcional)" : "License # (optional)"}
              className="w-full rounded-xl px-3.5 py-3 mb-2 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
            <input value={market} onChange={(e) => { setMarket(e.target.value); saveProfile({ market: e.target.value }); }} placeholder={lang === "es" ? "Tu mercado (ej. McAllen, TX)" : "Your market (e.g. McAllen, TX)"}
              className="w-full rounded-xl px-3.5 py-3 mb-3 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
            <p style={{ color: QC.muted2, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>{lang === "es" ? "Color de tu marca — tus informes lo usan" : "Your brand color — your reports use it"}</p>
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <input type="color" value={brand} onChange={(e) => { setBrandColor(e.target.value); saveProfile({ brandColor: e.target.value }); }}
                style={{ width: 46, height: 36, border: `1.5px solid ${QC.line}`, borderRadius: 10, background: "#fff", padding: 3, cursor: "pointer" }} />
              {["#1B2A5C", "#7A1F2B", "#14532D", "#3B2E7E", "#0F766E", "#111111"].map((c) => (
                <button key={c} onClick={() => { setBrandColor(c); saveProfile({ brandColor: c }); }} title={c}
                  style={{ width: 28, height: 28, borderRadius: 8, background: c, border: brand === c ? `2.5px solid ${QC.goldLine}` : "2px solid #fff", boxShadow: "0 1px 4px rgba(0,0,0,0.25)", cursor: "pointer" }} />
              ))}
            </div>
            <p style={{ color: QC.muted2, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>{lang === "es" ? "Logo o foto (opcional)" : "Logo or headshot (optional)"}</p>
            {logo
              ? (<div className="flex items-center gap-3">
                  <img src={logo} alt="" style={{ height: 44, maxWidth: 120, objectFit: "contain", borderRadius: 8, background: "#fff", border: `1px solid ${QC.line}`, padding: 4 }} />
                  <button onClick={() => { setLogo(null); logoIdRef.current = null; saveProfile({ logo: null }); }}
                    style={{ background: "#fff", color: QC.navy, border: `1.5px solid ${QC.line}`, borderRadius: 10, padding: "8px 14px", fontWeight: 700, fontSize: 13 }}>{lang === "es" ? "Quitar" : "Remove"}</button>
                </div>)
              : (<label className="block rounded-xl px-3.5 py-3 text-center cursor-pointer font-semibold" style={{ background: QC.bg, border: `1.5px dashed ${QC.line}`, color: QC.muted2, fontSize: 13 }}>
                  {lang === "es" ? "＋ Subir imagen" : "＋ Upload image"}
                  <input type="file" accept="image/*" onChange={(e) => onLogoFile(e.target.files?.[0])} style={{ display: "none" }} />
                </label>)}
            {/* Live preview — an exact replica of the document masthead, updating
                as the realtor edits their color, logo, and identity above */}
            <p style={{ color: QC.muted2, fontSize: 11, fontWeight: 700, margin: "14px 0 6px" }}>{lang === "es" ? "Vista previa — así abren tus informes" : "Preview — how your reports open"}</p>
            <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${QC.line}`, boxShadow: "0 4px 14px rgba(17,27,66,0.10)" }}>
              <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ background: brandGrad, borderBottom: `2.5px solid ${brandTint}` }}>
                <div className="flex items-center gap-2.5 min-w-0">
                  {logo && <img src={logo} alt="" className="shrink-0" style={{ height: 32, maxWidth: 84, objectFit: "contain", background: "#fff", borderRadius: 7, padding: 3 }} />}
                  <div className="min-w-0">
                    <p style={{ color: brandTint, fontSize: 7.5, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Presentado por" : "Presented by"}</p>
                    <p className="text-white font-extrabold truncate" style={{ fontSize: 13 }}>{userName || (lang === "es" ? "Tu nombre" : "Your name")}</p>
                    {bizName && <p className="truncate" style={{ color: "rgba(255,255,255,0.7)", fontSize: 10.5 }}>{bizName}</p>}
                    {(userPhone || bizEmail) && <p className="truncate" style={{ color: "rgba(255,255,255,0.62)", fontSize: 10 }}>{[userPhone, bizEmail].filter(Boolean).join(" · ")}</p>}
                    {license && <p className="truncate" style={{ color: "rgba(255,255,255,0.5)", fontSize: 9 }}>Lic. {license}</p>}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p style={{ color: brandTint, fontSize: 7, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase" }}>{new Date().toLocaleDateString(lang === "es" ? "es-MX" : "en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
                  <p style={{ color: "rgba(255,255,255,0.72)", fontSize: 7, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", marginTop: 2 }}>{lang === "es" ? "Privado y confidencial" : "Private & confidential"}</p>
                </div>
              </div>
              <div className="px-4 py-2.5" style={{ background: "#fff" }}>
                <p style={{ color: QC.muted2, fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase" }}>{lang === "es" ? "Valor de mercado estimado" : "Estimated market value"}</p>
                <p style={{ color: brand, fontFamily: DOC.serif, fontSize: 17, fontWeight: 700 }}>$284,000 – $301,500</p>
              </div>
            </div>
            </div>)}
          </div>
        </div>
      </div>
    );
  };

  /* ── 04 · LEADS — the seller-lead inbox + one-tap share of the lead form ── */
  const Leads = () => {
    const ago = (x) => {
      if (!x) return "";
      const h = (Date.now() - new Date(x).getTime()) / 36e5;
      if (h < 1) return lang === "es" ? "hace minutos" : "minutes ago";
      if (h < 24) return lang === "es" ? `hace ${Math.round(h)}h` : `${Math.round(h)}h ago`;
      return lang === "es" ? `hace ${Math.round(h / 24)}d` : `${Math.round(h / 24)}d ago`;
    };
    const digits = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length === 10 ? "1" + d : d; };
    const waMsg = (l) => {
      const first = String(l.name || "").trim().split(/\s+/)[0] || "";
      const who = [userName, bizName].filter(Boolean).join(" · ");
      return lang === "es"
        ? `Hola${first ? " " + first : ""}! Soy ${who || "tu agente"} — vi que checaste el valor de tu casa${l.address ? ` en ${l.address}` : ""}. Te preparo el análisis completo gratis. ¿Cuándo te puedo llamar?`
        : `Hi${first ? " " + first : ""}! This is ${who || "your agent"} — I saw you checked your home's value${l.address ? ` at ${l.address}` : ""}. I'll put together the full analysis for you, free. When's a good time to call?`;
    };
    return (
      <div className="flex-1 overflow-y-auto pb-10" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          {/* Compact share card — the months below get the screen space */}
          <div className="rounded-2xl p-3.5 mb-3" style={{ background: "#fff", border: `2px solid ${QC.goldLine}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <div className="flex items-center justify-between mb-1">
              <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Consigue más leads" : "Get more leads"}</p>
              <span style={{ color: QC.muted2, fontSize: 11, fontWeight: 800 }}>📥 {leads.length} {leads.length === 1 ? "lead" : "leads"}</span>
            </div>
            <p className="mb-2" style={{ color: QC.muted2, fontSize: 10.5, fontWeight: 600, lineHeight: 1.45 }}>{lang === "es" ? "Mándale tu formulario a un cliente — su info te llega aquí sola." : "Send your lead form to a client — their info lands here on its own."}</p>
            <button onClick={shareLeadForm} className="w-full active:translate-y-px transition-transform mb-1.5"
              style={{ background: "#25D366", color: "#fff", border: "none", borderRadius: 11, padding: 11, fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}>💬 {lang === "es" ? "Mandar mi formulario" : "Send my lead form"}</button>
            <div className="flex gap-2">
              <button onClick={() => copyText(leadFormUrl)} className="flex-1 active:translate-y-px transition-transform"
                style={{ background: QC.bg, color: QC.navy, border: `1.5px solid ${QC.line}`, borderRadius: 9, padding: 8, fontWeight: 800, fontSize: 11.5, cursor: "pointer" }}>📋 {lang === "es" ? "Copiar link" : "Copy link"}</button>
              <a href={leadFormUrl} target="_blank" rel="noreferrer" className="flex-1 flex items-center justify-center"
                style={{ background: QC.bg, color: QC.navy, border: `1.5px solid ${QC.line}`, borderRadius: 9, padding: 8, fontWeight: 800, fontSize: 11.5, textDecoration: "none" }}>👀 {lang === "es" ? "Ver formulario" : "Preview form"}</a>
            </div>
          </div>

          {leads.length === 0 ? (
            <div className="rounded-2xl text-center" style={{ background: "#fff", border: "1px dashed #CAD5E7", padding: "26px 22px" }}>
              <p style={{ color: "#66759D", fontSize: 13, fontWeight: 600 }}>{lang === "es" ? "Todavía no hay leads — comparte tu formulario y aparecerán aquí solos." : "No leads yet — share your form and they'll show up here on their own."}</p>
            </div>
          ) : (() => {
            // Group by month (leads arrive newest-first); latest month starts open
            const groups = [];
            leads.forEach((l) => {
              const d = new Date(l.created_at);
              const k = `${d.getFullYear()}-${d.getMonth()}`;
              const g = groups[groups.length - 1];
              if (g && g.k === k) g.items.push(l);
              else groups.push({ k, label: d.toLocaleDateString(lang === "es" ? "es-MX" : "en-US", { month: "long", year: "numeric" }), items: [l] });
            });
            return groups.map((g, gi) => {
              const open = monthsOpen?.[g.k] ?? (gi === 0);
              const gPending = g.items.filter((l) => (l.status || "new") === "new").length;
              return (
                <div key={g.k} className="mb-2.5">
                  <button onClick={() => setMonthsOpen((m) => ({ ...(m || {}), [g.k]: !open }))}
                    className="w-full flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-left active:opacity-80"
                    style={{ background: "#fff", border: `1px solid ${QC.line}`, cursor: "pointer" }}>
                    <span style={{ color: QC.gold, fontSize: 12 }}>{open ? "▾" : "▸"}</span>
                    <span className="flex-1 font-extrabold capitalize" style={{ color: QC.navyDeep, fontSize: 13 }}>{g.label}</span>
                    {gPending > 0 && <span className="shrink-0 rounded-full px-2 py-0.5 font-extrabold" style={{ background: QC.gold, color: QC.navyDeep, fontSize: 10.5 }}>{gPending}</span>}
                    <span style={{ color: QC.muted2, fontSize: 11.5, fontWeight: 700 }}>{g.items.length} {g.items.length === 1 ? "lead" : "leads"}</span>
                  </button>
                  {open && g.items.map((l) => {
                    const st = l.status || "new";
                    const isNew = st === "new";
                    const low = l.info?.low, high = l.info?.high;
                    return (
                      <div key={l.id} className="rounded-2xl p-4 mt-2" style={{ background: "#fff", border: isNew ? `2px solid ${QC.goldLine}` : `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <span className="font-extrabold" style={{ color: QC.navyDeep, fontSize: 15 }}>{l.name || (lang === "es" ? "(sin nombre)" : "(no name)")}</span>
                          {isNew && <span className="shrink-0 rounded-full px-2 py-0.5" style={{ background: "#FDF3D7", border: `1px solid ${QC.goldLine}`, color: "#8A6A00", fontSize: 10, fontWeight: 900, letterSpacing: "0.06em" }}>{lang === "es" ? "NUEVO" : "NEW"}</span>}
                        </div>
                        {l.address ? <p style={{ color: QC.body, fontSize: 12.5, fontWeight: 600 }}>📍 {l.address}</p> : null}
                        <p className="mb-2" style={{ color: QC.muted2, fontSize: 11.5, fontWeight: 600 }}>
                          {l.phone}{low && high ? ` · ${fmt(low)}–${fmt(high)}` : ""} · {ago(l.created_at)}
                        </p>
                        {/* Not a CRM — one tap says where this lead stands */}
                        <div className="flex gap-1.5 mb-2">
                          {[
                            ["contacted", lang === "es" ? "Contactado" : "Contacted", "#1E7B3C", "#EAF8EF", "#A7E0BC"],
                            ["interested", lang === "es" ? "Interesado" : "Interested", "#8A6A00", "#FDF3D7", QC.goldLine],
                            ["not-interested", lang === "es" ? "No interesado" : "Not interested", "#67718A", "#F2F4F7", "#D5DAE3"],
                          ].map(([val, lbl, fg, bg, bd]) => {
                            const on = st === val;
                            return (
                              <button key={val} onClick={() => markLead(l.id, val)} className="flex-1 active:translate-y-px"
                                style={{ background: on ? bg : "#fff", color: on ? fg : QC.muted2, border: `1.5px solid ${on ? bd : QC.line}`, borderRadius: 9, padding: "7px 2px", fontWeight: 800, fontSize: 10.5, cursor: "pointer", whiteSpace: "nowrap" }}>
                                {on ? "✓ " : ""}{lbl}
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex gap-2">
                          <a href={`https://wa.me/${digits(l.phone)}?text=${encodeURIComponent(waMsg(l))}`} target="_blank" rel="noreferrer"
                            onClick={() => isNew && markLead(l.id, "contacted")} className="flex-1 text-center"
                            style={{ background: "#25D366", color: "#fff", borderRadius: 10, padding: 10, fontWeight: 800, fontSize: 12.5, textDecoration: "none" }}>💬 WhatsApp</a>
                          <a href={`tel:+${digits(l.phone)}`} onClick={() => isNew && markLead(l.id, "contacted")} className="flex-1 text-center"
                            style={{ background: QC.navy, color: "#fff", borderRadius: 10, padding: 10, fontWeight: 800, fontSize: 12.5, textDecoration: "none" }}>📞 {lang === "es" ? "Llamar" : "Call"}</a>
                        </div>
                        {/* Optional one-liner note */}
                        {l.info?.note
                          ? <button onClick={() => { const n = window.prompt(lang === "es" ? "Nota del lead" : "Lead note", l.info.note); if (n !== null) noteLead(l.id, n.slice(0, 300)); }}
                              className="w-full text-left mt-2 active:opacity-80" style={{ background: QC.bg, border: `1px solid ${QC.line}`, borderRadius: 9, padding: "8px 10px", color: QC.body, fontSize: 11.5, fontWeight: 600, cursor: "pointer", lineHeight: 1.45 }}>📝 {l.info.note}</button>
                          : <button onClick={() => { const n = window.prompt(lang === "es" ? "Nota del lead" : "Lead note", ""); if (n !== null && n.trim()) noteLead(l.id, n.slice(0, 300)); }}
                              className="w-full mt-2 active:opacity-80" style={{ background: "none", border: "none", color: QC.muted2, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: "4px 0 0" }}>📝 {lang === "es" ? "＋ Agregar nota" : "＋ Add note"}</button>}
                      </div>
                    );
                  })}
                </div>
              );
            });
          })()}
        </div>
      </div>
    );
  };

  /* ── Client CMA report (printable / shareable PDF view) ── */
  const Report = () => {
    const R = curatedView(lookup);
    if (!R || !R.value) return <NeedProperty title={lang === "es" ? "Informe del cliente" : "Client report"} sub={lang === "es" ? "Busca una propiedad para generar un informe con comparables y valor de mercado." : "Search a property to generate a report with comparables and a market value."} />;
    const subj = R.subject || {};
    const comps = (Array.isArray(R.comps) ? R.comps : []).filter((c) => !c.excludedAsOutlier && !excludedComps[c.address]).slice(0, 6);
    const n = R.compsUsed || comps.length;
    const hasRange = R.low != null && R.high != null;
    const narrative = lang === "es"
      ? `El conjunto de comparables respalda un valor de mercado cercano a ${fmt(R.value)}${hasRange ? `, dentro de un rango de ${fmt(R.low)}–${fmt(R.high)}` : ""}. El mayor respaldo proviene de ${n} ${n === 1 ? "venta cercana" : "ventas cercanas"} de tamaño y condición similares${R.avgPpsf ? `, con un promedio de ${fmt(R.avgPpsf)} por pie²` : ""}.${R.curated ? " Comparables seleccionadas personalmente por su agente." : ""}`
      : `The comparable set supports an indicated market value near ${fmt(R.value)}${hasRange ? `, within a ${fmt(R.low)}–${fmt(R.high)} range` : ""}. The strongest support comes from ${n} nearby ${n === 1 ? "sale" : "sales"} of similar size and condition${R.avgPpsf ? `, averaging ${fmt(R.avgPpsf)} per square foot` : ""}.${R.curated ? " Comparables hand-selected by your agent." : ""}`;
    // Seller net sheet math (realtor-side; shared only when included)
    const payoffN = Math.round(Number(String(netPayoff).replace(/[^0-9.]/g, "")) || 0);
    const commAmt = R.value * netCommPct / 100;
    const closeAmt = R.value * netClosePct / 100;
    const netAmt = R.value - commAmt - closeAmt - payoffN;
    const payEst = paymentFor(R.value);
    const shareL = shareLangPref || lang;
    // One link the client can open: all report data travels IN the link (/r?d=)
    const shareLink = async () => {
      const lg = await ensureLogoId();
      const digits = String(userPhone).replace(/\D/g, "");
      const rid = Array.from(crypto.getRandomValues(new Uint8Array(10))).map((b) => (b % 36).toString(36)).join("");
      const sLat2 = subj.latitude ?? R.lat, sLng2 = subj.longitude ?? R.lng;
      const payload = {
        l: shareL, a: subj.address || R.addr, v: R.value, lo: R.low, hi: R.high,
        ppsf: R.avgPpsf, n, cu: R.curated ? 1 : 0, rid,
        ...(sLat2 != null && sLng2 != null ? { ll: [sLat2, sLng2] } : {}),
        ...(Number.isFinite(R.marketDriftMo) && Math.abs(R.marketDriftMo * 1200) >= 1 ? { dr: R.marketDriftMo } : {}),
        s: { bd: subj.beds, ba: subj.baths, sf: subj.sqft, yr: subj.yearBuilt },
        c: comps.map((c) => [c.address, c.soldPrice]),
        g: { n: userName, b: bizName, p: digits, e: bizEmail, lic: license, bc: brand, ...(lg ? { lg } : {}) },
        ...(netInclude ? { ns: { cm: netCommPct, cl: netClosePct, po: payoffN, net: Math.round(netAmt) } } : {}),
        ...(payInclude ? { pay: { mo: payEst.monthly, dp: lendDownPct, rt: lendRate, yr: lendTerm, tp: payEst.typeLabel } } : {}),
      };
      setSentReports((prev) => [{ rid, addr: subj.address || R.addr, v: R.value, at: Date.now() }, ...prev.filter((x) => x.addr !== (subj.address || R.addr))].slice(0, 30));
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const url = `${location.origin}/r?d=${b64}`;
      const copied = () => showToast(lang === "es" ? "Link del informe copiado ✓" : "Report link copied ✓");
      try {
        if (navigator.share) await navigator.share({ title: "Quick Comp", url });
        else { await navigator.clipboard.writeText(url); copied(); }
      } catch { try { await navigator.clipboard.writeText(url); copied(); } catch { /* ignore */ } }
    };
    return (
      <div className="print-flow flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          {/* The report document — consulting-grade: serif display, hairline
              rules, numbered sections, a stat band, and a real comps table */}
          <div id="qc-report" className="overflow-hidden" style={{ background: "#fff", border: `1px solid ${QC.line}`, borderRadius: 18, boxShadow: "0 18px 38px rgba(17,27,66,0.12)" }}>
            {/* Cover — the house itself, address set over the photo */}
            <DocCover grad={brandGrad} tint={brandTint}
              ll={(subj.latitude ?? R.lat) != null ? { lat: subj.latitude ?? R.lat, lng: subj.longitude ?? R.lng } : null}
              kicker={lang === "es" ? "Análisis comparativo de mercado" : "Comparative Market Analysis"}
              title={subj.address || R.addr} />
            {/* Masthead */}
            <div className="flex items-center justify-between gap-3 px-5 py-3" style={{ background: brandGrad, borderTop: "1px solid rgba(255,255,255,0.14)", borderBottom: `2.5px solid ${brandTint}` }}>
              <div className="flex items-center gap-3 min-w-0">
                {logo && <img src={logo} alt="" className="shrink-0" style={{ height: 38, maxWidth: 96, objectFit: "contain", background: "#fff", borderRadius: 8, padding: 3 }} />}
                <div className="min-w-0">
                  <p style={{ color: brandTint, fontSize: 8, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Presentado por" : "Presented by"}</p>
                  <p className="text-white font-extrabold truncate" style={{ fontSize: 14 }}>{userName || (lang === "es" ? "Tu nombre" : "Your name")}</p>
                  {bizName && <p className="truncate" style={{ color: "rgba(255,255,255,0.7)", fontSize: 11 }}>{bizName}</p>}
                  {(userPhone || bizEmail) && <p className="truncate" style={{ color: "rgba(255,255,255,0.62)", fontSize: 10.5 }}>{[userPhone, bizEmail].filter(Boolean).join(" · ")}</p>}
                  {license && <p className="truncate" style={{ color: "rgba(255,255,255,0.5)", fontSize: 9.5 }}>{lang === "es" ? "Lic. " : "Lic. "}{license}</p>}
                </div>
              </div>
              <div className="text-right shrink-0">
                <p style={{ color: brandTint, fontSize: 7.5, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase" }}>{new Date().toLocaleDateString(lang === "es" ? "es-MX" : "en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
                <p style={{ color: "rgba(255,255,255,0.72)", fontSize: 7.5, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", marginTop: 2 }}>{lang === "es" ? "Privado y confidencial" : "Private & confidential"}</p>
              </div>
            </div>
            {/* Body */}
            <div className="px-5 py-5">
              {/* Stat band */}
              <div className="doc-band flex" style={{ borderBottom: `1px solid ${DOC.hair}`, paddingBottom: 12 }}>
                <DocStat first big label={t.cmpValue} value={fmt(R.value)} />
                {hasRange && <DocStat label={lang === "es" ? "Rango sugerido" : "Suggested range"} value={`${fmt(R.low)} – ${fmt(R.high)}`} />}
                {R.avgPpsf ? <DocStat label={lang === "es" ? "$/pie²" : "$/sq ft"} value={fmt(R.avgPpsf)} /> : null}
                <DocStat label={lang === "es" ? "Ventas" : "Comp sales"} value={String(n)} />
              </div>
              {/* 01 · Executive summary */}
              <DocSect accent={brand} n="01" title={lang === "es" ? "Resumen ejecutivo" : "Executive summary"}>
                <p style={{ color: DOC.body, fontSize: 12.5, lineHeight: 1.75, fontWeight: 500 }}>{narrative}</p>
              </DocSect>
              {/* 02 · Subject property */}
              <DocSect accent={brand} n="02" title={lang === "es" ? "La propiedad" : "Subject property"}>
                <div className="flex">
                  <DocStat first label={t.beds} value={String(subj.beds ?? "—")} />
                  <DocStat label={t.baths} value={String(subj.baths ?? "—")} />
                  <DocStat label={t.cmpSqft} value={subj.sqft ? Number(subj.sqft).toLocaleString("en-US") : "—"} />
                  <DocStat label={t.builtIn} value={String(subj.yearBuilt ?? "—")} />
                </div>
              </DocSect>
              {/* 03 · Market evidence */}
              <DocSect accent={brand} n="03" title={lang === "es" ? "Evidencia de mercado — ventas cerradas" : "Market evidence — closed sales"}>
                {comps.length === 0 && <p style={{ color: DOC.mut, fontSize: 12, fontWeight: 600 }}>{lang === "es" ? "Sin comparables disponibles." : "No comparables available."}</p>}
                {comps.length > 0 && (
                  <div>
                    <div className="flex gap-2 pb-1.5" style={{ borderBottom: `1px solid ${DOC.hair}` }}>
                      <span style={{ width: 16, color: DOC.mut, fontSize: 8, fontWeight: 800, letterSpacing: "0.1em" }}>#</span>
                      <span className="flex-1" style={{ color: DOC.mut, fontSize: 8, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase" }}>{lang === "es" ? "Dirección · vendida" : "Address · sold"}</span>
                      <span className="shrink-0" style={{ color: DOC.mut, fontSize: 8, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase" }}>{lang === "es" ? "Precio" : "Sold price"}</span>
                    </div>
                    {comps.map((c, i) => {
                      const dt = c.soldDate ? new Date(c.soldDate) : null;
                      const when = dt && !Number.isNaN(dt.getTime()) ? dt.toLocaleDateString(lang === "es" ? "es-MX" : "en-US", { month: "short", year: "numeric" }) : "";
                      return (
                        <div key={i} className="doc-row flex items-center gap-2 py-2" style={{ borderBottom: `1px solid ${DOC.hair}` }}>
                          <span style={{ width: 16, color: brand, fontSize: 10.5, fontWeight: 700, fontFamily: DOC.serif }}>{i + 1}</span>
                          <span className="flex-1 min-w-0">
                            <span className="block truncate" style={{ color: DOC.ink, fontSize: 12, fontWeight: 700 }}>{c.address}</span>
                            <span className="block" style={{ color: DOC.mut, fontSize: 9.5, fontWeight: 600 }}>{[when, c.sqft ? `${Number(c.sqft).toLocaleString("en-US")} ${t.cmpSqft}` : null, c.distance != null ? `${Number(c.distance).toFixed(2)} mi` : null].filter(Boolean).join(" · ")}</span>
                          </span>
                          <span className="shrink-0" style={{ color: DOC.ink, fontSize: 13.5, fontFamily: DOC.serif }}>{fmt(c.soldPrice)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </DocSect>
              {payInclude && (
                <DocSect accent={brand} n="04" title={lang === "es" ? "Pago mensual estimado" : "Financing snapshot"}>
                  <div className="flex justify-between items-baseline">
                    <span style={{ color: DOC.body, fontSize: 12, fontWeight: 600 }}>{payEst.typeLabel} · {lendDownPct}% {lang === "es" ? "enganche" : "down"} · {lendRate.toFixed(2)}% · {lendTerm} {lang === "es" ? "años" : "yr"}</span>
                    <span style={{ color: DOC.ink, fontSize: 16, fontFamily: DOC.serif }}>{fmt(payEst.monthly)}/{lang === "es" ? "mes" : "mo"}</span>
                  </div>
                  <p style={{ color: DOC.mut, fontSize: 9.5, fontWeight: 600, marginTop: 3 }}>{lang === "es" ? "Incluye impuestos, seguro y seguro hipotecario (est.)" : "Includes taxes, insurance & mortgage insurance (est.)"}</p>
                </DocSect>
              )}
              {netInclude && (
                <DocSect accent={brand} n={payInclude ? "05" : "04"} title={lang === "es" ? "Neto estimado del vendedor" : "Estimated seller proceeds"}>
                  {[[lang === "es" ? "Precio de venta" : "Sale price", fmt(R.value)],
                    [`${lang === "es" ? "Comisión" : "Commission"} (${netCommPct}%)`, `−${fmt(commAmt)}`],
                    [`${lang === "es" ? "Gastos de cierre" : "Closing costs"} (${netClosePct}%)`, `−${fmt(closeAmt)}`],
                    ...(payoffN ? [[lang === "es" ? "Saldo de hipoteca" : "Mortgage payoff", `−${fmt(payoffN)}`]] : [])].map(([k, x], i) => (
                    <div key={k} className="flex justify-between py-1.5" style={{ borderBottom: `1px solid ${DOC.hair}`, fontSize: 12, fontWeight: 600, color: DOC.body }}>
                      <span>{k}</span><span style={{ fontFamily: DOC.serif, color: DOC.ink }}>{x}</span>
                    </div>
                  ))}
                  <div className="flex justify-between pt-2" style={{ fontSize: 13, fontWeight: 800, color: DOC.ink }}>
                    <span style={{ letterSpacing: "0.1em", textTransform: "uppercase", fontSize: 10.5 }}>{lang === "es" ? "Neto estimado" : "Estimated net"}</span>
                    <span style={{ fontFamily: DOC.serif, fontSize: 16 }}>{fmt(netAmt)}</span>
                  </div>
                </DocSect>
              )}
              <p className="mt-4" style={{ color: DOC.mut, fontSize: 9, fontWeight: 500, lineHeight: 1.6, borderTop: `1px solid ${DOC.hair}`, paddingTop: 8 }}>¹ {t.cmpDisc}</p>
            </div>
            <DocFoot left={[bizName || userName, lang === "es" ? "Análisis comparativo de mercado" : "Comparative market analysis"].filter(Boolean).join(" · ")} right={lang === "es" ? "Confidencial" : "Confidential"} />
          </div>

          {/* Seller net sheet — the realtor's tool; shared only when included */}
          <div className="no-print rounded-2xl p-4 mt-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="font-extrabold" style={{ color: QC.navyDeep, fontSize: 14 }}>💰 {lang === "es" ? "Hoja neta del vendedor" : "Seller net sheet"}</p>
              <div className="flex gap-1">
                {[[true, lang === "es" ? "Incluir" : "Include"], [false, lang === "es" ? "No incluir" : "Don't include"]].map(([val, label]) => (
                  <button key={String(val)} onClick={() => setNetInclude(val)}
                    style={{ background: netInclude === val ? QC.navy : "#fff", color: netInclude === val ? "#fff" : QC.navy, border: `1.5px solid ${netInclude === val ? QC.navy : QC.line}`, borderRadius: 20, padding: "5px 11px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>{label}</button>
                ))}
              </div>
            </div>
            <p className="mb-3" style={{ color: QC.muted2, fontSize: 11, fontWeight: 600 }}>{lang === "es" ? "Lo que el vendedor se lleva. Solo aparece en el informe si eliges Incluir." : "What the seller walks away with. Only appears in the report if you choose Include."}</p>
            <Slider label={lang === "es" ? "Comisión" : "Commission"} value={netCommPct} display={`${netCommPct}% · ${fmt(commAmt)}`} min={3} max={8} step={0.25} onChange={setNetCommPct} />
            <Slider label={lang === "es" ? "Gastos de cierre" : "Closing costs"} value={netClosePct} display={`${netClosePct}% · ${fmt(closeAmt)}`} min={0} max={5} step={0.25} onChange={setNetClosePct} />
            <p className="mb-1" style={{ color: QC.muted2, fontSize: 11, fontWeight: 700 }}>{lang === "es" ? "Saldo de hipoteca del vendedor" : "Seller's mortgage payoff"}</p>
            <input value={netPayoff} onChange={(e) => setNetPayoff(e.target.value)} placeholder="$0" inputMode="numeric"
              className="w-full rounded-xl px-3.5 py-3 mb-3 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
            <div className="flex justify-between rounded-xl px-3.5 py-3" style={{ background: "#FDF9EF", border: `2px solid ${QC.goldLine}` }}>
              <span className="font-extrabold" style={{ color: QC.navy, fontSize: 13 }}>{lang === "es" ? "NETO ESTIMADO" : "ESTIMATED NET"}</span>
              <span className="font-extrabold" style={{ color: QC.navyDeep, fontSize: 16 }}>{fmt(netAmt)}</span>
            </div>
          </div>

          {/* Buyer payment estimate — include toggle (uses Lending settings) */}
          <div className="no-print rounded-2xl p-4 mt-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-extrabold" style={{ color: QC.navyDeep, fontSize: 14 }}>💳 {lang === "es" ? "Pago del comprador" : "Buyer payment"}</p>
                <p style={{ color: QC.muted2, fontSize: 11, fontWeight: 600 }}>{fmt(payEst.monthly)}/{lang === "es" ? "mes" : "mo"} · {payEst.typeLabel} {lendDownPct}% — {lang === "es" ? "según tu pestaña Crédito" : "from your Lending tab"}</p>
              </div>
              <div className="flex gap-1 shrink-0">
                {[[true, lang === "es" ? "Incluir" : "Include"], [false, lang === "es" ? "No" : "Don't"]].map(([val, label]) => (
                  <button key={String(val)} onClick={() => setPayInclude(val)}
                    style={{ background: payInclude === val ? QC.navy : "#fff", color: payInclude === val ? "#fff" : QC.navy, border: `1.5px solid ${payInclude === val ? QC.navy : QC.line}`, borderRadius: 20, padding: "5px 11px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>{label}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Client link language */}
          <div className="no-print flex items-center gap-1.5 mt-3 flex-wrap">
            <span style={{ color: QC.muted2, fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", marginRight: 2 }}>{lang === "es" ? "Idioma del link" : "Link language"}</span>
            {[["en", "English"], ["es", "Español"]].map(([code, label]) => {
              const on = shareL === code;
              return (
                <button key={code} onClick={() => setShareLangPref(code)}
                  style={{ background: on ? QC.navy : "#fff", color: on ? "#fff" : QC.navy, border: `1.5px solid ${on ? QC.navy : QC.line}`, borderRadius: 20, padding: "5px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>{label}</button>
              );
            })}
          </div>

          {/* Actions (not printed) */}
          <div className="no-print flex gap-2 mt-3">
            <button onClick={shareLink} className="flex-1 active:translate-y-px transition-transform"
              style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 700 }}>🔗 {lang === "es" ? "Compartir informe" : "Share report"}</button>
            <button onClick={() => window.print()} className="flex-1 active:translate-y-px transition-transform"
              style={{ background: "#fff", color: QC.navy, border: `1.5px solid ${QC.line}`, borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 700 }}>🖨️ {lang === "es" ? "Imprimir / PDF" : "Print / PDF"}</button>
          </div>
          <p className="no-print text-center mt-3" style={{ color: "#66759D", fontSize: 12, fontWeight: 600 }}>{lang === "es" ? "El link se abre sin app — mándalo por WhatsApp. El cliente puede guardarlo como PDF." : "The link opens without any app — send it by WhatsApp. Your client can save it as a PDF."}</p>
        </div>
      </div>
    );
  };

  /* ── First-login onboarding: language, identity, logo, market — everything
   * the reports and the app need, asked once. ── */
  const Welcome = () => {
    const finish = () => {
      saveProfile({ name: userName, biz: bizName, lang, market });
      try { localStorage.setItem("qc_welcomed", "1"); } catch { /* private mode */ }
      setScreen("comps");
    };
    const tabs = [
      ["01", lang === "es" ? "Comps" : "Comps", lang === "es" ? "Valor + ventas comparables" : "Value + sold comparables"],
      ["02", lang === "es" ? "Crédito" : "Lending", lang === "es" ? "Pago mensual estimado" : "Monthly payment estimate"],
      ["03", lang === "es" ? "Impuestos" : "Tax", lang === "es" ? "Resumen fiscal de la propiedad" : "Property tax snapshot"],
      ["04", lang === "es" ? "Trabajo" : "Workspace", lang === "es" ? "Guarda y reabre tu trabajo" : "Save & reopen your work"],
    ];
    return (
      <div className="flex-1 overflow-y-auto" style={{ background: QC.bg }}>
        <div className="px-6 pt-8 pb-6 text-center" style={{ background: QC.headGrad }}>
          <img src="/quick-comp-lockup-white.png" alt="Quick Comp" style={{ height: 64, objectFit: "contain", margin: "0 auto 14px" }} />
          <p className="text-white font-extrabold" style={{ fontSize: 22, lineHeight: 1.2 }}>{lang === "es" ? "Bienvenido a Quick Comp" : "Welcome to Quick Comp"}</p>
          <p style={{ color: "rgba(255,255,255,0.78)", fontSize: 13, fontWeight: 600, marginTop: 6 }}>{lang === "es" ? "Valúa cualquier propiedad en minutos." : "Value any property in minutes."}</p>
        </div>
        <div className="px-5 pt-5">
          <div className="rounded-2xl p-4 mb-4" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 4 }}>{lang === "es" ? "Idioma" : "Language"}</p>
            <p className="font-bold mb-3" style={{ color: QC.navyDeep, fontSize: 14 }}>{lang === "es" ? "La app y tus informes hablan el idioma que elijas." : "The app and your reports speak the language you pick."}</p>
            <div className="flex gap-2">
              {[["en", "English"], ["es", "Español"]].map(([code, label]) => {
                const on = lang === code;
                return (
                  <button key={code} onClick={() => { setLang(code); saveProfile({ lang: code }); }} className="flex-1 active:translate-y-px transition-transform"
                    style={{ background: on ? QC.navy : "#fff", color: on ? "#fff" : QC.navy, border: `1.5px solid ${on ? QC.navy : QC.line}`, borderRadius: 12, padding: "13px 0", fontSize: 15, fontWeight: 800, cursor: "pointer" }}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="rounded-2xl p-4 mb-4" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 4 }}>{lang === "es" ? "Tu perfil" : "Your profile"}</p>
            <p className="font-bold mb-3" style={{ color: QC.navyDeep, fontSize: 14 }}>{lang === "es" ? "Aparece como “Presentado por” en tus informes." : "Shown as “Presented by” on your client reports."}</p>
            <input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder={lang === "es" ? "Tu nombre" : "Your name"}
              className="w-full rounded-xl px-3.5 py-3 mb-2 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
            <input value={bizName} onChange={(e) => setBizName(e.target.value)} placeholder={lang === "es" ? "Inmobiliaria / Brokerage" : "Brokerage"}
              className="w-full rounded-xl px-3.5 py-3 mb-2 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
            <input value={market} onChange={(e) => { setMarket(e.target.value); }} placeholder={lang === "es" ? "Tu mercado (ej. McAllen, TX)" : "Your market (e.g. McAllen, TX)"}
              className="w-full rounded-xl px-3.5 py-3 mb-3 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
            <p style={{ color: QC.muted2, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>{lang === "es" ? "Logo o foto (opcional — sale en tus informes)" : "Logo or headshot (optional — shows on your reports)"}</p>
            {logo
              ? (<div className="flex items-center gap-3">
                  <img src={logo} alt="" style={{ height: 44, maxWidth: 120, objectFit: "contain", borderRadius: 8, background: "#fff", border: `1px solid ${QC.line}`, padding: 4 }} />
                  <button onClick={() => { setLogo(null); logoIdRef.current = null; saveProfile({ logo: null }); }}
                    style={{ background: "#fff", color: QC.navy, border: `1.5px solid ${QC.line}`, borderRadius: 10, padding: "8px 14px", fontWeight: 700, fontSize: 13 }}>{lang === "es" ? "Quitar" : "Remove"}</button>
                </div>)
              : (<label className="block rounded-xl px-3.5 py-3 text-center cursor-pointer font-semibold" style={{ background: QC.bg, border: `1.5px dashed ${QC.line}`, color: QC.muted2, fontSize: 13 }}>
                  {lang === "es" ? "＋ Subir imagen" : "＋ Upload image"}
                  <input type="file" accept="image/*" onChange={(e) => onLogoFile(e.target.files?.[0])} style={{ display: "none" }} />
                </label>)}
          </div>
          <div className="rounded-2xl p-4 mb-4" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <p style={{ color: QC.muted2, fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 10 }}>{lang === "es" ? "Tus 4 herramientas" : "Your 4 tools"}</p>
            {tabs.map(([n, name, desc]) => (
              <div key={n} className="flex items-center gap-3 py-2" style={{ borderTop: n !== "01" ? `1px solid ${QC.line}` : "none" }}>
                <span className="flex items-center justify-center shrink-0 font-extrabold" style={{ width: 34, height: 34, borderRadius: 10, background: QC.bg, color: QC.navy, fontSize: 12 }}>{n}</span>
                <span className="min-w-0"><span className="block font-bold" style={{ color: QC.navyDeep, fontSize: 14 }}>{name}</span><span className="block" style={{ color: QC.muted2, fontSize: 11, fontWeight: 600 }}>{desc}</span></span>
              </div>
            ))}
          </div>
          <button onClick={finish} className="w-full active:translate-y-px transition-transform mb-6"
            style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 12, padding: 16, fontSize: 16, fontWeight: 800, boxShadow: "0 4px 14px rgba(27,42,92,0.3)" }}>
            {lang === "es" ? "Empezar →" : "Get started →"}
          </button>
        </div>
      </div>
    );
  };

  /* ── AI listing writer — facts in, MLS description + social caption out ── */
  const ListingWriter = () => {
    const es = lang === "es";
    const d = listingDraft;
    const set = (k) => (e) => setListingDraft((f) => ({ ...f, [k]: e.target.value }));
    const inputStyle = { background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 };
    return (
      <div className="flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          <div className="rounded-2xl p-5 mb-3" style={{ background: QC.cardGrad, boxShadow: "0 18px 38px rgba(17,27,66,0.18)" }}>
            <p style={{ color: QC.goldHi, fontSize: 11, fontWeight: 900, letterSpacing: "0.16em", textTransform: "uppercase" }}>{es ? "Redactor de listing" : "Listing writer"}</p>
            <p className="text-white font-extrabold" style={{ fontSize: 20, margin: "4px 0 6px" }}>{es ? "De datos a listing en segundos" : "From facts to a listing in seconds"}</p>
            <p style={{ color: "rgba(255,255,255,0.76)", fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>{es ? "Los datos se llenan solos desde tu búsqueda — o escríbelos de donde sea. Agrega lo que solo tú sabes." : "Facts prefill from your search — or type them in from anywhere. Add the things only you know."}</p>
          </div>

          <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 10 }}>{es ? "Datos de la propiedad" : "Property facts"}</p>
            <input value={d.address} onChange={set("address")} placeholder={es ? "Dirección" : "Address"}
              className="w-full rounded-xl px-3.5 py-3 mb-2 font-semibold outline-none" style={inputStyle} />
            <div className="flex gap-2 mb-2">
              <input value={d.beds} onChange={set("beds")} placeholder={t.beds} inputMode="numeric"
                className="flex-1 rounded-xl px-3.5 py-3 font-semibold outline-none" style={{ ...inputStyle, minWidth: 0 }} />
              <input value={d.baths} onChange={set("baths")} placeholder={t.baths} inputMode="decimal"
                className="flex-1 rounded-xl px-3.5 py-3 font-semibold outline-none" style={{ ...inputStyle, minWidth: 0 }} />
            </div>
            <div className="flex gap-2 mb-3">
              <input value={d.sqft} onChange={set("sqft")} placeholder="Sq ft" inputMode="numeric"
                className="flex-1 rounded-xl px-3.5 py-3 font-semibold outline-none" style={{ ...inputStyle, minWidth: 0 }} />
              <input value={d.year} onChange={set("year")} placeholder={es ? "Año de construcción" : "Year built"} inputMode="numeric"
                className="flex-1 rounded-xl px-3.5 py-3 font-semibold outline-none" style={{ ...inputStyle, minWidth: 0 }} />
            </div>
            <p style={{ color: QC.muted2, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>{es ? "Lo que la hace especial (opcional — tú la conoces mejor)" : "What makes it special (optional — you know it best)"}</p>
            <div className="flex items-start gap-2 rounded-xl px-3 py-1 mb-3" style={{ background: QC.bg, border: `1.5px solid ${QC.line}` }}>
              <textarea rows={3} value={d.highlights} onChange={set("highlights")}
                placeholder={es ? "Ej. cocina remodelada 2023, alberca, sin vecinos atrás…" : "e.g. remodeled kitchen 2023, pool, no back neighbors…"}
                className="flex-1 py-2 font-semibold outline-none bg-transparent resize-none" style={{ color: QC.navy, fontSize: 13, lineHeight: 1.5 }} />
              {hasVoice && (
                <button onClick={() => startVoice((txt) => setListingDraft((f) => ({ ...f, highlights: (f.highlights ? f.highlights.trim() + " " : "") + txt })))}
                  className="text-xl mt-2 active:scale-90 transition-transform" style={{ background: "none", border: "none", opacity: listening ? 1 : 0.6 }}>{listening ? "🔴" : "🎤"}</button>
              )}
            </div>
            <button onClick={generateListing} disabled={listingBusy} className="w-full active:translate-y-px transition-transform"
              style={{ background: listingBusy ? QC.line : `linear-gradient(135deg,${QC.gold},#BD8426)`, color: QC.navyDeep, border: "none", borderRadius: 12, padding: 15, fontSize: 16, fontWeight: 800, boxShadow: listingBusy ? "none" : "0 4px 14px rgba(189,132,38,0.35)" }}>
              {listingBusy ? (es ? "Escribiendo…" : "Writing…") : "✨ " + (es ? "Escribir el listing" : "Write the listing")}
            </button>
          </div>

          {listingOut && (
            <>
              <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `2px solid ${QC.goldLine}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="font-extrabold" style={{ color: QC.navyDeep, fontSize: 14 }}>📝 {es ? "Descripción MLS" : "MLS description"}</p>
                  <button onClick={() => copyText(listingOut.mls)}
                    style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 20, padding: "6px 14px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>{es ? "Copiar" : "Copy"}</button>
                </div>
                <p style={{ color: QC.body, fontSize: 13.5, lineHeight: 1.65, fontWeight: 500, whiteSpace: "pre-wrap" }}>{listingOut.mls}</p>
              </div>
              {listingOut.social && (
                <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="font-extrabold" style={{ color: QC.navyDeep, fontSize: 14 }}>📲 {es ? "Post para redes" : "Social caption"}</p>
                    <button onClick={() => copyText(listingOut.social)}
                      style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 20, padding: "6px 14px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>{es ? "Copiar" : "Copy"}</button>
                  </div>
                  <p style={{ color: QC.body, fontSize: 13.5, lineHeight: 1.65, fontWeight: 500, whiteSpace: "pre-wrap" }}>{listingOut.social}</p>
                </div>
              )}
              <p style={{ color: "#66759D", fontSize: 11, fontWeight: 600, lineHeight: 1.5 }}>⚠️ {es ? "Revisa antes de publicar — tú eres responsable del texto final. Escrito con reglas de Vivienda Justa (solo describe la propiedad, nunca al comprador)." : "Review before you publish — you own the final text. Written under Fair Housing rules (describes the property, never the buyer)."}</p>
            </>
          )}
        </div>
      </div>
    );
  };

  /* ── Appraisal defense packet — the curated comp set, formatted for the
   * appraiser. Same data as the CMA report wearing a professional cover:
   * subject, contract price, adjusted comps, honest range. Print → PDF. ── */
  const AppraisalPacket = () => {
    const es = lang === "es";
    const R = curatedView(lookup);
    const pickList = savedWork.slice(0, 6);

    // No property loaded yet → pick from recent searches
    if (!R || !R.value) {
      return (
        <div className="flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
          <div className="px-5 pt-4">
            <div className="rounded-2xl p-5 mb-3" style={{ background: QC.cardGrad, boxShadow: "0 18px 38px rgba(17,27,66,0.18)" }}>
              <p style={{ color: QC.goldHi, fontSize: 11, fontWeight: 900, letterSpacing: "0.16em", textTransform: "uppercase" }}>{es ? "Paquete para avalúo" : "Appraisal packet"}</p>
              <p className="text-white font-extrabold" style={{ fontSize: 20, margin: "4px 0 6px" }}>{es ? "¿Avalúo bajo? Defiéndelo con datos" : "Low appraisal? Defend it with data"}</p>
              <p style={{ color: "rgba(255,255,255,0.76)", fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>{es ? "Elige una propiedad y arma un PDF con tus comparables ajustados para el valuador." : "Pick a property and build a clean packet of your adjusted comps for the appraiser."}</p>
            </div>
            {pickList.length ? (
              <div className="rounded-2xl px-4 py-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
                <p className="mb-0.5" style={{ color: QC.muted2, fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase" }}>{es ? "Elige la propiedad" : "Pick the property"}</p>
                {pickList.map((it, i) => (
                  <button key={it.addr + i} onClick={() => loadSaved(it)} className="w-full flex items-center gap-2.5 py-2.5 text-left active:opacity-80"
                    style={{ background: "none", border: "none", borderTop: i ? `1px solid ${QC.line}` : "none", cursor: "pointer" }}>
                    <span style={{ color: QC.navy }}>🏠</span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-bold truncate" style={{ color: QC.navyDeep, fontSize: 13 }}>{it.addr}</span>
                      {it.value != null && <span className="block" style={{ color: QC.muted2, fontSize: 10.5, fontWeight: 600 }}>{fmt(it.value)}</span>}
                    </span>
                    <span style={{ color: QC.gold, fontSize: 16 }}>›</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl text-center" style={{ background: "#fff", border: "1px dashed #CAD5E7", padding: "26px 22px" }}>
                <p style={{ color: "#66759D", fontSize: 13, fontWeight: 600 }}>{es ? "Primero corre los comps de la propiedad en la pestaña Comps." : "Run the property's comps on the Comps tab first."}</p>
              </div>
            )}
          </div>
        </div>
      );
    }

    const subj = R.subject || {};
    const addr = subj.address || R.addr;
    const comps = (Array.isArray(R.comps) ? R.comps : []).filter((c) => !c.excludedAsOutlier && !excludedComps[c.address]).slice(0, 6);
    const n = comps.length;
    const hasRange = R.low != null && R.high != null;
    const num = (x) => Number(x).toLocaleString("en-US");
    const soldDate = (dd) => { if (!dd) return "—"; const dt = new Date(dd); return Number.isNaN(dt.getTime()) ? "—" : dt.toLocaleDateString(es ? "es-MX" : "en-US", { month: "short", day: "numeric", year: "numeric" }); };
    const contractN = Math.round(Number(String(apprPrice).replace(/[^0-9.]/g, "")) || 0);
    // Honest positioning of the contract price against the indicated range
    const rel = contractN && hasRange ? (contractN >= R.low && contractN <= R.high ? "in" : contractN < R.low ? "below" : "above") : null;
    const relTxt = rel === "in" ? (es ? `consistente con el precio de contrato de ${fmt(contractN)}` : `consistent with the contract price of ${fmt(contractN)}`)
      : rel === "below" ? (es ? `por encima del precio de contrato de ${fmt(contractN)}` : `above the contract price of ${fmt(contractN)}`)
        : rel === "above" ? (es ? `por debajo del precio de contrato de ${fmt(contractN)}` : `below the contract price of ${fmt(contractN)}`) : "";
    const narrative = es
      ? `Preparado en apoyo a la operación pendiente en ${addr}. Las ${n} ventas cerradas siguientes se seleccionaron por cercanía, similitud y fecha reciente${R.curated ? ", revisadas una a una por el agente" : ""}. Ajustadas por fecha de venta y diferencias de superficie, indican un valor de mercado cercano a ${fmt(R.value)}${hasRange ? ` (rango ${fmt(R.low)}–${fmt(R.high)})` : ""}${relTxt ? `, ${relTxt}` : ""}.`
      : `Prepared in support of the pending transaction at ${addr}. The ${n} closed sales below were selected for proximity, similarity, and recency${R.curated ? ", each reviewed by the agent" : ""}. Adjusted for sale date and living-area differences, they indicate a market value near ${fmt(R.value)}${hasRange ? ` (${fmt(R.low)}–${fmt(R.high)} range)` : ""}${relTxt ? `, ${relTxt}` : ""}.`;
    const hasDrift = Number.isFinite(R.marketDriftMo) && Math.abs(R.marketDriftMo * 1200) >= 1;
    const inputStyle = { background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 };
    return (
      <div className="print-flow flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          {/* Controls — never printed */}
          <div className="no-print rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            {pickList.length > 1 && (
              <>
                <p style={{ color: QC.muted2, fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>{es ? "Propiedad" : "Property"}</p>
                <div className="flex gap-1.5 mb-3 flex-wrap">
                  {pickList.map((it, i) => {
                    const on = it.addr === addr;
                    return (
                      <button key={it.addr + i} onClick={() => loadSaved(it)}
                        style={{ background: on ? QC.navy : "#fff", color: on ? "#fff" : QC.navy, border: `1.5px solid ${on ? QC.navy : QC.line}`, borderRadius: 20, padding: "5px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer", maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {String(it.addr).split(",")[0]}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <p style={{ color: QC.muted2, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>{es ? "Precio de contrato que estás defendiendo" : "Contract price you're defending"}</p>
            <input value={apprPrice} onChange={(e) => setApprPrice(e.target.value)} placeholder="$0" inputMode="numeric"
              className="w-full rounded-xl px-3.5 py-3 mb-3 font-semibold outline-none" style={inputStyle} />
            <p style={{ color: QC.muted2, fontSize: 11, fontWeight: 700, marginBottom: 6 }}>{es ? "Notas para el valuador (opcional)" : "Notes for the appraiser (optional)"}</p>
            <textarea rows={2} value={apprNote} onChange={(e) => setApprNote(e.target.value)}
              placeholder={es ? "Ej. techo nuevo 2024, cocina remodelada…" : "e.g. new roof 2024, remodeled kitchen…"}
              className="w-full rounded-xl px-3.5 py-3 font-semibold outline-none resize-none" style={{ ...inputStyle, fontSize: 13, lineHeight: 1.5 }} />
          </div>

          {/* The packet document (this part prints) — same consulting-grade
              language as the CMA report: serif display, hairlines, sections */}
          <div id="qc-report" className="overflow-hidden" style={{ background: "#fff", border: `1px solid ${QC.line}`, borderRadius: 18, boxShadow: "0 18px 38px rgba(17,27,66,0.12)" }}>
            {/* Cover — the subject property, address set over the photo */}
            <DocCover grad={brandGrad} tint={brandTint}
              ll={(subj.latitude ?? R.lat) != null ? { lat: subj.latitude ?? R.lat, lng: subj.longitude ?? R.lng } : null}
              kicker={es ? "Apoyo de ventas comparables" : "Comparable Sales Support"}
              title={addr} />
            <div className="flex items-center justify-between gap-3 px-5 py-3" style={{ background: brandGrad, borderTop: "1px solid rgba(255,255,255,0.14)", borderBottom: `2.5px solid ${brandTint}` }}>
              <div className="flex items-center gap-3 min-w-0">
                {logo && <img src={logo} alt="" className="shrink-0" style={{ height: 38, maxWidth: 96, objectFit: "contain", background: "#fff", borderRadius: 8, padding: 3 }} />}
                <div className="min-w-0">
                  <p style={{ color: brandTint, fontSize: 8, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase" }}>{es ? "Preparado por" : "Prepared by"}</p>
                  <p className="text-white font-extrabold truncate" style={{ fontSize: 14 }}>{userName || (es ? "Tu nombre" : "Your name")}</p>
                  {bizName && <p className="truncate" style={{ color: "rgba(255,255,255,0.7)", fontSize: 11 }}>{bizName}</p>}
                  {(userPhone || bizEmail) && <p className="truncate" style={{ color: "rgba(255,255,255,0.62)", fontSize: 10.5 }}>{[userPhone, bizEmail].filter(Boolean).join(" · ")}</p>}
                  {license && <p className="truncate" style={{ color: "rgba(255,255,255,0.5)", fontSize: 9.5 }}>{es ? "Lic. " : "Lic. "}{license}</p>}
                </div>
              </div>
              <div className="text-right shrink-0">
                <p style={{ color: brandTint, fontSize: 7.5, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase" }}>{new Date().toLocaleDateString(es ? "es-MX" : "en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
                <p style={{ color: "rgba(255,255,255,0.72)", fontSize: 7.5, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", marginTop: 2 }}>{es ? "Para el valuador asignado" : "For the assigned appraiser"}</p>
              </div>
            </div>
            <div className="px-5 py-5">
              {/* Stat band */}
              <div className="doc-band flex" style={{ borderBottom: `1px solid ${DOC.hair}`, paddingBottom: 12 }}>
                {contractN > 0 && <DocStat first big label={es ? "Precio de contrato" : "Contract price"} value={fmt(contractN)} />}
                <DocStat first={!contractN} big={!contractN} label={es ? "Valor indicado" : "Indicated value"} value={fmt(R.value)} />
                {hasRange && <DocStat label={es ? "Rango" : "Range"} value={`${fmt(R.low)} – ${fmt(R.high)}`} />}
                <DocStat label={es ? "Ventas" : "Closed sales"} value={String(n)} />
              </div>
              {/* 01 · Purpose & summary */}
              <DocSect accent={brand} n="01" title={es ? "Propósito y resumen" : "Purpose & summary"}>
                <p style={{ color: DOC.body, fontSize: 12.5, lineHeight: 1.75, fontWeight: 500 }}>{narrative}</p>
                {hasDrift && (
                  <p className="mt-2" style={{ color: DOC.mut, fontSize: 10.5, fontWeight: 600, lineHeight: 1.6 }}>
                    {es ? "Tendencia del mercado derivada del conjunto de comparables" : "Market trend derived from the comp set"}: {R.marketDriftMo > 0 ? "↑" : "↓"} ~{Math.abs(R.marketDriftMo * 1200).toFixed(1)}%/{es ? "año" : "yr"} — {es ? "base de los ajustes por fecha de venta" : "the basis for the sale-date adjustments"}.
                  </p>
                )}
              </DocSect>
              {/* 02 · Subject property */}
              <DocSect accent={brand} n="02" title={es ? "La propiedad" : "Subject property"}>
                <div className="flex">
                  <DocStat first label={t.beds} value={String(subj.beds ?? "—")} />
                  <DocStat label={t.baths} value={String(subj.baths ?? "—")} />
                  <DocStat label={t.cmpSqft} value={subj.sqft ? num(subj.sqft) : "—"} />
                  <DocStat label={t.builtIn} value={String(subj.yearBuilt ?? "—")} />
                </div>
              </DocSect>
              {/* 03 · Closed comparable sales */}
              <DocSect accent={brand} n="03" title={es ? "Ventas cerradas comparables" : "Closed comparable sales"}>
                <div className="flex gap-2 pb-1.5" style={{ borderBottom: `1px solid ${DOC.hair}` }}>
                  <span style={{ width: 16, color: DOC.mut, fontSize: 8, fontWeight: 800 }}>#</span>
                  <span className="flex-1" style={{ color: DOC.mut, fontSize: 8, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase" }}>{es ? "Dirección · detalles" : "Address · details"}</span>
                  <span className="shrink-0" style={{ color: DOC.mut, fontSize: 8, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase" }}>{es ? "Precio · ajustado" : "Sold · adjusted"}</span>
                </div>
                {comps.map((c, i) => {
                  const ppsf = c.ppsf || (c.soldPrice && c.sqft ? Math.round(c.soldPrice / c.sqft) : null);
                  return (
                    <div key={i} className="doc-row flex items-center gap-2 py-2" style={{ borderBottom: `1px solid ${DOC.hair}` }}>
                      <span style={{ width: 16, color: brand, fontSize: 10.5, fontWeight: 700, fontFamily: DOC.serif }}>{i + 1}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate" style={{ color: DOC.ink, fontSize: 12, fontWeight: 700 }}>{c.address}</span>
                        <span className="block" style={{ color: DOC.mut, fontSize: 9.5, fontWeight: 600 }}>{[`${t.cmpSold} ${soldDate(c.soldDate)}`, c.distance != null ? `${Number(c.distance).toFixed(2)} mi` : null, c.sqft ? `${num(c.sqft)} ${t.cmpSqft}` : null, ppsf ? `${fmt(ppsf)}${t.cmpPerSqft}` : null].filter(Boolean).join(" · ")}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block" style={{ color: DOC.ink, fontSize: 13.5, fontFamily: DOC.serif }}>{fmt(c.soldPrice)}</span>
                        {c.adjValue ? <span className="block" style={{ color: DOC.mut, fontSize: 9.5, fontWeight: 600 }}>{es ? "aj." : "adj."} {fmt(c.adjValue)}</span> : null}
                      </span>
                    </div>
                  );
                })}
              </DocSect>
              {/* 04 · Agent notes */}
              {apprNote.trim() && (
                <DocSect accent={brand} n="04" title={es ? "Notas del agente" : "Agent notes"}>
                  <p style={{ color: DOC.body, fontSize: 12, lineHeight: 1.7, fontWeight: 500, whiteSpace: "pre-wrap" }}>{apprNote.trim()}</p>
                </DocSect>
              )}
              <p className="mt-4" style={{ color: DOC.mut, fontSize: 9, fontWeight: 500, lineHeight: 1.6, borderTop: `1px solid ${DOC.hair}`, paddingTop: 8 }}>¹ {es ? "Datos de mercado presentados para su consideración — no es un avalúo. La conclusión de valor pertenece al valuador." : "Market data provided for consideration — not an appraisal. The value conclusion remains the appraiser's."}</p>
            </div>
            <DocFoot left={[bizName || userName, es ? "Apoyo de comparables" : "Comparable sales support"].filter(Boolean).join(" · ")} right={es ? "Confidencial" : "Confidential"} />
          </div>

          <button onClick={() => window.print()} className="no-print w-full active:translate-y-px transition-transform mt-3"
            style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 12, padding: 15, fontSize: 16, fontWeight: 700, boxShadow: "0 4px 14px rgba(27,42,92,0.3)" }}>
            🖨️ {es ? "Imprimir / Guardar PDF" : "Print / Save PDF"}
          </button>
          <p className="no-print text-center mt-3" style={{ color: "#66759D", fontSize: 12, fontWeight: 600 }}>{es ? "Guárdalo como PDF y mándalo al valuador o al prestamista. Quita o corrige comparables en la pestaña Comps — el paquete usa tu selección." : "Save it as a PDF and email it to the appraiser or the lender. Remove or correct comps on the Comps tab — the packet uses your selection."}</p>
        </div>
      </div>
    );
  };

  /* ── Router ── */
  const titles = {
    report: "📄 " + (lang === "es" ? "Informe del cliente" : "Client report"),
    listing: "✨ " + (lang === "es" ? "Redactor de listing" : "Listing writer"),
    appraisal: "🛡️ " + (lang === "es" ? "Paquete para avalúo" : "Appraisal packet"),
    leads: "📥 Leads",
  };
  const backMap = {
    report: "comps",
    listing: "comps",
    appraisal: "workspace",
    leads: "comps",
  };
  const tabScreens = ["comps", "lending", "tax", "workspace"];
  const withNav = tabScreens;

  return (
    <div className="app-outer min-h-screen flex justify-center" style={{ background: C.navyDeep }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,800&family=Inter:wght@400;500;600;700;800&display=swap');
        * { font-family: 'Inter', sans-serif; -webkit-tap-highlight-color: transparent; }
        input::placeholder { color: #A7AEBE; }
        @keyframes ttpPulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.18); opacity: .65; } }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
        @page { margin: 0.45in; }
        @media print {
          body { background: #fff !important; }
          .no-print { display: none !important; }
          /* The phone-shaped shell must become a plain, full-width page flow:
             without this the document prints as a 448px strip clipped to one
             screen — the "PDF looks terrible" bug. */
          .app-outer { background: #fff !important; display: block !important; }
          .app-shell { height: auto !important; overflow: visible !important; max-width: none !important; }
          .print-flow { overflow: visible !important; height: auto !important; background: #fff !important; }
          .print-flow > div { padding: 0 !important; }
          /* Force backgrounds to print: without this Chrome/Safari drop the navy
             header band and gold labels, so "Presented by / agent / brokerage /
             license" prints as white-on-white — the report comes out anonymous. */
          #qc-report, #qc-report * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          #qc-report { box-shadow: none !important; border: none !important; border-radius: 0 !important; }
          /* Paper typography: paginate cleanly — never split a comp row or a
             stat band, never leave a section header orphaned at a page break. */
          #qc-report .doc-band, #qc-report .doc-row { break-inside: avoid; }
          #qc-report .doc-h { break-after: avoid; }
          #qc-report .doc-cover { padding-top: 170px !important; }
        }`}</style>
      <div className="app-shell w-full max-w-md flex flex-col relative" style={{ background: C.bg, height: "100dvh", overflow: "hidden" }}>
        {!session && (
          <div className="no-print px-4 py-2 text-center shrink-0" style={{ background: C.orangeSoft, borderBottom: `1.5px solid ${C.orange}` }}>
            <span className="text-xs font-bold" style={{ color: "#7A5A00" }}>{t.demoBanner}</span>
          </div>
        )}
        {/* Pinned top */}
        {tabScreens.includes(screen) && <div className="shrink-0"><BrandHeader /></div>}
        {screen !== "welcome" && !tabScreens.includes(screen) && (
          <div className="no-print shrink-0"><Header title={titles[screen] || ""} back={() => setScreen(backMap[screen] || "comps")} /></div>
        )}
        {/* Scrolling content — only this area moves; the tabs below stay put */}
        <div className="flex-1 min-h-0 flex flex-col">
          {screen === "welcome" && Welcome()}
          {screen === "comps" && (lookup ? CompsResult() : CompsSearch())}
          {screen === "lending" && Lending()}
          {screen === "tax" && Tax()}
          {screen === "workspace" && Workspace()}
          {screen === "leads" && Leads()}
          {screen === "report" && Report()}
          {screen === "listing" && ListingWriter()}
          {screen === "appraisal" && AppraisalPacket()}
        </div>
        {/* Pinned bottom tabs */}
        {withNav.includes(screen) && <div className="shrink-0"><BottomNav /></div>}
        {toast && (
          <div className="no-print absolute left-0 right-0 flex justify-center" style={{ bottom: 80, pointerEvents: "none" }}>
            <span className="rounded-full px-5 py-2.5 font-bold text-sm text-white" style={{ background: C.navyDeep, boxShadow: "0 8px 20px rgba(0,0,0,.3)" }}>{toast}</span>
          </div>
        )}
        {/* Full-screen property photo — tap anywhere to close */}
        {photoView && (
          <div className="no-print absolute inset-0 z-50 flex flex-col items-center justify-center px-4" style={{ background: "rgba(7,12,28,0.9)" }} onClick={() => setPhotoView(null)}>
            <img src={photoView.src} alt="" className="w-full rounded-2xl" style={{ maxHeight: "68vh", objectFit: "contain", boxShadow: "0 30px 80px rgba(0,0,0,.55)" }} />
            {photoView.label && <p className="text-center mt-3 font-bold text-white px-4" style={{ fontSize: 13.5 }}>📍 {photoView.label}</p>}
            <p className="text-center mt-1" style={{ color: "rgba(255,255,255,.55)", fontSize: 11, fontWeight: 700 }}>{lang === "es" ? "Toca para cerrar" : "Tap to close"}</p>
          </div>
        )}
      </div>
    </div>
  );
}
