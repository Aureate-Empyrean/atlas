/* Atlas: the personal geographic layer. Vanilla JS in the Nexus sandbox: every request goes through
   the Nexus bridge to this module's own API, and the page has no network of its own.

   The map is Atlas's own Web Mercator view. OpenStreetMap tiles arrive through Atlas's server,
   only after the owner turns the online map on (ADR 0025); without them the grid still works. */

"use strict";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

// Filled by the server from frontend/icon.svg; the header and manifest share one asset.
const ATLAS_ICON = "/*ATLAS_ICON*/";

const ICONS = {
  map: '<path d="m3 5.500 4.500-2 5 2 4.500-2v11l-4.500 2-5-2-4.500 2z"/><path d="M7.500 3.500v11M12.500 5.500v11"/>',
  library: '<path d="M4 5.500h12M4 10h12M4 14.500h12"/>',
  trash: '<path d="M4.500 6h11M8 6V4.500h4V6M6 6l.7 10h6.600L14 6"/>',
  plus: '<path d="M10 4.500v11M4.500 10h11"/>',
  minus: '<path d="M4.500 10h11"/>',
  fit: '<path d="M3.500 7.500v-4h4M16.500 7.500v-4h-4M3.500 12.500v4h4M16.500 12.500v4h-4"/>',
  search: '<circle cx="9" cy="9" r="5"/><path d="m13 13 3.500 3.500"/>',
  edit: '<path d="m4 16 .7-3.300 8.300-8.300a1.600 1.600 0 0 1 2.300 2.300L7 15z"/>',
  x: '<path d="m5.500 5.500 9 9M14.500 5.500l-9 9"/>',
  restore: '<path d="M4.500 9.500a5.500 5.500 0 1 1 1.600 4"/><path d="M4 5.500v4h4"/>',
  external: '<path d="M11 4h5v5M16 4l-7.500 7.500M14 11.500v3c0 .8-.7 1.500-1.500 1.500h-7c-.8 0-1.500-.7-1.500-1.500v-7c0-.8.7-1.500 1.500-1.500h3"/>',
  link: '<path d="M8.500 11.500a3 3 0 0 0 4.200 0l2.300-2.300a3 3 0 0 0-4.200-4.200l-.8.8"/><path d="M11.500 8.500a3 3 0 0 0-4.200 0L5 10.800A3 3 0 0 0 9.200 15l.8-.8"/>',
  calendar: '<rect x="3.500" y="4.500" width="13" height="12" rx="2"/><path d="M3.500 8.500h13M7 3v3M13 3v3"/>',
  people: '<circle cx="7.500" cy="7" r="2.800"/><path d="M2.500 16c.5-3 2.500-4.500 5-4.500s4.500 1.500 5 4.500"/><path d="M13 4.500a2.800 2.800 0 0 1 0 5M14.500 11.800c1.600.6 2.700 2 3 4.200"/>',
  note: '<path d="M5 3.500h7l3.500 3.500v9.500H5z"/><path d="M12 3.500V7h3.500"/>',
  tag: '<path d="M3.500 10.500v-7h7l6 6-7 7z"/><circle cx="7" cy="7" r="1"/>',
  chevron: '<path d="m5.500 8 4.500 4.500L14.500 8"/>',
  lock: '<rect x="5" y="9" width="10" height="7.500" rx="1.500"/><path d="M7 9V6.500a3 3 0 0 1 6 0V9"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ""}</svg>`;

/* Markers (ADR 0030): one pin silhouette, a solid colour and a white Lucide icon. The white halo
   keeps a pin readable on dark tiles, the darker rim and shadow on light ones. */
const LUCIDE = /*LUCIDE_ICONS*/null;
const iconMarkup = (name) => (Object.hasOwn(LUCIDE.icons, name) ? LUCIDE.icons[name] : LUCIDE.icons["map-pin"]).m;
const lucideIcon = (name, size = 18) => `<svg class="lu" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconMarkup(name)}</svg>`;
const MERIDIAN_MARKER = { color: "#c48663", icon: "person-solid" };
const DEFAULT_MARKER = { color: "#4285d4", icon: "map-pin" };
const PIN_PATH = "M18 1.500C8.900 1.500 1.500 8.900 1.500 18c0 11.900 13.700 24.500 15.400 26 .6.500 1.600.500 2.200 0 1.700-1.500 15.400-14.100 15.400-26C34.500 8.900 27.100 1.500 18 1.500z";
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const shade = (hex, f) => "#" + rgb(hex).map((c) => Math.round(c * f).toString(16).padStart(2, "0")).join("");
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function markerSvg(marker, size = 36) {
  const m = marker || DEFAULT_MARKER;
  const light = luminance(m.color) > 0.5;
  return `<svg class="pin-svg" width="${size}" height="${Math.round((size * 46) / 36)}" viewBox="0 0 36 46" aria-hidden="true"><path d="${PIN_PATH}" fill="#fff" stroke="#fff" stroke-width="2.600" stroke-linejoin="round" opacity=".92"/><path d="${PIN_PATH}" fill="${esc(m.color)}" stroke="${shade(m.color, 0.62)}" stroke-width="1"/><g transform="translate(8 8) scale(.8333)" color="#fff" fill="none" stroke="#fff" stroke-width="2.300" stroke-linecap="round" stroke-linejoin="round"${light ? ' style="filter:drop-shadow(0 0 1.200px rgba(0,0,0,.75))"' : ""}>${iconMarkup(m.icon)}</g></svg>`;
}
const layerOf = (p) => (p.inactive ? "inactive" : p.favorite ? "favorite" : p.want_to_visit ? "want" : "saved");
const STATE_LABEL = { saved: "", favorite: "Favorite", want: "Want to visit", inactive: "Historical" };
const STATE_BADGE = { favorite: "star-solid", want: "flag" };
const hasLocation = (p) => p.latitude !== null && p.longitude !== null;
const coords = (p) => `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;

/* ── Bridge ── */
let serial = 0;
const pending = new Map();
addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.channel !== "empyrean-v1") return;
  const req = pending.get(event.data.id);
  if (!req) return;
  clearTimeout(req.timer);
  pending.delete(event.data.id);
  event.data.error ? req.reject(Error(event.data.error)) : req.resolve(event.data.result);
});
function bridge(action, data = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++serial);
    const timer = setTimeout(() => (pending.delete(id), reject(Error("Nexus did not respond. Try again in a moment."))), 30000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ channel: "empyrean-v1", id, action, ...data }, "*");
  });
}
const api = (path, method = "GET", body) => bridge("request", { path: "/api" + path, method, ...(body === undefined ? {} : { body }) });

/* ── Feedback ── */
function toast(message, tone = "") {
  const el = document.createElement("div");
  el.className = `ae-toast ae-glass ${tone ? "ae-toast--" + tone : ""}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 4200);
}
function confirmDialog(title, text, label) {
  const d = $("#dialog");
  d.innerHTML = `<div class="ae-dialog-head"><h2>${esc(title)}</h2></div><div class="ae-dialog-body"><p>${esc(text)}</p></div>
    <div class="ae-dialog-foot"><button class="ae-btn" value="cancel">Cancel</button><button class="ae-btn ae-btn--danger" value="ok">${esc(label)}</button></div>`;
  d.showModal();
  $('[value="cancel"]', d).focus();
  return new Promise((resolve) => {
    const done = (v) => (d.close(), resolve(v));
    $('[value="cancel"]', d).onclick = () => done(false);
    $('[value="ok"]', d).onclick = () => done(true);
    d.oncancel = () => resolve(false);
  });
}

/* ── State ── */
const state = {
  view: "map", places: [], counts: { active: 0, trashed: 0 }, categories: [], tags: [], apps: [],
  selected: null, selectedGroup: null, picking: null, mapSettings: null, searchResults: null,
  filter: { q: "", view: "all", category: "" },
  filters: { places: true, contacts: true, hidden_categories: [], favorite: true, want: true, inactive: true, plain: true, current_addresses: true, former_addresses: false },
  contacts: { availability: "loading", items: [], geocoding: false, online: false, pending: 0, working: false },
  layersOpen: innerWidth > 760,
};
const map = { cx: 0.5, cy: 0.42, z: 2, ready: false };

function shell() {
  $("#app").innerHTML = `<aside class="rail" aria-label="Atlas">
      <div class="brand"><span class="brand-mark"><img src="${ATLAS_ICON}" alt="" aria-hidden="true" width="32" height="32"></span><span class="brand-name">Atlas</span></div>
      <nav id="nav" aria-label="Sections"></nav>
    </aside>
    <main class="sheet" id="sheet"></main>
    <aside id="detail" class="detail ae-glass" aria-label="Place details" hidden></aside>`;
}
function nav() {
  const item = (view, ic, text, count) => `<button class="nav-item" data-go="${view}" ${state.view === view ? 'aria-current="page"' : ""}>${icon(ic)}<span>${text}</span>${count ? `<span class="count">${count}</span>` : ""}</button>`;
  $("#nav").innerHTML = item("map", "map", "Map") + item("library", "library", "Library", state.counts.active) + item("categories", "tag", "Categories") + item("trash", "trash", "Trash", state.counts.trashed) + item("settings", "fit", "Settings");
}
async function refresh() {
  const [s, list, filters] = await Promise.all([api("/state"), api("/places"), api("/map-filters")]);
  state.counts = s.counts;
  state.categories = s.categories;
  state.tags = s.tags;
  state.places = list.items;
  state.filters = filters;
  state.mapSettings = await api("/map-settings");
}
/* The contact layer loads on its own: Meridian being slow or away must never hold up the map. */
let contactTimer = null;
async function loadContacts() {
  clearTimeout(contactTimer);
  try {
    state.contacts = await api("/contacts");
  } catch {
    state.contacts = { ...state.contacts, availability: "nexus_unreachable", items: [] };
  }
  pinsDirty = true;
  if ($("#map-stage")) {
    renderLayers();
    draw();
  }
  if (state.view === "library" && state.filter.category === MERIDIAN_ID()) loadLibrary().catch(() => {});
  if ($("#contacts-panel")) renderContactsPanel();
  if (state.selectedGroup) refreshContactDetail();
  const busy = state.contacts.working || (state.contacts.pending && state.contacts.geocoding && state.contacts.online);
  contactTimer = setTimeout(() => {
    if (document.visibilityState === "visible") loadContacts();
    else contactTimer = setTimeout(loadContacts, 60000);
  }, busy ? 4000 : 60000);
}
const MERIDIAN_ID = () => state.categories.find((c) => c.system === "meridian")?.id;
const categoryById = (id) => state.categories.find((c) => c.id === id);
let filterTimer = null;
function saveFilters() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => api("/map-filters", "PUT", state.filters).catch((e) => toast(e.message, "danger")), 250);
}
function render() {
  nav();
  const sheet = $("#sheet");
  sheet.classList.toggle("is-map", state.view === "map");
  if (state.view === "map") return viewMap(sheet);
  stopMap();
  if (state.view === "trash") return viewTrash(sheet);
  if (state.view === "settings") return viewSettings(sheet);
  if (state.view === "categories") return viewCategories(sheet);
  return viewLibrary(sheet);
}
async function go(view) {
  state.view = view;
  state.picking = null;
  closeDetail();
  await refresh().catch((e) => toast(e.message, "danger"));
  render();
  loadContacts();
}

