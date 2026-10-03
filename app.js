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
    sel: null,        // selected station id
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
      title: "Tag der offenen Tür · Garching", search: "Station, Institut, Thema suchen …",
      locate: "Meinen Standort zeigen", langTitle: "Sprache", docTitle: "Campus-Karte Garching",
      sheet: "Liste ein-/ausklappen", cats: "Kategorien",
      lStations: "Stationen", lInfra: "Infrastruktur (U-Bahn, Info, Essen …)", lPlan: "Offizieller Lageplan", lMap: "Karte",
      multiTitle: (n, r) => `${n} Stationen in Gebäude ${r}`, multiHead: (r, n) => `Gebäude ${r} · ${n} Stationen`,
      myPlan: "Mein Plan", count: (n) => `${n} Stationen`, countOf: (n, t) => `${n} von ${t} Stationen`,
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
      title: "Open Day · Garching", search: "Search station, institute, topic …",
      locate: "Show my location", langTitle: "Language",
      sheet: "Expand/collapse list", cats: "Categories",
      lStations: "Stations", lInfra: "Facilities (U-Bahn, info, food …)", lPlan: "Official site plan", lMap: "Map",
      multiTitle: (n, r) => `${n} stations in building ${r}`, multiHead: (r, n) => `Building ${r} · ${n} stations`,
      myPlan: "My plan", count: (n) => `${n} stations`, countOf: (n, t) => `${n} of ${t} stations`,
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
      title: "День открытых дверей", search: "Поиск: станция, институт, тема …",
      locate: "Показать моё местоположение", langTitle: "Язык",
      sheet: "Развернуть/свернуть список", cats: "Категории",
      lStations: "Станции", lInfra: "Инфраструктура (метро, инфо, еда …)", lPlan: "Официальный план", lMap: "Карта",
      multiTitle: (n, r) => `${n} ${plural(n, "станция", "станции", "станций")} в здании ${r}`,
      multiHead: (r, n) => `Здание ${r} · ${n} ${plural(n, "станция", "станции", "станций")}`,
      myPlan: "Мой план", count: (n) => `${n} ${plural(n, "станция", "станции", "станций")}`, countOf: (n, t) => `${n} из ${t} станций`,
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
  function matches(st) {
    // OR within a filter group (Kinder or Jugendliche), AND across groups (Kinder and Vorträge).
    const byGroup = {};
    state.cats.forEach((c) => {
      const g = c === FAV ? FAV : (catById(c) || {}).group;
      if (g) (byGroup[g] = byGroup[g] || []).push(c);
    });
    for (const g in byGroup) {
      if (!byGroup[g].some((c) => (c === FAV ? state.favs.has(st.id) : st.categories.includes(c)))) return false;
    }
    if (state.q) {
      const words = norm(state.q).split(/\s+/).filter(Boolean);
      return words.every((w) => st._text.includes(w));
    }
    return true;
  }
  function visible() {
    const out = state.data.stations.filter(matches);
    if (state.me) {
      out.forEach((s) => (s._d = s.lat != null ? dist(state.me, s) : Infinity));
      out.sort((a, b) => a._d - b._d);
    }
    return out;
  }

  // ---------- map ----------
  let map, stationLayer, poiLayer, poiDetail, meMarker, meCircle, planOverlay, osmLayer, layersCtl;
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
    poiLayer.clearLayers(); poiDetail.clearLayers();
    (state.data.pois || []).forEach((p) => {
      const name = (T("poi") || {})[p.type] || p.name;
      const note = p.type === "ubahn" ? T("ubahnNote") : p.note;
      L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: "", html: `<div class="poi" title="${esc(name)}">${esc(p.icon || "ℹ️")}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        keyboard: false, zIndexOffset: -500,
      }).bindPopup(`<strong>${esc(name)}</strong>${note ? "<br>" + esc(note) : ""}`)
        .addTo(p.type === "ubahn" || p.type === "info" ? poiLayer : poiDetail);
    });
  }

  function renderMarkers(list) {
    stationLayer.clearLayers(); markerByKey.clear();
    const groups = new Map();
    list.forEach((s) => {
      if (s.lat == null) return;
      const k = s.lat.toFixed(5) + "," + s.lng.toFixed(5);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    });
    groups.forEach((arr, k) => {
      const single = arr.length === 1;
      const sel = arr.some((s) => s.id === state.sel);
      // A building with several stations shows its Lageplan number plus a count bubble.
      const label = single ? (arr[0].number || "•") : (arr[0].plan_ref || "•");
      const html = `<div class="pin${single ? "" : " multi"}${sel ? " sel" : ""}" style="--c:${colorOf(arr[0])}"${single ? "" : ` data-n="${arr.length}"`}><b>${esc(label)}</b></div>`;
      const m = L.marker([arr[0].lat, arr[0].lng], {
        icon: L.divIcon({ className: "", html, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] }),
        title: single ? tx(arr[0], "title") : T("multiTitle", arr.length, arr[0].plan_ref || ""),
        zIndexOffset: sel ? 1000 : 0,
      });
      if (single) {
        m.on("click", () => select(arr[0].id, { pan: false }));
      } else {
        const ul = document.createElement("div");
        ul.innerHTML = `<strong>${esc(T("multiHead", arr[0].plan_ref || "", arr.length))}</strong><ul class="popup-list">` +
          arr.map((s) => `<li><button type="button" data-id="${esc(s.id)}">${s.number ? esc(s.number) + " · " : ""}${esc(tx(s, "title"))}</button></li>`).join("") + "</ul>";
        ul.addEventListener("click", (e) => { const b = e.target.closest("button[data-id]"); if (b) { map.closePopup(); select(b.dataset.id, { pan: false }); } });
        m.bindPopup(ul, { maxWidth: 280 });
      }
      m.addTo(stationLayer);
      arr.forEach((s) => markerByKey.set(s.id, m));
    });
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
    els.count.textContent = list.length === total ? T("count", total) : T("countOf", list.length, total);
    els.reset.hidden = !(state.cats.size || state.q);
    if (!list.length) {
      els.list.innerHTML = `<li class="empty">${esc(T("empty"))}</li>`;
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
        (nt ? `<span class="s next">🎤 ${esc(nt.start)} ${esc(nt.title)}</span>` : "") +
        (tags ? `<span class="tags">${tags}</span>` : "") +
        `</span>${d}</button></li>`;
    }).join("");
  }

  // ---------- detail ----------
  function renderDetail() {
    const s = state.sel && state.data.byId[state.sel];
    if (!s) { els.detail.hidden = true; els.listview.hidden = false; return; }
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
      `<span><strong>${esc(t.title)}</strong>${t.speaker ? "<br>" + esc(t.speaker) : ""}${t.where ? `<br><small>${esc(t.where)}</small>` : ""}</span></li>`).join("") +
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
    els.listview.hidden = true; els.detail.hidden = false; els.detail.scrollTop = 0;
  }

  // ---------- actions ----------
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
      map.setView([s.lat, s.lng], Math.max(map.getZoom(), 17), { animate: true });
    }
    if (s && s.lat != null) setTimeout(() => panIntoView(s), 250);
  }

  // Keep the selected pin above the bottom sheet on phones.
  function panIntoView(s) {
    const mapH = map.getSize().y;
    const sheetH = window.innerWidth >= 900 ? 0 : els.sheet.getBoundingClientRect().height;
    const p = map.latLngToContainerPoint([s.lat, s.lng]);
    const free = mapH - sheetH;
    if (p.y > free - 40 || p.y < 40) map.panBy([0, p.y - free / 2], { animate: true });
  }

  function bind() {
    els.chips.addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      const c = b.dataset.cat;
      state.cats.has(c) ? state.cats.delete(c) : state.cats.add(c);
      state.sel = null;
      renderChips(); render(); fitVisible();
    });
    let t;
    els.search.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => { state.q = els.search.value.trim(); state.sel = null; render(); }, 120);
    });
    els.reset.addEventListener("click", () => {
      state.cats.clear(); state.q = ""; els.search.value = ""; state.sel = null;
      renderChips(); render(); fitVisible();
    });
    els.list.addEventListener("click", (e) => {
      const b = e.target.closest(".item"); if (b) select(b.dataset.id);
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

  function locate() {
    closeLocHelp();
    if (!("geolocation" in navigator)) { showLocHelp(0); return; }
    if (watchId != null) {
      if (state.me) map.setView([state.me.lat, state.me.lng], Math.max(map.getZoom(), 17));
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
      meMarker = L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 2000, keyboard: false, title: T("me") }).addTo(map);
      meCircle = L.circle(ll, { radius: acc, color: "#1a73e8", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
      meMarker.on("dragend", () => { const p = meMarker.getLatLng(); setMe(p.lat, p.lng, 15, true); });
    } else { meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(acc); }
    // A hand-placed position can be dragged; a GPS position follows the device.
    if (meMarker.dragging) manual ? meMarker.dragging.enable() : meMarker.dragging.disable();
    render();
  }

  function onPos(p) {
    setMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy, false);
    if (firstFix) {
      firstFix = false;
      const c = state.data.center || [48.2655, 11.6705];
      if (dist(state.me, { lat: c[0], lng: c[1] }) > 5000) toast(T("offCampus"));
      else els.toast.hidden = true;
      map.setView([state.me.lat, state.me.lng], Math.max(map.getZoom(), 17));
    }
  }

  function onPosErr(e) {
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
      s._text = norm([s.number, s.title, s.title_en, s.title_ru, s.teaser, s.teaser_en, s.teaser_ru, s.location, s.description, ...(s.tags || []),
        ...(s.talks || []).map((t) => t.title + " " + t.speaker),
        ...s.categories.flatMap((c) => { const k = data.catIndex[c] || {}; return [k.label, k.label_en, k.label_ru]; })].join(" "));
      data.byId[s.id] = s;
    });
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
