// Generates SIMULATED municipality-level inequality data so the charts can be
// built before the real data arrives. Run from the repo root:
//
//   node scripts/simulate_data.js
//
// Output (the same format the real data should be delivered in):
//   data/indicators.json          indicator metadata (label, unit, file)
//   data/indicators/<id>.csv      one row per municipality, one column per year
//                                 code,2000,2001,...  (code = 6-digit ISTAT code,
//                                 plus a row "IT" for the national figure)
//
// Each municipality gets a log-normal income distribution whose mean and
// spread drift over time, so the Gini, top 1% share and bracket shares are
// consistent with each other. None of these numbers are real.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FIRST_YEAR = 2000;
const LAST_YEAR = 2024;
const YEARS = d3range(FIRST_YEAR, LAST_YEAR + 1);

const INDICATORS = [
  { id: "gini", label: "Gini index", unit: "index", format: ".3f", description: "Gini index of taxable income (0 = perfect equality, 1 = one person has everything)." },
  { id: "top1", label: "Top 1% income share", unit: "%", format: ".1f", description: "Share of total taxable income received by the top 1% of taxpayers." },
  { id: "bracket_0_15", label: "Taxpayers earning under €15,000", unit: "%", format: ".1f", description: "Share of taxpayers declaring less than €15,000." },
  { id: "bracket_15_28", label: "Taxpayers earning €15,000–28,000", unit: "%", format: ".1f", description: "Share of taxpayers declaring between €15,000 and €28,000." },
  { id: "bracket_28_50", label: "Taxpayers earning €28,000–50,000", unit: "%", format: ".1f", description: "Share of taxpayers declaring between €28,000 and €50,000." },
  { id: "bracket_50_plus", label: "Taxpayers earning over €50,000", unit: "%", format: ".1f", description: "Share of taxpayers declaring more than €50,000." }
];

// Rough north-south gradient in mean taxable income (euros, year 2000).
const REGION_MEAN_2000 = {
  "Lombardia": 21000, "Trentino-Alto Adige/Südtirol": 20500, "Emilia-Romagna": 20500,
  "Valle d'Aosta/Vallée d'Aoste": 20000, "Liguria": 19500, "Piemonte": 19500, "Veneto": 19500,
  "Friuli-Venezia Giulia": 19500, "Lazio": 19500, "Toscana": 19000, "Marche": 17500,
  "Umbria": 17500, "Abruzzo": 16000, "Sardegna": 15500, "Molise": 15000, "Campania": 15000,
  "Puglia": 14500, "Basilicata": 14500, "Sicilia": 14500, "Calabria": 13500
};

// Big cities: richer and more unequal than their surroundings.
const CITIES = {
  "058091": 1.0, "015146": 1.0, "063049": 0.9, "001272": 0.8, "082053": 0.8,
  "010025": 0.7, "037006": 0.7, "048017": 0.7, "027042": 0.6, "072006": 0.6,
  "083048": 0.5, "087015": 0.5, "023091": 0.5, "092009": 0.5
};

function d3range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; }

// Deterministic pseudo-random numbers so re-running gives the same data.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand) { return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand()); }

// Standard normal CDF and inverse (good enough for simulation).
function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function phiInv(p) {
  let lo = -8, hi = 8;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (phi(mid) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// Macro trend shared by all municipalities: nominal growth with the 2009 and
// 2012-13 recessions and the 2020 pandemic dip, plus slowly rising inequality.
function macro(year) {
  let income = 1;
  for (let y = FIRST_YEAR + 1; y <= year; y++) {
    const g = { 2009: -0.03, 2012: -0.015, 2013: -0.01, 2020: -0.04, 2021: 0.05, 2022: 0.04, 2023: 0.035 }[y];
    income *= 1 + (g !== undefined ? g : 0.018);
  }
  const t = year - FIRST_YEAR;
  const spread = 1 + 0.004 * t + (year >= 2009 ? 0.02 : 0) + (year === 2020 ? 0.015 : 0);
  return { income, spread };
}

function simulate(code, region) {
  const rand = rng(parseInt(code, 36));
  const city = CITIES[code] || 0;
  const mean0 = (REGION_MEAN_2000[region] || 17000) * (1 + 0.08 * gauss(rand)) * (1 + 0.25 * city);
  const sigma0 = Math.max(0.45, 0.76 + 0.05 * gauss(rand) + 0.15 * city);
  const drift = 0.002 * gauss(rand);
  const topBoost = 1.4 + 0.3 * city + 0.1 * rand();

  const rows = {};
  for (const ind of INDICATORS) rows[ind.id] = [];
  for (const year of YEARS) {
    const m = macro(year);
    const noise = 1 + 0.01 * gauss(rand);
    const sigma = sigma0 * m.spread * (1 + drift * (year - FIRST_YEAR)) * noise;
    const mean = mean0 * m.income * (1 + 0.015 * gauss(rand));
    const mu = Math.log(mean) - sigma * sigma / 2;
    const cdf = x => phi((Math.log(x) - mu) / sigma);

    const gini = 2 * phi(sigma / Math.SQRT2) - 1;
    const top1 = 100 * (1 - phi(phiInv(0.99) - sigma)) * topBoost;
    const b15 = cdf(15000), b28 = cdf(28000), b50 = cdf(50000);

    rows.gini.push(gini);
    rows.top1.push(top1);
    rows.bracket_0_15.push(100 * b15);
    rows.bracket_15_28.push(100 * (b28 - b15));
    rows.bracket_28_50.push(100 * (b50 - b28));
    rows.bracket_50_plus.push(100 * (1 - b50));
  }
  return rows;
}

const topo = JSON.parse(fs.readFileSync(path.join(ROOT, "data/comuni.topo.json")));
const comuni = topo.objects.comuni.geometries;

const out = {};
for (const ind of INDICATORS) out[ind.id] = [["code", ...YEARS].join(",")];

const national = {};
for (const ind of INDICATORS) national[ind.id] = YEARS.map(() => 0);

for (const g of comuni) {
  const rows = simulate(g.id, g.properties.reg);
  for (const ind of INDICATORS) {
    const decimals = ind.unit === "index" ? 3 : 1;
    out[ind.id].push([g.id, ...rows[ind.id].map(v => v.toFixed(decimals))].join(","));
    rows[ind.id].forEach((v, i) => { national[ind.id][i] += v / comuni.length; });
  }
}

fs.mkdirSync(path.join(ROOT, "data/indicators"), { recursive: true });
for (const ind of INDICATORS) {
  const decimals = ind.unit === "index" ? 3 : 1;
  out[ind.id].splice(1, 0, ["IT", ...national[ind.id].map(v => v.toFixed(decimals))].join(","));
  fs.writeFileSync(path.join(ROOT, `data/indicators/${ind.id}.csv`), out[ind.id].join("\n") + "\n");
}

fs.writeFileSync(path.join(ROOT, "data/indicators.json"), JSON.stringify({
  simulated: true,
  firstYear: FIRST_YEAR,
  lastYear: LAST_YEAR,
  indicators: INDICATORS.map(i => ({ ...i, file: `data/indicators/${i.id}.csv` }))
}, null, 2) + "\n");

console.log(`Wrote ${INDICATORS.length} indicators for ${comuni.length} municipalities, ${FIRST_YEAR}-${LAST_YEAR}.`);
