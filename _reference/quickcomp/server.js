const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

loadEnv();

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const ROOT = __dirname;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  try {
    setCommonHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health' || url.pathname === '/api/health' || url.pathname === '/api/config') {
      return sendJson(res, {
        ok: true,
        service: 'quick-comp-api',
        environment: process.env.NODE_ENV || 'development',
        hasGoogleMaps: Boolean(process.env.GOOGLE_MAPS_API_KEY),
        hasRentCast: Boolean(process.env.RENTCAST_API_KEY),
        hasOpenAI: Boolean(process.env.OPENAI_API_KEY),
        hasSupabase: Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY))
      });
    }

    if (url.pathname === '/api/geocode') {
      return await handleGeocode(url, res);
    }

    if (url.pathname === '/api/streetview') {
      return await handleStreetView(url, res);
    }

    if (url.pathname === '/api/static-map') {
      return await handleStaticMap(url, res);
    }

    if (url.pathname === '/api/briefing') {
      return await handleBriefing(url, res);
    }

    if (url.pathname === '/api/property') {
      return await handleProperty(url, res);
    }

    if (url.pathname === '/api/comps') {
      return await handleComps(url, res);
    }

    if (url.pathname === '/api/cma-report.pdf') {
      return await handleCmaReportPdf(url, res);
    }

    if (url.pathname === '/api/parse-checklist' && req.method === 'POST') {
      return await handleChecklist(req, res);
    }

    if (url.pathname === '/api/client-analysis' && req.method === 'POST') {
      return await handleClientAnalysis(req, res);
    }

    if (url.pathname === '/api/tax-analysis' && req.method === 'POST') {
      return await handleTaxAnalysis(req, res);
    }

    if (url.pathname === '/api/payment-analysis' && req.method === 'POST') {
      return await handlePaymentAnalysis(req, res);
    }

    if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
      return await handleSupabaseAuth(req, res, 'signup');
    }

    if (url.pathname === '/api/auth/signin' && req.method === 'POST') {
      return await handleSupabaseAuth(req, res, 'signin');
    }

    if (url.pathname === '/api/cloud/store' && req.method === 'GET') {
      return await handleCloudStore(req, res);
    }

    if (url.pathname === '/api/cloud/profile' && req.method === 'POST') {
      return await handleCloudProfile(req, res);
    }

    if (url.pathname === '/api/cloud/branding-asset' && req.method === 'POST') {
      return await handleCloudBrandingAsset(req, res);
    }

    if (url.pathname === '/api/cloud/workspace' && req.method === 'POST') {
      return await handleCloudWorkspace(req, res);
    }

    if (url.pathname === '/api/cloud/usage' && req.method === 'POST') {
      return await handleCloudUsage(req, res);
    }

    return serveStatic(url.pathname, res);
  } catch (err) {
    sendJson(res, { error: err.message || 'Server error' }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Quick Comp API running at http://${HOST}:${PORT}`);
});

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function serveStatic(requestPath, res) {
  const cleanPath = decodeURIComponent(requestPath === '/' ? '/index.html' : requestPath);
  const filePath = path.normalize(path.join(ROOT, cleanPath));
  if (!filePath.startsWith(ROOT)) return sendText(res, 'Not found', 404);
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 'Not found', 404);
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleGeocode(url, res) {
  const key = requireKey('GOOGLE_MAPS_API_KEY');
  const mode = url.searchParams.get('mode') || 'geocode';
  const address = url.searchParams.get('address');
  const latlng = url.searchParams.get('latlng');
  const input = url.searchParams.get('input');

  let endpoint;
  if (mode === 'autocomplete') {
    const data = await fetchJson('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'suggestions.placePrediction.text.text'
      },
      body: JSON.stringify({
        input: input || '',
        includedRegionCodes: ['us']
      })
    });
    const predictions = (data.suggestions || []).map((s) => ({
      description: s.placePrediction?.text?.text || ''
    })).filter((p) => p.description);
    return sendJson(res, {
      status: predictions.length ? 'OK' : 'ZERO_RESULTS',
      provider: 'google-places-new',
      predictions
    });
  } else {
    endpoint = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    if (latlng) endpoint.searchParams.set('latlng', latlng);
    else endpoint.searchParams.set('address', address || '');
  }
  endpoint.searchParams.set('key', key);

  const data = await fetchJson(endpoint);
  if (data.status && !['OK', 'ZERO_RESULTS'].includes(data.status)) {
    return sendJson(res, await fallbackGeocode({ mode, address, latlng, input }));
  }
  sendJson(res, data);
}

async function handleStreetView(url, res) {
  const key = requireKey('GOOGLE_MAPS_API_KEY');
  const lat = url.searchParams.get('lat');
  const lng = url.searchParams.get('lng');
  const address = url.searchParams.get('address');
  const size = url.searchParams.get('size') || '640x360';
  const location = lat && lng ? `${lat},${lng}` : address;
  if (!location) return sendText(res, 'Location is required', 400);

  const endpoint = new URL('https://maps.googleapis.com/maps/api/streetview');
  endpoint.searchParams.set('size', size);
  endpoint.searchParams.set('location', location);
  endpoint.searchParams.set('fov', '80');
  endpoint.searchParams.set('pitch', '0');
  endpoint.searchParams.set('source', 'outdoor');
  endpoint.searchParams.set('return_error_code', 'true');
  endpoint.searchParams.set('key', key);

  const response = await fetch(endpoint);
  if (!response.ok) return sendStreetViewPlaceholder(res);
  const bytes = Buffer.from(await response.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': response.headers.get('content-type') || 'image/jpeg',
    'Cache-Control': 'public, max-age=86400'
  });
  res.end(bytes);
}

async function handleStaticMap(url, res) {
  const key = requireKey('GOOGLE_MAPS_API_KEY');
  const subject = url.searchParams.get('subject');
  const points = url.searchParams.getAll('point').slice(0, 12);
  const size = url.searchParams.get('size') || '640x360';
  if (!subject && !points.length) return sendText(res, 'Map points are required', 400);

  const endpoint = new URL('https://maps.googleapis.com/maps/api/staticmap');
  endpoint.searchParams.set('size', size);
  endpoint.searchParams.set('scale', '2');
  endpoint.searchParams.set('maptype', 'roadmap');
  if (subject) endpoint.searchParams.append('markers', `color:0x111B42|label:S|${subject}`);
  points.forEach((point, index) => {
    endpoint.searchParams.append('markers', `color:0xC9973A|label:${index + 1}|${point}`);
  });
  endpoint.searchParams.set('key', key);

  const response = await fetch(endpoint);
  if (!response.ok) return sendStreetViewPlaceholder(res);
  const bytes = Buffer.from(await response.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': response.headers.get('content-type') || 'image/png',
    'Cache-Control': 'public, max-age=86400'
  });
  res.end(bytes);
}

