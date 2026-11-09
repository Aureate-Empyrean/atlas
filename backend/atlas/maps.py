"""Online map data for Atlas (ADR 0025): raster tiles and explicit place search.

Only the coordinates of tiles and the text of an explicit search ever leave. Nothing about the
owner's Places, contacts or notes does. Providers are separate and replaceable, and the network is
optional: with it off, or unreachable, tiles already cached are still served.

Default providers are OpenStreetMap's public services, which are donated. Atlas follows their
usage policies: it identifies itself, caches each tile for at least 7 days, sends few requests,
searches only when asked, and shows the required attribution.
"""

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
DEFAULT_GEOCODER = "https://nominatim.openstreetmap.org"
# Address suggestions as you type (ADR 0031). Nominatim's policy forbids that use; Photon is built
# for it. Its public instance is a fair-use service, and it is self-hostable.
DEFAULT_SUGGEST = "https://photon.komoot.io"
SUGGEST_PROVIDER = "Photon"
SUGGEST_INTERVAL = 0.4
SUGGEST_CACHE_SECONDS = 600
SUGGEST_CACHE_ENTRIES = 200
NUMBER_FIRST = {"us", "ca", "gb", "ie", "au", "nz", "fr"}
ATTRIBUTION = "© OpenStreetMap contributors"
USER_AGENT = "AureateEmpyrean-Atlas/0.5 (+https://github.com/Aureate-Empyrean/atlas)"
MIN_CACHE = 7 * 24 * 3600
MAX_CACHE_BYTES = 256 * 1024 * 1024
MAX_TILE_BYTES = 512 * 1024
BATCH = 16
BATCH_BYTES = 1_400_000  # inside the 2 MiB bridge limit once encoded
GEOCODE_INTERVAL = 1.1  # the public Nominatim policy allows one request per second
TILE_URL = re.compile(r"^https?://[^\s<>\"]+$")
URL = re.compile(r"^https?://[^\s<>\"{}]+$")


class Invalid(ValueError):
    pass


class Offline(Exception):
    pass


class Busy(Exception):
    pass


def _fetch(url, headers, timeout=8):
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read(MAX_TILE_BYTES * 8)
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), b""


def parse_suggestion(feature):
    """One provider result as address fields. A value the provider did not give stays empty."""
    props = feature["properties"]
    longitude, latitude = feature["geometry"]["coordinates"]
    kind = str(props.get("type") or "")
    code = str(props.get("countrycode") or "").lower()
    name = str(props.get("name") or "")
    number = str(props.get("housenumber") or "")
    road = str(props.get("street") or (name if kind == "street" else ""))
    street = (f"{number} {road}" if code in NUMBER_FIRST else f"{road} {number}").strip() if road else number
    locality = str(props.get("city") or (name if kind in ("city", "town", "village", "locality") else ""))
    fields = {
        "street": street[:200],
        "postal_code": str(props.get("postcode") or "")[:30],
        "locality": locality[:120],
        "region": str(props.get("state") or "")[:120],
        "country": str(props.get("country") or "")[:120],
    }
    place = name if name and kind not in ("house", "street", "city", "town", "village", "locality") else ""
    label = ", ".join(x for x in (place, street or locality or name) if x)
    place_line = " ".join(x for x in (fields["postal_code"], locality) if x)
    detail = ", ".join(x for x in (place_line, fields["region"], fields["country"]) if x)
    return {
        "kind": "suggestion", **fields, "label": label[:200], "detail": detail[:300],
        "latitude": float(latitude), "longitude": float(longitude),
        "precision": "house" if number else (kind or "area")[:20],
    }  # fmt: skip


