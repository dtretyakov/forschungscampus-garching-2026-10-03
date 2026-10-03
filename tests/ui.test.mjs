// Smoke test of the UI in a phone viewport: node tests/ui.test.mjs [base-url] [--fixture]
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const base = process.argv[2] || "http://127.0.0.1:8000/";
const useFixture = process.argv.includes("--fixture");
const shots = process.env.SHOTS || "tests/screenshots";
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  geolocation: { latitude: 48.2651, longitude: 11.6712 }, permissions: ["geolocation"], locale: "de-DE",
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/tile|ERR_|Failed to load resource/.test(m.text()) && errors.push(m.text()));
// Tiles are off by default; TILES=1 fetches them with curl (which honours the environment's proxy settings).
await page.route(/tile\.openstreetmap\.org/, async (r) => {
  if (!process.env.TILES) return r.abort();
  try {
    const { stdout } = await run("curl", ["-sf", "--max-time", "15", "-A", "garching-map-test", r.request().url()], { encoding: "buffer", maxBuffer: 1 << 22 });
    await r.fulfill({ contentType: "image/png", body: stdout });
  } catch { await r.abort(); }
});
if (useFixture) {
  await page.route(/data\/stations\.json/, (r) => r.fulfill({ contentType: "application/json", body: readFileSync("tests/fixture_stations.json") }));
  await page.route(/data\/pois\.json/, (r) => r.fulfill({ contentType: "application/json", body: readFileSync("tests/fixture_pois.json") }));
}

await page.goto(base);
await page.waitForSelector(".list .item");
const data = await page.evaluate(() => fetch("data/stations.json").then((r) => r.json()));
const total = data.stations.length;
assert.equal(await page.locator(".list .item").count(), total, "all stations listed");
await page.screenshot({ path: `${shots}/1-start.png` });

// Filter by the first category (Kinder, if present).
const cat = data.categories.find((c) => /kind/i.test(c.label)) || data.categories[0];
await page.click(`.chip[data-cat="${cat.id}"]`);
await page.waitForTimeout(600);
const expected = data.stations.filter((s) => (s.categories || []).includes(cat.id));
assert.equal(await page.locator(".list .item").count(), expected.length, "filtered list");
assert.match(await page.evaluate(() => location.hash), new RegExp(`cat=${cat.id}`));
// Markers: each visible station is on the map (grouped pins count their stations).
// Stations represented on the map: cluster/multi pins carry a count badge, a cluster without one shows the count itself.
const stationCount = () => page.$$eval(".leaflet-marker-pane .pin, .leaflet-marker-pane .cluster", (ms) => ms.map((m) => {
  const c = m.querySelector(".cnt");
  if (c) return +c.textContent;
  return m.classList.contains("cluster") ? +m.querySelector("b").textContent : 1;
}).reduce((a, b) => a + b, 0));
const pinned = await stationCount();
assert.equal(pinned, expected.filter((s) => s.lat != null).length, "markers match filter");
await page.screenshot({ path: `${shots}/2-filter-${cat.id}.png` });

// Station markers never overlap: centres at least 30 px apart.
const centres = await page.$$eval(".leaflet-marker-pane .pin, .leaflet-marker-pane .cluster", (ms) => ms.map((m) => {
  const r = m.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
}));
for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) {
  assert.ok(Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1]) >= 30, "markers overlap");
}
// Tapping a cluster zooms in and splits it.
if (await page.locator(".cluster").count()) {
  const before = await page.locator(".leaflet-marker-pane .pin, .leaflet-marker-pane .cluster").count();
  await page.locator(".cluster").first().click();
  await page.waitForTimeout(1200);
  assert.ok(await page.locator(".leaflet-marker-pane .pin, .leaflet-marker-pane .cluster").count() > before, "cluster splits on tap");
  assert.equal(await stationCount(), expected.filter((s) => s.lat != null).length, "markers still match filter after zoom");
}

