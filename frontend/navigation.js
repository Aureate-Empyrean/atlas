/* Atlas adapter for the Nexus navigation contract (`empyrean-navigation-v1`, SDK in
   vendor/nexus-navigation.js, kept in sync by empyrean-nexus/scripts/sync-navigation.mjs).
   Nexus owns the browser URL and history; Atlas owns its routes.

     /  /library  /categories  /trash  /settings   a section (/ is the map)
     /places/<id>[?section=library]                one Place, over the section it was opened in
     /map/contact                                  a Meridian contact selected on the map

   The URL never says which contact: who is selected, the map position and the library search
   are private per-entry view state, so an address that is copied or logged carries no location
   or relationship. An unsaved Place editor is a draft. Without a supporting host, Atlas keeps
   its old in-memory navigation. */

const ATLAS_SECTIONS = ["library", "categories", "trash", "settings"];
const AtlasRoutes = {
  parse(value) {
    const url = new URL(String(value || "/"), "http://atlas.invalid");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" || path === "/map") return { view: "map" };
    if (path === "/map/contact") return { view: "map", contact: true };
    if (ATLAS_SECTIONS.includes(path.slice(1))) return { view: path.slice(1) };
    const place = path.match(/^\/places\/([0-9a-f-]{36})$/);
    if (place) {
      const section = url.searchParams.get("section");
      return { view: ATLAS_SECTIONS.includes(section) ? section : "map", place: place[1] };
    }
    return { notFound: true, path: String(value || "/") };
  },
  serialize(route) {
    if (route.notFound) return route.path;
    if (route.place) return `/places/${route.place}${route.view === "map" ? "" : `?section=${route.view}`}`;
    if (route.contact) return "/map/contact";
    return route.view === "map" ? "/" : `/${route.view}`;
  },
};

let shownRoute = null;
let shownParsed = null;
let heldRoute = null;
let renderedSection = null;
let pendingCenter = false;
let pendingContact = null;
let keepPicking = false;
const retainedDrafts = new Map();
let lastCheckpointDirty = false;