function sendStreetViewPlaceholder(res) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <rect width="640" height="360" fill="#F0F4FA"/>
    <rect x="240" y="96" width="160" height="120" rx="10" fill="#dde4f0"/>
    <path d="M258 206h124v-70l-62-42-62 42z" fill="#1B2A5C" opacity=".18"/>
    <path d="M286 206v-56h68v56" fill="#1B2A5C" opacity=".26"/>
    <text x="320" y="255" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#6b7db3">Street View unavailable</text>
  </svg>`;
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=3600'
  });
  res.end(svg);
}

async function handleBriefing(url, res) {
  const key = requireKey('RENTCAST_API_KEY');
  const zipCode = String(url.searchParams.get('zipCode') || '').trim();
  if (!/^\d{5}$/.test(zipCode)) return sendJson(res, { error: 'Enter a valid 5-digit ZIP code' }, 400);

  const market = await fetchRentcastMarket({ key, zipCode });
  const rates = await fetchMortgageRates().catch(() => null);
  const talkingPoints = await buildBriefingTalkingPoints({ zipCode, market, rates }).catch(() => fallbackTalkingPoints(market, rates));

  sendJson(res, {
    zipCode,
    generatedAt: new Date().toISOString(),
    market,
    rates,
    talkingPoints
  });
}

async function handleProperty(url, res) {
  const key = requireKey('RENTCAST_API_KEY');
  const address = String(url.searchParams.get('address') || '').trim();
  if (!address) return sendJson(res, { error: 'Address is required' }, 400);

  let property = null;
  try {
    property = await fetchRentcastProperty({ key, address });
  } catch {
    property = null;
  }

  if (!property) {
    const geocode = await fallbackGeocode({ mode: 'geocode', address });
    const result = geocode.results?.[0] || {};
    return sendJson(res, {
      source: 'geocode',
      property: {
        address: result.formatted_address || address,
        latitude: result.geometry?.location?.lat || null,
        longitude: result.geometry?.location?.lng || null
      }
    });
  }

  sendJson(res, { source: 'rentcast', property });
}

async function fetchRentcastProperty({ key, address }) {
  const endpoint = new URL('https://api.rentcast.io/v1/properties');
  endpoint.searchParams.set('address', address);
  const data = await fetchJson(endpoint, { headers: { 'X-Api-Key': key } });
  const record = Array.isArray(data) ? data[0] : (data.property || data.properties?.[0] || data);
  if (!record || Object.keys(record).length === 0) return null;
  return normalizeProperty(record, address);
}

function normalizeProperty(p, fallbackAddress) {
  const newestYearRecord = (value) => {
    if (!value) return {};
    if (Array.isArray(value)) {
      return [...value].sort((a, b) => Number(b?.year || 0) - Number(a?.year || 0))[0] || {};
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value)
        .map(([year, record]) => ({ year: Number(year), record }))
        .filter((entry) => Number.isFinite(entry.year) && entry.record && typeof entry.record === 'object')
        .sort((a, b) => b.year - a.year);
      if (entries[0]) return { year: entries[0].year, ...entries[0].record };
      return value;
    }
    return {};
  };
  const newestHistorySale = (history) => {
    if (!history || typeof history !== 'object') return {};
    const sales = Object.entries(history)
      .map(([date, record]) => ({ date, ...(record || {}) }))
      .filter((record) => record.event === 'Sale' || record.price || record.salePrice || record.amount)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    return sales[0] || {};
  };
  const tax = newestYearRecord(p.tax || p.taxes || p.propertyTaxes || p.taxAssessment);
  const assessment = newestYearRecord(p.assessment || p.assessments || p.taxAssessments || p.assessor);
  const sale = p.lastSale || p.sale || p.sales?.[0] || newestHistorySale(p.history) || {};
  const owner = p.owner || p.owners?.[0] || {};
  const ownerName = p.ownerName
    || owner.name
    || (Array.isArray(owner.names) ? owner.names.join(', ') : null)
    || [owner.firstName, owner.lastName].filter(Boolean).join(' ')
    || null;
  return {
    address: p.formattedAddress || p.address || [p.addressLine1, p.city, p.state, p.zipCode].filter(Boolean).join(', ') || fallbackAddress,
    propertyType: p.propertyType || p.propertyUse || p.type || null,
    bedrooms: p.bedrooms ?? p.beds ?? null,
    bathrooms: p.bathrooms ?? p.baths ?? null,
    squareFootage: p.squareFootage || p.livingArea || p.lotSquareFootage || null,
    yearBuilt: p.yearBuilt || null,
    lotSize: p.lotSize || p.lotSquareFootage || null,
    latitude: p.latitude || p.location?.latitude || null,
    longitude: p.longitude || p.location?.longitude || null,
    ownerName,
    annualTax: p.propertyTax || p.annualTax || p.taxAmount || tax.amount || tax.total || tax.taxAmount || tax.annualAmount || null,
    taxYear: p.taxYear || tax.year || tax.taxYear || assessment.year || assessment.taxYear || null,
    assessmentYear: assessment.year || assessment.taxYear || null,
    assessedValue: p.assessedValue || p.assessmentValue || assessment.assessedValue || assessment.totalAssessedValue || assessment.value || null,
    landValue: p.landValue || assessment.land || assessment.landValue || assessment.assessedLandValue || null,
    improvementValue: p.improvementValue || assessment.improvements || assessment.improvementValue || assessment.assessedImprovementValue || null,
    exemptions: p.exemptions || tax.exemptions || assessment.exemptions || null,
    parcelNumber: p.parcelNumber || p.apn || p.assessorID || p.propertyId || null,
    county: p.county || null,
    ownerOccupied: p.ownerOccupied ?? null,
    lastSalePrice: p.lastSalePrice || sale.price || sale.salePrice || sale.amount || null,
    lastSaleDate: p.lastSaleDate || sale.date || sale.saleDate || null
  };
}

async function fetchRentcastMarket({ key, zipCode }) {
  const endpoint = new URL('https://api.rentcast.io/v1/markets');
  endpoint.searchParams.set('zipCode', zipCode);
  endpoint.searchParams.set('dataType', 'Sale');
  endpoint.searchParams.set('historyRange', '6');
  const data = await fetchJson(endpoint, { headers: { 'X-Api-Key': key } });
  const sale = data.saleData || {};
  const sf = (sale.dataByPropertyType || []).find((row) => row.propertyType === 'Single Family') || null;
  return {
    lastUpdatedDate: sale.lastUpdatedDate || null,
    averagePrice: sale.averagePrice || null,
    medianPrice: sale.medianPrice || null,
    averagePricePerSquareFoot: sale.averagePricePerSquareFoot || null,
    medianPricePerSquareFoot: sale.medianPricePerSquareFoot || null,
    averageDaysOnMarket: sale.averageDaysOnMarket || null,
    medianDaysOnMarket: sale.medianDaysOnMarket || null,
    newListings: sale.newListings || 0,
    totalListings: sale.totalListings || 0,
    singleFamily: sf ? {
      averagePrice: sf.averagePrice || null,
      medianPrice: sf.medianPrice || null,
      averageDaysOnMarket: sf.averageDaysOnMarket || null,
      medianDaysOnMarket: sf.medianDaysOnMarket || null,
      newListings: sf.newListings || 0,
      totalListings: sf.totalListings || 0
    } : null
  };
}

async function fetchMortgageRates() {
  const csv = await fetchText('https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US,MORTGAGE15US');
  const rows = csv.trim().split(/\r?\n/).slice(1).map((line) => line.split(','));
  const latest = rows.reverse().find((row) => row[1] && row[1] !== '.' && row[2] && row[2] !== '.');
  if (!latest) return null;
  return {
    date: latest[0],
    mortgage30: Number(latest[1]),
    mortgage15: Number(latest[2]),
    source: 'Freddie Mac PMMS via FRED'
  };
}

async function buildBriefingTalkingPoints({ zipCode, market, rates }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return fallbackTalkingPoints(market, rates);
  const response = await fetchJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Write concise daily real estate briefing talking points for a Realtor. Return ONLY JSON with keys buyer, seller, trend. No legal/financial advice. Keep each value under 22 words.'
        },
        {
          role: 'user',
          content: JSON.stringify({ zipCode, market, rates })
        }
      ],
      max_tokens: 220
    })
  });
  const content = response.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
  return {
    buyer: parsed.buyer || fallbackTalkingPoints(market, rates).buyer,
    seller: parsed.seller || fallbackTalkingPoints(market, rates).seller,
    trend: parsed.trend || fallbackTalkingPoints(market, rates).trend
  };
}

function fallbackTalkingPoints(market, rates) {
  const dom = market.medianDaysOnMarket || market.averageDaysOnMarket;
  return {
    buyer: rates?.mortgage30 ? `Rates are near ${rates.mortgage30.toFixed(2)}%, so payment strategy matters before touring.` : 'Review payment comfort before touring so the offer range stays realistic.',
    seller: market.totalListings ? `${market.totalListings} active listings means pricing and presentation need to be sharp.` : 'Strong presentation and accurate pricing are still the safest seller moves.',
    trend: dom ? `Median days on market is about ${Math.round(dom)}, so urgency depends on price band.` : 'Local market activity varies by price band; use fresh comps before advising.'
  };
}

async function fallbackGeocode({ mode, address, latlng, input }) {
  if (mode === 'autocomplete') {
    const endpoint = new URL('https://nominatim.openstreetmap.org/search');
    endpoint.searchParams.set('q', `${input || ''}, United States`);
    endpoint.searchParams.set('format', 'json');
    endpoint.searchParams.set('limit', '6');
    endpoint.searchParams.set('addressdetails', '1');
    endpoint.searchParams.set('countrycodes', 'us');
    const results = await fetchJson(endpoint, nominatimHeaders());
    return {
      status: 'OK',
      provider: 'nominatim-fallback',
      predictions: results.map((r) => ({
        description: r.display_name,
        place_id: String(r.place_id)
      }))
    };
  }

  let endpoint;
  if (latlng) {
    const [lat, lon] = latlng.split(',');
    endpoint = new URL('https://nominatim.openstreetmap.org/reverse');
    endpoint.searchParams.set('lat', lat || '');
    endpoint.searchParams.set('lon', lon || '');
  } else {
    endpoint = new URL('https://nominatim.openstreetmap.org/search');
    endpoint.searchParams.set('q', address || '');
    endpoint.searchParams.set('limit', '1');
  }
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('addressdetails', '1');

  const raw = await fetchJson(endpoint, nominatimHeaders());
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return {
    status: rows.length ? 'OK' : 'ZERO_RESULTS',
    provider: 'nominatim-fallback',
    results: rows.map((r) => ({
      formatted_address: r.display_name,
      geometry: {
        location: {
          lat: Number(r.lat),
          lng: Number(r.lon)
        }
      }
    }))
  };
}

function nominatimHeaders() {
  return {
    headers: {
      'Accept-Language': 'en',
      'User-Agent': 'QuickComp/1.0'
    }
  };
}

async function handleComps(url, res) {
  const key = requireKey('RENTCAST_API_KEY');
  const address = url.searchParams.get('address');
  if (!address) return sendJson(res, { error: 'Address is required' }, 400);

  const requestedRadius = Number(url.searchParams.get('radius') || '2');
  const requestedDaysOld = Number(url.searchParams.get('daysOld') || '183');
  const compCount = url.searchParams.get('compCount') || '12';
  const autoExpand = url.searchParams.get('autoExpand') === 'true';
  const allLookbacks = [
    { days: 183, label: '6 months' },
    { days: 365, label: '1 year' },
    { days: 730, label: '2 years' },
    { days: 1095, label: '3 years' }
  ];
  const exactLookback = allLookbacks.find((l) => l.days === requestedDaysOld) || { days: requestedDaysOld, label: `${requestedDaysOld} days` };
  const radii = autoExpand ? [2, 5, 10].filter((r) => r >= requestedRadius) : [requestedRadius];
  const lookbacks = autoExpand ? allLookbacks.filter((l) => l.days >= requestedDaysOld) : [exactLookback];
  let data = null;
  let usedRadius = radii[0] || 2;
  let usedLookback = lookbacks[0];
  let lastError = null;

  for (const radius of radii) {
    for (const lookback of lookbacks) {
      try {
        data = await fetchRentcastValue({ key, address, radius, compCount, daysOld: lookback.days });
        usedRadius = radius;
        usedLookback = lookback;
        break;
      } catch (err) {
        lastError = err;
        if (!/insufficient comparables|unable to calculate avm/i.test(err.message || '')) throw err;
      }
    }
    if (data) break;
  }

  if (!data) {
    const scope = autoExpand ? 'within the available expanded search' : `within ${requestedRadius} miles and ${exactLookback.label}`;
    throw lastError || new Error(`No comparable sales found ${scope}`);
  }

  const subject = data.subjectProperty || data.property || null;
  const rawComps = normalizeRentcastComps(data);
  const quickComp = calculateQuickCompValue({
    subject,
    comps: rawComps,
    rentcastEstimate: data.price || data.value || data.estimate || null,
    rentcastLow: data.priceRangeLow || data.valueRangeLow || null,
    rentcastHigh: data.priceRangeHigh || data.valueRangeHigh || null
  });
  const comps = quickComp.rankedComps || rawComps;
  sendJson(res, {
    source: 'rentcast',
    method: quickComp.method,
    requestedRadius,
    requestedDaysOld,
    expanded: usedRadius !== requestedRadius || usedLookback.days !== requestedDaysOld,
    radius: usedRadius,
    daysOld: usedLookback.days,
    lookbackLabel: usedLookback.label,
    estimate: quickComp.estimate,
    low: quickComp.low,
    high: quickComp.high,
    quickComp: omitRankedComps(quickComp),
    rentcastEstimate: data.price || data.value || data.estimate || null,
    rentcastLow: data.priceRangeLow || data.valueRangeLow || null,
    rentcastHigh: data.priceRangeHigh || data.valueRangeHigh || null,
    subject,
    comps
  });
}

async function handleCmaReportPdf(url, res) {
  const key = requireKey('RENTCAST_API_KEY');
  const address = String(url.searchParams.get('address') || '').trim();
  if (!address) return sendText(res, 'Address is required', 400);

  const radius = Number(url.searchParams.get('radius') || '2');
  const daysOld = Number(url.searchParams.get('daysOld') || '183');
  const data = await fetchRentcastValue({ key, address, radius, compCount: '12', daysOld });
  const subject = data.subjectProperty || data.property || null;
  const rawComps = normalizeRentcastComps(data);
  const quickComp = calculateQuickCompValue({
    subject,
    comps: rawComps,
    rentcastEstimate: data.price || data.value || data.estimate || null,
    rentcastLow: data.priceRangeLow || data.valueRangeLow || null,
    rentcastHigh: data.priceRangeHigh || data.valueRangeHigh || null
  });
  const comps = (quickComp.rankedComps || rawComps).slice(0, 12);
  const estimate = quickComp.estimate || data.price || data.value || data.estimate || null;
  const low = quickComp.low || data.priceRangeLow || data.valueRangeLow || null;
  const high = quickComp.high || data.priceRangeHigh || data.valueRangeHigh || null;
  const analysis = fallbackClientAnalysis({
    address,
    metrics: {
      avg: estimate,
      low,
      high,
      radius,
      lookback: daysOld <= 183 ? '6 months' : `${daysOld} days`,
      compCount: quickComp.usedCompCount || comps.length,
      method: quickComp.method,
      avgPpsf: quickComp.avgPpsf
    },
    comps
  });

  const pdf = await buildPremiumCmaPdf({ address, estimate, low, high, radius, daysOld, comps, analysis, quickComp });
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'inline; filename="quick-comp-cma-report.pdf"',
    'Cache-Control': 'no-store'
  });
  res.end(pdf);
}

async function buildPremiumCmaPdf({ address, estimate, low, high, radius, daysOld, comps, analysis, quickComp }) {
  const pageWidth = 612;
  const pageHeight = 792;
  const commands = [];
  const images = {};
  const navy = '0.067 0.106 0.259';
  const navy2 = '0.035 0.086 0.176';
  const gold = '0.788 0.592 0.227';
  const goldLight = '0.902 0.749 0.416';
  const ink = '0.067 0.106 0.259';
  const muted = '0.392 0.459 0.616';
  const line = '0.850 0.882 0.937';
  const soft = '0.963 0.976 0.996';

  const rect = (x, y, w, h, color) => {
    commands.push(`${color} rg ${x} ${y} ${w} ${h} re f`);
  };
  const strokeRect = (x, y, w, h, color = line, width = 1) => {
    commands.push(`${color} RG ${width} w ${x} ${y} ${w} ${h} re S`);
  };
  const text = (value, x, y, size = 10, font = 'F1', color = ink) => {
    commands.push('BT');
    commands.push(`${color} rg /${font} ${size} Tf`);
    commands.push(`1 0 0 1 ${x} ${y} Tm (${escapePdfText(String(value || ''))}) Tj`);
    commands.push('ET');
  };
  const wrapped = (value, x, y, maxChars, size = 10, leading = 14, font = 'F1', color = ink, maxLines = 6) => {
    const lines = wrapPdfLine(String(value || ''), maxChars).slice(0, maxLines);
    lines.forEach((row, i) => text(row, x, y - i * leading, size, font, color));
    return y - lines.length * leading;
  };
  const label = (value, x, y) => text(String(value).toUpperCase(), x, y, 7, 'F2', gold);
  const image = (name, x, y, w, h) => {
    if (!images[name]) return;
    commands.push('q');
    commands.push(`${w} 0 0 ${h} ${x} ${y} cm`);
    commands.push(`/${name} Do`);
    commands.push('Q');
  };

  const subjectImage = await fetchStreetViewImageBuffer({ address, size: '640x360' }).catch(() => null);
  if (subjectImage) images.Subject = subjectImage;
  const compImages = await Promise.all(
    comps.slice(0, 12).map((comp) => fetchStreetViewImageBuffer({ address: comp.address, size: '220x150' }).catch(() => null))
  );
  compImages.forEach((img, index) => {
    if (img) images[`Comp${index + 1}`] = img;
  });

  rect(0, 0, pageWidth, pageHeight, '1 1 1');
  rect(0, 690, pageWidth, 102, navy);
  rect(0, 686, pageWidth, 4, gold);
  text('CLIENT CMA REPORT', 48, 746, 19, 'F2', '1 1 1');
  text('Prepared for pricing guidance and client conversation', 48, 727, 8, 'F2', goldLight);
  text(new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), 390, 728, 8, 'F1', '0.780 0.824 0.918');

  image('Subject', 48, 532, 245, 138);
  strokeRect(48, 532, 245, 138, line, 1);
  text('Subject Property', 313, 648, 18, 'F2', ink);
  wrapped(address, 313, 626, 42, 10, 14, 'F1', muted, 3);

  rect(313, 552, 251, 52, soft);
  strokeRect(313, 552, 251, 52, line, 1);
  label('Estimated Market Value', 331, 584);
  text(formatCurrency(estimate), 331, 561, 24, 'F2', ink);
  if (low && high) {
    text(`Client range: ${formatCurrency(low)} - ${formatCurrency(high)}`, 331, 546, 8.5, 'F2', muted);
  }

  label('Comparable Support', 331, 535);
  const supportCount = quickComp?.usedCompCount || comps.filter((comp) => !comp.excludedAsOutlier).length || comps.length;
  text(`${supportCount} weighted sold comps within ${radius} mi`, 331, 518, 11, 'F2', ink);
  text(daysOld <= 183 ? 'Sold window: past 6 months' : `Sold window: ${daysOld} days`, 331, 503, 9, 'F1', muted);
  if (quickComp?.avgPpsf) {
    text(`Weighted avg: ${formatCurrency(quickComp.avgPpsf)}/sf`, 331, 490, 8.5, 'F1', muted);
  }

  rect(48, 346, 516, 126, '1 1 1');
  strokeRect(48, 346, 516, 126, line, 1);
  rect(48, 467, 516, 5, gold);
  text('Market Analysis', 66, 445, 15, 'F2', ink);
  let y = 425;
  [
    ['Overview', analysis.overview],
    ['Pricing', analysis.pricing],
    ['Comparable Support', analysis.compSupport],
    ['Recommendation', analysis.recommendation]
  ].forEach(([title, body]) => {
    label(title, 66, y);
    y = wrapped(body, 150, y, 70, 8.5, 11, 'F1', ink, 2) - 4;
  });

  text('Sold Comparables', 48, 312, 15, 'F2', ink);
  const cardW = 160;
  const cardH = 104;
  comps.slice(0, 6).forEach((comp, index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = 48 + col * 178;
    const y0 = 190 - row * 118;
    rect(x, y0, cardW, cardH, '0.982 0.988 1');
    strokeRect(x, y0, cardW, cardH, line, 1);
    image(`Comp${index + 1}`, x, y0 + 48, cardW, 56);
    rect(x, y0 + 48, 28, 18, navy2);
    text(String(index + 1), x + 10, y0 + 54, 8, 'F2', '1 1 1');
    wrapped(comp.address, x + 8, y0 + 38, 25, 6.5, 8, 'F2', ink, 2);
    text(formatCurrency(comp.soldPrice), x + 8, y0 + 17, 9, 'F2', gold);
    text(`${comp.sqft || '—'} sf · ${comp.distance ? Number(comp.distance).toFixed(2) : '—'} mi`, x + 8, y0 + 6, 6.5, 'F1', muted);
  });

  text('Prepared with Quick Comp', 48, 28, 8, 'F2', muted);
  text('Values are estimates and not an appraisal.', 386, 28, 8, 'F1', muted);

  const page2 = [];
  const p2Rect = (x, y, w, h, color) => page2.push(`${color} rg ${x} ${y} ${w} ${h} re f`);
  const p2Stroke = (x, y, w, h, color = line, width = 1) => page2.push(`${color} RG ${width} w ${x} ${y} ${w} ${h} re S`);
  const p2Text = (value, x, y, size = 10, font = 'F1', color = ink) => {
    page2.push('BT');
    page2.push(`${color} rg /${font} ${size} Tf`);
    page2.push(`1 0 0 1 ${x} ${y} Tm (${escapePdfText(String(value || ''))}) Tj`);
    page2.push('ET');
  };
  const p2Wrapped = (value, x, y, maxChars, size = 10, leading = 14, font = 'F1', color = ink, maxLines = 6) => {
    const lines = wrapPdfLine(String(value || ''), maxChars).slice(0, maxLines);
    lines.forEach((row, i) => p2Text(row, x, y - i * leading, size, font, color));
  };
  const p2Image = (name, x, y, w, h) => {
    if (!images[name]) return;
    page2.push('q');
    page2.push(`${w} 0 0 ${h} ${x} ${y} cm`);
    page2.push(`/${name} Do`);
    page2.push('Q');
  };

  p2Rect(0, 0, pageWidth, pageHeight, '1 1 1');
  p2Rect(0, 742, pageWidth, 50, navy);
  p2Rect(0, 738, pageWidth, 4, gold);
  p2Text('Comparable Photo Review', 48, 762, 17, 'F2', '1 1 1');
  p2Text(`${comps.length} sold properties reviewed for ${address}`, 48, 747, 8, 'F1', '0.780 0.824 0.918');

  const page2Cards = comps.slice(6, 12);
  page2Cards.forEach((comp, localIndex) => {
    const index = localIndex + 6;
    const col = localIndex % 2;
    const row = Math.floor(localIndex / 2);
    const x = 48 + col * 266;
    const y0 = 552 - row * 168;
    p2Rect(x, y0, 236, 136, '0.982 0.988 1');
    p2Stroke(x, y0, 236, 136, line, 1);
    p2Image(`Comp${index + 1}`, x, y0 + 56, 236, 80);
    p2Rect(x, y0 + 56, 30, 20, navy2);
    p2Text(String(index + 1), x + 10, y0 + 63, 8, 'F2', '1 1 1');
    p2Wrapped(comp.address, x + 10, y0 + 44, 38, 7.5, 9, 'F2', ink, 2);
    p2Text(formatCurrency(comp.soldPrice), x + 10, y0 + 20, 11, 'F2', gold);
    p2Text(`${comp.sqft || '-'} sf · ${comp.distance ? Number(comp.distance).toFixed(2) : '-'} mi · ${comp.yearBuilt || 'Year -'}`, x + 10, y0 + 8, 7, 'F1', muted);
  });

  p2Text('Full Comparable Set', 48, 185, 14, 'F2', ink);
  p2Rect(48, 160, 516, 18, navy2);
  p2Text('#', 58, 166, 7, 'F2', '1 1 1');
  p2Text('Address', 82, 166, 7, 'F2', '1 1 1');
  p2Text('Sold Price', 350, 166, 7, 'F2', '1 1 1');
  p2Text('Sq Ft', 424, 166, 7, 'F2', '1 1 1');
  p2Text('Dist.', 480, 166, 7, 'F2', '1 1 1');
  p2Text('Year', 528, 166, 7, 'F2', '1 1 1');
  let tableY = 143;
  comps.slice(0, 12).forEach((comp, index) => {
    if (index % 2 === 0) p2Rect(48, tableY - 5, 516, 14, '0.982 0.988 1');
    p2Text(String(index + 1), 58, tableY, 6.5, 'F2', gold);
    p2Wrapped(comp.address, 82, tableY, 50, 6.2, 7, 'F1', ink, 1);
    p2Text(formatCurrency(comp.soldPrice), 350, tableY, 6.5, 'F2', ink);
    p2Text(comp.sqft ? String(comp.sqft) : '-', 424, tableY, 6.5, 'F1', muted);
    p2Text(comp.distance ? `${Number(comp.distance).toFixed(2)} mi` : '-', 480, tableY, 6.5, 'F1', muted);
    p2Text(comp.yearBuilt ? String(comp.yearBuilt) : '-', 528, tableY, 6.5, 'F1', muted);
    tableY -= 13;
  });
  p2Text('Prepared with Quick Comp', 48, 28, 8, 'F2', muted);

  return buildPdfFromCommands([commands, page2], images);
}

function buildPdfFromCommands(commands, images = {}) {
  const pages = Array.isArray(commands[0]) ? commands : [commands];
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const imageRefs = {};
  for (const [name, img] of Object.entries(images)) {
    imageRefs[name] = add(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n${img.bytes.toString('binary')}\nendstream`);
  }
  const xObjects = Object.entries(imageRefs).map(([name, id]) => `/${name} ${id} 0 R`).join(' ');
  const pageIds = pages.map((pageCommands) => {
    const stream = pageCommands.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >> /XObject << ${xObjects} >> >> /Contents ${contentId} 0 R >>`);
  });
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  for (const pageId of pageIds) {
    objects[pageId - 1] = objects[pageId - 1].replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`);
  }
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
  offsets.push(Buffer.byteLength(output, 'binary'));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(output, 'binary');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, 'binary');
}