/* ── Map ── */
const lngX = (lng) => (lng + 180) / 360;
const latY = (lat) => {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const xLng = (x) => x * 360 - 180;
const yLat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
const worldSize = () => 256 * 2 ** map.z;
function viewSize() {
  const stage = $("#map-stage");
  return stage ? [stage.clientWidth, stage.clientHeight] : [1, 1];
}
function toScreen(x, y) {
  const [w, h] = viewSize();
  return [(x - map.cx) * worldSize() + w / 2, (y - map.cy) * worldSize() + h / 2];
}
function fromScreen(px, py) {
  const [w, h] = viewSize();
  return [map.cx + (px - w / 2) / worldSize(), map.cy + (py - h / 2) / worldSize()];
}
function minZoom() {
  const [w] = viewSize();
  return Math.max(1, Math.log2(w / 256));
}
function clampView() {
  map.z = Math.max(minZoom(), Math.min(19, map.z));
  map.cx = Math.max(0, Math.min(1, map.cx));
  map.cy = Math.max(0, Math.min(1, map.cy));
}
function placeVisible(p) {
  const f = state.filters;
  if (!hasLocation(p) || !f.places || f.hidden_categories.includes(p.category_id || "none")) return false;
  return { saved: f.plain, favorite: f.favorite, want: f.want, inactive: f.inactive }[layerOf(p)];
}
const visiblePlaces = () => state.places.filter(placeVisible);
/* People at one spot share one pin; each keeps their own appearance in its list. */
function contactGroups() {
  const f = state.filters;
  if (!f.contacts) return [];
  const groups = new Map();
  for (const c of state.contacts.items) {
    if (c.latitude === null || !(c.current ? f.current_addresses : f.former_addresses)) continue;
    if (!groups.has(c.group)) groups.set(c.group, { key: c.group, latitude: c.latitude, longitude: c.longitude, members: [] });
    groups.get(c.group).members.push(c);
  }
  return [...groups.values()].map((g) => {
    const first = g.members[0].marker;
    const same = g.members.every((m) => m.marker.color === first.color && m.marker.icon === first.icon);
    return { ...g, marker: same ? first : MERIDIAN_MARKER, former: g.members.every((m) => !m.current) };
  });
}
function fitPlaces() {
  const list = [...visiblePlaces(), ...contactGroups()];
  const [w, h] = viewSize();
  if (!list.length) {
    map.cx = 0.5;
    map.cy = 0.42;
    map.z = minZoom();
  } else {
    const xs = list.map((p) => lngX(p.longitude));
    const ys = list.map((p) => latY(p.latitude));
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    map.cx = (x0 + x1) / 2;
    map.cy = (y0 + y1) / 2;
    const span = Math.max((x1 - x0) / (w * 0.7), (y1 - y0) / (h * 0.7));
    map.z = span > 0 ? Math.log2(1 / (span * 256)) : 12;
    map.z = Math.min(map.z, 14);
  }
  clampView();
  draw();
}
function viewMap(sheet) {
  const located = state.places.filter(hasLocation).length + state.contacts.items.filter((c) => c.latitude !== null).length;
  sheet.innerHTML = `<div class="map-wrap">
    <div class="map-stage" id="map-stage" tabindex="0" role="application" aria-label="Map of your places. Arrow keys move it, plus and minus zoom.">
      <canvas id="map-tiles" aria-hidden="true"></canvas><canvas id="map-grid" aria-hidden="true"></canvas><div class="pins" id="pins"></div>
    </div>
    <div class="map-top">
      <button class="ae-btn ae-btn--primary" data-act="new-place">${icon("plus")}<span>Add place</span></button>
      <form class="map-search ae-glass" id="map-search" role="search"><input class="ae-input" id="map-q" type="search" placeholder="Search your places" aria-label="Search your places" maxlength="200" autocomplete="off"></form>
    </div>
    <div class="map-results ae-glass" id="map-results" hidden></div>
    ${state.mapSettings?.online ? `<button class="map-attribution" data-act="osm-copyright">${esc(state.mapSettings.attribution)}</button>` : `<div class="map-consent ae-glass"><p><strong>Show a real map?</strong> Atlas would fetch map images from OpenStreetMap. That shows the provider which area you are looking at. Your places, contacts and notes are never sent.</p><button class="ae-btn ae-btn--primary" data-act="map-online">Turn on the online map</button></div>`}
    <div class="map-layers ae-glass" id="map-layers" role="group" aria-label="Layers"></div>
    <div class="map-zoom ae-glass" role="group" aria-label="Zoom">
      <button class="map-tool" data-act="zoom-in" aria-label="Zoom in" title="Zoom in">${icon("plus")}</button>
      <button class="map-tool" data-act="zoom-out" aria-label="Zoom out" title="Zoom out">${icon("minus")}</button>
      <button class="map-tool" data-act="fit" aria-label="Fit all places" title="Fit all places">${icon("fit")}</button>
    </div>
    ${state.picking ? `<div class="map-picking ae-glass" role="status"><span>Click the map to choose the location.</span><button class="ae-btn ae-btn--sm" data-act="cancel-pick">Cancel</button></div>` : ""}
    ${!located && !state.picking ? `<div class="map-empty ae-glass"><h2>${state.places.length ? "None of your places has a location yet" : "The places that matter to you"}</h2><p>Add a place by clicking the map, or search for one.</p></div>` : ""}
  </div>`;
  renderLayers();
  bindMap();
  resizeCanvas();
  if (!map.ready) {
    map.ready = true;
    fitPlaces();
  } else {
    clampView();
    draw();
  }
  $("#map-stage").classList.toggle("is-picking", !!state.picking);
}
function renderLayers() {
  const box = $("#map-layers");
  if (!box) return;
  const f = state.filters;
  const row = (attr, on, marker, label, count) => `<label class="layer"><input type="checkbox" ${attr} ${on ? "checked" : ""}>${markerSvg(marker, 17)}<span class="grow">${esc(label)}</span>${count === undefined ? "" : `<span class="count">${count}</span>`}</label>`;
  const chip = (key, label) => `<label class="state-chip"><input type="checkbox" data-state="${key}" ${f[key] ? "checked" : ""}><span>${label}</span></label>`;
  const located = state.places.filter(hasLocation);
  const c = state.contacts;
  const shown = c.items.filter((x) => x.latitude !== null).length;
  const waiting = c.items.filter((x) => x.latitude === null).length;
  const meridian = categoryById(MERIDIAN_ID());
  let note = "";
  if (c.availability === "loading") note = `<p class="layer-note">Asking Meridian…</p>`;
  else if (c.availability !== "available") note = `<p class="layer-note">${esc(contactNote(c.availability))}</p>`;
  else if (waiting) note = `<button class="layer-action" data-act="contacts-panel">${lucideIcon("locate", 15)}<span>${waiting} ${waiting === 1 ? "address needs" : "addresses need"} a location</span></button>`;
  const cats = state.categories.filter((x) => !x.system);
  const uncategorized = located.filter((p) => !p.category_id).length;
  box.innerHTML = `<button class="layers-toggle" data-act="toggle-layers" aria-expanded="${state.layersOpen}">${lucideIcon("map", 16)}<span class="grow">Layers</span><span class="chev${state.layersOpen ? " is-open" : ""}">${icon("chevron")}</span></button>
    <div class="layers-body" ${state.layersOpen ? "" : "hidden"}>
      ${row('data-layer="places"', f.places, DEFAULT_MARKER, "Atlas Places", located.length)}
      ${row('data-layer="contacts"', f.contacts, meridian || MERIDIAN_MARKER, "Meridian contacts", shown)}
      ${note}
      <p class="section-label">Categories</p>
      ${cats.map((x) => row(`data-category="${esc(x.id)}"`, !f.hidden_categories.includes(x.id), x, x.name, located.filter((p) => p.category_id === x.id).length)).join("")}
      ${uncategorized ? row('data-category="none"', !f.hidden_categories.includes("none"), DEFAULT_MARKER, "No category", uncategorized) : ""}
      <p class="section-label">Show</p>
      <div class="state-chips">${chip("plain", "Other places")}${chip("favorite", "Favorites")}${chip("want", "Want to visit")}${chip("inactive", "Historical")}${chip("current_addresses", "Current addresses")}${chip("former_addresses", "Former addresses")}</div>
    </div>`;
}
function contactNote(availability) {
  return { not_granted: "Atlas does not have access to Meridian's addresses.", forbidden: "Meridian did not share its addresses.", module_uninstalled: "Meridian is not installed.", module_disabled: "Meridian is turned off, so its markers are hidden.", not_provided: "This version of Meridian does not share addresses yet." }[availability] || "Meridian cannot be reached right now. Its markers will come back with it.";
}
function pinScale() {
  return map.z < 4 ? 0.62 : map.z < 7 ? 0.74 : map.z < 11 ? 0.88 : 1;
}
function renderPins() {
  const box = $("#pins");
  if (!box) return;
  const places = visiblePlaces().map((p) => {
    const st = layerOf(p);
    return { lat: p.latitude, lng: p.longitude, attr: `data-pin="${esc(p.id)}"`, marker: p.marker, name: p.name, selected: state.selected?.id === p.id, faded: p.inactive, badge: STATE_BADGE[st], label: `${p.name}${p.category ? ", " + p.category : ""}${STATE_LABEL[st] ? ", " + STATE_LABEL[st] : ""}` };
  });
  const people = contactGroups().map((g) => {
    const name = g.members.length > 1 ? `${g.members.length} contacts` : g.members[0].name;
    return { lat: g.latitude, lng: g.longitude, attr: `data-contact-pin="${esc(g.key)}"`, marker: g.marker, name, selected: state.selectedGroup === g.key, faded: g.former, count: g.members.length > 1 ? g.members.length : 0, label: `${name}, from Meridian` };
  });
  box.innerHTML = [...places, ...people]
    .sort((a, b) => b.lat - a.lat)
    .map((m) => `<button class="pin ${m.selected ? "is-selected" : ""} ${m.faded ? "is-faded" : ""}" ${m.attr} data-lat="${m.lat}" data-lng="${m.lng}" data-color="${esc(m.marker.color)}" data-icon="${esc(m.marker.icon)}" aria-label="${esc(m.label)}" title="${esc(m.name)}">${markerSvg(m.marker)}${m.count ? `<span class="pin-count">${m.count}</span>` : ""}${m.badge ? `<span class="pin-badge">${lucideIcon(m.badge, 10)}</span>` : ""}<span class="pin-label">${esc(m.name)}</span></button>`)
    .join("");
  placePins();
}
function placePins() {
  const box = $("#pins");
  if (!box) return;
  box.style.setProperty("--pin-scale", pinScale());
  for (const el of box.children) {
    const [x, y] = toScreen(lngX(+el.dataset.lng), latY(+el.dataset.lat));
    el.style.transform = `translate(${x}px, ${y}px)`;
  }
}
function resizeCanvas() {
  const [w, h] = viewSize();
  const dpr = devicePixelRatio || 1;
  for (const c of [$("#map-grid"), $("#map-tiles")]) {
    if (!c) continue;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
/* Tiles: asked for in small batches, kept as decoded images for the session. */
const tiles = { images: new Map(), failed: new Set(), wanted: new Map(), busy: false };
function drawTiles() {
  const c = $("#map-tiles");
  if (!c) return;
  const ctx = c.getContext("2d");
  const [w, h] = viewSize();
  ctx.clearRect(0, 0, w, h);
  tiles.wanted.clear();
  if (!state.mapSettings?.online) return;
  const z = Math.max(0, Math.min(19, Math.round(map.z)));
  const n = 2 ** z;
  const size = worldSize() / n;
  const [left, top] = fromScreen(0, 0);
  const [right, bottom] = fromScreen(w, h);
  for (let y = Math.max(0, Math.floor(top * n)); y <= Math.min(n - 1, Math.floor(bottom * n)); y++) {
    for (let x = Math.max(0, Math.floor(left * n)); x <= Math.min(n - 1, Math.floor(right * n)); x++) {
      const key = `${z}/${x}/${y}`;
      const [sx, sy] = toScreen(x / n, y / n);
      const image = tiles.images.get(key);
      if (image) {
        ctx.drawImage(image, Math.floor(sx), Math.floor(sy), Math.ceil(size) + 1, Math.ceil(size) + 1);
        continue;
      }
      // Until a tile arrives, stretch the one it sits inside, so the map is never blank.
      for (let up = 1; up <= 4 && z - up >= 0; up++) {
        const parent = tiles.images.get(`${z - up}/${x >> up}/${y >> up}`);
        if (parent) {
          const part = 256 / 2 ** up;
          ctx.drawImage(parent, (x % 2 ** up) * part, (y % 2 ** up) * part, part, part, Math.floor(sx), Math.floor(sy), Math.ceil(size) + 1, Math.ceil(size) + 1);
          break;
        }
      }
      if (!tiles.failed.has(key)) tiles.wanted.set(key, [z, x, y]);
    }
  }
  loadTiles();
}
async function loadTiles() {
  if (tiles.busy || !tiles.wanted.size) return;
  tiles.busy = true;
  try {
    const batch = [...tiles.wanted.values()].slice(0, 16);
    const { tiles: got } = await api("/tiles", "POST", { tiles: batch });
    await Promise.all(Object.entries(got).map(([key, src]) => {
      if (!src) return tiles.failed.add(key);
      return new Promise((done) => {
        const image = new Image();
        image.onload = () => (tiles.images.set(key, image), done());
        image.onerror = () => (tiles.failed.add(key), done());
        image.src = src;
      });
    }));
    if (tiles.images.size > 800) for (const key of [...tiles.images.keys()].slice(0, 200)) tiles.images.delete(key);
  } catch {
    tiles.wanted.clear();
  } finally {
    tiles.busy = false;
  }
  if ($("#map-tiles")) draw();
}
const GRID_STEPS = [60, 30, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];
function gridLabel(value, pos, neg) {
  const n = Math.abs(value);
  return `${+n.toFixed(3)}°${value > 0 ? pos : value < 0 ? neg : ""}`;
}
function draw() {
  const c = $("#map-grid");
  if (!c) return;
  const ctx = c.getContext("2d");
  const [w, h] = viewSize();
  ctx.clearRect(0, 0, w, h);
  drawTiles();
  $("#map-stage")?.classList.toggle("is-online", !!state.mapSettings?.online);
  const degPx = worldSize() / 360;
  const step = GRID_STEPS.find((s) => s * degPx < 180 && s * degPx >= 70) || GRID_STEPS[GRID_STEPS.length - 1];
  ctx.font = "11px Roboto, sans-serif";
  ctx.lineWidth = 1;
  const line = (x0, y0, x1, y1, strong) => {
    ctx.strokeStyle = strong ? "rgba(165,216,255,.3)" : "rgba(165,216,255,.1)";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  ctx.fillStyle = "rgba(205,226,247,.72)";
  const [left, top] = fromScreen(0, 0);
  const [right, bottom] = fromScreen(w, h);
  const lngs = [xLng(Math.max(0, left)), xLng(Math.min(1, right))];
  for (let v = Math.ceil(lngs[0] / step) * step; v <= lngs[1] + 1e-9; v += step) {
    const [x] = toScreen(lngX(v), 0);
    line(x, 0, x, h, Math.abs(v) < 1e-9);
    ctx.fillText(gridLabel(v, "E", "W"), x + 4, h - 8);
  }
  const lats = [yLat(Math.min(1, bottom)), yLat(Math.max(0, top))];
  const latStep = step;
  for (let v = Math.ceil(lats[0] / latStep) * latStep; v <= lats[1] + 1e-9; v += latStep) {
    const [, y] = toScreen(0, latY(v));
    line(0, y, w, y, Math.abs(v) < 1e-9);
    ctx.fillText(gridLabel(v, "N", "S"), 8, y - 4);
  }
  renderPinsOnce();
}
let pinsDirty = true;
function renderPinsOnce() {
  if (pinsDirty) {
    pinsDirty = false;
    renderPins();
  } else placePins();
}
function zoomAt(px, py, delta) {
  const [x, y] = fromScreen(px, py);
  map.z += delta;
  clampView();
  const [sx, sy] = toScreen(x, y);
  const size = worldSize();
  map.cx += (sx - px) / size;
  map.cy += (sy - py) / size;
  clampView();
  draw();
}
let resizeObserver = null;
function stopMap() {
  resizeObserver?.disconnect();
  resizeObserver = null;
}
function showResults() {
  const box = $("#map-results");
  if (!box) return;
  const r = state.searchResults;
  if (!r) return (box.hidden = true);
  box.hidden = false;
  const people = (r.contacts || []).map((c) => `<button class="map-result" data-contact-pin="${esc(c.group)}">${markerSvg(c.marker, 17)}<span class="grow"><span class="primary">${esc(c.name)}</span><span class="secondary">${esc(c.text)}</span></span></button>`).join("");
  const local = r.local.map((p, i) => `<button class="map-result" data-result="local" data-i="${i}">${markerSvg(p.marker, 17)}<span class="grow"><span class="primary">${esc(p.name)}</span><span class="secondary">${esc(p.address || "Your place")}</span></span></button>`).join("");
  const online = (r.online || []).map((x, i) => `<button class="map-result" data-result="online" data-i="${i}">${icon("map")}<span class="grow"><span class="primary">${esc(x.name)}</span><span class="secondary">${esc(x.display)}</span></span></button>`).join("");
  const offer = state.mapSettings?.online && !r.online ? `<button class="ae-btn ae-btn--sm" data-act="search-online">${r.busy ? "Searching…" : "Search OpenStreetMap"}</button>` : "";
  box.innerHTML = `${local}${people}${local || people || r.online ? "" : '<p class="meta">None of your places match.</p>'}${online}${r.online && !r.online.length ? '<p class="meta">Nothing found online.</p>' : ""}${r.online?.length ? `<p class="meta">${esc(state.mapSettings.attribution)}</p>` : ""}${offer}`;
}
function runLocalSearch(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) {
    state.searchResults = null;
    return showResults();
  }
  state.searchResults = {
    q,
    local: state.places.filter((p) => words.every((w) => `${p.name} ${p.address} ${p.category} ${p.tags.join(" ")}`.toLowerCase().includes(w))).slice(0, 8),
    contacts: state.contacts.items.filter((c) => c.latitude !== null && words.every((w) => `${c.name} ${c.text}`.toLowerCase().includes(w))).slice(0, 6),
  };
  showResults();
}
function bindMap() {
  const stage = $("#map-stage");
  pinsDirty = true;
  $("#map-q")?.addEventListener("input", (event) => runLocalSearch(event.target.value));
  $("#map-search")?.addEventListener("submit", (event) => event.preventDefault());
  const pointers = new Map();
  let moved = 0;
  let pinch = 0;
  const local = (e) => {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(...local(e), -Math.sign(e.deltaY) * 0.45);
  }, { passive: false });
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest("[data-pin], [data-contact-pin]")) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    moved = 0;
    pinch = 0;
  });
  stage.addEventListener("pointermove", (e) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const now = local(e);
    pointers.set(e.pointerId, now);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.log2(dist / pinch));
      pinch = dist;
      moved += 10;
      return;
    }
    moved += Math.abs(now[0] - last[0]) + Math.abs(now[1] - last[1]);
    const size = worldSize();
    map.cx -= (now[0] - last[0]) / size;
    map.cy -= (now[1] - last[1]) / size;
    clampView();
    draw();
  });
  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    pinch = 0;
    if (e.type === "pointerup" && moved < 5 && state.picking) {
      const [x, y] = fromScreen(...local(e));
      finishPick(+yLat(Math.max(0, Math.min(1, y))).toFixed(6), +xLng(Math.max(0, Math.min(1, x))).toFixed(6));
    }
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("keydown", (e) => {
    const size = worldSize();
    const stepPx = 80;
    const [w, h] = viewSize();
    if (e.key === "ArrowLeft") map.cx -= stepPx / size;
    else if (e.key === "ArrowRight") map.cx += stepPx / size;
    else if (e.key === "ArrowUp") map.cy -= stepPx / size;
    else if (e.key === "ArrowDown") map.cy += stepPx / size;
    else if (e.key === "+" || e.key === "=") return zoomAt(w / 2, h / 2, 0.6);
    else if (e.key === "-") return zoomAt(w / 2, h / 2, -0.6);
    else return;
    e.preventDefault();
    clampView();
    draw();
  });
  stopMap();
  resizeObserver = new ResizeObserver(() => {
    resizeCanvas();
    clampView();
    draw();
  });
  resizeObserver.observe(stage);
}
async function finishPick(latitude, longitude) {
  if (state.picking.contact) {
    const id = state.picking.contact;
    state.picking = null;
    render();
    try {
      await api(`/contacts/${id}/location`, "PUT", { latitude, longitude });
      toast("Location saved", "good");
    } catch (error) {
      toast(error.message, "danger");
    }
    return loadContacts();
  }
  const draft = { ...state.picking, latitude, longitude };
  state.picking = null;
  render();
  openEditor(draft);
}

