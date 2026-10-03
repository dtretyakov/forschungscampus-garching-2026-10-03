/* Campus-Karte Garching – Tag der offenen Tür, 3. Oktober 2026 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const els = {
    chips: $("#chips"), search: $("#search"), list: $("#list"), count: $("#count"),
    reset: $("#reset"), sheet: $("#sheet"), grip: $("#grip"), listview: $("#listview"),
    detail: $("#detail"), locate: $("#locate"), toast: $("#toast"), lang: $("#lang"), title: $("#title"),
  };
  const FAV = "fav";

  const state = {
    data: null,       // { stations, categories, pois, center, ... }
    cats: new Set(),  // active category ids (OR-filter)
    q: "",
    qm: null,         // compiled query (makeQuery)
    sel: null,        // selected station id
    group: null,      // ids of stations sharing one map point, listed in the sheet
    me: null,         // {lat, lng, acc}
    favs: loadFavs(),
  };

  // ---------- storage ----------
  function loadFavs() {
    try { return new Set(JSON.parse(localStorage.getItem("garching-favs") || "[]")); } catch (e) { return new Set(); }
  }
  function saveFavs() {
    try { localStorage.setItem("garching-favs", JSON.stringify([...state.favs])); } catch (e) { /* ignore */ }
  }

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  // ---------- search ----------
  // Every query word must occur in the item's text; words of 5+ letters may also match a
  // word in the text with one typo (two for 7+ letters), e.g. "lazer" → "Laser".
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  function wordsOf(item) {
    if (!item._words) item._words = [...new Set(item._text.split(/[^a-z0-9\u0430-\u044f\u0451]+/).filter((w) => w.length >= 3))];
    return item._words;
  }
  // Text with every non-letter turned into a space, padded, so " eso" finds word starts.
  const spaced = (t) => " " + norm(t).replace(/[^a-z0-9\u0430-\u044f\u0451]+/g, " ") + " ";
  // Index an item: _tt = name/number, _tl = short texts (teaser, tags, place), _ts = everything.
  function indexItem(item, title, lead, rest) {
    item._tt = spaced(title.join(" "));
    item._tl = spaced(lead.join(" "));
    item._ts = spaced([...title, ...lead, ...rest].join(" "));
    item._text = item._ts;
    item._words = null;
  }
  // Score of an item for a query (0 = no match). Every word must match somewhere; a hit in the
  // name counts far more than one in the description. Words of up to 3 letters ("ESO") only
  // match at a word start, longer ones anywhere; 5+ letters also with a typo.
  function makeQuery(q) {
    const words = norm(q).split(/\s+/).map((w) => w.replace(/[^a-z0-9\u0430-\u044f\u0451.]/g, "")).filter(Boolean);
    if (!words.length) return null;
    const scoreWord = (item, w) => {
      if (item.number && item.number === w) return 300;
      const start = " " + w, whole = " " + w + " ", long = w.length >= 4;
      if (item._tt.includes(whole)) return 120;
      if (item._tt.includes(start)) return 80;
      if (long && item._tt.includes(w)) return 40;
      if (item._tl.includes(start)) return 25;
      if (long && item._tl.includes(w)) return 10;
      if (item._ts.includes(start)) return 5;
      if (long && item._ts.includes(w)) return 2;
      if (w.length < 5) return 0;
      const k = w.length >= 7 ? 2 : 1;
      return wordsOf(item).some((t) => lev(w, t.slice(0, w.length), k) <= k || lev(w, t, k) <= k) ? 1 : 0;
    };
    return (item) => {
      let total = 0;
      for (const w of words) {
        const sc = scoreWord(item, w);
        if (!sc) return 0;
        total += sc;
      }
      return total;
    };
  }

  function dist(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fmtDist(m) {
    if (m < 1000) return "≈ " + Math.max(10, Math.round(m / 10) * 10) + " " + T("unitM");
    return "≈ " + (m / 1000).toFixed(1).replace(".", LANG === "en" ? "." : ",") + " " + T("unitKm");
  }
  function walkMin(m) { return Math.max(1, Math.round(m / 75)); } // ~4.5 km/h
  function catById(id) { return state.data.catIndex[id]; }
  // Same purple as the highlighted buildings on the official Lageplan.
  function colorOf() { return "#94054f"; }
  const TARGET_ICON = { "targets:kinder": "🧒", "targets:jugendliche": "🧑", "targets:studieninteressierte": "🎓", "targets:erwachsene": "🧑‍💼" };
  // Event day only: talks before "now" are shown as past.
  function nowHM() {
    const p = Object.fromEntries(new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` !== "2026-10-03") return "00:00";
    return `${p.hour}:${p.minute}`;
  }
  function nextTalk(st) {
    const now = nowHM();
    return (st.talks || []).find((t) => (t.end || t.start) >= now);
  }
  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg; els.toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (els.toast.hidden = true), 3500);
  }

  // ---------- i18n (DE / EN) ----------
  const STR = {
    de: {
      title: "Tag der offenen Tür · Garching", search: "Stationen, Vorträge, Essen suchen …",
      secTalks: "Vorträge", secFood: "Essen & Trinken", building: "Gebäude",
      locate: "Meinen Standort zeigen", langTitle: "Sprache", docTitle: "Campus-Karte Garching",
      sheet: "Liste ein-/ausklappen", cats: "Kategorien",
      lStations: "Stationen", lInfra: "Infrastruktur (U-Bahn, Info, Essen …)", lPlan: "Offizieller Lageplan", lMap: "Karte",
      multiTitle: (n, r) => `${n} Stationen in Gebäude ${r}`, multiHead: (r, n) => `Gebäude ${r} · ${n} Stationen`,
      myPlan: "Mein Plan", allStations: "Alle Stationen",
      groupHead: (r, n) => `Nr. ${r} · ${n} Stationen`, count: (n) => `${n} Stationen`, countOf: (n, t) => `${n} von ${t} Stationen`,
      empty: "Keine Station passt zu diesem Filter.", reset: "Filter zurücksetzen",
      rLocation: "Standort", rPlan: "Lageplan", planNo: "Nr. ", rNote: "Hinweis", rTargets: "Zielgruppe", rFormats: "Format", rLang: "Sprache",
      talks: "Vorträge", back: "‹ Zurück zur Liste", away: (d, m) => `📍 ${d} entfernt · ca. ${m} Min. zu Fuß`,
      show: "Auf Karte zeigen", inPlan: "★ Im Plan", save: "☆ Merken", route: "Route", original: "Original", contact: "Kontakt",
      descNote: "", locating: "Standort wird gesucht …", me: "Mein Standort", unitM: "m", unitKm: "km",
      offCampus: "Du bist nicht auf dem Campus – Entfernungen sind trotzdem berechnet.",
      loadFail: "Stationsdaten konnten nicht geladen werden.",
      locTitle: "📍 Standort nicht verfügbar",
      locIOS: `<p>Safari darf deinen Standort gerade nicht verwenden. So schaltest du ihn ein:</p><ol>
        <li><b>Einstellungen → Datenschutz &amp; Sicherheit → Ortungsdienste</b> einschalten.</li>
        <li>Dort <b>Safari-Websites</b> → <b>Beim Verwenden der App</b> wählen und <b>Genauer Standort</b> aktivieren.</li>
        <li>In Safari auf <b>aA</b> tippen → <b>Website-Einstellungen</b> → <b>Standort</b>: <b>Fragen</b> oder <b>Erlauben</b>.</li>
        <li>Seite neu laden und 📍 erneut antippen.</li></ol>`,
      locAndroid: `<p>Der Browser darf deinen Standort gerade nicht verwenden. So schaltest du ihn ein:</p><ol>
        <li>Standort/GPS in den Schnelleinstellungen einschalten.</li>
        <li>Im Browser auf das Symbol links neben der Adresse tippen → <b>Berechtigungen</b> → <b>Standort</b> erlauben.</li>
        <li>Seite neu laden und 📍 erneut antippen.</li></ol>`,
      locDenied: `<p>Der Standortzugriff ist für diese Seite blockiert. Erlaube ihn in den Website-Einstellungen deines Browsers (Symbol neben der Adresse) und lade die Seite neu.</p>`,
      locUnsupported: `<p>Dieser Browser unterstützt keine Standortbestimmung.</p>`,
      locFailed: `<p>Der Standort konnte nicht bestimmt werden (kein GPS-Empfang?). Versuch es draußen noch einmal.</p>`,
      locManualHint: "Oder setze deinen Standort von Hand – dann funktionieren Entfernungen und Sortierung trotzdem.",
      tech: "Technische Info", manual: "Auf Karte antippen", reload: "Seite neu laden", retry: "Erneut versuchen", close: "Schließen",
      tapMap: "Tippe auf der Karte auf deinen Standort.", posSet: "Standort gesetzt – du kannst den blauen Punkt verschieben.",
      poi: { info: "Infostand", food: "Gastronomie", bus: "Bushaltestelle", parking: "Parkplatz", ubahn: "U6 Garching-Forschungszentrum" },
      ubahnNote: "U-Bahn verkehrt von 9:30 bis 11:30 im 10-Minuten-Takt.",
    },
    en: {
      title: "Open Day · Garching", search: "Search stations, talks, food …",
      secTalks: "Talks", secFood: "Food & drinks", building: "Building",
      locate: "Show my location", langTitle: "Language",
      sheet: "Expand/collapse list", cats: "Categories",
      lStations: "Stations", lInfra: "Facilities (U-Bahn, info, food …)", lPlan: "Official site plan", lMap: "Map",
      multiTitle: (n, r) => `${n} stations in building ${r}`, multiHead: (r, n) => `Building ${r} · ${n} stations`,
      myPlan: "My plan", allStations: "All stations",
      groupHead: (r, n) => `No. ${r} · ${n} stations`, count: (n) => `${n} stations`, countOf: (n, t) => `${n} of ${t} stations`,
      empty: "No station matches this filter.", reset: "Reset filters",
      rLocation: "Location", rPlan: "Site plan", planNo: "No. ", rNote: "Note", rTargets: "Audience", rFormats: "Format", rLang: "Language",
      talks: "Talks", back: "‹ Back to list", away: (d, m) => `📍 ${d} away · approx. ${m} min walk`,
      show: "Show on map", inPlan: "★ In my plan", save: "☆ Save", route: "Directions", original: "Original page", contact: "Contact",
      descNote: "The programme description is only available in German.", translate: "Translate page",
      locating: "Finding your location …", me: "My location", unitM: "m", unitKm: "km", docTitle: "Campus Map Garching",
      offCampus: "You are not on campus – distances are calculated anyway.",
      loadFail: "Could not load the station data.",
      locTitle: "📍 Location not available",
      locIOS: `<p>Safari is currently not allowed to use your location. To turn it on:</p><ol>
        <li>Turn on <b>Settings → Privacy &amp; Security → Location Services</b>.</li>
        <li>There, set <b>Safari Websites</b> to <b>While Using the App</b> and enable <b>Precise Location</b>.</li>
        <li>In Safari tap <b>aA</b> → <b>Website Settings</b> → <b>Location</b>: <b>Ask</b> or <b>Allow</b>.</li>
        <li>Reload the page and tap 📍 again.</li></ol>`,
      locAndroid: `<p>The browser is currently not allowed to use your location. To turn it on:</p><ol>
        <li>Turn on location/GPS in the quick settings.</li>
        <li>In the browser tap the icon left of the address → <b>Permissions</b> → allow <b>Location</b>.</li>
        <li>Reload the page and tap 📍 again.</li></ol>`,
      locDenied: `<p>Location access is blocked for this page. Allow it in your browser's site settings (icon next to the address) and reload the page.</p>`,
      locUnsupported: `<p>This browser does not support location.</p>`,
      locFailed: `<p>Your location could not be determined (no GPS signal?). Try again outdoors.</p>`,
      locManualHint: "Or set your location by hand – distances and sorting will still work.",
      tech: "Technical info", manual: "Tap on map", reload: "Reload page", retry: "Try again", close: "Close",
      tapMap: "Tap your location on the map.", posSet: "Location set – you can drag the blue dot.",
      poi: { info: "Info stand", food: "Food & drinks", bus: "Bus stop", parking: "Parking", ubahn: "U6 Garching-Forschungszentrum" },
      ubahnNote: "U-Bahn runs every 10 minutes from 9:30 to 11:30.",
    },
    ru: {
      title: "День открытых дверей", search: "Поиск: станции, доклады, еда …",
      secTalks: "Доклады", secFood: "Еда и напитки", building: "Здание",
      locate: "Показать моё местоположение", langTitle: "Язык",
      sheet: "Развернуть/свернуть список", cats: "Категории",
      lStations: "Станции", lInfra: "Инфраструктура (метро, инфо, еда …)", lPlan: "Официальный план", lMap: "Карта",
      multiTitle: (n, r) => `${n} ${plural(n, "станция", "станции", "станций")} в здании ${r}`,
      multiHead: (r, n) => `Здание ${r} · ${n} ${plural(n, "станция", "станции", "станций")}`,
      myPlan: "Мой план", allStations: "Все станции",
      groupHead: (r, n) => `№ ${r} · ${n} ${plural(n, "станция", "станции", "станций")}`, count: (n) => `${n} ${plural(n, "станция", "станции", "станций")}`, countOf: (n, t) => `${n} из ${t} станций`,
      empty: "Ни одна станция не подходит под фильтр.", reset: "Сбросить фильтры",
      rLocation: "Где", rPlan: "План", planNo: "№ ", rNote: "Примечание", rTargets: "Для кого", rFormats: "Формат", rLang: "Язык",
      talks: "Доклады", back: "‹ Назад к списку", away: (d, m) => `📍 ${d} отсюда · ≈ ${m} мин пешком`,
      show: "Показать на карте", inPlan: "★ В моём плане", save: "☆ Сохранить", route: "Маршрут", original: "Оригинал", contact: "Контакты",
      descNote: "Подробное описание программы есть только на немецком.", translate: "Перевести страницу",
      locating: "Определяем местоположение …", me: "Я здесь", unitM: "м", unitKm: "км", docTitle: "Карта кампуса Гархинг",
      offCampus: "Вы не на кампусе – расстояния всё равно посчитаны.",
      loadFail: "Не удалось загрузить данные о станциях.",
      locTitle: "📍 Местоположение недоступно",
      locIOS: `<p>Safari сейчас не может использовать ваше местоположение. Как включить:</p><ol>
        <li>Включите <b>Настройки → Конфиденциальность и безопасность → Службы геолокации</b>.</li>
        <li>Там для <b>Веб-сайты Safari</b> выберите <b>При использовании приложения</b> и включите <b>Точная геопозиция</b>.</li>
        <li>В Safari нажмите <b>aA</b> → <b>Настройки веб-сайта</b> → <b>Геопозиция</b>: <b>Спросить</b> или <b>Разрешить</b>.</li>
        <li>Перезагрузите страницу и снова нажмите 📍.</li></ol>`,
      locAndroid: `<p>Браузеру сейчас запрещено использовать ваше местоположение. Как включить:</p><ol>
        <li>Включите геолокацию/GPS в быстрых настройках.</li>
        <li>В браузере нажмите на значок слева от адреса → <b>Разрешения</b> → разрешите <b>Местоположение</b>.</li>
        <li>Перезагрузите страницу и снова нажмите 📍.</li></ol>`,
      locDenied: `<p>Доступ к местоположению для этой страницы заблокирован. Разрешите его в настройках сайта в браузере (значок рядом с адресом) и перезагрузите страницу.</p>`,
      locUnsupported: `<p>Этот браузер не поддерживает определение местоположения.</p>`,
      locFailed: `<p>Не удалось определить местоположение (нет сигнала GPS?). Попробуйте ещё раз на улице.</p>`,
      locManualHint: "Или отметьте себя на карте вручную – расстояния и сортировка всё равно будут работать.",
      tech: "Техническая информация", manual: "Отметить на карте", reload: "Перезагрузить", retry: "Ещё раз", close: "Закрыть",
      tapMap: "Нажмите на карте, где вы находитесь.", posSet: "Местоположение отмечено – синюю точку можно перетащить.",
      poi: { info: "Инфостенд", food: "Еда и напитки", bus: "Автобусная остановка", parking: "Парковка", ubahn: "U6 Garching-Forschungszentrum (метро)" },
      ubahnNote: "Метро ходит каждые 10 минут с 9:30 до 11:30.",
    },
  };
  // Russian plural forms: 1 станция, 2 станции, 5 станций.
  function plural(n, one, few, many) {
    const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  }
  const LANGS = ["de", "en", "ru"];
  let LANG = pickLang();
  function pickLang() {
    const h = new URLSearchParams(location.hash.slice(1)).get("lang");
    if (LANGS.includes(h)) return h;
    try { const v = localStorage.getItem("garching-lang"); if (LANGS.includes(v)) return v; } catch (e) { /* ignore */ }
    // First of the device's languages we support; English otherwise.
    for (const l of navigator.languages || [navigator.language || "de"]) {
      const c = String(l).slice(0, 2).toLowerCase();
      if (LANGS.includes(c)) return c;
    }
    return "en";
  }
  const T = (k, ...a) => { const v = STR[LANG][k] ?? STR.en[k] ?? STR.de[k]; return typeof v === "function" ? v(...a) : v; };
  // Station texts and labels: current language, then English, then the German original.
  const tx = (s, f) => (LANG !== "de" && (s[`${f}_${LANG}`] || s[`${f}_en`])) || s[f];
  const cl = (c) => (LANG !== "de" && (c[`label_${LANG}`] || c.label_en)) || c.label;

  // ---------- URL hash state: #cat=kinder,familie&q=laser&s=12 ----------
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    state.cats = new Set((p.get("cat") || "").split(",").filter(Boolean));
    state.q = p.get("q") || "";
    state.qm = makeQuery(state.q);
    state.sel = p.get("s") || null;
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (state.cats.size) p.set("cat", [...state.cats].join(","));
    if (state.q) p.set("q", state.q);
    if (state.sel) p.set("s", state.sel);
    if (LANG !== "de") p.set("lang", LANG);
    const h = p.toString().replace(/%2C/g, ",").replace(/%3A/g, ":");
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  }

  // ---------- filtering ----------
  function matches(st, ignoreQuery) {
    // OR within a filter group (Kinder or Jugendliche), AND across groups (Kinder and Vorträge).
    const byGroup = {};
    state.cats.forEach((c) => {
      const g = c === FAV ? FAV : (catById(c) || {}).group;
      if (g) (byGroup[g] = byGroup[g] || []).push(c);
    });
    for (const g in byGroup) {
      if (!byGroup[g].some((c) => (c === FAV ? state.favs.has(st.id) : st.categories.includes(c)))) return false;
    }
    if (ignoreQuery || !state.qm) return true;
    st._score = state.qm(st);
    return st._score > 0;
  }
  function visible() {
    const out = state.data.stations.filter((st) => matches(st) && (!state.group || state.group.includes(st.id)));
    if (state.me) {
      out.forEach((s) => (s._d = s.lat != null ? dist(state.me, s) : Infinity));
      out.sort((a, b) => a._d - b._d);
    }
    // With a search query the best matches come first (stable: distance / plan order as tie-break).
    if (state.qm) out.sort((a, b) => b._score - a._score);
    return out;
  }

  // ---------- map ----------
  let map, stationLayer, poiLayer, poiDetail, meMarker, meCircle, planOverlay, osmLayer, layersCtl;
  const foodMarkers = new Map();
  const keyOf = (p) => p.lat.toFixed(5) + "," + p.lng.toFixed(5);
  const markerByKey = new Map();

  function initMap() {
    const d = state.data;
    map = L.map("map", { zoomControl: false, attributionControl: false, maxZoom: 20 })
      .setView(d.center || [48.2655, 11.6705], d.zoom || 16);
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.attribution({ position: "topleft", prefix: false }).addTo(map);
    osmLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20, maxNativeZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    poiLayer = L.layerGroup().addTo(map);
    poiDetail = L.layerGroup();
    const syncPoi = () => {
      const on = map.getZoom() >= 17 && map.hasLayer(poiLayer);
      if (on && !map.hasLayer(poiDetail)) poiDetail.addTo(map);
      if (!on && map.hasLayer(poiDetail)) map.removeLayer(poiDetail);
    };
    map.on("zoomend overlayadd overlayremove", syncPoi);
    map.on("zoomend", () => state.data && renderMarkers(visible()));
    stationLayer = L.layerGroup().addTo(map);

    if (d.lageplan && d.lageplan.image && d.lageplan.bounds) {
      planOverlay = L.imageOverlay(d.lageplan.image, d.lageplan.bounds, { opacity: 0.75 });
    }
    renderMapChrome();
    syncPoi();
  }

  // Layer switcher and POI markers carry text, so they are rebuilt when the language changes.
  function renderMapChrome() {
    if (layersCtl) layersCtl.remove();
    const overlays = { [T("lStations")]: stationLayer, [T("lInfra")]: poiLayer };
    if (planOverlay) overlays[T("lPlan")] = planOverlay;
    layersCtl = L.control.layers({ [T("lMap")]: osmLayer }, overlays, { position: "topright", collapsed: true }).addTo(map);
    poiLayer.clearLayers(); poiDetail.clearLayers(); foodMarkers.clear();
    // Food vendors at the same spot share one marker that lists all of them.
    const food = new Map();
    state.data.food.forEach((f) => {
      const k = keyOf(f);
      if (!food.has(k)) food.set(k, []);
      food.get(k).push(f);
    });
    food.forEach((arr, k) => {
      const html = `<strong>🍴 ${esc(T("secFood"))}</strong><ul class="food-list">` + arr.map((f) =>
        `<li>${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>` : esc(f.name)}` +
        `${f.hours ? ` <small>(${esc(f.hours)})</small>` : ""}<br><small>${f.building ? esc(T("building")) + " " + esc(f.building) + " · " : ""}<span lang="de">${esc(f.where)}</span></small></li>`).join("") + "</ul>";
      const m = L.marker([arr[0].lat, arr[0].lng], {
        icon: L.divIcon({ className: "", html: `<div class="poi" title="${esc(arr.map((f) => f.name).join(", "))}">🍴${arr.length > 1 ? `<i>${arr.length}</i>` : ""}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        keyboard: false, zIndexOffset: -400,
      }).bindPopup(html, { maxWidth: 280 }).addTo(poiDetail);
      foodMarkers.set(k, m);
    });
    (state.data.pois || []).filter((p) => p.type !== "food").forEach((p) => {
      const name = (T("poi") || {})[p.type] || p.name;
      const note = p.type === "ubahn" ? T("ubahnNote") : p.note;
      L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: "", html: `<div class="poi" title="${esc(name)}">${esc(p.icon || "ℹ️")}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        keyboard: false, zIndexOffset: -500,
      }).bindPopup(`<strong>${esc(name)}</strong>${note ? "<br>" + esc(note) : ""}`)
        .addTo(p.type === "ubahn" || p.type === "info" ? poiLayer : poiDetail);
    });
  }

  // Pins closer than this on screen are merged into one cluster badge (like map apps);
  // from CLUSTER_OFF_ZOOM on every point gets its own pin.
  const CLUSTER_PX = 38, CLUSTER_OFF_ZOOM = 19;
  function renderMarkers(list) {
    stationLayer.clearLayers(); markerByKey.clear();
    // 1. Stations at exactly the same point share a pin.
    const points = new Map();
    list.forEach((s) => {
      if (s.lat == null) return;
      const k = keyOf(s);
      if (!points.has(k)) points.set(k, []);
      points.get(k).push(s);
    });
    // 2. Points that would overlap on screen at this zoom form a cluster.
    const z = map.getZoom();
    const clusters = [];
    points.forEach((arr) => {
      const p = map.project([arr[0].lat, arr[0].lng], z);
      const c = z < CLUSTER_OFF_ZOOM && clusters.find((c) => c.p.distanceTo(p) < CLUSTER_PX);
      if (c) { c.points.push(arr); c.all.push(...arr); } else clusters.push({ p, points: [arr], all: [...arr] });
    });
    clusters.forEach((c) => {
      const sel = c.all.some((s) => s.id === state.sel || (state.group && state.group.includes(s.id)));
      const at = c.points.length === 1 ? [c.all[0].lat, c.all[0].lng] : map.unproject(c.p, z);
      let html, size, anchor, title, onTap;
      if (c.points.length > 1) {
        // Cluster: building number if all are in one building, else the number of stations.
        const blds = new Set(c.all.map((s) => String(s.plan_ref || s.number || "").split(".")[0]));
        const label = blds.size === 1 && [...blds][0] ? [...blds][0] : String(c.all.length);
        html = `<div class="cluster${sel ? " sel" : ""}"><b>${esc(label)}</b>${label !== String(c.all.length) ? `<span class="cnt">${c.all.length}</span>` : ""}</div>`;
        size = [40, 40]; anchor = [20, 20];
        title = T("count", c.all.length);
        onTap = () => zoomInto(c.all);
      } else {
        const arr = c.points[0], single = arr.length === 1;
        const label = single ? (arr[0].number || "•") : (arr[0].plan_ref || "•");
        html = `<div class="pin${single ? "" : " multi"}${sel ? " sel" : ""}" style="--c:${colorOf(arr[0])}"><b>${esc(label)}</b>` +
          `${single ? "" : `<span class="cnt">${arr.length}</span>`}</div>`;
        size = [36, 36]; anchor = [18, 33];
        title = single ? tx(arr[0], "title") : T("groupHead", arr[0].plan_ref || "", arr.length);
        onTap = single ? () => select(arr[0].id, { pan: false }) : () => showGroup(arr);
      }
      const m = L.marker(at, {
        icon: L.divIcon({ className: "", html, iconSize: size, iconAnchor: anchor }),
        title, zIndexOffset: sel ? 1000 : 0,
      }).on("click", onTap).addTo(stationLayer);
      c.all.forEach((s) => markerByKey.set(s.id, m));
    });
  }

  // Tap on a cluster: zoom in until its stations separate.
  function zoomInto(stations) {
    const b = L.latLngBounds(stations.map((s) => [s.lat, s.lng]));
    const bottom = window.innerWidth >= 900 ? 30 : els.sheet.getBoundingClientRect().height + 30;
    const target = Math.min(CLUSTER_OFF_ZOOM, Math.max(map.getZoom() + 1,
      map.getBoundsZoom(b, false, L.point(60, 60 + bottom))));
    map.flyToBounds(b, { paddingTopLeft: [30, 30], paddingBottomRight: [30, bottom], maxZoom: target, duration: 0.5 });
  }

  // Several stations at one point: list them in the bottom sheet.
  function showGroup(arr) {
    state.group = arr.map((s) => s.id);
    state.sel = null;
    render();
    els.list.scrollTop = 0;
    if (els.sheet.dataset.state === "min") els.sheet.dataset.state = "peek";
  }

  // ---------- chips ----------
  function renderChips() {
    const d = state.data;
    const counts = {};
    d.stations.forEach((s) => s.categories.forEach((c) => (counts[c] = (counts[c] || 0) + 1)));
    const chips = [];
    (d.groups || [{ id: undefined }]).forEach((g) => {
      const cats = d.categories.filter((c) => counts[c.id] && c.group === g.id);
      if (!cats.length) return;
      if (g.label) chips.push(`<span class="glabel">${esc(cl(g))}</span>`);
      cats.forEach((c) => chips.push(
        `<button type="button" class="chip" data-cat="${esc(c.id)}" aria-pressed="${state.cats.has(c.id)}" style="--c:${esc(c.color || "")}">` +
        `${TARGET_ICON[c.id] ? TARGET_ICON[c.id] + " " : '<span class="dot"></span>'}${esc(cl(c))} <span class="n">${counts[c.id]}</span></button>`));
    });
    chips.splice(d.groups ? 5 : 0, 0, `<button type="button" class="chip" data-cat="${FAV}" aria-pressed="${state.cats.has(FAV)}" style="--c:#e3a008">★ ${esc(T("myPlan"))} <span class="n">${state.favs.size}</span></button>`);
    els.chips.innerHTML = chips.join("");
  }

  // ---------- list ----------
  function renderList(list) {
    const total = state.data.stations.length;
    if (state.group) {
      const g = state.data.byId[state.group[0]];
      els.count.textContent = T("groupHead", (g && g.plan_ref) || "", state.group.length);
      els.reset.textContent = "✕ " + T("allStations");
      els.reset.hidden = false;
    } else {
      els.count.textContent = list.length === total ? T("count", total) : T("countOf", list.length, total);
      els.reset.textContent = T("reset");
      els.reset.hidden = !(state.cats.size || state.q);
    }
    // With a search query, matching talks (of stations that pass the chips) and food places follow the stations.
    let extra = "";
    if (state.qm) {
      const now = nowHM();
      const ok = new Set(state.data.stations.filter((st) => matches(st, true)).map((st) => st.id));
      const talks = state.data.talks.filter((x) => ok.has(x.s.id) && state.qm(x) >= 5)
        .sort((a, b) => ((a.t.end || a.t.start) < now) - ((b.t.end || b.t.start) < now) || a.t.start.localeCompare(b.t.start));
      if (talks.length) {
        extra += `<li class="sec">🎤 ${esc(T("secTalks"))} · ${talks.length}</li>` + talks.map((x) =>
          `<li><button type="button" class="item talk${(x.t.end || x.t.start) < now ? " past" : ""}" data-id="${esc(x.s.id)}">` +
          `<span class="badge time">${esc(x.t.start)}</span><span class="main"><span class="t">${esc(tx(x.t, "title"))}</span>` +
          `<span class="s">${x.s.number ? esc(x.s.number) + " · " : ""}${esc(tx(x.s, "title"))}</span>` +
          (x.t.where ? `<span class="s clamp">${esc(x.t.where)}</span>` : "") + `</span></button></li>`).join("");
      }
      const food = state.data.food.map((f) => [f, state.qm(f)]).filter(([, sc]) => sc > 0)
        .sort((a, b) => b[1] - a[1]).map(([f]) => f);
      if (food.length) {
        extra += `<li class="sec">🍴 ${esc(T("secFood"))} · ${food.length}</li>` + food.map((f) =>
          `<li><button type="button" class="item food" data-food="${state.data.food.indexOf(f)}">` +
          `<span class="badge food">🍴</span><span class="main"><span class="t">${esc(f.name)}${f.hours ? ` <small>(${esc(f.hours)})</small>` : ""}</span>` +
          `<span class="s">${f.building ? esc(T("building")) + " " + esc(f.building) + " · " : ""}<span lang="de">${esc(f.where)}</span></span></span>` +
          (state.me ? `<span class="dist">${fmtDist(dist(state.me, f))}</span>` : "") + `</button></li>`).join("");
      }
    }
    if (!list.length) {
      els.list.innerHTML = (extra ? "" : `<li class="empty">${esc(T("empty"))}</li>`) + extra;
      return;
    }
    els.list.innerHTML = list.map((s) => {
      const tags = s.categories.filter((c) => c.startsWith("targets:")).map(catById).filter(Boolean)
        .map((c) => `<span class="tag">${TARGET_ICON[c.id] || ""} ${esc(cl(c))}</span>`).join("");
      const d = state.me && isFinite(s._d) ? `<span class="dist">${fmtDist(s._d)}</span>` : "";
      const nt = nextTalk(s);
      return `<li><button type="button" class="item" data-id="${esc(s.id)}">` +
        `<span class="badge" style="--c:${colorOf(s)}">${esc(s.number || "•")}</span>` +
        `<span class="main"><span class="t">${state.favs.has(s.id) ? '<span class="star">★</span> ' : ""}${esc(tx(s, "title"))}</span>` +
        (s.teaser ? `<span class="s clamp">${esc(tx(s, "teaser"))}</span>` : "") +
        (nt ? `<span class="s next">🎤 ${esc(nt.start)} ${esc(tx(nt, "title"))}</span>` : "") +
        (tags ? `<span class="tags">${tags}</span>` : "") +
        `</span>${d}</button></li>`;
    }).join("") + extra;
  }

  // ---------- detail ----------
  let detailId = null;
  function renderDetail() {
    const s = state.sel && state.data.byId[state.sel];
    if (!s) { els.detail.hidden = true; els.listview.hidden = false; detailId = null; return; }
    // Same station again (language switch, favourite, position): keep the reader's scroll position.
    const keep = s.id === detailId ? els.detail.scrollTop : 0;
    detailId = s.id;
    const fav = state.favs.has(s.id);
    const label = (g) => s.categories.filter((c) => c.startsWith(g + ":")).map(catById).filter(Boolean).map(cl).join(", ");
    const rows = [
      [T("rLocation"), s.location], [T("rPlan"), s.number ? T("planNo") + s.number : ""], [T("rNote"), tx(s, "position_note")],
      [T("rTargets"), label("targets")], [T("rFormats"), label("formats")], [T("rLang"), label("languages")],
    ].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
    const tags = (s.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join(" ");
    const now = nowHM();
    const talks = (s.talks || []).length ? `<h3>${esc(T("talks"))}</h3><ul class="talks">` + s.talks.map((t) =>
      `<li class="${(t.end || t.start) < now ? "past" : ""}"><span class="tm">${esc(t.start)}${t.end ? "–" + esc(t.end) : ""}</span>` +
      `<span><strong>${esc(tx(t, "title"))}</strong>${t.speaker ? "<br>" + esc(t.speaker) : ""}${t.where ? `<br><small>${esc(t.where)}</small>` : ""}</span></li>`).join("") +
      `</ul>` : "";
    const d = state.me && s.lat != null ? dist(state.me, s) : null;
    const nav = s.lat != null ? `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${s.lat},${s.lng}` : null;
    // description_html / contact_html are whitelist-sanitised by scripts/build_data.py
    const same = norm(s.description).replace(/\W/g, "") === norm(s.teaser).replace(/\W/g, "");
    const translate = s.url ? `https://translate.google.com/translate?sl=de&tl=${LANG}&u=${encodeURIComponent(s.url)}` : "";
    const descNote = LANG !== "de" && !same && s.description ? `<p class="tnote">${esc(T("descNote"))}${translate ? ` <a href="${translate}" target="_blank" rel="noopener">${esc(T("translate"))} ↗</a>` : ""}</p>` : "";
    const desc = same ? "" : s.description_html || String(s.description || "").split(/\n\s*\n/).filter(Boolean).map((t) => `<p>${esc(t.trim())}</p>`).join("");
    els.detail.innerHTML =
      `<button type="button" class="back" data-act="back">${esc(T("back"))}</button>` +
      `<h2><span class="badge" style="--c:${colorOf(s)}">${esc(s.number || "•")}</span><span>${esc(tx(s, "title"))}</span></h2>` +
      (s.teaser ? `<p class="lead">${esc(tx(s, "teaser"))}</p>` : "") +
      (rows ? `<dl>${rows}</dl>` : "") +
      (d != null ? `<p class="inst">${esc(T("away", fmtDist(d), walkMin(d)))}</p>` : "") +
      `<div class="actions">` +
      (s.lat != null ? `<button type="button" class="btn primary" data-act="show">${esc(T("show"))}</button>` : "") +
      `<button type="button" class="btn" data-act="fav">${esc(fav ? T("inPlan") : T("save"))}</button>` +
      (nav ? `<a class="btn" href="${nav}" target="_blank" rel="noopener">${esc(T("route"))}</a>` : "") +
      (s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(T("original"))}</a>` : "") +
      `</div>${talks}${descNote}<div class="desc" lang="de">${desc}</div>` +
      ((s.links || []).length ? `<p>${s.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || l.url)}</a>`).join(" · ")}</p>` : "") +
      (s.contact_html ? `<h3>${esc(T("contact"))}</h3><div class="desc">${s.contact_html}</div>` : "") +
      (tags ? `<div class="tags">${tags}</div>` : "");
    els.listview.hidden = true; els.detail.hidden = false; els.detail.scrollTop = keep;
  }

  // ---------- actions ----------
  // A new GPS fix only changes distances: update those texts in place instead of rebuilding
  // the list and the card, which would interrupt scrolling (and jump to the top on iOS).
  function renderPosition() {
    const s = state.sel && state.data.byId[state.sel];
    if (s) {
      const el = els.detail.querySelector(".inst");
      if (el && s.lat != null) el.textContent = T("away", fmtDist(dist(state.me, s)), walkMin(dist(state.me, s)));
      else if (!el) renderDetail();
    }
    const shown = [...els.list.querySelectorAll(".item:not(.talk):not(.food)")].map((b) => b.dataset.id);
    const list = visible();
    const same = shown.length === list.length && list.every((st, i) => st.id === shown[i]);
    if (!same || !els.list.querySelector(".dist")) {
      const top = els.list.scrollTop;
      renderList(list);
      els.list.scrollTop = top;
      return;
    }
    list.forEach((st, i) => {
      const d = els.list.querySelectorAll(".item:not(.talk):not(.food) .dist")[i];
      if (d && isFinite(st._d)) d.textContent = fmtDist(st._d);
    });
  }

  function render() {
    const list = visible();
    renderList(list);
    renderMarkers(list);
    renderDetail();
    writeHash();
  }

  function select(id, opts = {}) {
    state.sel = id;
    const s = state.data.byId[id];
    render();
    if (els.sheet.dataset.state === "min") els.sheet.dataset.state = "peek";
    if (s && s.lat != null && opts.pan !== false) {
      viewTo([s.lat, s.lng], Math.max(map.getZoom(), 17));
    }
    if (s && s.lat != null) setTimeout(() => panIntoView(s), 250);
  }

  function focusFood(f) {
    if (!f) return;
    if (!map.hasLayer(poiLayer)) poiLayer.addTo(map);
    if (window.innerWidth < 900) els.sheet.dataset.state = "peek";
    viewTo([f.lat, f.lng], 18);
    setTimeout(() => { const m = foodMarkers.get(keyOf(f)); if (m) m.openPopup(); panIntoView(f); }, 300);
  }

  // Leaflet ignores a zoom requested while another zoom animation is running (e.g. the first
  // GPS fix arriving during the initial fit or a pinch), so wait for that animation to end.
  function viewTo(ll, zoom) {
    const go = () => map.setView(ll, zoom == null ? map.getZoom() : zoom);
    if (map._animatingZoom) map.once("zoomend", () => setTimeout(go, 0)); else go();
  }

  // Keep the selected pin above the bottom sheet on phones.
  function panIntoView(s) {
    const mapH = map.getSize().y;
    const sheetH = window.innerWidth >= 900 ? 0 : els.sheet.getBoundingClientRect().height;
    const p = map.latLngToContainerPoint([s.lat, s.lng]);
    const free = mapH - sheetH;
    if (p.y > free - 90 || p.y < 60) map.panBy([0, p.y - free / 2], { animate: true });
  }

  function bind() {
    els.chips.addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      const c = b.dataset.cat;
      state.cats.has(c) ? state.cats.delete(c) : state.cats.add(c);
      state.sel = null; state.group = null;
      renderChips(); render(); ensureVisible();
    });
    let t, tf;
    const runSearch = () => { state.q = els.search.value.trim(); state.qm = makeQuery(state.q); state.sel = null; state.group = null; render(); els.list.scrollTop = 0; };
    // Show where the results are once typing pauses; the list is already up to date.
    // A specific search (up to 3 stations) jumps there; a broad one keeps the view if a hit is on screen.
    const fitResults = () => { const n = state.qm ? visible().length : 0; if (n && n <= 3) fitVisible(); else if (n) ensureVisible(); };
    els.search.addEventListener("input", () => {
      clearTimeout(t); clearTimeout(tf);
      t = setTimeout(runSearch, 120);
      tf = setTimeout(fitResults, 900);
    });
    // "Search" on the phone keyboard: close the keyboard so the results become visible.
    els.search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      clearTimeout(t); clearTimeout(tf);
      runSearch(); fitResults();
      els.search.blur();
      if (window.innerWidth < 900 && els.sheet.dataset.state === "min") els.sheet.dataset.state = "peek";
    });
    els.reset.addEventListener("click", () => {
      if (state.group) { state.group = null; state.sel = null; render(); return; }
      state.cats.clear(); state.q = ""; state.qm = null; els.search.value = ""; state.sel = null;
      renderChips(); render(); ensureVisible();
    });
    els.list.addEventListener("click", (e) => {
      const b = e.target.closest(".item");
      if (!b) return;
      if (b.dataset.food != null) focusFood(state.data.food[+b.dataset.food]);
      else select(b.dataset.id);
    });
    els.detail.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const s = state.data.byId[state.sel];
      if (b.dataset.act === "back") { state.sel = null; render(); }
      else if (b.dataset.act === "show") { if (window.innerWidth < 900) els.sheet.dataset.state = "peek"; map.setView([s.lat, s.lng], 18); setTimeout(() => panIntoView(s), 250); }
      else if (b.dataset.act === "fav") {
        state.favs.has(s.id) ? state.favs.delete(s.id) : state.favs.add(s.id);
        saveFavs(); renderChips(); render();
      }
    });
    els.grip.addEventListener("click", () => {
      const order = { min: "peek", peek: "full", full: "min" };
      els.sheet.dataset.state = order[els.sheet.dataset.state] || "peek";
    });
    // Simple swipe on the grip / list head to resize the sheet.
    let y0 = null;
    els.sheet.addEventListener("touchstart", (e) => {
      if (e.target.closest(".grip, .listhead")) y0 = e.touches[0].clientY;
    }, { passive: true });
    els.sheet.addEventListener("touchend", (e) => {
      if (y0 == null) return;
      const dy = e.changedTouches[0].clientY - y0; y0 = null;
      const st = els.sheet.dataset.state;
      if (dy < -30) els.sheet.dataset.state = st === "min" ? "peek" : "full";
      else if (dy > 30) els.sheet.dataset.state = st === "full" ? "peek" : "min";
    });
    els.locate.addEventListener("click", locate);
    els.lang.addEventListener("change", () => setLang(els.lang.value));
    window.addEventListener("hashchange", () => { const hl = new URLSearchParams(location.hash.slice(1)).get("lang"); if (LANGS.includes(hl)) setLang(hl); readHash(); els.search.value = state.q; renderChips(); render(); });
  }

  // After a filter change keep the map where it is as long as at least one matching station
  // is on screen (above the bottom sheet); only otherwise move to the results.
  function ensureVisible() {
    const list = visible().filter((s) => s.lat != null);
    if (!list.length) return;
    const size = map.getSize();
    const sheetH = window.innerWidth >= 900 ? 0 : els.sheet.getBoundingClientRect().height;
    const view = L.latLngBounds(map.containerPointToLatLng([0, 0]), map.containerPointToLatLng([size.x, Math.max(40, size.y - sheetH)]));
    if (!list.some((s) => view.contains([s.lat, s.lng]))) fitVisible();
  }

  function fitVisible() {
    const pts = visible().filter((s) => s.lat != null).map((s) => [s.lat, s.lng]);
    if (!pts.length) return;
    const bottom = window.innerWidth >= 900 ? 20 : els.sheet.getBoundingClientRect().height + 20;
    map.fitBounds(pts, { paddingTopLeft: [20, 20], paddingBottomRight: [20, bottom], maxZoom: 18 });
  }

  // ---------- geolocation ----------
  let watchId = null, firstFix = true;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(navigator.userAgent);

  // ---------- heading (direction the phone points to) ----------
  // Compass: iOS gives webkitCompassHeading (needs permission from a tap), Android/Chrome
  // gives an absolute alpha. Without a compass the GPS course is used while walking.
  let compass = null, gpsHeading = null, shownHeading = null, compassStarted = false, headingFrame = 0;
  function screenAngle() {
    return (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  }
  function startCompass() {
    if (compassStarted || typeof window.DeviceOrientationEvent === "undefined") return;
    compassStarted = true;
    const listen = () => {
      const absolute = "ondeviceorientationabsolute" in window;
      window.addEventListener(absolute ? "deviceorientationabsolute" : "deviceorientation", (e) => {
        let h = null;
        if (typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
        else if ((e.absolute || absolute) && typeof e.alpha === "number") h = 360 - e.alpha;
        if (h == null) return;
        compass = { h: (h + screenAngle() + 360) % 360, at: Date.now() };
        if (!headingFrame) headingFrame = requestAnimationFrame(() => { headingFrame = 0; applyHeading(); });
      }, true);
    };
    // iOS 13+: must be requested inside the tap handler.
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().then((r) => { if (r === "granted") listen(); }).catch(() => {});
    } else listen();
  }
  function applyHeading() {
    const cone = meMarker && meMarker.getElement() && meMarker.getElement().querySelector(".me-cone");
    if (!cone) return;
    const now = Date.now();
    const src = compass && now - compass.at < 3000 ? compass : gpsHeading && now - gpsHeading.at < 10000 ? gpsHeading : null;
    if (!src) { cone.classList.remove("on"); return; }
    // Smooth and keep the angle continuous so 359° → 1° does not spin around.
    if (shownHeading == null) shownHeading = src.h;
    else shownHeading += ((((src.h - shownHeading) % 360) + 540) % 360 - 180) * 0.35; // shortest way round
    cone.style.transform = `rotate(${shownHeading}deg)`;
    cone.classList.add("on");
  }

  function locate() {
    startCompass();
    closeLocHelp();
    if (!("geolocation" in navigator)) { showLocHelp(0); return; }
    if (watchId != null) {
      if (state.me) viewTo([state.me.lat, state.me.lng], Math.max(map.getZoom(), 17));
      return;
    }
    els.locate.classList.add("active");
    toast(T("locating"));
    firstFix = true;
    watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }

  function setMe(lat, lng, acc, manual) {
    state.me = { lat, lng, acc, manual };
    const ll = [lat, lng];
    if (!meMarker) {
      meMarker = L.marker(ll, {
        icon: L.divIcon({ className: "", html: '<div class="me-wrap"><div class="me-cone"></div><div class="me"></div></div>', iconSize: [96, 96], iconAnchor: [48, 48] }),
        zIndexOffset: 2000, keyboard: false, title: T("me"),
      }).addTo(map);
      meCircle = L.circle(ll, { radius: acc, color: "#1a73e8", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
      meMarker.on("dragend", () => { const p = meMarker.getLatLng(); setMe(p.lat, p.lng, 15, true); });
    } else { meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(acc); }
    // A hand-placed position can be dragged; a GPS position follows the device.
    if (meMarker.dragging) manual ? meMarker.dragging.enable() : meMarker.dragging.disable();
    applyHeading();
    renderPosition();
  }

  function onPos(p) {
    const c = p.coords;
    // Moving: the GPS course is a fallback direction when there is no compass.
    if (c.heading != null && !isNaN(c.heading) && c.speed > 0.7) gpsHeading = { h: c.heading, at: Date.now() };
    // Ignore jitter: same place (< 3 m) and similar accuracy.
    if (state.me && !state.me.manual && !firstFix && dist(state.me, { lat: c.latitude, lng: c.longitude }) < 3 &&
        Math.abs(state.me.acc - c.accuracy) < 5) { applyHeading(); return; }
    setMe(c.latitude, c.longitude, c.accuracy, false);
    if (firstFix) {
      firstFix = false;
      const c = state.data.center || [48.2655, 11.6705];
      if (dist(state.me, { lat: c[0], lng: c[1] }) > 5000) toast(T("offCampus"));
      else els.toast.hidden = true;
      viewTo([state.me.lat, state.me.lng], Math.max(map.getZoom(), 17));
      setTimeout(() => state.me && panIntoView(state.me), 600);
    }
  }

  function onPosErr(e) {
    // Brief signal loss (indoors, code 2/3) while we already have a fix: keep watching quietly.
    if (e.code !== 1 && state.me && !firstFix) return;
    els.locate.classList.remove("active");
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    els.toast.hidden = true;
    showLocHelp(e.code, e.message);
  }

  // Safari on iOS answers "denied" without asking when location is off for Safari websites,
  // so explain where to switch it on and offer to place the position by hand.
  let helpEl = null;
  function closeLocHelp() { if (helpEl) { helpEl.remove(); helpEl = null; } }
  function showLocHelp(code, detail) {
    closeLocHelp();
    const steps = code === 1 ? T(isIOS ? "locIOS" : isAndroid ? "locAndroid" : "locDenied")
      : code === 0 ? T("locUnsupported") : T("locFailed");
    helpEl = document.createElement("div");
    helpEl.className = "lochelp";
    helpEl.setAttribute("role", "dialog");
    helpEl.setAttribute("aria-label", T("locTitle"));
    helpEl.innerHTML = `<h3>${esc(T("locTitle"))}</h3>${steps}
      <p>${esc(T("locManualHint"))}</p>
      <p class="tech">${esc(T("tech"))}: Code ${esc(code)}${detail ? " – " + esc(detail) : ""}</p>
      <div class="actions">
        <button type="button" class="btn primary" data-act="manual">${esc(T("manual"))}</button>
        ${code === 1 ? `<button type="button" class="btn" data-act="reload">${esc(T("reload"))}</button>` : `<button type="button" class="btn" data-act="retry">${esc(T("retry"))}</button>`}
        <button type="button" class="btn" data-act="close">${esc(T("close"))}</button>
      </div>`;
    helpEl.addEventListener("click", (e) => {
      const a = (e.target.closest("[data-act]") || {}).dataset?.act;
      if (a === "close") closeLocHelp();
      else if (a === "retry") locate();
      else if (a === "reload") location.reload();
      else if (a === "manual") pickManually();
    });
    document.body.appendChild(helpEl);
  }

  function pickManually() {
    startCompass();
    closeLocHelp();
    if (window.innerWidth < 900) els.sheet.dataset.state = "min";
    toast(T("tapMap"));
    map.getContainer().classList.add("picking");
    map.once("click", (e) => {
      map.getContainer().classList.remove("picking");
      setMe(e.latlng.lat, e.latlng.lng, 15, true);
      els.sheet.dataset.state = "peek";
      toast(T("posSet"));
    });
  }

  // Texts that live in index.html.
  function applyStatic() {
    document.documentElement.lang = LANG;
    document.title = T("docTitle") || "Campus-Karte Garching";
    els.title.textContent = T("title");
    els.search.placeholder = T("search");
    els.search.setAttribute("aria-label", T("search"));
    els.locate.title = T("locate"); els.locate.setAttribute("aria-label", T("locate"));
    els.lang.value = LANG; els.lang.title = T("langTitle"); els.lang.setAttribute("aria-label", T("langTitle"));
    els.grip.setAttribute("aria-label", T("sheet"));
    els.chips.setAttribute("aria-label", T("cats"));
    els.reset.textContent = T("reset");
  }

  function setLang(l) {
    if (l === LANG) return;
    LANG = l;
    try { localStorage.setItem("garching-lang", l); } catch (e) { /* ignore */ }
    closeLocHelp();
    applyStatic();
    if (map) renderMapChrome();
    renderChips();
    render();
  }

  // ---------- boot ----------
  async function boot() {
    let data, pois = [];
    try {
      data = await (await fetch("data/stations.json", { cache: "no-cache" })).json();
    } catch (e) {
      els.list.innerHTML = `<li class="empty">${esc(T("loadFail"))}</li>`;
      return;
    }
    try { pois = await (await fetch("data/pois.json", { cache: "no-cache" })).json(); } catch (e) { /* optional */ }
    data.pois = Array.isArray(pois) ? pois : pois.pois || [];
    data.catIndex = Object.fromEntries(data.categories.map((c) => [c.id, c]));
    data.byId = {};
    data.stations.forEach((s) => {
      s.id = String(s.id);
      s.categories = s.categories || [];
      indexItem(s, [s.number, s.title, s.title_en, s.title_ru],
        [s.teaser, s.teaser_en, s.teaser_ru, s.location, ...(s.tags || []),
          ...s.categories.flatMap((c) => { const k = data.catIndex[c] || {}; return [k.label, k.label_en, k.label_ru]; })],
        [s.description, ...(s.talks || []).map((t) => [t.title, t.title_en, t.title_ru, t.speaker].join(" "))]);
      data.byId[s.id] = s;
    });
    data.food = data.pois.filter((p) => p.type === "food");
    data.food.forEach((f) => indexItem(f, [f.name], [f.search || "", f.where], [f.building ? "gebaude building здание " + f.building : ""]));
    data.talks = data.stations.flatMap((s) => (s.talks || []).map((t) => {
      const x = { t, s };
      indexItem(x, [t.title, t.title_en, t.title_ru], [t.speaker, s.title, s.title_en, s.title_ru], [t.where, "vortrag talk доклад"]);
      return x;
    }));
    state.data = data;
    applyStatic();
    readHash();
    els.search.value = state.q;
    initMap();
    renderChips();
    bind();
    render();
    if (state.sel && data.byId[state.sel]) select(state.sel);
    else fitVisible();
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }
  boot();
})();
