// Builds data/areas.topo.json: every Italian municipality, except the large
// cities that have several postcodes (CAP), which are split into CAP zones.
// Only needs re-running if the boundaries change.
//
// Sources:
//   Municipalities: openpolis/geojson-italy (ISTAT boundaries)
//     https://raw.githubusercontent.com/openpolis/geojson-italy/master/topojson/limits_IT_municipalities.topo.json
//   CAP zones: Zornade "Zone CAP sub-comunali" v2 (open data, attribution
//     required; includes OpenStreetMap data, ODbL)
//     https://zornade.com/data-downloads/  (shapefile: cap_subcomunali_italia.zip)
//
// From the repo root:
//   npm install --no-save d3-contour d3-delaunay d3-geo polygon-clipping shapefile topojson-client topojson-server topojson-simplify
//   node scripts/prepare_boundaries.js <limits_IT_municipalities.topo.json> <cap_subcom.shp>
//
// The Zornade zones are built from cadastral parcels, so each zone is a
// cloud of building blocks with gaps (streets) between them. To get solid
// zones that tile the city, each city is rebuilt on a ~100 m grid (every cell
// takes the CAP of the nearest parcel), then traced and clipped to the ISTAT
// city boundary so it lines up with its neighbours.
//
// Output features (object "areas"):
//   municipality: id = 6-digit ISTAT code, properties { type: "comune", name, prov, reg }
//   CAP zone:     id = 5-digit CAP, properties { type: "cap", name: CAP, city, cityCode, prov, reg }

const fs = require("fs");
const path = require("path");
const shapefile = require("shapefile");
const { Delaunay } = require("d3-delaunay");
const polygonClipping = require("polygon-clipping");
const { topology } = require("topojson-server");
const { presimplify, simplify, filter, filterWeight } = require("topojson-simplify");
const { quantize, feature } = require("topojson-client");
const { contours } = require("d3-contour");
const { geoArea } = require("d3-geo");

const CELL_M = 100; // grid cell size used to rebuild solid CAP zones
const SIMPLIFY_WEIGHT = 1e-6; // planar triangle area in degrees² below which points are dropped

async function main() {
  const [comuniPath, capPath] = process.argv.slice(2);
  if (!comuniPath || !capPath) {
    throw new Error("usage: node scripts/prepare_boundaries.js <limits_IT_municipalities.topo.json> <cap_subcom.shp>");
  }

  const comuniTopo = JSON.parse(fs.readFileSync(comuniPath));
  const comuni = feature(comuniTopo, comuniTopo.objects.comuni).features;

  // Parcel vertices per city, labelled with their CAP
  const source = await shapefile.open(capPath, capPath.replace(/\.shp$/, ".dbf"), { encoding: "windows-1252" });
  const cities = new Map(); // belfiore -> { caps: Set, points: [[lon, lat, cap]] }
  for (;;) {
    const r = await source.read();
    if (r.done) break;
    const p = r.value.properties;
    const g = r.value.geometry;
    if (!g || !p.cap) continue;
    if (!cities.has(p.codice_bel)) cities.set(p.codice_bel, { caps: new Set(), points: [] });
    const city = cities.get(p.codice_bel);
    city.caps.add(p.cap);
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const poly of polys) {
      // one labelled point per parcel: the average of its outer ring
      const ring = poly[0];
      let sx = 0, sy = 0;
      for (const [x, y] of ring) { sx += x; sy += y; }
      city.points.push([sx / ring.length, sy / ring.length, p.cap]);
    }
  }

  const features = [];
  let split = 0;
  for (const f of comuni) {
    const p = f.properties;
    const city = cities.get(p.com_catasto_code);
    if (!city || city.caps.size < 2) {
      features.push({
        type: "Feature",
        id: p.com_istat_code,
        properties: { type: "comune", name: p.name, prov: p.prov_acr, reg: p.reg_name },
        geometry: f.geometry
      });
      continue;
    }
    split++;
    for (const [cap, geometry] of capZones(f.geometry, city.points)) {
      features.push({
        type: "Feature",
        id: cap,
        properties: { type: "cap", name: cap, city: p.name, cityCode: p.com_istat_code, prov: p.prov_acr, reg: p.reg_name },
        geometry
      });
    }
  }

  let topo = topology({ areas: { type: "FeatureCollection", features } }, 1e6);
  topo = presimplify(topo);
  topo = simplify(topo, SIMPLIFY_WEIGHT);
  topo = filter(topo, filterWeight(topo, 0));
  topo = quantize(topo, 2e4);
  fixWinding(topo);

  const out = path.join(__dirname, "..", "data", "areas.topo.json");
  fs.writeFileSync(out, JSON.stringify(topo));
  const n = topo.objects.areas.geometries.length;
  console.log(`Wrote ${n} areas (${split} cities split into CAP zones) to ${out} (${fs.statSync(out).size} bytes)`);
}

// Solid CAP zones for one city. The city's bounding box is covered with a
// grid of ~CELL_M metre cells; each cell takes the CAP of the nearest parcel,
// a majority filter removes speckle, each CAP's cells are traced into
// outlines (marching squares) and the result is clipped to the city boundary.
function capZones(cityGeometry, points) {
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

  // Nearest labelled point for every cell centre
  const caps = Array.from(new Set(points.map(d => d[2])));
  const capIndex = new Map(caps.map((c, i) => [c, i]));
  const delaunay = Delaunay.from(points, d => d[0], d => d[1]);
  let grid = new Int32Array(nx * ny);
  let hint = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      hint = delaunay.find(x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dy, hint);
      grid[j * nx + i] = capIndex.get(points[hint][2]);
    }
  }

  // Majority filter (3x3), a few passes
  for (let pass = 0; pass < 3; pass++) {
    const next = new Int32Array(grid);
    const counts = new Map();
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        counts.clear();
        for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) {
          const c = grid[(j + v) * nx + i + u];
          counts.set(c, (counts.get(c) || 0) + 1);
        }
        let best = grid[j * nx + i], bestN = 0;
        counts.forEach((n, c) => { if (n > bestN) { best = c; bestN = n; } });
        if (bestN >= 5) next[j * nx + i] = best;
      }
    }
    grid = next;
  }

  // Trace each CAP and clip it to the city
  const tracer = contours().size([nx, ny]).thresholds([0.5]);
  const zones = [];
  caps.forEach((cap, k) => {
    const mask = new Float64Array(nx * ny);
    let any = false;
    for (let n = 0; n < mask.length; n++) if (grid[n] === k) { mask[n] = 1; any = true; }
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
function fixWinding(topo) {
  const reverseRing = ring => ring.slice().reverse().map(i => ~i);
  for (const g of topo.objects.areas.geometries) {
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
