// Custom map pins, categories and Meridian addresses inside the real aetest Nexus (never production),
// at desktop and phone width. It inspects the markers actually drawn on the map, and saves the
// screenshots used in the report. Synthetic data, removed at the end.
//
//   PLAYWRIGHT_PATH=G:/AureateEmpyrean/mnemosyne/node_modules/playwright node tests/e2e/markers_e2e.cjs
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const NEXUS = "http://localhost:12334";
const RUN = Date.now().toString(36);
const SHOTS = path.join(__dirname, "../../docs/screenshots/0.3.0");
const BRONZE = "#c48663";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (ok, what) => {
  if (!ok) throw new Error(`FAIL ${what}`);
  passed++;
  console.log(`ok   ${what}`);
};
async function until(fn, what, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    const value = await Promise.resolve().then(fn).catch(() => null);
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`FAIL ${what} (timed out)`);
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
async function open(page, module) {
  await page.goto(`${NEXUS}/app/modules/${module}`);
  await page.locator("#username, #module-application").first().waitFor({ timeout: 30000 });
  if (await page.locator("#username").isVisible()) {
    const owner = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../empyrean-nexus/.data/aetest-owner.json"), "utf8"));
    await page.locator("#username").fill(owner.username);
    await page.locator("#password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  return frameOf(page, module);
}
const call = (frame, p, method = "GET", body) => frame.evaluate(([x, m, b]) => (b === null ? api(x, m) : api(x, m, b)), [p, method, body === undefined ? null : body]);
const sql = (statement, ...args) => execFileSync("docker", ["exec", "aetest-module-atlas", "python", "-c", "import sqlite3,sys\nc=sqlite3.connect('/data/atlas.sqlite3')\nc.execute(sys.argv[1],sys.argv[2:])\nc.commit()", statement, ...args]);
const reload = (f) => f.evaluate(async () => { await refresh(); pinsDirty = true; render(); await loadContacts(); });
const focus = (f, lat, lng, z) => f.evaluate(([la, ln, zo]) => { map.ready = true; map.cx = lngX(ln); map.cy = latY(la); map.z = zo; clampView(); pinsDirty = true; draw(); }, [lat, lng, z]);
/* What is really on the map: the drawn pin, not the data behind it. */
const drawn = (f, selector) => f.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const svg = el.querySelector(".pin-svg");
  const body = svg.querySelectorAll("path")[1];
  const glyph = svg.querySelector("g");
  const box = svg.getBoundingClientRect();
  const [x, y] = toScreen(lngX(+el.dataset.lng), latY(+el.dataset.lat));
  const stage = document.querySelector("#map-stage").getBoundingClientRect();
  return { color: el.dataset.color, icon: el.dataset.icon, fill: body.getAttribute("fill"), stroke: glyph.getAttribute("stroke"), shapes: glyph.children.length, halo: svg.querySelector("path").getAttribute("stroke"), tipDx: Math.abs(box.left + box.width / 2 - stage.left - x), tipDy: Math.abs(box.bottom - stage.top - y), width: box.width, count: el.querySelector(".pin-count")?.textContent || "" };
}, selector);

const P = { food: `Bistro ${RUN}`, coffee: `Kaviareň ${RUN}`, nature: `Záhrada ${RUN}`, landmark: `Hrad ${RUN}`, hotel: `Hotel ${RUN}`, fun: `Divadlo ${RUN}`, home: `Domov ${RUN}`, travel: `Stanica ${RUN}`, plain: `Bez kategórie ${RUN}` };

