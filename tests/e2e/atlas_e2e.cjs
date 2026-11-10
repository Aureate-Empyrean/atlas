// Atlas inside the real aetest Nexus (never production): the application switcher icon, the map
// and its controls, choosing a location on the map, the Library, conflicts and Trash. Synthetic
// data, removed at the end. PHONE=1 runs at 390 px.
//
//   PLAYWRIGHT_PATH=G:/AureateEmpyrean/mnemosyne/node_modules/playwright node tests/e2e/atlas_e2e.cjs
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const NEXUS = process.env.NEXUS_URL || "http://localhost:12334";
const PHONE = !!process.env.PHONE;
const LABEL = PHONE ? "390" : "1440";
const SHOTS = path.join(__dirname, "../../docs/screenshots/0.1.0");
const RUN = Date.now().toString(36);
const ICON_SHA = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "../../frontend/icon.svg"))).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (ok, what) => {
  if (!ok) {
    console.error(`FAIL ${what}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok   ${what}`);
};

let removeThisRun = async () => {};
(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ reducedMotion: "reduce", viewport: PHONE ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${NEXUS}/app`);
  await page.locator("#username, #product-switch").first().waitFor({ timeout: 30000 });
  if (await page.locator("#username").isVisible()) {
    const owner = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../empyrean-nexus/.data/aetest-owner.json"), "utf8"));
    await page.locator("#username").fill(owner.username);
    await page.locator("#password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.locator("#product-switch").waitFor({ timeout: 30000 });

  await page.locator("#product-switch").click();
  const item = page.locator("#launcher-items .launcher-item", { hasText: "Atlas" });
  await item.waitFor({ timeout: 10000 });
  const img = item.locator(".monogram.has-icon img");
  await img.waitFor({ timeout: 10000 });
  await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle(), { timeout: 10000 });
  const served = await page.evaluate(async (u) => {
    const b = new Uint8Array(await (await fetch(u, { cache: "no-store" })).arrayBuffer());
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
  }, await img.getAttribute("src"));
  check(served === ICON_SHA, "the Nexus switcher shows Atlas's Sapphire icon");
  await page.locator("#product-menu").screenshot({ path: path.join(SHOTS, `switcher-${LABEL}.png`) });
  await item.click();

  let f;
  for (let i = 0; i < 80 && !f; i++) {
    f = page.frames().find((fr) => fr !== page.mainFrame() && fr.url().includes("/modules/atlas"));
    if (!f) await sleep(250);
  }
  await f.waitForSelector("#map-stage", { timeout: 30000 });
  // A run that stops part-way must not leave its places behind.
  removeThisRun = async () => {
    for (const x of (await api(`/places?q=${encodeURIComponent(RUN)}`)).items) {
      await api(`/places/${x.id}`, "DELETE");
      await api(`/trash/${x.id}`, "DELETE");
    }
  };
  const api = (p, m = "GET", b) => f.evaluate(([x, y, z]) => (z === null ? api(x, y) : api(x, y, z)), [p, m, b === undefined ? null : b]);
  const brand = await f.evaluate(() => ({ ok: document.querySelector(".brand-mark img")?.naturalWidth > 0, accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() }));
  check(brand.ok && brand.accent.toLowerCase() === "#4285d4", `the header shows the icon, accent ${brand.accent}`);
  const overflow = async (what) => {
    const n = await f.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(n <= 0, `${what} fits the width (${n})`);
  };
  await overflow("the map");

  // Add a place by choosing its location on the map.
  await f.locator('[data-act="new-place"]').click();
  await f.locator("#pl-name").fill(`Výhľad ${RUN}`);
  await f.locator("#pl-tags").fill("prvé, výhľad");
  await f.locator('[data-act="pick-on-map"]').click();
  await f.locator(".map-picking").waitFor();
  const box = await f.locator("#map-stage").boundingBox();
  await page.mouse.click(box.x + box.width / 2 + 40, box.y + box.height / 2 - 30);
  await f.locator("#pl-location").waitFor();
  const picked = await f.locator("#pl-location").inputValue();
  check(/^-?\d+(\.\d+)?, -?\d+(\.\d+)?$/.test(picked) && (await f.locator("#pl-name").inputValue()) === `Výhľad ${RUN}`, `choosing on the map keeps the draft (${picked})`);
  await f.locator('[data-act="save-place"]').click();
  await f.locator("#detail:not([hidden])").waitFor();
  let places = (await api(`/places?q=${encodeURIComponent(RUN)}`)).items;
  check(places.length === 1 && places[0].latitude !== null && places[0].tags.length === 2, "the place is saved with its location and tags");
  const a = places[0];

  // Typed coordinates, favorite and historical states, and a place with no location.
  const castle = await api("/places", "POST", { name: `Hrad ${RUN}`, latitude: 48.1425, longitude: 17.1, favorite: true });
  const old = await api("/places", "POST", { name: `Stará kancelária ${RUN}`, latitude: 48.15, longitude: 17.11, inactive: true });
  const none = await api("/places", "POST", { name: `Bez miesta ${RUN}`, want_to_visit: true });
  await f.evaluate(async () => { await refresh(); map.ready = false; closeDetail(); render(); });
  await f.locator("[data-pin]").first().waitFor();
  const pins = await f.locator("[data-pin]").count();
  check(pins >= 3, `pins are drawn (${pins})`);
  await f.locator(`[data-state="inactive"]`).uncheck();
  await sleep(100);
  check((await f.locator(`[data-pin="${old.id}"]`).count()) === 0, "a layer can be hidden");
  await f.locator(`[data-state="inactive"]`).check();
  await sleep(100);
  const zoomBefore = await f.evaluate(() => map.z);
  await f.locator('[data-act="zoom-in"]').click();
  check((await f.evaluate(() => map.z)) > zoomBefore, "the zoom control works");
  await overflow("the map with places");
  await page.screenshot({ path: path.join(SHOTS, `map-${LABEL}.png`) });
  await f.evaluate((id) => openDetail(id), castle.id);
  await f.locator("#detail:not([hidden]) .detail-title").waitFor();
  await page.screenshot({ path: path.join(SHOTS, `detail-${LABEL}.png`) });
  check((await f.locator("#detail").innerText()).includes("48.14250"), "the details show the location");

  // Library.
  await f.locator('[data-act="close-detail"]').click();
  await f.locator('[data-go="library"]').click();
  await f.locator(".place-card").first().waitFor();
  await f.locator("#lib-q").fill(`bez miesta ${RUN}`);
  await f.waitForFunction((n) => document.querySelectorAll(".place-card").length === 1 && document.querySelector(".place-card").textContent.includes(n), `Bez miesta ${RUN}`);
  check((await f.locator(".place-card").first().innerText()).includes("No location yet"), "the Library finds a place without a location");
  await f.locator("#lib-q").fill(RUN);
  await f.locator('[data-filter="favorites"]').click();
  await f.waitForFunction((n) => document.querySelectorAll(".place-card").length === 1 && document.querySelector(".place-card").textContent.includes(n), `Hrad ${RUN}`);
  check(true, "the Library filters by state");
  await overflow("the Library");
  await page.screenshot({ path: path.join(SHOTS, `library-${LABEL}.png`) });

  // A concurrent edit is reported rather than overwritten.
  await f.locator(".place-card").first().click();
  await f.locator('[data-act="edit-place"]').click();
  await f.locator("#pl-name").waitFor();
  const current = await api(`/places/${castle.id}`);
  await api(`/places/${castle.id}`, "PUT", { name: `Zmenený ${RUN}`, latitude: 48.1425, longitude: 17.1, favorite: true });
  await f.locator("#pl-name").fill(`Prepísaný ${RUN}`);
  await f.locator('[data-act="save-place"]').click();
  await f.locator("#pl-error:not([hidden])").waitFor();
  check((await f.locator("#pl-error").innerText()).includes("another session") && current.revision, "a concurrent edit is reported");
  await f.locator('[data-act="close-editor"]').click();
  await f.evaluate(() => closeDetail());

  // Trash, restore, and clean up.
  for (const p of [a, castle, old, none]) await api(`/places/${p.id}`, "DELETE");
  await f.locator('[data-go="trash"]').click();
  await f.locator("[data-restore]").first().waitFor();
  await api(`/places/${a.id}/restore`, "POST");
  check((await api(`/places?q=${encodeURIComponent(RUN)}`)).items.length === 1, "a trashed place can be restored");
  await api(`/places/${a.id}`, "DELETE");
  for (const p of [a, castle, old, none]) await api(`/trash/${p.id}`, "DELETE");
  check((await api(`/places?q=${encodeURIComponent(RUN)}`)).items.length === 0, "this run's places are removed");
  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
  await browser.close();
  console.log(`${passed} checks passed`);
})().catch(async (error) => {
  console.error(error);
  await removeThisRun().catch(() => {});
  process.exit(1);
});
