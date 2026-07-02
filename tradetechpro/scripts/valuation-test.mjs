/*
 * Valuation engine tests — synthetic comp sets that assert the CMA-style
 * behaviors a realtor expects. Run: node scripts/valuation-test.mjs
 */
import { calculateQuickCompValue } from "../server/valuation.mjs";

let failures = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}${extra ? ` (${extra})` : ""}`);
  if (!cond) failures++;
};

const NOW = new Date("2026-07-01").getTime();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString().slice(0, 10);
const subject = { squareFootage: 1800, yearBuilt: 2005, bedrooms: 3, bathrooms: 2, propertyType: "Single Family" };
const comp = (over = {}) => ({
  address: over.address || `${Math.floor(Math.random() * 900) + 100} Test St, TX`,
  soldPrice: 360000, sqft: 1800, beds: 3, baths: 2, yearBuilt: 2005,
  soldDate: daysAgo(60), distance: 0.5, propertyType: "Single Family", ...over,
});

console.log("baseline: clean recent set");
{
  const comps = [1, 2, 3, 4, 5, 6].map((i) => comp({ address: `${i} Base St`, soldPrice: 350000 + i * 4000, soldDate: daysAgo(30 + i * 10) }));
  const r = calculateQuickCompValue({ subject, comps, now: NOW });
  ok(r.method === "adjusted_sold_comparables", "uses adjusted-comparables method");
  ok(r.estimate > 330000 && r.estimate < 400000, "estimate in sane band", `$${r.estimate}`);
  ok(["good", "strong"].includes(r.confidence), "tight recent set earns good+ confidence", r.confidence);
}

console.log("time indexing: rising market re-prices stale comps upward");
{
  // market rising ~1%/mo: old sales cheap, recent sales dear
  const comps = [0, 3, 6, 9, 12, 15].map((m, i) => comp({
    address: `${i} Trend St`, soldDate: daysAgo(m * 30),
    soldPrice: Math.round(360000 * (1 - 0.01 * m)),
  }));
  const r = calculateQuickCompValue({ subject, comps, now: NOW });
  const naiveAvg = comps.reduce((s, c) => s + c.soldPrice, 0) / comps.length;
  ok(r.marketDriftMo > 0.004, "detects upward drift", `${(r.marketDriftMo * 100).toFixed(2)}%/mo`);
  ok(r.estimate > naiveAvg * 1.02, "estimate above naive stale average", `$${r.estimate} vs $${Math.round(naiveAvg)}`);
}

console.log("size bias: small high-$/sqft comps no longer inflate a big subject");
{
  const bigSubject = { ...subject, squareFootage: 2800 };
  // small homes at $250/sqft — naive ppsf math would say 2800*250 = $700k
  const comps = [1, 2, 3, 4, 5].map((i) => comp({ address: `${i} Small St`, sqft: 1900, soldPrice: 1900 * 250 + i * 1000 }));
  const r = calculateQuickCompValue({ subject: bigSubject, comps, now: NOW });
  const naive = 2800 * 250;
  ok(r.estimate < naive * 0.93, "marginal-sqft rule discounts the extra area", `$${r.estimate} vs naive $${naive}`);
}

console.log("hard gates: wrong type + non-arm's-length dropped, with reasons");
{
  const comps = [
    comp({ address: "1 Good St" }), comp({ address: "2 Good St", soldPrice: 355000 }),
    comp({ address: "3 Good St", soldPrice: 372000 }), comp({ address: "4 Good St", soldPrice: 349000 }),
    comp({ address: "9 Condo Ct", propertyType: "Condo", soldPrice: 210000, sqft: 1100 }),
    comp({ address: "7 Family Gift Ln", soldPrice: 20000 }), // family transfer
  ];
  const r = calculateQuickCompValue({ subject, comps, now: NOW });
  const reasons = Object.fromEntries(r.rankedComps.filter((c) => c.excludedReason).map((c) => [c.address, c.excludedReason]));
  ok(reasons["9 Condo Ct"] === "type", "condo excluded from SFR subject", reasons["9 Condo Ct"]);
  ok(["non_arms_length", "price_outlier"].includes(reasons["7 Family Gift Ln"]), "$20k transfer excluded", reasons["7 Family Gift Ln"]);
  ok(r.usedCompCount === 4, "only the 4 real comps price the home", String(r.usedCompCount));
}

console.log("honest confidence: wide-net searches get downgraded");
{
  const comps = [1, 2, 3, 4, 5].map((i) => comp({ address: `${i} Far St`, soldPrice: 350000 + i * 5000 }));
  const near = calculateQuickCompValue({ subject, comps, usedRadius: 2, usedDays: 183, now: NOW });
  const far = calculateQuickCompValue({ subject, comps, usedRadius: 10, usedDays: 730, now: NOW });
  const rank = { low: 0, limited: 1, good: 2, strong: 3 };
  ok(rank[far.confidence] < rank[near.confidence], "10mi/2yr < 2mi/6mo confidence", `${near.confidence} -> ${far.confidence}`);
}

console.log("exclusion parity: client recompute from per-comp output matches engine");
{
  const comps = [1, 2, 3, 4, 5, 6].map((i) => comp({ address: `${i} Parity St`, soldPrice: 340000 + i * 9000, soldDate: daysAgo(20 + i * 25) }));
  const r = calculateQuickCompValue({ subject, comps, now: NOW });
  const included = r.rankedComps.filter((c) => !c.excludedAsOutlier && c.adjValue && c.weight);
  const tw = included.reduce((s, c) => s + c.weight, 0);
  const recomputed = Math.round(included.reduce((s, c) => s + c.adjValue * c.weight, 0) / tw / 1000) * 1000;
  ok(Math.abs(recomputed - r.estimate) <= 1000, "weighted recompute ≈ engine estimate", `$${recomputed} vs $${r.estimate}`);
}

console.log("fallback: thin data still answers via AVM");
{
  const r = calculateQuickCompValue({ subject, comps: [comp()], rentcastEstimate: 300000, now: NOW });
  ok(r.method === "rentcast_avm_fallback" && r.estimate === 300000, "AVM fallback under 3 comps");
}

console.log(failures === 0 ? "\nALL VALUATION TESTS PASSED ✅" : `\n${failures} FAILURE(S) ❌`);
process.exit(failures ? 1 : 0);
