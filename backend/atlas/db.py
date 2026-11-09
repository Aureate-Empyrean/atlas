import sqlite3
from contextlib import contextmanager
from pathlib import Path

from . import markers

# Atlas MVP (roadmap Phase 4): Places, the first of Atlas's geographic resources. Areas, Routes,
# Collections and Visits are part of the architecture and are not built yet.
# - A Place may have no location yet (latitude and longitude are both set or both empty): it can
#   be named, referenced and placed later. It needs no street address and no external POI.
# - favorite and want_to_visit are personal states; inactive marks historical geography, as
#   metadata, never as part of the name.
# - trashed_at moves a Place to Trash; purging deletes it and leaves a tombstone, so references
#   from other modules resolve as deleted (410).
MIGRATIONS = [
    """
CREATE TABLE places(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 category TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
 latitude REAL CHECK(latitude IS NULL OR latitude BETWEEN -90 AND 90),
 longitude REAL CHECK(longitude IS NULL OR longitude BETWEEN -180 AND 180),
 favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
 want_to_visit INTEGER NOT NULL DEFAULT 0 CHECK(want_to_visit IN (0,1)),
 inactive INTEGER NOT NULL DEFAULT 0 CHECK(inactive IN (0,1)),
 search_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 trashed_at TEXT, CHECK((latitude IS NULL) = (longitude IS NULL)));
CREATE INDEX places_live ON places(trashed_at, name);
CREATE TABLE place_tags(place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
 tag TEXT NOT NULL, PRIMARY KEY(place_id, tag));
CREATE INDEX place_tags_tag ON place_tags(tag);
CREATE TABLE tombstones(id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
""",
    # 0.2.0 (ADR 0025): map settings, and where a Place saved from an online search came from.
    # A saved result is the owner's own snapshot; the provider is a source, not an authority.
    """
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
ALTER TABLE places ADD COLUMN external_ref TEXT;
""",
    # 0.3.0 (ADR 0030): categories with stable identifiers, marker appearance, and Atlas's own
    # knowledge about Meridian addresses (a position and a hash; never a name or the address text).
    # `places.category` keeps the old free text, frozen, so this step loses nothing.
    (
        """
CREATE TABLE categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
 color TEXT NOT NULL, icon TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', system TEXT,
 position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
ALTER TABLE places ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE places ADD COLUMN marker_color TEXT;
ALTER TABLE places ADD COLUMN marker_icon TEXT;
CREATE INDEX places_category ON places(category_id);
CREATE TABLE contact_locations(address_id TEXT PRIMARY KEY, query_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','located','ambiguous','not_found')),
 latitude REAL, longitude REAL, source TEXT, candidates TEXT, orphaned_at TEXT, updated_at TEXT NOT NULL);
CREATE TABLE marker_overrides(scope TEXT NOT NULL CHECK(scope IN ('contact','address')),
 source_ref TEXT NOT NULL, color TEXT, icon TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(scope, source_ref));
""",
        markers.seed_categories,
    ),
]


class Database:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migrate()

    def migrate(self):
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > len(MIGRATIONS):
                raise RuntimeError("Database is newer than this application")
            for i in range(version, len(MIGRATIONS)):
                step = MIGRATIONS[i]
                sql, data = step if isinstance(step, tuple) else (step, None)
                db.executescript("BEGIN IMMEDIATE;\n" + sql)
                if data:
                    data(db)
                db.execute(f"PRAGMA user_version={i + 1}")
                db.execute("COMMIT")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()
