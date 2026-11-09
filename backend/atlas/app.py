import base64
import hashlib
import json
import os
import re
import secrets
import sqlite3
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from . import VERSION, contacts, maps, markers, nexus
from .db import MIGRATIONS, Database
from .util import REF, UUID, fold, iso_now, uuid7

ROOT = Path(__file__).resolve().parents[2]
BACKUP_HEADER = "X-Empyrean-Backup-"
BACKUP_FORMAT = "atlas-sqlite"
BACKUP_FORMAT_VERSION = 1
MAX_ARTIFACT = 256 * 1024 * 1024
MAX_PLACES_PAGE = 2000
VIEWS = {
    "all": "",
    "favorites": "AND favorite=1",
    "want": "AND want_to_visit=1",
    "inactive": "AND inactive=1",
}
TAG = re.compile(r"^[\w][\w .&'/+-]*$")


class PlaceIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    category_id: str | None = Field(default=None, max_length=36)
    marker_color: str | None = Field(default=None, max_length=7)
    marker_icon: str | None = Field(default=None, max_length=48)
    address: str = Field(default="", max_length=500)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    favorite: bool = False
    want_to_visit: bool = False
    inactive: bool = False
    tags: list[str] = Field(default_factory=list, max_length=30)
    expected_revision: str | None = Field(default=None, max_length=64)
    external_ref: str | None = Field(default=None, max_length=80, pattern=r"^osm:(node|way|relation)/\d+$")

    @model_validator(mode="after")
    def check(self):
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("A location needs both latitude and longitude")
        self.marker_color = markers.color(self.marker_color or None)
        self.marker_icon = markers.icon(self.marker_icon or None)
        tags = []
        for tag in self.tags:
            tag = " ".join(tag.split()).lower()
            if not tag or len(tag) > 40 or not TAG.fullmatch(tag):
                raise ValueError("Use letters, digits and spaces for tags, at most 40 characters")
            if tag not in tags:
                tags.append(tag)
        self.tags = tags
        return self


def page_assets():
    """Shared tokens and foundation, the bundled Roboto face (inline: the sandbox has no
    network), then Atlas's own styles."""
    font = base64.b64encode((ROOT / "frontend/fonts/Roboto.woff2").read_bytes()).decode()
    face = (
        '@font-face{font-family:"Roboto";src:url(data:font/woff2;base64,'
        + font
        + ') format("woff2");font-weight:100 900;font-stretch:75% 100%;font-display:swap}'
    )
    return "\n".join(
        [
            (ROOT / "frontend/aureate-tokens.css").read_text(encoding="utf-8"),
            (ROOT / "frontend/aureate-foundation.css").read_text(encoding="utf-8"),
            face,
            (ROOT / "frontend/style.css").read_text(encoding="utf-8"),
        ]
    )


def reference(pid):
    return f"nexus:v1:atlas:place:{pid}"


def revision(conn, pid):
    row = conn.execute("SELECT * FROM places WHERE id=?", (pid,)).fetchone()
    tags = [r[0] for r in conn.execute("SELECT tag FROM place_tags WHERE place_id=? ORDER BY tag", (pid,))]
    return hashlib.sha256(json.dumps([dict(row), tags], sort_keys=True).encode()).hexdigest()


def view(conn, row, tags=None, cats=None):
    cats = markers.categories(conn) if cats is None else cats
    if tags is None:
        tags = [
            r[0] for r in conn.execute("SELECT tag FROM place_tags WHERE place_id=? ORDER BY tag", (row["id"],))
        ]
    return {
        "id": row["id"], "resource": reference(row["id"]), "name": row["name"],
        "description": row["description"], "category_id": row["category_id"],
        "category": cats[row["category_id"]]["name"] if row["category_id"] in cats else "",
        "marker": markers.place_marker(row, cats), "marker_color": row["marker_color"],
        "marker_icon": row["marker_icon"], "address": row["address"],
        "latitude": row["latitude"], "longitude": row["longitude"], "favorite": bool(row["favorite"]),
        "want_to_visit": bool(row["want_to_visit"]), "inactive": bool(row["inactive"]), "tags": tags,
        "external_ref": row["external_ref"],
        "created_at": row["created_at"], "updated_at": row["updated_at"], "trashed_at": row["trashed_at"],
    }  # fmt: skip


class MapSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    online: bool
    tile_url: str = Field(default=maps.DEFAULT_TILES, max_length=500)
    geocoder_url: str = Field(default=maps.DEFAULT_GEOCODER, max_length=500)
    suggest_url: str | None = Field(default=None, max_length=500)  # left as it is when omitted


class CategoryIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=40)
    color: str = Field(max_length=7)
    icon: str = Field(max_length=48)
    description: str = Field(default="", max_length=200)

    @model_validator(mode="after")
    def check(self):
        self.name = " ".join(self.name.split())
        self.color = markers.color(self.color)
        self.icon = markers.icon(self.icon)
        return self


class OverrideIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: Literal["contact", "address"]
    source: str = Field(max_length=240)
    color: str | None = Field(default=None, max_length=7)
    icon: str | None = Field(default=None, max_length=48)

    @model_validator(mode="after")
    def check(self):
        self.color = markers.color(self.color or None)
        self.icon = markers.icon(self.icon or None)
        match = REF.fullmatch(self.source)
        if self.scope == "contact" and not (match and match[1] == "meridian" and match[2] in contacts.CONTACT_KINDS):
            raise ValueError("A contact override needs a Meridian contact reference")
        if self.scope == "address" and not UUID.fullmatch(self.source):
            raise ValueError("An address override needs a Meridian address identifier")
        return self


class LocationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class ContactSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    geocoding: bool


class MapFilters(BaseModel):
    """What the map shows. Hidden things are only hidden: nothing is deleted or unlinked."""

    model_config = ConfigDict(extra="forbid")

    places: bool = True
    contacts: bool = True
    hidden_categories: list[str] = Field(default_factory=list, max_length=500)
    favorite: bool = True
    want: bool = True
    inactive: bool = True
    plain: bool = True
    current_addresses: bool = True
    former_addresses: bool = False


class TilesIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tiles: list[list[int]] = Field(max_length=maps.BATCH)


