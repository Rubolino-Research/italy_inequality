# Inequality in Italy

Static site (GitHub Pages) showing income inequality across Italian municipalities.

## Structure

- `index.html` - page: intro, explore panel (map + line chart), data request form
- `js/explore.js` - the interactive charts (D3 v7, vendored in `js/d3.min.js`)
- `data/areas.topo.json` - map areas: municipalities (6-digit ISTAT code), with the 41 cities
  that have several zip codes split into zip code (CAP) zones (5-digit CAP)
- `data/indicators.json` - list of indicators and the year range
- `data/indicators/<id>.csv` - one file per indicator: `code,2000,2001,...`, one row per
  municipality (ISTAT code) and per zip code zone (CAP), plus whole-city rows for the split
  cities (ISTAT code) and a row `IT` for the national figure

**The indicator data is currently simulated** (`node scripts/simulate_data.js`). To use real
data, replace the CSVs with files in the same format and set `"simulated": false` in
`data/indicators.json`. Whenever the data or map files change, also change the `version`
value in `data/indicators.json` (the simulation script does this automatically): browsers
cache the data files, and the version makes them fetch the new ones. Boundaries are rebuilt with `scripts/prepare_boundaries.js` (instructions at the top of the
script). Zip code areas are derived from Zornade's sub-municipal CAP zones (open data with
attribution; includes OpenStreetMap data, ODbL), so the credit line under the map must stay.

## Running locally

The charts load their data with `fetch`, which browsers block for files opened directly
from disk. From the repo root run:

    python3 -m http.server 8000

then open http://localhost:8000.
