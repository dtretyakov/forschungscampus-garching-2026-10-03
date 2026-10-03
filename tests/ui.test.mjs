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

assert.deepEqual(errors, [], "no page errors");
await browser.close();
console.log(`OK: ${total} stations, ${expected.length} in "${cat.label}"`);
