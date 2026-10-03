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
const pinned = await page.$$eval(".pin", (ps) => ps.map((p) => +(p.dataset.n || 1)).reduce((a, b) => a + b, 0));
assert.equal(pinned, expected.filter((s) => s.lat != null).length, "markers match filter");
await page.screenshot({ path: `${shots}/2-filter-${cat.id}.png` });

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

// Deep link restores the filter.
await page.goto(base + `#cat=${cat.id}`);
await page.waitForSelector(".list .item");
assert.equal(await page.locator(".list .item").count(), expected.length, "deep link");
assert.equal(await page.getAttribute(`.chip[data-cat="${cat.id}"]`, "aria-pressed"), "true");

// Desktop layout.
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/5-desktop.png` });

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
  await ctx4.close();
}

assert.deepEqual(errors, [], "no page errors");
await browser.close();
console.log(`OK: ${total} stations, ${expected.length} in "${cat.label}"`);