async function seed(a, m, state) {
  const id = Object.fromEntries((await call(a, "/categories")).items.map((c) => [c.name, c.id]));
  const add = (name, latitude, longitude, extra) => call(a, "/places", "POST", { name, latitude, longitude, ...extra });
  const places = {
    food: await add(P.food, 48.1468, 17.104, { category_id: id.Food }),
    coffee: await add(P.coffee, 48.1441, 17.1077, { category_id: id.Food, marker_color: "#e5484d", marker_icon: "coffee" }),
    nature: await add(P.nature, 48.1506, 17.1159, { category_id: id.Nature }),
    landmark: await add(P.landmark, 48.1425, 17.1, { category_id: id.Landmarks }),
    hotel: await add(P.hotel, 48.1395, 17.112, { category_id: id.Accommodation }),
    fun: await add(P.fun, 48.1437, 17.1125, { category_id: id.Entertainment, want_to_visit: true }),
    home: await add(P.home, 48.153, 17.106, { category_id: id.Home, favorite: true }),
    travel: await add(P.travel, 48.1575, 17.1067, { category_id: id.Travel, inactive: true }),
    plain: await add(P.plain, 48.1485, 17.0985, {}),
  };
  const person = async (name, addresses) => {
    const id = (await call(m, "/people", "POST", { names: [{ kind: "full", given: name, family: RUN }], addresses })).id;
    state.people[name] = id;
    return id;
  };
  const adr = (street, extra = {}) => ({ street, locality: "Bratislava", postal_code: "811 01", country: "Slovakia", label: "Home", ...extra });
  const people = {
    a: await person("Anna", [adr(`Testovacia 1 ${RUN}`)]),
    b: await person("Beata", [adr(`Testovacia 2 ${RUN}`)]),
    c: await person("Cyril", [adr(`Testovacia 3 ${RUN}`)]),
    d: await person("Dana", [adr(`Testovacia 4 ${RUN}`)]),
    e: await person("Emil", [adr(`Spoločná 5 ${RUN}`)]),
    f: await person("Fero", [adr(`Spoločná 5 ${RUN}`)]),
    g: await person("Gita", [adr(`Domáca 7 ${RUN}`, { is_primary: true }), adr(`Pracovná 8 ${RUN}`, { label: "Work" }), adr(`Stará 9 ${RUN}`, { label: "Childhood", valid_until: "2005" })]),
    h: await person("Hana", [adr(`Nejasná 10 ${RUN}`)]),
    i: await person("Igor", [{ street: `Zzzqx ${RUN} 999`, locality: `Nowhereville${RUN}`, country: "Atlantis" }]),
  };
  return { id, places, people };
}

