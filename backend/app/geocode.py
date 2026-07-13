"""Free place-name search (geocoding) via OpenStreetMap's Nominatim — no API
key needed, unlike Google/HERE/Mapbox geocoding. Nominatim's usage policy caps
public use at ~1 request/sec and requires an identifying User-Agent; both are
enforced here so the app stays compliant regardless of how often the frontend
calls it (the frontend also only searches on explicit submit, never per-keystroke)."""

import threading
import time

import requests

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "path-planning-robotics-demo/1.0 (local student project, no contact endpoint)"
MIN_INTERVAL_S = 1.1

_lock = threading.Lock()
_last_request_time = 0.0


def _throttle():
    global _last_request_time
    with _lock:
        wait = MIN_INTERVAL_S - (time.monotonic() - _last_request_time)
        if wait > 0:
            time.sleep(wait)
        _last_request_time = time.monotonic()


def search(query, region=None, limit=5):
    """query -> list of {label, lat, lon}. `region`, if given, is
    (center_lat, center_lon, radius_m): softly biases results toward that
    area (bounded=0, so a place with an exact-name match elsewhere still
    shows up) rather than hard-excluding everything outside it."""
    _throttle()
    params = {"q": query, "format": "jsonv2", "limit": limit}
    if region is not None:
        center_lat, center_lon, radius_m = region
        deg = radius_m / 111_000  # rough meters-to-degrees at these latitudes
        params["viewbox"] = f"{center_lon - deg},{center_lat + deg},{center_lon + deg},{center_lat - deg}"
        params["bounded"] = 0

    resp = requests.get(NOMINATIM_URL, params=params, headers={"User-Agent": USER_AGENT}, timeout=10)
    resp.raise_for_status()
    return [
        {"label": item["display_name"], "lat": float(item["lat"]), "lon": float(item["lon"])}
        for item in resp.json()
    ]
