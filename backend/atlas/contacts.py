"""The Meridian contact-address layer (ADR 0030).

Meridian owns every contact and address. Atlas reads them through the `contact-addresses`
projection each time the layer is drawn and keeps neither names nor address text. What Atlas
stores is its own knowledge: where an address is on the map (with a hash, to notice when the
address changes) and how its marker looks, both keyed by Meridian's stable identifiers.

Locating an address needs the owner's separate consent. Only street, postal code, city, region and
country go to the provider, never who lives there. An ambiguous answer waits for the owner.
"""

import hashlib
import json
import math
import threading
import time
from datetime import UTC, datetime, timedelta

from . import markers, nexus
from .maps import Offline
from .util import REF, UUID, fold, iso_now

MAX_ADDRESSES = 5000
PAGE = 100
ORPHAN_DAYS = 30
SAME_PLACE_KM = 0.3
IMPORTANCE_MARGIN = 0.05
RETRY_SECONDS = 60
GEOCODING_KEY = "contact_geocoding"
CONTACT_KINDS = {"person", "organization", "group"}


def read_projection():
    """(availability, items). Every page, or the reason there is nothing. Never raises."""
    items, cursor = [], None
    while len(items) < MAX_ADDRESSES:
        try:
            out = nexus.call("POST", "/projections/query", {
                "module": "meridian", "projection": "contact-addresses", "query": {"limit": PAGE}, "cursor": cursor,
            })  # fmt: skip
        except nexus.NexusRefused as exc:
            return ("not_granted" if exc.status == 403 else "nexus_error"), []
        except nexus.NexusUnavailable:
            return "nexus_unreachable", []
        if out.get("availability") != "available":
            return str(out.get("availability") or "temporarily_unavailable"), []
        items.extend(i for i in out.get("items") or [] if well_formed(i))
        cursor = out.get("next_cursor")
        if not cursor:
            break
    return "available", items[:MAX_ADDRESSES]


def well_formed(item):
    if not isinstance(item, dict) or not UUID.fullmatch(str(item.get("id", ""))):
        return False
    match = REF.fullmatch(str(item.get("resource", "")))
    return bool(match and match[1] == "meridian" and match[2] in CONTACT_KINDS)


def geocode_query(item):
    """The address as a search: geography only. Never a label, a PO box, a c/o line or a name."""
    parts = item.get("parts") if isinstance(item.get("parts"), dict) else {}
    locality = " ".join(p for p in (str(parts.get("postal_code") or ""), str(parts.get("locality") or "")) if p)
    segments = [str(parts.get("street") or ""), locality, str(parts.get("region") or ""), str(parts.get("country") or "")]
    if not any(segments):
        segments = str(item.get("text") or "").replace("\n", ",").split(",")
    name = fold(str(item.get("label") or ""))
    words = set(name.split())
    kept = []
    for segment in segments:
        segment = " ".join(segment.split())
        folded = fold(segment)
        if not folded or folded.startswith(("c/o", "attn", "p.o.", "po box")):
            continue
        if name and (name in folded or set(folded.split()) <= words):
            continue
        kept.append(segment[:200])
    return ", ".join(kept)[:400]


def query_hash(query):
    return hashlib.sha256(fold(query).encode()).hexdigest()


def distance_km(a, b):
    lat = math.radians((a["latitude"] + b["latitude"]) / 2)
    dx = math.radians(b["longitude"] - a["longitude"]) * math.cos(lat)
    dy = math.radians(b["latitude"] - a["latitude"])
    return 6371 * math.hypot(dx, dy)


def classify(results):
    """(status, chosen, candidates). Results close together are one answer; a distant result about
    as prominent as the first means only the owner can tell which is right."""
    if not results:
        return "not_found", None, []
    top = results[0]
    rivals = [r for r in results[1:] if distance_km(top, r) > SAME_PLACE_KM and float(r.get("importance") or 0) >= float(top.get("importance") or 0) - IMPORTANCE_MARGIN]
    if rivals:
        return "ambiguous", None, [top, *rivals][:5]
    return "located", top, []