function buildSimplePdf(lines) {
  const safeLines = lines.flatMap((line) => wrapPdfLine(String(line || ''), 88));
  const pageHeight = 792;
  const marginLeft = 54;
  const startY = 738;
  const lineHeight = 15;
  const pages = [];
  for (let i = 0; i < safeLines.length; i += 42) pages.push(safeLines.slice(i, i + 42));

  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageIds = [];

  for (const pageLines of pages) {
    const commands = ['BT'];
    let y = startY;
    pageLines.forEach((line, index) => {
      const isTitle = index < 2 && pageIds.length === 0;
      commands.push(`/${isTitle ? 'F2' : 'F1'} ${isTitle ? 22 : 10} Tf`);
      commands.push(`1 0 0 1 ${marginLeft} ${y} Tm (${escapePdfText(line)}) Tj`);
      y -= lineHeight;
    });
    commands.push('ET');
    const contentId = add(`<< /Length ${Buffer.byteLength(commands.join('\n'))} >>\nstream\n${commands.join('\n')}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 ${pageHeight}] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  for (const pageId of pageIds) {
    objects[pageId - 1] = objects[pageId - 1].replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`);
  }

  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output);
}

function wrapPdfLine(line, max) {
  if (!line) return [''];
  const words = line.split(/\s+/);
  const rows = [];
  let row = '';
  for (const word of words) {
    if (`${row} ${word}`.trim().length > max) {
      rows.push(row);
      row = word;
    } else {
      row = `${row} ${word}`.trim();
    }
  }
  if (row) rows.push(row);
  return rows;
}