function viewSettings(sheet) {
  const s = state.mapSettings;
  const size = s.cached_bytes ?? 0;
  sheet.innerHTML = `<div class="page"><header class="head"><div><p class="eyebrow">Atlas</p><h1 class="display" data-heading tabindex="-1">Settings</h1></div></header>
    <section class="settings-block"><label class="check"><input type="checkbox" id="st-online" ${s.online ? "checked" : ""}><span>Use the online map and place search</span></label>
      <p class="meta">Only the map area being viewed and the words you search for are sent to these services. Your places, contacts and notes are never sent. Without the network, areas you have already viewed remain available.</p>
      <div class="ae-field"><label class="ae-label" for="st-tiles">Map images</label><input class="ae-input" id="st-tiles" value="${esc(s.tile_url)}" maxlength="500"></div>
      <div class="ae-field"><label class="ae-label" for="st-geo">Place search</label><input class="ae-input" id="st-geo" value="${esc(s.geocoder_url)}" maxlength="500"></div>
      <p class="meta">You can point these at your own servers. ${(size / 1048576).toFixed(1)} MB of map images are stored for offline use.</p>
      <p class="form-error" id="st-error" role="alert" hidden></p><button class="ae-btn ae-btn--primary" data-act="save-settings">Save</button></section>
    <section class="settings-block"><label class="check"><input type="checkbox" id="st-geocoding" ${state.contacts.geocoding ? "checked" : ""}><span>Find locations for Meridian addresses</span></label>
      <p class="meta">Only the street, postal code, city, region and country are sent to the place search above, one address at a time. Names, labels and notes are never sent, and it is not said whose address it is.</p></section></div>`;
  $("#st-geocoding").addEventListener("change", async (e) => {
    await api("/contacts/settings", "PUT", { geocoding: e.target.checked }).catch((err) => toast(err.message, "danger"));
    loadContacts();
  });
}

