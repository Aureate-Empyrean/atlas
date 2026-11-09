"""Atlas 0.3.0 (ADR 0030): categories, marker appearance, and the Meridian contact-address layer."""

import json
import sqlite3
from pathlib import Path

import pytest
from atlas import maps, markers, nexus
from atlas.app import create_app
from atlas.db import MIGRATIONS
from fastapi.testclient import TestClient

KEY = "k" * 40
GW = {"x-nexus-gateway-key": KEY}
ROOT = Path(__file__).resolve().parents[1]
A1, A2, A3, A4 = (f"0190f0e4-0000-7000-8000-00000000000{i}" for i in range(1, 5))
PERSON = "nexus:v1:meridian:person:0190f0e4-0000-7000-8000-0000000000a1"
OTHER = "nexus:v1:meridian:person:0190f0e4-0000-7000-8000-0000000000a2"
ORG = "nexus:v1:meridian:organization:0190f0e4-0000-7000-8000-0000000000a3"
BRONZE, PERSON_ICON = "#c48663", "person-solid"


def address(aid=A1, resource=PERSON, name="Alžbeta Nováková", street="Hlavná 1", locality="Bratislava", **extra):
    kind = resource.split(":")[3]
    uid = resource.split(":")[4]
    section = {"person": "people", "organization": "organizations", "group": "groups"}[kind]
    return {
        "id": aid, "resource": resource, "label": name, "address_label": extra.pop("address_label", "Home"),
        "text": extra.pop("text", f"{street}, 811 01 {locality}, Slovakia"),
        "parts": extra.pop("parts", {"street": street, "postal_code": "811 01", "locality": locality, "region": "", "country": "Slovakia"}),
        "current": extra.pop("current", True), "primary": extra.pop("primary", True),
        "open_path": f"/{section}/{uid}", "place_ref": extra.pop("place_ref", None), "updated_at": "2026-11-09T10:00:00Z",
    }  # fmt: skip


class Meridian:
    """Nexus and Meridian as Atlas sees them, through nexus.call."""

    def __init__(self):
        self.items = []
        self.availability = "available"
        self.raises = None
        self.page = 100

    def __call__(self, method, path, body=None):
        if self.raises:
            raise self.raises
        assert method == "POST" and path == "/projections/query"
        assert body["module"] == "meridian" and body["projection"] == "contact-addresses"
        if self.availability != "available":
            return {"availability": self.availability}
        offset = int(body["cursor"] or 0)
        following = offset + self.page if offset + self.page < len(self.items) else None
        return {"availability": "available", "items": self.items[offset : offset + self.page], "next_cursor": str(following) if following else None}


class Provider:
    def __init__(self):
        self.queries = []
        self.answers = {}
        self.fail = False

    def __call__(self, url, headers):
        if self.fail:
            raise OSError("no network")
        from urllib.parse import parse_qs, urlparse

        q = parse_qs(urlparse(url).query)["q"][0]
        self.queries.append(q)
        return 200, {}, json.dumps(self.answers.get(q, [])).encode()


def hit(lat, lon, importance=0.5, name="x"):
    return {"lat": str(lat), "lon": str(lon), "name": name, "display_name": f"{name}, Slovakia", "importance": importance, "osm_type": "node", "osm_id": 1}


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_RESOLVER_KEY", KEY)
    monkeypatch.setattr(maps, "GEOCODE_INTERVAL", 0)
    meridian = Meridian()
    provider = Provider()
    monkeypatch.setattr(nexus, "call", meridian)

    class World:
        pass

    w = World()
    w.meridian, w.provider, w.dir = meridian, provider, tmp_path

    def start():
        w.app = create_app(tmp_path, fetch=provider, background=False)
        w.client = TestClient(w.app)
        w.client.headers.update(GW)
        return w.client

    w.start = start
    start()

    def consent():
        settings = w.client.get("/api/map-settings").json()
        assert w.client.put("/api/map-settings", json={"online": True, "tile_url": settings["tile_url"], "geocoder_url": settings["geocoder_url"]}).status_code == 200
        assert w.client.put("/api/contacts/settings", json={"geocoding": True}).status_code == 200

    w.consent = consent

    def layer():
        out = w.client.get("/api/contacts").json()
        return out, {i["id"]: i for i in out["items"]}

    w.layer = layer

    def locate():
        w.client.get("/api/contacts")
        w.app.state.locator.run()
        return layer()

    w.locate = locate
    return w