function escapePdfText(value) {
  return value.replace(/[\\()]/g, '\\$&');
}

async function fetchStreetViewImageBuffer({ address, size = '640x360' }) {
  const key = requireKey('GOOGLE_MAPS_API_KEY');
  const endpoint = new URL('https://maps.googleapis.com/maps/api/streetview');
  endpoint.searchParams.set('size', size);
  endpoint.searchParams.set('location', address);
  endpoint.searchParams.set('fov', '80');
  endpoint.searchParams.set('pitch', '0');
  endpoint.searchParams.set('source', 'outdoor');
  endpoint.searchParams.set('return_error_code', 'true');
  endpoint.searchParams.set('key', key);

  const response = await fetch(endpoint);
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  if (!/jpe?g/i.test(contentType)) return null;
  const dimensions = jpegDimensions(bytes);
  if (!dimensions) return null;
  return { bytes, ...dimensions };
}

function jpegDimensions(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + length;
  }
  return null;
}

async function fetchRentcastValue({ key, address, radius, compCount, daysOld }) {
  const endpoint = new URL('https://api.rentcast.io/v1/avm/value');
  endpoint.searchParams.set('address', address);
  endpoint.searchParams.set('maxRadius', String(radius));
  endpoint.searchParams.set('daysOld', String(daysOld));
  endpoint.searchParams.set('compCount', compCount);
  endpoint.searchParams.set('lookupSubjectAttributes', 'true');

  return fetchJson(endpoint, {
    headers: { 'X-Api-Key': key }
  });
}