/* ── Library ── */
const FILTERS = [["all", "All"], ["favorites", "Favorites"], ["want", "Want to visit"], ["inactive", "Historical"]];
async function loadLibrary() {
  const f = state.filter;
  const box = $("#place-list");
  if (f.category && f.category === MERIDIAN_ID()) {
    const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    const items = state.contacts.items.filter((c) => words.every((w) => `${c.name} ${c.text}`.toLowerCase().includes(w)));
    if (!box) return;
    $("#library-meta").textContent = `${items.length} ${items.length === 1 ? "address" : "addresses"} from Meridian`;
    box.innerHTML = state.contacts.availability !== "available"
      ? `<div class="empty"><h3>Not available right now</h3><p>${esc(contactNote(state.contacts.availability))}</p></div>`
      : items.length ? items.map(contactCard).join("") : `<div class="empty"><h3>Nothing matches</h3><p>Addresses you add in Meridian appear here by themselves.</p></div>`;
    return;
  }
  const params = new URLSearchParams({ q: f.q, view_name: f.view, category: f.category });
  const { items } = await api("/places?" + params);
  if (!box) return;
  $("#library-meta").textContent = `${items.length} ${items.length === 1 ? "place" : "places"}`;
  box.innerHTML = items.length
    ? items.map(placeCard).join("")
    : `<div class="empty"><h3>${f.q || f.view !== "all" || f.category ? "Nothing matches" : "No places yet"}</h3><p>${f.q || f.view !== "all" || f.category ? "Try another search or filter." : "Add a place by name, and give it a location whenever you know it."}</p></div>`;
}
function placeCard(p) {
  const where = p.address || (hasLocation(p) ? coords(p) : "No location yet");
  const facts = [p.category, ...p.tags].filter(Boolean).join(" · ");
  return `<button class="place-card" data-place="${esc(p.id)}">${markerSvg(p.marker, 26)}<span class="grow"><span class="primary">${esc(p.name)}${p.inactive ? ' <span class="tag">Historical</span>' : ""}</span><span class="secondary">${esc(where)}</span>${facts ? `<span class="secondary">${esc(facts)}</span>` : ""}</span></button>`;
}
function contactCard(c) {
  const facts = [cap(c.address_label), !c.current && "Former address", c.latitude === null && "No location yet"].filter(Boolean).join(" · ");
  const open = c.latitude !== null ? `data-contact-pin="${esc(c.group)}"` : `data-act="contacts-panel"`;
  return `<button class="place-card" ${open}>${markerSvg(c.marker, 26)}<span class="grow"><span class="primary">${esc(c.name)}</span><span class="secondary">${esc(c.text)}</span>${facts ? `<span class="secondary">${esc(facts)}</span>` : ""}</span></button>`;
}
function viewLibrary(sheet) {
  const f = state.filter;
  sheet.innerHTML = `<div class="page"><header class="head"><div><p class="eyebrow">Library</p><h1 class="display" data-heading tabindex="-1">Places</h1><p class="meta" id="library-meta"></p></div>
      <button class="ae-btn ae-btn--primary" data-act="new-place">${icon("plus")}<span>Add place</span></button></header>
    <div class="library-tools">
      <label class="search">${icon("search")}<input class="ae-input" id="lib-q" type="search" placeholder="Search your places" aria-label="Search your places" value="${esc(f.q)}" maxlength="200"></label>
      <div class="segments" role="group" aria-label="Show">${FILTERS.map(([k, l]) => `<button class="segment" data-filter="${k}" aria-pressed="${f.view === k}">${l}</button>`).join("")}</div>
      <div id="lib-category" class="lib-combo"></div>
    </div>
    <div class="place-list" id="place-list"></div></div>`;
  let timer;
  $("#lib-q").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.filter.q = e.target.value;
      loadLibrary().catch((err) => toast(err.message, "danger"));
    }, 200);
  });
  mountCategoryCombo($("#lib-category"), { value: f.category, mode: "filter", onChange: (id) => {
    state.filter.category = id;
    loadLibrary().catch((err) => toast(err.message, "danger"));
  } });
  loadLibrary().catch((err) => toast(err.message, "danger"));
}

/* ── Categories ── */
function viewCategories(sheet) {
  const card = (c) => `<div class="place-card is-static category-card" data-category-card="${esc(c.id)}">${markerSvg(c, 30)}<span class="grow"><span class="primary">${esc(c.name)}${c.system ? ` <span class="tag">${icon("lock")} Managed by Atlas</span>` : ""}</span><span class="secondary">${esc(c.description || "No description")}</span>${c.system ? `<span class="secondary">${state.contacts.items.length} ${state.contacts.items.length === 1 ? "address" : "addresses"} from your contacts</span>` : `<span class="secondary">${c.places} ${c.places === 1 ? "place" : "places"}</span>`}</span>${c.system ? "" : `<button class="ae-btn ae-btn--sm" data-cat-edit="${esc(c.id)}">${icon("edit")}<span>Edit</span></button><button class="ae-btn ae-btn--sm ae-btn--quiet is-danger" data-cat-delete="${esc(c.id)}">Delete</button>`}</div>`;
  sheet.innerHTML = `<div class="page"><header class="head"><div><p class="eyebrow">Atlas</p><h1 class="display" data-heading tabindex="-1">Categories</h1><p class="meta">Each category gives its places a color and an icon. A place can still have its own.</p></div>
      <button class="ae-btn ae-btn--primary" data-act="new-category">${icon("plus")}<span>New category</span></button></header>
    <div class="place-list">${state.categories.map(card).join("")}</div></div>`;
}
const SWATCHES = ["#e5484d", "#f97316", "#f5b301", "#22a55b", "#0ea5a4", "#06b6d4", "#2f80ed", "#4285d4", "#7c5cd6", "#a855f7", "#e0457b", "#ec4899", "#c48663", "#64748b"];
let fieldSerial = 0;
/* Icon and color pickers, shared by categories, places and contact markers. A null value means
   "inherit", and only `required` pickers (a category's own look) must always hold one. */
