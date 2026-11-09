"""Categories and map-marker appearance for Atlas (ADR 0030).

A marker is a coloured pin with a white Lucide icon. Its appearance is resolved, one property at a
time, from the most specific setting: an individual override, then the category, then a default.
Colours and icons never decide which category or layer something belongs to.

Categories have stable identifiers. The starter set is ordinary, editable data. The Meridian
category is system-managed: it stands for the contact-address layer and cannot hold Places.
"""

import json
import re
import uuid
from pathlib import Path

from .util import fold, iso_now

ROOT = Path(__file__).resolve().parents[2]
ICONS = frozenset(json.loads((ROOT / "frontend/lucide-icons.json").read_text(encoding="utf-8"))["icons"])
COLOR = re.compile(r"^#[0-9a-f]{6}$")
NAMESPACE = uuid.UUID("6f1c5e0a-5b1d-5a57-9d42-0a7a7c2f4e10")
NONE = "none"  # the filter value for Places without a category

# Atlas's Sapphire Blue, for a Place with no category.
DEFAULT_APPEARANCE = {"color": "#4285d4", "icon": "map-pin"}
# Meridian's own --accent token (meridian/frontend/style.css), and a solid person.
MERIDIAN_APPEARANCE = {"color": "#c48663", "icon": "person-solid"}
MERIDIAN_NAME = "Meridian"
MERIDIAN_DESCRIPTION = "Addresses of your contacts, kept up to date from Meridian."


def category_id(key):
    return str(uuid.uuid5(NAMESPACE, key))


MERIDIAN_ID = category_id("system:meridian")
STARTERS = (
    ("Home", "#2f80ed", "house", "Where you and yours live."),
    ("Travel", "#0ea5a4", "plane", "Trips and destinations."),
    ("Food", "#f97316", "utensils", "Restaurants, cafés and markets."),
    ("Nature", "#22a55b", "trees", "Parks, trails and viewpoints."),
    ("Accommodation", "#7c5cd6", "bed-double", "Hotels and places to stay."),
    ("Entertainment", "#e0457b", "ticket", "Cinemas, concerts and fun."),
    ("Landmarks", "#e5484d", "landmark", "Monuments and notable sights."),
)
# Words Atlas 0.2.0 suggested in its free-text field, with the appearance each becomes.
LEGACY = {
    "friends": ("#ec4899", "users"),
    "culture": ("#a855f7", "drama"),
    "shop": ("#14b8a6", "shopping-bag"),
    "work": ("#64748b", "briefcase"),
    "other": ("#6b7f99", "map-pin"),
}
ALIASES = {"landmark": "Landmarks", "hotel": "Accommodation", "hotels": "Accommodation"}
UNKNOWN_COLORS = ("#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4", "#ef4444", "#84cc16", "#d946ef")


class Invalid(ValueError):
    pass


def color(value):
    if value is None:
        return None
    text = str(value).strip().lower()
    if not COLOR.fullmatch(text):
        raise Invalid("Enter a colour as six hexadecimal digits, like #4285D4.")
    return text


def icon(value):
    if value is None:
        return None
    if value not in ICONS:
        raise Invalid("Choose an icon from the list.")
    return value


def seed_categories(conn):
    """Part of migration 3: the starter set, the system category, and every free-text category
    already in use. Places keep their old text in `category`, untouched."""
    now = iso_now()
    known = {}

    def add(key, name, col, ico, description, position, system=None):
        cid = MERIDIAN_ID if system else category_id(key)
        conn.execute(
            "INSERT INTO categories(id,name,name_key,color,icon,description,system,position,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (cid, name, fold(name), col, ico, description, system, position, now, now),
        )
        known[fold(name)] = cid
        return cid

    for position, (name, col, ico, description) in enumerate(STARTERS):
        add(f"starter:{name}", name, col, ico, description, position)
    add("system:meridian", MERIDIAN_NAME, MERIDIAN_APPEARANCE["color"], MERIDIAN_APPEARANCE["icon"], MERIDIAN_DESCRIPTION, 1000, system="meridian")
    position = len(STARTERS)
    texts = [r[0] for r in conn.execute("SELECT DISTINCT category FROM places WHERE category<>'' ORDER BY category")]
    for text in texts:
        key = fold(text)
        name = ALIASES.get(key) or text[:1].upper() + text[1:]
        name_key = fold(name)
        if name_key == fold(MERIDIAN_NAME):  # the name is reserved for the system category
            name, name_key = f"{name} places", f"{name_key} places"
        cid = known.get(name_key)
        if not cid:
            col, ico = LEGACY.get(key) or (UNKNOWN_COLORS[position % len(UNKNOWN_COLORS)], "map-pin")
            cid = add(f"legacy:{name_key}", name, col, ico, "", position)
            position += 1
        conn.execute("UPDATE places SET category_id=? WHERE category=?", (cid, text))


def categories(conn):
    return {r["id"]: dict(r) for r in conn.execute("SELECT * FROM categories")}


def category_view(row, places=0):
    return {
        "id": row["id"], "name": row["name"], "color": row["color"], "icon": row["icon"],
        "description": row["description"], "system": row["system"], "places": places,
    }  # fmt: skip


def list_categories(conn):
    counts = dict(conn.execute("SELECT category_id, count(*) FROM places WHERE trashed_at IS NULL AND category_id IS NOT NULL GROUP BY category_id").fetchall())
    rows = conn.execute("SELECT * FROM categories ORDER BY position, name_key").fetchall()
    return [category_view(r, counts.get(r["id"], 0)) for r in rows]


def place_marker(row, cats):
    """Colour and icon for a Place, with where each came from."""
    category = cats.get(row["category_id"]) if row["category_id"] else None
    base = category or DEFAULT_APPEARANCE
    known_icon = row["marker_icon"] if row["marker_icon"] in ICONS else None
    return {
        "color": row["marker_color"] or base["color"],
        "icon": known_icon or base["icon"],
        "color_custom": bool(row["marker_color"]),
        "icon_custom": bool(known_icon),
    }


def contact_marker(contact, address):
    """Colour and icon for a Meridian address: the address's own, then its contact's, then Meridian's."""
    out = {}
    for prop in ("color", "icon"):
        if address and address.get(prop):
            out[prop], out[f"{prop}_origin"] = address[prop], "address"
        elif contact and contact.get(prop):
            out[prop], out[f"{prop}_origin"] = contact[prop], "contact"
        else:
            out[prop], out[f"{prop}_origin"] = MERIDIAN_APPEARANCE[prop], "meridian"
    return out
