// Interactive maps + line charts for the "Explore" section.
//
// Two panels, built from the same code (createPanel):
//   Italy panel: map of every municipality
//   City panel:  a city picker and a map of that city split into zip codes (CAP)
// Each panel has its own line chart and its own list of selected places; any
// municipality or zip code can be added to either list from the search box.
// The indicator and the year are shared, so both maps always show the same thing.
//
// Data (see scripts/prepare_boundaries.js and scripts/simulate_data.js):
//   data/indicators.json          indicator list, year range, data version
//   data/indicators/<id>.csv      code,2000,2001,...  (ISTAT code, CAP, or "IT")
//   data/comuni.topo.json         municipality boundaries, keyed by ISTAT code
//   data/cities.json              cities split into CAP zones, with their CAPs
//   data/cities/<ISTAT>.topo.json CAP zones of one city, loaded when picked

(function () {
  "use strict";

  var NATIONAL = "IT";
  var MAX_PLACES = 8;
  var SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
  var NATIONAL_COLOR = "#52514e";
  var MAP_RAMP = ["#fde0dc", "#f8b5ac", "#f0877c", "#e34948", "#c3302f", "#9a2023", "#6b1418"];
  var NO_DATA = "#e4e3df";

  var ITALY_DEFAULTS = ["058091", "015146", "063049", "001272", "082053"]; // Roma, Milano, Napoli, Torino, Palermo
  var CITY_DEFAULT = "058091"; // Roma
  var CITY_DEFAULTS = ["058091", "00186", "00197", "00133"]; // Roma as a whole, Centro storico, Parioli, Tor Bella Monaca

  // Text comes from js/i18n.js; numbers follow the page language (0.45 / 0,45)
  var t = I18N.t;
  var LOCALES = {
    en: d3.formatLocale({ decimal: ".", thousands: ",", grouping: [3], currency: ["€", ""] }),
    it: d3.formatLocale({ decimal: ",", thousands: ".", grouping: [3], currency: ["", " €"] })
  };
  function fmt(spec) { return LOCALES[I18N.lang].format(spec); }

  // Shared state
  var state = {
    meta: null,
    indicator: null,
    year: null,
    places: {}, // code -> { type: "comune" | "cap" | "national", name, prov, city, cityCode }
    cities: [], // data/cities.json
    cache: {}, // indicator id -> Map(code -> [values by year])
    cityMaps: {} // ISTAT code -> promise of topojson
  };
  var panels = [];
  var searchIndex = null; // { labels: [...], byLabel: {} }

  var tooltip = d3.select("body").append("div").attr("class", "chart-tooltip").style("display", "none");

  // ---------- loading ----------

  // indicators.json is always re-checked with the server; its "version" is
  // added to every other data URL so browsers never mix old and new files.
  d3.json("data/indicators.json", { cache: "no-cache" }).then(function (meta) {
    state.meta = meta;
    state.year = meta.lastYear;
    state.indicator = meta.indicators[0].id;
    return Promise.all([
      d3.json(versioned("data/comuni.topo.json")),
      d3.json(versioned("data/cities.json")),
      loadIndicator(state.indicator)
    ]);
  }).then(function (res) {
    var topo = res[0];
    state.cities = res[1];
    var comuni = topojson.feature(topo, topo.objects.comuni).features;
    comuni.forEach(function (f) {
      state.places[f.id] = { type: "comune", name: f.properties.name, prov: f.properties.prov };
    });
    state.cities.forEach(function (c) {
      c.zones.forEach(function (cap) {
        state.places[cap] = { type: "cap", name: cap, city: c.name, cityCode: c.code, prov: c.prov };
      });
    });
    state.places[NATIONAL] = { type: "national", name: "Italy" }; // shown via t("explore.italy")

    var italyGeo = {
      features: comuni,
      regionBorders: topojson.mesh(topo, topo.objects.comuni, function (a, b) { return a.properties.reg !== b.properties.reg; }),
      outline: topojson.mesh(topo, topo.objects.comuni, function (a, b) { return a === b; })
    };

    document.querySelectorAll(".explore-panel").forEach(function (root) {
      var kind = root.getAttribute("data-panel");
      panels.push(createPanel(root, kind, kind === "city" ? CITY_DEFAULTS : ITALY_DEFAULTS));
    });
    panels.forEach(function (p) {
      if (p.kind === "italy") p.setGeo(italyGeo);
      else p.setCity(CITY_DEFAULT);
    });

    I18N.onChange(function () { panels.forEach(function (p) { p.relabel(); }); renderAll(); });

    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { panels.forEach(function (p) { p.rebuild(); }); renderAll(); }, 150);
    });
    renderAll();
  }).catch(function (err) {
    document.querySelectorAll(".explore-panel").forEach(function (root) {
      root.classList.remove("is-loading");
      root.querySelector(".js-map").textContent = t("explore.loadError");
    });
    console.error(err);
  });

  function loadIndicator(id) {
    if (state.cache[id]) return Promise.resolve(state.cache[id]);
    return d3.text(versioned(findIndicator(id).file)).then(function (text) {
      var values = new Map();
      d3.csvParseRows(text).slice(1).forEach(function (r) {
        values.set(r[0], r.slice(1).map(function (v) { return v === "" ? NaN : +v; }));
      });
      state.cache[id] = values;
      return values;
    });
  }

  function loadCityMap(code) {
    if (!state.cityMaps[code]) {
      var city = state.cities.find(function (c) { return c.code === code; });
      state.cityMaps[code] = d3.json(versioned(city.file));
    }
    return state.cityMaps[code];
  }

  function versioned(url) {
    return state.meta.version ? url + "?v=" + encodeURIComponent(state.meta.version) : url;
  }

  // ---------- shared setters ----------

  function setIndicator(id) {
    state.indicator = id;
    panels.forEach(function (p) { p.root.classList.add("is-loading"); });
    loadIndicator(id).then(function () {
      panels.forEach(function (p) { p.root.classList.remove("is-loading"); });
      renderAll();
    });
    renderAll();
  }

  function setYear(y) {
    state.year = y;
    renderAll();
  }

  function renderAll() {
    panels.forEach(function (p) { p.render(); });
  }

  // ---------- helpers ----------

  function findIndicator(id) {
    return state.meta.indicators.find(function (i) { return i.id === id; });
  }

  // Indicator label/description in the page language ("label_it" etc. in indicators.json)
  function indicatorText(ind, field) {
    return (I18N.lang !== "en" && ind[field + "_" + I18N.lang]) || ind[field];
  }

  function placeLabel(code) {
    var p = state.places[code];
    if (p.type === "national") return t("explore.italy");
    if (p.type === "cap") return p.name + " – " + p.city + " (" + p.prov + ")";
    return p.name + " (" + p.prov + ")";
  }

  // Short form for tooltips: "Roma", "00186 Roma"
  function placeShortName(code) {
    var p = state.places[code];
    if (p.type === "national") return t("explore.italy");
    return p.type === "cap" ? p.name + " " + p.city : p.name;
  }

  function formatValue(v) {
    if (v == null || isNaN(v)) return t("explore.noData");
    var ind = findIndicator(state.indicator);
    var s = fmt(ind.format)(v);
    return ind.unit === "%" ? s + "%" : s;
  }

  function yearIndex(y) { return y - state.meta.firstYear; }

  function valueOf(code, year) {
    var row = state.cache[state.indicator] && state.cache[state.indicator].get(code);
    return row ? row[yearIndex(year)] : NaN;
  }

  function showTooltip(event, build, preferLeft) {
    tooltip.html("").style("display", null);
    build(tooltip);
    var node = tooltip.node();
    var x = event.pageX + 14;
    var y = event.pageY + 14;
    if (preferLeft || x + node.offsetWidth > window.scrollX + document.documentElement.clientWidth - 8) {
      x = event.pageX - node.offsetWidth - 14;
    }
    tooltip.style("left", x + "px").style("top", y + "px");
  }

  function hideTooltip() { tooltip.style("display", "none"); }

  function tooltipRow(tt, color, value, name, dashed) {
    var row = tt.append("div").attr("class", "row-item");
    row.append("span").attr("class", "key")
      .style("background", dashed
        ? "repeating-linear-gradient(90deg," + color + " 0 3px,transparent 3px 5px)"
        : color);
    row.append("strong").text(value);
    row.append("span").text(name);
  }

  function tooltipHint(tt, text) {
    tt.append("div").style("margin-top", "4px").style("color", "#8a8986").text(text);
  }

  // Search box entries: "Name (PR)" and "CAP – City (PR)", built once
  function getSearchIndex() {
    if (searchIndex) return searchIndex;
    var byLabel = {};
    var labels = Object.keys(state.places).filter(function (code) { return code !== NATIONAL; })
      .sort(function (a, b) {
        var pa = state.places[a], pb = state.places[b];
        return d3.ascending(pa.type === "cap" ? pa.city + pa.name : pa.name, pb.type === "cap" ? pb.city + pb.name : pb.name);
      })
      .map(function (code) {
        var label = placeLabel(code);
        byLabel[label.toLowerCase()] = code;
        return label;
      });
    searchIndex = { labels: labels, byLabel: byLabel };
    return searchIndex;
  }

  function findPlace(query) {
    var v = query.trim().toLowerCase();
    if (!v) return null;
    var idx = getSearchIndex();
    if (idx.byLabel[v]) return idx.byLabel[v];
    if (/^\d{5}$/.test(v) && state.places[v]) return v;
    // Allow typing just the name when it is unique
    var matches = Object.keys(idx.byLabel).filter(function (k) { return k.split(" (")[0] === v; });
    return matches.length === 1 ? idx.byLabel[matches[0]] : null;
  }

  // ---------- one panel ----------

  function createPanel(root, kind, defaults) {
    var el = function (cls) { return root.querySelector(cls); };
    var panel = {
      root: root,
      kind: kind,
      selected: [], // [{ code, color }] - colour follows the place, never its position
      geo: null, // { features, regionBorders?, outline, zoneBorders? }
      cityCode: null,
      map: {},
      line: {}
    };

    var indicatorSelect = el(".js-indicator");
    var yearSelect = el(".js-year-select");
    var yearSlider = el(".js-year-slider");
    var citySelect = el(".js-city");
    var searchInput = el(".js-search");

    // Indicator dropdown (shared value)
    state.meta.indicators.forEach(function (ind) {
      var o = document.createElement("option");
      o.value = ind.id;
      indicatorSelect.appendChild(o);
    });
    indicatorSelect.addEventListener("change", function () { setIndicator(this.value); });
    el(".js-simulated").hidden = !state.meta.simulated;

    // Year dropdown and slider (shared value)
    d3.range(state.meta.lastYear, state.meta.firstYear - 1, -1).forEach(function (y) {
      var o = document.createElement("option");
      o.value = y;
      o.textContent = y;
      yearSelect.appendChild(o);
    });
    yearSlider.min = state.meta.firstYear;
    yearSlider.max = state.meta.lastYear;
    yearSlider.step = 1;
    yearSelect.addEventListener("change", function () { setYear(+this.value); });
    yearSlider.addEventListener("input", function () { setYear(+this.value); });

    // City picker (city panel only)
    if (citySelect) {
      state.cities.forEach(function (c) {
        var o = document.createElement("option");
        o.value = c.code;
        o.textContent = c.name + " (" + c.zones.length + " CAP)";
        citySelect.appendChild(o);
      });
      citySelect.addEventListener("change", function () { panel.setCity(this.value); });
    }

    // Search: any municipality or zip code
    var datalist = el(".js-search-options");
    getSearchIndex().labels.forEach(function (label) {
      var o = document.createElement("option");
      o.value = label;
      datalist.appendChild(o);
    });
    function trySearch() {
      var code = findPlace(searchInput.value);
      if (code) {
        addPlace(code);
        searchInput.value = "";
        panel.render();
      }
    }
    searchInput.addEventListener("change", trySearch);
    searchInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); trySearch(); } });

    defaults.forEach(addPlace);

    function addPlace(code) {
      if (!state.places[code] || code === NATIONAL || isSelected(code)) return;
      if (panel.selected.length >= MAX_PLACES) {
        window.alert(t("explore.maxPlaces", { n: MAX_PLACES }));
        return;
      }
      var used = panel.selected.map(function (s) { return s.color; });
      var color = SERIES_COLORS.find(function (c) { return used.indexOf(c) === -1; });
      panel.selected.push({ code: code, color: color });
    }

    function isSelected(code) {
      return panel.selected.some(function (s) { return s.code === code; });
    }

    function togglePlace(code) {
      var i = panel.selected.findIndex(function (s) { return s.code === code; });
      if (i >= 0) panel.selected.splice(i, 1);
      else addPlace(code);
      panel.render();
    }

    // ----- map -----

    panel.setGeo = function (geo) {
      panel.geo = geo;
      buildMap();
      panel.render();
    };

    panel.setCity = function (code) {
      panel.cityCode = code;
      citySelect.value = code;
      root.classList.add("is-loading");
      loadCityMap(code).then(function (topo) {
        if (panel.cityCode !== code) return; // another city was picked meanwhile
        root.classList.remove("is-loading");
        panel.setGeo({
          features: topojson.feature(topo, topo.objects.zones).features,
          zoneBorders: topojson.mesh(topo, topo.objects.zones, function (a, b) { return a !== b; }),
          outline: topojson.mesh(topo, topo.objects.zones, function (a, b) { return a === b; })
        });
      });
    };

    function buildMap() {
      var map = panel.map;
      var box = el(".js-map");
      box.innerHTML = "";
      if (!panel.geo) return;
      var width = box.clientWidth;
      var height = box.clientHeight;

      var projection = d3.geoConicConformal()
        .parallels([38, 45])
        .rotate([-12.5, 0])
        .fitExtent([[8, 8], [width - 8, height - 8]], { type: "FeatureCollection", features: panel.geo.features });
      var path = d3.geoPath(projection);
      map.path = path;
      map.shapes = {};
      panel.geo.features.forEach(function (f) { map.shapes[f.id] = f; });

      map.svg = d3.select(box).append("svg").attr("width", width).attr("height", height);
      map.g = map.svg.append("g");

      map.paths = map.g.append("g").selectAll("path")
        .data(panel.geo.features)
        .join("path")
        .attr("d", path)
        .attr("stroke-width", 0.3)
        .attr("vector-effect", "non-scaling-stroke")
        .on("pointermove", function (event, f) {
          map.hover.attr("d", path(f)).style("display", null);
          showTooltip(event, function (tt) {
            tt.append("div").attr("class", "title").text(placeLabel(f.id));
            tt.append("div").text(state.year + ": ").append("strong").style("color", "#0b0b0b").text(formatValue(valueOf(f.id, state.year)));
            tooltipHint(tt, isSelected(f.id) ? t("explore.clickRemove") : t("explore.clickAdd"));
          });
        })
        .on("pointerleave", function () { map.hover.style("display", "none"); hideTooltip(); })
        .on("click", function (event, f) { togglePlace(f.id); });

      function overlay(datum, color, widthPx) {
        if (!datum) return;
        map.g.append("path")
          .datum(datum)
          .attr("d", path)
          .attr("fill", "none")
          .attr("stroke", color)
          .attr("stroke-width", widthPx)
          .attr("vector-effect", "non-scaling-stroke")
          .style("pointer-events", "none");
      }
      overlay(panel.geo.regionBorders, "#ffffff", 0.8);
      overlay(panel.geo.zoneBorders, "#ffffff", 0.8);
      overlay(panel.geo.outline, "#8a8986", 0.6);

      map.hover = map.g.append("path")
        .attr("fill", "none")
        .attr("stroke", "#0b0b0b")
        .attr("stroke-width", 1.5)
        .attr("vector-effect", "non-scaling-stroke")
        .style("pointer-events", "none")
        .style("display", "none");

      map.markers = map.g.append("g").style("pointer-events", "none");

      map.zoom = d3.zoom()
        .scaleExtent([1, kind === "city" ? 20 : 40])
        .translateExtent([[0, 0], [width, height]])
        .on("zoom", function (event) {
          map.g.attr("transform", event.transform);
          map.markers.selectAll("circle").attr("r", 5 / event.transform.k).attr("stroke-width", 2 / event.transform.k);
        });
      map.svg.call(map.zoom);

      // Zoom buttons
      var btns = d3.select(box).append("div").attr("class", "zoom-buttons");
      [["+", 1.6, "explore.zoomIn"], ["−", 1 / 1.6, "explore.zoomOut"], ["⟲", 0, "explore.zoomReset"]].forEach(function (b) {
        btns.append("button")
          .attr("type", "button")
          .attr("class", "btn btn-default btn-xs")
          .attr("data-label", b[2])
          .text(b[0])
          .on("click", function () {
            if (b[1] === 0) map.svg.transition().duration(400).call(map.zoom.transform, d3.zoomIdentity);
            else map.svg.transition().duration(250).call(map.zoom.scaleBy, b[1]);
          });
      });
      updateZoomLabels();
    }

    function updateZoomLabels() {
      root.querySelectorAll(".zoom-buttons button").forEach(function (b) {
        var label = t(b.getAttribute("data-label"));
        b.setAttribute("aria-label", label);
        b.setAttribute("title", label);
      });
    }

    // Colour scale fixed across years (so the slider shows real change), over
    // the areas this map shows: all municipalities, or this city's zip codes.
    function colorScale() {
      var values = [];
      panel.geo.features.forEach(function (f) {
        var row = state.cache[state.indicator].get(f.id);
        if (row) row.forEach(function (v) { if (!isNaN(v)) values.push(v); });
      });
      values.sort(d3.ascending);
      return d3.scaleQuantize()
        .domain([d3.quantileSorted(values, 0.02), d3.quantileSorted(values, 0.98)])
        .range(MAP_RAMP);
    }

    function renderMap() {
      var map = panel.map;
      if (!map.paths) return;
      var scale = colorScale();
      var fill = function (f) {
        var v = valueOf(f.id, state.year);
        return isNaN(v) ? NO_DATA : scale(v);
      };
      map.paths.attr("fill", fill).attr("stroke", fill);

      // Selected places on this map: a dot in the place's series colour with a white ring
      var k = d3.zoomTransform(map.svg.node()).k;
      map.markers.selectAll("circle")
        .data(panel.selected.filter(function (s) { return map.shapes[s.code]; }).map(function (s) {
          return { code: s.code, color: s.color, xy: map.path.centroid(map.shapes[s.code]) };
        }), function (d) { return d.code; })
        .join("circle")
        .attr("cx", function (d) { return d.xy[0]; })
        .attr("cy", function (d) { return d.xy[1]; })
        .attr("r", 5 / k)
        .attr("fill", function (d) { return d.color; })
        .attr("stroke", "#ffffff")
        .attr("stroke-width", 2 / k);

      renderLegend(scale);
    }

    function renderLegend(scale) {
      var box = el(".js-legend");
      box.innerHTML = "";
      var width = box.clientWidth;
      var cell = (width - 20) / MAP_RAMP.length;
      var ind = findIndicator(state.indicator);
      var g = d3.select(box).append("svg").attr("width", width).attr("height", 36)
        .append("g").attr("transform", "translate(10,4)");
      g.selectAll("rect").data(MAP_RAMP).join("rect")
        .attr("x", function (d, i) { return i * cell; })
        .attr("width", cell - 2)
        .attr("height", 10)
        .attr("rx", 2)
        .attr("fill", function (d) { return d; });
      // Enough decimals that neighbouring labels differ (e.g. 9.2% 9.6%, not 9% 9%)
      var thresholds = scale.thresholds();
      var step = thresholds.length > 1 ? thresholds[1] - thresholds[0] : 1;
      var decimals = Math.max(ind.unit === "%" ? 0 : 2, Math.ceil(-Math.log10(step)));
      g.selectAll("text").data(thresholds).join("text")
        .attr("x", function (d, i) { return (i + 1) * cell - 1; })
        .attr("y", 24)
        .attr("text-anchor", "middle")
        .attr("fill", "#52514e")
        .attr("font-size", 10)
        .text(function (d) { return fmt("." + decimals + "f")(d) + (ind.unit === "%" ? "%" : ""); });
    }

    // ----- line chart -----

    function buildLine() {
      var line = panel.line;
      var box = el(".js-line");
      box.innerHTML = "";
      var width = box.clientWidth;
      var height = box.clientHeight;
      var m = { top: 16, right: 16, bottom: 28, left: 44 };

      line.m = m;
      line.width = width;
      line.svg = d3.select(box).append("svg").attr("width", width).attr("height", height);
      line.x = d3.scaleLinear().domain([state.meta.firstYear, state.meta.lastYear]).range([m.left, width - m.right]);
      line.y = d3.scaleLinear().range([height - m.bottom, m.top]);

      line.grid = line.svg.append("g").attr("class", "grid").attr("transform", "translate(" + m.left + ",0)");
      line.xAxis = line.svg.append("g").attr("class", "axis").attr("transform", "translate(0," + (height - m.bottom) + ")");
      line.yAxis = line.svg.append("g").attr("class", "axis").attr("transform", "translate(" + m.left + ",0)");
      line.yearMarker = line.svg.append("line")
        .attr("y1", m.top).attr("y2", height - m.bottom)
        .attr("stroke", "#0b0b0b").attr("stroke-opacity", 0.25).attr("stroke-width", 1);
      line.series = line.svg.append("g").attr("fill", "none").attr("stroke-width", 2)
        .attr("stroke-linejoin", "round").attr("stroke-linecap", "round");
      line.crosshair = line.svg.append("line")
        .attr("y1", m.top).attr("y2", height - m.bottom)
        .attr("stroke", "#52514e").attr("stroke-width", 1).style("display", "none");
      line.dots = line.svg.append("g");

      line.xAxis.call(d3.axisBottom(line.x).tickFormat(d3.format("d")).ticks(Math.min(8, width / 70)).tickSizeOuter(0));

      // Hover layer: crosshair snaps to the nearest year; click sets the year
      line.svg.append("rect")
        .attr("x", m.left).attr("y", m.top)
        .attr("width", width - m.left - m.right).attr("height", height - m.top - m.bottom)
        .attr("fill", "transparent")
        .style("cursor", "pointer")
        .on("pointermove", function (event) { showLineTooltip(event, Math.round(line.x.invert(d3.pointer(event)[0]))); })
        .on("pointerleave", function () {
          line.crosshair.style("display", "none");
          line.dots.selectAll("*").remove();
          hideTooltip();
        })
        .on("click", function (event) { setYear(Math.round(line.x.invert(d3.pointer(event)[0]))); });
    }

    function lineSeries() {
      var years = d3.range(state.meta.firstYear, state.meta.lastYear + 1);
      var series = panel.selected.map(function (s) { return { code: s.code, color: s.color, dashed: false }; });
      series.push({ code: NATIONAL, color: NATIONAL_COLOR, dashed: true });
      series.forEach(function (s) {
        s.values = years.map(function (y) { return { year: y, value: valueOf(s.code, y) }; });
      });
      return series;
    }

    function renderLine() {
      var line = panel.line;
      var series = lineSeries();
      var all = [];
      series.forEach(function (s) { s.values.forEach(function (d) { if (!isNaN(d.value)) all.push(d.value); }); });
      var ext = d3.extent(all);
      var pad = (ext[1] - ext[0]) * 0.08 || 1;
      var ind = findIndicator(state.indicator);
      var lo = ext[0] - pad;
      if (ind.unit === "%" || ind.unit === "index") lo = Math.max(0, lo);
      line.y.domain([lo, ext[1] + pad]).nice();

      var yFormat = ind.unit === "%" ? function (v) { return fmt(".0f")(v) + "%"; } : fmt(".2f");
      line.yAxis.call(d3.axisLeft(line.y).ticks(6).tickFormat(yFormat).tickSizeOuter(0));
      line.yAxis.select(".domain").remove();
      line.grid.call(d3.axisLeft(line.y).ticks(6).tickSize(-(line.width - line.m.left - line.m.right)).tickFormat(""));

      var gen = d3.line()
        .defined(function (d) { return !isNaN(d.value); })
        .x(function (d) { return line.x(d.year); })
        .y(function (d) { return line.y(d.value); });

      line.series.selectAll("path")
        .data(series, function (d) { return d.code; })
        .join("path")
        .attr("stroke", function (d) { return d.color; })
        .attr("stroke-dasharray", function (d) { return d.dashed ? "5 4" : null; })
        .attr("d", function (d) { return gen(d.values); });

      line.yearMarker.attr("x1", line.x(state.year)).attr("x2", line.x(state.year));
    }

    function showLineTooltip(event, year) {
      var line = panel.line;
      var series = lineSeries();
      var x = line.x(year);
      var at = function (s) { return s.values[yearIndex(year)].value; };
      line.crosshair.attr("x1", x).attr("x2", x).style("display", null);

      line.dots.selectAll("circle")
        .data(series.filter(function (s) { return !isNaN(at(s)); }))
        .join("circle")
        .attr("cx", x)
        .attr("cy", function (s) { return line.y(at(s)); })
        .attr("r", 4)
        .attr("fill", function (s) { return s.color; })
        .attr("stroke", "#ffffff")
        .attr("stroke-width", 2);

      var sorted = series.slice().sort(function (a, b) { return d3.descending(at(a), at(b)); });
      showTooltip(event, function (tt) {
        tt.append("div").attr("class", "title").text(year);
        sorted.forEach(function (s) { tooltipRow(tt, s.color, formatValue(at(s)), placeShortName(s.code), s.dashed); });
        tooltipHint(tt, t("explore.clickYear"));
      }, x > line.width / 2);
    }

    // ----- selected list (acts as the legend) -----

    function renderSelectedList() {
      var list = el(".js-selected");
      list.innerHTML = "";
      panel.selected.forEach(function (s) {
        var li = document.createElement("li");
        var key = document.createElement("span");
        key.className = "key";
        key.style.background = s.color;
        var name = document.createElement("span");
        name.className = "name";
        name.textContent = placeLabel(s.code);
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "×";
        btn.setAttribute("aria-label", t("explore.remove", { name: placeShortName(s.code) }));
        btn.addEventListener("click", function () { togglePlace(s.code); });
        li.appendChild(key);
        li.appendChild(name);
        li.appendChild(btn);
        list.appendChild(li);
      });
      var li = document.createElement("li");
      var key = document.createElement("span");
      key.className = "key dashed";
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = t("explore.italyNational");
      li.appendChild(key);
      li.appendChild(name);
      list.appendChild(li);
    }

    // ----- panel lifecycle -----

    panel.relabel = function () {
      Array.prototype.forEach.call(indicatorSelect.options, function (o) {
        o.textContent = indicatorText(findIndicator(o.value), "label");
      });
      updateZoomLabels();
    };

    panel.rebuild = function () {
      buildMap();
      buildLine();
    };

    panel.render = function () {
      if (!state.cache[state.indicator]) return;
      indicatorSelect.value = state.indicator;
      el(".js-indicator-description").textContent = indicatorText(findIndicator(state.indicator), "description");
      yearSelect.value = state.year;
      yearSlider.value = state.year;
      el(".js-year-label").textContent = state.year;
      renderMap();
      renderLine();
      renderSelectedList();
    };

    panel.relabel();
    buildLine();
    return panel;
  }
})();