// Open details.
await page.locator(".list .item").first().click();
await page.waitForSelector("#detail:not([hidden]) h2");
assert.equal(await page.locator("#detail script").count(), 0, "description is escaped");
await page.click("#grip"); // expand sheet
await page.waitForTimeout(400);
await page.screenshot({ path: `${shots}/3-detail.png` });
await page.click('[data-act="back"]');

// Geolocation: blue dot + distances, list sorted by distance.
await page.click("#locate");
await page.waitForSelector(".me");
await page.waitForSelector(".item .dist");
const d = await page.$$eval(".item .dist", (xs) => xs.map((x) => x.textContent));
const meters = d.map((t) => parseFloat(t.replace(/[^\d,]/g, "").replace(",", ".")) * (/km/.test(t) ? 1000 : 1));
assert.deepEqual(meters, [...meters].sort((a, b) => a - b), "sorted by distance");
await page.screenshot({ path: `${shots}/4-located.png` });

// A GPS update must not reset the scroll position of an open card.
await page.locator(".list .item").first().click();
await page.waitForSelector("#detail:not([hidden]) h2");
await page.evaluate(() => { document.querySelector("#sheet").dataset.state = "full"; document.querySelector("#detail").scrollTop = 150; });
const before = await page.evaluate(() => document.querySelector("#detail").scrollTop);
await ctx.setGeolocation({ latitude: 48.2662, longitude: 11.6702 });
await page.waitForTimeout(1200);
assert.equal(await page.evaluate(() => document.querySelector("#detail").scrollTop), before, "scroll kept after GPS update");
// Compass: an absolute orientation event turns the direction beam (alpha 270 → heading 90°).
await page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent("deviceorientationabsolute", { alpha: 270, absolute: true })));
await page.waitForSelector(".me-cone.on");
assert.match(await page.$eval(".me-cone", (e) => e.style.transform), /rotate\(90deg\)/, "heading beam");
await page.screenshot({ path: `${shots}/4b-heading.png` });
await page.click('[data-act="back"]');
await page.evaluate(() => { document.querySelector("#sheet").dataset.state = "peek"; });

// Deep link restores the filter.
await page.goto(base + `#cat=${cat.id}`);
await page.waitForSelector(".list .item");
assert.equal(await page.locator(".list .item").count(), expected.length, "deep link");
assert.equal(await page.getAttribute(`.chip[data-cat="${cat.id}"]`, "aria-pressed"), "true");

// Desktop layout.
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/5-desktop.png` });

// Several stations at one point (e.g. 17.3): tapping the pin lists them in the sheet.
{
  const counts = {};
  data.stations.forEach((s) => s.lat != null && (counts[s.lat + "," + s.lng] = (counts[s.lat + "," + s.lng] || []).concat(s)));
  const grp = Object.values(counts).find((a) => a.length > 1);
  if (grp) {
    await page.goto(base + `#s=${grp[0].id}`);
    await page.waitForSelector("#detail:not([hidden]) h2");
    await page.waitForTimeout(800);
    await page.click('[data-act="back"]');
    const ref = grp[0].plan_ref || grp[0].number;
    const pin = page.locator(".pin.multi", { has: page.locator("b", { hasText: new RegExp(`^${ref.replace(".", "\\.")}$`) }) });
    await pin.first().dispatchEvent("click");
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".list .item:not(.talk):not(.food)").count(), grp.length, "group listed in sheet");
    assert.match(await page.textContent("#count"), new RegExp(String(grp.length)));
    await page.screenshot({ path: `${shots}/11-group-list.png` });
    await page.locator(".list .item").first().click();
    await page.waitForSelector("#detail:not([hidden]) h2");
    await page.click('[data-act="back"]');
    await page.click("#reset");
    assert.equal(await page.locator(".list .item").count(), data.stations.length, "back to all stations");
  }
}

