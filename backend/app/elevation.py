"""Bulk elevation lookup via the free Open-Elevation API. Used once at graph
build time to compute per-edge slope for the economy cost model; results are
cached on the graph itself (saved into the same graphml cache as everything
else), so this network cost is paid once, not per request."""

import requests

ELEVATION_API_URL = "https://api.open-elevation.com/api/v1/lookup"
BATCH_SIZE = 1000


def fetch_elevations(coords):
    """coords: list of (lat, lon). Returns a list of elevations in meters,
    same order, via batched POST requests to Open-Elevation."""
    elevations = [0.0] * len(coords)
    for start in range(0, len(coords), BATCH_SIZE):
        batch = coords[start:start + BATCH_SIZE]
        locations = [{"latitude": lat, "longitude": lon} for lat, lon in batch]
        resp = requests.post(ELEVATION_API_URL, json={"locations": locations}, timeout=60)
        resp.raise_for_status()
        results = resp.json()["results"]
        for i, r in enumerate(results):
            elevations[start + i] = float(r["elevation"])
    return elevations