async function handleChecklist(req, res) {
  const key = requireKey('OPENAI_API_KEY');
  const body = await readJson(req);
  const transcript = String(body.transcript || '').trim();
  if (!transcript) return sendJson(res, { error: 'Transcript is required' }, 400);

  const response = await fetchJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Extract real estate checklist fields from spoken text. Return ONLY a JSON object with these keys when found: cl_name, cl_phone, cl_email, cl_agent, cl_type, prop_address, prop_type, prop_sqft, prop_beds, prop_baths, prop_year, prop_lot, fin_price, fin_down, fin_loan, fin_earnest, fin_contingencies, time_close, time_possession, time_inspection. Values should be clean strings ready for a form field.'
        },
        { role: 'user', content: transcript }
      ],
      max_tokens: 300
    })
  });

  const content = response.choices?.[0]?.message?.content || '{}';
  const fields = JSON.parse(content.replace(/```json|```/g, '').trim());
  sendJson(res, { fields });
}

async function handleClientAnalysis(req, res) {
  const body = await readJson(req);
  const address = String(body.address || '').trim();
  const metrics = body.metrics || {};
  const comps = Array.isArray(body.comps) ? body.comps.slice(0, 8) : [];
  if (!address || !comps.length) return sendJson(res, { error: 'Address and comps are required' }, 400);

  const analysis = await buildClientAnalysis({ address, metrics, comps }).catch(() => fallbackClientAnalysis({ address, metrics, comps }));
  sendJson(res, { analysis });
}