function mountMarkerFields(root, { base, value, required = false, onChange }) {
  const v = { color: value.color ?? null, icon: value.icon ?? null };
  const id = ++fieldSerial;
  let query = "";
  root.innerHTML = `<div class="ae-field"><label class="ae-label" for="mk-q-${id}">Icon</label><input class="ae-input" id="mk-q-${id}" data-icon-search type="search" placeholder="Search icons: coffee, tree, house…" autocomplete="off"><div class="icon-grid" role="group" aria-label="Icons"></div></div>
    <div class="ae-field"><span class="ae-label">Color</span><div class="swatches" role="group" aria-label="Preset colors">${SWATCHES.map((c) => `<button type="button" class="swatch" data-swatch="${c}" style="--c:${c}" aria-label="${c}"></button>`).join("")}</div>
      <div class="hex-row"><input type="color" class="color-well" aria-label="Pick any color"><input class="ae-input hex-input" data-hex maxlength="7" placeholder="#4285D4" aria-label="Color as a HEX value" autocomplete="off"></div>
      <p class="meta contrast-note" hidden>White icons are hard to see on a color this light.</p></div>`;
  const grid = $(".icon-grid", root);
  const effective = () => ({ color: v.color || base().color, icon: v.icon || base().icon });
  const paintIcons = () => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const names = Object.keys(LUCIDE.icons).filter((n) => words.every((w) => `${n} ${LUCIDE.icons[n].t}`.toLowerCase().includes(w)));
    grid.innerHTML = names.length ? names.slice(0, 84).map((n) => `<button type="button" class="icon-choice" data-choice="${n}" aria-pressed="${effective().icon === n}" title="${n.replaceAll("-", " ")}" aria-label="${n.replaceAll("-", " ")}">${lucideIcon(n, 19)}</button>`).join("") : `<p class="meta">No icon matches that word.</p>`;
  };
  const paintColor = () => {
    const c = effective().color;
    $$(".swatch", root).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.swatch === c)));
    $(".color-well", root).value = c;
    const hex = $("[data-hex]", root);
    if (document.activeElement !== hex) hex.value = c.toUpperCase();
    $(".contrast-note", root).hidden = luminance(c) < 0.62;
  };
  const changed = () => (paintIcons(), paintColor(), onChange({ ...v }));
  $("[data-icon-search]", root).addEventListener("input", (e) => ((query = e.target.value), paintIcons()));
  grid.addEventListener("click", (e) => {
    const b = e.target.closest("[data-choice]");
    if (!b) return;
    v.icon = !required && v.icon === b.dataset.choice ? null : b.dataset.choice;
    changed();
  });
  $(".swatches", root).addEventListener("click", (e) => {
    const b = e.target.closest("[data-swatch]");
    if (!b) return;
    v.color = !required && v.color === b.dataset.swatch ? null : b.dataset.swatch;
    changed();
  });
  $(".color-well", root).addEventListener("input", (e) => ((v.color = e.target.value.toLowerCase()), changed()));
  $("[data-hex]", root).addEventListener("input", (e) => {
    let text = e.target.value.trim().toLowerCase();
    if (/^#?[0-9a-f]{3}$/.test(text)) text = "#" + [...text.replace("#", "")].map((x) => x + x).join("");
    else if (/^[0-9a-f]{6}$/.test(text)) text = "#" + text;
    const ok = /^#[0-9a-f]{6}$/.test(text);
    e.target.setAttribute("aria-invalid", String(!ok && !!text));
    if (ok) (v.color = text), changed();
  });
  $("[data-hex]", root).addEventListener("blur", paintColor);
  paintIcons();
  paintColor();
  return {
    get: () => ({ ...v }),
    set: (next) => ((v.color = next.color ?? null), (v.icon = next.icon ?? null), changed()),
    refresh: () => (paintIcons(), paintColor()),
  };
}
/* The category selector: searchable, showing each category's own marker. */
function mountCategoryCombo(root, { value, mode, onChange, onCreate, exclude }) {
  let current = value || "";
  let query = "";
  const options = () => {
    const out = [];
    if (mode === "filter") out.push({ id: "", name: "All categories", marker: null });
    else out.push({ id: "", name: "No category", marker: DEFAULT_MARKER });
    for (const c of state.categories.filter((x) => !x.system && x.id !== exclude)) out.push({ id: c.id, name: c.name, marker: c, note: c.description });
    if (mode === "filter") out.push({ id: "none", name: "No category", marker: DEFAULT_MARKER });
    const m = state.categories.find((x) => x.system === "meridian");
    if (m && mode !== "move") out.push({ id: m.id, name: m.name, marker: m, note: mode === "filter" ? "Addresses of your contacts" : "Filled automatically from your contacts", disabled: mode !== "filter" });
    return out;
  };
  const faceOf = () => options().find((o) => o.id === current) || options()[0];
  const paintList = () => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = options().filter((o) => words.every((w) => o.name.toLowerCase().includes(w)));
    $(".combo-list", root).innerHTML = list.length ? list.map((o) => `<button type="button" class="combo-option" role="option" data-combo="${esc(o.id)}" aria-selected="${o.id === current}" ${o.disabled ? 'aria-disabled="true" disabled' : ""}>${o.marker ? markerSvg(o.marker, 20) : `<span class="combo-all">${lucideIcon("map", 17)}</span>`}<span class="grow"><span class="primary">${esc(o.name)}</span>${o.note ? `<span class="secondary">${esc(o.note)}</span>` : ""}</span>${o.disabled ? icon("lock") : ""}</button>`).join("") : `<p class="meta">No category with that name.</p>`;
  };
  const paint = () => {
    const face = faceOf();
    root.innerHTML = `<div class="combo"><button type="button" class="combo-button ae-input" aria-haspopup="listbox" aria-expanded="false">${face.marker ? markerSvg(face.marker, 20) : `<span class="combo-all">${lucideIcon("map", 17)}</span>`}<span class="grow">${esc(face.name)}</span>${icon("chevron")}</button>
      <div class="combo-panel ae-glass" hidden><input class="ae-input combo-search" type="search" placeholder="Search categories" aria-label="Search categories" autocomplete="off"><div class="combo-list" role="listbox" aria-label="Categories"></div>${onCreate ? `<button type="button" class="combo-create" data-combo-create>${icon("plus")}<span>Create category</span></button>` : ""}</div></div>`;
    const combo = $(".combo", root);
    const panel = $(".combo-panel", root);
    const button = $(".combo-button", root);
    const close = (focus) => {
      panel.hidden = true;
      combo.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
      if (focus) button.focus();
    };
    combo._close = close;
    button.addEventListener("click", () => {
      if (!panel.hidden) return close();
      panel.hidden = false;
      combo.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
      query = "";
      $(".combo-search", root).value = "";
      paintList();
      $(".combo-search", root).focus();
    });
    $(".combo-search", root).addEventListener("input", (e) => ((query = e.target.value), paintList()));
    panel.addEventListener("keydown", (e) => {
      const items = $$(".combo-option:not([disabled])", panel);
      const at = items.indexOf(document.activeElement);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        items[Math.min(at + 1, items.length - 1)]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        (at <= 0 ? $(".combo-search", root) : items[at - 1]).focus();
      }
    });
    panel.addEventListener("click", (e) => {
      const opt = e.target.closest("[data-combo]");
      if (opt && !opt.disabled) {
        current = opt.dataset.combo;
        paint();
        onChange(current);
        $(".combo-button", root).focus();
      } else if (e.target.closest("[data-combo-create]")) {
        close();
        onCreate((created) => {
          current = created.id;
          paint();
          onChange(current);
        });
      }
    });
  };
  paint();
  return { set: (id) => ((current = id || ""), paint()), repaint: paint };
}
document.addEventListener("pointerdown", (e) => $$(".combo.is-open").forEach((c) => !c.contains(e.target) && c._close()));
const previewBlock = (marker) => `<div class="marker-preview" aria-hidden="true"><div class="preview-tile is-dark">${markerSvg(marker, 34)}</div><div class="preview-tile is-light">${markerSvg(marker, 34)}</div></div>`;
function openCategoryDialog(cat, saved) {
  const d = $("#subdialog");
  const draft = { name: cat?.name || "", description: cat?.description || "", color: cat?.color || "#2f80ed", icon: cat?.icon || "map-pin" };
  d.innerHTML = `<div class="ae-dialog-head"><h2>${cat ? "Edit category" : "New category"}</h2></div>
    <div class="ae-dialog-body place-form"><div id="cat-preview"></div>
      <div class="ae-field"><label class="ae-label" for="cat-name">Name</label><input class="ae-input" id="cat-name" maxlength="40" value="${esc(draft.name)}"></div>
      <div id="cat-fields" class="marker-fields"></div>
      <div class="ae-field"><label class="ae-label" for="cat-description">Description (optional)</label><input class="ae-input" id="cat-description" maxlength="200" value="${esc(draft.description)}"></div>
      <p class="form-error" id="cat-error" role="alert" hidden></p></div>
    <div class="ae-dialog-foot"><button class="ae-btn" id="cat-cancel">Cancel</button><button class="ae-btn ae-btn--primary" id="cat-save">Save</button></div>`;
  const preview = () => ($("#cat-preview", d).innerHTML = previewBlock(draft));
  preview();
  mountMarkerFields($("#cat-fields", d), { base: () => draft, value: { color: draft.color, icon: draft.icon }, required: true, onChange: (v) => ((draft.color = v.color), (draft.icon = v.icon), preview()) });
  $("#cat-cancel", d).onclick = () => d.close();
  $("#cat-save", d).onclick = async () => {
    const err = $("#cat-error", d);
    err.hidden = true;
    try {
      const body = { name: $("#cat-name", d).value.trim(), description: $("#cat-description", d).value.trim(), color: draft.color, icon: draft.icon };
      if (!body.name) throw Error("Give the category a name.");
      const out = await api(cat ? `/categories/${cat.id}` : "/categories", cat ? "PUT" : "POST", body);
      d.close();
      state.categories = (await api("/state")).categories;
      saved?.(out);
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
    }
  };
  d.showModal();
  $("#cat-name", d).focus();
}
function openDeleteCategory(cat) {
  const d = $("#subdialog");
  let target = "";
  d.innerHTML = `<div class="ae-dialog-head"><h2>Delete ${esc(cat.name)}?</h2></div>
    <div class="ae-dialog-body place-form"><p>${cat.places ? `${cat.places} ${cat.places === 1 ? "place uses" : "places use"} this category. ${cat.places === 1 ? "It" : "They"} will not be deleted, and any individual marker stays as it is.` : "No place uses this category."}</p>
      ${cat.places ? `<div class="ae-field"><span class="ae-label">Move ${cat.places === 1 ? "it" : "them"} to</span><div id="del-combo"></div></div>` : ""}
      <p class="form-error" id="del-error" role="alert" hidden></p></div>
    <div class="ae-dialog-foot"><button class="ae-btn" id="del-cancel">Cancel</button><button class="ae-btn ae-btn--danger" id="del-ok">Delete category</button></div>`;
  if (cat.places) mountCategoryCombo($("#del-combo", d), { value: "", mode: "move", exclude: cat.id, onChange: (id) => (target = id) });
  $("#del-cancel", d).onclick = () => d.close();
  $("#del-ok", d).onclick = async () => {
    try {
      await api(`/categories/${cat.id}${target ? "?move_to=" + encodeURIComponent(target) : ""}`, "DELETE");
      d.close();
      toast("Category deleted");
      state.filters.hidden_categories = state.filters.hidden_categories.filter((x) => x !== cat.id);
      saveFilters();
      await go("categories");
    } catch (error) {
      $("#del-error", d).textContent = error.message;
      $("#del-error", d).hidden = false;
    }
  };
  d.showModal();
}

