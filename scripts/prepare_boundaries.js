// Builds data/comuni.topo.json (municipality boundaries) from the openpolis
// TopoJSON. Only needs re-running if the boundaries change. From the repo root:
//
//   curl -L -o /tmp/muni.topo.json https://raw.githubusercontent.com/openpolis/geojson-italy/master/topojson/limits_IT_municipalities.topo.json
//   npm install --no-save d3-geo topojson-client topojson-simplify
//   node scripts/prepare_boundaries.js /tmp/muni.topo.json
//
// It simplifies the shapes, keeps only the properties the site uses
// (id = 6-digit ISTAT code, name, province, region) and fixes the ring
// winding order that d3 expects (otherwise every shape covers the globe).

const fs = require("fs");
const path = require("path");
const { presimplify, simplify, quantile, filter, filterWeight } = require("topojson-simplify");
const { quantize, feature } = require("topojson-client");
const { geoArea } = require("d3-geo");

const input = process.argv[2];
if (!input) throw new Error("usage: node scripts/prepare_boundaries.js <limits_IT_municipalities.topo.json>");

let topo = JSON.parse(fs.readFileSync(input));
topo = presimplify(topo);
topo = simplify(topo, quantile(topo, 0.05));
topo = filter(topo, filterWeight(topo, 0));

for (const g of topo.objects.comuni.geometries) {
  const p = g.properties;
  g.id = p.com_istat_code;
  g.properties = { name: p.name, prov: p.prov_acr, reg: p.reg_name };
}

topo = quantize(topo, 1e4);

// d3 treats rings as clockwise-exterior; flip any polygon that comes out
// covering more than half the sphere.
const reverseRing = ring => ring.slice().reverse().map(i => ~i);
for (const g of topo.objects.comuni.geometries) {
  const polys = g.type === "Polygon" ? [g.arcs] : g.type === "MultiPolygon" ? g.arcs : [];
  polys.forEach((rings, pi) => {
    const f = feature(topo, { type: "Polygon", arcs: rings });
    if (geoArea(f) > 2 * Math.PI) {
      const fixed = rings.map(reverseRing);
      if (g.type === "Polygon") g.arcs = fixed;
      else g.arcs[pi] = fixed;
    }
  });
}

const out = path.join(__dirname, "..", "data", "comuni.topo.json");
fs.writeFileSync(out, JSON.stringify(topo));
console.log(`Wrote ${topo.objects.comuni.geometries.length} municipalities to ${out} (${fs.statSync(out).size} bytes)`);
