# Inequality in Italy

Static site (GitHub Pages) showing income inequality across Italian municipalities.

## Structure

- `index.html` - page: intro, explore panel (map + line chart), data request form
- `js/explore.js` - the interactive charts (D3 v7, vendored in `js/d3.min.js`)
- `data/comuni.topo.json` - municipality boundaries keyed by 6-digit ISTAT code
- `data/indicators.json` - list of indicators and the year range
- `data/indicators/<id>.csv` - one file per indicator: `code,2000,2001,...`, one row per
  municipality (ISTAT code) plus a row `IT` for the national figure

**The indicator data is currently simulated** (`node scripts/simulate_data.js`). To use real
data, replace the CSVs with files in the same format and set `"simulated": false` in
`data/indicators.json`. Boundaries are rebuilt with `scripts/prepare_boundaries.js`.

## Running locally

The charts load their data with `fetch`, which browsers block for files opened directly
from disk. From the repo root run:

    python3 -m http.server 8000

then open http://localhost:8000.
