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
  const [failed, setFailed] = useState(false);

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
        const html = `<div style="font-family:Inter,sans-serif;min-width:170px">`
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
    hello: "Hola", today: "Hoy", theyOwe: "Te deben", jobs: "Trabajos",
    newEstimate: "NUEVO ESTIMADO", calculator: "CALCULADORA", payments: "COBROS",
    askTTP: "Pregúntale a ALTO", home: "Inicio", customers: "Clientes",
    yourName: "Tu nombre", bizName: "Nombre de tu negocio", phone: "Tu teléfono",
    continue: "CONTINUAR", whichTrade: "¿Cuál es tu oficio?", soon: "Próximamente",
    concrete: "Concreto", roofing: "Techos", plumbing: "Plomería", electric: "Eléctrico",
    painting: "Pintura", fence: "Cercas", landscaping: "Jardinería", pressure: "Lavado a presión",
    length: "Largo (ft)", width: "Ancho (ft)", thickness: "Grosor (in)", waste: "Desperdicio",
    result: "RESULTADO", cubicYards: "Yardas cúbicas", withWaste: "Con desperdicio",
    order: "Pide", trucks: "Camiones", optPrice: "OPCIONAL: PRECIO",
    pricePerYard: "Precio por yarda ($)", laborSqFt: "Mano de obra ($/sq ft)",
    material: "Material", labor: "Mano de obra", estTotal: "TOTAL ESTIMADO",
    toEstimate: "CONVERTIR A ESTIMADO →", forWho: "¿Para qué cliente?",
    addCustomer: "+ Agregar cliente", name: "Nombre", save: "GUARDAR",
    estimate: "Estimado", ready: "listo", sendText: "📱 ENVIAR POR TEXTO",
    sendEmail: "✉️ ENVIAR POR EMAIL", sentTo: "Enviado por texto a",
    simulateAccept: "▶ Demo: el cliente aceptó", accepted: "Aceptado",
    estimateSt: "Estimado", scheduled: "Programado", inProgress: "En Progreso",
    done: "Terminado", paid: "Pagado", pending: "PENDIENTE", partial: "PARCIAL",
    overdue: "Vencido", daysShort: "d", remind: "Recordar", reminderSent: "Recordatorio enviado a",
    genInvoice: "GENERAR FACTURA", invoice: "Factura", subtotal: "Subtotal",
    tax: "Impuesto (si aplica)", depositRec: "Depósito recibido", balance: "SALDO PENDIENTE",
    payNow: "💳 PAGAR AHORA", markPaid: "✓ Marcar como pagado", paidToast: "Pago registrado",
    job: "Trabajo", jobAddr: "Dirección del trabajo", photos: "Fotos", addPhoto: "📷 Agregar foto",
    notes: "Notas", status: "Estado", newJob: "+ NUEVO", noJobs: "Sin trabajos todavía. Crea tu primer estimado.",
    call: "Llamar", text: "Texto", history: "Historial",
    aiHint: "Escribe o usa los botones…", aiThinking: "Pensando…",
    aiChip1: "¿Cuántas yardas para 20×30, 4 pulgadas?",
    aiChip2: "¿Quién me debe dinero?",
    aiChip3: "Redacta un recordatorio de pago amable",
    back: "Atrás", total: "Total", deposit: "Depósito (30%)",
    lineSlab: "Losa de concreto", lineMesh: "Malla de refuerzo", lineBase: "Base de gravilla",
    addons: "Extras", finish: "Acabado: escoba",
    welcome1: "Cotiza en 2 minutos.", welcome2: "Cobra más rápido.",
    madeFor: "HECHO PARA CONTRATISTAS",
    alreadyClient: "¿Ya eres cliente de ALTO Pro?",
    demoBanner: "🧪 Modo demo — tus datos no se guardan en la nube. ¿Cliente? Entra con tu link de WhatsApp.",
    demoLimit: "El modo demo incluye 6 mediciones de prueba y ya las usaste. Los clientes de ALTO Pro miden sin límite.",
    alreadyClientHint: "Entra con el link que te mandamos por WhatsApp — es tu llave personal. ¿Lo perdiste? Escríbenos y te mandamos uno nuevo.",
    aiErr: "No pude conectar. Intenta de nuevo.",
    estCreated: "Estimado creado",
    footprint: "Área de la casa (sq ft)", stories: "Pisos", pitch: "Inclinación (pitch)",
    roofArea: "Área del techo", squares: "Cuadros (squares)", matSquares: "Material (+10%)",
    materialType: "Material", tearOff: "Tear-off (quitar techo viejo)", layers: "Capas existentes",
    shingle3: "Shingle 3-tab", archShingle: "Shingle arquitectónico", metalRoof: "Metal", tileRoof: "Teja",
    matPerSq: "Material ($/sq)", laborPerSq: "Mano de obra ($/sq)", tearPerSq: "Tear-off ($/sq)",
    accessories: "Underlayment, drip edge, clavos", tearOffLine: "Tear-off y disposición",
    lineRoof: "Techo nuevo", storyNote: "+10% mano de obra por piso extra",
    measureTitle: "Medir techo", searchAddress: "Escribe la dirección…",
    measuring1: "Buscando imagen satelital…", measuring2: "Midiendo el techo…", measuring3: "Calculando cuadros…",
    satMeasured: "MEDIDO POR SATÉLITE", verifyOnSite: "Estimado satelital — verifica en sitio",
    segments: "Secciones del techo", propertyInfo: "DATOS DE LA PROPIEDAD",
    beds: "Recámaras", baths: "Baños", builtIn: "Construida", livingArea: "Área habitable",
    editSquares: "Cuadros (puedes editar)", manualMode: "✏️ Medir manualmente",
    noRoofData: "Sin datos satelitales para esta dirección. Usa la calculadora.",
    roofMeasured: "Techo medido", useThisAddr: "Buscar", suggestions: "SUGERENCIAS",
    sourceNote: "Datos reales de Google", imageryFrom: "imagen satelital de",
    verifyManual: "Confirma en sitio o ajusta los cuadros abajo",
    traceTitle: "Trazar techo", traceHint: "Toca las esquinas · arrastra para mover · +/− para acercar",
    verifyBtn: "✏️ VERIFICAR MANUAL",
    undo: "↩ Deshacer", clearAll: "✕ Borrar", closeSection: "✓ Cerrar sección",
    modePts: "Puntos", modeSq: "Cuadros", addSquare: "➕ Cuadro", delShape: "🗑 Borrar",
    sqHint: "Arrastra el cuadro · jala las esquinas para ajustar · gíralo con el puntito de arriba",
    howMeasure: "¿Cómo quieres medir el techo?",
    pressArea: "Presiona el área", pressAreaSub: "marca las esquinas",
    makeSquares: "Haz cuadros", makeSquaresSub: "pon y ajusta cuadros",
    measMaybeOff: "La medición puede estar incompleta",
    measMaybeOffSub: "El satélite no alcanzó a captar todo el techo aquí. Mídelo a mano en ~10 segundos para cobrar con seguridad.",
    measManualBtn: "Medir a mano con cuadros",
    tracedArea: "Área trazada", useMeasure: "USAR ESTA MEDIDA →",
    traceOnPhoto: "✏️ Trazar en la foto", traced: "TRAZADO",
    tracedNote: "Trazado a mano sobre imagen de Google",
    noRoofTrace: "Sin medición automática — traza el techo en la foto",
    adjustDetails: "Ajustar detalles", shortVerify: "Verifica en sitio",
    useMyLocation: "Usar mi ubicación", myLocation: "Mi ubicación", locating: "Buscando tu ubicación…",
    cmpValue: "Valor estimado de mercado", cmpRange: "Rango", cmpDone: "Valor listo",
    cmpConfStrong: "Confianza alta", cmpConfGood: "Confianza buena", cmpConfLimited: "Confianza limitada", cmpConfLow: "Confianza baja",
    cmpSubject: "Propiedad evaluada", cmpComps: "Ventas comparables", cmpSold: "Vendida", cmpPerSqft: "/pie²",
    cmpMatch: "coincidencia", cmpMap: "Mapa de comparables", cmpWithin: "dentro de", cmpComp: "comps",
    cmpDisc: "Estimado basado en ventas recientes comparables — no es un avalúo.",
    cmpNone: "No se encontraron ventas comparables cerca. Prueba otra dirección.",
    cmpNew: "Nueva búsqueda", cmpExcluded: "Atípico", cmpSqft: "pie²",
    cmpStart: "Empieza con una dirección. Buscaremos ventas cercanas y te daremos un valor de mercado.",
    locErr: "No pude obtener tu ubicación. Activa el GPS y permite el acceso.",
    leads: "Leads", leadNew: "NUEVO", leadDone: "✓ Contactado", leadUndo: "Marcar nuevo",
    leadWhats: "WhatsApp", leadCall: "Llamar", leadEst: "Estimado",
    leadsEmpty: "Aquí caen los clientes que piden precio en tu página web.",
    leadsEmptySub: "Cuando alguien deja su teléfono en tu sitio, te aparece aquí al instante.",
    leadMsg: (n, a, who) => `Hola${n ? " " + n : ""} 👋 Soy ${who}. Vi que pediste precio para tu techo${a ? " en " + a : ""}. ¿Cuándo puedo pasar a verlo? Es gratis y sin compromiso.`,
    settings: "Ajustes", brandSection: "TU MARCA", saved: "Guardado",
    bizSection: "MI NEGOCIO", emailLbl: "Email", licenseLbl: "Licencia / RCAT # (opcional)",
    pricesSection: "MIS PRECIOS", pricesHint: "Tus precios por cuadro (square). Cada estimado nuevo los usa automáticamente.",
    paySection: "PAGOS", zelleLbl: "Número de Zelle", zelleHint: "Vacío = usamos tu teléfono",
    acctSection: "MI CUENTA", changeTrade: "🔨 Cambiar oficio", logout: "Cerrar sesión",
    logoutQ: "¿Cerrar sesión? Tus datos quedan guardados en la nube.",
    viewPdf: "📄 VER PDF / IMPRIMIR", brandHint: "Tu logo aparece en estimados, facturas y el PDF que recibe tu cliente.",
    accHigh: "✓ Precisión alta · típicamente ±5%",
    accOld: "⚠️ Imagen antigua — verifica antes de ordenar",
    accMed: "⚠️ Calidad media — verifica antes de ordenar",
    accEst: "⚠️ Estimado del área de la casa — verifica",
    accTraced: "✏️ Medido por ti en la foto",
    quickInvoice: "Factura rápida (hablada)", viSpeak: "Toca el micrófono y di: cliente, trabajo y monto",
    viExample: "“Factura para María García, reparación de techo, 450 dólares”",
    viHeard: "Escuché", cust: "Cliente", concept: "Concepto", amount: "Monto ($)",
    createInvoice: "CREAR FACTURA →", howToPay: "CÓMO PAGAR", payCash: "Efectivo o cheque aceptado",
    linkCopied: "Enlace copiado — pégalo en un mensaje", invMsg: "Factura", estMsg: "Estimado", fromMsg: "de",
    logoOpt: "LOGO DE TU NEGOCIO (OPCIONAL)", uploadLogo: "📷 Subir logo", removeLogo: "Quitar",
    installHint: "Instala la app: toca Compartir ⬆️ y luego “Agregar a pantalla de inicio”",
    measureFence: "Medir cerca", fenceTitle: "Dibujar cerca",
    fenceHint: "Toca a lo largo de la cerca · arrastra para mover · +/− acercar",
    endRun: "✓ Terminar línea", totalLF: "Pies lineales", panels: "Paneles (8 ft)",
    posts: "Postes", cornerPosts: "Esquinas", walkGate: "Puerta sencilla", doubleGate: "Puerta doble",
    perLF: "Precio por pie ($)", walkPrice: "Puerta sencilla ($)", dblPrice: "Puerta doble ($)",
    markup: "Margen materiales (%)", cedar: "Cedro", vinyl: "Vinilo", chain: "Malla", alum: "Aluminio", custom: "Otro",
    lineFence: "Cerca", lineGates: "Puertas", lineMarkup: "Margen de materiales",
    fenceDrawn: "Cerca medida",
    propLine: "Línea de propiedad cargada — toca un lado para quitarlo o agregarlo",
    noParcel: "Sin línea de propiedad para esta dirección — dibuja la cerca en la foto",
  },
  en: {
    hello: "Hi", today: "Today", theyOwe: "They owe you", jobs: "Jobs",
    newEstimate: "NEW ESTIMATE", calculator: "CALCULATOR", payments: "PAYMENTS",
    askTTP: "Ask ALTO", home: "Home", customers: "Customers",
    yourName: "Your name", bizName: "Your business name", phone: "Your phone",
    continue: "CONTINUE", whichTrade: "What's your trade?", soon: "Coming soon",
    concrete: "Concrete", roofing: "Roofing", plumbing: "Plumbing", electric: "Electrical",
    painting: "Painting", fence: "Fence", landscaping: "Landscaping", pressure: "Pressure washing",
    length: "Length (ft)", width: "Width (ft)", thickness: "Thickness (in)", waste: "Waste",
    result: "RESULT", cubicYards: "Cubic yards", withWaste: "With waste",
    order: "Order", trucks: "Trucks", optPrice: "OPTIONAL: PRICING",
    pricePerYard: "Price per yard ($)", laborSqFt: "Labor ($/sq ft)",
    material: "Material", labor: "Labor", estTotal: "ESTIMATED TOTAL",
    toEstimate: "CONVERT TO ESTIMATE →", forWho: "Which customer?",
    addCustomer: "+ Add customer", name: "Name", save: "SAVE",
    estimate: "Estimate", ready: "ready", sendText: "📱 SEND BY TEXT",
    sendEmail: "✉️ SEND BY EMAIL", sentTo: "Sent by text to",
    simulateAccept: "▶ Demo: customer accepted", accepted: "Accepted",
    estimateSt: "Estimate", scheduled: "Scheduled", inProgress: "In Progress",
    done: "Done", paid: "Paid", pending: "PENDING", partial: "PARTIAL",
    overdue: "Overdue", daysShort: "d", remind: "Remind", reminderSent: "Reminder sent to",
    genInvoice: "GENERATE INVOICE", invoice: "Invoice", subtotal: "Subtotal",
    tax: "Tax (if applies)", depositRec: "Deposit received", balance: "BALANCE DUE",
    payNow: "💳 PAY NOW", markPaid: "✓ Mark as paid", paidToast: "Payment recorded",
    job: "Job", jobAddr: "Job address", photos: "Photos", addPhoto: "📷 Add photo",
    notes: "Notes", status: "Status", newJob: "+ NEW", noJobs: "No jobs yet. Create your first estimate.",
    call: "Call", text: "Text", history: "History",
    aiHint: "Type or use the buttons…", aiThinking: "Thinking…",
    aiChip1: "How many yards for 20×30, 4 inches?",
    aiChip2: "Who owes me money?",
    aiChip3: "Draft a friendly payment reminder",
    back: "Back", total: "Total", deposit: "Deposit (30%)",
    lineSlab: "Concrete slab", lineMesh: "Reinforcement mesh", lineBase: "Gravel base",
    addons: "Add-ons", finish: "Finish: broom",
    welcome1: "Quote in 2 minutes.", welcome2: "Get paid faster.",
    madeFor: "BUILT FOR CONTRACTORS",
    alreadyClient: "Already an ALTO Pro client?",
    demoBanner: "🧪 Demo mode — your data isn't saved to the cloud. Client? Enter with your WhatsApp link.",
    demoLimit: "The demo includes 6 trial measurements and you've used them. ALTO Pro clients measure with no limits.",
    alreadyClientHint: "Enter with the link we sent you on WhatsApp — it's your personal key. Lost it? Message us and we'll send a new one.",
    aiErr: "Couldn't connect. Try again.",
    estCreated: "Estimate created",
    footprint: "House footprint (sq ft)", stories: "Stories", pitch: "Pitch",
    roofArea: "Roof area", squares: "Squares", matSquares: "Material (+10%)",
    materialType: "Material", tearOff: "Tear-off (remove old roof)", layers: "Existing layers",
    shingle3: "3-tab shingle", archShingle: "Architectural shingle", metalRoof: "Metal", tileRoof: "Tile",
    matPerSq: "Material ($/sq)", laborPerSq: "Labor ($/sq)", tearPerSq: "Tear-off ($/sq)",
    accessories: "Underlayment, drip edge, nails", tearOffLine: "Tear-off & disposal",
    lineRoof: "New roof", storyNote: "+10% labor per extra story",
    measureTitle: "Measure roof", searchAddress: "Type the address…",
    measuring1: "Finding satellite imagery…", measuring2: "Measuring the roof…", measuring3: "Calculating squares…",
    satMeasured: "MEASURED BY SATELLITE", verifyOnSite: "Satellite estimate — verify on site",
    segments: "Roof sections", propertyInfo: "PROPERTY INFO",
    beds: "Bedrooms", baths: "Baths", builtIn: "Built", livingArea: "Living area",
    editSquares: "Squares (you can edit)", manualMode: "✏️ Measure manually",
    noRoofData: "No satellite data for this address. Use the calculator.",
    roofMeasured: "Roof measured", useThisAddr: "Search", suggestions: "SUGGESTIONS",
    sourceNote: "Real data from Google", imageryFrom: "satellite imagery from",
    verifyManual: "Confirm on site or adjust the squares below",
    traceTitle: "Trace roof", traceHint: "Tap the corners · drag to move · +/− to zoom",
    verifyBtn: "✏️ VERIFY MANUALLY",
    undo: "↩ Undo", clearAll: "✕ Clear", closeSection: "✓ Close section",
    modePts: "Points", modeSq: "Squares", addSquare: "➕ Square", delShape: "🗑 Delete",
    sqHint: "Drag the box · pull the corners to fit · rotate with the top dot",
    howMeasure: "How do you want to measure?",
    pressArea: "Press the area", pressAreaSub: "tap the corners",
    makeSquares: "Make squares", makeSquaresSub: "drop & adjust boxes",
    measMaybeOff: "This measurement may be incomplete",
    measMaybeOffSub: "The satellite didn't capture the whole roof here. Measure it by hand in ~10 seconds to quote with confidence.",
    measManualBtn: "Measure by hand with squares",
    tracedArea: "Traced area", useMeasure: "USE THIS MEASUREMENT →",
    traceOnPhoto: "✏️ Trace on the photo", traced: "TRACED",
    tracedNote: "Hand-traced on Google imagery",
    noRoofTrace: "No automatic measurement — trace the roof on the photo",
    adjustDetails: "Adjust details", shortVerify: "Verify on site",
    useMyLocation: "Use my location", myLocation: "My location", locating: "Finding your location…",
    cmpValue: "Estimated Market Value", cmpRange: "Range", cmpDone: "Value ready",
    cmpConfStrong: "High confidence", cmpConfGood: "Good confidence", cmpConfLimited: "Limited confidence", cmpConfLow: "Low confidence",
    cmpSubject: "Subject Property", cmpComps: "Sold Comparables", cmpSold: "Sold", cmpPerSqft: "/sq ft",
    cmpMatch: "match", cmpMap: "Comparable Map", cmpWithin: "within", cmpComp: "comps",
    cmpDisc: "Estimate based on recent comparable sales — not an appraisal.",
    cmpNone: "No comparable sales found nearby. Try another address.",
    cmpNew: "New search", cmpExcluded: "Outlier", cmpSqft: "sq ft",
    cmpStart: "Start with a property address. We'll find nearby sales and shape a market value.",
    locErr: "Couldn't get your location. Turn on GPS and allow access.",
    leads: "Leads", leadNew: "NEW", leadDone: "✓ Contacted", leadUndo: "Mark new",
    leadWhats: "WhatsApp", leadCall: "Call", leadEst: "Estimate",
    leadsEmpty: "Customers who ask for a price on your website land here.",
    leadsEmptySub: "When someone leaves their phone on your site, it shows up here instantly.",
    leadMsg: (n, a, who) => `Hi${n ? " " + n : ""} 👋 This is ${who}. I saw you asked for a roof price${a ? " at " + a : ""}. When can I stop by? It's free, no obligation.`,
    settings: "Settings", brandSection: "YOUR BRAND", saved: "Saved",
    bizSection: "MY BUSINESS", emailLbl: "Email", licenseLbl: "License # (optional)",
    pricesSection: "MY PRICES", pricesHint: "Your prices per square. Every new estimate uses them automatically.",
    paySection: "PAYMENTS", zelleLbl: "Zelle number", zelleHint: "Empty = we use your phone",
    acctSection: "MY ACCOUNT", changeTrade: "🔨 Change trade", logout: "Log out",
    logoutQ: "Log out? Your data stays saved in the cloud.",
    viewPdf: "📄 VIEW PDF / PRINT", brandHint: "Your logo appears on estimates, invoices, and the PDF your client receives.",
    accHigh: "✓ High accuracy · typically ±5%",
    accOld: "⚠️ Older imagery — verify before ordering",
    accMed: "⚠️ Medium quality — verify before ordering",
    accEst: "⚠️ Estimated from home size — verify",
    accTraced: "✏️ Measured by you on the photo",
    quickInvoice: "Quick invoice (spoken)", viSpeak: "Tap the mic and say: customer, job, and amount",
    viExample: "“Invoice for María García, roof repair, 450 dollars”",
    viHeard: "Heard", cust: "Customer", concept: "Description", amount: "Amount ($)",
    createInvoice: "CREATE INVOICE →", howToPay: "HOW TO PAY", payCash: "Cash or check accepted",
    linkCopied: "Link copied — paste it in a message", invMsg: "Invoice", estMsg: "Estimate", fromMsg: "from",
    logoOpt: "YOUR BUSINESS LOGO (OPTIONAL)", uploadLogo: "📷 Upload logo", removeLogo: "Remove",
    installHint: "Install the app: tap Share ⬆️ then “Add to Home Screen”",
    measureFence: "Measure fence", fenceTitle: "Draw fence",
    fenceHint: "Tap along the fence line · drag to move · +/− zoom",
    endRun: "✓ End line", totalLF: "Linear feet", panels: "Panels (8 ft)",
    posts: "Posts", cornerPosts: "Corners", walkGate: "Walk gate", doubleGate: "Double gate",
    perLF: "Price per foot ($)", walkPrice: "Walk gate ($)", dblPrice: "Double gate ($)",
    markup: "Material markup (%)", cedar: "Cedar", vinyl: "Vinyl", chain: "Chain link", alum: "Aluminum", custom: "Custom",
    lineFence: "Fence", lineGates: "Gates", lineMarkup: "Material markup",
    fenceDrawn: "Fence measured",
    propLine: "Property line loaded — tap a side to remove or add it",
    noParcel: "No property line for this address — draw the fence on the photo",
  },
};