async function handleTaxAnalysis(req, res) {
  const body = await readJson(req);
  const property = body.property || {};
  if (!property.address) return sendJson(res, { error: 'Property is required' }, 400);

  const analysis = await buildTaxAnalysis({ property }).catch(() => fallbackTaxAnalysis({ property }));
  sendJson(res, { analysis });
}

async function handlePaymentAnalysis(req, res) {
  const body = await readJson(req);
  const property = body.property || {};
  const payment = body.payment || {};
  if (!payment.total) return sendJson(res, { error: 'Payment details are required' }, 400);

  const analysis = await buildPaymentAnalysis({ property, payment }).catch(() => fallbackPaymentAnalysis({ property, payment }));
  sendJson(res, { analysis });
}

async function handleSupabaseAuth(req, res, mode) {
  const supabaseUrl = requireKey('SUPABASE_URL').replace(/\/$/, '');
  const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
  if (!supabaseKey) return sendJson(res, { error: 'SUPABASE_ANON_KEY is missing. Add it to .env and restart the app.' }, 500);

  const body = await readJson(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return sendJson(res, { error: 'Email and password are required' }, 400);

  const name = String(body.name || '').trim();
  const brokerage = String(body.brokerage || '').trim();
  const endpoint = mode === 'signup'
    ? `${supabaseUrl}/auth/v1/signup`
    : `${supabaseUrl}/auth/v1/token?grant_type=password`;
  const payload = mode === 'signup'
    ? { email, password, data: { name, brokerage } }
    : { email, password };

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch {
    return sendJson(res, { error: 'Could not reach Supabase. Check the project URL, make sure the project is healthy, then restart the backend.' }, 502);
  }
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    return sendJson(res, { error: data.msg || data.message || data.error_description || 'Supabase auth failed' }, response.status);
  }
  sendJson(res, normalizeSupabaseAuth(data, { email, name, brokerage }));
}

function normalizeSupabaseAuth(data, fallback) {
  const user = data.user || {};
  const metadata = user.user_metadata || {};
  return {
    id: user.id || fallback.email,
    email: user.email || fallback.email,
    name: metadata.name || fallback.name || '',
    brokerage: metadata.brokerage || fallback.brokerage || '',
    accessToken: data.access_token || '',
    refreshToken: data.refresh_token || ''
  };
}

async function handleCloudStore(req, res) {
  const auth = getSupabaseRequestAuth(req);
  if (!auth.ok) return sendJson(res, { error: auth.error }, auth.status);

  const [profileRows, workspaceRows] = await Promise.all([
    supabaseRest(auth, `/rest/v1/profiles?id=eq.${encodeURIComponent(auth.userId)}&select=*`),
    supabaseRest(auth, `/rest/v1/workspace_items?user_id=eq.${encodeURIComponent(auth.userId)}&select=*&order=saved_at.desc&limit=50`)
  ]).catch((error) => {
    throw new Error(cloudSetupMessage(error));
  });

  sendJson(res, {
    profile: profileRows?.[0] ? profileFromRow(profileRows[0]) : null,
    workspace: Array.isArray(workspaceRows) ? workspaceRows.map(workspaceFromRow) : []
  });
}

async function handleCloudProfile(req, res) {
  const auth = getSupabaseRequestAuth(req);
  if (!auth.ok) return sendJson(res, { error: auth.error }, auth.status);
  const body = await readJson(req);
  const profile = body.profile || {};
  const row = {
    id: auth.userId,
    email: cleanString(profile.email || auth.email),
    name: cleanString(profile.name),
    brokerage: cleanString(profile.brokerage),
    phone: cleanString(profile.phone),
    license: cleanString(profile.license),
    logo_url: cleanString(profile.logoUrl),
    headshot_url: cleanString(profile.headshotUrl),
    status: cleanString(profile.status) || 'trial',
    plan: cleanString(profile.plan) || 'trial',
    report_count: Number(profile.reportCount || 0),
    report_limit: Number(profile.reportLimit || 5),
    updated_at: new Date().toISOString()
  };
  const rows = await supabaseRest(auth, '/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row)
  }).catch((error) => {
    throw new Error(cloudSetupMessage(error));
  });
  sendJson(res, { profile: profileFromRow(rows?.[0] || row) });
}

async function handleCloudBrandingAsset(req, res) {
  const auth = getSupabaseRequestAuth(req);
  if (!auth.ok) return sendJson(res, { error: auth.error }, auth.status);
  const body = await readJson(req);
  const kind = cleanString(body.kind);
  if (!['logo', 'headshot'].includes(kind)) {
    return sendJson(res, { error: 'Choose a logo or headshot image.' }, 400);
  }

  const base64 = cleanString(body.base64).replace(/^data:[^,]+,/, '');
  const mimeType = cleanString(body.mimeType) || 'image/jpeg';
  if (!base64) return sendJson(res, { error: 'Choose an image to upload.' }, 400);
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(mimeType)) {
    return sendJson(res, { error: 'Use a JPG, PNG, or WebP image.' }, 400);
  }

  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) return sendJson(res, { error: 'That image could not be read.' }, 400);
  if (bytes.length > 5 * 1024 * 1024) {
    return sendJson(res, { error: 'Use an image under 5 MB.' }, 400);
  }

  const extension = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const objectPath = `${auth.userId}/${kind}-${Date.now()}.${extension}`;
  await supabaseStorageUpload(auth, objectPath, bytes, mimeType).catch((error) => {
    throw new Error(storageSetupMessage(error));
  });

  const publicUrl = `${requireKey('SUPABASE_URL').replace(/\/$/, '')}/storage/v1/object/public/branding-assets/${objectPath}`;
  const column = kind === 'logo' ? 'logo_url' : 'headshot_url';
  await supabaseRest(auth, '/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      id: auth.userId,
      email: auth.email || '',
      [column]: publicUrl,
      updated_at: new Date().toISOString()
    })
  }).catch(() => null);

  sendJson(res, { publicUrl });
}

