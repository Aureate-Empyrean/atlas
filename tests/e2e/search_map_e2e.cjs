// D9 and D16 inside the real aetest Nexus (never production): OpenStreetMap tiles and explicit search
// in Atlas; Meridian linking a Chronos event and a Mnemosyne note found by search, with no prior
// tie to a participant; and backlinks that open the exact item. Synthetic data, removed at the end.
//
//   PLAYWRIGHT_PATH=G:/AureateEmpyrean/mnemosyne/node_modules/playwright node tests/e2e/search_map_e2e.cjs
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const NEXUS = "http://localhost:12334";
const RUN = Date.now().toString(36);
const SHOTS = path.join(__dirname, "../../docs/screenshots/0.2.0");
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
async function until(fn, what, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(500);
  }
  check(false, `${what} (timed out)`);
}
async function open(page, module, query = "") {
  await page.goto(`${NEXUS}/app/modules/${module}${query}`);
  await page.locator("#username, #module-application").first().waitFor({ timeout: 30000 });
  if (await page.locator("#username").isVisible()) {
    const owner = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../empyrean-nexus/.data/aetest-owner.json"), "utf8"));
    await page.locator("#username").fill(owner.username);
    await page.locator("#password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  return frameOf(page, module);
}
async function frameOf(page, module) {
  let frame;
  for (let i = 0; i < 80 && !frame; i++) {
    frame = page.frames().find((fr) => fr !== page.mainFrame() && fr.url().includes(`/modules/${module}`));
    if (!frame) await sleep(250);
  }
  await frame.waitForFunction(() => typeof api === "function", null, { timeout: 30000 });
  await sleep(600);
  return frame;
}
const call = (frame, p, method = "GET", body) => frame.evaluate(([x, m, b]) => (b === null ? api(x, m) : api(x, m, b)), [p, method, body === undefined ? null : body]);
const edges = (source) => JSON.parse(execFileSync("docker", ["exec", "aetest-nexus-1", "python", "-c", `import sqlite3,json,sys
c=sqlite3.connect('file:/data/nexus.sqlite3?mode=ro',uri=True)
print(json.dumps(c.execute("select target,readers from resource_references where source=?",(sys.argv[1],)).fetchall()))`, source], { encoding: "utf8" }));

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const pane = page.frameLocator("#module-application");

  // Atlas: nothing goes out until the owner agrees; then a real map.
  let a = await open(page, "atlas");
  await pane.locator("#map-stage").waitFor();
  const start = await call(a, "/map-settings");
  if (start.online) await call(a, "/map-settings", "PUT", { online: false, tile_url: start.tile_url, geocoder_url: start.geocoder_url });
  await a.evaluate(async () => { await refresh(); render(); });
  await pane.locator('[data-act="map-online"]').waitFor();
  check(true, "the map asks before using the network");
  await pane.locator('[data-act="map-online"]').click();
  await until(() => a.evaluate(() => tiles.images.size > 0), "tiles arrive from OpenStreetMap");
  // A decoded tile is painted on the next draw, so wait for the pixels themselves.
  await until(() => a.evaluate(() => {
    const c = document.querySelector("#map-tiles");
    const d = c.getContext("2d").getImageData(c.width / 2 - 40, c.height / 2 - 40, 80, 80).data;
    return d.some((v, i) => i % 4 === 3 && v > 0);
  }), "the map shows real map imagery", 20);
  check(true, "the map shows real map imagery");
  check((await pane.locator(".map-attribution").innerText()).includes("OpenStreetMap"), "the required attribution is shown");
  await sleep(1500);
  await page.screenshot({ path: path.join(SHOTS, "atlas-map-1440.png") });

  // Local first, online only when asked; a result is saved as the owner's own copy.
  await pane.locator("#map-q").fill("Bratislava");
  await pane.locator('[data-act="search-online"]').waitFor();
  await pane.locator('[data-act="search-online"]').click();
  const firstResult = pane.locator('[data-result="online"]').first();
  await firstResult.waitFor({ timeout: 20000 });
  await firstResult.click();
  await pane.locator("#pl-name").waitFor();
  await pane.locator("#pl-name").fill(`Bistro ${RUN}`);
  await pane.locator('[data-act="save-place"]').click();
  await pane.locator("#detail:not([hidden])").waitFor();
  const place = (await call(a, `/places?q=${encodeURIComponent(RUN)}`)).items[0];
  check(place && /^osm:/.test(place.external_ref || "") && place.latitude > 47, `an online result is saved as the owner's copy (${place?.external_ref})`);

  // A Chronos event and a Mnemosyne note with no tie to the person.
  const c = await open(page, "chronos");
  const cal = (await call(c, "/state")).calendars.find((x) => x.kind === "native");
  const event = await call(c, "/events", "POST", { calendar_id: cal.id, title: `Stretnutie ${RUN}`, start: "2026-11-24T12:00", end: "2026-11-24T13:00", time_zone: "Europe/Bratislava" });
  const n = await open(page, "mnemosyne");
  const wid = await n.evaluate(() => state.wid);
  const note = await n.evaluate(([w, title]) => api(`/api/w/${w}/resources`, "POST", { kind: "note", title, status: "open" }), [wid, `Zápisnica ${RUN}`]);

  let m = await open(page, "meridian");
  const person = await call(m, "/people", "POST", { names: [{ kind: "full", value: `Hľadaná Osoba ${RUN}` }] });
  check((await call(m, `/interaction-link-candidates?entity=${person.id}`)).items.length === 0, "the person has no prior link to anything");
  await m.evaluate((id) => go("person", id), person.id);
  await pane.locator('.add-chip[data-section="interactions"]').click();
  await pane.locator("#ix-summary").fill(`Porada ${RUN}`);
  for (const label of [`Stretnutie ${RUN}`, `Zápisnica ${RUN}`, `Bistro ${RUN}`]) {
    await pane.locator("#ix-place-q").fill(label);
    const choice = pane.locator('[data-act="ix-place-pick"]', { hasText: label });
    await choice.first().waitFor({ timeout: 20000 });
    await choice.first().click();
  }
  check((await pane.locator(".ix-link").count()) === 3, "search finds an event, a note and a place with no prior link");
  await pane.locator('#panel [data-act="panel-save"]').click();
  await pane.locator("#panel").waitFor({ state: "detached" });
  const iid = (await call(m, `/interactions?entity=${person.id}`)).items[0].id;
  const source = `nexus:v1:meridian:interaction:${iid}`;
  await until(async () => edges(source).length === 3, "the edges are registered");
  const full = await until(async () => { const x = await call(m, `/interactions/${iid}`); return x.links.every((l) => l.availability === "available") ? x : null; }, "the links resolve");
  check(full.links.some((l) => l.label.includes(`Stretnutie ${RUN}`)), "the owners label what was found by search");

  // Backlinks open the exact item.
  const c2 = await open(page, "chronos");
  const key = await c2.evaluate(async (id) => { await refresh(); return state.occurrences.find((o) => o.event_id === id)?.key; }, event.id);
  await c2.evaluate((k) => openDetails(k), key);
  const open1 = pane.locator('#linked-from [data-act="open-module"]').first();
  await open1.waitFor({ timeout: 20000 });
  await open1.click();
  await page.waitForURL(/\/app\/modules\/meridian\?path=/, { timeout: 15000 });
  // Meridian 0.11.0: the link names the Interaction itself, shown on its participant's profile.
  check(page.url().includes(encodeURIComponent(`/interactions/${iid}`)), "a backlink opens the exact Meridian Interaction");
  await pane.locator(".person-name", { hasText: `Hľadaná Osoba ${RUN}` }).waitFor({ timeout: 20000 });
  check(true, "Meridian shows that person after the jump");

  const direct = await open(page, "chronos", `?path=${encodeURIComponent(`/events/${event.id}`)}`);
  await pane.locator("#details-title", { hasText: `Stretnutie ${RUN}` }).waitFor({ timeout: 20000 });
  check(true, "a link opens one Chronos event directly");
  void direct;
  await open(page, "atlas", `?path=${encodeURIComponent(`/places/${place.id}`)}`);
  await pane.locator("#detail .detail-title", { hasText: `Bistro ${RUN}` }).waitFor({ timeout: 20000 });
  check(true, "a link opens one Atlas place directly");

  // Clean up.
  m = await open(page, "meridian");
  await call(m, `/interactions/${iid}`, "DELETE");
  await until(async () => edges(source).length === 0, "the edges are removed");
  await call(m, `/people/${person.id}`, "DELETE");
  const c3 = await open(page, "chronos");
  await call(c3, `/events/${event.id}`, "DELETE");
  a = await open(page, "atlas");
  await call(a, `/places/${place.id}`, "DELETE");
  await call(a, `/trash/${place.id}`, "DELETE");
  const n2 = await open(page, "mnemosyne");
  await n2.evaluate(async ([w, id]) => {
    await mutate(id, { trashed: true }); // permanent deletion is only for items already in Trash
    await api(`/api/w/${w}/resources/${id}?confirmed=true`, "DELETE");
  }, [wid, note.id]);
  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
  await browser.close();
  console.log(`${passed} checks passed`);
})().catch((error) => {
  console.error(String(error).slice(0, 1500));
  process.exit(1);
});