async function desktop(browser, state) {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const people = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const pane = page.frameLocator("#module-application");
  const a = await open(page, "atlas");
  state.a = a;
  await pane.locator("#map-stage").waitFor();
  const ms = await call(a, "/map-settings");
  state.mapBefore = ms;
  state.filtersBefore = await call(a, "/map-filters");
  await call(a, "/map-settings", "PUT", { online: true, tile_url: ms.tile_url, geocoder_url: ms.geocoder_url });
  await call(a, "/contacts/settings", "PUT", { geocoding: false });
  await call(a, "/map-filters", "PUT", { contacts: true, places: true, hidden_categories: [], favorite: true, want: true, inactive: true, plain: true, current_addresses: true, former_addresses: false });
  const m = await open(people, "meridian");
  state.people = {};
  Object.assign(state, await seed(a, m, state));
  await people.close();
  const atlas = await open(page, "atlas");
  await pane.locator("#map-stage").waitFor();
  state.a = atlas;
  await atlas.evaluate(() => loadContacts());

  // The layer: automatic, no Atlas Places created, nothing located without consent.
  let layer = await until(async () => { const l = await call(atlas, "/contacts"); return l.items.some((x) => x.name.includes(RUN)) && l; }, "Meridian addresses reach Atlas");
  const mine = () => layer.items.filter((x) => x.name.includes(RUN));
  check(mine().length === 11, `every address appears by itself (${mine().length})`);
  check(mine().every((x) => x.status === "pending" && x.latitude === null), "nothing is located before consent");
  check((await call(atlas, "/places?q=" + encodeURIComponent("Anna"))).items.length === 0, "no Atlas Place was created for a contact");
  const of = (given, street) => mine().find((x) => x.name.startsWith(given) && (!street || x.text.includes(street)));
  const put = (x, lat, lng) => call(atlas, `/contacts/${x.id}/location`, "PUT", { latitude: lat, longitude: lng });
  await put(of("Anna"), 48.149, 17.113);
  await put(of("Beata"), 48.147, 17.1185);
  await put(of("Cyril"), 48.1445, 17.1205);
  await put(of("Dana"), 48.141, 17.107);
  await put(of("Emil"), 48.1512, 17.1012);
  await put(of("Fero"), 48.1512, 17.1012);
  await put(of("Gita", "Domáca"), 48.1548, 17.1135);
  await put(of("Gita", "Pracovná"), 48.1385, 17.1025);
  await put(of("Gita", "Stará"), 48.1602, 17.117);
  await call(atlas, "/contacts/markers", "PUT", { scope: "contact", source: of("Beata").resource, color: "#ec4899", icon: "heart-solid" });
  await call(atlas, "/contacts/markers", "PUT", { scope: "contact", source: of("Cyril").resource, color: "#2f80ed", icon: "house" });
  await call(atlas, "/contacts/markers", "PUT", { scope: "contact", source: of("Dana").resource, color: "#22a55b", icon: "tree-pine" });
  await reload(atlas);
  await until(() => atlas.evaluate(() => tiles.images.size >= 0 && state.contacts.items.length > 0), "contacts load");
  await focus(atlas, 48.1475, 17.109, 14.2);
  await until(() => atlas.evaluate(() => tiles.images.size > 3), "real map tiles arrive");
  await sleep(1500);

  // Actual markers.
  layer = await call(atlas, "/contacts");
  const placePin = (k) => `[data-pin="${state.places[k].id}"]`;
  const food = await drawn(atlas, placePin("food"));
  const cat = (await call(atlas, "/categories")).items.find((c) => c.name === "Food");
  check(food.fill === cat.color && food.icon === cat.icon, `a Place draws its category's color and icon (${food.fill}, ${food.icon})`);
  check(food.stroke === "#fff" && food.shapes > 0, "the icon is drawn in white");
  check(food.halo === "#fff" && food.width > 25, `the pin has its halo and a real size (${Math.round(food.width)}px)`);
  check(food.tipDx < 2 && food.tipDy < 3, `the tip of the pin is on the exact location (${food.tipDx.toFixed(1)}, ${food.tipDy.toFixed(1)})`);
  const coffee = await drawn(atlas, placePin("coffee"));
  check(coffee.fill === "#e5484d" && coffee.icon === "coffee", "a Place can have its own color and icon");
  const group = (x) => `[data-contact-pin="${x.group}"]`;
  const anna = await drawn(atlas, group(of("Anna")));
  check(anna.fill === BRONZE && anna.icon === "person-solid", "a contact draws Meridian's bronze with a white person");
  const pink = await drawn(atlas, group(of("Beata")));
  check(pink.fill === "#ec4899" && pink.icon === "heart-solid", "per-contact: pink with a white heart");
  const blue = await drawn(atlas, group(of("Cyril")));
  check(blue.fill === "#2f80ed" && blue.icon === "house", "per-contact: blue with a white house");
  const green = await drawn(atlas, group(of("Dana")));
  check(green.fill === "#22a55b" && green.icon === "tree-pine", "per-contact: green with a white tree");
  const shared = await drawn(atlas, group(of("Emil")));
  check(shared.count === "2", "two contacts at one address share one pin showing 2");
  check((await atlas.locator(group(of("Gita", "Stará"))).count()) === 0, "a former address is hidden by default");
  await page.screenshot({ path: path.join(SHOTS, "map-1440.png") });

  // Zoom-level rendering.
  const near = (await drawn(atlas, placePin("food"))).width;
  await focus(atlas, 48.1475, 17.109, 5.5);
  await sleep(250);
  const far = (await drawn(atlas, placePin("food"))).width;
  check(far < near * 0.9, `pins are smaller when zoomed out (${Math.round(far)} < ${Math.round(near)})`);
  await focus(atlas, 48.1475, 17.109, 14.2);
  await pane.locator(placePin("food")).hover();
  await sleep(250);
  check((await drawn(atlas, placePin("food"))).width > near * 1.05, "a pin grows on hover");
  await page.mouse.move(700, 880);

  // Selected state and Meridian detail.
  await pane.locator(group(of("Emil"))).click();
  await pane.locator("#detail:not([hidden]) .contact-card").nth(1).waitFor();
  check(await atlas.evaluate((sel) => document.querySelector(sel).classList.contains("is-selected"), group(of("Emil"))), "a clicked pin is selected");
  const text = await pane.locator("#detail").innerText();
  check(text.includes("Emil") && text.includes("Fero") && text.includes("2 contacts here"), "the shared pin lists both contacts");
  check(text.includes("From Meridian"), "it says the data belongs to Meridian");
  await page.screenshot({ path: path.join(SHOTS, "shared-address-1440.png") });

  // Customizing a contact, in the real dialog.
  await pane.locator(`#detail [data-contact-action="customize"][data-id="${of("Anna").id}"]`).count();
  await pane.locator('[data-act="close-detail"]').click();
  await pane.locator(group(of("Anna"))).click();
  await pane.locator(`[data-contact-action="customize"][data-id="${of("Anna").id}"]`).click();
  await pane.locator("#subdialog [data-icon-search]").fill("coffee");
  await pane.locator('#subdialog [data-choice="coffee"]').click();
  await pane.locator('#subdialog [data-swatch="#7c5cd6"]').click();
  await page.screenshot({ path: path.join(SHOTS, "contact-marker-1440.png") });
  await pane.locator("#cm-save").click();
  await until(async () => (await drawn(atlas, group(of("Anna")))).fill === "#7c5cd6", "the contact's marker changes");
  check((await drawn(atlas, group(of("Anna")))).icon === "coffee", "the contact's icon changes");
  const edited = (await call(atlas, "/contacts")).items.find((x) => x.id === of("Anna").id);
  check(edited.name === of("Anna").name && edited.text === of("Anna").text, "customizing did not touch the contact or address");
  await pane.locator(`[data-contact-action="customize"][data-id="${of("Anna").id}"]`).click();
  await pane.locator("#cm-reset").click();
  await until(async () => (await drawn(atlas, group(of("Anna")))).fill === BRONZE, "reset to Meridian defaults");

  // Several addresses: address-level customization.
  await pane.locator('[data-act="close-detail"]').click();
  await pane.locator(group(of("Gita", "Domáca"))).click();
  await pane.locator(`[data-contact-action="customize"][data-id="${of("Gita", "Domáca").id}"]`).click();
  await pane.locator('#subdialog [name="cm-scope"][value="address"]').check();
  await pane.locator("#subdialog [data-hex]").fill("#00AA88");
  await pane.locator("#cm-save").click();
  await until(async () => (await drawn(atlas, group(of("Gita", "Domáca")))).fill === "#00aa88", "one address of a contact can differ");
  check((await drawn(atlas, group(of("Gita", "Pracovná")))).fill === BRONZE, "the contact's other address stays default");
  await pane.locator('[data-act="close-detail"]').click();

  // An exact link to Meridian.
  await pane.locator(group(of("Beata"))).click();
  await pane.locator('#detail [data-module="meridian"]').click();
  await until(() => page.url().includes(`/app/modules/meridian`) && page.url().includes(encodeURIComponent(`/people/${state.people.b}`)), "opens the exact contact in Meridian");
  const mframe = await frameOf(page, "meridian");
  await until(() => mframe.evaluate((n) => document.body.innerText.includes(n), "Beata"), "Meridian shows that contact");
  check(true, "the marker opens the exact Meridian profile");

  // An address changed in Meridian updates Atlas.
  const doc = await call(mframe, `/people/${state.people.a}`);
  const row = doc.addresses[0];
  await call(mframe, `/people/${state.people.a}`, "PUT", { names: doc.names.map(({ id, kind, given, family }) => ({ id, kind, given, family })), addresses: [{ id: row.id, label: row.label, street: `Presťahovaná 11 ${RUN}`, locality: "Košice", country: "Slovakia" }], expected_revision: doc.edit_revision });
  const back = await open(page, "atlas");
  state.a = back;
  await pane.locator("#map-stage").waitFor();
  layer = await until(async () => { const l = await call(back, "/contacts"); const x = l.items.find((i) => i.id === row.id); return x.text.includes("Presťahovaná") && l; }, "the changed address arrives");
  const moved = layer.items.find((x) => x.id === row.id);
  check(moved.status === "pending" && moved.latitude === null, "a changed address loses its old position instead of showing a wrong one");
  await call(back, `/contacts/${row.id}/location`, "PUT", { latitude: 48.149, longitude: 17.113 });

  // Consent, real geocoding, not found, ambiguous, by hand.
  await back.evaluate(() => loadContacts());
  await focus(back, 48.1475, 17.109, 14.2);
  await pane.locator('[data-act="contacts-panel"]').click();
  await pane.locator("#allow-geocoding").waitFor();
  const consentText = await pane.locator(".consent-card").innerText();
  check(consentText.includes("Names") && consentText.includes("never sent"), "the consent says what is and is not sent");
  await page.screenshot({ path: path.join(SHOTS, "address-consent-1440.png") });
  await pane.locator("#panel-close").click();
  const igor = (await call(back, "/contacts")).items.find((x) => x.name.startsWith("Igor"));
  const hana = (await call(back, "/contacts")).items.find((x) => x.name.startsWith("Hana"));
  await pane.locator('[data-act="contacts-panel"]').click();
  await pane.locator("#allow-geocoding").click();
  await until(async () => { const l = await call(back, "/contacts"); return l.items.find((x) => x.id === igor.id).status === "not_found"; }, "a real lookup reports an unknown address", 240);
  check(true, "a real provider answered, and an unknown address waits for the owner");
  sql("UPDATE contact_locations SET status='ambiguous',latitude=NULL,longitude=NULL,candidates=? WHERE address_id=?", JSON.stringify([{ display: "Nejasná 10, Bratislava-Staré Mesto", latitude: 48.1472, longitude: 17.1062 }, { display: "Nejasná 10, Banská Bystrica", latitude: 48.736, longitude: 19.146 }]), hana.id);
  await back.evaluate(() => loadContacts());
  await pane.locator(`[data-candidate="${hana.id}"]`).first().waitFor();
  await page.screenshot({ path: path.join(SHOTS, "address-corrections-1440.png") });
  await pane.locator(`[data-candidate="${hana.id}"]`).first().click();
  await until(async () => { const l = await call(back, "/contacts"); const x = l.items.find((i) => i.id === hana.id); return x.status === "located" && x.source === "manual"; }, "choosing a candidate places the address");
  await pane.locator(`[data-panel-pick="${igor.id}"]`).click();
  await pane.locator(".map-picking").waitFor();
  const stage = await pane.locator("#map-stage").boundingBox();
  await page.mouse.click(stage.x + stage.width * 0.68, stage.y + stage.height * 0.3);
  await until(async () => (await call(back, "/contacts")).items.find((x) => x.id === igor.id).status === "located", "placing an address by hand");
  check(true, "an ambiguous address and an unknown one were both corrected by the owner");

  // Layers and filters, persisted by Atlas.
  await back.evaluate(() => loadContacts());
  await focus(back, 48.1475, 17.109, 14.2);
  await sleep(300);
  const annaPins = () => back.locator("[data-contact-pin]").count();
  check((await annaPins()) > 0, "contact pins are on the map");
  await pane.locator('[data-layer="contacts"]').uncheck();
  await until(async () => (await annaPins()) === 0, "the Meridian layer can be hidden");
  check((await back.locator("[data-pin]").count()) > 0, "Atlas Places stay when Meridian is hidden");
  await until(async () => (await call(back, "/map-filters")).contacts === false, "the layer choice is saved in Atlas");
  check((await call(back, "/contacts")).items.length > 0, "hiding unlinked and deleted nothing");
  const again = await open(page, "atlas");
  state.a = again;
  await pane.locator("#map-stage").waitFor();
  await sleep(800);
  check((await pane.locator('[data-layer="contacts"]').isChecked()) === false, "the layer choice survives a reload");
  await pane.locator('[data-layer="contacts"]').check();
  await pane.locator(`[data-category="${state.id.Food}"]`).uncheck();
  await sleep(300);
  check((await again.locator(placePin("food")).count()) === 0, "a category can be hidden on the map");
  check((await again.locator(placePin("coffee")).count()) === 0, "a custom-colored Place is still in its category");
  await pane.locator(`[data-category="${state.id.Food}"]`).check();
  await pane.locator('[data-state="former_addresses"]').check();
  await again.evaluate(() => loadContacts());
  await focus(again, 48.15, 17.11, 14);
  await sleep(300);
  layer = await call(again, "/contacts");
  check((await again.locator(`[data-contact-pin="${layer.items.find((x) => x.text.includes("Stará 9")).group}"]`).count()) === 1, "former addresses can be shown");
  await pane.locator('[data-state="former_addresses"]').uncheck();

  // The Place editor: selector, creating a category, live preview, customizing and resetting.
  await pane.locator('[data-act="new-place"]').first().click();
  await pane.locator("#pl-name").fill(`Kúpele ${RUN}`);
  check(!(await pane.locator("#pl-customize").evaluate((el) => el.open)), "customizing stays folded away");
  await pane.locator("#pl-category .combo-button").click();
  await pane.locator("#pl-category .combo-search").fill("foo");
  check((await pane.locator("#pl-category .combo-option").count()) === 1, "the category selector is searchable");
  await pane.locator("#pl-category .combo-search").fill("");
  await sleep(100);
  check(await pane.locator('#pl-category .combo-option:has-text("Meridian")').isDisabled(), "Meridian is shown but cannot hold a Place");
  await page.screenshot({ path: path.join(SHOTS, "category-selector-1440.png") });
  await pane.locator("#pl-category [data-combo-create]").click();
  await pane.locator("#cat-name").fill(`Wellness ${RUN}`);
  await pane.locator("#subdialog [data-icon-search]").fill("flower");
  await pane.locator('#subdialog [data-choice="flower-2"]').click();
  await pane.locator("#subdialog [data-hex]").fill("#14B8A6");
  await page.screenshot({ path: path.join(SHOTS, "category-editor-1440.png") });
  await pane.locator("#cat-save").click();
  await until(async () => (await pane.locator("#pl-category .combo-button").innerText()).includes("Wellness"), "the new category is selected");
  check((await pane.locator("#pl-preview path").nth(1).getAttribute("fill")) === "#14b8a6", "the live preview shows the category");
  await pane.locator("#pl-customize summary").click();
  await pane.locator("#pl-marker-fields [data-icon-search]").fill("bath");
  await pane.locator('#pl-marker-fields [data-choice="bath"]').click();
  await pane.locator('#pl-marker-fields [data-swatch="#f97316"]').click();
  check((await pane.locator("#pl-preview path").nth(1).getAttribute("fill")) === "#f97316", "the live preview shows the customization");
  await page.screenshot({ path: path.join(SHOTS, "place-editor-1440.png") });
  await pane.locator("#pl-marker-reset").click();
  check((await pane.locator("#pl-preview path").nth(1).getAttribute("fill")) === "#14b8a6", "reset returns to the category's look");
  await pane.locator("#pl-marker-fields [data-icon-search]").fill("bath");
  await pane.locator('#pl-marker-fields [data-choice="bath"]').click();
  await pane.locator("#pl-location").fill("48.1520, 17.1200");
  await pane.locator('[data-act="save-place"]').click();
  await pane.locator("#detail:not([hidden])").waitFor();
  const spa = (await call(again, "/places?q=" + encodeURIComponent(`Kúpele ${RUN}`))).items[0];
  check(spa.marker.color === "#14b8a6" && spa.marker.icon === "bath" && spa.marker.icon_custom && !spa.marker.color_custom, "the saved Place keeps one override and inherits the rest");
  state.spa = spa.id;
  state.wellness = spa.category_id;

  // Categories page and safe delete.
  await pane.locator('[data-go="categories"]').first().click();
  await pane.locator(`[data-category-card="${spa.category_id}"]`).waitFor();
  check((await pane.locator(`[data-category-card="${state.id.Meridian}"]`).innerText()).includes("Owned by Meridian"), "Meridian is shown as a source that Meridian owns");
  check((await pane.locator(`[data-category-card="${state.id.Meridian}"] [data-cat-delete]`).count()) === 0, "Meridian cannot be deleted");
  await page.screenshot({ path: path.join(SHOTS, "categories-1440.png") });
  await pane.locator(`[data-cat-edit="${spa.category_id}"]`).click();
  await pane.locator("#cat-name").fill(`Kúpele a relax ${RUN}`);
  await pane.locator("#subdialog [data-hex]").fill("#3366CC");
  await pane.locator("#cat-save").click();
  await pane.locator(`[data-category-card="${spa.category_id}"]:has-text("Kúpele a relax")`).waitFor();
  const inherited = (await call(again, `/places/${spa.id}`)).marker;
  check(inherited.color === "#3366cc" && inherited.icon === "bath", "editing a category updates inheritors and keeps overrides");
  await pane.locator(`[data-cat-delete="${spa.category_id}"]`).click();
  check((await pane.locator("#subdialog").innerText()).includes("will not be deleted"), "deleting explains that places are kept");
  await pane.locator("#del-ok").click();
  await until(async () => (await call(again, `/places/${spa.id}`)).category_id === null, "the category is deleted");
  check((await call(again, `/places/${spa.id}`)).marker.icon === "bath", "the place remains, with its own icon");

  // Library filters.
  await pane.locator('[data-go="library"]').first().click();
  await pane.locator("#lib-category .combo-button").click();
  await pane.locator('#lib-category [data-combo="' + state.id.Nature + '"]').click();
  await until(async () => (await pane.locator("#place-list .place-card").count()) >= 1 && (await pane.locator("#place-list").innerText()).includes(P.nature), "the Library filters by category");
  await pane.locator("#lib-category .combo-button").click();
  await pane.locator('#lib-category [data-combo="' + state.id.Meridian + '"]').click();
  await until(async () => (await pane.locator("#place-list").innerText()).includes("Beata"), "the Library lists Meridian addresses");
  await page.screenshot({ path: path.join(SHOTS, "library-meridian-1440.png") });

  // Meridian stopped: the rest of Atlas carries on, nothing is lost.
  await pane.locator('[data-go="map"]').first().click();
  await pane.locator("#map-stage").waitFor();
  const before = await call(again, "/contacts");
  execFileSync("docker", ["stop", "aetest-module-meridian"]);
  try {
    await until(async () => (await call(again, "/contacts")).availability !== "available", "Atlas notices Meridian has stopped");
    await again.evaluate(() => loadContacts());
    await sleep(400);
    check((await again.locator("[data-contact-pin]").count()) === 0, "with Meridian stopped its markers are withheld");
    check((await again.locator("[data-pin]").count()) > 0, "Atlas Places still work");
    check((await pane.locator(".layer-note").innerText()).length > 10, "the layer says why");
    await page.screenshot({ path: path.join(SHOTS, "meridian-unavailable-1440.png") });
  } finally {
    execFileSync("docker", ["start", "aetest-module-meridian"]);
  }
  await until(async () => (await call(again, "/contacts")).availability === "available", "Meridian comes back", 90);
  const after = await call(again, "/contacts");
  check(after.items.filter((x) => x.latitude !== null).length === before.items.filter((x) => x.latitude !== null).length, "every marker and position returns");
  check(after.items.find((x) => x.name.startsWith("Beata")).marker.icon === "heart-solid", "overrides return with them");
  check(errors.length === 0, `no script errors (${errors.join(" / ")})`);
  await page.close();
  // Atlas and Nexus really restart; the phone journey below then finds everything still there.
  execFileSync("docker", ["restart", "aetest-module-atlas"]);
  execFileSync("docker", ["restart", "aetest-nexus-1"]);
  await sleep(6000);
}

