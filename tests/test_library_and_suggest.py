"""Atlas 0.5.0: Meridian addresses as Library entries, and address suggestions for Meridian."""

import json

import pytest
from atlas import maps
from atlas.maps import parse_suggestion
from test_markers import A1, A2, KEY, PERSON, address, world  # noqa: F401

RES = {"x-nexus-resolver-key": KEY}


def feature(**props):
    return {
        "geometry": {"coordinates": [17.1, 48.1]},
        "properties": {"countrycode": "SK", "country": "Slovakia", **props},
    }


def test_a_slovak_address_puts_the_number_after_the_street():
    out = parse_suggestion(
        feature(
            street="Dlhá",
            housenumber="5",
            postcode="811 01",
            city="Testovo",
            state="Bratislavský kraj",
            type="house",
        )
    )
    assert (out["street"], out["postal_code"], out["locality"], out["region"], out["country"]) == (
        "Dlhá 5",
        "811 01",
        "Testovo",
        "Bratislavský kraj",
        "Slovakia",
    )
    assert (out["latitude"], out["longitude"], out["precision"]) == (48.1, 17.1, "house")


def test_an_american_address_puts_the_number_first():
    assert (
        parse_suggestion(
            feature(countrycode="US", street="Main St", housenumber="13", type="house")
        )["street"]
        == "13 Main St"
    )


def test_missing_values_stay_empty():
    out = parse_suggestion(feature(name="Testovo", type="city"))
    assert (out["street"], out["postal_code"], out["region"]) == ("", "", "")
    assert out["locality"] == "Testovo" and out["precision"] == "city"


def test_a_street_without_a_number_is_only_approximate():
    out = parse_suggestion(feature(name="Dlhá", type="street", city="Testovo"))
    assert out["street"] == "Dlhá" and out["precision"] == "street"


def test_a_named_place_keeps_its_name_in_the_label_only():
    out = parse_suggestion(
        feature(name="Synthetic Café", street="Dlhá", housenumber="5", type="amenity")
    )
    assert out["street"] == "Dlhá 5" and out["label"] == "Synthetic Café, Dlhá 5"


class Photon:
    def __init__(self):
        self.urls, self.status, self.fail = [], 200, False
        self.features = [feature(street="Dlhá", housenumber="5", city="Testovo", type="house")]

    def __call__(self, url, headers):
        if self.fail:
            raise OSError("no network")
        self.urls.append(url)
        self.headers = headers
        return self.status, {}, json.dumps({"features": self.features}).encode()


def online(w):
    s = w.client.get("/api/map-settings").json()
    assert (
        w.client.put(
            "/api/map-settings",
            json={"online": True, "tile_url": s["tile_url"], "geocoder_url": s["geocoder_url"]},
        ).status_code
        == 200
    )


def ask(w, query, headers=RES):
    return w.client.post(
        "/empyrean/v1/projections/address-suggest",
        headers=headers,
        json={"requester": "meridian", "query": query, "cursor": None},
    )


@pytest.fixture
def photon(world, monkeypatch):  # noqa: F811
    monkeypatch.setattr(maps, "SUGGEST_INTERVAL", 0)
    stub = Photon()
    world.app.state.maps.quick_fetch = stub
    return stub


def statuses(response):
    return response.json()["items"][0]


def test_the_network_stays_closed_until_atlas_is_online(world, photon):  # noqa: F811
    assert statuses(ask(world, {"q": "Dlhá 5"}))["outcome"] == "atlas_offline"
    assert photon.urls == []


def test_only_the_query_goes_to_the_provider(world, photon):  # noqa: F811
    online(world)
    out = ask(world, {"q": "Dlhá 5"}).json()["items"]
    assert out[0]["kind"] == "status" and out[1]["street"] == "Dlhá 5"
    assert photon.urls == [
        "https://photon.komoot.io/api?q=Dl%C3%A1h+5".replace("Dl%C3%A1h", "Dlh%C3%A1") + "&limit=6"
    ]
    assert set(photon.headers) == {"User-Agent"}


def test_repeated_searches_come_from_the_cache(world, photon):  # noqa: F811
    online(world)
    ask(world, {"q": "Dlhá 5"})
    ask(world, {"q": "dlhá  5"})
    assert len(photon.urls) == 1


def test_requests_are_rate_limited_here(world, photon, monkeypatch):  # noqa: F811
    online(world)
    monkeypatch.setattr(maps, "SUGGEST_INTERVAL", 60)
    assert statuses(ask(world, {"q": "first query"}))["outcome"] == "ok"
    assert statuses(ask(world, {"q": "second query"}))["outcome"] == "busy"
    assert len(photon.urls) == 1


def test_provider_refusals_and_failures_are_outcomes(world, photon):  # noqa: F811
    online(world)
    photon.status = 429
    assert statuses(ask(world, {"q": "first query"}))["outcome"] == "busy"
    photon.status = 500
    assert statuses(ask(world, {"q": "second query"}))["outcome"] == "offline"
    photon.fail = True
    assert statuses(ask(world, {"q": "third query"}))["outcome"] == "offline"