/* ── Trash ── */
async function viewTrash(sheet) {
  const { items } = await api("/trash");
  sheet.innerHTML = `<div class="page"><header class="head"><div><p class="eyebrow">Atlas</p><h1 class="display" data-heading tabindex="-1">Trash</h1><p class="meta">${items.length} ${items.length === 1 ? "place" : "places"}</p></div></header>
    <div class="place-list">${items.length ? items.map((p) => `<div class="place-card is-static">${markerSvg(p.marker, 26)}<span class="grow"><span class="primary">${esc(p.name)}</span><span class="secondary">${esc(p.address || (hasLocation(p) ? coords(p) : "No location yet"))}</span></span><button class="ae-btn ae-btn--sm" data-restore="${esc(p.id)}">${icon("restore")}<span>Restore</span></button><button class="ae-btn ae-btn--sm ae-btn--quiet is-danger" data-purge="${esc(p.id)}">Delete for good</button></div>`).join("") : `<div class="empty"><h3>Trash is empty</h3><p>Places you move to Trash wait here until you restore them or delete them for good.</p></div>`}</div></div>`;
}

/* ── One place ── */
const LINKED_KIND = { "chronos:event": "Event in Chronos", "meridian:interaction": "Interaction in Meridian", "meridian:person": "Person in Meridian", "mnemosyne:note": "Note in Mnemosyne", "mnemosyne:task": "Task in Mnemosyne", "mnemosyne:project": "Project in Mnemosyne", "argus:photo": "Photo in Argus" };
const LINKED_ICON = { chronos: "calendar", meridian: "people", mnemosyne: "note" };
function closeDetail() {
  state.selected = null;
  state.selectedGroup = null;
  pinsDirty = true;
  const box = $("#detail");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
  if ($("#map-stage")) draw();
}
async function openDetail(id, { center = false } = {}) {
  const p = await api(`/places/${id}`);
  state.selected = p;
  state.selectedGroup = null;
  pinsDirty = true;
  const box = $("#detail");
  const states = [p.favorite && "Favorite", p.want_to_visit && "Want to visit", p.inactive && "Historical"].filter(Boolean);
  box.innerHTML = `<div class="detail-head">${markerSvg(p.marker, 30)}<h2 class="detail-title" tabindex="-1">${esc(p.name)}</h2><button class="map-tool" data-act="close-detail" aria-label="Close details">${icon("x")}</button></div>
    ${states.length ? `<p class="detail-states">${states.map((s) => `<span class="tag">${s}</span>`).join("")}</p>` : ""}
    ${p.description ? `<p class="detail-text">${esc(p.description)}</p>` : ""}
    <dl class="facts-list">
      ${p.category ? `<div><dt>Category</dt><dd>${esc(p.category)}</dd></div>` : ""}
      ${p.address ? `<div><dt>Address</dt><dd>${esc(p.address)}</dd></div>` : ""}
      <div><dt>Location</dt><dd>${hasLocation(p) ? esc(coords(p)) : "Not set yet"}</dd></div>
      ${p.external_ref ? `<div><dt>Source</dt><dd>OpenStreetMap (${esc(p.external_ref.slice(4))}), saved as your own copy</dd></div>` : ""}
      ${p.tags.length ? `<div><dt>Tags</dt><dd>${esc(p.tags.join(", "))}</dd></div>` : ""}
    </dl>
    <div class="detail-actions"><button class="ae-btn" data-act="edit-place">${icon("edit")}<span>Edit</span></button>${hasLocation(p) ? `<button class="ae-btn" data-act="show-on-map">${icon("map")}<span>Show on map</span></button>` : ""}<button class="ae-btn ae-btn--quiet is-danger" data-act="trash-place">${icon("trash")}<span>Move to Trash</span></button></div>
    <div id="linked-from" data-place="${esc(p.id)}" hidden></div>`;
  box.hidden = false;
  $(".detail-title", box).focus({ preventScroll: true });
  if ($("#map-stage")) {
    if (center && hasLocation(p)) {
      map.cx = lngX(p.longitude);
      map.cy = latY(p.latitude);
      map.z = Math.max(map.z, 12);
    }
    draw();
  }
  loadLinkedFrom(p.id);
}
/* A Meridian pin: everything shown is read live from Meridian, and belongs to it. */
const KIND_LABEL = { person: "Person", organization: "Organization", group: "Group" };
function openContactDetail(key, { center = false } = {}) {
  state.selected = null;
  state.selectedGroup = key;
  pinsDirty = true;
  refreshContactDetail();
  const box = $("#detail");
  if (box.hidden) return;
  box.hidden = false;
  $(".detail-title", box)?.focus({ preventScroll: true });
  if ($("#map-stage")) {
    const first = state.contacts.items.find((c) => c.group === key);
    if (center && first) {
      map.cx = lngX(first.longitude);
      map.cy = latY(first.latitude);
      map.z = Math.max(map.z, 13);
    }
    draw();
  }
}
function refreshContactDetail() {
  const box = $("#detail");
  const members = state.contacts.items.filter((c) => c.group === state.selectedGroup);
  if (!members.length) {
    if (state.selectedGroup) closeDetail();
    return;
  }
  const canOpen = state.apps.some((a) => a.id === "meridian");
  const one = members.length === 1;
  const card = (c) => `<article class="contact-card">
      <div class="contact-head">${markerSvg(c.marker, 26)}<span class="grow"><span class="primary">${esc(c.name)}</span><span class="secondary">${esc([KIND_LABEL[c.kind], cap(c.address_label)].filter(Boolean).join(" · "))}</span></span></div>
      <p class="detail-text">${esc(c.text)}</p>
      <p class="detail-states">${[!c.current && "Former address", c.primary && "Primary", c.approximate && "Approximate location", c.source === "manual" && "Location set by you"].filter(Boolean).map((t) => `<span class="tag">${t}</span>`).join("")}</p>
      <div class="detail-actions">${canOpen ? `<button class="ae-btn ae-btn--primary ae-btn--sm" data-module="meridian" data-path="${esc(c.open_path)}">${icon("external")}<span>Open in Meridian</span></button>` : ""}<button class="ae-btn ae-btn--sm" data-contact-action="customize" data-id="${esc(c.id)}">${lucideIcon("palette", 15)}<span>Customize marker</span></button><button class="ae-btn ae-btn--sm" data-contact-action="pick" data-id="${esc(c.id)}">${lucideIcon("locate", 15)}<span>Adjust location</span></button></div>
    </article>`;
  box.innerHTML = `<div class="detail-head">${markerSvg(one ? members[0].marker : MERIDIAN_MARKER, 30)}<h2 class="detail-title" tabindex="-1">${one ? esc(members[0].name) : `${members.length} contacts here`}</h2><button class="map-tool" data-act="close-detail" aria-label="Close details">${icon("x")}</button></div>
    <p class="source-note">${icon("lock")}<span>From Meridian. Atlas only shows it, and only its marker can be changed here.</span></p>
    <div class="contact-list">${members.map(card).join("")}</div>`;
  box.hidden = false;
}
function openContactMarker(c) {
  const d = $("#subdialog");
  const multiple = c.siblings > 0;
  let scope = multiple && c.address_override ? "address" : "contact";
  const stored = () => (scope === "address" ? c.address_override : c.contact_override) || { color: null, icon: null };
  const below = () => {
    const contact = scope === "address" ? c.contact_override : null;
    return { color: contact?.color || MERIDIAN_MARKER.color, icon: contact?.icon || MERIDIAN_MARKER.icon };
  };
  let value = { ...stored() };
  const shown = () => ({ color: value.color || below().color, icon: value.icon || below().icon });
  d.innerHTML = `<div class="ae-dialog-head"><h2>Marker for ${esc(c.name)}</h2></div>
    <div class="ae-dialog-body place-form"><div id="cm-preview"></div>
      ${multiple ? `<div class="scope-row" role="radiogroup" aria-label="Apply to"><label class="check"><input type="radio" name="cm-scope" value="contact" ${scope === "contact" ? "checked" : ""}><span>All addresses of this contact</span></label><label class="check"><input type="radio" name="cm-scope" value="address" ${scope === "address" ? "checked" : ""}><span>Only ${esc(cap(c.address_label) || "this address")}</span></label></div>` : ""}
      <div id="cm-fields" class="marker-fields"></div><p class="meta">This changes how the marker looks in Atlas. The contact and the address stay as they are in Meridian.</p>
      <p class="form-error" id="cm-error" role="alert" hidden></p></div>
    <div class="ae-dialog-foot"><button class="ae-btn ae-btn--quiet" id="cm-reset">Reset to Meridian defaults</button><button class="ae-btn" id="cm-cancel">Cancel</button><button class="ae-btn ae-btn--primary" id="cm-save">Save</button></div>`;
  const preview = () => ($("#cm-preview", d).innerHTML = previewBlock(shown()));
  preview();
  const fields = mountMarkerFields($("#cm-fields", d), { base: below, value, onChange: (v) => ((value = v), preview()) });
  $$('[name="cm-scope"]', d).forEach((r) => r.addEventListener("change", () => {
    scope = r.value;
    fields.set(stored());
  }));
  const write = async (body) => {
    try {
      await api("/contacts/markers", "PUT", { scope, source: scope === "address" ? c.id : c.resource, ...body });
      d.close();
      await loadContacts();
    } catch (error) {
      $("#cm-error", d).textContent = error.message;
      $("#cm-error", d).hidden = false;
    }
  };
  $("#cm-cancel", d).onclick = () => d.close();
  $("#cm-save", d).onclick = () => write(value);
  $("#cm-reset", d).onclick = () => write({ color: null, icon: null });
  d.showModal();
}
/* Addresses without a position: consent, and the owner's corrections. */
function openContactsPanel() {
  const d = $("#subdialog");
  d.innerHTML = `<div id="contacts-panel" class="contacts-panel"></div>`;
  renderContactsPanel();
  d.showModal();
}
function renderContactsPanel() {
  const panel = $("#contacts-panel");
  if (!panel) return;
  const c = state.contacts;
  const open = c.items.filter((x) => x.latitude === null);
  const reason = { pending: c.working ? "Looking for it…" : "Waiting to be located", ambiguous: "Several possible locations", not_found: "Not found" };
  const row = (x) => `<li class="attention-row" data-attention="${esc(x.id)}">${markerSvg(x.marker, 24)}<div class="grow"><p class="primary">${esc(x.name)}</p><p class="secondary">${esc(x.text)}</p><p class="secondary">${reason[x.status]}${x.current ? "" : " · Former address"}</p>
      ${(x.candidates || []).map((o, i) => `<button class="candidate" data-candidate="${esc(x.id)}" data-i="${i}">${icon("map")}<span>${esc(o.display)}</span></button>`).join("")}
      <div class="detail-actions"><button class="ae-btn ae-btn--sm" data-panel-pick="${esc(x.id)}">${icon("map")}<span>Choose on map</span></button>${c.geocoding && c.online && x.status !== "pending" ? `<button class="ae-btn ae-btn--sm" data-panel-again="${esc(x.id)}">Try again</button>` : ""}</div></div></li>`;
  const consent = c.geocoding ? "" : `<div class="consent-card"><p><strong>Find these addresses automatically?</strong> Atlas would send only the street, postal code, city, region and country to the place search, one address at a time. Names, labels and notes are never sent, and it is not said whose address it is.</p>${c.online ? `<button class="ae-btn ae-btn--primary" id="allow-geocoding">Allow finding addresses</button>` : `<p class="meta">Turn on the online map first, in Settings.</p>`}</div>`;
  panel.innerHTML = `<div class="ae-dialog-head"><h2>Addresses without a location</h2></div>
    <div class="ae-dialog-body place-form">${consent}${open.length ? `<ul class="attention-list">${open.map(row).join("")}</ul>` : `<p class="meta">Every address is on the map.</p>`}</div>
    <div class="ae-dialog-foot"><button class="ae-btn" id="panel-close">Close</button></div>`;
  $("#panel-close", panel).onclick = () => $("#subdialog").close();
  const allow = $("#allow-geocoding", panel);
  if (allow) allow.onclick = async () => {
    await api("/contacts/settings", "PUT", { geocoding: true });
    await loadContacts();
  };
  panel.onclick = async (e) => {
    const cand = e.target.closest("[data-candidate]");
    const pick = e.target.closest("[data-panel-pick]");
    const again = e.target.closest("[data-panel-again]");
    try {
      if (cand) {
        const item = c.items.find((x) => x.id === cand.dataset.candidate).candidates[+cand.dataset.i];
        await api(`/contacts/${cand.dataset.candidate}/location`, "PUT", { latitude: item.latitude, longitude: item.longitude });
        await loadContacts();
      } else if (pick) {
        $("#subdialog").close();
        startContactPick(pick.dataset.panelPick);
      } else if (again) {
        await api(`/contacts/${again.dataset.panelAgain}/locate-again`, "POST");
        await loadContacts();
      }
    } catch (error) {
      toast(error.message, "danger");
    }
  };
}
function startContactPick(id) {
  const c = state.contacts.items.find((x) => x.id === id);
  state.picking = { contact: id, name: c?.name };
  closeDetail();
  state.view = "map";
  render();
}
/* Backlinks standard (architecture/concepts/backlinks.md). */
async function loadLinkedFrom(id) {
  const result = await api(`/places/${id}/linked-from`).catch(() => null);
  const box = $("#linked-from");
  if (!box || box.dataset.place !== id || !result || result.availability !== "available" || !result.items.length) return;
  const rows = result.items.map((x) => {
    const gone = x.availability !== "available";
    const note = x.availability === "deleted" ? "deleted there" : ["forbidden", "not_found", "not_resolvable"].includes(x.availability) ? "not available" : gone ? "not available right now" : "";
    const open = !gone && state.apps.some((a) => a.id === x.module) ? `<button class="map-tool" data-module="${esc(x.module)}" data-path="${esc(x.open_path || "")}" aria-label="Open ${esc(cap(x.module))}" title="Open ${esc(cap(x.module))}">${icon("external")}</button>` : "";
    return `<li class="linked-row${gone ? " is-gone" : ""}">${icon(LINKED_ICON[x.module] || "link")}<span class="grow"><span class="primary">${esc(gone ? "Something linked here" : x.label)}</span><span class="secondary">${esc([LINKED_KIND[`${x.module}:${x.type}`] || `Linked in ${cap(x.module)}`, note].filter(Boolean).join(" · "))}</span></span>${open}</li>`;
  });
  box.innerHTML = `<p class="section-label">Linked from other modules</p><ul class="linked-list">${rows.join("")}</ul><p class="linked-hint">These items belong to their modules.</p>`;
  box.hidden = false;
}