async function handleCloudWorkspace(req, res) {
  const auth = getSupabaseRequestAuth(req);
  if (!auth.ok) return sendJson(res, { error: auth.error }, auth.status);
  const body = await readJson(req);
  const item = body.item || {};
  const itemKey = cleanString(item.key) || `${cleanString(item.type)}:${cleanString(item.address)}`;
  const row = {
    user_id: auth.userId,
    item_key: itemKey,
    type: cleanString(item.type),
    address: cleanString(item.address),
    key_value: cleanString(item.key),
    meta: cleanString(item.meta),
    payload: item.payload || {},
    saved_at: item.savedAt || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const rows = await supabaseRest(auth, '/rest/v1/workspace_items?on_conflict=user_id,item_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row)
  }).catch((error) => {
    throw new Error(cloudSetupMessage(error));
  });
  sendJson(res, { item: workspaceFromRow(rows?.[0] || row) });
}

async function handleCloudUsage(req, res) {
  const auth = getSupabaseRequestAuth(req);
  if (!auth.ok) return sendJson(res, { error: auth.error }, auth.status);
  const body = await readJson(req);
  const reportType = cleanString(body.reportType) || 'report';
  await supabaseRest(auth, '/rest/v1/usage_events', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: auth.userId,
      report_type: reportType,
      created_at: new Date().toISOString()
    })
  }).catch((error) => {
    throw new Error(cloudSetupMessage(error));
  });

  const rows = await supabaseRest(auth, `/rest/v1/profiles?id=eq.${encodeURIComponent(auth.userId)}&select=*`);
  const profile = rows?.[0] ? profileFromRow(rows[0]) : null;
  const nextCount = Number(profile?.reportCount || 0) + 1;
  const nextLimit = Number(profile?.reportLimit || 5);
  const nextStatus = profile?.status === 'active' ? 'active' : (nextCount >= nextLimit ? 'expired' : 'trial');
  const updated = await supabaseRest(auth, '/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      id: auth.userId,
      email: profile?.email || auth.email,
      name: profile?.name || '',
      brokerage: profile?.brokerage || '',
      phone: profile?.phone || '',
      license: profile?.license || '',
      logo_url: profile?.logoUrl || '',
      headshot_url: profile?.headshotUrl || '',
      plan: profile?.plan || 'trial',
      status: nextStatus,
      report_count: nextCount,
      report_limit: nextLimit,
      updated_at: new Date().toISOString()
    })
  });
  sendJson(res, { profile: profileFromRow(updated?.[0] || {}) });
}

function getSupabaseRequestAuth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false, status: 401, error: 'Sign in again to sync this account.' };
  const payload = decodeJwtPayload(token);
  if (!payload?.sub) return { ok: false, status: 401, error: 'Session could not be verified. Sign in again.' };
  return {
    ok: true,
    token,
    userId: payload.sub,
    email: payload.email || ''
  };
}

function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function supabaseRest(auth, pathName, options = {}) {
  const supabaseUrl = requireKey('SUPABASE_URL').replace(/\/$/, '');
  const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
  if (!supabaseKey) throw new Error('SUPABASE_ANON_KEY is missing. Add it to .env and restart the app.');
  return fetchJson(`${supabaseUrl}${pathName}`, {
    method: options.method || 'GET',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body
  });
}

async function supabaseStorageUpload(auth, objectPath, bytes, mimeType) {
  const supabaseUrl = requireKey('SUPABASE_URL').replace(/\/$/, '');
  const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
  if (!supabaseKey) throw new Error('SUPABASE_ANON_KEY is missing. Add it to .env and restart the app.');
  const response = await fetch(`${supabaseUrl}/storage/v1/object/branding-assets/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': mimeType,
      'x-upsert': 'true'
    },
    body: bytes
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data.msg || data.message || data.error || `Storage upload failed with ${response.status}`);
  }
  return data;
}

function profileFromRow(row) {
  return {
    email: row.email || '',
    name: row.name || '',
    brokerage: row.brokerage || '',
    phone: row.phone || '',
    license: row.license || '',
    logoUrl: row.logo_url || '',
    headshotUrl: row.headshot_url || '',
    status: row.status || 'trial',
    plan: row.plan || 'trial',
    reportCount: Number(row.report_count || 0),
    reportLimit: Number(row.report_limit || 5)
  };
}

function workspaceFromRow(row) {
  return {
    type: row.type || 'comps',
    address: row.address || '',
    key: row.key_value || row.item_key || '',
    meta: row.meta || '',
    savedAt: row.saved_at || row.updated_at,
    payload: row.payload || {}
  };
}

function cleanString(value) {
  return String(value || '').trim();
}

function cloudSetupMessage(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/relation .* does not exist|schema cache|workspace_items|usage_events|profiles/i.test(message)) {
    return 'Cloud sync tables are not installed yet. Run supabase/schema.sql in the Supabase SQL editor.';
  }
  return message || 'Cloud sync is unavailable right now.';
}

function storageSetupMessage(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/bucket|not found|row-level security|policy/i.test(message)) {
    return 'Branding uploads are not installed yet. Run the updated Supabase SQL setup, then try again.';
  }
  return message || 'Branding upload is unavailable right now.';
}

async function buildClientAnalysis({ address, metrics, comps }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return fallbackClientAnalysis({ address, metrics, comps });

  const response = await fetchJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are writing for a Realtor who needs to explain a CMA to a client in plain English. Return ONLY JSON with keys overview, pricing, compSupport, recommendation, note. Make the analysis specific to the subject address, estimated value, distance, sold window, and comparable sale details provided. Explain WHY the value makes sense, mention what could push value higher/lower, and give a practical next step. Each value must be 1-2 clear sentences. Avoid saying AI. Avoid legal/financial advice. Sound confident, premium, and understandable, but not absolute.'
        },
        {
          role: 'user',
          content: JSON.stringify({ address, metrics, comps })
        }
      ],
      max_tokens: 600
    })
  });
  const content = response.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
  return {
    overview: parsed.overview || '',
    pricing: parsed.pricing || '',
    compSupport: parsed.compSupport || '',
    recommendation: parsed.recommendation || '',
    note: parsed.note || ''
  };
}

async function buildPaymentAnalysis({ property, payment }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return fallbackPaymentAnalysis({ property, payment });

  const response = await fetchJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Write a polished, client-ready home payment summary. Return ONLY JSON with keys summary, paymentBreakdown, buyerNote, nextStep. Each value must be 1-2 short sentences. Avoid saying AI. Do not give financial advice or promise loan approval. Sound helpful, clear, and Realtor-friendly.'
        },
        {
          role: 'user',
          content: JSON.stringify({ property, payment })
        }
      ],
      max_tokens: 500
    })
  });
  const content = response.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
  const asSentence = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      const label = (key) => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (ch) => ch.toUpperCase());
      return Object.entries(value).map(([key, val]) => `${label(key)}: ${typeof val === 'number' ? formatCurrency(val) : val}`).join('; ');
    }
    return String(value);
  };
  return {
    summary: asSentence(parsed.summary),
    paymentBreakdown: asSentence(parsed.paymentBreakdown),
    buyerNote: asSentence(parsed.buyerNote),
    nextStep: asSentence(parsed.nextStep)
  };
}

async function buildTaxAnalysis({ property }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return fallbackTaxAnalysis({ property });

  const response = await fetchJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Write a concise, client-ready property tax summary for a real estate client. Return ONLY JSON with keys summary, assessment, buyerNote, verify. Each value must be 1-2 short sentences. Avoid saying AI. Do not give legal, tax, or financial advice. Make it useful for a Realtor to explain quickly.'
        },
        {
          role: 'user',
          content: JSON.stringify({ property })
        }
      ],
      max_tokens: 500
    })
  });
  const content = response.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
  return {
    summary: parsed.summary || '',
    assessment: parsed.assessment || '',
    buyerNote: parsed.buyerNote || '',
    verify: parsed.verify || ''
  };
}

function fallbackClientAnalysis({ address, metrics, comps }) {
  const count = comps.length;
  const range = metrics.low && metrics.high ? `${formatCurrency(metrics.low)} to ${formatCurrency(metrics.high)}` : 'the indicated comparable range';
  const value = metrics.avg ? formatCurrency(metrics.avg) : 'the indicated market value';
  const listingRange = metrics.listLow && metrics.listHigh ? `${formatCurrency(metrics.listLow)} to ${formatCurrency(metrics.listHigh)}` : range;
  return {
    overview: `${address} was reviewed against ${count} recent sold comparable properties within the selected market criteria.`,
    pricing: `The comparable set supports an estimated market value near ${value}, with observed comparable sales ranging from ${range}.`,
    compSupport: `The strongest support comes from the closest and most recent sales, with additional weight placed on similar size, bedroom count, condition indicators, and price per square foot.`,
    recommendation: `A practical client discussion range is ${listingRange}, with final positioning adjusted for property condition, updates, showing feedback, and current competition.`,
    note: 'This analysis is intended as a market guidance tool and should be reviewed alongside local expertise, property condition, and any MLS-specific information available.'
  };
}

function fallbackPaymentAnalysis({ property, payment }) {
  const address = property.address || 'this property';
  return {
    summary: `For ${address}, the estimated monthly payment is ${formatCurrency(payment.total)} based on the current calculator inputs.`,
    paymentBreakdown: `This estimate includes principal and interest, estimated property taxes, insurance, and HOA when entered.`,
    buyerNote: `The final payment can change based on lender terms, credit profile, taxes, insurance quotes, HOA dues, and closing details.`,
    nextStep: `Use this as a quick planning number, then confirm the full payment scenario with the buyer's lender before making final decisions.`
  };
}