/* ─── Seed data ─── */
const seedCustomers = [
  { id: 1, name: "María Garza", phone: "(956) 555-0143", addr: "456 Oak Dr, Rio Grande City, TX" },
  { id: 2, name: "José Pérez", phone: "(956) 555-0188", addr: "210 Mesquite Ln, Roma, TX" },
  { id: 3, name: "Ana Ríos", phone: "(956) 555-0102", addr: "88 Palma St, La Grulla, TX" },
];
const seedJobs = [
  { id: 101, inv: 1040, custId: 1, title: { es: "Techo nuevo 24 sq, arquitectónico", en: "New roof 24 sq, architectural" }, amount: 8580, paidAmt: 2574, status: "accepted", days: 3, photos: 2, lines: [["lineRoof", 2970], ["accessories", 810], ["tearOffLine", 1200], ["labor", 3600]] },
  { id: 102, inv: 1038, custId: 2, title: { es: "Techo metálico 31 sq", en: "Metal roof 31 sq" }, amount: 14200, paidAmt: 14200, status: "paid", days: 0, photos: 6, lines: [["lineRoof", 8500], ["accessories", 1100], ["labor", 4600]] },
  { id: 103, inv: 1035, custId: 3, title: { es: "Reparación de goteras", en: "Leak repair" }, amount: 1150, paidAmt: 0, status: "done", days: 12, photos: 3, lines: [["labor", 1150]] },
];

const fmt = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

/* ─── Roof / property lookup (DEMO — simulated data; swap for Google Solar API + property data API) ─── */
const PITCH_FACTORS = { 3: 1.031, 4: 1.054, 5: 1.083, 6: 1.118, 7: 1.158, 8: 1.202, 9: 1.25, 10: 1.302, 12: 1.414 };
const MAT_PRICES = { three: 95, arch: 110, metal: 250, tile: 350 };
const FENCE_PRICES = { cedar: 28, vinyl: 38, chain: 18, alum: 45, custom: 30 };