/* ── Editor ── */
function parseLocation(text) {
  const value = text.trim();
  if (!value) return { latitude: null, longitude: null };
  const m = value.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m || Math.abs(+m[1]) > 90 || Math.abs(+m[2]) > 180) throw Error("Enter the location as latitude, longitude: for example 48.1486, 17.1077");
  return { latitude: +m[1], longitude: +m[2] };
}
let editing = { category_id: null, marker_color: null, marker_icon: null };
function readEditor() {
  const d = $("#dialog");
  return {
    name: $("#pl-name", d).value.trim(),
    category_id: editing.category_id,
    marker_color: editing.marker_color,
    marker_icon: editing.marker_icon,
    address: $("#pl-address", d).value.trim(),
    description: $("#pl-description", d).value.trim(),
    tags: $("#pl-tags", d).value.split(",").map((x) => x.trim()).filter(Boolean),
    favorite: $("#pl-favorite", d).checked,
    want_to_visit: $("#pl-want", d).checked,
    inactive: $("#pl-inactive", d).checked,
    locationText: $("#pl-location", d).value,
  };
}
function editorBase() {
  const c = categoryById(editing.category_id);
  return c ? { color: c.color, icon: c.icon } : DEFAULT_MARKER;
}
function openEditor(draft = {}) {
  const d = $("#dialog");
  const location = draft.locationText !== undefined && draft.latitude === undefined ? draft.locationText : draft.latitude != null ? `${draft.latitude}, ${draft.longitude}` : "";
  editing = { category_id: draft.category_id || null, marker_color: draft.marker_color || null, marker_icon: draft.marker_icon || null };
  const customized = !!(editing.marker_color || editing.marker_icon);
  d.innerHTML = `<div class="ae-dialog-head"><h2>${draft.id ? "Edit place" : "New place"}</h2></div>
    <div class="ae-dialog-body place-form">
      <div class="identity-row"><div class="identity-pin" id="pl-preview"></div><div class="ae-field grow"><label class="ae-label" for="pl-name">Name</label><input class="ae-input" id="pl-name" maxlength="200" value="${esc(draft.name || "")}" placeholder="For example: Grandmother's garden"></div></div>
      <div class="ae-field"><span class="ae-label" id="pl-category-label">Category</span><div id="pl-category"></div></div>
      <details class="customize" id="pl-customize" ${customized ? "open" : ""}><summary>${lucideIcon("palette", 16)}<span>Customize marker</span><span class="customize-state" id="pl-custom-state"></span></summary>
        <div class="customize-body"><div id="pl-marker-preview"></div><div id="pl-marker-fields" class="marker-fields"></div><button type="button" class="ae-btn ae-btn--sm" id="pl-marker-reset">Reset to category defaults</button></div></details>
      <div class="ae-field"><label class="ae-label" for="pl-location">Location (optional)</label><div class="location-row"><input class="ae-input" id="pl-location" value="${esc(location)}" placeholder="48.1486, 17.1077" inputmode="decimal"><button class="ae-btn" data-act="pick-on-map">${icon("map")}<span>Choose on map</span></button></div></div>
      <div class="ae-field"><label class="ae-label" for="pl-address">Address (optional)</label><input class="ae-input" id="pl-address" maxlength="500" value="${esc(draft.address || "")}"></div>
      <div class="ae-field"><label class="ae-label" for="pl-tags">Tags, separated by commas</label><input class="ae-input" id="pl-tags" value="${esc((draft.tags || []).join(", "))}"></div>
      <div class="ae-field"><label class="ae-label" for="pl-description">Short description</label><textarea class="ae-textarea" id="pl-description" rows="3" maxlength="2000">${esc(draft.description || "")}</textarea></div>
      <div class="check-row"><label class="check"><input type="checkbox" id="pl-favorite" ${draft.favorite ? "checked" : ""}><span>Favorite</span></label><label class="check"><input type="checkbox" id="pl-want" ${draft.want_to_visit ? "checked" : ""}><span>Want to visit</span></label><label class="check"><input type="checkbox" id="pl-inactive" ${draft.inactive ? "checked" : ""}><span>Historical</span></label></div>
      <p class="form-error" id="pl-error" role="alert" hidden></p>
    </div>
    <div class="ae-dialog-foot"><button class="ae-btn" data-act="close-editor">Cancel</button><button class="ae-btn ae-btn--primary" data-act="save-place">Save</button></div>`;
  d.dataset.id = draft.id || "";
  d.dataset.revision = draft.revision || "";
  d.dataset.external = draft.external_ref || "";
  const shown = () => ({ color: editing.marker_color || editorBase().color, icon: editing.marker_icon || editorBase().icon });
  const paint = () => {
    $("#pl-preview", d).innerHTML = markerSvg(shown(), 40);
    $("#pl-marker-preview", d).innerHTML = previewBlock(shown());
    const parts = [editing.marker_icon && "icon", editing.marker_color && "color"].filter(Boolean);
    $("#pl-custom-state", d).textContent = parts.length ? `Own ${parts.join(" and ")}` : "From category";
    $("#pl-marker-reset", d).disabled = !parts.length;
  };
  const fields = mountMarkerFields($("#pl-marker-fields", d), { base: editorBase, value: { color: editing.marker_color, icon: editing.marker_icon }, onChange: (v) => {
    editing.marker_color = v.color;
    editing.marker_icon = v.icon;
    paint();
  } });
  $("#pl-marker-reset", d).onclick = () => fields.set({ color: null, icon: null });
  mountCategoryCombo($("#pl-category", d), { value: editing.category_id, mode: "editor", onChange: (id) => {
    editing.category_id = id || null;
    fields.refresh();
    paint();
  }, onCreate: (done) => openCategoryDialog(null, done) });
  paint();
  d.showModal();
  $("#pl-name", d).focus();
}
async function saveEditor(button) {
  const d = $("#dialog");
  const err = $("#pl-error", d);
  err.hidden = true;
  try {
    const { locationText, ...form } = readEditor();
    if (!form.name) throw Error("Give the place a name.");
    const body = { ...form, ...parseLocation(locationText) };
    const id = d.dataset.id;
    if (id && d.dataset.revision) body.expected_revision = d.dataset.revision;
    if (d.dataset.external) body.external_ref = d.dataset.external;
    button.disabled = true;
    const saved = await api(id ? `/places/${id}` : "/places", id ? "PUT" : "POST", body);
    d.close();
    toast(id ? "Place saved" : "Place added", "good");
    await refresh();
    pinsDirty = true;
    render();
    await openDetail(saved.id);
  } catch (error) {
    button.disabled = false;
    err.textContent = error.message;
    err.hidden = false;
  }
}