function fallbackTaxAnalysis({ property }) {
  const annualTax = formatCurrency(property.annualTax);
  const assessed = formatCurrency(property.assessedValue);
  const taxYear = property.taxYear || 'the latest available tax year';
  const assessmentYear = property.assessmentYear || 'the latest available assessment year';
  return {
    summary: `${property.address} shows an annual property tax amount of ${annualTax} for ${taxYear}, based on the available public-record data.`,
    assessment: `The current assessed value shown is ${assessed} for ${assessmentYear}, with land and improvement values separated when available.`,
    buyerNote: 'For a buyer, this is useful for estimating ownership cost, but the actual future tax bill can change after purchase, exemption changes, or county reassessment.',
    verify: 'Before relying on this in final advice, confirm tax amounts, exemptions, ownership, and parcel details with the county tax office or appraisal district.'
  };
}

function formatCurrency(value) {
  if (!value) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function normalizeRentcastComps(data) {
  const raw = data.comparables || data.comps || data.saleComparables || [];
  const comps = raw.map((c) => ({
    address: c.formattedAddress || c.address || [c.addressLine1, c.city, c.state, c.zipCode].filter(Boolean).join(', ') || 'Comparable property',
    soldPrice: c.price || c.soldPrice || c.lastSalePrice || c.salePrice || c.value || null,
    sqft: c.squareFootage || c.livingArea || c.size || null,
    beds: c.bedrooms ?? c.beds ?? null,
    baths: c.bathrooms ?? c.baths ?? null,
    soldDate: c.soldDate || c.lastSaleDate || c.saleDate || c.listedDate || null,
    yearBuilt: c.yearBuilt || null,
    distance: c.distance || null,
    latitude: c.latitude || null,
    longitude: c.longitude || null
  })).filter((c) => c.soldPrice);
  return dedupeComparableProperties(comps);
}

function dedupeComparableProperties(comps) {
  const byKey = new Map();
  for (const comp of comps) {
    const key = comparableIdentityKey(comp);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, comp);
      continue;
    }
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
  return String(address || '')
    .toLowerCase()
    .replace(/\b(street|st|drive|dr|lane|ln|avenue|ave|road|rd|court|ct|boulevard|blvd|circle|cir|place|pl|trail|trl|north|south|east|west)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function mergeComparable(a, b) {
  const merged = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (merged[key] === null || merged[key] === undefined || merged[key] === '') merged[key] = value;
  }
  const aDistance = Number(a.distance);
  const bDistance = Number(b.distance);
  if (Number.isFinite(aDistance) && Number.isFinite(bDistance)) merged.distance = Math.min(aDistance, bDistance);
  if (b.soldDate && (!a.soldDate || new Date(b.soldDate) > new Date(a.soldDate))) merged.soldDate = b.soldDate;
  return merged;
}

function calculateQuickCompValue({ subject, comps, rentcastEstimate, rentcastLow, rentcastHigh }) {
  const subjectSqft = readNumber(subject, ['squareFootage', 'livingArea', 'buildingArea', 'livingSize']);
  const subjectYear = readNumber(subject, ['yearBuilt']);
  const subjectBeds = readNumber(subject, ['bedrooms', 'beds']);
  const subjectBaths = readNumber(subject, ['bathrooms', 'baths']);
  const validComps = comps
    .map((comp, index) => {
      const ppsf = comp.soldPrice && comp.sqft ? comp.soldPrice / comp.sqft : null;
      return { ...comp, originalRank: index, ppsf };
    })
    .filter((comp) => comp.soldPrice && comp.sqft && comp.ppsf);

  if (!subjectSqft || validComps.length < 3) {
    const estimate = rentcastEstimate || null;
    return {
      method: estimate ? 'rentcast_avm_fallback' : 'insufficient_data',
      estimate,
      low: rentcastLow || (estimate ? Math.round(estimate * 0.95 / 1000) * 1000 : null),
      high: rentcastHigh || (estimate ? Math.round(estimate * 1.05 / 1000) * 1000 : null),
      avgPpsf: null,
      lowPpsf: null,
      highPpsf: null,
      subjectSqft: subjectSqft || null,
      usedCompCount: validComps.length,
      excludedOutliers: 0,
      confidence: validComps.length ? 'limited' : 'low',
      rankedComps: comps
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
    ...comps.filter((comp) => !scored.some((ranked) => ranked.address === comp.address))
  ].map((comp) => ({
    ...comp,
    excludedAsOutlier: excludedAddresses.has(comp.address) || undefined,
    ppsf: comp.ppsf ? Math.round(comp.ppsf) : undefined
  })).slice(0, 12);

  return {
    method: 'weighted_sold_price_per_sqft',
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
    confidence: scored.length >= 8 ? 'strong' : scored.length >= 5 ? 'good' : 'limited',
    rankedComps
  };
}

function omitRankedComps(value) {
  const { rankedComps, ...rest } = value;
  return rest;
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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data.message || data.error || `Request failed with ${response.status}`);
  }
  return data;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return text;
}

function requireKey(name) {
  if (!process.env[name]) throw new Error(`${name} is missing. Add it to .env and restart the app.`);
  return process.env[name];
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function setCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