// Search: typo tolerance, talk results, food results.
{
  await page.goto(base);
  await page.waitForSelector(".list .item");
  const long = data.stations.map((s) => [s, (s.title.match(/[A-Za-zÄÖÜäöüß]{8,}/g) || [])[0]]).find(([, w]) => w);
  if (long) {
    const [st, w] = long;
    const typo = w.slice(0, 3) + (w[3] === "x" ? "y" : "x") + w.slice(4);
    await page.fill("#search", typo);
    await page.waitForTimeout(300);
    assert.ok(await page.locator(`.item[data-id="${st.id}"]:not(.talk)`).count(), `typo "${typo}" finds ${st.id}`);
  }
  const withTalk = data.stations.find((s) => (s.talks || []).length);
  if (withTalk) {
    const word = (withTalk.talks[0].title.match(/[A-Za-zÄÖÜäöüß]{6,}/) || [withTalk.talks[0].title])[0];
    await page.fill("#search", word);
    await page.waitForTimeout(300);
    assert.ok(await page.locator(".item.talk").count() > 0, "talk results");
  }
  // Searching an acronym from a station name ("ESO") puts that station first.
  const acr = data.stations.map((s) => [s, (s.title.match(/\(([A-Z]{3,5})\)/) || [])[1]]).find(([, a]) => a);
  if (acr) {
    await page.fill("#search", acr[1]);
    await page.waitForTimeout(300);
    assert.equal(await page.getAttribute(".list .item:not(.talk):not(.food) >> nth=0", "data-id"), acr[0].id, `"${acr[1]}" ranks ${acr[0].id} first`);
  }
  const pois = await page.evaluate(() => fetch("data/pois.json").then((r) => r.json()));
  if (pois.some((p) => p.type === "food" && /pizza/i.test(p.name))) {
    await page.fill("#search", "пицца");
    await page.waitForTimeout(300);
    assert.ok(await page.locator(".item.food").count() > 0, "food results (ru query)");
    await page.screenshot({ path: `${shots}/10-search-food.png` });
    await page.locator(".item.food").first().click();
    await page.waitForSelector(".leaflet-popup .food-list");
  }
  await page.fill("#search", "");
}

// Location denied (iOS Safari answers like this when location is off for Safari websites):
// the help dialog explains the settings and the position can be set by tapping the map.
{
  const ctx2 = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "de-DE",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const p2 = await ctx2.newPage();
  p2.on("pageerror", (e) => errors.push(e.message));
  await p2.route(/tile\.openstreetmap\.org/, (r) => r.abort());
  if (useFixture) {
    await p2.route(/data\/stations\.json/, (r) => r.fulfill({ contentType: "application/json", body: readFileSync("tests/fixture_stations.json") }));
    await p2.route(/data\/pois\.json/, (r) => r.fulfill({ contentType: "application/json", body: readFileSync("tests/fixture_pois.json") }));
  }
  await p2.addInitScript(() => {
    navigator.geolocation.watchPosition = (ok, err) => { setTimeout(() => err({ code: 1, message: "denied" }), 50); return 1; };
  });
  await p2.goto(base);
  await p2.waitForSelector(".list .item");
  await p2.click("#locate");
  await p2.waitForSelector(".lochelp");
  assert.match(await p2.textContent(".lochelp"), /Safari-Websites/, "iOS help shown");
  await p2.screenshot({ path: `${shots}/6-location-help.png` });
  await p2.click('.lochelp [data-act="manual"]');
  const box = await p2.locator("#map").boundingBox();
  await p2.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
  await p2.waitForSelector(".me");
  await p2.waitForSelector(".item .dist");
  await p2.screenshot({ path: `${shots}/7-manual-position.png` });
  await ctx2.close();
}