/* ── The Place editor ── */
let editorBaseline = null;
const editorOpen = () => $("#dialog").open && !!$("#pl-name", $("#dialog"));
function editorDraftValue() {
  const d = $("#dialog");
  return { ...readEditor(), id: d.dataset.id || undefined, revision: d.dataset.revision || undefined, external_ref: d.dataset.external || undefined };
}
function placeEditorOpened() {
  editorBaseline = JSON.stringify(editorDraftValue());
}
const editorDirty = () => editorOpen() && JSON.stringify(editorDraftValue()) !== editorBaseline;
function captureDraft() {
  // A Place being positioned on the map is an editor too, without its dialog.
  const value = editorDirty() ? editorDraftValue() : state.picking && !state.picking.contact ? state.picking : null;
  return value ? { key: `place:${value.id || "new"}`, label: value.name || "New place", route: shownRoute, value } : null;
}
function checkpointValue() {
  const live = captureDraft();
  const drafts = [...retainedDrafts.values()].filter((d) => d.key !== live?.key);
  if (live) drafts.push(live);
  return { version: 1, dirty: drafts.length > 0, drafts };
}
function checkpointNow() {
  if (!atlasNavigation.enabled) return Promise.resolve();
  const value = checkpointValue();
  if (!value.dirty && !lastCheckpointDirty) return Promise.resolve();
  return atlasNavigation.checkpoint(value).then(() => {
    lastCheckpointDirty = value.dirty;
  });
}
let checkpointTimer;
function scheduleCheckpoint() {
  clearTimeout(checkpointTimer);
  checkpointTimer = setTimeout(() => checkpointNow().catch((error) => toast(error.message, "danger")), 400);
}
for (const kind of ["input", "change"]) document.addEventListener(kind, (event) => event.target.closest("#dialog") && editorOpen() && scheduleCheckpoint());
function renderDraftTray() {
  let tray = $("#draft-tray");
  if (!retainedDrafts.size) return tray?.remove();
  if (!tray) {
    tray = document.createElement("div");
    tray.id = "draft-tray";
    tray.className = "draft-tray ae-glass";
    tray.setAttribute("role", "status");
    document.body.append(tray);
  }
  tray.replaceChildren(
    ...[...retainedDrafts.values()].map((draft) => {
      const row = document.createElement("div");
      row.className = "draft-tray-row";
      row.innerHTML = `<span class="grow">An unsaved place is kept in this tab: ${esc(draft.label)}</span><button class="ae-btn ae-btn--sm ae-btn--primary" data-draft="resume">Resume editing</button><button class="ae-btn ae-btn--sm ae-btn--quiet" data-draft="discard">Discard</button>`;
      $('[data-draft="resume"]', row).onclick = () => {
        if (editorOpen()) return toast("Finish the place you are editing first.", "danger");
        openEditor(draft.value);
        retainedDrafts.delete(draft.key);
        renderDraftTray();
        scheduleCheckpoint();
      };
      $('[data-draft="discard"]', row).onclick = () => {
        retainedDrafts.delete(draft.key);
        renderDraftTray();
        checkpointNow().catch(() => {});
      };
      return row;
    }),
  );
}
function renderHoldNotice() {
  const body = $("#dialog .ae-dialog-body");
  if (!body) return;
  let notice = $("#dialog-hold", body);
  if (!heldRoute) return notice?.remove();
  if (notice) return;
  notice = document.createElement("div");
  notice.id = "dialog-hold";
  notice.className = "notice";
  notice.setAttribute("role", "status");
  notice.innerHTML = `<p>The browser moved to another page. Your unsaved place stays here until you save or discard it, or use Back and Forward to return.</p><button class="ae-btn ae-btn--sm" id="dialog-hold-discard">Discard and continue</button>`;
  body.prepend(notice);
  $("#dialog-hold-discard", notice).onclick = () => $("#dialog").close();
}
document.addEventListener(
  "close",
  (event) => {
    if (event.target !== $("#dialog")) return;
    editorBaseline = null;
    scheduleCheckpoint();
    if (!heldRoute) return;
    const { reference, route } = heldRoute;
    heldRoute = null;
    shownRoute = reference;
    shownParsed = route;
    showRoute(route, null);
  },
  true,
);

/* ── Showing a route ── */
async function showRoute(next, message) {
  const isCurrent = message?.isCurrent || (() => true);
  const view = message?.viewState;
  const picking = keepPicking;
  keepPicking = false;
  // A Place being positioned is not lost when the map is left: it becomes a draft.
  if (!picking && state.picking && !state.picking.contact) {
    const live = captureDraft();
    if (live) retainedDrafts.set(live.key, live);
    renderDraftTray();
  }
  if (!picking) state.picking = null;
  state.selected = null;
  state.selectedGroup = null;
  if (next.notFound) {
    state.view = "map";
    renderedSection = null;
    stopMap();
    nav();
    $("#sheet").classList.remove("is-map");
    $("#sheet").innerHTML = `<div class="page"><div class="empty"><h3 data-heading tabindex="-1">This page could not be found</h3><p>The address may be wrong, or the place may have been removed.</p><button class="ae-btn" data-go="map">Back to the map</button></div></div>`;
    closeDetail();
    return "not-found";
  }
  if (view?.filter) state.filter = { ...state.filter, ...view.filter };
  const section = next.view;
  const first = renderedSection === null;
  if (section !== renderedSection) {
    closeDetail();
    await refresh();
    if (!isCurrent()) return;
    // Only now: a restore superseded while loading must leave no trace of the section it wanted.
    state.view = section;
    if (view?.map) Object.assign(map, view.map);
    render();
    renderedSection = section;
    if (first) loadContacts();
    else loadContacts().catch(() => {});
  } else {
    closeDetail();
    if (picking) render();
    if (view?.map) {
      Object.assign(map, view.map);
      if ($("#map-stage")) draw();
    }
  }
  if (!isCurrent()) return;
  if (next.place) {
    try {
      await openDetail(next.place, { center: pendingCenter || (!view && message?.cause !== "commit") });
    } catch (error) {
      if (!/not found/i.test(error.message)) throw error;
      const box = $("#detail");
      box.innerHTML = `<div class="detail-head"><h2 class="detail-title" tabindex="-1">This place could not be found</h2><button class="map-tool" data-act="close-detail" aria-label="Close details">${icon("x")}</button></div><p class="detail-text">It may have been removed.</p>`;
      box.hidden = false;
      pendingCenter = false;
      return "not-found";
    }
    pendingCenter = false;
  } else if (next.contact) {
    const key = pendingContact || view?.contact;
    const center = pendingCenter;
    pendingContact = null;
    pendingCenter = false;
    // Contacts arrive on their own schedule and may be slow; selection waits for them.
    if (key) whenContacts(() => isCurrent() && openContactDetail(key, { center }));
  }
  if (view?.scroll && $("#sheet")) $("#sheet").scrollTop = view.scroll;
}
function whenContacts(run) {
  if (state.contacts.availability !== "loading") return run();
  const started = Date.now();
  const wait = setInterval(() => {
    if (state.contacts.availability === "loading" && Date.now() - started < 15000) return;
    clearInterval(wait);
    run();
  }, 120);
}