def cats(client):
    return {c["name"]: c for c in client.get("/api/categories").json()["items"]}


def place(client, name="Somewhere", **extra):
    r = client.post("/api/places", json={"name": name, "latitude": 48.1, "longitude": 17.1, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def keep(p, **changes):
    fields = ("name", "description", "category_id", "marker_color", "marker_icon", "address", "latitude", "longitude", "favorite", "want_to_visit", "inactive", "tags")
    return {**{k: p[k] for k in fields}, **changes}


# ── Category CRUD ──


def test_starter_categories_are_ordinary_editable_data(world):
    all_of = cats(world.client)
    for name in ("Home", "Travel", "Food", "Nature", "Accommodation", "Entertainment", "Landmarks"):
        assert all_of[name]["system"] is None and markers.COLOR.fullmatch(all_of[name]["color"]) and all_of[name]["icon"] in markers.ICONS
    food = all_of["Food"]
    r = world.client.put(f"/api/categories/{food['id']}", json={"name": "Eating out", "color": "#112233", "icon": "coffee", "description": "Cafés"})
    assert r.status_code == 200 and r.json()["id"] == food["id"] and r.json()["name"] == "Eating out"


def test_category_create_validate_and_unique_names(world):
    c = world.client
    r = c.post("/api/categories", json={"name": "Dogs", "color": "#ABCDEF", "icon": "dog", "description": "Good ones"})
    assert r.status_code == 201 and r.json()["color"] == "#abcdef"
    assert c.post("/api/categories", json={"name": "dogs", "color": "#000000", "icon": "dog"}).status_code == 409
    assert "colour" in c.post("/api/categories", json={"name": "Bad", "color": "red", "icon": "dog"}).json()["detail"]
    assert "icon" in c.post("/api/categories", json={"name": "Bad", "color": "#000000", "icon": "<script>"}).json()["detail"]
    assert c.post("/api/categories", json={"name": "meridian", "color": "#000000", "icon": "dog"}).status_code == 409


def test_deleting_a_category_never_loses_places(world):
    c = world.client
    all_of = cats(c)
    p1 = place(c, "One", category_id=all_of["Food"]["id"], marker_color="#123456")
    p2 = place(c, "Two", category_id=all_of["Food"]["id"])
    r = c.delete(f"/api/categories/{all_of['Food']['id']}")
    assert r.json() == {"deleted": True, "places_kept": 2}
    one, two = c.get(f"/api/places/{p1['id']}").json(), c.get(f"/api/places/{p2['id']}").json()
    assert one["category_id"] is None and one["marker"]["color"] == "#123456" and one["marker"]["icon"] == "map-pin"
    assert two["marker"]["color"] == markers.DEFAULT_APPEARANCE["color"]


def test_deleting_a_category_can_move_its_places(world):
    c = world.client
    all_of = cats(c)
    p = place(c, category_id=all_of["Food"]["id"])
    c.delete(f"/api/categories/{all_of['Food']['id']}?move_to={all_of['Travel']['id']}")
    assert c.get(f"/api/places/{p['id']}").json()["category"] == "Travel"
    assert c.get("/api/places", params={"q": "travel"}).json()["items"]
    assert c.get("/api/places", params={"q": "food"}).json()["items"] == []


def test_rename_follows_into_search(world):
    c = world.client
    food = cats(c)["Food"]
    place(c, "Bistro", category_id=food["id"])
    c.put(f"/api/categories/{food['id']}", json={"name": "Gastronomy", "color": food["color"], "icon": food["icon"]})
    assert [p["name"] for p in c.get("/api/places", params={"q": "gastronomy"}).json()["items"]] == ["Bistro"]
    assert c.get("/api/places", params={"category": food["id"]}).json()["items"][0]["category"] == "Gastronomy"


def test_meridian_category_is_system_managed(world):
    c = world.client
    m = cats(c)["Meridian"]
    assert m["system"] == "meridian" and m["color"] == BRONZE and m["icon"] == PERSON_ICON
    assert c.put(f"/api/categories/{m['id']}", json={"name": "Friends", "color": "#000000", "icon": "dog"}).status_code == 403
    assert c.delete(f"/api/categories/{m['id']}").status_code == 403
    assert "automatically" in c.post("/api/places", json={"name": "No", "category_id": m["id"]}).json()["detail"]


def test_the_meridian_colour_is_meridians_own_token():
    css = (ROOT.parent / "meridian/frontend/style.css").read_text(encoding="utf-8")
    assert f"--accent: {BRONZE};" in css


# ── Migration ──


def old_database(path, rows):
    db = sqlite3.connect(path)
    for sql in MIGRATIONS[:2]:
        db.executescript(sql)
    db.execute("PRAGMA user_version=2")
    for pid, category in rows:
        db.execute("INSERT INTO places(id,name,category,search_text,created_at,updated_at) VALUES(?,?,?,?,?,?)", (pid, f"Place {pid[-1]}", category, f"place {pid[-1]} {category}", "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z"))
    db.execute("UPDATE places SET trashed_at='2026-11-02T00:00:00Z' WHERE id=?", (rows[-1][0],))
    db.commit()
    db.close()


def test_free_text_categories_migrate_without_loss(tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_RESOLVER_KEY", KEY)
    ids = [f"0190f0e4-0000-7000-8000-00000000010{i}" for i in range(7)]
    old_database(tmp_path / "atlas.sqlite3", list(zip(ids, ["food", "friends", "Weird shed", "", "landmark", "meridian", "culture"], strict=True)))
    c = TestClient(create_app(tmp_path, background=False))
    c.headers.update(GW)
    all_of = cats(c)
    got = {p["id"]: p for p in c.get("/api/places").json()["items"]}
    assert len(got) == 6  # one is in Trash
    assert got[ids[0]]["category_id"] == all_of["Food"]["id"]  # joined the starter
    assert got[ids[1]]["category"] == "Friends" and got[ids[1]]["marker"]["icon"] == "users"
    assert got[ids[2]]["category"] == "Weird shed" and got[ids[2]]["marker"]["icon"] == "map-pin"
    assert got[ids[3]]["category_id"] is None
    assert got[ids[4]]["category"] == "Landmarks"
    assert got[ids[5]]["category"] == "Meridian places" and all_of["Meridian"]["system"] == "meridian"
    assert c.get("/api/trash").json()["items"][0]["category"] == "Culture"
    db = sqlite3.connect(tmp_path / "atlas.sqlite3")
    assert db.execute("PRAGMA user_version").fetchone()[0] == len(MIGRATIONS)
    assert db.execute("SELECT category FROM places WHERE id=?", (ids[1],)).fetchone()[0] == "friends"  # old text kept


def test_a_backup_from_before_the_categories_restores_and_migrates(tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_RESOLVER_KEY", KEY)
    old = tmp_path / "old.sqlite3"
    pid = "0190f0e4-0000-7000-8000-000000000201"
    old_database(old, [(pid, "nature"), ("0190f0e4-0000-7000-8000-000000000202", "work")])
    data = tmp_path / "data"
    c = TestClient(create_app(data, background=False))
    c.headers.update(GW)
    headers = {"x-nexus-resolver-key": KEY, "X-Empyrean-Backup-Module": "atlas", "X-Empyrean-Backup-Format": "atlas-sqlite", "X-Empyrean-Backup-Format-Version": "1"}
    assert c.post("/empyrean/v1/backup/restore", content=old.read_bytes(), headers=headers).status_code == 200
    assert c.get(f"/api/places/{pid}").json()["category"] == "Nature"


# ── Inheritance and per-place overrides ──


def test_a_place_inherits_and_follows_its_category(world):
    c = world.client
    food = cats(c)["Food"]
    p = place(c, category_id=food["id"])
    assert p["marker"] == {"color": food["color"], "icon": food["icon"], "color_custom": False, "icon_custom": False}
    c.put(f"/api/categories/{food['id']}", json={"name": "Food", "color": "#010203", "icon": "soup"})
    after = c.get(f"/api/places/{p['id']}").json()["marker"]
    assert after["color"] == "#010203" and after["icon"] == "soup"


def test_an_override_survives_category_changes_one_property_at_a_time(world):
    c = world.client
    food = cats(c)["Food"]
    p = place(c, "Red cafe", category_id=food["id"], marker_color="#FF0000", marker_icon="coffee")
    assert p["marker"]["color"] == "#ff0000" and p["marker"]["icon"] == "coffee" and p["marker"]["color_custom"]
    c.put(f"/api/categories/{food['id']}", json={"name": "Food", "color": "#010203", "icon": "soup"})
    assert c.get(f"/api/places/{p['id']}").json()["marker"]["color"] == "#ff0000"
    icon_only = c.put(f"/api/places/{p['id']}", json=keep(p, marker_color=None)).json()
    assert icon_only["marker"] == {"color": "#010203", "icon": "coffee", "color_custom": False, "icon_custom": True}


def test_reset_to_category_defaults(world):
    c = world.client
    food = cats(c)["Food"]
    p = place(c, category_id=food["id"], marker_color="#ff0000", marker_icon="coffee")
    reset = c.put(f"/api/places/{p['id']}", json=keep(p, marker_color=None, marker_icon=None)).json()
    assert reset["marker"] == {"color": food["color"], "icon": food["icon"], "color_custom": False, "icon_custom": False}


def test_a_custom_colour_does_not_change_membership(world):
    c = world.client
    all_of = cats(c)
    p = place(c, category_id=all_of["Food"]["id"], marker_color=all_of["Nature"]["color"], marker_icon=all_of["Nature"]["icon"])
    assert [x["id"] for x in c.get("/api/places", params={"category": all_of["Food"]["id"]}).json()["items"]] == [p["id"]]
    assert c.get("/api/places", params={"category": all_of["Nature"]["id"]}).json()["items"] == []


def test_place_marker_values_are_validated(world):
    c = world.client
    assert c.post("/api/places", json={"name": "x", "marker_color": "#12"}).status_code == 422
    assert c.post("/api/places", json={"name": "x", "marker_icon": "nope"}).status_code == 422


def test_no_category_filter(world):
    c = world.client
    place(c, "Plain")
    place(c, "Fed", category_id=cats(c)["Food"]["id"])
    assert [p["name"] for p in c.get("/api/places", params={"category": "none"}).json()["items"]] == ["Plain"]


# ── The Meridian layer ──


def test_addresses_appear_without_creating_places_or_copying_people(world):
    world.meridian.items = [address()]
    world.provider.answers["Hlavná 1, 811 01 Bratislava, Slovakia"] = [hit(48.14, 17.1)]
    world.consent()
    out, items = world.locate()
    item = items[A1]
    assert out["availability"] == "available" and item["status"] == "located" and item["latitude"] == 48.14
    assert item["marker"]["color"] == BRONZE and item["marker"]["icon"] == PERSON_ICON and item["name"] == "Alžbeta Nováková"
    assert world.client.get("/api/places").json()["items"] == []
    raw = (world.dir / "atlas.sqlite3").read_bytes() + b"".join(p.read_bytes() for p in world.dir.glob("atlas.sqlite3-*"))
    assert "Nováková".encode() not in raw and "Hlavná".encode() not in raw


def test_exact_deep_link_for_every_kind_of_contact(world):
    world.meridian.items = [address(), address(A2, ORG, name="Acme", street="Mlynská 2")]
    _, items = world.layer()
    assert items[A1]["open_path"] == "/people/0190f0e4-0000-7000-8000-0000000000a1"
    assert items[A2]["open_path"] == "/organizations/0190f0e4-0000-7000-8000-0000000000a3" and items[A2]["kind"] == "organization"


def test_every_page_of_the_projection_is_read(world):
    world.meridian.page = 2
    world.meridian.items = [address(f"0190f0e4-0000-7000-8000-00000000030{i}", street=f"Ulica {i}") for i in range(5)]
    _, items = world.layer()
    assert len(items) == 5


def test_nothing_is_sent_without_consent(world):
    world.meridian.items = [address()]
    out, items = world.locate()
    assert items[A1]["status"] == "pending" and world.provider.queries == [] and out["geocoding"] is False
    settings = world.client.get("/api/map-settings").json()
    world.client.put("/api/contacts/settings", json={"geocoding": True})
    world.locate()
    assert world.provider.queries == [] and settings["online"] is False  # the online map is a separate consent


@pytest.mark.parametrize(
    "item, sent",
    [
        (address(name="Eva Malá", street="Dlhá 5"), "Dlhá 5, 811 01 Bratislava, Slovakia"),
        (address(name="Eva Malá", street="c/o Eva Malá"), "811 01 Bratislava, Slovakia"),
        (address(name="Eva Malá", parts={"street": "Eva Malá", "locality": "Košice"}), "Košice"),
        (address(name="Acme Corp", parts={}, text="Acme Corp\nMlynská 2\nBratislava"), "Mlynská 2, Bratislava"),
    ],
)
def test_only_geography_reaches_the_provider(world, item, sent):
    world.meridian.items = [item]
    world.consent()
    world.locate()
    assert world.provider.queries == [sent]


def test_an_address_with_no_geography_is_not_eligible(world):
    world.meridian.items = [address(parts={}, text="c/o Someone")]
    assert world.layer()[1] == {}


def test_contacts_at_one_address_share_a_group_and_one_lookup(world):
    world.meridian.items = [address(A1, PERSON), address(A2, OTHER, name="Peter Novák")]
    world.provider.answers["Hlavná 1, 811 01 Bratislava, Slovakia"] = [hit(48.14, 17.1)]
    world.consent()
    _, items = world.locate()
    assert items[A1]["group"] == items[A2]["group"] == "48.14000,17.10000"
    assert items[A1]["id"] != items[A2]["id"] and items[A1]["resource"] != items[A2]["resource"]
    assert len(world.provider.queries) == 1


def test_a_second_contact_reuses_a_known_address(world):
    world.meridian.items = [address(A1, PERSON)]
    world.provider.answers["Hlavná 1, 811 01 Bratislava, Slovakia"] = [hit(48.14, 17.1)]
    world.consent()
    world.locate()
    world.meridian.items.append(address(A2, OTHER, name="Peter Novák"))
    _, items = world.locate()
    assert items[A2]["status"] == "located" and len(world.provider.queries) == 1


def test_an_address_change_moves_the_marker_and_keeps_its_appearance(world):
    world.meridian.items = [address()]
    world.provider.answers = {"Hlavná 1, 811 01 Bratislava, Slovakia": [hit(48.14, 17.1)], "Nová 9, 811 01 Bratislava, Slovakia": [hit(48.2, 17.2)]}
    world.consent()
    world.locate()
    world.client.put("/api/contacts/markers", json={"scope": "address", "source": A1, "color": "#ff00aa", "icon": "heart-solid"})
    world.meridian.items = [address(street="Nová 9")]
    _, items = world.layer()
    assert items[A1]["status"] == "pending" and items[A1]["latitude"] is None  # never a stale position
    _, items = world.locate()
    assert items[A1]["latitude"] == 48.2 and items[A1]["marker"]["color"] == "#ff00aa" and items[A1]["marker"]["icon"] == "heart-solid"


def test_editing_something_else_changes_nothing(world):
    world.meridian.items = [address()]
    world.provider.answers["Hlavná 1, 811 01 Bratislava, Slovakia"] = [hit(48.14, 17.1)]
    world.consent()
    world.locate()
    world.client.put(f"/api/contacts/{A1}/location", json={"latitude": 48.5, "longitude": 17.5})
    world.meridian.items = [address(name="Alžbeta Veľká", address_label="Cottage")]
    _, items = world.locate()
    assert items[A1]["latitude"] == 48.5 and items[A1]["name"] == "Alžbeta Veľká" and items[A1]["source"] == "manual"
    assert len(world.provider.queries) == 1


def test_contact_and_address_overrides_are_separate(world):
    world.meridian.items = [address(A1, PERSON), address(A2, PERSON, street="Work 2", address_label="Work", primary=False), address(A3, OTHER, name="Peter", street="Iná 3")]
    c = world.client
    c.put("/api/contacts/markers", json={"scope": "contact", "source": PERSON, "color": "#0000ff", "icon": "house"})
    c.put("/api/contacts/markers", json={"scope": "address", "source": A2, "icon": "briefcase"})
    _, items = world.layer()
    assert items[A1]["marker"] == {"color": "#0000ff", "color_origin": "contact", "icon": "house", "icon_origin": "contact"}
    assert items[A2]["marker"] == {"color": "#0000ff", "color_origin": "contact", "icon": "briefcase", "icon_origin": "address"}
    assert items[A3]["marker"]["color"] == BRONZE and items[A3]["marker"]["color_origin"] == "meridian"
    assert items[A1]["siblings"] == 1 and items[A3]["siblings"] == 0


def test_reset_to_meridian_defaults(world):
    world.meridian.items = [address()]
    c = world.client
    c.put("/api/contacts/markers", json={"scope": "contact", "source": PERSON, "color": "#0000ff", "icon": "house"})
    c.put("/api/contacts/markers", json={"scope": "contact", "source": PERSON, "color": None, "icon": None})
    assert world.layer()[1][A1]["marker"]["color_origin"] == "meridian"
    assert sqlite3.connect(world.dir / "atlas.sqlite3").execute("SELECT count(*) FROM marker_overrides").fetchone()[0] == 0


def test_override_identifiers_are_validated(world):
    c = world.client
    assert c.put("/api/contacts/markers", json={"scope": "contact", "source": "Alžbeta", "color": "#000000"}).status_code == 422
    assert c.put("/api/contacts/markers", json={"scope": "address", "source": "48.1,17.1", "color": "#000000"}).status_code == 422
    assert c.put("/api/contacts/markers", json={"scope": "contact", "source": "nexus:v1:chronos:event:abc", "color": "#000000"}).status_code == 422


def test_everything_survives_a_restart(world):
    world.meridian.items = [address()]
    world.provider.answers["Hlavná 1, 811 01 Bratislava, Slovakia"] = [hit(48.14, 17.1)]
    world.consent()
    world.locate()
    c = world.client
    c.put("/api/contacts/markers", json={"scope": "address", "source": A1, "color": "#00ff00", "icon": "tree-pine"})
    custom = c.post("/api/categories", json={"name": "Keep", "color": "#111111", "icon": "dog"}).json()
    p = place(c, category_id=custom["id"], marker_icon="cat")
    c.put("/api/map-filters", json={"contacts": False, "hidden_categories": [custom["id"]]})
    c = world.start()
    _, items = world.layer()
    assert items[A1]["marker"]["icon"] == "tree-pine" and items[A1]["latitude"] == 48.14
    assert c.get(f"/api/places/{p['id']}").json()["marker"] == {"color": "#111111", "icon": "cat", "color_custom": False, "icon_custom": True}
    f = c.get("/api/map-filters").json()
    assert f["contacts"] is False and f["hidden_categories"] == [custom["id"]] and f["places"] is True
    assert world.provider.queries == ["Hlavná 1, 811 01 Bratislava, Slovakia"]


def test_layer_filter_defaults_and_validation(world):
    c = world.client
    f = c.get("/api/map-filters").json()
    assert f["places"] and f["contacts"] and f["current_addresses"] and not f["former_addresses"]
    assert c.put("/api/map-filters", json={"unknown": True}).status_code == 422


def test_hiding_the_layer_deletes_nothing(world):
    world.meridian.items = [address()]
    world.client.put("/api/contacts/markers", json={"scope": "address", "source": A1, "color": "#00ff00"})
    world.client.put("/api/map-filters", json={"contacts": False})
    assert world.layer()[1][A1]["marker"]["color"] == "#00ff00"


def test_current_and_former_addresses(world):
    world.meridian.items = [address(A1), address(A2, street="Stará 2", current=False, primary=False)]
    _, items = world.layer()
    assert items[A1]["current"] is True and items[A2]["current"] is False


def test_an_ambiguous_answer_waits_for_the_owner(world):
    world.meridian.items = [address()]
    world.provider.answers["Hlavná 1, 811 01 Bratislava, Slovakia"] = [hit(48.14, 17.1, 0.5, "A"), hit(49.0, 20.0, 0.48, "B")]
    world.consent()
    _, items = world.locate()
    assert items[A1]["status"] == "ambiguous" and items[A1]["latitude"] is None and len(items[A1]["candidates"]) == 2
    choice = items[A1]["candidates"][1]
    assert world.client.put(f"/api/contacts/{A1}/location", json={"latitude": choice["latitude"], "longitude": choice["longitude"]}).status_code == 200
    _, items = world.locate()
    assert items[A1]["status"] == "located" and items[A1]["latitude"] == 49.0 and items[A1]["source"] == "manual" and "candidates" not in items[A1]


def test_nearby_or_minor_results_are_not_ambiguous(world):
    world.meridian.items = [address()]
    world.provider.answers["Hlavná 1, 811 01 Bratislava, Slovakia"] = [hit(48.14, 17.1, 0.6), hit(48.1405, 17.1, 0.6), hit(49.0, 20.0, 0.2)]
    world.consent()
    assert world.locate()[1][A1]["status"] == "located"


def test_not_found_can_be_tried_again_or_placed_by_hand(world):
    world.meridian.items = [address()]
    world.consent()
    assert world.locate()[1][A1]["status"] == "not_found"
    world.provider.answers["Hlavná 1, 811 01 Bratislava, Slovakia"] = [hit(48.14, 17.1)]
    assert world.locate()[1][A1]["status"] == "not_found"  # it does not hammer the provider
    world.client.post(f"/api/contacts/{A1}/locate-again")
    assert world.locate()[1][A1]["status"] == "located"


def test_correcting_an_unknown_address_is_refused(world):
    assert world.client.put(f"/api/contacts/{A4}/location", json={"latitude": 1, "longitude": 2}).status_code == 404
    assert world.client.put("/api/contacts/not-an-id/location", json={"latitude": 1, "longitude": 2}).status_code == 404


def test_a_network_failure_leaves_addresses_waiting(world):
    world.meridian.items = [address()]
    world.consent()
    world.provider.fail = True
    _, items = world.locate()
    assert items[A1]["status"] == "pending"


@pytest.mark.parametrize(
    "availability", ["module_uninstalled", "module_disabled", "temporarily_unavailable", "forbidden", "not_provided"]
)
def test_an_unavailable_meridian_hides_markers_and_loses_nothing(world, availability):
    world.meridian.items = [address()]
    world.provider.answers["Hlavná 1, 811 01 Bratislava, Slovakia"] = [hit(48.14, 17.1)]
    world.consent()
    world.locate()
    world.client.put("/api/contacts/markers", json={"scope": "address", "source": A1, "color": "#00ff00"})
    world.meridian.availability = availability
    out, items = world.layer()
    assert out["availability"] == availability and items == {}
    world.meridian.availability = "available"
    _, items = world.layer()
    assert items[A1]["latitude"] == 48.14 and items[A1]["marker"]["color"] == "#00ff00"


def test_permission_refused_and_nexus_unreachable(world):
    world.meridian.raises = nexus.NexusRefused(403)
    assert world.layer()[0]["availability"] == "not_granted"
    world.meridian.raises = nexus.NexusUnavailable("down")
    assert world.layer()[0]["availability"] == "nexus_unreachable"
    assert world.client.get("/api/places").status_code == 200


def test_the_layer_needs_the_gateway(world):
    assert TestClient(world.app).get("/api/contacts").status_code == 403


def test_malformed_items_are_ignored(world):
    world.meridian.items = [address(), {"id": "x"}, {**address(A2), "resource": "nexus:v1:chronos:event:abc"}]
    assert list(world.layer()[1]) == [A1]


def test_a_deleted_contact_disappears_and_a_restored_one_keeps_its_corrections(world):
    world.meridian.items = [address()]
    world.client.get("/api/contacts")
    world.client.put(f"/api/contacts/{A1}/location", json={"latitude": 48.5, "longitude": 17.5})
    world.client.put("/api/contacts/markers", json={"scope": "contact", "source": PERSON, "color": "#00ff00"})
    world.meridian.items = []
    assert world.layer()[1] == {}
    assert world.client.put(f"/api/contacts/{A1}/location", json={"latitude": 1, "longitude": 2}).status_code == 404
    world.meridian.items = [address()]
    item = world.layer()[1][A1]
    assert item["latitude"] == 48.5 and item["marker"]["color"] == "#00ff00"


def test_a_long_deleted_address_is_forgotten(world):
    world.meridian.items = [address()]
    world.client.get("/api/contacts")
    world.meridian.items = []
    world.client.get("/api/contacts")
    db = sqlite3.connect(world.dir / "atlas.sqlite3")
    db.execute("UPDATE contact_locations SET orphaned_at='2026-01-01T00:00:00Z'")
    db.commit()
    db.close()
    world.client.get("/api/contacts")
    assert sqlite3.connect(world.dir / "atlas.sqlite3").execute("SELECT count(*) FROM contact_locations").fetchone()[0] == 0


def test_a_linked_atlas_place_supplies_the_position(world):
    p = place(world.client, "Cottage", latitude=48.7, longitude=19.1)
    world.meridian.items = [address(place_ref=p["resource"])]
    item = world.layer()[1][A1]
    assert item["status"] == "located" and item["latitude"] == 48.7 and item["source"] == "place"


def test_manifest_declares_exactly_the_reviewed_scope():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert "projections.read" in manifest["capabilities"]
    assert manifest["projections"]["read"] == [{"module": "meridian", "projection": "contact-addresses"}]


def test_icon_bundle_is_geometry_only_and_has_the_needed_shapes():
    bundle = json.loads((ROOT / "frontend/lucide-icons.json").read_text(encoding="utf-8"))
    for name in ("person-solid", "heart-solid", "coffee", "utensils", "house", "tree-pine", "plane", "trees", "bed-double", "ticket", "landmark", "map-pin"):
        assert name in bundle["icons"]
    for entry in bundle["icons"].values():
        assert "<script" not in entry["m"] and " on" not in entry["m"]
    assert (ROOT / "frontend/LUCIDE-LICENSE").is_file()
