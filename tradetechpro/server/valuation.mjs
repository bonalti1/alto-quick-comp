/*
 * Quick Comp valuation engine — sold-comparable math, CMA-style.
 *
 * Upgrades over the original weighted-$/sqft blend, all computed from data
 * the comps already carry (no new API fields):
 *
 *   1. TIME INDEXING — the comp set's own $/sqft-vs-sold-date trend re-prices
 *      stale sales to today (capped ±1%/month), so a 2-year lookback in a
 *      moving market no longer drags the number.
 *   2. ADJUSTED PRICES, not raw $/sqft — each comp is valued as
 *      timeAdjPrice + (subjectSqft − compSqft) × ~45% of $/sqft (the
 *      appraiser's marginal-sqft rule), removing the small-home/big-home bias.
 *   3. HARD GATES before weighting — same property type and GLA within ±35%
 *      (relaxed automatically if they'd leave fewer than 3 comps), plus a
 *      non-arm's-length screen (sub-40%-of-median sales = family transfers).
 *   4. HONEST CONFIDENCE — comp count × price dispersion × radius/lookback
 *      penalties, not count alone.
 *   5. PER-COMP OUTPUT (adjValue, weight, reasons) so the app can let the
 *      realtor exclude comps and recompute the value live — same math.
 */

export function normalizeRentcastComps(data) {
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
    propertyType: c.propertyType || c.propertyUse || c.type || null,
  })).filter((c) => c.soldPrice);
  return dedupeComparableProperties(comps);
}

export function dedupeComparableProperties(comps) {
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

/* Broad type buckets: an appraiser wouldn't comp a condo against a house,
 * but "Single Family" vs "Single Family Residence" is the same thing. */
function typeBucket(t) {
  const s = String(t || "").toLowerCase();
  if (!s) return null;
  if (/condo|apart/.test(s)) return "condo";
  if (/town|row/.test(s)) return "town";
  if (/manufactured|mobile/.test(s)) return "manufactured";
  if (/multi|duplex|triplex|fourplex/.test(s)) return "multi";
  if (/land|lot/.test(s)) return "land";
  if (/single|residen|house|sfr/.test(s)) return "sfr";
  return "other";
}

function monthsAgo(soldDate, now) {
  if (!soldDate) return null;
  const d = new Date(soldDate);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, (now - d.getTime()) / (30.44 * 86400000));
}

/* Market drift per month, from the comp set's own $/sqft vs months-ago
 * (least-squares slope, relative to median $/sqft, capped ±1%/mo). Needs 4+
 * dated comps spanning 3+ months — otherwise no adjustment. */
function marketDriftPerMonth(comps, now) {
  const pts = comps
    .map((c) => ({ m: monthsAgo(c.soldDate, now), p: c.ppsf }))
    .filter((x) => x.m !== null && x.p);
  if (pts.length < 4) return 0;
  const span = Math.max(...pts.map((x) => x.m)) - Math.min(...pts.map((x) => x.m));
  if (span < 3) return 0;
  const mMean = pts.reduce((s, x) => s + x.m, 0) / pts.length;
  const pMean = pts.reduce((s, x) => s + x.p, 0) / pts.length;
  let num = 0, den = 0;
  for (const x of pts) { num += (x.m - mMean) * (x.p - pMean); den += (x.m - mMean) ** 2; }
  if (!den) return 0;
  const slope = num / den; // $/sqft change per month-AGO (negative slope = rising market)
  const med = median(pts.map((x) => x.p).sort((a, b) => a - b)) || pMean;
  if (!med) return 0;
  // convert to "market moves +x%/month toward today"
  return clamp(-slope / med, -0.01, 0.01);
}

