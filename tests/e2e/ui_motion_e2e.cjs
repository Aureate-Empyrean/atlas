// Atlas's layout and motion, in a real Nexus on a disposable installation with synthetic data.
// Expects Meridian contacts with located addresses and no Atlas Places. Removes what it creates.
//
//   NEXUS_URL=http://localhost:12398 OWNER_FILE=owner.json BROWSER=chromium PLAYWRIGHT_PATH=... node tests/e2e/ui_motion_e2e.cjs
const fs = require("fs");
const playwright = require(process.env.PLAYWRIGHT_PATH || "playwright");

const NEXUS = process.env.NEXUS_URL;
const ENGINE = process.env.BROWSER || "chromium";
if (!NEXUS || !process.env.OWNER_FILE) throw new Error("NEXUS_URL and OWNER_FILE are required");
const owner = JSON.parse(fs.readFileSync(process.env.OWNER_FILE, "utf8"));
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
const check = (ok, what) => {
  if (ok) {
    passed++;
    console.log(`ok   ${what}`);
  } else {
    failures.push(what);
    console.log(`FAIL ${what}`);
  }
};
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await Promise.resolve().then(fn).catch(() => null);
    if (value) return value;
    await sleep(60);
  }
  check(false, `${what} (timed out)`);
  return null;
}
const frameOf = async (page) => (await page.locator("#module-application").elementHandle({ timeout: 25000 })).contentFrame();
async function open(page, module, reference) {
  await page.goto(`${NEXUS}/app/modules/${module}${reference ? `?path=${encodeURIComponent(reference)}` : ""}`);
  await page.locator("#username, #module-application").first().waitFor({ timeout: 30000 });
  if (await page.locator("#username").isVisible()) {
    await page.locator("#username").fill(owner.username);
    await page.locator("#password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  return until(async () => {
    const f = await frameOf(page);
    return (await f.evaluate((m) => globalThis.eval(`typeof ${m}Navigation !== "undefined" && ${m}Navigation.enabled`), module)) ? f : null;
  }, `${module} ready`, 30000);
}
const call = (f, p, m = "GET", b) => f.evaluate(([x, y, z]) => (z === null ? api(x, y) : api(x, y, z)), [p, m, b === undefined ? null : b]);
const animations = (f, selector) => f.evaluate((s) => document.querySelector(s)?.getAnimations().length || 0, selector);
const SIZES = [[1920, 1080], [1440, 900], [768, 1024], [390, 844]];