/* ── Actions ── */
document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-go], [data-act], [data-pin], [data-contact-pin], [data-contact-action], [data-place], [data-filter], [data-restore], [data-purge], [data-module], [data-result], [data-cat-edit], [data-cat-delete]");
  if (!el) return;
  try {
    if (el.dataset.go) return await go(el.dataset.go);
    if (el.dataset.pin) return await openDetail(el.dataset.pin);
    if (el.dataset.contactPin) {
      if (el.matches(".map-result")) {
        state.searchResults = null;
        showResults();
        $("#map-q").value = "";
        return openContactDetail(el.dataset.contactPin, { center: true });
      }
      if (state.view !== "map") {
        state.view = "map";
        render();
        return openContactDetail(el.dataset.contactPin, { center: true });
      }
      return openContactDetail(el.dataset.contactPin);
    }
    if (el.dataset.contactAction) {
      const c = state.contacts.items.find((x) => x.id === el.dataset.id);
      if (!c) return;
      if (el.dataset.contactAction === "customize") return openContactMarker(c);
      return startContactPick(c.id);
    }
    if (el.dataset.catEdit) return openCategoryDialog(categoryById(el.dataset.catEdit), () => go("categories"));
    if (el.dataset.catDelete) return openDeleteCategory(categoryById(el.dataset.catDelete));
    if (el.dataset.place && el.matches(".place-card")) return await openDetail(el.dataset.place);
    if (el.dataset.module) return await bridge("navigate", { module: el.dataset.module, ...(el.dataset.path ? { path: el.dataset.path } : {}) });
    if (el.dataset.result) {
      const item = state.searchResults[el.dataset.result === "local" ? "local" : "online"][+el.dataset.i];
      state.searchResults = null;
      showResults();
      $("#map-q").value = "";
      if (el.dataset.result === "local") return await openDetail(item.id, { center: true });
      map.cx = lngX(item.longitude);
      map.cy = latY(item.latitude);
      map.z = Math.max(map.z, 15);
      clampView();
      draw();
      return openEditor({ name: item.name, address: item.display, latitude: item.latitude, longitude: item.longitude, external_ref: item.external_ref });
    }
    if (el.dataset.filter) {
      state.filter.view = el.dataset.filter;
      $$("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
      return await loadLibrary();
    }
    if (el.dataset.restore) {
      await api(`/places/${el.dataset.restore}/restore`, "POST");
      toast("Place restored", "good");
      return await go("trash");
    }
    if (el.dataset.purge) {
      if (!(await confirmDialog("Delete this place for good?", "This cannot be undone. Links from other modules will show it as deleted.", "Delete for good"))) return;
      await api(`/trash/${el.dataset.purge}`, "DELETE");
      return await go("trash");
    }
    const act = el.dataset.act;
    if (act === "new-place") return openEditor();
    if (act === "new-category") return openCategoryDialog(null, () => go("categories"));
    if (act === "contacts-panel") return openContactsPanel();
    if (act === "toggle-layers") {
      state.layersOpen = !state.layersOpen;
      return renderLayers();
    }
    if (act === "osm-copyright") return await bridge("external", { url: "https://www.openstreetmap.org/copyright" });
    if (act === "map-online") {
      state.mapSettings = { ...state.mapSettings, ...(await api("/map-settings", "PUT", { online: true, tile_url: state.mapSettings.tile_url, geocoder_url: state.mapSettings.geocoder_url })) };
      tiles.failed.clear();
      return render();
    }
    if (act === "search-online") {
      const r = state.searchResults;
      r.busy = true;
      showResults();
      r.online = (await api("/geocode?q=" + encodeURIComponent(r.q))).items;
      r.busy = false;
      return showResults();
    }
    if (act === "save-settings") {
      const err = $("#st-error");
      err.hidden = true;
      try {
        await api("/map-settings", "PUT", { online: $("#st-online").checked, tile_url: $("#st-tiles").value, geocoder_url: $("#st-geo").value });
        tiles.images.clear();
        tiles.failed.clear();
        await refresh();
        toast("Settings saved", "good");
        return render();
      } catch (error) {
        err.textContent = error.message;
        err.hidden = false;
        return;
      }
    }
    if (act === "close-detail") return closeDetail();
    if (act === "close-editor") return $("#dialog").close();
    if (act === "save-place") return await saveEditor(el);
    if (act === "zoom-in" || act === "zoom-out") {
      const [w, h] = viewSize();
      return zoomAt(w / 2, h / 2, act === "zoom-in" ? 0.8 : -0.8);
    }
    if (act === "fit") return fitPlaces();
    if (act === "cancel-pick") {
      const draft = state.picking;
      state.picking = null;
      render();
      if (draft.contact) return;
      return openEditor(draft);
    }
    if (act === "pick-on-map") {
      event.preventDefault();
      const d = $("#dialog");
      state.picking = { ...readEditor(), id: d.dataset.id || undefined, revision: d.dataset.revision || undefined, external_ref: d.dataset.external || undefined };
      d.close();
      closeDetail();
      state.view = "map";
      return render();
    }
    const p = state.selected;
    if (act === "edit-place" && p) return openEditor(p);
    if (act === "show-on-map" && p) {
      state.view = "map";
      render();
      return await openDetail(p.id, { center: true });
    }
    if (act === "trash-place" && p) {
      await api(`/places/${p.id}`, "DELETE");
      toast("Moved to Trash");
      closeDetail();
      await refresh();
      pinsDirty = true;
      return render();
    }
  } catch (error) {
    toast(error.message, "danger");
  }
});
document.addEventListener("change", (event) => {
  const { layer, category, state: key } = event.target.dataset || {};
  if (!layer && !category && !key) return;
  const f = state.filters;
  if (layer) f[layer] = event.target.checked;
  if (key) f[key] = event.target.checked;
  if (category) f.hidden_categories = event.target.checked ? f.hidden_categories.filter((x) => x !== category) : [...new Set([...f.hidden_categories, category])];
  saveFilters();
  pinsDirty = true;
  draw();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#dialog").open && state.selected) closeDetail();
});

(async () => {
  shell();
  try {
    const context = await bridge("context");
    state.apps = context.applications || [];
    await refresh();
    render();
    loadContacts();
    const deep = location.pathname.match(/\/places\/([0-9a-f-]{36})$/);
    if (deep) await openDetail(deep[1], { center: true });
  } catch (error) {
    $("#sheet").innerHTML = `<div class="page"><div class="empty"><h3>Atlas could not be opened</h3><p>${esc(error.message)}</p></div></div>`;
  }
})();