class Maps:
    def __init__(self, db, data: Path, fetch=None):
        self.db = db
        self.cache = Path(data) / "tiles"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.fetch = fetch or _fetch
        self.quick_fetch = fetch or (lambda url, headers: _fetch(url, headers, timeout=4))
        self.last_suggest = [0.0]
        self.suggestions = {}  # memory only: what was searched is never written down
        self.lock = threading.Lock()
        self.last_geocode = [0.0]
        self.writes = [0]

    def settings(self, conn):
        stored = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}
        return {
            "online": stored.get("online") == "1",
            "tile_url": stored.get("tile_url") or DEFAULT_TILES,
            "geocoder_url": stored.get("geocoder_url") or DEFAULT_GEOCODER,
            "suggest_url": stored.get("suggest_url") or DEFAULT_SUGGEST,
            "attribution": ATTRIBUTION,
        }

    def save(self, conn, online, tile_url, geocoder_url, suggest_url=None):
        if not TILE_URL.fullmatch(tile_url) or not all(p in tile_url for p in ("{z}", "{x}", "{y}")):
            raise Invalid("The tile address must be http(s) and contain {z}, {x} and {y}.")
        if not URL.fullmatch(geocoder_url):
            raise Invalid("The search address must be http(s).")
        if suggest_url is not None and not URL.fullmatch(suggest_url):
            raise Invalid("The address suggestion service must be http(s).")
        values = [("online", "1" if online else "0"), ("tile_url", tile_url), ("geocoder_url", geocoder_url.rstrip("/"))]
        if suggest_url is not None:  # left as it is when the caller does not name one
            values.append(("suggest_url", suggest_url.rstrip("/")))
        for key, value in values:
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)", (key, value))

    def _paths(self, z, x, y):
        folder = self.cache / str(z) / str(x)
        return folder / f"{y}.tile", folder / f"{y}.json"

    @staticmethod
    def _image(data):
        return data[:8] == b"\x89PNG\r\n\x1a\n" or data[:3] == b"\xff\xd8\xff"

    @staticmethod
    def _max_age(headers):
        lowered = {k.lower(): v for k, v in headers.items()}
        m = re.search(r"max-age=(\d+)", lowered.get("cache-control", ""))
        return max(MIN_CACHE, int(m.group(1)) if m else 0)

    def tile(self, settings, z, x, y):
        """Bytes of a tile, from the cache when it is fresh or when the network cannot help."""
        path, meta_path = self._paths(z, x, y)
        cached = path.read_bytes() if path.is_file() else None
        meta = json.loads(meta_path.read_text()) if cached and meta_path.is_file() else {}
        if cached and time.time() - meta.get("fetched", 0) < meta.get("max_age", MIN_CACHE):
            return cached
        if not settings["online"]:
            return cached
        url = settings["tile_url"].format(z=z, x=x, y=y)
        headers = {"User-Agent": USER_AGENT}
        if meta.get("etag"):
            headers["If-None-Match"] = meta["etag"]
        try:
            status, reply, body = self.fetch(url, headers)
        except (OSError, ValueError):
            return cached
        if status == 304 and cached:
            meta.update(fetched=time.time(), max_age=self._max_age(reply))
            meta_path.write_text(json.dumps(meta))
            return cached
        if status != 200 or not self._image(body) or len(body) > MAX_TILE_BYTES:
            return cached
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".part")
        temp.write_bytes(body)
        os.replace(temp, path)
        meta_path.write_text(json.dumps({"fetched": time.time(), "max_age": self._max_age(reply), "etag": {k.lower(): v for k, v in reply.items()}.get("etag")}))
        self._trim()
        return body

    def _trim(self):
        with self.lock:
            self.writes[0] += 1
            if self.writes[0] % 64:
                return
        files = [(p.stat().st_mtime, p.stat().st_size, p) for p in self.cache.rglob("*.tile")]
        total = sum(f[1] for f in files)
        for _, size, path in sorted(files, key=lambda f: f[0]):
            if total <= MAX_CACHE_BYTES:
                break
            path.unlink(missing_ok=True)
            path.with_suffix(".json").unlink(missing_ok=True)
            total -= size

    def cached_bytes(self):
        return sum(p.stat().st_size for p in self.cache.rglob("*.tile"))

    def suggest(self, settings, q):
        """Address suggestions as someone types. Only the words typed are sent. Rate limited here,
        whatever the callers do; results are kept briefly in memory and never logged."""
        if not settings["online"]:
            raise Offline
        key = " ".join(q.lower().split())
        now = time.monotonic()
        with self.lock:
            hit = self.suggestions.get(key)
            if hit and now - hit[0] < SUGGEST_CACHE_SECONDS:
                return hit[1]
            if now - self.last_suggest[0] < SUGGEST_INTERVAL:
                raise Busy
            self.last_suggest[0] = now
        query = urllib.parse.urlencode({"q": q[:120], "limit": 6})
        try:
            status, _, body = self.quick_fetch(f"{settings['suggest_url']}/api?{query}", {"User-Agent": USER_AGENT})
            if status == 429:
                raise Busy
            if status != 200:
                raise Offline
            features = json.loads(body or b"{}").get("features") or []
        except (OSError, ValueError) as exc:
            raise Offline from exc
        results = []
        for feature in features[:6]:
            try:
                results.append(parse_suggestion(feature))
            except (KeyError, TypeError, ValueError):
                continue
        with self.lock:
            self.suggestions[key] = (now, results)
            for old in list(self.suggestions)[:-SUGGEST_CACHE_ENTRIES]:
                del self.suggestions[old]
        return results

    def geocode(self, settings, q):
        """An explicit search: only the words typed are sent."""
        if not settings["online"]:
            raise Offline
        with self.lock:
            wait = GEOCODE_INTERVAL - (time.monotonic() - self.last_geocode[0])
            if wait > 0:
                time.sleep(wait)
            self.last_geocode[0] = time.monotonic()
        query = urllib.parse.urlencode({"q": q[:200], "format": "jsonv2", "limit": 6})
        try:
            status, _, body = self.fetch(f"{settings['geocoder_url']}/search?{query}", {"User-Agent": USER_AGENT})
        except (OSError, ValueError) as exc:
            raise Offline from exc
        if status != 200:
            raise Offline
        results = []
        for item in json.loads(body or b"[]")[:6]:
            try:
                kind, oid = str(item.get("osm_type", "")), int(item.get("osm_id", 0))
                results.append({
                    "name": str(item.get("name") or str(item.get("display_name", "")).split(",")[0])[:200],
                    "display": str(item.get("display_name", ""))[:300],
                    "latitude": float(item["lat"]), "longitude": float(item["lon"]),
                    "importance": float(item.get("importance") or 0),
                    "external_ref": f"osm:{kind}/{oid}" if kind in ("node", "way", "relation") and oid else None,
                })  # fmt: skip
            except (KeyError, TypeError, ValueError):
                continue
        return results