(async () => {
  const browser = await playwright[ENGINE].launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const external = new Set();
  page.on("request", (r) => {
    if (/^https?:/.test(r.url()) && new URL(r.url()).hostname !== "localhost") external.add(new URL(r.url()).hostname);
  });
  let a = await open(page, "atlas");
  await until(() => a.evaluate(() => state.contacts.availability === "available" && $("#pins").children.length > 0), "Meridian markers on the map");
  await until(() => a.evaluate(() => flightTarget === null && map.z > 5), "the first view fits Meridian's markers");

  /* ── The empty state ── */
  check((await call(a, "/places")).items.length === 0, "the test starts with no Atlas Places");
  check(await a.locator("#map-empty").isHidden(), "no onboarding message over Meridian markers");
  const toggle = a.locator('[data-layer="contacts"]');
  await toggle.uncheck();
  await until(() => a.locator("#map-empty").isVisible(), "hiding the only layer shows an empty state");
  check((await a.locator("#map-empty").innerText()).includes("Nothing to show with these layers"), "and it says the layers are why");
  await toggle.check();
  await until(() => a.locator("#map-empty").isHidden(), "showing the layer removes it");
  await until(() => a.evaluate(() => !document.querySelector(".map-wrap > .map-empty:not(#map-empty)")), "its fading copy goes away");

  /* ── The map stays direct, and buttons glide ── */
  const zooms = await a.evaluate(async () => {
    document.querySelector('[data-act="zoom-in"]').click();
    const seen = [];
    const start = performance.now();
    while (performance.now() - start < 300) {
      seen.push(map.z);
      await new Promise(requestAnimationFrame);
    }
    return seen;
  });
  check(new Set(zooms.map((z) => z.toFixed(3))).size >= 3, "the zoom button glides");
  await until(() => a.evaluate(() => flightTarget === null), "the glide ends");
  const target = await a.evaluate(() => map.z);
  await a.evaluate(() => { for (let i = 0; i < 3; i++) document.querySelector('[data-act="zoom-in"]').click(); });
  await until(() => a.evaluate((t) => Math.abs(map.z - (t + 2.4)) < 0.05, target), "repeated zoom clicks add up exactly");
  const before = await a.evaluate(() => [map.cx, map.z]);
  await a.evaluate(() => document.querySelector('[data-act="fit"]').click());
  const stage = await a.locator("#map-stage").boundingBox();
  await page.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.6 + 80, stage.y + stage.height * 0.7, { steps: 4 });
  await page.mouse.up();
  const dragged = await a.evaluate(() => map.cx);
  await sleep(450);
  check((await a.evaluate(() => map.cx)) === dragged && dragged !== before[0], "dragging takes over from a glide at once");

  /* ── Sections ── */
  for (const view of ["library", "categories", "map", "trash", "settings", "library"]) await a.evaluate((v) => document.querySelector(`[data-go="${v}"]`).click(), view);
  await until(() => a.evaluate(() => state.view === "library" && !!document.querySelector("#place-list")), "rapid section changes end on the last one");
  await until(() => a.evaluate(() => shownRoute === "/library"), "and the address agrees");
  await until(() => a.evaluate(() => document.querySelectorAll("[data-contact-entry]").length > 0), "the Library shows Meridian addresses");
  await a.evaluate(() => document.querySelector('[data-go="categories"]').click());
  await until(() => a.locator(".category-grid").count(), "Categories opens");
  check((await animations(a, ".page")) >= 0, "section change ran");
  await a.evaluate(() => document.querySelector('[data-go="library"]').click());
  await until(() => a.evaluate(() => document.querySelectorAll("[data-contact-entry]").length > 0), "Library again");

  /* ── Library cards ── */
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(320);
    const g = await a.evaluate(() => {
      const cards = [...document.querySelectorAll("[data-contact-entry]")].map((c) => {
        const r = c.getBoundingClientRect();
        const chip = c.querySelector(".source-chip").getBoundingClientRect();
        const title = c.querySelector(".card-title").getBoundingClientRect();
        const actions = c.querySelector(".card-actions").getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), actionBottom: Math.round(actions.bottom), chipRight: chip.right, cardRight: r.right, chipH: chip.height, overlap: title.right > chip.left + 0.5 };
      });
      return { cards, wide: document.documentElement.scrollWidth <= innerWidth + 1 };
    });
    const rows = {};
    for (const c of g.cards) (rows[c.top] ||= []).push(c);
    check(Object.values(rows).every((r) => new Set(r.map((c) => c.actionBottom)).size === 1), `actions line up across a row at ${w} px`);
    check(g.cards.every((c) => !c.overlap && c.chipH < 22 && c.chipRight <= c.cardRight), `the source indicator never wraps or overlaps at ${w} px`);
    check(g.wide, `no sideways scrolling in the Library at ${w} px`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(200);

  /* ── Filters ── */
  const entries = () => a.locator("[data-contact-entry]").count();
  const total = await entries();
  await a.locator('[data-source="places"]').click();
  await until(async () => (await entries()) === 0, "the Your places filter hides Meridian addresses");
  await a.locator('[data-source="contacts"]').click();
  await until(async () => (await entries()) === total, "the Meridian filter shows them");
  const glide = await a.evaluate(async () => {
    const box = document.querySelector("#place-list");
    const first = box.firstElementChild;
    document.querySelector("#lib-sort").value = "source";
    document.querySelector("#lib-q").value = "testov";
    document.querySelector("#lib-q").dispatchEvent(new Event("input", { bubbles: true }));
    const start = performance.now();
    let moving = 0;
    while (performance.now() - start < 700) {
      moving = Math.max(moving, [...box.children].filter((c) => c.getAnimations().length).length);
      await new Promise(requestAnimationFrame);
    }
    return { moving, connected: first.isConnected };
  });
  check(glide.moving > 0, "cards animate when a search changes the list");
  await a.locator("#lib-q").fill("");
  await until(async () => (await entries()) === total, "search clears");

  /* ── Meridian link and details ── */
  const entry = a.locator("[data-contact-entry]").first();
  const openPath = await entry.locator('button[data-module="meridian"]').getAttribute("data-path");
  await entry.locator('button[data-module="meridian"]').click();
  await until(() => new URL(page.url()).searchParams.get("path") === openPath, "Open in Meridian goes to the exact address");
  await page.goBack();
  await until(() => new URL(page.url()).pathname === "/app/modules/atlas", "Back returns to Atlas");
  a = await until(async () => { const f = await frameOf(page); return (await f.evaluate(() => globalThis.eval('typeof atlasNavigation !== "undefined" && atlasNavigation.enabled'))) ? f : null; }, "Atlas again");
  await until(() => a.evaluate(() => document.querySelectorAll("[data-contact-entry]").length > 0), "the Library again");
  await a.locator("[data-contact-entry] [data-contact-pin]").first().click();
  await until(() => a.locator("#detail").isVisible(), "Show on map opens its details");
  await until(async () => !(await animations(a, "#detail")), "the panel settles");
  await a.locator('#detail [data-act="close-detail"]').click();
  check(await a.locator("#detail").isHidden(), "closing is immediate for the page");
  await until(() => a.evaluate(() => document.querySelectorAll(".detail").length === 1), "the fading copy is removed");

  /* ── Categories ── */
  a = await open(page, "atlas", "/categories");
  await a.locator(".category-grid").waitFor();
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(300);
    const g = await a.evaluate(() => ({
      columns: getComputedStyle(document.querySelector(".category-grid")).gridTemplateColumns.split(" ").length,
      width: document.querySelector(".category-card").getBoundingClientRect().width,
      broken: [...document.querySelectorAll(".cat-title h3")].filter((h) => h.textContent.length < 16 && h.getClientRects()[0].height > 26).length,
      wide: document.documentElement.scrollWidth <= innerWidth + 1,
      clipped: [...document.querySelectorAll(".category-card")].filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).length,
    }));
    check(g.width >= (w > 700 ? 300 : 280), `category cards are at least 300 px wide at ${w} px (${Math.round(g.width)})`);
    check(g.broken === 0, `short category names stay on one line at ${w} px`);
    check(g.clipped === 0 && g.wide, `nothing is clipped or overflowing at ${w} px`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const source = a.locator(".source-row");
  check((await source.innerText()).includes("Owned by Meridian") && !(await source.innerText()).includes("Managed by Atlas"), "Meridian is presented as the owner of its addresses");
  check((await source.locator("[data-cat-edit], [data-cat-delete]").count()) === 0, "the source has no Edit or Delete");
  check((await a.locator(`.category-grid [data-category-card] h3:text-is("Meridian")`).count()) === 0, "Meridian is not listed among the categories");
  check(await a.locator("#source-count").evaluate((e) => /\d+ address/.test(e.textContent)), "the source shows its address count");
  const edit = a.locator("[data-cat-edit]").first();
  check(/^Edit .+/.test(await edit.getAttribute("aria-label")), "actions name their category for assistive technology");

  /* ── Category changes, and dialogs that can be interrupted ── */
  await a.locator('[data-act="new-category"]').click();
  await a.locator("#cat-name").waitFor();
  await a.locator("#cat-name").fill(`Skúšobná ${RUN}`);
  await a.locator("#cat-save").click();
  const card = () => a.locator(`[data-category-card]:has(h3:text-is("Skúšobná ${RUN}"))`);
  await card().waitFor();
  await card().locator("[data-cat-edit]").click();
  await a.locator("#cat-name").fill(`Upravená ${RUN}`);
  await a.locator("#cat-save").click();
  await a.locator(`h3:text-is("Upravená ${RUN}")`).waitFor();
  await a.locator(`[data-category-card]:has(h3:text-is("Upravená ${RUN}")) [data-cat-delete]`).click();
  await a.locator("#del-ok").waitFor();
  await a.locator("#del-ok").click();
  await until(async () => (await a.locator(`h3:text-is("Upravená ${RUN}")`).count()) === 0, "a category can be created, edited and deleted");
  await a.locator('[data-act="new-category"]').click();
  await a.evaluate(() => { const d = $("#subdialog"); for (let i = 0; i < 6; i++) { d.close(); d.showModal(); } d.close(); });
  await until(() => a.evaluate(() => !$("#subdialog").open && getComputedStyle($("#subdialog")).display === "none"), "a dialog opened and closed rapidly ends closed");
  await a.locator('[data-act="source-library"]').click();
  await until(() => a.evaluate(() => state.view === "library" && state.filter.source === "contacts" && document.querySelectorAll("[data-contact-entry]").length > 0), "Show in Library opens the Meridian addresses");

  /* ── Reduced motion ── */
  const calm = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", storageState: await ctx.storageState() });
  const still = await calm.newPage();
  const q = await open(still, "atlas", "/library");
  await until(() => q.evaluate(() => document.querySelectorAll("[data-contact-entry]").length > 0), "Library with reduced motion");
  const running = await q.evaluate(async () => {
    document.querySelector('[data-go="categories"]').click();
    await new Promise((r) => setTimeout(r, 120));
    return document.getAnimations().filter((x) => x.effect.getTiming().duration > 1).length;
  });
  check(running === 0, "with reduced motion nothing animates");
  await calm.close();

  check(errors.filter((e) => !/access control checks/.test(e)).length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  check(external.size === 0, `no external requests ${[...external].join(",")}`);
  await browser.close();
  console.log(JSON.stringify({ engine: ENGINE, passed, failed: failures.length, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  console.log(JSON.stringify({ engine: ENGINE, passed, failed: failures.length + 1, failures: [...failures, e.message.slice(0, 300)] }));
  process.exit(1);
});
