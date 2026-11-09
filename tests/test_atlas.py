"""Atlas 0.1.0 (roadmap Phase 4): Places, Library data, references and the backlinks standard."""

import json
import sqlite3
from pathlib import Path

import pytest
from atlas import nexus
from atlas.app import create_app
from fastapi.testclient import TestClient

KEY = "k" * 40
GW = {"x-nexus-gateway-key": KEY}
RES = {"x-nexus-resolver-key": KEY}
ROOT = Path(__file__).resolve().parents[1]
EVENT = "nexus:v1:chronos:event:0190f0e4-0000-7000-8000-000000000001"
INTERACTION = "nexus:v1:meridian:interaction:0190f0e4-0000-7000-8000-000000000002"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_RESOLVER_KEY", KEY)
    with TestClient(create_app(tmp_path)) as c:
        c.headers.update(GW)
        yield c


def CATS(client):
    return {c["name"]: c["id"] for c in client.get("/api/categories").json()["items"]}


def place(client, name="Michael's Gate", **extra):
    r = client.post("/api/places", json={"name": name, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def body(p, **changes):
    keep = ("name", "description", "category_id", "address", "latitude", "longitude", "favorite", "want_to_visit", "inactive", "tags")
    return {**{k: p[k] for k in keep}, **changes}


PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 40


class Provider:
    def __init__(self):
        self.calls = []
        self.fail = False

    def __call__(self, url, headers):
        self.calls.append((url, headers))
        if self.fail:
            raise OSError("offline")
        if "/search?" in url:
            return 200, {}, json.dumps([{"lat": "48.14", "lon": "17.1", "name": "Bratislava Castle", "display_name": "Bratislava Castle, Slovakia", "osm_type": "way", "osm_id": 42}]).encode()
        if headers.get("If-None-Match") == "e1":
            return 304, {"Cache-Control": "max-age=99"}, b""
        return 200, {"ETag": "e1", "Cache-Control": "max-age=60"}, PNG


@pytest.fixture
def online(tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_RESOLVER_KEY", KEY)
    provider = Provider()
    with TestClient(create_app(tmp_path, fetch=provider)) as c:
        c.headers.update(GW)
        yield c, provider, tmp_path


def turn_on(c):
    return c.put("/api/map-settings", json={"online": True})


def test_the_network_stays_off_until_the_owner_turns_it_on(online):
    c, provider, _ = online
    assert c.get("/api/map-settings").json()["online"] is False
    assert c.post("/api/tiles", json={"tiles": [[1, 0, 0]]}).json() == {"tiles": {"1/0/0": None}}
    assert c.get("/api/geocode", params={"q": "castle"}).status_code == 503
    assert provider.calls == []


def test_tiles_identify_atlas_are_cached_and_stay_available_offline(online):
    c, provider, _ = online
    turn_on(c)
    got = c.post("/api/tiles", json={"tiles": [[3, 1, 2]]}).json()["tiles"]["3/1/2"]
    assert got.startswith("data:image/png;base64,")
    url, headers = provider.calls[0]
    assert url == "https://tile.openstreetmap.org/3/1/2.png" and headers["User-Agent"].startswith("AureateEmpyrean-Atlas")
    assert c.post("/api/tiles", json={"tiles": [[3, 1, 2]]}).json()["tiles"]["3/1/2"] == got
    assert len(provider.calls) == 1  # cached for at least 7 days, though the server said 60 s
    provider.fail = True
    c.put("/api/map-settings", json={"online": False})
    assert c.post("/api/tiles", json={"tiles": [[3, 1, 2]]}).json()["tiles"]["3/1/2"] == got  # offline
    assert len(provider.calls) == 1
    turn_on(c)
    assert c.post("/api/tiles", json={"tiles": [[3, 0, 0]]}).json()["tiles"]["3/0/0"] is None


def test_an_expired_tile_is_revalidated_with_its_etag(online):
    c, provider, path = online
    turn_on(c)
    c.post("/api/tiles", json={"tiles": [[2, 1, 1]]})
    meta = path / "tiles/2/1/1.json"
    data = json.loads(meta.read_text())
    data["fetched"] = 0
    meta.write_text(json.dumps(data))
    assert c.post("/api/tiles", json={"tiles": [[2, 1, 1]]}).json()["tiles"]["2/1/1"].startswith("data:")
    assert provider.calls[-1][1]["If-None-Match"] == "e1"


@pytest.mark.parametrize("tile", [[20, 0, 0], [1, 2, 0], [1, 0], [-1, 0, 0]])
def test_invalid_tiles_are_refused(online, tile):
    c, provider, _ = online
    turn_on(c)
    assert c.post("/api/tiles", json={"tiles": [tile]}).status_code == 422
    assert provider.calls == []


def test_search_sends_only_the_words_and_a_result_is_saved_as_the_owners_copy(online):
    c, provider, _ = online
    turn_on(c)
    place(c, "Private note about home", description="secret")
    found = c.get("/api/geocode", params={"q": "castle"}).json()["items"]
    assert found[0]["external_ref"] == "osm:way/42" and found[0]["latitude"] == 48.14
    url = provider.calls[-1][0]
    assert "q=castle" in url and "secret" not in url and "Private" not in url
    saved = place(c, found[0]["name"], latitude=48.14, longitude=17.1, external_ref=found[0]["external_ref"])
    assert saved["external_ref"] == "osm:way/42"
    assert c.post("/api/places", json={"name": "X", "external_ref": "javascript:1"}).status_code == 422


def test_providers_are_replaceable_and_validated(online):
    c, provider, _ = online
    bad = c.put("/api/map-settings", json={"online": True, "tile_url": "https://x/no-placeholders"})
    assert bad.status_code == 422
    assert c.put("/api/map-settings", json={"online": True, "tile_url": "ftp://x/{z}/{x}/{y}"}).status_code == 422
    assert c.put("/api/map-settings", json={"online": True, "tile_url": "http://tiles.local/{z}/{x}/{y}.png", "geocoder_url": "http://geo.local/"}).status_code == 200
    c.post("/api/tiles", json={"tiles": [[1, 1, 1]]})
    assert provider.calls[-1][0] == "http://tiles.local/1/1/1.png"
    c.get("/api/geocode", params={"q": "a"})
    assert provider.calls[-1][0].startswith("http://geo.local/search?")


def test_personal_data_needs_the_gateway(client):
    assert client.get("/api/places", headers={"x-nexus-gateway-key": "wrong"}).status_code == 403


def test_a_place_needs_only_a_name_and_keeps_its_details(client):
    bare = place(client, "Somewhere we once stopped")
    assert bare["latitude"] is None and bare["resource"].startswith("nexus:v1:atlas:place:")
    full = place(client, "  Bratislava   Castle ".strip(), latitude=48.1425, longitude=17.1, category_id=CATS(client)["Landmarks"],
                 tags=["History", "history", "views"], favorite=True, want_to_visit=True, inactive=True,
                 address="Zámocká", description="Good viewpoint after sunset")  # fmt: skip
    assert full["category"] == "Landmarks" and full["tags"] == ["history", "views"]
    assert (full["favorite"], full["want_to_visit"], full["inactive"]) == (True, True, True)
    assert full["name"] == "Bratislava Castle"  # historical state stays out of the name


@pytest.mark.parametrize(
    "doc, message",
    [
        ({"latitude": 48.0}, "both latitude and longitude"),
        ({"latitude": 91, "longitude": 1}, ""),
        ({"latitude": 1, "longitude": 181}, ""),
        ({"tags": ["<script>"]}, "for tags"),
        ({"category_id": "0190f0e4-0000-7000-8000-00000000dead"}, "no longer exists"),
    ],
)
def test_validation(client, doc, message):
    r = client.post("/api/places", json={"name": "X", **doc})
    assert r.status_code == 422 and message in r.text


def test_library_search_views_and_filters_ignore_accents(client):
    place(client, "Kaviareň Mýtna", category_id=CATS(client)["Food"], tags=["coffee"], favorite=True)
    place(client, "Old office", category_id=CATS(client)["Home"], inactive=True)
    place(client, "Tatra hike", category_id=CATS(client)["Nature"], want_to_visit=True)
    names = lambda **q: [p["name"] for p in client.get("/api/places", params=q).json()["items"]]  # noqa: E731
    assert names(q="kaviaren myt") == ["Kaviareň Mýtna"]
    assert names(q="coffee") == ["Kaviareň Mýtna"]
    assert names(view_name="favorites") == ["Kaviareň Mýtna"]
    assert names(view_name="want") == ["Tatra hike"]
    assert names(view_name="inactive") == ["Old office"]
    assert names(category=CATS(client)["Home"]) == ["Old office"]
    assert names(tag="coffee") == ["Kaviareň Mýtna"]
    assert names(q="100%") == []
    assert client.get("/api/places", params={"view_name": "nope"}).status_code == 422
    state = client.get("/api/state").json()
    assert state["counts"] == {"active": 3, "trashed": 0} and state["tags"] == ["coffee"]


def test_concurrent_edits_are_detected(client):
    p = place(client)
    first = client.put(f"/api/places/{p['id']}", json=body(p, name="New", expected_revision=p["revision"]))
    assert first.status_code == 200
    stale = client.put(f"/api/places/{p['id']}", json=body(p, name="Other", expected_revision=p["revision"]))
    assert stale.status_code == 409 and "another session" in stale.text
    assert client.get(f"/api/places/{p['id']}").json()["name"] == "New"


def resolve(client, resource, requester="chronos"):
    return client.post("/empyrean/v1/resources/resolve", headers=RES, json={"resource": resource, "requester": requester})


def test_resolver_reveals_only_the_name_and_reports_trash_and_deletion(client):
    p = place(client, "Home", latitude=48.1, longitude=17.1, description="Private note")
    out = resolve(client, p["resource"])
    assert out.status_code == 200
    assert out.json() == {"resource": p["resource"], "label": "Home", "open_path": f"/places/{p['id']}"}
    assert client.post("/empyrean/v1/resources/resolve", json={"resource": p["resource"]}).status_code == 403
    client.delete(f"/api/places/{p['id']}")
    assert client.get(f"/api/places/{p['id']}").status_code == 404
    assert resolve(client, p["resource"]).status_code == 404
    client.post(f"/api/places/{p['id']}/restore")
    assert resolve(client, p["resource"]).status_code == 200
    assert client.delete(f"/api/trash/{p['id']}").status_code == 404  # must be in Trash first
    client.delete(f"/api/places/{p['id']}")
    assert client.delete(f"/api/trash/{p['id']}").status_code == 200
    assert resolve(client, p["resource"]).status_code == 410
    assert resolve(client, "nexus:v1:atlas:area:0190f0e4-0000-7000-8000-000000000003").status_code == 404


def test_place_directory_is_names_only_and_pages(client):
    for i in range(3):
        place(client, f"Park {i}", latitude=1.0, longitude=2.0, category_id=CATS(client)["Nature"], description="secret")
    place(client, "Café")
    trashed = place(client, "Park gone")
    client.delete(f"/api/places/{trashed['id']}")
    ask = lambda query, cursor=None: client.post(  # noqa: E731
        "/empyrean/v1/projections/place-directory", headers=RES, json={"requester": "chronos", "query": query, "cursor": cursor}
    ).json()  # fmt: skip
    first = ask({"q": "park", "limit": 2})
    assert [x["label"] for x in first["items"]] == ["Park 0", "Park 1"] and first["next_cursor"] == "2"
    assert set(first["items"][0]) == {"id", "resource", "label", "category"}
    assert [x["label"] for x in ask({"q": "park", "limit": 2}, first["next_cursor"])["items"]] == ["Park 2"]
    assert [x["label"] for x in ask({"q": "cafe"})["items"]] == ["Café"]


def test_backlinks_follow_the_standard(client, monkeypatch):
    p = place(client)

    def fake(method, path, body=None):
        if path.startswith("/references?"):
            assert "direction=incoming" in path
            return {"references": [
                {"source": EVENT, "target": p["resource"], "relation": "chronos.at"},
                {"source": INTERACTION, "target": p["resource"], "relation": "meridian.interaction-about"},
                {"source": p["resource"], "target": p["resource"], "relation": "atlas.self"},
            ]}  # fmt: skip
        if body["resource"] == EVENT:
            return {"availability": "available", "label": "Lunch"}
        return {"availability": "deleted"}

    monkeypatch.setattr(nexus, "call", fake)
    got = client.get(f"/api/places/{p['id']}/linked-from").json()
    assert got["availability"] == "available"
    assert [(x["module"], x["type"], x["label"], x["availability"]) for x in got["items"]] == [
        ("chronos", "event", "Lunch", "available"),
        ("meridian", "interaction", "", "deleted"),
    ]


def test_backlinks_when_nexus_cannot_answer(client, monkeypatch):
    p = place(client)
    assert client.get(f"/api/places/{p['id']}/linked-from").json() == {"availability": "nexus_unreachable", "items": []}

    def refused(method, path, body=None):
        raise nexus.NexusRefused(403)

    monkeypatch.setattr(nexus, "call", refused)
    assert client.get(f"/api/places/{p['id']}/linked-from").json()["availability"] == "not_granted"


def test_backup_round_trip(client, tmp_path):
    p = place(client, "Keep me", tags=["a"])
    exported = client.post("/empyrean/v1/backup/export", headers=RES)
    headers = {k: v for k, v in exported.headers.items() if k.lower().startswith("x-empyrean-backup-")}
    assert headers["x-empyrean-backup-module"] == "atlas"
    assert client.post("/empyrean/v1/backup/validate", headers={**RES, **headers}, content=exported.content).json() == {"valid": True}
    bad = client.post("/empyrean/v1/backup/validate", headers={**RES, **headers}, content=b"not sqlite")
    assert bad.status_code == 422
    wrong = {**headers, "x-empyrean-backup-module": "meridian"}
    assert client.post("/empyrean/v1/backup/validate", headers={**RES, **wrong}, content=exported.content).status_code == 422
    client.delete(f"/api/places/{p['id']}")
    client.delete(f"/api/trash/{p['id']}")
    assert client.post("/empyrean/v1/backup/restore", headers={**RES, **headers}, content=exported.content).json() == {"restored": True}
    assert client.get(f"/api/places/{p['id']}").json()["tags"] == ["a"]
    with sqlite3.connect(tmp_path / "atlas.sqlite3") as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_manifest_and_one_canonical_icon(client):
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["id"] == "atlas" and manifest["resources"] == [{"type": "place", "resolvable": True}]
    assert manifest["projections"]["provides"] == ["place-directory", "address-suggest"]
    assert "network.egress" in manifest["capabilities"]  # ADR 0025
    icon = (ROOT / "frontend/icon.svg").read_text(encoding="utf-8")
    assert all(c in icon for c in ("#A5D8FF", "#4285D4", "#194F91"))
    public = TestClient(client.app)
    assert public.get(manifest["icon"]).headers["content-type"].startswith("image/svg+xml")
    page = public.get("/").text
    assert "data:image/svg+xml;base64," in page and "/*ATLAS_ICON*/" not in page
