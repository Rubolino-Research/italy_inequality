// Interactive map + line chart for the "Explore" panel.
//
// Data (see scripts/simulate_data.js for the format):
//   data/indicators.json       indicator list and year range
//   data/indicators/<id>.csv   code,2000,2001,...  one row per municipality + "IT"
//   data/comuni.topo.json      municipality boundaries, keyed by ISTAT code
//
// State is shared by every control: the indicator dropdown, the map slider and
// year dropdown, and the map clicks and search box all update `state` and
// call render().

(function () {
  "use strict";

  var DEFAULT_PLACES = ["058091", "015146", "063049", "001272", "082053"]; // Roma, Milano, Napoli, Torino, Palermo
  var NATIONAL = "IT";
  var MAX_PLACES = 8;
  var SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
  var NATIONAL_COLOR = "#52514e";
  var MAP_RAMP = ["#fde0dc", "#f8b5ac", "#f0877c", "#e34948", "#c3302f", "#9a2023", "#6b1418"];
  var NO_DATA = "#e4e3df";

  var state = {
    meta: null,
    indicator: null,
    year: null,
    selected: [], // [{ code, color }] - colour follows the place, never its position
    places: {}, // code -> { name, prov }
    cache: {} // indicator id -> Map(code -> [values by year])
  };

  var panel = document.querySelector(".explore-panel");
  var indicatorSelect = document.getElementById("indicator-select");
  var yearSelect = document.getElementById("year-select");
  var yearSlider = document.getElementById("year-slider");
  var yearLabel = document.getElementById("year-label");
  var searchInput = document.getElementById("place-search");
  var searchOptions = document.getElementById("place-options");
  var selectedList = document.getElementById("place-selected");

  var tooltip = d3.select("body").append("div").attr("class", "chart-tooltip").style("display", "none");

  var map = { svg: null, g: null, paths: null, projection: null, features: null, zoom: null };
  var line = {};

  // ---------- loading ----------

  Promise.all([
    d3.json("data/indicators.json"),
    d3.json("data/comuni.topo.json")
  ]).then(function (res) {
    state.meta = res[0];
    var topo = res[1];
    map.features = topojson.feature(topo, topo.objects.comuni).features;
    map.regionBorders = topojson.mesh(topo, topo.objects.comuni, function (a, b) {
      return a.properties.reg !== b.properties.reg;
    });
    map.coast = topojson.mesh(topo, topo.objects.comuni, function (a, b) { return a === b; });
    map.features.forEach(function (f) {
      state.places[f.id] = { name: f.properties.name, prov: f.properties.prov };
    });
    state.places[NATIONAL] = { name: "Italy", prov: null };

    setupControls();
    DEFAULT_PLACES.forEach(addPlace);
    return setIndicator(state.meta.indicators[0].id);
  }).catch(function (err) {
    panel.classList.remove("is-loading");
    document.getElementById("map-chart").textContent =
      "Could not load the data. If you opened index.html directly from your computer, run a local web server instead (see readme).";
    console.error(err);
  });

  function loadIndicator(id) {
    if (state.cache[id]) return Promise.resolve(state.cache[id]);
    var ind = findIndicator(id);
    return d3.text(ind.file).then(function (text) {
      var rows = d3.csvParseRows(text);
      var values = new Map();
      rows.slice(1).forEach(function (r) {
        values.set(r[0], r.slice(1).map(function (v) { return v === "" ? NaN : +v; }));
      });
      state.cache[id] = values;
      return values;
    });
  }

  function findIndicator(id) {
    return state.meta.indicators.find(function (i) { return i.id === id; });
  }

  // ---------- controls ----------

  function setupControls() {
    var meta = state.meta;
    var years = d3.range(meta.firstYear, meta.lastYear + 1);
    state.year = meta.lastYear;

    meta.indicators.forEach(function (ind) {
      var o = document.createElement("option");
      o.value = ind.id;
      o.textContent = ind.label;
      indicatorSelect.appendChild(o);
    });
    indicatorSelect.addEventListener("change", function () { setIndicator(this.value); });

    years.slice().reverse().forEach(function (y) {
      var o = document.createElement("option");
      o.value = y;
      o.textContent = y;
      yearSelect.appendChild(o);
    });
    yearSlider.min = meta.firstYear;
    yearSlider.max = meta.lastYear;
    yearSlider.step = 1;
    yearSelect.addEventListener("change", function () { setYear(+this.value); });
    yearSlider.addEventListener("input", function () { setYear(+this.value); });

    document.getElementById("simulated-note").hidden = !meta.simulated;

    // Search box: datalist of "Name (PR)" labels
    var byLabel = {};
    Object.keys(state.places).sort(function (a, b) {
      return d3.ascending(state.places[a].name, state.places[b].name);
    }).forEach(function (code) {
      if (code === NATIONAL) return;
      var label = placeLabel(code);
      byLabel[label.toLowerCase()] = code;
      var o = document.createElement("option");
      o.value = label;
      searchOptions.appendChild(o);
    });
    function trySearch() {
      var v = searchInput.value.trim().toLowerCase();
      if (!v) return;
      var code = byLabel[v];
      if (!code) {
        // Allow typing just the name when it is unique
        var matches = Object.keys(byLabel).filter(function (k) { return k.split(" (")[0] === v; });
        if (matches.length === 1) code = byLabel[matches[0]];
      }
      if (code) {
        addPlace(code);
        searchInput.value = "";
        render();
      }
    }
    searchInput.addEventListener("change", trySearch);
    searchInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); trySearch(); } });

    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { buildMap(); buildLine(); render(); }, 150);
    });

    buildMap();
    buildLine();
  }

  function setIndicator(id) {
    state.indicator = id;
    indicatorSelect.value = id;
    document.getElementById("indicator-description").textContent = findIndicator(id).description;
    panel.classList.add("is-loading");
    return loadIndicator(id).then(function () {
      panel.classList.remove("is-loading");
      render();
    });
  }

  function setYear(y) {
    state.year = y;
    render();
  }

  function addPlace(code) {
    if (code === NATIONAL || state.selected.some(function (s) { return s.code === code; })) return;
    if (state.selected.length >= MAX_PLACES) {
      window.alert("You can compare up to " + MAX_PLACES + " municipalities. Remove one first.");
      return;
    }
    var used = state.selected.map(function (s) { return s.color; });
    var color = SERIES_COLORS.find(function (c) { return used.indexOf(c) === -1; });
    state.selected.push({ code: code, color: color });
  }

  function togglePlace(code) {
    var i = state.selected.findIndex(function (s) { return s.code === code; });
    if (i >= 0) state.selected.splice(i, 1);
    else addPlace(code);
    render();
  }

  // ---------- helpers ----------

  function placeLabel(code) {
    var p = state.places[code];
    return p.prov ? p.name + " (" + p.prov + ")" : p.name;
  }

  function formatValue(v) {
    if (v == null || isNaN(v)) return "No data";
    var ind = findIndicator(state.indicator);
    var s = d3.format(ind.format)(v);
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

  // ---------- map ----------

  function buildMap() {
    var el = document.getElementById("map-chart");
    el.innerHTML = "";
    var width = el.clientWidth;
    var height = el.clientHeight;

    map.projection = d3.geoConicConformal()
      .parallels([38, 45])
      .rotate([-12.5, 0])
      .fitExtent([[8, 8], [width - 8, height - 8]], { type: "FeatureCollection", features: map.features });
    var path = d3.geoPath(map.projection);

    map.svg = d3.select(el).append("svg").attr("width", width).attr("height", height);
    map.g = map.svg.append("g");

    map.paths = map.g.append("g").selectAll("path")
      .data(map.features)
      .join("path")
      .attr("d", path)
      .attr("stroke-width", 0.3)
      .attr("vector-effect", "non-scaling-stroke")
      .on("pointermove", function (event, f) {
        map.hover.attr("d", path(f)).style("display", null);
        showTooltip(event, function (tt) {
          tt.append("div").attr("class", "title").text(placeLabel(f.id));
          tt.append("div").text(state.year + ": ").append("strong").style("color", "#0b0b0b").text(formatValue(valueOf(f.id, state.year)));
          var selected = state.selected.some(function (s) { return s.code === f.id; });
          tt.append("div").style("margin-top", "4px").style("color", "#8a8986")
            .text(selected ? "Click to remove from chart" : "Click to add to chart");
        });
      })
      .on("pointerleave", function () { map.hover.style("display", "none"); hideTooltip(); })
      .on("click", function (event, f) { togglePlace(f.id); });

    map.g.append("path")
      .datum(map.regionBorders)
      .attr("d", path)
      .attr("fill", "none")
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 0.8)
      .attr("vector-effect", "non-scaling-stroke")
      .style("pointer-events", "none");

    map.g.append("path")
      .datum(map.coast)
      .attr("d", path)
      .attr("fill", "none")
      .attr("stroke", "#8a8986")
      .attr("stroke-width", 0.5)
      .attr("vector-effect", "non-scaling-stroke")
      .style("pointer-events", "none");

    map.hover = map.g.append("path")
      .attr("fill", "none")
      .attr("stroke", "#0b0b0b")
      .attr("stroke-width", 1.5)
      .attr("vector-effect", "non-scaling-stroke")
      .style("pointer-events", "none")
      .style("display", "none");

    map.markers = map.g.append("g").style("pointer-events", "none");
    map.path = path;

    map.zoom = d3.zoom()
      .scaleExtent([1, 40])
      .translateExtent([[0, 0], [width, height]])
      .on("zoom", function (event) {
        map.g.attr("transform", event.transform);
        map.markers.selectAll("circle").attr("r", 5 / event.transform.k).attr("stroke-width", 2 / event.transform.k);
      });
    map.svg.call(map.zoom);

    // Zoom buttons
    var btns = d3.select(el).append("div")
      .style("position", "absolute").style("right", "6px").style("top", "6px")
      .style("display", "flex").style("flex-direction", "column").style("gap", "4px");
    [["+", 1.6], ["−", 1 / 1.6], ["⟲", 0]].forEach(function (b) {
      btns.append("button")
        .attr("type", "button")
        .attr("class", "btn btn-default btn-xs")
        .attr("aria-label", b[1] === 0 ? "Reset zoom" : (b[1] > 1 ? "Zoom in" : "Zoom out"))
        .style("width", "26px")
        .text(b[0])
        .on("click", function () {
          if (b[1] === 0) map.svg.transition().duration(400).call(map.zoom.transform, d3.zoomIdentity);
          else map.svg.transition().duration(250).call(map.zoom.scaleBy, b[1]);
        });
    });
  }

  function colorScale() {
    // Fixed across years so moving the slider shows real change.
    var values = [];
    state.cache[state.indicator].forEach(function (row, code) {
      if (code === NATIONAL) return;
      row.forEach(function (v) { if (!isNaN(v)) values.push(v); });
    });
    values.sort(d3.ascending);
    var lo = d3.quantileSorted(values, 0.02);
    var hi = d3.quantileSorted(values, 0.98);
    return d3.scaleQuantize().domain([lo, hi]).range(MAP_RAMP);
  }

  function renderMap() {
    var scale = colorScale();
    map.paths.attr("fill", function (f) {
      var v = valueOf(f.id, state.year);
      return isNaN(v) ? NO_DATA : scale(v);
    }).attr("stroke", function (f) {
      var v = valueOf(f.id, state.year);
      return isNaN(v) ? NO_DATA : scale(v);
    });

    // Selected places: a dot in the place's series colour with a white ring
    var k = d3.zoomTransform(map.svg.node()).k;
    map.markers.selectAll("circle")
      .data(state.selected.map(function (s) {
        var f = map.features.find(function (x) { return x.id === s.code; });
        return { code: s.code, color: s.color, xy: map.path.centroid(f) };
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
    var el = document.getElementById("map-legend");
    el.innerHTML = "";
    var width = el.clientWidth;
    var n = MAP_RAMP.length;
    var cell = (width - 20) / n;
    var svg = d3.select(el).append("svg").attr("width", width).attr("height", 36);
    var g = svg.append("g").attr("transform", "translate(10,4)");
    g.selectAll("rect").data(MAP_RAMP).join("rect")
      .attr("x", function (d, i) { return i * cell; })
      .attr("width", cell - 2)
      .attr("height", 10)
      .attr("rx", 2)
      .attr("fill", function (d) { return d; });
    var thresholds = scale.thresholds();
    var ind = findIndicator(state.indicator);
    g.selectAll("text").data(thresholds).join("text")
      .attr("x", function (d, i) { return (i + 1) * cell - 1; })
      .attr("y", 24)
      .attr("text-anchor", "middle")
      .attr("fill", "#52514e")
      .attr("font-size", 10)
      .text(function (d) { return d3.format(ind.unit === "%" ? ".0f" : ".2f")(d) + (ind.unit === "%" ? "%" : ""); });
  }

  // ---------- line chart ----------

  function buildLine() {
    var el = document.getElementById("line-chart");
    el.innerHTML = "";
    var width = el.clientWidth;
    var height = el.clientHeight;
    var m = { top: 16, right: 16, bottom: 28, left: 44 };

    line.m = m;
    line.width = width;
    line.height = height;
    line.svg = d3.select(el).append("svg").attr("width", width).attr("height", height);
    line.x = d3.scaleLinear()
      .domain([state.meta.firstYear, state.meta.lastYear])
      .range([m.left, width - m.right]);
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
      .on("pointermove", function (event) {
        var year = Math.round(line.x.invert(d3.pointer(event)[0]));
        showLineTooltip(event, year);
      })
      .on("pointerleave", function () {
        line.crosshair.style("display", "none");
        line.dots.selectAll("*").remove();
        hideTooltip();
      })
      .on("click", function (event) {
        setYear(Math.round(line.x.invert(d3.pointer(event)[0])));
      });
  }

  function lineSeries() {
    var years = d3.range(state.meta.firstYear, state.meta.lastYear + 1);
    var series = state.selected.map(function (s) {
      return { code: s.code, color: s.color, dashed: false };
    });
    series.push({ code: NATIONAL, color: NATIONAL_COLOR, dashed: true });
    series.forEach(function (s) {
      s.values = years.map(function (y) { return { year: y, value: valueOf(s.code, y) }; });
    });
    return series;
  }

  function renderLine() {
    var series = lineSeries();
    var all = [];
    series.forEach(function (s) { s.values.forEach(function (d) { if (!isNaN(d.value)) all.push(d.value); }); });
    var ext = d3.extent(all);
    var pad = (ext[1] - ext[0]) * 0.08 || 1;
    var ind = findIndicator(state.indicator);
    var lo = ext[0] - pad;
    if (ind.unit === "%" || ind.unit === "index") lo = Math.max(0, lo);
    line.y.domain([lo, ext[1] + pad]).nice();

    var yFormat = ind.unit === "%" ? function (v) { return d3.format(".0f")(v) + "%"; } : d3.format(".2f");
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
    var series = lineSeries();
    var x = line.x(year);
    line.crosshair.attr("x1", x).attr("x2", x).style("display", null);

    line.dots.selectAll("circle")
      .data(series.filter(function (s) { return !isNaN(s.values[yearIndex(year)].value); }))
      .join("circle")
      .attr("cx", x)
      .attr("cy", function (s) { return line.y(s.values[yearIndex(year)].value); })
      .attr("r", 4)
      .attr("fill", function (s) { return s.color; })
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 2);

    var sorted = series.slice().sort(function (a, b) {
      return d3.descending(a.values[yearIndex(year)].value, b.values[yearIndex(year)].value);
    });
    showTooltip(event, function (tt) {
      tt.append("div").attr("class", "title").text(year);
      sorted.forEach(function (s) {
        tooltipRow(tt, s.color, formatValue(s.values[yearIndex(year)].value), state.places[s.code].name, s.dashed);
      });
      tt.append("div").style("margin-top", "4px").style("color", "#8a8986").text("Click to show this year on the map");
    }, x > line.width / 2);
  }

  // ---------- selected list (acts as the legend) ----------

  function renderSelectedList() {
    selectedList.innerHTML = "";
    state.selected.forEach(function (s) {
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
      btn.setAttribute("aria-label", "Remove " + state.places[s.code].name);
      btn.addEventListener("click", function () { togglePlace(s.code); });
      li.appendChild(key);
      li.appendChild(name);
      li.appendChild(btn);
      selectedList.appendChild(li);
    });
    var li = document.createElement("li");
    var key = document.createElement("span");
    key.className = "key dashed";
    var name = document.createElement("span");
    name.className = "name";
    name.textContent = "Italy (national)";
    li.appendChild(key);
    li.appendChild(name);
    selectedList.appendChild(li);
  }

  // ---------- render everything ----------

  function render() {
    if (!state.indicator || !state.cache[state.indicator]) return;
    yearSelect.value = state.year;
    yearSlider.value = state.year;
    yearLabel.textContent = state.year;
    renderMap();
    renderLine();
    renderSelectedList();
  }
})();
