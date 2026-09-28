// Builds the map files. Only needs re-running if the boundaries change.
//
//   data/comuni.topo.json          every Italian municipality (Italy map)
//   data/cities.json               the cities that have several postcodes (CAP),
//                                  with their CAP list and map file
//   data/cities/<ISTAT>.topo.json  one map per city, split into CAP zones
//
// Sources:
//   Municipalities: openpolis/geojson-italy (ISTAT boundaries)
//     https://raw.githubusercontent.com/openpolis/geojson-italy/master/topojson/limits_IT_municipalities.topo.json
//   CAP zones: Zornade "Zone CAP sub-comunali" v2 (open data, attribution
//     required; includes OpenStreetMap data, ODbL)
//     https://zornade.com/data-downloads/  (shapefile: cap_subcomunali_italia.zip)
//
// From the repo root:
//   npm install --no-save d3-contour d3-geo polygon-clipping shapefile topojson-client topojson-server topojson-simplify
//   node scripts/prepare_boundaries.js <limits_IT_municipalities.topo.json> <cap_subcom.shp>
//
// The Zornade zones are built from cadastral parcels, so each zone is a
// cloud of building blocks with gaps (streets, parks) between them. To get
// solid zones that tile the city, each city is rebuilt on a CELL_M grid:
// cells inside a parcel take that parcel's CAP, every other cell takes the
// CAP of the nearest parcel, and the zones are traced from the grid and
// clipped to the ISTAT city boundary.

const fs = require("fs");
const path = require("path");
const shapefile = require("shapefile");
const polygonClipping = require("polygon-clipping");
const { contours } = require("d3-contour");
const { geoArea } = require("d3-geo");
const { topology } = require("topojson-server");
const { presimplify, simplify, quantile, filter, filterWeight } = require("topojson-simplify");
const { quantize, feature } = require("topojson-client");

const DATA = path.join(__dirname, "..", "data");
const CELL_M = 25; // grid cell size for rebuilding CAP zones
const CITY_SIMPLIFY = 2e-9; // planar triangle area (degrees²) below which city map points are dropped

async function main() {
  const [comuniPath, capPath] = process.argv.slice(2);
  if (!comuniPath || !capPath) {
    throw new Error("usage: node scripts/prepare_boundaries.js <limits_IT_municipalities.topo.json> <cap_subcom.shp>");
  }

  const comuniTopo = JSON.parse(fs.readFileSync(comuniPath));
  writeItalyMap(comuniTopo);

  // Parcels per city, labelled with their CAP
  const comuni = feature(comuniTopo, comuniTopo.objects.comuni).features;
  const source = await shapefile.open(capPath, capPath.replace(/\.shp$/, ".dbf"), { encoding: "windows-1252" });
  const parcels = new Map(); // belfiore -> { caps: Set, rings: [[ring, cap]] }
  for (;;) {
    const r = await source.read();
    if (r.done) break;
    const p = r.value.properties;
    const g = r.value.geometry;
    if (!g || !p.cap) continue;
    if (!parcels.has(p.codice_bel)) parcels.set(p.codice_bel, { caps: new Set(), rings: [] });
    const city = parcels.get(p.codice_bel);
    city.caps.add(p.cap);
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const poly of polys) city.rings.push([poly[0], p.cap]);
  }

  fs.mkdirSync(path.join(DATA, "cities"), { recursive: true });
  const index = [];
  for (const f of comuni) {
    const p = f.properties;
    const city = parcels.get(p.com_catasto_code);
    if (!city || city.caps.size < 2) continue;
    const zones = capZones(f.geometry, city.rings);
    const file = `data/cities/${p.com_istat_code}.topo.json`;
    const features = zones.map(([cap, geometry]) => ({ type: "Feature", id: cap, properties: {}, geometry }));
    let topo = topology({ zones: { type: "FeatureCollection", features } }, 1e6);
    topo = presimplify(topo);
    topo = simplify(topo, CITY_SIMPLIFY);
    topo = filter(topo, filterWeight(topo, 0));
    topo = quantize(topo, 1e5);
    fixWinding(topo, "zones");
    fs.writeFileSync(path.join(__dirname, "..", file), JSON.stringify(topo));
    index.push({
      code: p.com_istat_code,
      name: p.name,
      prov: p.prov_acr,
      reg: p.reg_name,
      file,
      zones: zones.map(z => z[0]).sort()
    });
    console.log(`${p.name}: ${zones.length} zones, ${fs.statSync(path.join(__dirname, "..", file)).size} bytes`);
  }
  index.sort((a, b) => a.name.localeCompare(b.name, "it"));
  fs.writeFileSync(path.join(DATA, "cities.json"), JSON.stringify(index, null, 1) + "\n");
  console.log(`Wrote ${index.length} city maps`);
}

// Italy map: every municipality, simplified
function writeItalyMap(source) {
  let topo = JSON.parse(JSON.stringify(source));
  topo = presimplify(topo);
  topo = simplify(topo, quantile(topo, 0.05));
  topo = filter(topo, filterWeight(topo, 0));
  for (const g of topo.objects.comuni.geometries) {
    const p = g.properties;
    g.id = p.com_istat_code;
    g.properties = { name: p.name, prov: p.prov_acr, reg: p.reg_name };
  }
  topo = quantize(topo, 1e4);
  fixWinding(topo, "comuni");
  const out = path.join(DATA, "comuni.topo.json");
  fs.writeFileSync(out, JSON.stringify(topo));
  console.log(`Italy map: ${topo.objects.comuni.geometries.length} municipalities, ${fs.statSync(out).size} bytes`);
}