async function phone(browser, state) {
  const page = await (await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: "reduce" })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const pane = page.frameLocator("#module-application");
  const a = await open(page, "atlas");
  await pane.locator("#map-stage").waitFor();
  await a.evaluate(() => loadContacts());
  await until(() => a.evaluate(() => state.contacts.items.length > 0), "contacts on the phone");
  const kept = (await call(a, "/contacts")).items.find((x) => x.name.startsWith("Beata"));
  check(kept.marker.color === "#ec4899" && kept.marker.icon === "heart-solid" && kept.latitude !== null, "the override and position survive restarting Atlas and Nexus");
  check((await call(a, "/map-filters")).contacts === true && (await call(a, "/categories")).items.some((c) => c.system === "meridian"), "categories and filters survive too");
  await focus(a, 48.1475, 17.109, 13.6);
  await until(() => a.evaluate(() => tiles.images.size > 1), "tiles on the phone");
  await sleep(1400);
  const overflow = (what) => a.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth).then((n) => check(n <= 0, `${what}: no horizontal overflow (${n})`));
  await overflow("map");
  check(await pane.locator(".layers-body").isHidden(), "the layers start folded away on a phone");
  const size = await pane.locator("[data-pin]").first().boundingBox();
  check(size.width >= 28, `pins stay a good size to tap (${Math.round(size.width)}px)`);
  await page.screenshot({ path: path.join(SHOTS, "map-390.png") });
  await pane.locator('[data-act="toggle-layers"]').tap();
  await pane.locator(".layers-body").waitFor();
  await page.screenshot({ path: path.join(SHOTS, "layers-390.png") });
  await pane.locator('[data-act="toggle-layers"]').tap();
  const beata = (await call(a, "/contacts")).items.find((x) => x.name.startsWith("Beata"));
  await pane.locator(`[data-contact-pin="${beata.group}"]`).tap();
  await pane.locator("#detail:not([hidden]) .contact-card").waitFor();
  check(await a.evaluate((sel) => document.querySelector(sel).classList.contains("is-selected"), `[data-contact-pin="${beata.group}"]`), "tapping selects a pin");
  await page.screenshot({ path: path.join(SHOTS, "contact-detail-390.png") });
  await overflow("contact detail");
  await pane.locator('[data-act="close-detail"]').tap();
  await pane.locator('[data-act="new-place"]').first().tap();
  await pane.locator("#pl-category .combo-button").tap();
  await sleep(150);
  await overflow("place editor with the selector open");
  await page.screenshot({ path: path.join(SHOTS, "category-selector-390.png") });
  await pane.locator("#pl-category .combo-button").tap();
  await pane.locator("#pl-customize summary").tap();
  await sleep(150);
  await pane.locator("#pl-marker-fields .icon-grid").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, "place-editor-390.png") });
  await overflow("place editor customizing");
  await pane.locator('[data-act="close-editor"]').tap();
  check(errors.length === 0, `no script errors on the phone (${errors.join(" / ")})`);
  await page.close();
}