export function calculateQuickCompValue({ subject, comps, rentcastEstimate, rentcastLow, rentcastHigh, usedRadius = 2, usedDays = 183, now = Date.now() }) {
  const subjectSqft = readNumber(subject, ["squareFootage", "livingArea", "buildingArea", "livingSize"]);
  const subjectYear = readNumber(subject, ["yearBuilt"]);
  const subjectBeds = readNumber(subject, ["bedrooms", "beds"]);
  const subjectBaths = readNumber(subject, ["bathrooms", "baths"]);
  const subjectType = typeBucket(subject?.propertyType);

  let validComps = comps
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
      avgPpsf: null, lowPpsf: null, highPpsf: null,
      subjectSqft: subjectSqft || null,
      usedCompCount: validComps.length,
      excludedOutliers: 0,
      confidence: validComps.length ? "limited" : "low",
      rankedComps: comps,
    };
  }

  const dropReasons = new Map(); // address -> reason
  const drop = (arr, pred, reason) => arr.filter((c) => {
    if (pred(c)) return true;
    if (!dropReasons.has(c.address)) dropReasons.set(c.address, reason);
    return false;
  });

  // HARD GATES — only enforced when 3+ comps survive them (thin markets relax)
  if (subjectType) {
    const sameType = drop(validComps, (c) => !typeBucket(c.propertyType) || typeBucket(c.propertyType) === subjectType, "type");
    if (sameType.length >= 3) validComps = sameType; else sameType.forEach(() => {});
  }
  const sized = drop(validComps, (c) => Math.abs(c.sqft - subjectSqft) / subjectSqft <= 0.35, "size");
  if (sized.length >= 3) validComps = sized;

  // Non-arm's-length screen (family transfers, deed corrections): a "sale" at
  // under 40% of the set's median $/sqft is not market evidence.
  const medAll = median(validComps.map((c) => c.ppsf).sort((a, b) => a - b));
  if (validComps.length >= 4 && medAll) {
    const armsLength = drop(validComps, (c) => c.ppsf >= medAll * 0.4, "non_arms_length");
    if (armsLength.length >= 3) validComps = armsLength;
  }

  // Price-per-sqft outlier trim around the median (as before)
  const ppsfs = validComps.map((comp) => comp.ppsf).sort((a, b) => a - b);
  const medianPpsf = median(ppsfs);
  const filtered = validComps.length >= 5
    ? drop(validComps, (comp) => comp.ppsf >= medianPpsf * 0.75 && comp.ppsf <= medianPpsf * 1.25, "price_outlier")
    : validComps;
  const used = filtered.length >= 3 ? filtered : validComps;

  // TIME INDEXING — re-price each comp to today using the set's own trend
  const drift = marketDriftPerMonth(used, now);
  const timed = used.map((comp) => {
    const m = monthsAgo(comp.soldDate, now);
    const timeAdjPct = m === null ? 0 : clamp(drift * m, -0.25, 0.25);
    const adjPpsf = comp.ppsf * (1 + timeAdjPct);
    return { ...comp, timeAdjPct, adjPpsf, adjSoldPrice: comp.soldPrice * (1 + timeAdjPct) };
  });

  // Weights — distance normalized to the radius that was actually needed
  const distCap = Math.max(1, usedRadius * 1.2);
  const scored = timed.map((comp) => {
    const distanceWeight = scoreCloseness(Number(comp.distance), 0, distCap, 0.55, 1.4);
    const sqftDiff = Math.abs(comp.sqft - subjectSqft) / subjectSqft;
    const sqftWeight = clamp(1.35 - sqftDiff * 1.6, 0.45, 1.35);
    const yearDiff = subjectYear && comp.yearBuilt ? Math.abs(comp.yearBuilt - subjectYear) : null;
    const yearWeight = yearDiff === null ? 0.9 : clamp(1.2 - yearDiff / 45, 0.55, 1.2);
    const bedWeight = subjectBeds && comp.beds ? clamp(1.08 - Math.abs(comp.beds - subjectBeds) * 0.12, 0.72, 1.08) : 0.95;
    const bathWeight = subjectBaths && comp.baths ? clamp(1.08 - Math.abs(comp.baths - subjectBaths) * 0.12, 0.72, 1.08) : 0.95;
    const recencyWeight = scoreRecency(comp.soldDate, now);
    const weight = distanceWeight * sqftWeight * yearWeight * bedWeight * bathWeight * recencyWeight;
    const matchScore = Math.round(clamp(weight / 2.6, 0.45, 0.98) * 100);
    // ADJUSTED PRICE — appraiser's marginal-sqft rule (~45% of $/sqft):
    // what this comp says the SUBJECT is worth.
    const adjValue = comp.adjSoldPrice + (subjectSqft - comp.sqft) * 0.45 * comp.adjPpsf;
    return { ...comp, weight, matchScore, adjValue };
  }).sort((a, b) => b.weight - a.weight);

  const totalWeight = scored.reduce((sum, comp) => sum + comp.weight, 0);
  const estimateRaw = totalWeight
    ? scored.reduce((sum, comp) => sum + comp.adjValue * comp.weight, 0) / totalWeight
    : medianPpsf * subjectSqft;
  const avgPpsf = estimateRaw / subjectSqft;

  // Range from the actual dispersion of what the comps say (±4%..±12%)
  const variance = totalWeight
    ? scored.reduce((sum, comp) => sum + comp.weight * (comp.adjValue - estimateRaw) ** 2, 0) / totalWeight
    : 0;
  const spread = clamp(Math.sqrt(variance) / estimateRaw || 0.08, 0.04, 0.12);
  const estimate = roundToNearest(estimateRaw, 1000);
  const low = roundToNearest(estimateRaw * (1 - spread), 1000);
  const high = roundToNearest(estimateRaw * (1 + spread), 1000);

  // HONEST CONFIDENCE — count, dispersion, and how far the net was cast
  let score = scored.length >= 8 ? 3 : scored.length >= 5 ? 2 : 1;
  if (spread > 0.1) score -= 1;
  if (usedRadius > 2) score -= 1;
  if (usedDays > 365) score -= 1;
  const confidence = score >= 3 ? "strong" : score === 2 ? "good" : score === 1 ? "limited" : "low";

  const rankedComps = [
    ...scored,
    ...comps.filter((comp) => !scored.some((ranked) => ranked.address === comp.address)),
  ].map((comp) => ({
    ...comp,
    excludedAsOutlier: dropReasons.has(comp.address) || undefined,
    excludedReason: dropReasons.get(comp.address) || undefined,
    ppsf: comp.ppsf ? Math.round(comp.ppsf) : undefined,
    adjPpsf: comp.adjPpsf ? Math.round(comp.adjPpsf) : undefined,
    adjValue: comp.adjValue ? Math.round(comp.adjValue) : undefined,
    weight: comp.weight ? +comp.weight.toFixed(3) : undefined,
    timeAdjPct: comp.timeAdjPct ? +comp.timeAdjPct.toFixed(4) : undefined,
  })).slice(0, 12);

  return {
    method: "adjusted_sold_comparables",
    estimate, low, high,
    avgPpsf: Math.round(avgPpsf),
    lowPpsf: Math.round(avgPpsf * (1 - spread)),
    highPpsf: Math.round(avgPpsf * (1 + spread)),
    subjectSqft,
    subjectYear: subjectYear || null,
    usedCompCount: scored.length,
    excludedOutliers: dropReasons.size,
    marketDriftMo: +drift.toFixed(4),
    spread: +spread.toFixed(3),
    confidence,
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

function scoreRecency(soldDate, now = Date.now()) {
  if (!soldDate) return 0.95;
  const date = new Date(soldDate);
  if (Number.isNaN(date.getTime())) return 0.95;
  const days = Math.max(0, (now - date.getTime()) / 86400000);
  return clamp(1.18 - days / 1600, 0.65, 1.18);
}

function roundToNearest(value, nearest) {
  return Math.round(value / nearest) * nearest;
}