const MOCK_PROPERTIES = [
  { addr: "456 Oak Dr, Rio Grande City, TX", roofArea: 2460, pitch: "6", stories: 1, beds: 3, baths: 2, sqft: 1850, year: 2004, segments: 4 },
  { addr: "210 Mesquite Ln, Roma, TX", roofArea: 3120, pitch: "4", stories: 1, beds: 4, baths: 2, sqft: 2400, year: 1998, segments: 6 },
  { addr: "88 Palma St, La Grulla, TX", roofArea: 1690, pitch: "5", stories: 1, beds: 2, baths: 1, sqft: 1240, year: 1987, segments: 2 },
  { addr: "1204 Cenizo Ct, Rio Grande City, TX", roofArea: 3890, pitch: "8", stories: 2, beds: 4, baths: 3, sqft: 2980, year: 2019, segments: 8 },
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
        soldDate: dt.toISOString().slice(0, 10), yearBuilt: subjYear + ((g % 20) - 10),
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
const WANT_ROOF = /[?&]demo=roof/.test(window.location.search);
const DEMO_ROOF = WANT_ROOF && !savedProfile.biz;

/* ─── Main App ─── */
export default function TradeTechPro() {
  const [lang, setLang] = useState(savedProfile.lang || "es");
  const t = TR[lang];
  const [screen, setScreen] = useState(WANT_ROOF ? "home" : "comps");
  const [trade, setTrade] = useState(savedProfile.trade || "roofing");
  const [userName, setUserName] = useState(savedProfile.name || (DEMO_ROOF ? "José" : ""));
  const [bizName, setBizName] = useState(savedProfile.biz || (DEMO_ROOF ? "Techos García (Demo)" : ""));
  const [userPhone, setUserPhone] = useState(savedProfile.phone || "");
  const [logo, setLogo] = useState(savedProfile.logo || null);
  const [bizEmail, setBizEmail] = useState(savedProfile.email || "");
  const [license, setLicense] = useState(savedProfile.license || "");
  const [zelle, setZelle] = useState(savedProfile.zelle || "");
  const [myPrices, setMyPrices] = useState(savedProfile.prices || {});
  const logoIdRef = useRef(null); // server id for the currently uploaded logo

  // contractor's saved price beats the default
  const priceOf = (k) => (myPrices[k] != null && myPrices[k] !== "" ? Number(myPrices[k]) : MAT_PRICES[k]);
  const zelleNum = zelle || userPhone;

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
  const [activeJobId, setActiveJobId] = useState(null);
  const [toast, setToast] = useState(null);
  const [pendingEstimate, setPendingEstimate] = useState(null);
  const [newCust, setNewCust] = useState(null);

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
        if (!WANT_ROOF) setScreen("comps");
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

  /* ── Leads from the website widget ── */
  const [leads, setLeads] = useState([]);
  const fetchLeads = async () => {
    if (!session) return;
    try {
      const r = await api("/api/leads");
      if (r.ok) setLeads((await r.json()).leads || []);
    } catch { /* offline */ }
  };
  // refresh when the account loads, when looking at home/leads, and every minute on those screens
  useEffect(() => {
    if (!session || !cloudReady) return;
    if (screen !== "home" && screen !== "leads") return;
    fetchLeads();
    const id = setInterval(fetchLeads, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, cloudReady, screen]);
  const newLeadCount = leads.filter((l) => l.status === "new").length;

  const markLead = (id, status) => {
    setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, status } : l)));
    api(`/api/leads/${id}`, { method: "POST", body: JSON.stringify({ status }) }).catch(() => { /* retried implicitly on next fetch */ });
  };

  // calculator state
  const [L, setL] = useState("30"), [W, setW] = useState("20"), [TH, setTH] = useState("4"), [waste, setWaste] = useState("10");
  const [ppy, setPpy] = useState("160"), [laborRate, setLaborRate] = useState("2.50");

  // roofing calculator state
  const [fp, setFp] = useState("1800"), [stories, setStories] = useState("1"), [pitch, setPitch] = useState("6");
  const [roofMat, setRoofMat] = useState("arch"), [tearOff, setTearOff] = useState(true), [layers, setLayers] = useState("1");
  const [matSq, setMatSq] = useState(String(savedProfile.prices?.arch ?? 110)),
    [labSq, setLabSq] = useState(String(savedProfile.prices?.labor ?? 150)),
    [tearSq, setTearSq] = useState(String(savedProfile.prices?.tear ?? 50));

  // address lookup state (demo data for now)
  const [addrQ, setAddrQ] = useState("");
  const [measuring, setMeasuring] = useState(false);
  const [measurePhase, setMeasurePhase] = useState(0);
  const [lookup, setLookup] = useState(null);
  const [mSq, setMSq] = useState("");
  const [placeSugs, setPlaceSugs] = useState(null); // null = use built-in list
  const placesSeq = useRef(0);

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

  // voice invoice draft
  const [viHeard, setViHeard] = useState("");
  const [viName, setViName] = useState("");
  const [viConcept, setViConcept] = useState("");
  const [viAmount, setViAmount] = useState("");
  const [viBusy, setViBusy] = useState(false);

  const viParse = async (text) => {
    setViHeard(text);
    setViBusy(true);
    let p = null;
    try {
      const r = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, lang }),
      });
      if (r.ok) p = await r.json();
    } catch { /* backend unreachable */ }
    if (!p) {
      // offline fallback: biggest number = amount, "para X" = name
      const nums = [...text.matchAll(/\$?\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map(m => parseFloat(m[1].replace(/,/g, "")));
      const nm = text.match(/(?:para|for)\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ'-]*(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ'-]*){0,2})/i);
      p = { name: nm ? nm[1].trim() : "", concept: text.trim(), amount: nums.length ? Math.max(...nums) : null };
    }
    setViName(p.name || "");
    setViConcept(p.concept || text);
    setViAmount(p.amount != null ? String(p.amount) : "");
    setViBusy(false);
  };

  const viCreate = () => {
    const amount = Math.round(parseFloat(viAmount) || 0);
    if (!amount || !viConcept.trim()) return;
    let cust = customers.find(c => c.name.toLowerCase() === viName.trim().toLowerCase());
    if (!cust) {
      cust = { id: Date.now() + 1, name: viName.trim() || "—", phone: "", addr: "" };
      setCustomers([...customers, cust]);
    }
    const id = Date.now();
    const concept = viConcept.trim();
    const job = {
      id, inv: 1040 + jobs.length + 1, custId: cust.id, title: { es: concept, en: concept },
      amount, paidAmt: 0, status: "done", days: 0, photos: 0, lines: [[concept, amount]],
      addr: "", meas: null,
    };
    setJobs([job, ...jobs]);
    setActiveJobId(id);
    setScreen("invoice");
    showToast(t.estCreated + " ✓");
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

  /* ── Sharing: everything travels inside the link, no server storage ── */
  const buildShareUrl = (job, kind, lgId) => {
    const c = custOf(job);
    const labelOf = (k) => (k === "labor" ? t.labor : t[k] || k);
    const payload = {
      lg: lgId || undefined,
      k: kind, inv: job.inv, biz: bizName || "South Texas Roofing", ph: userPhone,
      cn: c.name, ca: job.addr || c.addr || "", ti: job.title[lang],
      li: job.lines.map(([k, v]) => [labelOf(k), v]),
      tot: job.amount, dep: job.paidAmt, paid: job.status === "paid",
      lang, zelle: zelleNum || "", lic: license || undefined, em: bizEmail || undefined,
      m: job.meas ? { la: job.meas.lat, ln: job.meas.lng, bb: job.meas.bbox, o: job.meas.outline, l: job.meas.lines } : null,
      ms: job.meas && job.meas.roofArea ? { ra: job.meas.roofArea, pi: job.meas.pitch, sq: job.meas.squares, id: job.meas.imageryDate } : null,
      dt: new Date().toLocaleDateString(lang === "es" ? "es-MX" : "en-US"),
    };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${window.location.origin}/i?d=${b64}`;
  };

  const shareDoc = async (job, kind) => {
    const c = custOf(job);
    const url = buildShareUrl(job, kind, await ensureLogoId());
    const msg = `${kind === "inv" ? t.invMsg : t.estMsg} #${job.inv} ${t.fromMsg} ${bizName || "ALTO Pro"}: ${url}`;
    if (navigator.share) {
      try { await navigator.share({ text: msg }); showToast(`${t.sentTo} ${c.name} 📱`); } catch { /* user closed the share sheet */ }
      return;
    }
    try { await navigator.clipboard.writeText(msg); showToast("🔗 " + t.linkCopied); } catch { /* ignore */ }
    const num = (c.phone || "").replace(/[^\d+]/g, "");
    window.location.href = `sms:${num}?&body=${encodeURIComponent(msg)}`;
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

  const [aiMsgs, setAiMsgs] = useState([]);
  const [aiInput, setAiInput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2400); };

  const calc = useMemo(() => {
    const l = parseFloat(L) || 0, w = parseFloat(W) || 0, th = parseFloat(TH) || 0, ws = parseFloat(waste) || 0;
    const yards = (l * w * (th / 12)) / 27;
    const withWaste = yards * (1 + ws / 100);
    const orderY = Math.ceil(withWaste * 2) / 2;
    const trucks = Math.max(1, Math.ceil(orderY / 10));
    const mat = orderY * (parseFloat(ppy) || 0);
    const lab = l * w * (parseFloat(laborRate) || 0);
    return { yards, withWaste, orderY, trucks, mat, lab, total: mat + lab, sqft: l * w };
  }, [L, W, TH, waste, ppy, laborRate]);

  const owed = jobs.filter(j => j.status !== "paid" && j.status !== "estimate").reduce((s, j) => s + (j.amount - j.paidAmt), 0);
  const activeJob = jobs.find(j => j.id === activeJobId);
  const custOf = (j) => customers.find(c => c.id === j.custId) || {};

  const createEstimate = (custId) => {
    const p = pendingEstimate || {
      title: lang === "es" ? `Losa ${L}×${W}, ${TH}″` : `Slab ${L}×${W}, ${TH}″`,
      lines: [["lineSlab", Math.round(calc.mat)], ["labor", Math.round(calc.lab)]],
      total: Math.round(calc.total),
    };
    const id = Date.now();
    const job = {
      id, inv: 1040 + jobs.length + 1, custId, title: { es: p.title, en: p.title },
      amount: p.total, paidAmt: 0, status: "estimate", days: 0, photos: 0, lines: p.lines,
      addr: p.addr || "", meas: p.meas || null,
    };
    setJobs([job, ...jobs]);
    setActiveJobId(id);
    setPendingEstimate(null);
    setScreen("send");
    showToast(t.estCreated + " ✓");
  };

  const startLookup = async (addr, placeId = null, gps = null) => {
    // Demo mode gets 6 measurements TOTAL (not per day) — a taste, not a tool.
    // The counter lives next to the demo data itself, so wiping it to cheat
    // also wipes everything the freeloader saved.
    if (!session) {
      let used = 0;
      try { used = parseInt(localStorage.getItem("alto_demo_meas") || "0", 10) || 0; } catch { /* private mode */ }
      if (used >= 6) { showToast("🔒 " + t.demoLimit); return; }
    }
    setAddrQ(addr);
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
        res = j.found ? {
          addr: j.addr || addr, lat: j.lat ?? null, lng: j.lng ?? null,
          parcel: j.parcel || null, // fence flow still uses the parcel boundary
          value: j.value ?? null,
          low: j.valueRange?.low ?? null, high: j.valueRange?.high ?? null,
          confidence: j.confidence || null, method: j.method || null,
          avgPpsf: j.avgPpsf ?? null, compsUsed: j.compsUsed ?? null,
          radius: j.radius ?? null, lookbackLabel: j.lookbackLabel || null,
          subject: j.subject ? {
            address: j.subject.address || j.addr || addr,
            beds: j.subject.bedrooms ?? null, baths: j.subject.bathrooms ?? null,
            sqft: j.subject.squareFootage ?? null, yearBuilt: j.subject.yearBuilt ?? null,
            latitude: j.subject.latitude ?? null, longitude: j.subject.longitude ?? null,
          } : null,
          comps: Array.isArray(j.comps) ? j.comps : [],
          source: j.source || "live",
        } : null;
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
    if (!res || !res.value) {
      // Found the place but the market was too thin to value, or nothing found.
      setLookup(null);
      setScreen("comps");
      showToast("🏠 " + t.cmpNone);
      return;
    }
    setLookup(res);
    setLendPrice(null); // lending follows the new comp value until the user overrides
    recordWork(res);
    setScreen("comps");
    showToast("🏠 " + t.cmpDone + " ✓");
  };

  const askAI = async (q) => {
    if (!q.trim() || aiBusy) return;
    const userMsg = { role: "user", content: q };
    const history = [...aiMsgs, userMsg];
    setAiMsgs(history);
    setAiInput("");
    setAiBusy(true);
    try {
      const data = {
        jobs: jobs.map(j => ({ customer: custOf(j).name, title: j.title[lang], total: j.amount, paid: j.paidAmt, status: j.status, daysOutstanding: j.days })),
      };
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, lang, trade, bizName, data }),
      });
      const out = await res.json();
      const text = out.text || TR[lang].aiErr;
      setAiMsgs([...history, { role: "assistant", content: text }]);
    } catch {
      setAiMsgs([...history, { role: "assistant", content: TR[lang].aiErr }]);
    }
    setAiBusy(false);
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
  const Onboard = () => (
    <div className="flex flex-col items-center justify-center flex-1 px-6 text-center"
      style={{ background: "linear-gradient(180deg, #FFFFFF 0%, #EFF2F7 100%)" }}>
      <img src="/brand-logo.png" alt="ALTO Pro" style={{ maxWidth: 240, margin: "0 auto 6px" }} onError={(e) => { e.currentTarget.style.display = "none"; }} />
      <p className="mb-7 font-semibold" style={{ color: C.slate, fontSize: 15 }}>{t.welcome1} <span style={{ color: C.orange }}>{t.welcome2}</span></p>
      <div className="w-full text-left rounded-3xl px-5 pt-5 pb-3"
        style={{ background: "#fff", boxShadow: "0 14px 40px rgba(16,27,48,.09)", border: "1px solid #EDF0F4" }}>
        <Field label={t.yourName} value={userName} onChange={setUserName} placeholder="Rolando" />
        <Field label={t.bizName} value={bizName} onChange={setBizName} placeholder="South Texas Roofing" />
        <Field label={t.phone} value={userPhone} onChange={setUserPhone} placeholder="(956) 555-0100" type="tel" />
      </div>
      <div className="w-full mt-5">
        <Btn style={{ boxShadow: "0 10px 24px rgba(248,180,8,.38)", letterSpacing: "0.1em" }}
          onClick={() => { saveProfile({ name: userName, biz: bizName, phone: userPhone, lang }); setScreen("trade"); }}>{t.continue}</Btn>
      </div>
      <div className="w-full mt-4 rounded-2xl px-4 py-3 text-center" style={{ background: "#fff", border: `1.5px dashed ${C.line}` }}>
        <p className="text-sm font-bold" style={{ color: C.navy }}>{t.alreadyClient}</p>
        <p className="text-xs font-semibold mt-1" style={{ color: C.slate }}>{t.alreadyClientHint}</p>
      </div>
      <div className="mt-6"><LangToggle /></div>
      <p className="mt-6 text-xs font-semibold" style={{ color: "#A9B1C2", letterSpacing: "0.22em" }}>{t.madeFor}</p>
    </div>
  );

  const Settings = () => {
    const setPrice = (k, v) => {
      const next = { ...myPrices, [k]: v };
      setMyPrices(next);
      saveProfile({ prices: next });
    };
    const matLabel = { three: t.shingle3, arch: t.archShingle, metal: t.metalRoof, tile: t.tileRoof };
    return (
      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
          <p className="text-xs font-bold tracking-widest mb-2" style={{ color: C.orange }}>{t.bizSection}</p>
          <Field label={t.yourName} value={userName} onChange={setUserName} placeholder="Rolando" />
          <Field label={t.bizName} value={bizName} onChange={setBizName} placeholder="South Texas Roofing" />
          <Field label={t.phone} value={userPhone} onChange={setUserPhone} placeholder="(956) 555-0100" type="tel" />
          <Field label={t.emailLbl} value={bizEmail} onChange={setBizEmail} placeholder="garza@roofing.com" />
          <Field label={t.licenseLbl} value={license} onChange={setLicense} placeholder="RCAT-12345" />
        </div>
        <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
          <p className="text-xs font-bold tracking-widest mb-1" style={{ color: C.orange }}>{t.brandSection}</p>
          <p className="text-xs mb-3" style={{ color: C.slate }}>{t.brandHint}</p>
          <div className="flex items-center gap-3">
            {logo && <img src={logo} alt="" className="rounded-lg" style={{ maxHeight: 52, maxWidth: 150, background: "#fff", border: `1.5px solid ${C.line}`, padding: 3 }} />}
            <label className="rounded-xl px-4 py-3 text-sm font-bold cursor-pointer" style={{ background: "#fff", border: `1.5px dashed ${C.orange}`, color: C.orange }}>
              {logo ? "📷" : t.uploadLogo}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => onLogoFile(e.target.files?.[0])} />
            </label>
            {logo && (
              <button onClick={() => { setLogo(null); logoIdRef.current = null; saveProfile({ logo: null }); }}
                className="text-sm font-bold" style={{ background: "none", border: "none", color: C.slate }}>✕ {t.removeLogo}</button>
            )}
          </div>
        </div>
        <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
          <p className="text-xs font-bold tracking-widest mb-1" style={{ color: C.orange }}>{t.pricesSection}</p>
          <p className="text-xs mb-3" style={{ color: C.slate }}>{t.pricesHint}</p>
          <div className="grid grid-cols-2 gap-x-3">
            {Object.keys(MAT_PRICES).map(k => (
              <Field key={k} label={matLabel[k] + " ($/sq)"} value={myPrices[k] ?? ""} onChange={(v) => setPrice(k, v)}
                type="number" placeholder={String(MAT_PRICES[k])} />
            ))}
            <Field label={t.laborPerSq} value={myPrices.labor ?? ""} onChange={(v) => setPrice("labor", v)} type="number" placeholder="150" />
            <Field label={t.tearPerSq} value={myPrices.tear ?? ""} onChange={(v) => setPrice("tear", v)} type="number" placeholder="50" />
          </div>
        </div>
        <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
          <p className="text-xs font-bold tracking-widest mb-2" style={{ color: C.orange }}>{t.paySection}</p>
          <Field label={t.zelleLbl} value={zelle} onChange={setZelle} placeholder={userPhone || "(956) 555-0100"} type="tel" />
          <p className="text-xs -mt-1 mb-1" style={{ color: C.slate }}>{t.zelleHint}</p>
        </div>
        <div className="rounded-2xl p-4 mb-4" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
          <p className="text-xs font-bold tracking-widest mb-2" style={{ color: C.orange }}>{t.acctSection}</p>
          <div className="flex items-center justify-between py-2">
            <span className="text-sm font-bold" style={{ color: C.navy }}>{t.changeTrade}</span>
            <button onClick={() => setScreen("trade")} className="rounded-xl px-4 py-2 text-sm font-bold" style={{ background: C.bg, color: C.navy, border: "none" }}>→</button>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-sm font-bold" style={{ color: C.navy }}>Idioma / Language</span>
            <LangToggle />
          </div>
          {session && (
            <div className="flex items-center justify-between py-2">
              <span className="text-sm font-bold" style={{ color: C.red }}>{t.logout}</span>
              <button onClick={() => {
                if (!window.confirm(t.logoutQ)) return;
                try { localStorage.removeItem("alto_session"); localStorage.removeItem("ttp_profile"); } catch { /* ignore */ }
                window.location.reload();
              }} className="rounded-xl px-4 py-2 text-sm font-bold" style={{ background: C.redSoft, color: C.red, border: "none" }}>→</button>
            </div>
          )}
          <p className="text-xs mt-2" style={{ color: "#A9B1C2" }}>ALTO Pro · v1.0</p>
        </div>
        <Btn onClick={() => {
          saveProfile({ name: userName, biz: bizName, phone: userPhone, lang, email: bizEmail, license, zelle, prices: myPrices });
          setMatSq(String(priceOf(roofMat)));
          if (myPrices.labor != null && myPrices.labor !== "") setLabSq(String(myPrices.labor));
          if (myPrices.tear != null && myPrices.tear !== "") setTearSq(String(myPrices.tear));
          setScreen("home");
          showToast(t.saved + " ✓");
        }}>{t.save}</Btn>
      </div>
    );
  };

  const TradePicker = () => {
    const trades = [
      ["roofing", "🏠", t.roofing, true], ["concrete", "🏗️", t.concrete, true],
      ["fence", "🪵", t.fence, true], ["pressure", "💦", t.pressure, false],
      ["landscaping", "🌿", t.landscaping, false], ["painting", "🎨", t.painting, false],
      ["plumbing", "🔧", t.plumbing, false], ["electric", "⚡", t.electric, false],
    ];
    return (
      <div className="flex-1 px-5 pt-8">
        <div className="flex justify-center mb-3"><Logo size={56} /></div>
        <h2 className="text-center font-extrabold mb-6" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 30 }}>{t.whichTrade}</h2>
        <div className="grid grid-cols-2 gap-3">
          {trades.map(([key, icon, label, active]) => (
            <button key={key} onClick={() => { if (active) { setTrade(key); saveProfile({ trade: key }); setScreen("home"); } }}
              className="rounded-2xl p-5 flex flex-col items-center gap-2 active:scale-95 transition-transform"
              style={{ background: "#fff", border: active ? `2px solid ${C.orange}` : `1.5px solid ${C.line}`, opacity: active ? 1 : 0.55 }}>
              <span className="text-4xl">{icon}</span>
              <span className="font-bold" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 19 }}>{label}</span>
              {!active && <span className="text-xs font-semibold" style={{ color: C.slate }}>{t.soon}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  };

  const Home = () => (
    <div className="flex-1 flex flex-col">
      <div className="px-5 pt-5 pb-4" style={{ background: C.navy }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Logo size={34} color="#fff" />
            <span className="font-extrabold" style={{ fontFamily: "'Inter', sans-serif", fontSize: 21, letterSpacing: 1 }}><span className="text-white">QUICK</span> <span style={{ color: C.orange }}>COMP</span></span>
          </div>
          <div className="flex items-center gap-2">
            <LangToggle onDark />
            <button onClick={() => setScreen("settings")} className="text-lg" style={{ background: "none", border: "none", opacity: 0.8 }}>⚙️</button>
          </div>
        </div>
        <p className="text-white font-bold text-2xl" style={{ fontFamily: "'Inter', sans-serif", fontSize: 28 }}>{t.hello}, {userName || "Rolando"} 👋</p>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold" style={{ color: "#9DA8C4" }}>
            {t.theyOwe}: <span style={{ color: C.orange }}>{fmt(owed)}</span> · {jobs.filter(j => j.status !== "paid").length} {t.jobs.toLowerCase()}
          </p>
          <button onClick={() => setScreen("trade")} className="text-xs font-bold rounded-full px-3 py-1"
            style={{ background: "rgba(248,180,8,.15)", color: C.orange, border: `1px solid ${C.orange}` }}>
            {trade === "roofing" ? "🏠 " + t.roofing : trade === "fence" ? "🪵 " + t.fence : "🏗️ " + t.concrete}
          </button>
        </div>
      </div>
      {(trade === "roofing" || trade === "fence") && (
        <div className="px-5 pt-4">
          <button onClick={() => { setAddrQ(""); setPlaceSugs(null); setLookup(null); setScreen("comps"); }}
            className="w-full rounded-2xl flex items-center gap-3 px-4 py-4 active:scale-95 transition-transform"
            style={{ background: "#fff", border: `2px solid ${C.orange}`, boxShadow: "0 4px 14px rgba(248,180,8,.18)" }}>
            <span className="text-2xl">🛰️</span>
            <span className="text-left">
              <span className="block font-extrabold" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 20 }}>{trade === "fence" ? t.measureFence : t.measureTitle}</span>
              <span className="block text-sm font-semibold" style={{ color: C.slate }}>{t.searchAddress}</span>
            </span>
            <span className="ml-auto text-xl" style={{ color: C.orange }}>→</span>
          </button>
        </div>
      )}
      {session && (
        <div className="px-5 pt-3">
          <button onClick={() => setScreen("leads")}
            className="w-full rounded-2xl flex items-center gap-3 px-4 py-4 active:scale-95 transition-transform"
            style={{ background: newLeadCount > 0 ? C.navy : "#fff", border: newLeadCount > 0 ? "none" : `1.5px solid ${C.line}`, boxShadow: newLeadCount > 0 ? "0 6px 16px rgba(16,27,48,.3)" : "none" }}>
            <span className="text-2xl">📥</span>
            <span className="font-extrabold" style={{ color: newLeadCount > 0 ? "#fff" : C.navy, fontFamily: "'Inter', sans-serif", fontSize: 20 }}>{t.leads}</span>
            {newLeadCount > 0 && (
              <span className="ml-auto rounded-full px-3 py-1 text-sm font-extrabold" style={{ background: C.orange, color: "#fff" }}>{newLeadCount} {t.leadNew}</span>
            )}
            {newLeadCount === 0 && <span className="ml-auto text-xl" style={{ color: C.slate }}>→</span>}
          </button>
        </div>
      )}
      <div className="px-5 pt-5 grid grid-cols-2 gap-3">
        {[
          ["➕", t.newEstimate, () => { if (trade === "roofing" || trade === "fence") { setAddrQ(""); setPlaceSugs(null); setLookup(null); setScreen("comps"); } else setScreen("calc"); }, C.orange, "#fff"],
          ["🧮", t.calculator, () => setScreen("calc"), "#fff", C.navy],
          ["🔨", t.jobs.toUpperCase(), () => setScreen("jobs"), "#fff", C.navy],
          ["💵", t.payments, () => setScreen("payments"), "#fff", C.navy],
        ].map(([icon, label, fn, bg, fg], i) => (
          <button key={i} onClick={fn} className="rounded-2xl flex flex-col items-center justify-center gap-2 active:scale-95 transition-transform"
            style={{ background: bg, color: fg, height: 110, border: bg === "#fff" ? `1.5px solid ${C.line}` : "none", boxShadow: bg !== "#fff" ? "0 6px 16px rgba(248,180,8,.35)" : "none" }}>
            <span className="text-3xl">{icon}</span>
            <span className="font-extrabold tracking-wide" style={{ fontFamily: "'Inter', sans-serif", fontSize: 18 }}>{label}</span>
          </button>
        ))}
      </div>
      {showInstallHint && (
        <div className="px-5 pt-3">
          <div className="rounded-2xl px-4 py-3 flex items-center gap-2" style={{ background: C.orangeSoft, border: `1.5px solid ${C.orange}` }}>
            <span className="text-xl">📲</span>
            <span className="flex-1 text-xs font-bold" style={{ color: C.navy }}>{t.installHint}</span>
            <button onClick={() => { setHideInstall(true); try { localStorage.setItem("alto_inst", "1"); } catch { /* ignore */ } }}
              className="text-sm font-bold" style={{ background: "none", border: "none", color: C.slate }}>✕</button>
          </div>
        </div>
      )}
      <div className="px-5 mt-4 grid gap-3">
        <button onClick={() => { setViHeard(""); setViName(""); setViConcept(""); setViAmount(""); setScreen("voiceInvoice"); }}
          className="w-full rounded-2xl flex items-center gap-3 px-4 py-4 active:scale-95 transition-transform"
          style={{ background: "#fff", border: `1.5px dashed ${C.orange}` }}>
          <span className="text-2xl">🎤</span>
          <span className="font-bold" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 19 }}>{t.quickInvoice}</span>
        </button>
        <button onClick={() => setScreen("ai")} className="w-full rounded-2xl flex items-center gap-3 px-4 py-4 active:scale-95 transition-transform"
          style={{ background: "#fff", border: `1.5px dashed ${C.orange}` }}>
          <span className="text-2xl">🎙️</span>
          <span className="font-bold" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 19 }}>{t.askTTP}</span>
          <span className="ml-auto text-sm font-semibold" style={{ color: C.orange }}>AI</span>
        </button>
      </div>
    </div>
  );

  const Calc = () => (
    <div className="flex-1 overflow-y-auto px-5 pb-6">
      <div className="rounded-2xl p-4 mb-4" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
        <div className="grid grid-cols-2 gap-x-3">
          <Field label={t.length} value={L} onChange={setL} type="number" />
          <Field label={t.width} value={W} onChange={setW} type="number" />
          <Field label={t.thickness} value={TH} onChange={setTH} type="number" />
          <Field label={t.waste} value={waste} onChange={setWaste} type="number" suffix="%" />
        </div>
      </div>
      <div className="rounded-2xl p-4 mb-4" style={{ background: C.navy }}>
        <p className="text-xs font-bold tracking-widest mb-2" style={{ color: C.orange }}>{t.result}</p>
        {[[t.cubicYards, calc.yards.toFixed(2)], [t.withWaste, calc.withWaste.toFixed(2)], [t.order, calc.orderY + " yd³"], [t.trucks + " (10 yd³)", calc.trucks]].map(([k, v]) => (
          <div key={k} className="flex justify-between py-1">
            <span className="text-sm font-semibold" style={{ color: "#9DA8C4" }}>{k}</span>
            <span className="font-extrabold text-white" style={{ fontFamily: "'Inter', sans-serif", fontSize: 20 }}>{v}</span>
          </div>
        ))}
      </div>
      <div className="rounded-2xl p-4 mb-4" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
        <p className="text-xs font-bold tracking-widest mb-2" style={{ color: C.slate }}>{t.optPrice}</p>
        <div className="grid grid-cols-2 gap-x-3">
          <Field label={t.pricePerYard} value={ppy} onChange={setPpy} type="number" />
          <Field label={t.laborSqFt} value={laborRate} onChange={setLaborRate} type="number" />
        </div>
        <div className="flex justify-between py-1"><span className="text-sm font-semibold" style={{ color: C.slate }}>{t.material} ({calc.orderY} yd³)</span><span className="font-bold" style={{ color: C.navy }}>{fmt(calc.mat)}</span></div>
        <div className="flex justify-between py-1"><span className="text-sm font-semibold" style={{ color: C.slate }}>{t.labor} ({calc.sqft} sq ft)</span><span className="font-bold" style={{ color: C.navy }}>{fmt(calc.lab)}</span></div>
        <div className="flex justify-between pt-2 mt-1" style={{ borderTop: `1.5px solid ${C.line}` }}>
          <span className="font-extrabold" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 20 }}>{t.estTotal}</span>
          <span className="font-extrabold" style={{ color: C.orange, fontFamily: "'Inter', sans-serif", fontSize: 24 }}>{fmt(calc.total)}</span>
        </div>
      </div>
      <Btn onClick={() => {
        setPendingEstimate({
          title: lang === "es" ? `Losa ${L}×${W}, ${TH}″` : `Slab ${L}×${W}, ${TH}″`,
          lines: [["lineSlab", Math.round(calc.mat)], ["labor", Math.round(calc.lab)]],
          total: Math.round(calc.total),
        });
        setScreen("pickCustomer");
      }}>{t.toEstimate}</Btn>
    </div>
  );

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

  const CompsResult = () => {
    const R = lookup;
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
              {R.lookbackLabel ? ` · ${R.lookbackLabel}` : ""}{R.avgPpsf ? ` · ${fmt(R.avgPpsf)}${t.cmpPerSqft}` : ""}.
            </p>
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
            const rankBg = i === 0 ? "linear-gradient(135deg,#FFD700,#FFA500)" : i === 1 ? "linear-gradient(135deg,#C0C0C0,#A0A0A0)" : i === 2 ? "linear-gradient(135deg,#CD7F32,#8B5A00)" : QC.bg;
            const rankTxt = i <= 2 ? QC.navy : QC.muted;
            const barColor = i === 0 ? QC.goldLine : i <= 2 ? QC.navy : QC.line;
            const belowMkt = c.soldPrice && c.soldPrice < R.value * 0.95;
            return (
              <div key={i} className="rounded-2xl p-4 mb-2.5" style={{ background: "#fff", border: i === 0 ? `2px solid ${QC.goldLine}` : `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)", opacity: out ? 0.55 : 1 }}>
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
                        <p style={{ color: QC.muted, fontSize: 10, fontWeight: 500, marginTop: 2 }}>{reasons[Math.min(i, 3)]} · {t.cmpSold} {soldDate(c.soldDate)}{c.distance != null ? ` · ${Number(c.distance).toFixed(2)} mi` : ""}</p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p style={{ color: i === 0 ? "#8A6A00" : QC.navyDeep, fontSize: 20, fontWeight: 800 }}>{fmt(c.soldPrice)}</p>
                      {ppsf && <p style={{ color: QC.muted, fontSize: 10, fontWeight: 500 }}>{fmt(ppsf)}{t.cmpPerSqft}</p>}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2.5">
                  {[c.sqft ? `${num(c.sqft)} ${t.cmpSqft}` : null, c.beds != null ? `${c.beds} ${t.beds}` : null, c.baths != null ? `${c.baths} ${t.baths}` : null, c.yearBuilt ? `${t.builtIn} ${c.yearBuilt}` : null].filter(Boolean).map((tag, k) => (
                    <span key={k} style={{ background: QC.bg, border: `1px solid ${QC.line}`, borderRadius: 8, padding: "4px 10px", fontSize: 11, fontWeight: 700, color: QC.body }}>{tag}</span>
                  ))}
                  {out
                    ? <span style={{ background: "#FBEAEA", border: "1px solid #f3c7c2", borderRadius: 6, padding: "3px 8px", fontSize: 9, fontWeight: 700, color: QC.red }}>{t.cmpExcluded}</span>
                    : i === 0
                      ? <span style={{ background: "#FFFBEA", border: "1px solid #ffe08a", borderRadius: 6, padding: "3px 8px", fontSize: 9, fontWeight: 700, color: "#8A6A00" }}>{lang === "es" ? "Comp más cercana" : "Closest Comp"}</span>
                      : belowMkt
                        ? <span style={{ background: "#EEF6FF", border: "1px solid #c0d4f0", borderRadius: 6, padding: "3px 8px", fontSize: 9, fontWeight: 700, color: QC.navy }}>{lang === "es" ? "Bajo el mercado" : "Below Market"}</span>
                        : null}
                </div>
                {c.matchScore != null && !out && (
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
    const r = lendRate / 100 / 12;
    const n = lendTerm * 12;
    const pi = r > 0 ? principal * r / (1 - Math.pow(1 + r, -n)) : principal / n;
    const taxMo = price * (lendTaxPct / 100) / 12;
    const insMo = lendInsYr / 12;
    const monthly = pi + taxMo + insMo;
    return (
      <div className="flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          <div className="rounded-2xl p-5 mb-3" style={{ background: QC.cardGrad, boxShadow: "0 18px 38px rgba(17,27,66,0.18)" }}>
            <p style={{ color: QC.goldHi, fontSize: 11, fontWeight: 900, letterSpacing: "0.16em", textTransform: "uppercase" }}>{lang === "es" ? "Pago mensual estimado" : "Monthly payment estimate"}</p>
            <p className="text-white" style={{ fontSize: 42, lineHeight: 1, fontWeight: 900, margin: "8px 0" }}>{m(monthly)}<span style={{ fontSize: 18, fontWeight: 700, color: "rgba(255,255,255,.7)" }}>/{lang === "es" ? "mes" : "mo"}</span></p>
            <p style={{ color: "rgba(255,255,255,0.76)", fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>
              {lang === "es" ? "Ajusta precio, enganche, tasa, impuestos y seguro para responder al instante." : "Slide price, down payment, rate, taxes, and insurance to answer buyer questions fast."}
            </p>
            <div className="flex gap-2 mt-3">
              {[["P&I", m(pi)], [lang === "es" ? "Impuesto" : "Tax", m(taxMo)], [lang === "es" ? "Seguro" : "Insurance", m(insMo)]].map(([l, v]) => (
                <div key={l} className="flex-1 rounded-xl text-center" style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.10)", padding: "8px 4px" }}>
                  <p className="text-white font-extrabold" style={{ fontSize: 13 }}>{v}</p>
                  <p style={{ color: QC.goldHi, fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginTop: 2 }}>{l}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl p-4" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 14 }}>{lang === "es" ? "Calculadora de financiamiento" : "Lending calculator"}</p>
            <Slider label={lang === "es" ? "Precio" : "Home price"} value={price} display={m(price)} min={50000} max={2000000} step={5000} onChange={setLendPrice} />
            <Slider label={lang === "es" ? "Enganche" : "Down payment"} value={lendDownPct} display={`${lendDownPct}% · ${m(down)}`} min={0} max={50} step={1} onChange={setLendDownPct} />
            <Slider label={lang === "es" ? "Tasa de interés" : "Interest rate"} value={lendRate} display={`${lendRate.toFixed(2)}%`} min={2} max={12} step={0.05} onChange={setLendRate} />
            <Slider label={lang === "es" ? "Plazo" : "Loan term"} value={lendTerm} display={`${lendTerm} ${lang === "es" ? "años" : "yr"}`} min={10} max={30} step={5} onChange={setLendTerm} />
            <Slider label={lang === "es" ? "Impuesto predial / año" : "Property tax / yr"} value={lendTaxPct} display={`${lendTaxPct.toFixed(2)}%`} min={0} max={3} step={0.05} onChange={setLendTaxPct} />
            <Slider label={lang === "es" ? "Seguro / año" : "Insurance / yr"} value={lendInsYr} display={m(lendInsYr)} min={0} max={6000} step={100} onChange={setLendInsYr} />
            {lookup?.value
              ? <p className="mt-1" style={{ color: QC.muted, fontSize: 11, fontWeight: 600 }}>{lang === "es" ? "Precio inicial tomado del valor de mercado estimado." : "Starting price taken from the estimated market value."}</p>
              : <p className="mt-1" style={{ color: QC.muted, fontSize: 11, fontWeight: 600 }}>{lang === "es" ? "Busca una propiedad para empezar con su valor de mercado." : "Search a property to start from its market value."}</p>}
          </div>
        </div>
      </div>
    );
  };

  /* ── 03 · TAX — tax snapshot ── */
  const Tax = () => {
    const subj = lookup?.subject || {};
    if (!lookup?.value) return <NeedProperty title={lang === "es" ? "Resumen de impuestos" : "Tax snapshot"} sub={lang === "es" ? "Busca una propiedad para ver dueño, valor catastral, año fiscal y datos clave." : "Search a property to see owner, assessed value, tax year, and key facts."} />;
    const num = (n) => Number(n).toLocaleString("en-US");
    const assessed = Math.round((lookup.value || 0) * 0.86);
    const annualTax = Math.round(assessed * 0.011);
    const facts = [["🛏️", subj.beds ?? "—", t.beds], ["🛁", subj.baths ?? "—", t.baths], ["📐", subj.sqft ? num(subj.sqft) : "—", t.cmpSqft], ["📅", subj.yearBuilt ?? "—", t.builtIn]];
    const rows = [
      [lang === "es" ? "Dueño registrado" : "Owner of record", subj.owner || (lang === "es" ? "Según registro público" : "Per public record")],
      [lang === "es" ? "Valor catastral" : "Assessed value", "$" + num(assessed)],
      [lang === "es" ? "Impuesto anual estimado" : "Est. annual tax", "$" + num(annualTax)],
      [lang === "es" ? "Año fiscal" : "Tax year", String(new Date().getFullYear())],
    ];
    return (
      <div className="flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 2px 8px rgba(27,42,92,0.06)" }}>
            <p style={{ color: QC.gold, fontSize: 10, fontWeight: 900, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 6 }}>{lang === "es" ? "Resumen de impuestos" : "Tax snapshot"}</p>
            <p className="font-extrabold mb-3" style={{ color: QC.navyDeep, fontSize: 16, lineHeight: 1.3 }}>{subj.address || lookup.addr}</p>
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
          <div className="flex items-center gap-2 rounded-xl px-3 py-2.5" style={{ background: QC.bg, border: `1px solid ${QC.line}` }}>
            <span style={{ color: QC.green }}>✓</span>
            <span style={{ color: QC.body, fontSize: 12, fontWeight: 600 }}>{lang === "es" ? "Resumen fiscal listo para el cliente" : "Client-ready tax summary available"}</span>
          </div>
          <p className="mt-3" style={{ color: "#66759D", fontSize: 11, fontWeight: 600, lineHeight: 1.5 }}>⚠️ {lang === "es" ? "Valores catastrales estimados — confirma con el condado." : "Assessed values are estimates — confirm with the county."}</p>
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
              className="w-full rounded-xl px-3.5 py-3 font-semibold outline-none" style={{ background: QC.bg, border: `1.5px solid ${QC.line}`, color: QC.navy, fontSize: 14 }} />
          </div>
        </div>
      </div>
    );
  };

  /* ── Client CMA report (printable / shareable PDF view) ── */
  const Report = () => {
    const R = lookup;
    if (!R || !R.value) return <NeedProperty title={lang === "es" ? "Informe del cliente" : "Client report"} sub={lang === "es" ? "Busca una propiedad para generar un informe con comparables y valor de mercado." : "Search a property to generate a report with comparables and a market value."} />;
    const subj = R.subject || {};
    const comps = (Array.isArray(R.comps) ? R.comps : []).filter((c) => !c.excludedAsOutlier).slice(0, 6);
    const n = R.compsUsed || comps.length;
    const hasRange = R.low != null && R.high != null;
    const narrative = lang === "es"
      ? `El conjunto de comparables respalda un valor de mercado cercano a ${fmt(R.value)}${hasRange ? `, dentro de un rango de ${fmt(R.low)}–${fmt(R.high)}` : ""}. El mayor respaldo proviene de ${n} ${n === 1 ? "venta cercana" : "ventas cercanas"} de tamaño y condición similares${R.avgPpsf ? `, con un promedio de ${fmt(R.avgPpsf)} por pie²` : ""}.`
      : `The comparable set supports an indicated market value near ${fmt(R.value)}${hasRange ? `, within a ${fmt(R.low)}–${fmt(R.high)} range` : ""}. The strongest support comes from ${n} nearby ${n === 1 ? "sale" : "sales"} of similar size and condition${R.avgPpsf ? `, averaging ${fmt(R.avgPpsf)} per square foot` : ""}.`;
    const share = async () => {
      const text = `${subj.address || R.addr} — ${fmt(R.value)}${hasRange ? ` (${fmt(R.low)}–${fmt(R.high)})` : ""}\n${narrative}`;
      try {
        if (navigator.share) await navigator.share({ title: "Quick Comp — CMA", text });
        else { await navigator.clipboard.writeText(text); showToast(lang === "es" ? "Copiado ✓" : "Copied ✓"); }
      } catch { /* user dismissed */ }
    };
    return (
      <div className="flex-1 overflow-y-auto pb-6" style={{ background: QC.bg }}>
        <div className="px-5 pt-4">
          {/* The report document */}
          <div id="qc-report" className="rounded-2xl overflow-hidden" style={{ background: "#fff", border: `1px solid ${QC.line}`, boxShadow: "0 18px 38px rgba(17,27,66,0.12)" }}>
            {/* Branded header band */}
            <div className="flex items-center justify-between gap-3 px-4 py-3.5" style={{ background: QC.headGrad }}>
              <div className="min-w-0">
                <p style={{ color: QC.goldHi, fontSize: 8, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase" }}>{lang === "es" ? "Presentado por" : "Presented by"}</p>
                <p className="text-white font-extrabold truncate" style={{ fontSize: 14 }}>{userName || (lang === "es" ? "Tu nombre" : "Your name")}</p>
                {bizName && <p className="truncate" style={{ color: "rgba(255,255,255,0.7)", fontSize: 11 }}>{bizName}</p>}
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

              <p className="mt-3" style={{ color: QC.muted, fontSize: 9.5, fontWeight: 600, lineHeight: 1.5 }}>⚠️ {t.cmpDisc}</p>
            </div>
          </div>

          {/* Actions (not printed) */}
          <div className="no-print flex gap-2 mt-3">
            <button onClick={() => window.print()} className="flex-1 active:translate-y-px transition-transform"
              style={{ background: QC.navy, color: "#fff", border: "none", borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 700 }}>🖨️ {lang === "es" ? "Imprimir" : "Print"}</button>
            <button onClick={share} className="flex-1 active:translate-y-px transition-transform"
              style={{ background: "#fff", color: QC.navy, border: `1.5px solid ${QC.line}`, borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 700 }}>📤 {lang === "es" ? "Compartir" : "Share"}</button>
          </div>
          <p className="no-print text-center mt-3" style={{ color: "#66759D", fontSize: 12, fontWeight: 600 }}>{lang === "es" ? "Comparte, imprime o guarda para después." : "Share, print, or save for later."}</p>
        </div>
      </div>
    );
  };

  const PickCustomer = () => (
    <div className="flex-1 px-5">
      <p className="font-extrabold mb-4" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 26 }}>{t.forWho}</p>
      {customers.map(c => (
        <button key={c.id} onClick={() => createEstimate(c.id)} className="w-full rounded-2xl p-4 mb-3 flex items-center gap-3 active:scale-95 transition-transform text-left"
          style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
          <span className="w-10 h-10 rounded-full flex items-center justify-center font-extrabold" style={{ background: C.orangeSoft, color: C.orange }}>{c.name[0]}</span>
          <span><span className="block font-bold" style={{ color: C.navy }}>{c.name}</span><span className="text-sm" style={{ color: C.slate }}>{c.phone}</span></span>
        </button>
      ))}
      {newCust === null ? (
        <button onClick={() => setNewCust({ name: "", phone: "" })} className="w-full rounded-2xl p-4 font-bold" style={{ background: "none", border: `2px dashed ${C.orange}`, color: C.orange }}>{t.addCustomer}</button>
      ) : (
        <div className="rounded-2xl p-4" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
          <Field label={t.name} value={newCust.name} onChange={(v) => setNewCust({ ...newCust, name: v })} />
          <Field label={t.phone} value={newCust.phone} onChange={(v) => setNewCust({ ...newCust, phone: v })} type="tel" />
          <Btn onClick={() => {
            const c = { id: Date.now(), name: newCust.name || "—", phone: newCust.phone, addr: "" };
            setCustomers([...customers, c]); setNewCust(null); createEstimate(c.id);
          }}>{t.save}</Btn>
        </div>
      )}
    </div>
  );

  const SendScreen = () => {
    if (!activeJob) return null;
    const c = custOf(activeJob);
    return (
      <div className="flex-1 px-5 flex flex-col">
        <div className="rounded-2xl p-5 text-center mb-4" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
          <Logo size={48} />
          <p className="font-extrabold mt-2" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 24 }}>{t.estimate} #{activeJob.inv} {t.ready} ✓</p>
          <p className="font-semibold" style={{ color: C.slate }}>{c.name}</p>
          <p className="font-extrabold mt-1" style={{ color: C.orange, fontFamily: "'Inter', sans-serif", fontSize: 32 }}>{fmt(activeJob.amount)}</p>
          <p className="text-sm" style={{ color: C.slate }}>{activeJob.title[lang]}{trade === "concrete" ? " · " + t.finish : ""}</p>
        </div>
        <div className="grid gap-3">
          <Btn onClick={() => shareDoc(activeJob, "est")}>{t.sendText}</Btn>
          <Btn color="#fff" textColor={C.navy} style={{ border: `1.5px solid ${C.line}` }}
            onClick={async () => window.open(buildShareUrl(activeJob, "est", await ensureLogoId()), "_blank")}>{t.viewPdf}</Btn>
          <Btn color={C.navy} onClick={() => {
            setJobs(jobs.map(j => j.id === activeJob.id ? { ...j, status: "accepted" } : j));
            setScreen("jobDetail");
            showToast(`${t.accepted} ✓`);
          }}>{t.simulateAccept}</Btn>
        </div>
      </div>
    );
  };

  const JobsList = () => (
    <div className="flex-1 overflow-y-auto px-5 pb-4">
      {jobs.length === 0 && <p className="text-center mt-10 font-semibold" style={{ color: C.slate }}>{t.noJobs}</p>}
      {jobs.map(j => {
        const c = custOf(j);
        const bal = j.amount - j.paidAmt;
        return (
          <button key={j.id} onClick={() => { setActiveJobId(j.id); setScreen("jobDetail"); }}
            className="w-full rounded-2xl p-4 mb-3 text-left active:scale-95 transition-transform" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
            <div className="flex items-center justify-between mb-1">
              <span className="font-bold" style={{ color: C.navy }}>{c.name}</span>
              <StatusPill status={j.status} t={t} />
            </div>
            <p className="text-sm font-semibold" style={{ color: C.slate }}>{j.title[lang]}</p>
            <div className="flex justify-between mt-1">
              <span className="font-extrabold" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 20 }}>{fmt(j.amount)}</span>
              {bal > 0 && j.status !== "estimate" && <span className="text-sm font-bold" style={{ color: j.days >= 7 ? C.red : C.yellow }}>{fmt(bal)} · {j.days}{t.daysShort}</span>}
            </div>
          </button>
        );
      })}
      <Btn onClick={() => setScreen("calc")}>{t.newJob}</Btn>
    </div>
  );

  const JobDetail = () => {
    if (!activeJob) return null;
    const c = custOf(activeJob);
    return (
      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
          <div className="flex items-center justify-between mb-1">
            <span className="font-extrabold" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 22 }}>{activeJob.title[lang]}</span>
            <StatusPill status={activeJob.status} t={t} />
          </div>
          <p className="font-semibold" style={{ color: C.slate }}>{c.name} · {c.phone}</p>
          <p className="text-sm" style={{ color: C.slate }}>{t.jobAddr}: {activeJob.addr || c.addr || "—"}</p>
        </div>
        <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
          <p className="text-xs font-bold tracking-widest mb-2" style={{ color: C.slate }}>{t.photos} ({activeJob.photos})</p>
          <div className="flex gap-2">
            {Array.from({ length: Math.min(activeJob.photos, 3) }).map((_, i) => (
              <div key={i} className="w-16 h-16 rounded-xl flex items-center justify-center text-2xl" style={{ background: C.bg }}>📷</div>
            ))}
            <button onClick={() => { setJobs(jobs.map(j => j.id === activeJob.id ? { ...j, photos: j.photos + 1 } : j)); showToast("📷 ✓"); }}
              className="w-16 h-16 rounded-xl flex items-center justify-center text-2xl font-bold" style={{ background: C.orangeSoft, color: C.orange, border: `2px dashed ${C.orange}` }}>+</button>
          </div>
        </div>
        <Btn onClick={() => setScreen("invoice")}>{activeJob.paidAmt > 0 || activeJob.status === "paid" ? t.invoice + ` #${activeJob.inv}` : t.genInvoice}</Btn>
      </div>
    );
  };

  const Invoice = () => {
    if (!activeJob) return null;
    const c = custOf(activeJob);
    const deposit = activeJob.paidAmt;
    const bal = activeJob.amount - deposit;
    const paid = activeJob.status === "paid";
    return (
      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="rounded-2xl overflow-hidden mb-4" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
          <div className="px-5 py-4 flex items-center justify-between" style={{ background: C.navy }}>
            <div>
              <p className="font-extrabold text-white" style={{ fontFamily: "'Inter', sans-serif", fontSize: 20 }}>{(bizName || "SOUTH TEXAS ROOFING").toUpperCase()}</p>
              <p className="text-xs font-semibold" style={{ color: "#9DA8C4" }}>{t.invoice} #{activeJob.inv} · 10 Jun 2026</p>
            </div>
            {logo
              ? <img src={logo} alt="" style={{ maxHeight: 40, maxWidth: 110, background: "#fff", borderRadius: 8, padding: 3 }} />
              : <Logo size={36} color="#fff" />}
          </div>
          <div className="px-5 py-3" style={{ borderBottom: `1px solid ${C.line}` }}>
            <p className="font-bold" style={{ color: C.navy }}>{c.name}</p>
            <p className="text-sm" style={{ color: C.slate }}>{activeJob.addr || c.addr || "—"}</p>
          </div>
          <div className="px-5 py-3" style={{ borderBottom: `1px solid ${C.line}` }}>
            {activeJob.lines.map(([k, v], i) => (
              <div key={i} className="flex justify-between py-1">
                <span className="text-sm font-semibold" style={{ color: C.slate }}>{k === "labor" ? t.labor : t[k] || k}</span>
                <span className="font-bold" style={{ color: C.navy }}>{fmt(v)}</span>
              </div>
            ))}
          </div>
          <div className="px-5 py-3">
            <div className="flex justify-between py-0.5"><span className="text-sm font-semibold" style={{ color: C.slate }}>{t.subtotal}</span><span className="font-bold" style={{ color: C.navy }}>{fmt(activeJob.amount)}</span></div>
            <div className="flex justify-between py-0.5"><span className="text-sm font-semibold" style={{ color: C.slate }}>{t.tax}</span><span className="font-bold" style={{ color: C.navy }}>$0</span></div>
            <div className="flex justify-between py-0.5"><span className="text-sm font-semibold" style={{ color: C.slate }}>{t.depositRec}</span><span className="font-bold" style={{ color: C.green }}>–{fmt(deposit)}</span></div>
            <div className="flex justify-between pt-2 mt-1" style={{ borderTop: `1.5px solid ${C.line}` }}>
              <span className="font-extrabold" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 20 }}>{t.balance}</span>
              <span className="font-extrabold" style={{ color: paid ? C.green : C.orange, fontFamily: "'Inter', sans-serif", fontSize: 24 }}>{paid ? "✓ " + t.paid : fmt(bal)}</span>
            </div>
          </div>
        </div>
        <div className="rounded-2xl p-4 mb-4" style={{ background: C.orangeSoft }}>
          <p className="text-xs font-bold tracking-widest mb-1" style={{ color: C.orange }}>{t.howToPay}</p>
          {zelleNum && <p className="text-sm font-semibold" style={{ color: C.navy }}>💜 Zelle: <b>{zelleNum}</b></p>}
          <p className="text-sm font-semibold" style={{ color: C.navy }}>💵 {t.payCash}</p>
        </div>
        {!paid && (
          <div className="grid gap-3">
            <Btn onClick={() => shareDoc(activeJob, "inv")}>{t.sendText}</Btn>
            <Btn color="#fff" textColor={C.navy} style={{ border: `1.5px solid ${C.line}` }}
              onClick={async () => window.open(buildShareUrl(activeJob, "inv", await ensureLogoId()), "_blank")}>{t.viewPdf}</Btn>
            <Btn color="#fff" textColor={C.navy} style={{ border: `1.5px solid ${C.line}` }} onClick={() => { setJobs(jobs.map(j => j.id === activeJob.id ? { ...j, status: "paid", paidAmt: j.amount, days: 0 } : j)); showToast(t.paidToast + " ✓"); }}>{t.markPaid}</Btn>
          </div>
        )}
      </div>
    );
  };

  const Payments = () => {
    const unpaid = jobs.filter(j => j.status !== "paid" && j.status !== "estimate" && j.amount - j.paidAmt > 0).sort((a, b) => b.days - a.days);
    return (
      <div className="flex-1 overflow-y-auto px-5 pb-4">
        <div className="rounded-2xl p-4 mb-4" style={{ background: C.navy }}>
          <p className="text-xs font-bold tracking-widest" style={{ color: "#9DA8C4" }}>{t.theyOwe.toUpperCase()}</p>
          <p className="font-extrabold text-white" style={{ fontFamily: "'Inter', sans-serif", fontSize: 36 }}>{fmt(owed)}</p>
        </div>
        {unpaid.map(j => {
          const c = custOf(j);
          const late = j.days >= 7;
          return (
            <div key={j.id} className="rounded-2xl p-4 mb-3 flex items-center gap-3" style={{ background: "#fff", border: `1.5px solid ${late ? C.red : C.line}` }}>
              <span className="text-xl">{late ? "🔴" : "⏳"}</span>
              <button className="flex-1 text-left" style={{ background: "none", border: "none", padding: 0 }} onClick={() => { setActiveJobId(j.id); setScreen("invoice"); }}>
                <span className="block font-bold" style={{ color: C.navy }}>{c.name}</span>
                <span className="text-sm font-semibold" style={{ color: late ? C.red : C.slate }}>{fmt(j.amount - j.paidAmt)} · {j.days}{t.daysShort} {late ? "· " + t.overdue : ""}</span>
              </button>
              <button onClick={() => showToast(`${t.reminderSent} ${c.name} 📱`)} className="rounded-xl px-4 py-2 font-bold text-sm" style={{ background: C.orangeSoft, color: C.orange, border: "none" }}>{t.remind}</button>
            </div>
          );
        })}
        {unpaid.length === 0 && <p className="text-center mt-8 font-semibold" style={{ color: C.green }}>✓ {t.paid} 🎉</p>}
      </div>
    );
  };

  const Customers = () => (
    <div className="flex-1 overflow-y-auto px-5 pb-4">
      {customers.map(c => {
        const cJobs = jobs.filter(j => j.custId === c.id);
        return (
          <div key={c.id} className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
            <div className="flex items-center gap-3 mb-2">
              <span className="w-10 h-10 rounded-full flex items-center justify-center font-extrabold" style={{ background: C.orangeSoft, color: C.orange }}>{c.name[0]}</span>
              <div className="flex-1">
                <p className="font-bold" style={{ color: C.navy }}>{c.name}</p>
                <p className="text-sm" style={{ color: C.slate }}>{c.phone}</p>
              </div>
              <button onClick={() => showToast("📞 " + c.name)} className="rounded-xl px-3 py-2 text-sm font-bold" style={{ background: C.bg, color: C.navy, border: "none" }}>{t.call}</button>
              <button onClick={() => showToast("💬 " + c.name)} className="rounded-xl px-3 py-2 text-sm font-bold" style={{ background: C.bg, color: C.navy, border: "none" }}>{t.text}</button>
            </div>
            {cJobs.length > 0 && (
              <p className="text-xs font-semibold" style={{ color: C.slate }}>{t.history}: {cJobs.map(j => `#${j.inv} ${fmt(j.amount)}`).join(" · ")}</p>
            )}
          </div>
        );
      })}
    </div>
  );

  const FenceDraw = () => {
    if (!fenceBase) return null;
    // Parcel boundary → chains of consecutive included edges count as fence runs
    const P = fenceBase.parcel, n = P ? P.length : 0;
    const chains = [];
    if (P) {
      if (fExcl.size === 0) chains.push([...P, P[0]]);
      else if (fExcl.size < n) {
        for (let s = 0; s < n; s++) {
          if (fExcl.has(s) || !fExcl.has((s - 1 + n) % n)) continue;
          const ch = [P[s]];
          let i = s;
          while (!fExcl.has(i)) { ch.push(P[(i + 1) % n]); i = (i + 1) % n; if (i === s) break; }
          chains.push(ch);
        }
      }
    }
    const allRuns = [...chains, ...fRuns, ...(fCur.length >= 2 ? [fCur] : [])];
    const runLF = (run) => run.slice(1).reduce((s, p, i) => s + distFt(run[i], p), 0);
    const totalLF = Math.round(allRuns.reduce((s, r) => s + runLF(r), 0));
    const panels = Math.ceil(totalLF / 8);
    const posts = allRuns.reduce((s, r) => s + Math.ceil(runLF(r) / 8) + 1, 0);
    const corners = allRuns.reduce((s, r) => s + Math.max(0, r.length - 2), 0);
    const lf$ = parseFloat(fLF) || 0;
    const fenceCost = Math.round(totalLF * lf$);
    const gatesCost = gWalk * (parseFloat(fWalkP) || 0) + gDbl * (parseFloat(fDblP) || 0);
    const mkAmt = Math.round((fenceCost + gatesCost) * ((parseFloat(fMk) || 0) / 100));
    const total = fenceCost + gatesCost + mkAmt;
    const typeLabel = { cedar: t.cedar, vinyl: t.vinyl, chain: t.chain, alum: t.alum, custom: t.custom };

    const onDown = (e) => {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      tracePtr.current = { x: e.clientX, y: e.clientY, moved: false };
    };
    const onMove = (e) => {
      if (!tracePtr.current) return;
      const dx = e.clientX - tracePtr.current.x, dy = e.clientY - tracePtr.current.y;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) tracePtr.current.moved = true;
      if (tracePtr.current.moved) setDragOff([dx, dy]);
    };
    const onUp = (e) => {
      const start = tracePtr.current;
      tracePtr.current = null;
      if (!start) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (start.moved) {
        const dxN = ((e.clientX - start.x) / rect.width) * TRACE_W, dyN = ((e.clientY - start.y) / rect.height) * TRACE_H;
        const [lat, lng] = pxToLl(TRACE_W / 2 - dxN, TRACE_H / 2 - dyN, fenceBase);
        setDragOff([0, 0]);
        setFenceBase({ ...fenceBase, lat, lng });
      } else {
        const x = ((e.clientX - rect.left) / rect.width) * TRACE_W, y = ((e.clientY - rect.top) / rect.height) * TRACE_H;
        // Tap near a property-line segment toggles it on/off; elsewhere draws
        if (P) {
          const dseg = (p, a, b) => {
            const dx = b[0] - a[0], dy = b[1] - a[1];
            if (!dx && !dy) return Math.hypot(p[0] - a[0], p[1] - a[1]);
            const tt = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
            return Math.hypot(p[0] - (a[0] + tt * dx), p[1] - (a[1] + tt * dy));
          };
          let best = -1, bestD = 60;
          for (let i = 0; i < n; i++) {
            const d = dseg([x, y], llToPx(P[i], fenceBase), llToPx(P[(i + 1) % n], fenceBase));
            if (d < bestD) { bestD = d; best = i; }
          }
          if (best >= 0) {
            const nx = new Set(fExcl);
            nx.has(best) ? nx.delete(best) : nx.add(best);
            setFExcl(nx);
            return;
          }
        }
        setFCur([...fCur, pxToLl(x, y, fenceBase)]);
      }
    };
    const zoomBy = (d) => {
      const z = Math.min(Math.max(fenceBase.zoom + d, 15), 21);
      if (z !== fenceBase.zoom) setFenceBase({ ...fenceBase, zoom: z });
    };
    const undo = () => {
      if (fCur.length) setFCur(fCur.slice(0, -1));
      else if (fRuns.length) { setFCur(fRuns[fRuns.length - 1]); setFRuns(fRuns.slice(0, -1)); }
    };
    const endRun = () => { if (fCur.length >= 2) { setFRuns([...fRuns, fCur]); setFCur([]); } };
    const proj = (pts) => pts.map(p => llToPx(p, fenceBase));
    const labels = (pts) => {
      const px = proj(pts), out = [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const ft = distFt(pts[i], pts[i + 1]);
        const [pa, pb] = [px[i], px[i + 1]];
        const sl = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
        if (ft < 3 || sl < 55) continue;
        const nx = -(pb[1] - pa[1]) / sl, ny = (pb[0] - pa[0]) / sl;
        out.push({ x: (pa[0] + pb[0]) / 2 + nx * 40, y: (pa[1] + pb[1]) / 2 + ny * 40 + 14, ft: Math.round(ft) });
      }
      return out;
    };
    const stepper = (v, set, label, icon) => (
      <div className="flex-1 rounded-2xl px-3 py-2 text-center" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
        <p className="text-xs font-bold" style={{ color: C.slate }}>{icon} {label}</p>
        <div className="flex items-center justify-center gap-3 mt-1">
          <button onClick={() => set(Math.max(0, v - 1))} className="w-9 h-9 rounded-full text-lg font-extrabold" style={{ background: C.bg, border: `1.5px solid ${C.line}`, color: C.navy }}>−</button>
          <span className="font-extrabold w-6" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 24 }}>{v}</span>
          <button onClick={() => set(v + 1)} className="w-9 h-9 rounded-full text-lg font-extrabold" style={{ background: C.bg, border: `1.5px solid ${C.line}`, color: C.navy }}>+</button>
        </div>
      </div>
    );
    return (
      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <p className="text-xs font-bold mb-2" style={{ color: C.navy }}>👆 {P ? t.propLine : t.fenceHint}</p>
        <div className="relative rounded-2xl overflow-hidden mb-3" style={{ aspectRatio: "1280/800", background: C.navyDeep, cursor: "crosshair", touchAction: "none" }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
          <div className="absolute inset-0" style={{ transform: `translate(${dragOff[0]}px, ${dragOff[1]}px)` }}>
            {!fNoImg && (
              <img src={`/api/roofimg?lat=${fenceBase.lat}&lng=${fenceBase.lng}&zoom=${fenceBase.zoom}`} alt=""
                className="absolute inset-0 w-full h-full" draggable={false} onError={() => setFNoImg(true)} />
            )}
            {fNoImg && <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold" style={{ color: "#9DA8C4", backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 19px, rgba(255,255,255,.08) 20px), repeating-linear-gradient(90deg, transparent, transparent 19px, rgba(255,255,255,.08) 20px)" }}>DEMO</div>}
            <svg viewBox={`0 0 ${TRACE_W} ${TRACE_H}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none" }}>
              {P && P.map((pt, i) => {
                const a = llToPx(pt, fenceBase), b = llToPx(P[(i + 1) % n], fenceBase);
                const ex = fExcl.has(i);
                return (
                  <g key={"pe" + i}>
                    {!ex && <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#fff" strokeWidth="9" strokeLinecap="round" opacity=".85" />}
                    <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
                      stroke={ex ? "rgba(255,255,255,.6)" : C.orange} strokeWidth={ex ? 3 : 5}
                      strokeDasharray={ex ? "8 14" : "none"} strokeLinecap="round" />
                  </g>
                );
              })}
              {P && P.map((pt, i) => {
                const a = llToPx(pt, fenceBase);
                return <circle key={"pv" + i} cx={a[0]} cy={a[1]} r="8" fill="#fff" stroke={C.orange} strokeWidth="3" />;
              })}
              {chains.map((ch, ci) => labels(ch).map((l, i) => (
                <text key={`c${ci}-${i}`} x={l.x} y={l.y} textAnchor="middle" fontSize="46" fontWeight="800" fill={C.navy}
                  stroke="#fff" strokeWidth="10" paintOrder="stroke" fontFamily="'Inter', sans-serif">{l.ft}′</text>
              )))}
              {[...fRuns, fCur].map((run, ri) => {
                const px = proj(run);
                const isCur = ri === fRuns.length;
                return (
                  <g key={ri}>
                    {px.length > 1 && <polyline points={px.map(p => `${p[0]},${p[1]}`).join(" ")} fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" opacity=".85" />}
                    {px.length > 1 && <polyline points={px.map(p => `${p[0]},${p[1]}`).join(" ")} fill="none" stroke={C.orange} strokeWidth="5" strokeLinecap="round" strokeDasharray={isCur ? "16 10" : "none"} />}
                    {px.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="9" fill="#fff" stroke={C.orange} strokeWidth="4" />)}
                    {labels(run).map((l, i) => (
                      <text key={"f" + i} x={l.x} y={l.y} textAnchor="middle" fontSize="46" fontWeight="800" fill={C.navy}
                        stroke="#fff" strokeWidth="10" paintOrder="stroke" fontFamily="'Inter', sans-serif">{l.ft}′</text>
                    ))}
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="absolute right-2 top-2 flex flex-col gap-1.5" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
            <button onClick={() => zoomBy(1)} className="w-11 h-11 rounded-full text-xl font-extrabold active:scale-90" style={{ background: "rgba(255,255,255,.92)", border: "none", color: C.navy, boxShadow: "0 2px 8px rgba(0,0,0,.3)" }}>+</button>
            <button onClick={() => zoomBy(-1)} className="w-11 h-11 rounded-full text-xl font-extrabold active:scale-90" style={{ background: "rgba(255,255,255,.92)", border: "none", color: C.navy, boxShadow: "0 2px 8px rgba(0,0,0,.3)" }}>−</button>
          </div>
        </div>
        <div className="flex gap-2 mb-3">
          <button onClick={undo} className="flex-1 rounded-xl py-2.5 text-sm font-bold" style={{ background: "#fff", border: `1.5px solid ${C.line}`, color: C.navy }}>{t.undo}</button>
          <button onClick={() => { setFRuns([]); setFCur([]); }} className="flex-1 rounded-xl py-2.5 text-sm font-bold" style={{ background: "#fff", border: `1.5px solid ${C.line}`, color: C.red }}>{t.clearAll}</button>
          <button onClick={endRun} disabled={fCur.length < 2}
            className="flex-1 rounded-xl py-2.5 text-sm font-bold" style={{ background: fCur.length >= 2 ? C.orangeSoft : "#fff", border: `1.5px solid ${fCur.length >= 2 ? C.orange : C.line}`, color: fCur.length >= 2 ? C.orange : C.slate }}>{t.endRun}</button>
        </div>
        <div className="rounded-2xl px-4 py-3 mb-3" style={{ background: C.navy }}>
          <div className="flex items-end justify-between">
            <span className="text-xs font-bold tracking-widest" style={{ color: "#9DA8C4" }}>{t.totalLF.toUpperCase()}</span>
            <span className="font-extrabold text-white" style={{ fontFamily: "'Inter', sans-serif", fontSize: 40 }}>{totalLF.toLocaleString()} ft</span>
          </div>
          <p className="text-xs font-semibold" style={{ color: "#9DA8C4" }}>{panels} {t.panels.toLowerCase()} · {posts} {t.posts.toLowerCase()} · {corners} {t.cornerPosts.toLowerCase()}</p>
        </div>
        <div className="flex gap-2 mb-3">
          {stepper(gWalk, setGWalk, t.walkGate, "🚪")}
          {stepper(gDbl, setGDbl, t.doubleGate, "🚛")}
        </div>
        <div className="grid grid-cols-5 gap-1.5 mb-3">
          {Object.keys(FENCE_PRICES).map(k => (
            <button key={k} onClick={() => { setFType(k); setFLF(String(FENCE_PRICES[k])); }}
              className="rounded-xl py-2.5 px-0.5 text-xs font-bold active:scale-95"
              style={{ background: fType === k ? C.orangeSoft : "#fff", border: fType === k ? `2px solid ${C.orange}` : `1.5px solid ${C.line}`, color: fType === k ? C.orange : C.navy }}>
              {typeLabel[k]}
            </button>
          ))}
        </div>
        <div className="rounded-2xl px-4 py-3 mb-3 flex items-center justify-between" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
          <span className="font-extrabold" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 20 }}>{t.estTotal}</span>
          <span className="font-extrabold" style={{ color: C.orange, fontFamily: "'Inter', sans-serif", fontSize: 28 }}>{fmt(total)}</span>
        </div>
        <Btn disabled={totalLF === 0} onClick={() => {
          const title = `${t.lineFence} ${typeLabel[fType]}, ${totalLF} ft`;
          const lines = [[`${t.lineFence} ${typeLabel[fType]} (${totalLF} ft × $${lf$})`, fenceCost]];
          if (gatesCost) lines.push([`${t.lineGates} (${gWalk + gDbl})`, gatesCost]);
          if (mkAmt) lines.push([t.lineMarkup + ` (${fMk}%)`, mkAmt]);
          setPendingEstimate({
            title, lines, total, addr: fenceBase.addr || "",
            meas: { lat: fenceBase.lat, lng: fenceBase.lng, bbox: null, lines: allRuns.map(r => r.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)])) },
          });
          setScreen("pickCustomer");
        }}>{t.toEstimate}</Btn>
        <button onClick={() => setShowDetails(!showDetails)} className="w-full py-3 text-sm font-bold" style={{ background: "none", border: "none", color: C.slate }}>{showDetails ? "▴ " : "▾ "}{t.adjustDetails}</button>
        {showDetails && (
          <div className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
            <div className="grid grid-cols-2 gap-x-3">
              <Field label={t.perLF} value={fLF} onChange={setFLF} type="number" />
              <Field label={t.markup} value={fMk} onChange={setFMk} type="number" suffix="%" />
              <Field label={t.walkPrice} value={fWalkP} onChange={setFWalkP} type="number" />
              <Field label={t.dblPrice} value={fDblP} onChange={setFDblP} type="number" />
            </div>
          </div>
        )}
      </div>
    );
  };

  const VoiceInvoice = () => (
    <div className="flex-1 overflow-y-auto px-5 pb-6">
      <div className="rounded-2xl p-5 mb-4 text-center" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
        <p className="text-sm font-bold mb-1" style={{ color: C.navy }}>{t.viSpeak}</p>
        <p className="text-xs mb-4" style={{ color: C.slate }}>{t.viExample}</p>
        <button onClick={() => startVoice(viParse)} disabled={!hasVoice}
          className="w-20 h-20 rounded-full text-4xl active:scale-90 transition-transform"
          style={{ background: listening ? C.red : C.orange, border: "none", boxShadow: "0 6px 16px rgba(248,180,8,.4)", opacity: hasVoice ? 1 : 0.4 }}>
          {listening ? "🔴" : "🎤"}
        </button>
        {viBusy && <p className="text-sm font-semibold mt-3" style={{ color: C.slate }}>{t.aiThinking}</p>}
        {viHeard && !viBusy && <p className="text-sm mt-3" style={{ color: C.slate }}>{t.viHeard}: “{viHeard}”</p>}
      </div>
      <div className="rounded-2xl p-4 mb-4" style={{ background: "#fff", border: `1.5px solid ${C.line}` }}>
        <Field label={t.cust} value={viName} onChange={setViName} placeholder="María García" />
        <Field label={t.concept} value={viConcept} onChange={setViConcept} placeholder={lang === "es" ? "Reparación de techo" : "Roof repair"} />
        <Field label={t.amount} value={viAmount} onChange={setViAmount} type="number" placeholder="450" />
      </div>
      <Btn onClick={viCreate} disabled={!viConcept.trim() || !(parseFloat(viAmount) > 0)}>{t.createInvoice}</Btn>
    </div>
  );

  const AI = () => (
    <div className="flex-1 flex flex-col px-5 pb-4 overflow-hidden">
      <div className="flex-1 overflow-y-auto py-2">
        {aiMsgs.length === 0 && (
          <div className="text-center mt-6">
            <span className="text-4xl">🎙️</span>
            <p className="font-bold mt-2" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 22 }}>{t.askTTP}</p>
          </div>
        )}
        {aiMsgs.map((m, i) => (
          <div key={i} className={`flex mb-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className="rounded-2xl px-4 py-2.5 max-w-xs text-sm font-medium whitespace-pre-wrap"
              style={m.role === "user" ? { background: C.navy, color: "#fff" } : { background: "#fff", color: C.navy, border: `1.5px solid ${C.line}` }}>
              {m.content}
            </div>
          </div>
        ))}
        {aiBusy && <p className="text-sm font-semibold" style={{ color: C.slate }}>{t.aiThinking}</p>}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-2">
        {[t.aiChip1, t.aiChip2, t.aiChip3].map(chip => (
          <button key={chip} onClick={() => askAI(chip)} className="rounded-full px-3 py-2 text-xs font-bold whitespace-nowrap" style={{ background: C.orangeSoft, color: C.orange, border: "none" }}>{chip}</button>
        ))}
      </div>
      <div className="flex gap-2 items-center">
        <input value={aiInput} onChange={e => setAiInput(e.target.value)} onKeyDown={e => e.key === "Enter" && askAI(aiInput)}
          placeholder={t.aiHint} className="flex-1 rounded-xl px-4 py-3 text-sm font-semibold outline-none"
          style={{ background: "#fff", border: `1.5px solid ${C.line}`, color: C.navy }} />
        <button onClick={() => askAI(aiInput)} disabled={aiBusy} className="rounded-xl px-4 py-3 font-extrabold" style={{ background: C.orange, color: "#fff", border: "none" }}>→</button>
      </div>
    </div>
  );

  const Leads = () => {
    const prettyPhone = (p) => {
      const d = String(p || "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
      return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
    };
    const when = (ts) => {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "";
      const sameDay = d.toDateString() === new Date().toDateString();
      return sameDay
        ? d.toLocaleTimeString(lang === "es" ? "es-MX" : "en-US", { hour: "numeric", minute: "2-digit" })
        : d.toLocaleDateString(lang === "es" ? "es-MX" : "en-US", { month: "short", day: "numeric" });
    };
    const waLink = (l) => {
      const d = String(l.phone || "").replace(/\D/g, "");
      const who = userName && bizName ? `${userName} (${bizName})` : (bizName || userName || "ALTO Pro");
      return `https://wa.me/${d.length === 10 ? "1" + d : d}?text=${encodeURIComponent(t.leadMsg(l.name, l.address, who))}`;
    };
    return (
      <div className="flex-1 overflow-y-auto px-5 pb-6">
        {leads.length === 0 && (
          <div className="text-center mt-12 px-6">
            <span className="text-5xl">📥</span>
            <p className="font-bold mt-3" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 22 }}>{t.leadsEmpty}</p>
            <p className="text-sm mt-2 font-semibold" style={{ color: C.slate }}>{t.leadsEmptySub}</p>
          </div>
        )}
        {leads.map((l) => (
          <div key={l.id} className="rounded-2xl p-4 mb-3" style={{ background: "#fff", border: l.status === "new" ? `2px solid ${C.orange}` : `1.5px solid ${C.line}` }}>
            <div className="flex items-center gap-2">
              <span className="font-extrabold" style={{ color: C.navy, fontFamily: "'Inter', sans-serif", fontSize: 19 }}>{l.name || prettyPhone(l.phone)}</span>
              {l.status === "new" && <span className="rounded-full px-2 py-0.5 text-xs font-extrabold" style={{ background: C.orange, color: "#fff" }}>{t.leadNew}</span>}
              <span className="ml-auto text-xs font-bold" style={{ color: C.slate }}>{when(l.created_at)}</span>
            </div>
            {l.address && <p className="text-sm font-semibold mt-1" style={{ color: C.slate }}>📍 {l.address}</p>}
            <div className="flex items-center gap-3 mt-1">
              <span className="text-sm font-bold" style={{ color: C.navy }}>{prettyPhone(l.phone)}</span>
              {l.info?.low != null && (
                <span className="text-sm font-bold" style={{ color: C.orange }}>{t.leadEst}: {fmt(l.info.low)}–{fmt(l.info.high)}</span>
              )}
            </div>
            <div className="flex gap-2 mt-3">
              <a href={waLink(l)} target="_blank" rel="noreferrer" onClick={() => l.status === "new" && markLead(l.id, "contacted")}
                className="flex-1 rounded-xl py-2.5 text-center text-sm font-extrabold no-underline" style={{ background: "#25D366", color: "#fff" }}>💬 {t.leadWhats}</a>
              <a href={`tel:+1${String(l.phone || "").replace(/\D/g, "").replace(/^1/, "")}`} onClick={() => l.status === "new" && markLead(l.id, "contacted")}
                className="flex-1 rounded-xl py-2.5 text-center text-sm font-extrabold no-underline" style={{ background: C.navy, color: "#fff" }}>📞 {t.leadCall}</a>
              <button onClick={() => markLead(l.id, l.status === "new" ? "contacted" : "new")}
                className="rounded-xl px-3 py-2.5 text-sm font-bold" style={{ background: C.bg, color: l.status === "new" ? C.slate : "#1E7B3C", border: "none" }}>
                {l.status === "new" ? "✓" : t.leadDone}
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  };

  /* ── Router ── */
  const titles = {
    calc: trade === "roofing" ? "🏠 " + t.cmpValue : "🧮 " + t.calculator, pickCustomer: t.estimate, send: t.estimate, jobs: t.jobs,
    jobDetail: t.job, invoice: t.invoice, payments: t.payments, customers: t.customers, ai: t.askTTP,
    roofAddress: "🏠 " + (trade === "fence" ? t.measureFence : t.searchAddress),
    voiceInvoice: "🎤 " + t.quickInvoice, fenceDraw: "🪵 " + t.fenceTitle,
    settings: "⚙️ " + t.settings, leads: "📥 " + t.leads,
    report: "📄 " + (lang === "es" ? "Informe del cliente" : "Client report"),
  };
  const backMap = {
    report: "comps",
    calc: "home", pickCustomer: trade === "fence" ? "fenceDraw" : "calc", send: "jobs", jobs: "home", jobDetail: "jobs",
    invoice: "jobDetail", payments: "home", customers: "home", ai: "home", roofAddress: "home",
    voiceInvoice: "home", fenceDraw: "home", settings: "home", leads: "home",
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
        {!session && screen !== "onboard" && (
          <div className="no-print px-4 py-2 text-center" style={{ background: C.orangeSoft, borderBottom: `1.5px solid ${C.orange}` }}>
            <span className="text-xs font-bold" style={{ color: "#7A5A00" }}>{t.demoBanner}</span>
          </div>
        )}
        {tabScreens.includes(screen) && <BrandHeader />}
        {screen !== "onboard" && screen !== "trade" && screen !== "home" && !tabScreens.includes(screen) && (
          <div className="no-print"><Header title={titles[screen] || ""} back={() => setScreen(backMap[screen] || "comps")} /></div>
        )}
        {screen === "onboard" && Onboard()}
        {screen === "settings" && Settings()}
        {screen === "trade" && TradePicker()}
        {screen === "home" && Home()}
        {screen === "comps" && (lookup ? CompsResult() : CompsSearch())}
        {screen === "lending" && Lending()}
        {screen === "tax" && Tax()}
        {screen === "workspace" && Workspace()}
        {screen === "report" && Report()}
        {screen === "calc" && (trade === "roofing" ? CompsResult() : Calc())}
        {screen === "roofAddress" && CompsSearch()}
        {screen === "voiceInvoice" && VoiceInvoice()}
        {screen === "fenceDraw" && FenceDraw()}
        {screen === "pickCustomer" && PickCustomer()}
        {screen === "send" && SendScreen()}
        {screen === "jobs" && JobsList()}
        {screen === "jobDetail" && JobDetail()}
        {screen === "invoice" && Invoice()}
        {screen === "payments" && Payments()}
        {screen === "customers" && Customers()}
        {screen === "ai" && AI()}
        {screen === "leads" && Leads()}
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
