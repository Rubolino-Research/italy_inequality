// English / Italian text for the whole page.
//
// Static text: give an element data-i18n="key" (sets its text),
// data-i18n-html="key" (sets HTML - only for our own strings with links),
// data-i18n-placeholder="key" or data-i18n-aria-label="key".
// Dynamic text (js/explore.js): I18N.t("key", { n: 8 }).
//
// The language comes from ?lang=it|en in the URL, else the visitor's last
// choice, else their browser language; the EN | IT switch changes it.

(function () {
  "use strict";

  var STRINGS = {
    en: {
      "page.title": "Inequality in Italy",
      "menu.home": "Home",
      "menu.about": "Who earns what?",
      "menu.explore": "Explore the data",
      "menu.request": "Request our data",
      "header.title": "Inequality in\u00a0Italy",
      "header.button": "Who earns what?",
      "intro.title": "Italian inequality is above the OECD average",
      "intro.lead": "Interact with our map and graph to investigate and compare zip codes",
      "explore.indicator": "Indicator",
      "explore.simulated": "Simulated data for demonstration only – these are not real figures.",
      "explore.mapLabel": "Map of Italian municipalities and zip codes",
      "explore.lineLabel": "Line chart of the selected places over time",
      "explore.year": "Year",
      "explore.hint": "Scroll or pinch to zoom, drag to pan, click an area to add it to the chart. Large cities are split into zip codes (CAP).",
      "explore.credit": 'Zip code areas derived from <a href="https://zornade.com/data-downloads/" target="_blank" rel="noopener">Zornade</a> (includes &copy; OpenStreetMap contributors, ODbL). Municipal boundaries: ISTAT via <a href="https://github.com/openpolis/geojson-italy" target="_blank" rel="noopener">openpolis</a>.',
      "explore.search": "Municipality or zip code",
      "explore.searchPlaceholder": "e.g. Bologna or 00186",
      "explore.noData": "No data",
      "explore.clickAdd": "Click to add to chart",
      "explore.clickRemove": "Click to remove from chart",
      "explore.clickYear": "Click to show this year on the map",
      "explore.italy": "Italy",
      "explore.italyNational": "Italy (national)",
      "explore.remove": "Remove {name}",
      "explore.maxPlaces": "You can compare up to {n} places. Remove one first.",
      "explore.zoomIn": "Zoom in",
      "explore.zoomOut": "Zoom out",
      "explore.zoomReset": "Reset zoom",
      "explore.loadError": "Could not load the data. If you opened index.html directly from your computer, run a local web server instead (see readme).",
      "request.title": "Request our data",
      "request.name": "Name",
      "request.email": "Email",
      "request.reason": "Briefly explain your reason for downloading",
      "request.send": "Send request",
      "footer.text": "Inequality in Italy"
    },
    it: {
      "page.title": "Disuguaglianza in Italia",
      "menu.home": "Home",
      "menu.about": "Chi guadagna cosa?",
      "menu.explore": "Esplora i dati",
      "menu.request": "Richiedi i nostri dati",
      "header.title": "Disuguaglianza in\u00a0Italia",
      "header.button": "Chi guadagna cosa?",
      "intro.title": "La disuguaglianza in Italia è superiore alla media OCSE",
      "intro.lead": "Usa la mappa e il grafico per esplorare e confrontare i CAP",
      "explore.indicator": "Indicatore",
      "explore.simulated": "Dati simulati a solo scopo dimostrativo – non sono dati reali.",
      "explore.mapLabel": "Mappa dei comuni e dei CAP italiani",
      "explore.lineLabel": "Grafico dell'andamento nel tempo dei luoghi selezionati",
      "explore.year": "Anno",
      "explore.hint": "Scorri o usa due dita per ingrandire, trascina per spostarti, clicca su un'area per aggiungerla al grafico. Le grandi città sono suddivise per CAP.",
      "explore.credit": 'Zone CAP ricavate da <a href="https://zornade.com/data-downloads/" target="_blank" rel="noopener">Zornade</a> (include &copy; contributori di OpenStreetMap, ODbL). Confini comunali: ISTAT tramite <a href="https://github.com/openpolis/geojson-italy" target="_blank" rel="noopener">openpolis</a>.',
      "explore.search": "Comune o CAP",
      "explore.searchPlaceholder": "es. Bologna o 00186",
      "explore.noData": "Nessun dato",
      "explore.clickAdd": "Clicca per aggiungere al grafico",
      "explore.clickRemove": "Clicca per rimuovere dal grafico",
      "explore.clickYear": "Clicca per mostrare quest'anno sulla mappa",
      "explore.italy": "Italia",
      "explore.italyNational": "Italia (nazionale)",
      "explore.remove": "Rimuovi {name}",
      "explore.maxPlaces": "Puoi confrontare al massimo {n} luoghi. Rimuovine uno prima.",
      "explore.zoomIn": "Ingrandisci",
      "explore.zoomOut": "Riduci",
      "explore.zoomReset": "Ripristina la vista",
      "explore.loadError": "Impossibile caricare i dati. Se hai aperto index.html direttamente dal computer, avvia invece un server web locale (vedi readme).",
      "request.title": "Richiedi i nostri dati",
      "request.name": "Nome",
      "request.email": "Email",
      "request.reason": "Spiega brevemente perché vuoi scaricare i dati",
      "request.send": "Invia richiesta",
      "footer.text": "Disuguaglianza in Italia"
    }
  };

  var LANGS = ["en", "it"];
  var listeners = [];

  function initialLang() {
    var fromUrl = new URLSearchParams(window.location.search).get("lang");
    if (LANGS.indexOf(fromUrl) >= 0) return fromUrl;
    try {
      var saved = window.localStorage.getItem("lang");
      if (LANGS.indexOf(saved) >= 0) return saved;
    } catch (e) { /* storage unavailable */ }
    return (navigator.language || "").toLowerCase().indexOf("it") === 0 ? "it" : "en";
  }

  var I18N = {
    lang: initialLang(),

    t: function (key, params) {
      var s = STRINGS[I18N.lang][key];
      if (s === undefined) s = STRINGS.en[key];
      if (s === undefined) return key;
      return s.replace(/\{(\w+)\}/g, function (m, name) {
        return params && params[name] !== undefined ? params[name] : m;
      });
    },

    set: function (lang) {
      if (LANGS.indexOf(lang) < 0 || lang === I18N.lang) return;
      I18N.lang = lang;
      try { window.localStorage.setItem("lang", lang); } catch (e) { /* storage unavailable */ }
      apply();
      listeners.forEach(function (fn) { fn(lang); });
    },

    onChange: function (fn) { listeners.push(fn); }
  };

  function apply() {
    document.documentElement.lang = I18N.lang;
    document.title = I18N.t("page.title");
    each("[data-i18n]", function (el) { el.textContent = I18N.t(el.getAttribute("data-i18n")); });
    each("[data-i18n-html]", function (el) { el.innerHTML = I18N.t(el.getAttribute("data-i18n-html")); });
    each("[data-i18n-placeholder]", function (el) { el.placeholder = I18N.t(el.getAttribute("data-i18n-placeholder")); });
    each("[data-i18n-aria-label]", function (el) { el.setAttribute("aria-label", I18N.t(el.getAttribute("data-i18n-aria-label"))); });
    each("[data-lang]", function (el) {
      var on = el.getAttribute("data-lang") === I18N.lang;
      el.classList.toggle("active", on);
      el.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }

  each("[data-lang]", function (el) {
    el.addEventListener("click", function () { I18N.set(el.getAttribute("data-lang")); });
  });
  apply();

  window.I18N = I18N;
})();
