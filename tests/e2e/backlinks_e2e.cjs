// The backlinks standard across modules, inside the real aetest Nexus (never production): a Place
// picked in Meridian and Chronos, an Interaction linking a Chronos event and a Mnemosyne note, and
// each target showing "Linked from other modules" with its owner's label and honest unresolved
// states. Synthetic data, removed or trashed at the end.
//
//   PLAYWRIGHT_PATH=G:/AureateEmpyrean/mnemosyne/node_modules/playwright node tests/e2e/backlinks_e2e.cjs
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const NEXUS = "http://localhost:12334";
const RUN = Date.now().toString(36);
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
async function until(fn, what, seconds = 90) {
  for (let i = 0; i < seconds * 2; i++) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(500);
  }
  check(false, `${what} (timed out)`);
}
async function open(page, module) {
  await page.goto(`${NEXUS}/app/modules/${module}`);
  await page.locator("#username, #module-application").first().waitFor({ timeout: 30000 });
  if (await page.locator("#username").isVisible()) {
    const owner = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../empyrean-nexus/.data/aetest-owner.json"), "utf8"));
    await page.locator("#username").fill(owner.username);
    await page.locator("#password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
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
const edges = (source) => {
  const code = `import sqlite3,json,sys
c=sqlite3.connect('file:/data/nexus.sqlite3?mode=ro',uri=True)
print(json.dumps(c.execute("select target,readers from resource_references where source=?",(sys.argv[1],)).fetchall()))`;
  return JSON.parse(execFileSync("docker", ["exec", "aetest-nexus-1", "python", "-c", code, source], { encoding: "utf8" }));
};

let removeThisRun = async () => {};
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  // A run that stops part-way must not leave its places behind.
  removeThisRun = async () => {
    const a = await open(page, "atlas");
    for (const p of (await call(a, "/places?q=" + encodeURIComponent(RUN))).items) {
      await call(a, `/places/${p.id}`, "DELETE");
      await call(a, `/trash/${p.id}`, "DELETE");
    }
  };
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // Setup: a Person, a Place, an event and a note that involve the Person.
  let m = await open(page, "meridian");
  // Remove what an interrupted earlier run left behind.
  for (const old of (await call(m, `/people?q=${encodeURIComponent("Spätná Väzba")}`)).items) {
    for (const x of (await call(m, `/interactions?entity=${old.id}`)).items) await call(m, `/interactions/${x.id}`, "DELETE");
    await call(m, `/people/${old.id}`, "DELETE");
  }
  const person = await call(m, "/people", "POST", { names: [{ kind: "full", value: `Spätná Väzba ${RUN}` }] });
  const personRef = `nexus:v1:meridian:person:${person.id}`;
  let a = await open(page, "atlas");
  for (const old of (await call(a, `/places?q=Bistro`)).items) {
    await call(a, `/places/${old.id}`, "DELETE");
    await call(a, `/trash/${old.id}`, "DELETE");
  }
  const place = await call(a, "/places", "POST", { name: `Bistro ${RUN}`, latitude: 48.14, longitude: 17.11 });
  let c = await open(page, "chronos");
  const cal = (await call(c, "/state")).calendars.find((x) => x.kind === "native");
  const event = await call(c, "/events", "POST", { calendar_id: cal.id, title: `Obed ${RUN}`, start: "2026-11-20T12:00", end: "2026-11-20T13:00", time_zone: "Europe/Bratislava" });
  await call(c, `/events/${event.id}/people`, "POST", { resource: personRef, label: `Spätná Väzba ${RUN}` });
  const eventRef = `nexus:v1:chronos:event:${event.id}`;

  // The event's place is picked in the Chronos interface, from Atlas's directory.
  const key = await c.evaluate(async (id) => { await refresh(); return state.occurrences.find((o) => o.event_id === id)?.key; }, event.id);
  await c.evaluate((k) => openDetails(k), key);
  const cf = page.frameLocator("#module-application");
  await cf.locator('[data-act="add-place"]').click();
  await cf.locator(".place-search input").fill(`Bistro ${RUN}`);
  await cf.locator('[data-act="pick-place"]').first().waitFor({ timeout: 15000 });
  await cf.locator('[data-act="pick-place"]').first().click();
  await until(async () => (await cf.locator("#place-rows").innerText()).includes(`Bistro ${RUN}`), "the place shows on the event");
  check(true, "a Place is picked in Chronos from Atlas's directory");

  const n = await open(page, "mnemosyne");
  const wid = await n.evaluate(() => state.wid);
  const note = await n.evaluate(([w, title]) => api(`/api/w/${w}/resources`, "POST", { kind: "note", title, status: "open" }), [wid, `Poznámky ${RUN}`]);
  await n.evaluate(([w, id, target]) => api(`/api/w/${w}/resources/${id}/links`, "POST", { target, readers: ["meridian"] }), [wid, note.id, personRef]);
  const noteRef = `nexus:v1:mnemosyne:note:${note.id}`;

  // The Interaction links a Place (search), and the event and note (candidates).
  m = await open(page, "meridian");
  await until(async () => (await call(m, `/interaction-link-candidates?entity=${person.id}`)).items.length >= 2, "the event and note become candidates");
  await m.evaluate((id) => go("person", id), person.id);
  await m.locator('.add-chip[data-section="interactions"]').click();
  await m.locator("#ix-summary").fill(`Obed spolu ${RUN}`);
  await m.locator("#ix-place-q").fill(`Bistro ${RUN}`);
  await m.locator('[data-act="ix-place-pick"]').first().waitFor({ timeout: 15000 });
  await m.locator('[data-act="ix-place-pick"]').first().click();
  for (const label of [`Obed ${RUN}`, `Poznámky ${RUN}`]) {
    await m.locator('[data-act="ix-link-load"]').click();
    const choice = m.locator(".ix-choice", { hasText: label });
    await choice.waitFor({ timeout: 20000 });
    await choice.click();
  }
  check((await m.locator(".ix-link").count()) === 3, "the Interaction links a Place, an event and a note");
  await m.locator('#panel [data-act="panel-save"]').click();
  await m.locator("#panel").waitFor({ state: "detached" });
  const iid = (await call(m, `/interactions?entity=${person.id}`)).items[0].id;
  const source = `nexus:v1:meridian:interaction:${iid}`;
  const registered = await until(async () => { const e = edges(source); return e.length === 3 ? e : null; }, "all three edges are registered");
  const readersOf = Object.fromEntries(registered.map(([t, r]) => [t, JSON.parse(r)]));
  check(readersOf[eventRef][0] === "chronos" && readersOf[noteRef][0] === "mnemosyne" && readersOf[place.resource][0] === "atlas", "each edge is shared only with its target's module");

  const LABEL = `Obed spolu ${RUN}`;
  // Atlas.
  a = await open(page, "atlas");
  const apane = page.frameLocator("#module-application");
  await a.evaluate((id) => openDetail(id), place.id);
  const alinked = apane.locator("#linked-from");
  await until(async () => (await alinked.innerText()).includes(LABEL) && (await alinked.innerText()).includes(`Obed ${RUN}`), "Atlas lists its backlinks");
  const atext = await alinked.innerText();
  check(atext.includes("Linked from other modules".toUpperCase()) || atext.includes("Linked from other modules"), "Atlas uses the standard section");
  check(atext.includes("Event in Chronos") && atext.includes("Interaction in Meridian"), "Atlas shows the event and the Interaction, labelled by their owners");
  await page.screenshot({ path: path.join(__dirname, "../../docs/screenshots/0.1.0/backlinks-1440.png") });

  // Chronos.
  c = await open(page, "chronos");
  const key2 = await c.evaluate(async (id) => { await refresh(); return state.occurrences.find((o) => o.event_id === id)?.key; }, event.id);
  await c.evaluate((k) => openDetails(k), key2);
  const clinked = page.frameLocator("#module-application").locator("#linked-from");
  await until(async () => (await clinked.innerText()).includes(LABEL), "Chronos lists its backlink");
  check((await clinked.innerText()).includes("Interaction in Meridian"), "Chronos shows the Interaction in the standard section");

  // Mnemosyne.
  const n2 = await open(page, "mnemosyne");
  await n2.evaluate((id) => openDetails(id), note.id);
  const nlinked = page.frameLocator("#module-application").locator("#linked-others");
  await until(async () => (await nlinked.innerText()).includes(LABEL), "Mnemosyne lists its backlink");
  check(!(await nlinked.innerText()).includes("nexus:v1:"), "Mnemosyne shows a label, never a raw reference");

  // Meridian still lists what links to the Person.
  m = await open(page, "meridian");
  const back = await call(m, `/entities/${person.id}/linked-from`);
  check(back.items.some((x) => x.source === eventRef) && back.items.some((x) => x.source === noteRef), "Meridian lists the event and note that link to the Person");

  // Deleting an event removes its own outgoing edges (the source owns them), so Atlas stops listing
  // it; a deleted target stays visible, unresolved, on the Interaction that links to it.
  const c2 = await open(page, "chronos");
  await call(c2, `/events/${event.id}`, "DELETE");
  const a2 = await open(page, "atlas");
  await until(async () => { const r = await call(a2, `/places/${place.id}/linked-from`); return r.availability === "available" && !r.items.some((i) => i.module === "chronos"); }, "the deleted event's own link is gone from Atlas");
  check((await call(a2, `/places/${place.id}/linked-from`)).items.some((i) => i.label === LABEL), "a deleted source's edge goes away, and the Interaction's remains");
  m = await open(page, "meridian");
  const full = await until(async () => { const x = await call(m, `/interactions/${iid}`); return x.links.find((l) => l.resource === eventRef)?.availability === "deleted" ? x : null; }, "Meridian reports the deleted event");
  check(full.links.find((l) => l.resource === eventRef).label === `Obed ${RUN}`, "a deleted target stays readable by its last label");
  check(full.links.find((l) => l.resource === place.resource).availability === "available", "the Interaction's other links keep working");

  // Clean up.
  await call(m, `/interactions/${iid}`, "DELETE");
  await until(async () => edges(source).length === 0, "the Nexus edges are removed");
  check(true, "deleting the Interaction removes its edges");
  await call(m, `/people/${person.id}`, "DELETE");
  const a3 = await open(page, "atlas");
  await call(a3, `/places/${place.id}`, "DELETE");
  await call(a3, `/trash/${place.id}`, "DELETE");
  const n3 = await open(page, "mnemosyne");
  await n3.evaluate(([w, id]) => api(`/api/w/${w}/resources/${id}`, "DELETE"), [wid, note.id]).catch(() => {});
  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
  await browser.close();
  console.log(`${passed} checks passed`);
})().catch(async (error) => {
  console.error(error);
  await removeThisRun().catch(() => {});
  process.exit(1);
});
