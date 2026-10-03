/* Campus-Karte Garching – Tag der offenen Tür, 3. Oktober 2026 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const els = {
    chips: $("#chips"), search: $("#search"), list: $("#list"), count: $("#count"),
    reset: $("#reset"), sheet: $("#sheet"), grip: $("#grip"), listview: $("#listview"),
    detail: $("#detail"), locate: $("#locate"), toast: $("#toast"),
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
    if (m < 1000) return "≈ " + Math.max(10, Math.round(m / 10) * 10) + " m";
    return "≈ " + (m / 1000).toFixed(1).replace(".", ",") + " km";
  }
  function walkMin(m) { return Math.max(1, Math.round(m / 75)); } // ~4.5 km/h
  function catById(id) { return state.data.catIndex[id]; }
  function colorOf(st) {
    const c = st.categories.map(catById).find((c) => c && c.color);
    return c ? c.color : "#0b5cad";
  }
  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg; els.toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (els.toast.hidden = true), 3500);
  }

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
    const h = p.toString().replace(/%2C/g, ",");
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  }

  // ---------- filtering ----------
  function matches(st) {
    if (state.cats.size) {
      const ok = [...state.cats].some((c) => (c === FAV ? state.favs.has(st.id) : st.categories.includes(c)));
      if (!ok) return false;
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
  let map, stationLayer, poiLayer, meMarker, meCircle, planOverlay;
  const markerByKey = new Map();

  function initMap() {
    const d = state.data;
    map = L.map("map", { zoomControl: false, attributionControl: false, maxZoom: 20 })
      .setView(d.center || [48.2655, 11.6705], d.zoom || 16);
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.attribution({ position: "topleft", prefix: false }).addTo(map);
    const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20, maxNativeZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    poiLayer = L.layerGroup().addTo(map);
    stationLayer = L.layerGroup().addTo(map);

    const overlays = { "Stationen": stationLayer, "Infrastruktur (U-Bahn, Info, Essen …)": poiLayer };
    if (d.lageplan && d.lageplan.image && d.lageplan.bounds) {
      planOverlay = L.imageOverlay(d.lageplan.image, d.lageplan.bounds, { opacity: 0.75 });
      overlays["Offizieller Lageplan"] = planOverlay;
    }
    L.control.layers({ "Karte": osm }, overlays, { position: "topright", collapsed: true }).addTo(map);

    (d.pois || []).forEach((p) => {
      L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: "", html: `<div class="poi" title="${esc(p.name)}">${esc(p.icon || "ℹ️")}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        keyboard: false, zIndexOffset: -500,
      }).bindPopup(`<strong>${esc(p.name)}</strong>${p.note ? "<br>" + esc(p.note) : ""}`).addTo(poiLayer);
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
      const label = single ? (arr[0].number || "•") : arr.length;
      const color = single ? colorOf(arr[0]) : "#334155";
      const html = `<div class="pin${single ? "" : " multi"}${sel ? " sel" : ""}" style="--c:${color}"><b>${esc(label)}</b></div>`;
      const m = L.marker([arr[0].lat, arr[0].lng], {
        icon: L.divIcon({ className: "", html, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] }),
        title: single ? arr[0].title : `${arr.length} Stationen: ${arr[0].building || ""}`,
        zIndexOffset: sel ? 1000 : 0,
      });
      if (single) {
        m.on("click", () => select(arr[0].id, { pan: false }));
      } else {
        const ul = document.createElement("div");
        ul.innerHTML = `<strong>${esc(arr[0].building || arr.length + " Stationen")}</strong><ul class="popup-list">` +
          arr.map((s) => `<li><button type="button" data-id="${esc(s.id)}">${s.number ? esc(s.number) + " · " : ""}${esc(s.title)}</button></li>`).join("") + "</ul>";
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
    const cats = d.categories.filter((c) => counts[c.id]);
    const chips = cats.map((c) =>
      `<button type="button" class="chip" data-cat="${esc(c.id)}" aria-pressed="${state.cats.has(c.id)}" style="--c:${esc(c.color || "")}">` +
      `<span class="dot"></span>${esc(c.label)} <span class="n">${counts[c.id]}</span></button>`);
    chips.push(`<button type="button" class="chip" data-cat="${FAV}" aria-pressed="${state.cats.has(FAV)}" style="--c:#e3a008">★ Mein Plan <span class="n">${state.favs.size}</span></button>`);
    els.chips.innerHTML = chips.join("");
  }

  // ---------- list ----------
  function renderList(list) {
    const total = state.data.stations.length;
    els.count.textContent = list.length === total ? `${total} Stationen` : `${list.length} von ${total} Stationen`;
    els.reset.hidden = !(state.cats.size || state.q);
    if (!list.length) {
      els.list.innerHTML = `<li class="empty">Keine Station passt zu diesem Filter.</li>`;
      return;
    }
    els.list.innerHTML = list.map((s) => {
      const tags = s.categories.map(catById).filter(Boolean).map((c) => `<span class="tag">${esc(c.label)}</span>`).join("");
      const sub = [s.institution, s.building].filter(Boolean).join(" · ");
      const d = state.me && isFinite(s._d) ? `<span class="dist">${fmtDist(s._d)}</span>` : "";
      return `<li><button type="button" class="item" data-id="${esc(s.id)}">` +
        `<span class="badge" style="--c:${colorOf(s)}">${esc(s.number || "•")}</span>` +
        `<span class="main"><span class="t">${state.favs.has(s.id) ? '<span class="star">★</span> ' : ""}${esc(s.title)}</span>` +
        (sub ? `<span class="s">${esc(sub)}</span>` : "") +
        (s.times ? `<span class="s">🕒 ${esc(s.times)}</span>` : "") +
        (tags ? `<span class="tags">${tags}</span>` : "") +
        `</span>${d}</button></li>`;
    }).join("");
  }

  // ---------- detail ----------
  function renderDetail() {
    const s = state.sel && state.data.byId[state.sel];
    if (!s) { els.detail.hidden = true; els.listview.hidden = false; return; }
    const fav = state.favs.has(s.id);
    const rows = [
      ["Institution", s.institution], ["Gebäude", s.building], ["Adresse", s.address], ["Raum", s.room],
      ["Zeiten", s.times], ["Zielgruppe", s.audience],
    ].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
    const tags = s.categories.map(catById).filter(Boolean).map((c) => `<span class="tag">${esc(c.label)}</span>`).join(" ");
    const d = state.me && s.lat != null ? dist(state.me, s) : null;
    const nav = s.lat != null ? `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${s.lat},${s.lng}` : null;
    const desc = String(s.description || "").split(/\n\s*\n/).filter(Boolean).map((t) => `<p>${esc(t.trim())}</p>`).join("");
    els.detail.innerHTML =
      `<button type="button" class="back" data-act="back">‹ Zurück zur Liste</button>` +
      `<h2><span class="badge" style="--c:${colorOf(s)}">${esc(s.number || "•")}</span><span>${esc(s.title)}</span></h2>` +
      (tags ? `<div class="tags">${tags}</div>` : "") +
      (rows ? `<dl>${rows}</dl>` : "") +
      (d != null ? `<p class="inst">📍 ${fmtDist(d)} entfernt · ca. ${walkMin(d)} Min. zu Fuß</p>` : "") +
      `<div class="actions">` +
      (s.lat != null ? `<button type="button" class="btn primary" data-act="show">Auf Karte zeigen</button>` : "") +
      `<button type="button" class="btn" data-act="fav">${fav ? "★ Im Plan" : "☆ Merken"}</button>` +
      (nav ? `<a class="btn" href="${nav}" target="_blank" rel="noopener">Route</a>` : "") +
      (s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">Original</a>` : "") +
      `</div><div class="desc">${desc}</div>`;
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
    window.addEventListener("hashchange", () => { readHash(); els.search.value = state.q; renderChips(); render(); });
  }

  function fitVisible() {
    const pts = visible().filter((s) => s.lat != null).map((s) => [s.lat, s.lng]);
    if (!pts.length) return;
    const bottom = window.innerWidth >= 900 ? 20 : els.sheet.getBoundingClientRect().height + 20;
    map.fitBounds(pts, { paddingTopLeft: [20, 20], paddingBottomRight: [20, bottom], maxZoom: 18 });
  }

  // ---------- geolocation ----------
  let watchId = null, firstFix = true;
  function locate() {
    if (!("geolocation" in navigator)) { toast("Standort wird von diesem Browser nicht unterstützt."); return; }
    if (watchId != null) {
      if (state.me) map.setView([state.me.lat, state.me.lng], Math.max(map.getZoom(), 17));
      return;
    }
    els.locate.classList.add("active");
    toast("Standort wird gesucht …");
    firstFix = true;
    watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
  function onPos(p) {
    state.me = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    const ll = [state.me.lat, state.me.lng];
    if (!meMarker) {
      meMarker = L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 2000, keyboard: false, title: "Mein Standort" }).addTo(map);
      meCircle = L.circle(ll, { radius: state.me.acc, color: "#1a73e8", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    } else { meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(state.me.acc); }
    if (firstFix) {
      firstFix = false;
      const c = state.data.center || [48.2655, 11.6705];
      if (dist(state.me, { lat: c[0], lng: c[1] }) > 5000) toast("Du bist nicht auf dem Campus – Entfernungen sind trotzdem berechnet.");
      else els.toast.hidden = true;
      map.setView(ll, Math.max(map.getZoom(), 17));
    }
    render();
  }
  function onPosErr(e) {
    els.locate.classList.remove("active");
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    toast(e.code === 1 ? "Standortzugriff verweigert – bitte in den Browser-Einstellungen erlauben." : "Standort konnte nicht bestimmt werden.");
  }

  // ---------- boot ----------
  async function boot() {
    let data, pois = [];
    try {
      data = await (await fetch("data/stations.json", { cache: "no-cache" })).json();
    } catch (e) {
      els.list.innerHTML = `<li class="empty">Stationsdaten konnten nicht geladen werden.</li>`;
      return;
    }
    try { pois = await (await fetch("data/pois.json", { cache: "no-cache" })).json(); } catch (e) { /* optional */ }
    data.pois = Array.isArray(pois) ? pois : pois.pois || [];
    data.catIndex = Object.fromEntries(data.categories.map((c) => [c.id, c]));
    data.byId = {};
    data.stations.forEach((s) => {
      s.id = String(s.id);
      s.categories = s.categories || [];
      s._text = norm([s.number, s.title, s.institution, s.building, s.address, s.room, s.description, s.audience,
        ...s.categories.map((c) => (data.catIndex[c] || {}).label)].join(" "));
      data.byId[s.id] = s;
    });
    state.data = data;
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