def sync(conn, items):
    """Bring Atlas's location rows in line with Meridian's addresses. Returns them by address id."""
    now = iso_now()
    rows = {r["address_id"]: dict(r) for r in conn.execute("SELECT * FROM contact_locations")}
    places = {r["id"]: r for r in conn.execute("SELECT id, latitude, longitude FROM places WHERE trashed_at IS NULL AND latitude IS NOT NULL")}
    seen = set()
    for item in items:
        query = geocode_query(item)
        if not query:
            continue  # no geography to place
        aid = item["id"]
        seen.add(aid)
        digest = query_hash(query)
        row = rows.get(aid)
        if row and row["query_hash"] == digest:
            if row["orphaned_at"]:
                conn.execute("UPDATE contact_locations SET orphaned_at=NULL WHERE address_id=?", (aid,))
                row["orphaned_at"] = None
            continue
        # New, or the address changed: an old position (even a corrected one) is no longer true.
        status, lat, lng, source = "pending", None, None, None
        place = _linked_place(item, places)
        if place:
            status, lat, lng, source = "located", place["latitude"], place["longitude"], "place"
        else:
            twin = next((r for r in rows.values() if r["query_hash"] == digest and r["status"] == "located" and r["latitude"] is not None), None)
            if twin:  # the same address is only ever looked up once
                status, lat, lng, source = "located", twin["latitude"], twin["longitude"], twin["source"]
        conn.execute(
            "INSERT INTO contact_locations(address_id,query_hash,status,latitude,longitude,source,candidates,orphaned_at,updated_at) "
            "VALUES(?,?,?,?,?,?,NULL,NULL,?) ON CONFLICT(address_id) DO UPDATE SET query_hash=excluded.query_hash,status=excluded.status,"
            "latitude=excluded.latitude,longitude=excluded.longitude,source=excluded.source,candidates=NULL,orphaned_at=NULL,updated_at=excluded.updated_at",
            (aid, digest, status, lat, lng, source, now),
        )
        rows[aid] = {"address_id": aid, "query_hash": digest, "status": status, "latitude": lat, "longitude": lng, "source": source, "candidates": None, "orphaned_at": None}
    # Gone from Meridian: hidden at once, forgotten after a while (a restored contact keeps its corrections).
    limit = (datetime.now(UTC) - timedelta(days=ORPHAN_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    for aid, row in list(rows.items()):
        if aid in seen:
            continue
        if not row["orphaned_at"]:
            conn.execute("UPDATE contact_locations SET orphaned_at=? WHERE address_id=?", (now, aid))
        elif row["orphaned_at"] < limit:
            conn.execute("DELETE FROM contact_locations WHERE address_id=?", (aid,))
        rows.pop(aid)
    return rows


def _linked_place(item, places):
    ref = REF.fullmatch(str(item.get("place_ref") or ""))
    if ref and ref[1] == "atlas" and ref[2] == "place":
        return places.get(ref[3])
    return None


def overrides(conn):
    out = {"contact": {}, "address": {}}
    for r in conn.execute("SELECT scope, source_ref, color, icon FROM marker_overrides"):
        icon = r["icon"] if r["icon"] in markers.ICONS else None
        out[r["scope"]][r["source_ref"]] = {"color": r["color"], "icon": icon}
    return out


def build_layer(conn, items):
    rows = sync(conn, items)
    custom = overrides(conn)
    out = []
    for item in items:
        row = rows.get(item["id"])
        if not row:
            continue
        contact_override = custom["contact"].get(item["resource"])
        address_override = custom["address"].get(item["id"])
        located = row["status"] == "located" and row["latitude"] is not None
        entry = {
            "id": item["id"], "resource": item["resource"], "kind": REF.fullmatch(item["resource"])[2],
            "name": str(item.get("label") or "")[:200], "address_label": str(item.get("address_label") or "")[:40],
            "text": str(item.get("text") or "")[:1000], "current": bool(item.get("current", True)),
            "primary": bool(item.get("primary")), "open_path": str(item.get("open_path") or ""),
            "status": row["status"], "source": row["source"],
            "latitude": row["latitude"] if located else None, "longitude": row["longitude"] if located else None,
            "approximate": not (item.get("parts") or {}).get("street") and row["source"] != "manual",
            "group": f"{row['latitude']:.5f},{row['longitude']:.5f}" if located else None,
            "marker": markers.contact_marker(contact_override, address_override),
            "contact_override": contact_override, "address_override": address_override,
            "siblings": 0,
        }  # fmt: skip
        if row["status"] == "ambiguous" and row["candidates"]:
            entry["candidates"] = json.loads(row["candidates"])
        out.append(entry)
    per_contact = {}
    for entry in out:
        per_contact[entry["resource"]] = per_contact.get(entry["resource"], 0) + 1
    for entry in out:
        entry["siblings"] = per_contact[entry["resource"]] - 1
    return out


class Locator:
    """Looks addresses up one at a time, in the background, within the provider's rate limit."""

    def __init__(self, db, maps_obj, background=True):
        self.db, self.maps, self.background = db, maps_obj, background
        self.lock = threading.Lock()
        self.thread = None
        self.not_before = 0.0

    def enabled(self, conn):
        row = conn.execute("SELECT value FROM settings WHERE key=?", (GEOCODING_KEY,)).fetchone()
        return bool(row and row["value"] == "1")

    @property
    def running(self):
        return bool(self.thread and self.thread.is_alive())

    def kick(self):
        if not self.background or time.monotonic() < self.not_before:
            return
        with self.lock:
            if self.running:
                return
            self.thread = threading.Thread(target=self.run, daemon=True)
            self.thread.start()

    def run(self):
        """One pass over everything still waiting. A network failure stops it until a later try."""
        availability, items = read_projection()
        if availability != "available":
            return
        for item in items:
            query = geocode_query(item)
            if not query:
                continue
            with self.db.connect() as conn:
                settings = self.maps.settings(conn)
                if not (settings["online"] and self.enabled(conn)):
                    return
                row = conn.execute("SELECT status, query_hash FROM contact_locations WHERE address_id=?", (item["id"],)).fetchone()
                if not row or row["status"] != "pending" or row["query_hash"] != query_hash(query):
                    continue
                twin = conn.execute(
                    "SELECT latitude, longitude, source FROM contact_locations WHERE query_hash=? AND status='located' AND latitude IS NOT NULL LIMIT 1",
                    (row["query_hash"],),
                ).fetchone()
                if twin:  # someone else at this address was just found: no need to ask again
                    conn.execute(
                        "UPDATE contact_locations SET status='located',latitude=?,longitude=?,source=?,updated_at=? WHERE address_id=?",
                        (twin["latitude"], twin["longitude"], twin["source"], iso_now(), item["id"]),
                    )
                    continue
            try:
                results = self.maps.geocode(settings, query)
            except Offline:
                self.not_before = time.monotonic() + RETRY_SECONDS
                return
            status, chosen, candidates = classify(results)
            with self.db.connect() as conn:
                conn.execute(
                    "UPDATE contact_locations SET status=?,latitude=?,longitude=?,source=?,candidates=?,updated_at=? WHERE address_id=? AND query_hash=?",
                    (status, chosen["latitude"] if chosen else None, chosen["longitude"] if chosen else None, "geocoder" if chosen else None,
                     json.dumps([{k: c.get(k) for k in ("display", "latitude", "longitude")} for c in candidates]) if candidates else None,
                     iso_now(), item["id"], query_hash(query)),
                )  # fmt: skip