async function cleanup(page, state) {
  const a = await open(page, "atlas");
  const places = (await call(a, "/places?q=" + encodeURIComponent(RUN))).items;
  for (const p of places) {
    await call(a, `/places/${p.id}`, "DELETE");
    await call(a, `/trash/${p.id}`, "DELETE");
  }
  for (const c of (await call(a, "/categories")).items.filter((x) => !x.system && x.name.endsWith(` ${RUN}`))) {
    await call(a, `/categories/${c.id}`, "DELETE").catch(() => {});
  }
  const layer = await call(a, "/contacts");
  for (const x of layer.items.filter((i) => i.name.includes(RUN))) {
    await call(a, "/contacts/markers", "PUT", { scope: "contact", source: x.resource, color: null, icon: null });
    await call(a, "/contacts/markers", "PUT", { scope: "address", source: x.id, color: null, icon: null });
  }
  if (state.filtersBefore) await call(a, "/map-filters", "PUT", state.filtersBefore);
  await call(a, "/contacts/settings", "PUT", { geocoding: false });
  if (state.mapBefore) await call(a, "/map-settings", "PUT", { online: state.mapBefore.online, tile_url: state.mapBefore.tile_url, geocoder_url: state.mapBefore.geocoder_url });
  const m = await open(page, "meridian");
  for (const id of new Set(Object.values(state.people || {}))) {
    await call(m, `/people/${id}`, "DELETE").catch(() => {});
    await call(m, `/trash/${id}`, "DELETE").catch(() => {});
  }
  console.log("synthetic data removed");
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const state = {};
  let failed = null;
  try {
    await desktop(browser, state);
    await phone(browser, state);
    console.log(`${passed} checks passed`);
  } catch (error) {
    failed = error;
  }
  try {
    const page = await browser.newPage();
    await cleanup(page, state);
  } catch (error) {
    console.error("cleanup failed:", error.message);
  }
  await browser.close();
  if (failed) {
    console.error(failed.message || failed);
    process.exit(1);
  }
})();
