"""Generate frontend/lucide-icons.json from an installed lucide-static package.

    python scripts/build_icons.py <path to node_modules/lucide-static>

The Atlas page runs in the Nexus sandbox with no network, so the icons it offers are bundled. Only
the curated names below are kept, as geometry alone. The `-solid` entries are the same Lucide
geometry filled, for shapes that read better as a silhouette at pin size.
"""

import json
import re
import sys
from pathlib import Path

CURATED = """
map-pin map-pinned map compass navigation globe earth route signpost milestone flag flag-triangle-right pin locate
house house-plus hotel building building-complex castle church landmark school university hospital factory store warehouse
door-open key key-round fence tent tent-tree caravan
bed bed-double bed-single sofa armchair lamp bath shower-head toilet
utensils utensils-crossed coffee cup-soda wine beer martini pizza sandwich soup salad cake cake-slice cookie croissant
ice-cream-cone donut popcorn fish apple cherry grape banana carrot egg-fried chef-hat cooking-pot milk wheat vegan
tree-pine tree-deciduous tree-palm trees mountain mountain-snow flower flower-2 leaf sprout sun sunrise sunset moon
cloud snowflake waves-horizontal droplet droplets flame shell bird bug dog cat rabbit squirrel turtle paw-print
plane plane-takeoff plane-landing train-front train-track tram-front bus bus-front car car-front car-taxi-front bike
ship sailboat anchor fuel parking-meter luggage backpack binoculars tractor footprints rocket
camera image ticket clapperboard film tv list-music keyboard-music mic mic-vocal guitar piano drum headphones gamepad-2 dices
puzzle palette brush drama party-popper sparkles ferris-wheel tower-control telescope
book book-open library graduation-cap pencil briefcase briefcase-business laptop monitor printer wrench hammer
construction microscope flask-conical atom
shopping-bag shopping-cart shopping-basket gift shirt gem scissors banknote wallet credit-card piggy-bank scale gavel vote
stethoscope pill syringe cross heart-pulse activity dumbbell volleyball trophy medal goal
user user-round users users-round baby contact handshake heart heart-handshake star bookmark tag crown shield
lock bell clock calendar phone mail wifi zap plug lightbulb recycle umbrella skull ghost circle square triangle hexagon
""".split()
# Lucide geometry drawn filled: (name, source icon, extra search words).
SOLID = [
    ("person-solid", "user-round", "person contact silhouette people human"),
    ("heart-solid", "heart", "love favourite favorite"),
    ("star-solid", "star", "favourite favorite rating"),
]
ALLOWED = {"path", "circle", "rect", "line", "polyline", "polygon", "ellipse"}
ATTR = re.compile(r"^[a-z0-9.,\s#%-]+$", re.I)


def markup(nodes, solid=False):
    parts = []
    for tag, attrs in nodes:
        if tag not in ALLOWED:
            raise SystemExit(f"unexpected element {tag}")
        attrs = {k: v for k, v in attrs.items() if k != "key"}
        for value in attrs.values():
            if not ATTR.fullmatch(str(value)):
                raise SystemExit(f"unexpected attribute value {value}")
        if solid:
            attrs["fill"] = "currentColor"
        parts.append(f"<{tag} " + " ".join(f'{k}="{v}"' for k, v in attrs.items()) + "/>")
    return "".join(parts)


def main(package):
    package = Path(package)
    version = json.loads((package / "package.json").read_text(encoding="utf-8"))["version"]
    nodes = json.loads((package / "icon-nodes.json").read_text(encoding="utf-8"))
    tags = json.loads((package / "tags.json").read_text(encoding="utf-8"))
    missing = [n for n in CURATED if n not in nodes]
    if missing:
        print("not in this Lucide version, skipped:", " ".join(missing))
    icons = {}
    for name in dict.fromkeys(CURATED):
        if name in nodes:
            icons[name] = {"m": markup(nodes[name]), "t": " ".join(tags.get(name, []))}
    for name, source, words in SOLID:
        icons[name] = {"m": markup(nodes[source], solid=True), "t": words}
    target = Path(__file__).resolve().parents[1] / "frontend"
    out = json.dumps({"version": version, "icons": icons}, separators=(",", ":"), ensure_ascii=True)
    (target / "lucide-icons.json").write_text(out + "\n", encoding="utf-8", newline="\n")
    (target / "LUCIDE-LICENSE").write_bytes((package / "LICENSE").read_bytes())
    print(len(icons), "icons,", len(out), "bytes, Lucide", version)


if __name__ == "__main__":
    main(sys.argv[1])