const atlasNavigation = EmpyreanNavigation.createClient({
  async apply(value, message) {
    if (message.checkpoint?.version === 1) {
      for (const draft of message.checkpoint.drafts || []) retainedDrafts.set(draft.key, draft);
      lastCheckpointDirty = !!message.checkpoint.dirty;
      renderDraftTray();
    }
    const next = AtlasRoutes.parse(value);
    const reference = AtlasRoutes.serialize(next);
    if (reference === shownRoute) {
      if (heldRoute) {
        heldRoute = null;
        renderHoldNotice();
      }
      return;
    }
    if (shownRoute && editorDirty()) {
      heldRoute = { reference, route: next };
      renderHoldNotice();
      return;
    }
    if (!message.isCurrent()) return;
    heldRoute = null;
    const previous = { route: shownRoute, parsed: shownParsed };
    shownRoute = reference;
    shownParsed = next;
    const outcome = await showRoute(next, message);
    // Superseded while loading: the next restore must show its page. An editor opened meanwhile
    // still belongs to the page that was on screen.
    if (!message.isCurrent() && shownRoute === reference) {
      shownRoute = editorDirty() ? previous.route : null;
      if (editorDirty()) shownParsed = previous.parsed;
    }
    return outcome;
  },
  beforeLeave: checkpointNow,
  captureView() {
    if (heldRoute || !shownParsed || shownParsed.notFound) return null;
    return {
      scroll: state.view === "map" ? 0 : $("#sheet")?.scrollTop || 0,
      filter: state.filter,
      contact: state.selectedGroup || null,
      map: map.ready ? { cx: map.cx, cy: map.cy, z: map.z } : null,
    };
  },
  onError(error) {
    toast(error.message, "danger");
  },
});

let navigationQueue = Promise.resolve();
let queuedRoute = null; // the newest move still on its way, so a repeat is compared with it
function queueNavigation(reference, mode) {
  queuedRoute = reference;
  const next = navigationQueue.catch(() => {}).then(() => atlasNavigation.navigate(reference, mode));
  navigationQueue = next;
  const clear = () => {
    if (navigationQueue === next) queuedRoute = null;
  };
  next.then(clear, clear);
  return next;
}
function commitRoute(route, mode = "push") {
  return queueNavigation(AtlasRoutes.serialize(route), mode).catch((error) => {
    if (!/superseded/i.test(error.message)) toast(error.message, "danger");
  });
}