def create_app(data_dir=None, fetch=None, background=True):
    data = Path(data_dir or os.getenv("ATLAS_DATA", "/data"))
    db = Database(data / "atlas.sqlite3")
    online = maps.Maps(db, data, fetch)
    app_maps = online
    style = page_assets()
    locator = contacts.Locator(db, app_maps, background)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db = db
    app.state.locator = locator
    app.state.maps = app_maps

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        msg = re.sub(r"^Value error, ", "", errors[0].get("msg", "Invalid request")) if errors else "Invalid request"
        return JSONResponse({"detail": msg}, 422)

    @app.middleware("http")
    async def trusted_gateway(request: Request, call_next):
        # Where someone goes is personal: reachable only through the owner-authenticated gateway.
        if request.url.path.startswith("/api/"):
            key = os.getenv("NEXUS_RESOLVER_KEY", "")
            if not key or not secrets.compare_digest(request.headers.get("x-nexus-gateway-key", ""), key):
                return JSONResponse({"detail": "Nexus gateway required"}, status_code=403)
        return await call_next(request)

    def require_resolver(request):
        key = os.getenv("NEXUS_RESOLVER_KEY", "")
        if not key or not secrets.compare_digest(request.headers.get("x-nexus-resolver-key", ""), key):
            raise HTTPException(403, "Resolver authentication required")

    def place_or_404(conn, pid, trashed=False):
        row = conn.execute("SELECT * FROM places WHERE id=?", (pid,)).fetchone() if UUID.fullmatch(pid or "") else None
        if not row or (row["trashed_at"] is not None) != trashed:
            raise HTTPException(404, "Not found")
        return row

    def one(conn, pid):
        row = conn.execute("SELECT * FROM places WHERE id=?", (pid,)).fetchone()
        return {**view(conn, row), "revision": revision(conn, pid)}

    @app.get("/health")
    def health():
        with db.connect() as conn:
            conn.execute("SELECT 1").fetchone()
        return {"status": "ok", "version": VERSION}

    @app.get("/api/state")
    def state():
        with db.connect() as conn:
            counts = dict(
                conn.execute(
                    "SELECT count(*) FILTER (WHERE trashed_at IS NULL) AS active,"
                    " count(*) FILTER (WHERE trashed_at IS NOT NULL) AS trashed FROM places"
                ).fetchone()
            )
            tags = [
                r[0]
                for r in conn.execute(
                    "SELECT DISTINCT t.tag FROM place_tags t JOIN places p ON p.id=t.place_id "
                    "WHERE p.trashed_at IS NULL ORDER BY t.tag"
                )
            ]
            categories = markers.list_categories(conn)
        return {"version": VERSION, "counts": counts, "categories": categories, "tags": tags}

    @app.get("/api/places")
    def list_places(q: str = "", view_name: str = "all", category: str = "", tag: str = ""):
        if view_name not in VIEWS:
            raise HTTPException(422, "Unknown view")
        where, args = VIEWS[view_name], []
        for token in [t for t in fold(q[:200]).split(" ") if t][:8]:
            where += " AND search_text LIKE ? ESCAPE '\\'"
            args.append("%" + token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
        if category == markers.NONE:
            where += " AND category_id IS NULL"
        elif category:
            where += " AND category_id=?"
            args.append(category)
        if tag:
            where += " AND id IN (SELECT place_id FROM place_tags WHERE tag=?)"
            args.append(tag.lower())
        with db.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM places WHERE trashed_at IS NULL {where} ORDER BY search_text, id LIMIT ?",
                (*args, MAX_PLACES_PAGE),
            ).fetchall()
            tags = _tags(conn, [r["id"] for r in rows])
            cats = markers.categories(conn)
            return {"items": [view(conn, r, tags.get(r["id"], []), cats) for r in rows]}

    def _tags(conn, ids):
        out = {}
        for r in conn.execute("SELECT place_id, tag FROM place_tags ORDER BY tag"):
            out.setdefault(r["place_id"], []).append(r["tag"])
        return {k: v for k, v in out.items() if k in set(ids)}

    def searchable(name, category, address, description, tags):
        return fold(" ".join([name, category, address, description, *tags]))

    def assignable(conn, cid):
        if cid is None:
            return None
        row = conn.execute("SELECT * FROM categories WHERE id=?", (cid,)).fetchone()
        if not row:
            raise HTTPException(422, "That category no longer exists.")
        if row["system"]:
            raise HTTPException(422, "The Meridian category is filled automatically from your contacts.")
        return row

    def store(conn, body: PlaceIn, pid=None):
        now = iso_now()
        category = assignable(conn, body.category_id)
        text = searchable(body.name, category["name"] if category else "", body.address, body.description, body.tags)
        row = {
            "name": " ".join(body.name.split()), "description": body.description, "category_id": body.category_id,
            "marker_color": body.marker_color, "marker_icon": body.marker_icon,
            "address": body.address, "latitude": body.latitude, "longitude": body.longitude,
            "favorite": int(body.favorite), "want_to_visit": int(body.want_to_visit),
            "inactive": int(body.inactive), "search_text": text, "updated_at": now,
            "external_ref": body.external_ref,
        }  # fmt: skip
        if pid:
            columns = ",".join(f"{k}=?" for k in row)
            conn.execute(f"UPDATE places SET {columns} WHERE id=?", (*row.values(), pid))
            conn.execute("DELETE FROM place_tags WHERE place_id=?", (pid,))
        else:
            pid = uuid7()
            row.update(id=pid, created_at=now)
            conn.execute(
                f"INSERT INTO places({','.join(row)}) VALUES({','.join('?' * len(row))})",
                tuple(row.values()),
            )
        conn.executemany("INSERT INTO place_tags(place_id, tag) VALUES(?,?)", [(pid, t) for t in body.tags])
        return pid

    @app.post("/api/places", status_code=201)
    def create_place(body: PlaceIn):
        with db.connect() as conn:
            return one(conn, store(conn, body))

    @app.get("/api/places/{pid}")
    def get_place(pid: str):
        with db.connect() as conn:
            place_or_404(conn, pid)
            return one(conn, pid)

    @app.put("/api/places/{pid}")
    def update_place(pid: str, body: PlaceIn):
        with db.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            place_or_404(conn, pid)
            if body.expected_revision and body.expected_revision != revision(conn, pid):
                raise HTTPException(
                    409,
                    "This place changed in another session. Reopen it to see the latest version before saving.",
                )
            store(conn, body, pid)
            return one(conn, pid)

    @app.delete("/api/places/{pid}")
    def trash_place(pid: str):
        with db.connect() as conn:
            place_or_404(conn, pid)
            conn.execute("UPDATE places SET trashed_at=?, updated_at=? WHERE id=?", (iso_now(), iso_now(), pid))
        return {"trashed": True}

    @app.post("/api/places/{pid}/restore")
    def restore_place(pid: str):
        with db.connect() as conn:
            place_or_404(conn, pid, trashed=True)
            conn.execute("UPDATE places SET trashed_at=NULL, updated_at=? WHERE id=?", (iso_now(), pid))
            return one(conn, pid)

    @app.get("/api/trash")
    def trash():
        with db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM places WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC LIMIT ?",
                (MAX_PLACES_PAGE,),
            ).fetchall()
            return {"items": [view(conn, r) for r in rows]}

    @app.delete("/api/trash/{pid}")
    def purge_place(pid: str):
        """Delete for good. The tombstone keeps other modules' references honest (410)."""
        with db.connect() as conn:
            place_or_404(conn, pid, trashed=True)
            conn.execute("DELETE FROM places WHERE id=?", (pid,))
            conn.execute("INSERT OR REPLACE INTO tombstones(id, deleted_at) VALUES(?,?)", (pid, iso_now()))
        return {"deleted": True}

    # ── Categories (ADR 0030) ────────────────────────────────────────

    def category_or_404(conn, cid):
        row = conn.execute("SELECT * FROM categories WHERE id=?", (cid,)).fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        return row

    def name_free(conn, name, own=None):
        key = fold(name)
        if key == fold(markers.MERIDIAN_NAME):
            raise HTTPException(409, "Meridian is reserved for your contacts' addresses.")
        row = conn.execute("SELECT id FROM categories WHERE name_key=?", (key,)).fetchone()
        if row and row["id"] != own:
            raise HTTPException(409, "You already have a category with that name.")
        return key

    def reindex(conn, cid):
        """The category's name is searchable, so its Places follow a rename."""
        for row in conn.execute("SELECT p.*, c.name AS cname FROM places p LEFT JOIN categories c ON c.id=p.category_id WHERE p.category_id=?", (cid,)).fetchall():
            tags = [r[0] for r in conn.execute("SELECT tag FROM place_tags WHERE place_id=?", (row["id"],))]
            conn.execute("UPDATE places SET search_text=? WHERE id=?", (searchable(row["name"], row["cname"] or "", row["address"], row["description"], tags), row["id"]))

    @app.get("/api/categories")
    def list_categories():
        with db.connect() as conn:
            return {"items": markers.list_categories(conn)}

    @app.post("/api/categories", status_code=201)
    def create_category(body: CategoryIn):
        with db.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            key = name_free(conn, body.name)
            cid, now = uuid7(), iso_now()
            position = conn.execute("SELECT coalesce(max(position),0)+1 FROM categories WHERE system IS NULL").fetchone()[0]
            conn.execute(
                "INSERT INTO categories(id,name,name_key,color,icon,description,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (cid, body.name, key, body.color, body.icon, body.description, position, now, now),
            )
            return markers.category_view(category_or_404(conn, cid))

    @app.put("/api/categories/{cid}")
    def update_category(cid: str, body: CategoryIn):
        with db.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if category_or_404(conn, cid)["system"]:
                raise HTTPException(403, "The Meridian category is managed by Atlas.")
            key = name_free(conn, body.name, cid)
            conn.execute(
                "UPDATE categories SET name=?,name_key=?,color=?,icon=?,description=?,updated_at=? WHERE id=?",
                (body.name, key, body.color, body.icon, body.description, iso_now(), cid),
            )
            reindex(conn, cid)
            return markers.category_view(category_or_404(conn, cid))

    @app.delete("/api/categories/{cid}")
    def delete_category(cid: str, move_to: str = ""):
        """Never loses a Place: its Places move to `move_to`, or stay with no category. Individual
        marker customizations stay with the Place."""
        with db.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if category_or_404(conn, cid)["system"]:
                raise HTTPException(403, "The Meridian category is managed by Atlas.")
            target = None
            if move_to:
                if move_to == cid:
                    raise HTTPException(422, "Choose a different category to move its places to.")
                target = assignable(conn, move_to)["id"]
            moved = conn.execute("SELECT count(*) FROM places WHERE category_id=?", (cid,)).fetchone()[0]
            conn.execute("UPDATE places SET category_id=? WHERE category_id=?", (target, cid))
            conn.execute("DELETE FROM categories WHERE id=?", (cid,))
            if target:
                reindex(conn, target)
            else:
                for row in conn.execute("SELECT id FROM places WHERE category_id IS NULL").fetchall():
                    p = conn.execute("SELECT * FROM places WHERE id=?", (row["id"],)).fetchone()
                    tags = [r[0] for r in conn.execute("SELECT tag FROM place_tags WHERE place_id=?", (row["id"],))]
                    conn.execute("UPDATE places SET search_text=? WHERE id=?", (searchable(p["name"], "", p["address"], p["description"], tags), row["id"]))
            return {"deleted": True, "places_kept": moved}

    @app.get("/api/map-filters")
    def get_map_filters():
        with db.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key='map_filters'").fetchone()
        return MapFilters(**json.loads(row["value"])).model_dump() if row else MapFilters().model_dump()

    @app.put("/api/map-filters")
    def put_map_filters(body: MapFilters):
        with db.connect() as conn:
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('map_filters', ?)", (json.dumps(body.model_dump()),))
        return body.model_dump()

    # ── Meridian contact addresses (ADR 0030) ────────────────────────

    @app.get("/api/contacts")
    def contact_layer():
        availability, items = contacts.read_projection()
        with db.connect() as conn:
            consent = locator.enabled(conn)
            online_on = app_maps.settings(conn)["online"]
            if availability != "available":
                # Withheld until Meridian can vouch for them. Nothing stored is touched.
                return {"availability": availability, "items": [], "geocoding": consent, "online": online_on, "pending": 0, "working": False}
            entries = contacts.build_layer(conn, items)
        pending = sum(1 for e in entries if e["status"] == "pending")
        if pending and consent and online_on:
            locator.kick()
        return {"availability": "available", "items": entries, "geocoding": consent, "online": online_on, "pending": pending, "working": locator.running}

    @app.put("/api/contacts/settings")
    def contact_settings(body: ContactSettings):
        with db.connect() as conn:
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)", (contacts.GEOCODING_KEY, "1" if body.geocoding else "0"))
        if body.geocoding:
            locator.not_before = 0.0
            locator.kick()
        return {"geocoding": body.geocoding}

    @app.put("/api/contacts/markers")
    def set_contact_marker(body: OverrideIn):
        """Appearance only: keyed by Meridian's stable identifiers, never changing the contact."""
        with db.connect() as conn:
            if body.color is None and body.icon is None:
                conn.execute("DELETE FROM marker_overrides WHERE scope=? AND source_ref=?", (body.scope, body.source))
            else:
                conn.execute(
                    "INSERT OR REPLACE INTO marker_overrides(scope,source_ref,color,icon,updated_at) VALUES(?,?,?,?,?)",
                    (body.scope, body.source, body.color, body.icon, iso_now()),
                )
        return {"scope": body.scope, "source": body.source, "color": body.color, "icon": body.icon}

    def location_or_404(conn, aid):
        row = conn.execute("SELECT * FROM contact_locations WHERE address_id=? AND orphaned_at IS NULL", (aid,)).fetchone() if UUID.fullmatch(aid or "") else None
        if not row:
            raise HTTPException(404, "Not found")
        return row

    @app.put("/api/contacts/{aid}/location")
    def correct_location(aid: str, body: LocationIn):
        """The owner's answer: kept until the address itself changes in Meridian."""
        with db.connect() as conn:
            location_or_404(conn, aid)
            conn.execute(
                "UPDATE contact_locations SET status='located',latitude=?,longitude=?,source='manual',candidates=NULL,updated_at=? WHERE address_id=?",
                (body.latitude, body.longitude, iso_now(), aid),
            )
        return {"located": True}

    @app.post("/api/contacts/{aid}/locate-again")
    def locate_again(aid: str):
        with db.connect() as conn:
            location_or_404(conn, aid)
            conn.execute(
                "UPDATE contact_locations SET status='pending',latitude=NULL,longitude=NULL,source=NULL,candidates=NULL,updated_at=? WHERE address_id=?",
                (iso_now(), aid),
            )
        locator.not_before = 0.0
        locator.kick()
        return {"pending": True}

    # ── Online map (ADR 0025) ────────────────────────────────────────

    @app.get("/api/map-settings")
    def get_map_settings():
        with db.connect() as conn:
            return {**app_maps.settings(conn), "cached_bytes": app_maps.cached_bytes()}

    @app.put("/api/map-settings")
    def put_map_settings(body: MapSettings):
        try:
            with db.connect() as conn:
                app_maps.save(conn, body.online, body.tile_url, body.geocoder_url, body.suggest_url)
                return app_maps.settings(conn)
        except maps.Invalid as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/api/tiles")
    def tiles(body: TilesIn):
        """Tiles as data URLs: the sandboxed page has no network. Keys left out are to be asked
        for again; a null value means the tile cannot be had right now."""
        with db.connect() as conn:
            settings = app_maps.settings(conn)
        out, used = {}, 0
        for item in body.tiles:
            if len(item) != 3 or not 0 <= item[0] <= 19 or not all(0 <= v < 2 ** item[0] for v in item[1:]):
                raise HTTPException(422, "Invalid tile")
            z, x, y = item
            data_bytes = app_maps.tile(settings, z, x, y)
            key = f"{z}/{x}/{y}"
            if data_bytes is None:
                out[key] = None
                continue
            used += len(data_bytes)
            if used > maps.BATCH_BYTES:
                break
            kind = "jpeg" if data_bytes[:3] == b"\xff\xd8\xff" else "png"
            out[key] = f"data:image/{kind};base64," + base64.b64encode(data_bytes).decode()
        return {"tiles": out}

    @app.get("/api/geocode")
    def geocode(q: str):
        if not q.strip():
            return {"items": []}
        with db.connect() as conn:
            settings = app_maps.settings(conn)
        try:
            return {"items": app_maps.geocode(settings, q.strip()), "attribution": settings["attribution"]}
        except maps.Offline as exc:
            raise HTTPException(503, "Online search is not available right now.") from exc

    @app.get("/api/places/{pid}/linked-from")
    def linked_from(pid: str):
        with db.connect() as conn:
            place_or_404(conn, pid)
        return nexus.linked_from(reference(pid))

    # ── Nexus protocol ───────────────────────────────────────────────

    @app.post("/empyrean/v1/resources/resolve")
    def protocol_resolve(body: dict, request: Request):
        """The name only: a Place's coordinates are personal and are not part of a label."""
        require_resolver(request)
        match = REF.fullmatch(str(body.get("resource", "")))
        if not match or match[1] != "atlas" or match[2] != "place" or not UUID.fullmatch(match[3]):
            raise HTTPException(404, "Not found")
        with db.connect() as conn:
            row = conn.execute("SELECT * FROM places WHERE id=?", (match[3],)).fetchone()
            if not row:
                gone = conn.execute("SELECT 1 FROM tombstones WHERE id=?", (match[3],)).fetchone()
                raise HTTPException(410 if gone else 404, "Unavailable")
            if row["trashed_at"]:
                raise HTTPException(404, "Unavailable")
            return {"resource": body["resource"], "label": row["name"][:200], "open_path": f"/places/{row['id']}"}

    @app.post("/empyrean/v1/projections/address-suggest")
    def address_suggest(body: dict, request: Request):
        """Real-world address suggestions for Meridian's editor (ADR 0031). The first item says
        whether the network may be used; nothing from this request is stored or logged."""
        require_resolver(request)
        query = body.get("query") if isinstance(body.get("query"), dict) else {}
        with db.connect() as conn:
            settings = app_maps.settings(conn)
        status = {"kind": "status", "online": settings["online"], "provider": maps.SUGGEST_PROVIDER, "attribution": f"{maps.SUGGEST_PROVIDER} · {settings['attribution']}", "outcome": "ok"}
        if query.get("status"):
            return {"items": [status], "next_cursor": None}
        text = " ".join(str(query.get("q") or "").split())
        if not settings["online"]:
            return {"items": [{**status, "outcome": "atlas_offline"}], "next_cursor": None}
        if len(text) < 3:
            return {"items": [status], "next_cursor": None}
        try:
            return {"items": [status, *app_maps.suggest(settings, text)], "next_cursor": None}
        except maps.Busy:
            return {"items": [{**status, "outcome": "busy"}], "next_cursor": None}
        except maps.Offline:
            return {"items": [{**status, "outcome": "offline"}], "next_cursor": None}

    @app.post("/empyrean/v1/projections/place-directory")
    def place_directory(body: dict, request: Request):
        """Names to choose a Place from another module; never coordinates or personal states."""
        require_resolver(request)
        query = body.get("query") if isinstance(body.get("query"), dict) else {}
        try:
            limit = max(1, min(int(query.get("limit") or 10), 20))
        except (TypeError, ValueError) as exc:
            raise HTTPException(422, "limit must be a number") from exc
        tokens = [t for t in fold(str(query.get("q") or "")[:100]).split(" ") if t][:8]
        cursor = body.get("cursor")
        offset = int(cursor) if isinstance(cursor, str) and cursor.isdigit() else 0
        with db.connect() as conn:
            rows = conn.execute(
                "SELECT p.id, p.name, coalesce(c.name,'') AS category, p.search_text FROM places p LEFT JOIN categories c ON c.id=p.category_id "
                "WHERE p.trashed_at IS NULL ORDER BY p.search_text, p.id"
            ).fetchall()
        matches = [r for r in rows if all(t in fold(r["name"]) for t in tokens)]
        page = matches[offset : offset + limit]
        following = offset + limit if offset + limit < len(matches) else None
        return {
            "items": [{"id": r["id"], "resource": reference(r["id"]), "label": r["name"][:200], "category": r["category"]} for r in page],
            "next_cursor": str(following) if following else None,
        }  # fmt: skip

    async def receive_artifact(request):
        path = db.path.parent / f"restore-{uuid7()}.part"
        size = 0
        try:
            with open(path, "wb") as out:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_ARTIFACT:
                        raise HTTPException(413, "Backup artifact exceeds 256 MiB")
                    out.write(chunk)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return path

    def check_artifact(request, path):
        headers = {
            k[len(BACKUP_HEADER) :].lower(): v
            for k, v in request.headers.items()
            if k.lower().startswith(BACKUP_HEADER.lower())
        }
        if headers.get("module") != "atlas" or headers.get("format") != BACKUP_FORMAT:
            raise ValueError("Not an Atlas backup")
        if headers.get("format-version") != str(BACKUP_FORMAT_VERSION):
            raise ValueError("Unsupported backup format version")
        try:
            snapshot = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                if snapshot.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise ValueError("Backup database is damaged")
                if not 1 <= snapshot.execute("PRAGMA user_version").fetchone()[0] <= len(MIGRATIONS):
                    raise ValueError("Backup schema is not supported by this version")
                tables = {r[0] for r in snapshot.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not {"places", "place_tags", "tombstones"} <= tables:
                    raise ValueError("Backup is missing Atlas data")
            finally:
                snapshot.close()
        except sqlite3.Error as exc:
            raise ValueError("Backup is not a readable database") from exc

    @app.post("/empyrean/v1/backup/export")
    def backup_export(request: Request):
        require_resolver(request)
        path = db.path.parent / f"export-{uuid7()}.part"
        try:
            target = sqlite3.connect(path)
            with db.connect() as conn:
                conn.backup(target)
            target.execute("PRAGMA journal_mode=DELETE")
            target.close()
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return FileResponse(
            path,
            media_type="application/octet-stream",
            background=BackgroundTask(path.unlink, missing_ok=True),
            headers={
                BACKUP_HEADER + "Module": "atlas",
                BACKUP_HEADER + "Module-Version": VERSION,
                BACKUP_HEADER + "Format": BACKUP_FORMAT,
                BACKUP_HEADER + "Format-Version": str(BACKUP_FORMAT_VERSION),
                BACKUP_HEADER + "Created-At": iso_now(),
                BACKUP_HEADER + "Restorable-By": f">={VERSION},<1",
            },
        )

    @app.post("/empyrean/v1/backup/validate")
    async def backup_validate(request: Request):
        require_resolver(request)
        path = await receive_artifact(request)
        try:
            await run_in_threadpool(check_artifact, request, path)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        finally:
            path.unlink(missing_ok=True)
        return {"valid": True}

    def replace_data(path):
        snapshot = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            with db.connect() as conn:
                snapshot.backup(conn)
        finally:
            snapshot.close()
        db.migrate()

    @app.post("/empyrean/v1/backup/restore")
    async def backup_restore(request: Request):
        require_resolver(request)
        path = await receive_artifact(request)
        try:
            try:
                await run_in_threadpool(check_artifact, request, path)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            await run_in_threadpool(replace_data, path)
        finally:
            path.unlink(missing_ok=True)
        return {"restored": True}

    @app.post("/empyrean/v1/backup/finalize")
    def backup_finalize(request: Request):
        require_resolver(request)
        return {"finalized": True}

    # ── Interface ────────────────────────────────────────────────────

    @app.get("/icon.svg", include_in_schema=False)
    def app_icon():
        return FileResponse(ROOT / "frontend/icon.svg", media_type="image/svg+xml")

    @app.get("/{path:path}", response_class=HTMLResponse)
    def ui(path: str):
        html = (ROOT / "frontend/index.html").read_text(encoding="utf-8")
        icon = base64.b64encode((ROOT / "frontend/icon.svg").read_bytes()).decode()
        script = (ROOT / "frontend/app.js").read_text(encoding="utf-8").replace(
            "/*ATLAS_ICON*/", "data:image/svg+xml;base64," + icon
        ).replace("/*LUCIDE_ICONS*/null", (ROOT / "frontend/lucide-icons.json").read_text(encoding="utf-8").strip())
        # Nexus navigation contract: the shared SDK, then Atlas's adapter.
        script = "\n".join(
            [
                script,
                (ROOT / "frontend/vendor/nexus-navigation.js").read_text(encoding="utf-8"),
                (ROOT / "frontend/navigation.js").read_text(encoding="utf-8"),
            ]
        )
        return html.replace("/*STYLE*/", style).replace("/*SCRIPT*/", script)

    return app
