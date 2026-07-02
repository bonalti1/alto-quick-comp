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
    demoLimit: "El modo demo incluye 6 valuaciones de prueba y ya las usaste. Los clientes de Quick Comp valúan sin límite.",
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
    demoLimit: "The demo includes 6 trial valuations and you've used them. Quick Comp clients value with no limits.",
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
      subject: { address: addr, beds, baths, sqft: subjSqft, yearBuilt: subjYear, latitude: baseLat, longitude: baseLng },
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

  // On startup with a session: load my account and my saved data
  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const r = await api("/api/me");
        if (r.status === 401) { try { localStorage.removeItem("alto_session"); } catch { /* ignore */ } setSession(null); return; }
        if (!r.ok) return;
        const j = await r.json();
        const p = j.contractor?.data?.profile || {};
        setBizName(p.biz || j.contractor.name || "");
        setUserName(p.name || "");
        setUserPhone(p.phone || j.contractor.phone || "");
        if (p.logo) setLogo(p.logo);
        if (p.lang) setLang(p.lang);
        if (p.trade) setTrade(p.trade);
        if (p.email) setBizEmail(p.email);
        if (p.license) setLicense(p.license);
        if (p.zelle) setZelle(p.zelle);
        if (p.prices) setMyPrices(p.prices);
        // Real accounts start clean — no demo data
        setCustomers(j.state?.customers || []);
        setJobs(j.state?.jobs || []);
        if (!WANT_ROOF && welcomedInit) setScreen("comps");
        setCloudReady(true);
      } catch { /* offline — local data keeps working */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Save to the cloud shortly after anything changes
  useEffect(() => {
    if (!session || !cloudReady) return;
    const id = setTimeout(() => {
      api("/api/state", {
        method: "PUT",
        body: JSON.stringify({
          state: { customers, jobs },
          profile: { profile: { name: userName, biz: bizName, phone: userPhone, logo, lang, trade, email: bizEmail, license, zelle, prices: myPrices } },
        }),
      }).catch(() => { /* offline — retried on next change */ });
    }, 1500);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, cloudReady, customers, jobs, userName, bizName, userPhone, logo, lang, trade, bizEmail, license, zelle, myPrices]);

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
  const [placeSugs, setPlaceSugs] = useState(null); // null = use built-in list
  const placesSeq = useRef(0);

  const [taxLookup, setTaxLookup] = useState(null); // Tax tab has its own independent search
  const [mapSat, setMapSat] = useState(true); // comparables map: satellite vs roadmap
  const [mapFocus, setMapFocus] = useState(null); // {i, t} — focus a comp on the in-app map
  const focusCompOnMap = (i) => {
    setMapFocus({ i, t: Date.now() });
    document.getElementById("qc-compmap")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

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
      const next = [item, ...prev.filter((p) => p.addr !== addr)].slice(0, 12);
      try { localStorage.setItem("qc_saved", JSON.stringify(next)); } catch {}
      return next;
    });
  };

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

  const startLookup = async (addr, placeId = null, gps = null, target = "comps") => {
    // Demo mode gets 6 measurements TOTAL (not per day) — a taste, not a tool.
    // The counter lives next to the demo data itself, so wiping it to cheat
    // also wipes everything the freeloader saved.
    if (!session) {
      let used = 0;
      try { used = parseInt(localStorage.getItem("alto_demo_meas") || "0", 10) || 0; } catch { /* private mode */ }
      if (used >= 6) { showToast("🔒 " + t.demoLimit); return; }
    }
    setAddrQ(addr);
    setExcludedComps({});
    setPriceOverrides({});
    setManualComps([]);
    setAddComp(null);
    setRadiusPref("auto");
    setNetPayoff("");
    setNetInclude(false);
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
    if (!answered) res = await mockLookup(addr);
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

  /* ── Shell pieces ── */
  const LangToggle = ({ onDark = false }) => (
    <div className="flex rounded-full overflow-hidden" style={{ border: `1.5px solid ${onDark ? "rgba(255,255,255,.28)" : C.line}` }}>
      {["es", "en"].map(l => (
        <button key={l} onClick={() => setLang(l)} className="px-3 py-1 text-xs font-bold uppercase"
          style={{
            background: lang === l ? (onDark ? C.orange : C.navy) : (onDark ? "transparent" : "#fff"),
            color: lang === l ? (onDark ? C.navy : "#fff") : (onDark ? "rgba(255,255,255,.8)" : C.slate),
            border: "none",
          }}>{l}</button>
      ))}
    </div>
  );

  const Header = ({ title, back }) => (
    <div className="flex items-center gap-3 px-5 pt-4 pb-3" style={{ background: C.navy }}>
      {back && <button onClick={back} className="text-2xl font-bold" style={{ color: "#fff", background: "none", border: "none" }}>‹</button>}
      <Logo size={28} color="#fff" />
      <span className="flex-1 font-bold text-lg truncate" style={{ color: "#fff", fontWeight: 800, letterSpacing: 0.3 }}>{title}</span>
      <LangToggle onDark />
    </div>
  );

  /* Quick Comp brand bar shown atop the primary tab screens */
  const BrandHeader = () => (
    <div className="relative flex items-center justify-center px-5 pt-4 pb-3" style={{ background: C.navy }}>
      <img src="/quick-comp-lockup-white.png" alt="Quick Comp" draggable={false} style={{ height: 46, objectFit: "contain", display: "block" }} />
      <div className="absolute" style={{ right: 16, top: "50%", transform: "translateY(-50%)" }}><LangToggle onDark /></div>
    </div>
  );

  const BottomNav = () => {
    const items = [
      ["comps", lang === "es" ? "Comps" : "Comps"],
      ["lending", lang === "es" ? "Crédito" : "Lending"],
      ["tax", lang === "es" ? "Impuestos" : "Tax"],
      ["workspace", lang === "es" ? "Trabajo" : "Workspace"],
    ];
    return (
      <div className="flex justify-around items-center gap-1.5 px-2 py-2" style={{ background: "#fff", borderTop: `1px solid ${C.line}` }}>
        {items.map(([s, label], i) => {
          const on = screen === s;
          return (
            <button key={s} onClick={() => setScreen(s)}
              className="flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-2xl"
              style={{ background: on ? C.navy : "transparent", border: "none" }}>
              <span className="text-xs font-extrabold" style={{ color: on ? C.orange : C.slate, letterSpacing: 0.5 }}>{`0${i + 1}`}</span>
              <span className="text-[11px] font-bold uppercase truncate" style={{ color: on ? "#fff" : C.slate, letterSpacing: 0.5 }}>{label}</span>
            </button>
          );
        })}
      </div>
    );
  };

  /* ── Screens ── */
  // Quick Comp visual language — scoped to the comps screens (search + result) only.
  const QC = {
    navy: "#1B2A5C", navyDeep: "#111B42",
    cardGrad: "linear-gradient(135deg,#162655,#223B72)",
    headGrad: "linear-gradient(135deg,#07162D 0%,#111B42 62%,#1D2F5A 100%)",
    gold: "#D7B665", goldHi: "#E6BF6A", goldLine: "#FFD700",
    bg: "#F0F4FA", line: "#dde4f0", line2: "#D9E1EF",
    muted: "#9aaac8", muted2: "#6b7db3", body: "#4a5a7a",
    green: "#1E9E5A", red: "#E8442E",
  };

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
    const localPool = [...new Set([...MOCK_PROPERTIES.map(p => p.addr), ...customers.map(c => c.addr).filter(Boolean)])];
    // Live suggestions are already filtered/ranked by Google — don't re-filter them
    const matches = placeSugs !== null
      ? placeSugs
      : localPool.filter(a => !q || a.toLowerCase().includes(q)).map(a => ({ text: a, placeId: null }));
    const custom = addrQ.trim() && !matches.some(m => m.text.toLowerCase() === q) ? addrQ.trim() : null;
    const go = () => { if (custom) startLookup(custom); else if (matches[0]) startLookup(matches[0].text, matches[0].placeId); };
    return (
      <div className="flex-1" style={{ background: QC.bg }}>
        <div className="px-5 py-4" style={{ background: QC.headGrad, borderBottom: `2px solid ${QC.gold}` }}>
          <p className="text-center" style={{ color: QC.goldHi, fontSize: 11, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Valuación de propiedad" : "Property Valuation"}</p>
          <p className="text-center font-extrabold text-white mt-0.5" style={{ fontSize: 18 }}>{lang === "es" ? "Pon precio con confianza" : "Price the property with confidence"}</p>
        </div>
        <div className="px-5 pt-3">
          <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <p className="mb-2" style={{ color: QC.muted2, fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Dirección de la propiedad" : "Property Address"}</p>
            <div className="flex gap-2">
              <button onClick={useMyLocation} title={t.useMyLocation} className="flex items-center justify-center shrink-0 active:scale-95 transition-transform"
                style={{ width: 48, height: 48, background: QC.bg, border: `1.5px solid ${QC.line}`, borderRadius: 12, color: QC.navy, fontSize: 18 }}>🧭</button>
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
          <p className="text-center mt-3" style={{ color: QC.muted, fontSize: 11, fontWeight: 600 }}>{lang === "es" ? "Ventas comparables cercanas · 100% gratis" : "Nearby comparable sales · 100% free"} · DEMO</p>
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
        <div className="px-5 pt-4">
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
                style={{ width: "100%", height: 170, objectFit: "cover", display: "block", background: QC.bg }}
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
            const rankBg = i === 0 ? "linear-gradient(135deg,#FFD700,#FFA500)" : i === 1 ? "linear-gradient(135deg,#C0C0C0,#A0A0A0)" : i === 2 ? "linear-gradient(135deg,#CD7F32,#8B5A00)" : QC.bg;
            const rankTxt = i <= 2 ? QC.navy : QC.muted;
            const barColor = i === 0 ? QC.goldLine : i <= 2 ? QC.navy : QC.line;
            const belowMkt = c.soldPrice && c.soldPrice < R.value * 0.95;
            return (
              <div key={i} className="rounded-2xl p-4 mb-2.5" style={{ background: "#fff", border: i === 0 ? `2px solid ${QC.goldLine}` : `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)", opacity: out || manualOut ? 0.5 : 1 }}>
                <div className="flex items-start gap-3 mb-2.5">
                  {c.latitude != null && c.longitude != null && (
                    <button onClick={() => focusCompOnMap(i)} title={lang === "es" ? "Ver en el mapa" : "View on map"}
                      className="relative shrink-0 active:scale-95 transition-transform" style={{ padding: 0, border: "none", background: "none", lineHeight: 0 }}>
                      <img
                        src={`/api/streetview?lat=${c.latitude}&lng=${c.longitude}`}
                        alt={c.address}
                        onError={(e) => { e.currentTarget.style.display = "none"; }}
                        style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 12, display: "block", background: QC.bg }}
                      />
                      <span className="absolute flex items-center justify-center" style={{ right: -5, bottom: -5, width: 20, height: 20, borderRadius: 10, background: QC.navy, color: "#fff", fontSize: 10, border: "2px solid #fff" }}>📍</span>
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

  const Slider = ({ label, value, display, min, max, step, onChange }) => (
    <div className="mb-3.5">
      <div className="flex justify-between items-baseline mb-1.5">
        <span style={{ color: QC.muted2, fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>{label}</span>
        <span className="font-extrabold" style={{ color: QC.navy, fontSize: 15 }}>{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full" style={{ accentColor: QC.gold, height: 4 }} />
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
      const localPool = [...new Set([...MOCK_PROPERTIES.map(p => p.addr), ...customers.map(c => c.addr).filter(Boolean)])];
      const matches = placeSugs !== null ? placeSugs : localPool.filter(a => !q || a.toLowerCase().includes(q)).map(a => ({ text: a, placeId: null }));
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
                  style={{ width: 48, height: 48, background: QC.bg, border: `1.5px solid ${QC.line}`, borderRadius: 12, color: QC.navy, fontSize: 18 }}>🧭</button>
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
            <p className="text-center mt-3" style={{ color: QC.muted, fontSize: 11, fontWeight: 600 }}>{lang === "es" ? "Solo impuestos — no necesitas correr comparables" : "Tax only — no need to run comps"} · DEMO</p>
          </div>
        </div>
      );
    }

    // We have a tax record
    const R = taxLookup;
    const subj = R.subject || {};
    const hasRealAssess = subj.assessedValue != null;
    const assessed = hasRealAssess ? subj.assessedValue : (R.value ? Math.round(R.value * 0.86) : null);
    const hasRealTax = subj.annualTax != null;
    const stateRate = TAX_RATE_BY_STATE[stateFromAddress(subj.address || R.addr)] || 0.011;
    const annualTax = hasRealTax ? subj.annualTax : (R.value ? Math.round(R.value * stateRate) : assessed ? Math.round(assessed * 0.011) : null);
    const taxYear = subj.taxYear || new Date().getFullYear();
    const estimated = !hasRealAssess || !hasRealTax;
    const facts = [["🛏️", subj.beds ?? "—", t.beds], ["🛁", subj.baths ?? "—", t.baths], ["📐", subj.sqft ? num(subj.sqft) : "—", t.cmpSqft], ["📅", subj.yearBuilt ?? "—", t.builtIn]];
    const rows = [
      [lang === "es" ? "Dueño registrado" : "Owner of record", subj.owner || (lang === "es" ? "Según registro público" : "Per public record")],
      [lang === "es" ? "Valor catastral" : "Assessed value", assessed ? "$" + num(assessed) + (hasRealAssess ? "" : (lang === "es" ? " (est.)" : " (est.)")) : "—"],
      [lang === "es" ? (hasRealTax ? "Impuesto anual" : "Impuesto anual estimado") : (hasRealTax ? "Annual tax" : "Est. annual tax"), annualTax ? "$" + num(annualTax) : "—"],
      [lang === "es" ? "Año fiscal" : "Tax year", String(taxYear)],
    ];
    return (
      <div className="flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 6 }}>{lang === "es" ? "Resumen de impuestos" : "Tax snapshot"}</p>
            <p className="font-extrabold mb-3" style={{ color: QC.navyDeep, fontSize: 16, lineHeight: 1.3 }}>{subj.address || R.addr}</p>
            {rows.map(([k, v], i) => (
              <div key={k} className="flex justify-between py-2" style={{ borderTop: i ? `1px solid ${QC.line}` : "none" }}>
                <span style={{ color: QC.muted2, fontSize: 13, fontWeight: 600 }}>{k}</span>
                <span className="font-extrabold" style={{ color: QC.navy, fontSize: 13 }}>{v}</span>
              </div>
            ))}
          </div>
          <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <p style={{ color: QC.muted2, fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 8 }}>{lang === "es" ? "Datos clave de la propiedad" : "Key property facts"}</p>
            <div className="grid grid-cols-4 gap-2">
              {facts.map(([icon, v, label]) => (
                <div key={label} style={{ background: QC.bg, border: `1px solid ${QC.line}`, borderRadius: 10, padding: "10px 6px", textAlign: "center" }}>
                  <p className="font-extrabold" style={{ color: QC.navy, fontSize: 15 }}>{v}</p>
                  <p style={{ color: QC.muted, fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 3 }}>{icon} {label}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl px-3 py-2.5 mb-3" style={{ background: QC.bg, border: `1px solid ${QC.line}` }}>
            <span style={{ color: QC.green }}>✓</span>
            <span style={{ color: QC.body, fontSize: 12, fontWeight: 600 }}>{lang === "es" ? "Resumen fiscal listo para el cliente" : "Client-ready tax summary available"}</span>
          </div>
          <button onClick={() => { setAddrQ(""); setPlaceSugs(null); setTaxLookup(null); }} className="w-full active:translate-y-px transition-transform"
            style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 12, padding: 15, fontSize: 16, fontWeight: 700, boxShadow: "0 4px 14px rgba(27,42,92,0.3)" }}>
            {lang === "es" ? "Nueva búsqueda" : "New search"}
          </button>
          {estimated && <p className="mt-3" style={{ color: "#66759D", fontSize: 11, fontWeight: 600, lineHeight: 1.5 }}>⚠️ {lang === "es" ? "Valores catastrales estimados — confirma con el condado." : "Assessed values are estimates — confirm with the county."}</p>}
          <p className="mt-2" style={{ color: "#66759D", fontSize: 11, fontWeight: 600, lineHeight: 1.5 }}>ℹ️ {lang === "es" ? "Al venderse, el impuesto suele recalcularse — las exenciones del dueño actual no se transfieren al comprador." : "After a sale, taxes are usually recalculated — the current owner's exemptions don't transfer to the buyer."}</p>
        </div>
      </div>
    );
  };

  /* ── 04 · WORKSPACE — saved work + Realtor branding ── */
  const Workspace = () => {
    const reopen = (it) => {
      setLookup(it);
      setLendPrice(null);
      setScreen("comps");
    };
    return (
      <div className="flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          <div className="rounded-2xl p-5 mb-3" style={{ background: QC.cardGrad, boxShadow: "0 18px 38px rgba(17,27,66,0.18)" }}>
            <p style={{ color: QC.goldHi, fontSize: 11, fontWeight: 900, letterSpacing: "0.16em", textTransform: "uppercase" }}>{lang === "es" ? "Trabajo guardado" : "Saved work"}</p>
            <p className="text-white font-extrabold" style={{ fontSize: 26, margin: "4px 0 6px" }}>{savedWork.length} {lang === "es" ? (savedWork.length === 1 ? "elemento reciente" : "elementos recientes") : (savedWork.length === 1 ? "recent item" : "recent items")}</p>
            <p style={{ color: "rgba(255,255,255,0.76)", fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>{lang === "es" ? "Reabre comps, estimados de financiamiento e impuestos sin empezar de cero." : "Reopen past comps, lending estimates, and tax snapshots without starting over."}</p>
          </div>

          {savedWork.length === 0 ? (
            <div className="rounded-2xl text-center mb-3" style={{ background: "#fff", border: "1px dashed #CAD5E7", padding: "26px 22px" }}>
              <p style={{ color: "#66759D", fontSize: 13, fontWeight: 600 }}>{lang === "es" ? "Tus búsquedas de propiedades aparecerán aquí." : "Your property searches will show up here."}</p>
            </div>
          ) : (
            <div className="mb-3">
              {savedWork.map((it, i) => (
                <button key={it.addr + i} onClick={() => reopen(it)} className="w-full flex items-center gap-3 rounded-2xl p-3.5 mb-2 text-left active:scale-[0.99] transition-transform"
                  style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
                  <span className="shrink-0 flex items-center justify-center rounded-xl font-extrabold" style={{ width: 40, height: 40, background: QC.bg, border: `1px solid ${QC.line}`, color: QC.navy, fontSize: 13 }}>{`0${i + 1}`.slice(-2)}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-bold truncate" style={{ color: QC.navyDeep, fontSize: 14 }}>{it.addr || "—"}</span>
                    <span className="block" style={{ color: QC.muted2, fontSize: 11, fontWeight: 600 }}>{lang === "es" ? "Comp · valor" : "Comp · value"} {it.value ? "$" + Number(it.value).toLocaleString("en-US") : "—"}</span>
                  </span>
                  <span style={{ color: QC.gold, fontSize: 18 }}>›</span>
                </button>
              ))}
            </div>
          )}

          <div className="rounded-2xl p-4" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 4 }}>{lang === "es" ? "Perfil del agente" : "Realtor profile"}</p>
            <p className="font-extrabold mb-3" style={{ color: QC.navyDeep, fontSize: 17 }}>{lang === "es" ? "Marca de tus informes" : "Client report branding"}</p>
            <div className="flex items-center gap-2 rounded-xl px-3 py-2.5 mb-3" style={{ background: QC.bg, border: `1px solid ${QC.line}` }}>
              <span style={{ color: QC.gold }}>✦</span>
              <span style={{ color: QC.body, fontSize: 12, fontWeight: 600 }}>{lang === "es" ? "Marca personal activa — tus informes la usan." : "Personal branding is active — reports use it."}</span>
            </div>
            <div className="rounded-2xl p-3.5 mb-3 flex items-center gap-3" style={{ background: QC.headGrad }}>
              <span className="shrink-0 flex items-center justify-center rounded-xl font-extrabold" style={{ width: 40, height: 40, background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.18)", color: QC.goldHi, fontSize: 17 }}>{(userName || "R")[0].toUpperCase()}</span>
              <span className="min-w-0">
                <span className="block" style={{ color: QC.goldHi, fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase" }}>{lang === "es" ? "Presentado por" : "Presented by"}</span>
                <span className="block font-extrabold text-white truncate" style={{ fontSize: 15 }}>{userName || (lang === "es" ? "Tu nombre" : "Your name")}{bizName ? ` · ${bizName}` : ""}</span>
                {bizEmail && <span className="block truncate" style={{ color: "rgba(255,255,255,0.7)", fontSize: 11 }}>{bizEmail}</span>}
              </span>
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
              className="w-full rounded-xl px-3.5 py-3 mb-3 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
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
          </div>
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
    // One link the client can open: all report data travels IN the link (/r?d=)
    const shareLink = async () => {
      const lg = await ensureLogoId();
      const digits = String(userPhone).replace(/\D/g, "");
      const payload = {
        l: lang, a: subj.address || R.addr, v: R.value, lo: R.low, hi: R.high,
        ppsf: R.avgPpsf, n, cu: R.curated ? 1 : 0,
        s: { bd: subj.beds, ba: subj.baths, sf: subj.sqft, yr: subj.yearBuilt },
        c: comps.map((c) => [c.address, c.soldPrice]),
        g: { n: userName, b: bizName, p: digits, e: bizEmail, lic: license, ...(lg ? { lg } : {}) },
        ...(netInclude ? { ns: { cm: netCommPct, cl: netClosePct, po: payoffN, net: Math.round(netAmt) } } : {}),
      };
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const url = `${location.origin}/r?d=${b64}`;
      const copied = () => showToast(lang === "es" ? "Link del informe copiado ✓" : "Report link copied ✓");
      try {
        if (navigator.share) await navigator.share({ title: "Quick Comp", url });
        else { await navigator.clipboard.writeText(url); copied(); }
      } catch { try { await navigator.clipboard.writeText(url); copied(); } catch { /* ignore */ } }
    };
    return (
      <div className="flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          {/* The report document */}
          <div id="qc-report" className="rounded-2xl overflow-hidden" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 18px 38px rgba(17,27,66,0.12)" }}>
            {/* Branded header band */}
            <div className="flex items-center justify-between gap-3 px-4 py-3.5" style={{ background: QC.headGrad }}>
              <div className="flex items-center gap-3 min-w-0">
                {logo && <img src={logo} alt="" className="shrink-0" style={{ height: 38, maxWidth: 96, objectFit: "contain", background: "#fff", borderRadius: 8, padding: 3 }} />}
                <div className="min-w-0">
                  <p style={{ color: QC.goldHi, fontSize: 8, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Presentado por" : "Presented by"}</p>
                  <p className="text-white font-extrabold truncate" style={{ fontSize: 14 }}>{userName || (lang === "es" ? "Tu nombre" : "Your name")}</p>
                  {bizName && <p className="truncate" style={{ color: "rgba(255,255,255,0.7)", fontSize: 11 }}>{bizName}</p>}
                  {(userPhone || bizEmail) && <p className="truncate" style={{ color: "rgba(255,255,255,0.62)", fontSize: 10.5 }}>{[userPhone, bizEmail].filter(Boolean).join(" · ")}</p>}
                  {license && <p className="truncate" style={{ color: "rgba(255,255,255,0.5)", fontSize: 9.5 }}>{lang === "es" ? "Lic. " : "Lic. "}{license}</p>}
                </div>
              </div>
              <p className="text-white font-extrabold shrink-0" style={{ fontSize: 13, letterSpacing: "0.03em" }}>{lang === "es" ? "Informe CMA" : "Client CMA Report"}</p>
            </div>
            {/* Body */}
            <div className="px-4 py-4">
              <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.16em", textTransform: "uppercase" }}>{t.cmpValue}</p>
              <p style={{ color: QC.navyDeep, fontSize: 36, fontWeight: 900, lineHeight: 1, margin: "6px 0" }}>{fmt(R.value)}</p>
              {hasRange && <p style={{ color: QC.muted2, fontSize: 13, fontWeight: 600 }}>{fmt(R.low)} – {fmt(R.high)} {lang === "es" ? "rango sugerido" : "suggested range"}</p>}
              <p className="font-bold mt-1.5" style={{ color: QC.navy, fontSize: 13 }}>{subj.address || R.addr}</p>

              {/* Sold comparable support */}
              <div className="rounded-xl mt-3 px-3.5 py-3" style={{ background: QC.bg, border: `1px solid ${QC.line}` }}>
                <p style={{ color: QC.navy, fontSize: 12, fontWeight: 800, letterSpacing: "0.02em", marginBottom: 8 }}>{lang === "es" ? "Apoyo de ventas comparables" : "Sold Comparable Support"}</p>
                {comps.length === 0 && <p style={{ color: QC.muted, fontSize: 12, fontWeight: 600 }}>{lang === "es" ? "Sin comparables disponibles." : "No comparables available."}</p>}
                {comps.map((c, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 py-1.5" style={{ borderTop: i ? `1px solid ${QC.line}` : "none" }}>
                    <span className="truncate" style={{ color: QC.body, fontSize: 12.5, fontWeight: 600 }}>{i + 1}. {c.address}</span>
                    <span className="shrink-0 font-extrabold" style={{ color: QC.navyDeep, fontSize: 12.5 }}>{fmt(c.soldPrice)}</span>
                  </div>
                ))}
              </div>

              {/* AI-assisted summary */}
              <div className="rounded-xl mt-3 px-4 py-3.5" style={{ background: QC.cardGrad, border: `1px solid ${QC.gold}55` }}>
                <p style={{ color: QC.goldHi, fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", marginBottom: 6 }}>{lang === "es" ? "Resumen asistido por IA" : "AI-Assisted Summary"}</p>
                <p className="text-white" style={{ fontSize: 12.5, lineHeight: 1.6, fontWeight: 500 }}>{narrative}</p>
              </div>

              {netInclude && (
                <div className="rounded-xl mt-3 px-3.5 py-3" style={{ background: "#FDF9EF", border: `2px solid ${QC.goldLine}` }}>
                  <p style={{ color: QC.navy, fontSize: 12, fontWeight: 800, marginBottom: 6 }}>💰 {lang === "es" ? "Hoja neta del vendedor" : "Seller Net Sheet"}</p>
                  {[[lang === "es" ? "Precio de venta" : "Sale price", fmt(R.value)],
                    [`${lang === "es" ? "Comisión" : "Commission"} (${netCommPct}%)`, `−${fmt(commAmt)}`],
                    [`${lang === "es" ? "Gastos de cierre" : "Closing costs"} (${netClosePct}%)`, `−${fmt(closeAmt)}`],
                    ...(payoffN ? [[lang === "es" ? "Saldo de hipoteca" : "Mortgage payoff", `−${fmt(payoffN)}`]] : [])].map(([k, x], i) => (
                    <div key={k} className="flex justify-between py-1" style={{ borderTop: i ? `1px solid ${QC.goldLine}44` : "none", fontSize: 12, fontWeight: 600, color: QC.body }}>
                      <span>{k}</span><span style={{ fontWeight: 800, color: QC.navyDeep }}>{x}</span>
                    </div>
                  ))}
                  <div className="flex justify-between pt-2 mt-1" style={{ borderTop: `2px solid ${QC.goldLine}`, fontSize: 14, fontWeight: 900, color: QC.navyDeep }}>
                    <span>{lang === "es" ? "NETO ESTIMADO" : "ESTIMATED NET"}</span><span>{fmt(netAmt)}</span>
                  </div>
                </div>
              )}
              <p className="mt-3" style={{ color: QC.muted, fontSize: 9.5, fontWeight: 600, lineHeight: 1.5 }}>⚠️ {t.cmpDisc}</p>
            </div>
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

  /* ── First-login welcome (captures name + brokerage for report branding) ── */
  const Welcome = () => {
    const finish = () => {
      saveProfile({ name: userName, biz: bizName });
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
            <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 4 }}>{lang === "es" ? "Tu perfil" : "Your profile"}</p>
            <p className="font-bold mb-3" style={{ color: QC.navyDeep, fontSize: 14 }}>{lang === "es" ? "Aparece como “Presentado por” en tus informes." : "Shown as “Presented by” on your client reports."}</p>
            <input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder={lang === "es" ? "Tu nombre" : "Your name"}
              className="w-full rounded-xl px-3.5 py-3 mb-2 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
            <input value={bizName} onChange={(e) => setBizName(e.target.value)} placeholder={lang === "es" ? "Inmobiliaria / Brokerage" : "Brokerage"}
              className="w-full rounded-xl px-3.5 py-3 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
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

  /* ── Router ── */
  const titles = {
    report: "📄 " + (lang === "es" ? "Informe del cliente" : "Client report"),
  };
  const backMap = {
    report: "comps",
  };
  const tabScreens = ["comps", "lending", "tax", "workspace"];
  const withNav = tabScreens;

  return (
    <div className="min-h-screen flex justify-center" style={{ background: C.navyDeep }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,800&family=Inter:wght@400;500;600;700;800&display=swap');
        * { font-family: 'Inter', sans-serif; -webkit-tap-highlight-color: transparent; }
        input::placeholder { color: #A7AEBE; }
        @keyframes ttpPulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.18); opacity: .65; } }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
        @media print {
          body { background: #fff !important; }
          .no-print { display: none !important; }
          #qc-report { box-shadow: none !important; border: 1px solid #d9e1ef !important; }
        }`}</style>
      <div className="w-full max-w-md flex flex-col relative" style={{ background: C.bg, minHeight: "100vh" }}>
        {!session && (
          <div className="no-print px-4 py-2 text-center" style={{ background: C.orangeSoft, borderBottom: `1.5px solid ${C.orange}` }}>
            <span className="text-xs font-bold" style={{ color: "#7A5A00" }}>{t.demoBanner}</span>
          </div>
        )}
        {tabScreens.includes(screen) && <BrandHeader />}
        {screen !== "welcome" && !tabScreens.includes(screen) && (
          <div className="no-print"><Header title={titles[screen] || ""} back={() => setScreen(backMap[screen] || "comps")} /></div>
        )}
        {screen === "welcome" && Welcome()}
        {screen === "comps" && (lookup ? CompsResult() : CompsSearch())}
        {screen === "lending" && Lending()}
        {screen === "tax" && Tax()}
        {screen === "workspace" && Workspace()}
        {screen === "report" && Report()}
        {withNav.includes(screen) && <BottomNav />}
        {toast && (
          <div className="absolute left-0 right-0 flex justify-center" style={{ bottom: 80, pointerEvents: "none" }}>
            <span className="rounded-full px-5 py-2.5 font-bold text-sm text-white" style={{ background: C.navyDeep, boxShadow: "0 8px 20px rgba(0,0,0,.3)" }}>{toast}</span>
          </div>
        )}
      </div>
    </div>
  );
}