// Solid CAP zones for one city, from its labelled parcel rings
function capZones(cityGeometry, rings) {
  const cityPolys = cityGeometry.type === "Polygon" ? [cityGeometry.coordinates] : cityGeometry.coordinates;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  cityPolys.forEach(poly => poly[0].forEach(([x, y]) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }));
  const dy = CELL_M / 111320;
  const dx = dy / Math.cos(((y0 + y1) / 2) * Math.PI / 180);
  x0 -= 2 * dx; y0 -= 2 * dy; x1 += 2 * dx; y1 += 2 * dy;
  const nx = Math.ceil((x1 - x0) / dx);
  const ny = Math.ceil((y1 - y0) / dy);

  const caps = Array.from(new Set(rings.map(r => r[1]))).sort();
  const capIndex = new Map(caps.map((c, i) => [c, i]));
  const grid = new Int16Array(nx * ny).fill(-1);

  // 1. Cells whose centre is inside a parcel take its CAP (scanline fill)
  for (const [ring, cap] of rings) {
    const k = capIndex.get(cap);
    let ry0 = Infinity, ry1 = -Infinity;
    for (const [, y] of ring) { ry0 = Math.min(ry0, y); ry1 = Math.max(ry1, y); }
    const j0 = Math.max(0, Math.ceil((ry0 - y0) / dy - 0.5));
    const j1 = Math.min(ny - 1, Math.floor((ry1 - y0) / dy - 0.5));
    for (let j = j0; j <= j1; j++) {
      const cy = y0 + (j + 0.5) * dy;
      const xs = [];
      for (let n = 0, m = ring.length - 1; n < ring.length; m = n++) {
        const [ax, ay] = ring[m], [bx, by] = ring[n];
        if ((ay > cy) !== (by > cy)) xs.push(ax + (cy - ay) / (by - ay) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil((xs[q] - x0) / dx - 0.5));
        const i1 = Math.min(nx - 1, Math.floor((xs[q + 1] - x0) / dx - 0.5));
        for (let i = i0; i <= i1; i++) grid[j * nx + i] = k;
      }
    }
  }

  // 2. Every other cell takes the CAP of the nearest labelled cell (breadth-first)
  const queue = new Int32Array(nx * ny);
  let head = 0, tail = 0;
  for (let n = 0; n < grid.length; n++) if (grid[n] >= 0) queue[tail++] = n;
  while (head < tail) {
    const n = queue[head++];
    const i = n % nx, j = (n - i) / nx, k = grid[n];
    if (i > 0 && grid[n - 1] < 0) { grid[n - 1] = k; queue[tail++] = n - 1; }
    if (i < nx - 1 && grid[n + 1] < 0) { grid[n + 1] = k; queue[tail++] = n + 1; }
    if (j > 0 && grid[n - nx] < 0) { grid[n - nx] = k; queue[tail++] = n - nx; }
    if (j < ny - 1 && grid[n + nx] < 0) { grid[n + nx] = k; queue[tail++] = n + nx; }
  }

  // 3. One majority pass (3x3) to smooth single-cell jaggies
  const smooth = new Int16Array(grid);
  const counts = new Int32Array(caps.length);
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      let best = grid[j * nx + i], bestN = 0;
      for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) counts[grid[(j + v) * nx + i + u]]++;
      for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) {
        const c = grid[(j + v) * nx + i + u];
        if (counts[c] > bestN) { best = c; bestN = counts[c]; }
      }
      for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) counts[grid[(j + v) * nx + i + u]] = 0;
      if (bestN >= 5) smooth[j * nx + i] = best;
    }
  }

  // 4. Trace each CAP and clip it to the city boundary
  const tracer = contours().size([nx, ny]).thresholds([0.5]);
  const mask = new Float64Array(nx * ny);
  const zones = [];
  caps.forEach((cap, k) => {
    let any = false;
    for (let n = 0; n < mask.length; n++) { const on = smooth[n] === k; mask[n] = on ? 1 : 0; any = any || on; }
    if (!any) return;
    const traced = tracer(mask)[0].coordinates.map(poly =>
      poly.map(ring => ring.map(([gx, gy]) => [x0 + gx * dx, y0 + gy * dy])));
    const clipped = polygonClipping.intersection(traced, cityPolys);
    if (clipped.length) zones.push([cap, { type: "MultiPolygon", coordinates: clipped }]);
  });
  return zones;
}

// d3 treats rings as clockwise-exterior; flip any polygon that comes out
// covering more than half the sphere.
function fixWinding(topo, name) {
  const reverseRing = ring => ring.slice().reverse().map(i => ~i);
  for (const g of topo.objects[name].geometries) {
    const polys = g.type === "Polygon" ? [g.arcs] : g.type === "MultiPolygon" ? g.arcs : [];
    polys.forEach((rings, pi) => {
      if (geoArea(feature(topo, { type: "Polygon", arcs: rings })) > 2 * Math.PI) {
        const fixed = rings.map(reverseRing);
        if (g.type === "Polygon") g.arcs = fixed;
        else g.arcs[pi] = fixed;
      }
    });
  }
}

main().catch(err => { console.error(err); process.exit(1); });