// English: a browser set to English gets the English UI; the button switches to German and back.
{
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  const p3 = await ctx3.newPage();
  p3.on("pageerror", (e) => errors.push(e.message));
  await p3.route(/tile\.openstreetmap\.org/, (r) => r.abort());
  if (useFixture) {
    await p3.route(/data\/stations\.json/, (r) => r.fulfill({ contentType: "application/json", body: readFileSync("tests/fixture_stations.json") }));
    await p3.route(/data\/pois\.json/, (r) => r.fulfill({ contentType: "application/json", body: readFileSync("tests/fixture_pois.json") }));
  }
  await p3.goto(base);
  await p3.waitForSelector(".list .item");
  assert.equal(await p3.getAttribute("html", "lang"), "en");
  assert.match(await p3.textContent("#title"), /Open Day/);
  assert.match(await p3.textContent("#count"), /stations/);
  const kid = data.categories.find((c) => /kind/i.test(c.label));
  if (kid && kid.label_en) assert.match(await p3.textContent(`.chip[data-cat="${kid.id}"]`), new RegExp(kid.label_en));
  await p3.click(`.chip[data-cat="${cat.id}"]`);
  assert.match(await p3.evaluate(() => location.hash), /lang=en/);
  await p3.locator(".list .item").first().click();
  await p3.waitForSelector("#detail:not([hidden]) h2");
  assert.match(await p3.textContent("#detail .back"), /Back to list/);
  await p3.screenshot({ path: `${shots}/8-english-detail.png` });
  await p3.selectOption("#lang", "de");
  assert.equal(await p3.getAttribute("html", "lang"), "de");
  assert.match(await p3.textContent("#detail .back"), /Zurück/);
  await ctx3.close();
}

// Russian: a browser set to Russian gets the Russian UI and Russian station texts (English fallback).
{
  const ctx4 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ru-RU" });
  const p4 = await ctx4.newPage();
  p4.on("pageerror", (e) => errors.push(e.message));
  await p4.route(/tile\.openstreetmap\.org/, (r) => r.abort());
  if (useFixture) {
    await p4.route(/data\/stations\.json/, (r) => r.fulfill({ contentType: "application/json", body: readFileSync("tests/fixture_stations.json") }));
    await p4.route(/data\/pois\.json/, (r) => r.fulfill({ contentType: "application/json", body: readFileSync("tests/fixture_pois.json") }));
  }
  await p4.goto(base);
  await p4.waitForSelector(".list .item");
  assert.equal(await p4.getAttribute("html", "lang"), "ru");
  assert.equal(await p4.inputValue("#lang"), "ru");
  assert.match(await p4.textContent("#title"), /День открытых дверей/);
  assert.match(await p4.textContent("#count"), /станц/);
  const kid = data.categories.find((c) => /kind/i.test(c.label));
  if (kid && kid.label_ru) assert.match(await p4.textContent(`.chip[data-cat="${kid.id}"]`), new RegExp(kid.label_ru));
  await p4.click(`.chip[data-cat="${cat.id}"]`);
  assert.match(await p4.evaluate(() => location.hash), /lang=ru/);
  const first = expected[0];
  const want = first.teaser_ru || first.teaser_en || first.teaser;
  await p4.locator(".list .item").first().click();
  await p4.waitForSelector("#detail:not([hidden]) h2");
  assert.match(await p4.textContent("#detail .back"), /Назад/);
  if (want) assert.equal((await p4.textContent("#detail .lead")).trim(), want);
  await p4.screenshot({ path: `${shots}/9-russian-detail.png` });
  // Talk titles are shown translated.
  const ts = data.stations.find((st) => (st.talks || []).some((t) => t.title_ru));
  if (ts) {
    await p4.goto(base + `#lang=ru&s=${ts.id}`);
    await p4.waitForSelector("#detail .talks");
    const want2 = ts.talks.find((t) => t.title_ru).title_ru;
    assert.ok((await p4.textContent("#detail .talks")).includes(want2), "talk title in Russian");
  }
  assert.ok(useFixture || data.stations.some((st) => (st.talks || []).some((t) => t.title_ru)), "talk translations present in data");
  await ctx4.close();
}

assert.deepEqual(errors, [], "no page errors");
await browser.close();
console.log(`OK: ${total} stations, ${expected.length} in "${cat.label}"`);