def test_malformed_results_are_skipped(world, photon):  # noqa: F811
    online(world)
    photon.features = [{"nonsense": True}, feature(street="Dlhá", type="street")]
    assert [i["street"] for i in ask(world, {"q": "Dlhá"}).json()["items"][1:]] == ["Dlhá"]


def test_the_projection_needs_the_resolver_key(world, photon):  # noqa: F811
    online(world)
    assert ask(world, {"q": "Dlhá 5"}, headers={"x-nexus-resolver-key": "wrong"}).status_code == 403
    assert photon.urls == []


def test_status_query_touches_no_provider(world, photon):  # noqa: F811
    online(world)
    assert statuses(ask(world, {"status": True}))["provider"] == "Photon"
    assert photon.urls == []


def test_the_suggestion_service_is_configurable_and_kept(world, photon):  # noqa: F811
    s = world.client.get("/api/map-settings").json()
    body = {"online": True, "tile_url": s["tile_url"], "geocoder_url": s["geocoder_url"]}
    assert (
        world.client.put(
            "/api/map-settings", json={**body, "suggest_url": "https://photon.example.org/"}
        ).json()["suggest_url"]
        == "https://photon.example.org"
    )
    assert (
        world.client.put("/api/map-settings", json=body).json()["suggest_url"]
        == "https://photon.example.org"
    )
    assert (
        world.client.put("/api/map-settings", json={**body, "suggest_url": "ftp://x"}).status_code
        == 422
    )


# ── Meridian addresses ──


def placed(aid=A1, resource=PERSON, **extra):
    return {
        **address(aid, resource, **extra),
        "position": {"latitude": 48.2, "longitude": 17.2, "precision": "house"},
    }


def test_a_position_chosen_in_meridian_needs_no_lookup_or_consent(world):  # noqa: F811
    world.meridian.items = [placed()]
    entry = world.layer()[1][A1]
    assert (entry["status"], entry["latitude"], entry["source"]) == ("located", 48.2, "meridian")
    assert world.provider.queries == []


def test_a_pending_address_takes_a_position_when_one_arrives(world):  # noqa: F811
    world.meridian.items = [address()]
    assert world.layer()[1][A1]["status"] == "pending"
    world.meridian.items = [placed()]
    assert world.layer()[1][A1]["latitude"] == 48.2


def test_a_changed_address_loses_its_position(world):  # noqa: F811
    world.meridian.items = [placed()]
    world.layer()
    world.meridian.items = [address(street="Krátka 2")]
    entry = world.layer()[1][A1]
    assert entry["status"] == "pending" and entry["latitude"] is None


def test_an_owner_correction_is_not_overwritten(world):  # noqa: F811
    world.meridian.items = [address()]
    world.layer()
    assert (
        world.client.put(
            f"/api/contacts/{A1}/location", json={"latitude": 49.0, "longitude": 18.0}
        ).status_code
        == 200
    )
    world.meridian.items = [placed()]
    entry = world.layer()[1][A1]
    assert (entry["latitude"], entry["source"]) == (49.0, "manual")


def test_identifiers_and_exact_links_pass_through(world):  # noqa: F811
    path = f"/people/x/addresses/{A1}"
    world.meridian.items = [{**placed(), "open_path": path}]
    entry = world.layer()[1][A1]
    assert (entry["id"], entry["resource"], entry["open_path"]) == (A1, PERSON, path)


def test_several_addresses_of_one_contact_stay_separate(world):  # noqa: F811
    world.meridian.items = [
        placed(A1, primary=True),
        {**placed(A2, primary=False, current=False, street="Krátka 2")},
    ]
    _, entries = world.layer()
    assert set(entries) == {A1, A2} and entries[A1]["siblings"] == 1
    assert entries[A1]["primary"] is True and entries[A2]["current"] is False


def test_a_trashed_contact_disappears_and_returns_with_its_location(world):  # noqa: F811
    world.meridian.items = [placed()]
    world.layer()
    world.meridian.items = []
    assert world.layer()[1] == {}
    world.meridian.items = [placed()]
    assert world.layer()[1][A1]["latitude"] == 48.2


def test_during_an_outage_nothing_stale_is_shown(world):  # noqa: F811
    world.meridian.items = [placed()]
    world.layer()
    world.meridian.availability = "temporarily_unavailable"
    out, entries = world.layer()
    assert out["availability"] == "temporarily_unavailable" and entries == {}
    world.meridian.availability = "available"
    assert world.layer()[1][A1]["latitude"] == 48.2


def test_contact_details_are_not_stored_by_atlas(world):  # noqa: F811
    import sqlite3

    world.meridian.items = [placed(name="Synthetic Stored Name")]
    world.layer()
    raw = (world.dir / "atlas.sqlite3").read_bytes()
    assert b"Synthetic Stored Name" not in raw
    assert (
        sqlite3.connect(world.dir / "atlas.sqlite3")
        .execute("SELECT count(*) FROM places")
        .fetchone()[0]
        == 0
    )


def test_a_person_is_never_sent_to_the_provider_for_a_chosen_address(world):  # noqa: F811
    world.meridian.items = [placed(name="Synthetic Private Name")]
    world.consent()
    world.locate()
    assert not any("Synthetic" in q for q in world.provider.queries)
