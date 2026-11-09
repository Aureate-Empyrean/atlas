# Atlas

The personal geographic layer of Aureate Empyrean: the places that matter to you, on a map and in a library, linked with
the rest of your Empyrean data. Architecture: [`architecture/modules/atlas.md`](../architecture/modules/atlas.md).

**Status: 0.3.0 in production and on aetest, schema 3 ([deployment](../DEPLOYMENT_ATLAS_MERIDIAN_EXODUS_2026-11-09.md), [validation](../VALIDATION_ATLAS_MARKERS_AETEST_2026-11-09.md)).** 0.2.0 has been in production since 2026-11-09 ([deployment](../DEPLOYMENT_PHASE4_5_EXODUS_2026-11-09.md); validated in [Phase 4](../VALIDATION_PHASE4_AETEST_2026-11-09.md) and [0.2.0](../VALIDATION_PHASE5_AETEST_2026-11-09.md)).

| | |
| --- | --- |
| Module ID, version | `atlas`, 0.4.0 (schema 3) on aetest; 0.3.0 in production |
| Port | 19333 |
| Nexus range | `>=0.1.8,<0.2.0` |
| Capabilities | `ui.application`, `storage.data`, `references.read`, `references.resolve`, `projections.read` (only Meridian's `contact-addresses`), `network.egress` (optional, off until the owner turns the online map on) |
| Resources | `place` (resolvable; the label is the name only) |
| Projection provided | `place-directory` v1: query `{q, limit ≤20}`, items `{id, resource, label, category}`. Never coordinates or personal states |
| Backlinks | Follows [the standard](../architecture/concepts/backlinks.md); reads labels for `chronos:event` and `meridian:interaction` |
| Backup | Backup v1, format `atlas-sqlite` |
| Identity | Sapphire Blue (`#A5D8FF`, `#4285D4`, `#194F91`, background `#101A2A`) |

## What it does

Places need only a name. Location, address, category, tags and a short description are optional, as are the favorite,
want-to-visit and historical states. The Map shows Places over OpenStreetMap imagery (once the owner turns it on; [ADR 0025](../architecture/decisions/0025-atlas-openstreetmap-providers.md)), with pan, zoom, pinch, keyboard control,
layers, click-to-place and an explicit place search. Viewed areas stay available offline. The Library searches and filters them.

## Markers and categories (0.3.0)

Every marker is a colored pin with a white [Lucide](https://lucide.dev) icon (ISC, `frontend/LUCIDE-LICENSE`; regenerate the bundle with `scripts/build_icons.py`). Categories are managed under Categories, and a Place can override its color or icon. Meridian's contact addresses appear by themselves in their own layer: Atlas stores positions and appearance only, never names or address text. See [ADR 0030](../architecture/decisions/0030-atlas-markers-categories-and-contact-layer.md).

## Navigation (0.4.0 on aetest)

Sections and Places are browser history entries through the Nexus navigation contract (`frontend/navigation.js`). A
Meridian contact selection is an entry too, at `/map/contact`: the URL never says who it is. The selection, map
position and Library search are private per-entry state. An unsaved Place editor stays open while the address moves,
and is kept as a draft when Atlas is left. See `../empyrean-nexus/docs/navigation-history.md`.

## Limits

Routing, Areas, Routes, Collections and smart views are in the architecture and not built yet. The map style is a basic
first version. See the [validation record](../VALIDATION_PHASE4_AETEST_2026-11-09.md).

## Develop and test

```bash
docker run --rm -v G:/AureateEmpyrean/atlas:/src -v G:/AureateEmpyrean/meridian:/meridian:ro -w /src -e PYTHONPATH=/src/backend aureate-pytest:local python -m pytest -q -p no:cacheprovider tests
```

Build and pin with `docker compose build` and `python scripts/manifest.py`, then install `manifest.local.json` through
Nexus. Browser checks run against aetest only: `tests/e2e/markers_e2e.cjs`, `atlas_e2e.cjs`, `backlinks_e2e.cjs` and `search_map_e2e.cjs`.
