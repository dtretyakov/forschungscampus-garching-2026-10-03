// Offline support for weak campus reception: app shell cache-first,
// station data network-first, map tiles cached as they are viewed.
const SHELL = "shell-v8";
const TILES = "tiles-v1";
const ASSETS = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css", "data/stations.json", "data/pois.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname === "tile.openstreetmap.org") {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === "opaque") c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  const networkFirst = url.pathname.includes("/data/") || e.request.mode === "navigate" || /\.(js|css)$/.test(url.pathname);
  e.respondWith(networkFirst
    ? fetch(e.request).then((res) => { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return res; })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    : caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
