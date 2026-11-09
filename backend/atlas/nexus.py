"""The few Nexus module APIs Atlas uses, with its own bearer token (never a browser credential)."""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 4
MAX_LABELS = 40


class NexusUnavailable(Exception):
    pass


class NexusRefused(Exception):
    def __init__(self, status):
        super().__init__(str(status))
        self.status = status


def call(method, path, body=None):
    base = os.getenv("NEXUS_URL", "").rstrip("/")
    token = os.getenv("NEXUS_TOKEN", "")
    if not base or not token:
        raise NexusUnavailable("Not running under Nexus")
    req = urllib.request.Request(
        base + "/api/v1/module" + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read(1024 * 1024))
    except urllib.error.HTTPError as exc:
        raise NexusRefused(exc.code) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise NexusUnavailable(str(exc)) from exc


def linked_from(target):
    """Backlinks standard (architecture/concepts/backlinks.md): resources in other modules that
    link to this one and let Atlas see the link, labelled by their owners. Never raises."""
    query = urllib.parse.urlencode({"resource": target, "direction": "incoming", "limit": 100})
    try:
        page = call("GET", f"/references?{query}")
    except NexusRefused as exc:
        return {"availability": "not_granted" if exc.status == 403 else "nexus_error", "items": []}
    except NexusUnavailable:
        return {"availability": "nexus_unreachable", "items": []}
    items = []
    for edge in page.get("references") or []:
        source = edge.get("source", "")
        parts = source.split(":")
        if len(parts) != 5 or parts[2] == "atlas":
            continue
        entry = {"source": source, "module": parts[2], "type": parts[3],
                 "relation": edge.get("relation", ""), "label": "", "availability": "unknown"}  # fmt: skip
        if len(items) < MAX_LABELS:
            try:
                out = call("POST", "/resources/resolve", {"resource": source})
                entry["availability"] = out.get("availability") or "unknown"
                if entry["availability"] == "available":
                    entry["label"] = str(out.get("label") or "")[:200]
                    entry["open_path"] = (out.get("open") or {}).get("module_path")
            except NexusRefused as exc:
                entry["availability"] = "forbidden" if exc.status == 403 else "unknown"
            except NexusUnavailable:
                entry["availability"] = "temporarily_unavailable"
        items.append(entry)
    return {"availability": "available", "items": items}
