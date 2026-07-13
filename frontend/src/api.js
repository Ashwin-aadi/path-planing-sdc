// Set VITE_API_BASE at build time (e.g. Vercel project env vars) to point a
// deployed frontend at a deployed backend; falls back to local dev default.
const BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";

async function asJson(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail)
      ? body.detail.map((e) => e.msg || JSON.stringify(e)).join("; ")
      : body.detail;
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return res.json();
}

export function getRegions() {
  return fetch(`${BASE}/api/regions`).then(asJson);
}

export function getNearestRegion(lat, lon) {
  return fetch(`${BASE}/api/nearest_region?lat=${lat}&lon=${lon}`).then(asJson);
}

export function geocodeSearch(query, region) {
  const params = new URLSearchParams({ q: query });
  if (region) params.set("region", region);
  return fetch(`${BASE}/api/geocode?${params}`).then(asJson);
}

export function getBounds(region) {
  const q = region ? `?region=${region}` : "";
  return fetch(`${BASE}/api/graph/bounds${q}`).then(asJson);
}

export function getEdges(bounds, region) {
  const params = bounds
    ? { min_lat: bounds.min_lat, max_lat: bounds.max_lat, min_lon: bounds.min_lon, max_lon: bounds.max_lon }
    : {};
  if (region) params.region = region;
  const q = Object.keys(params).length ? `?${new URLSearchParams(params)}` : "";
  return fetch(`${BASE}/api/graph/edges${q}`).then(asJson);
}

export function getBlocks() {
  return fetch(`${BASE}/api/blocks`).then(asJson);
}

export function toggleBlock(u, v) {
  return fetch(`${BASE}/api/blocks/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ u, v }),
  }).then(asJson);
}

export function setBlock(u, v, blocked) {
  return fetch(`${BASE}/api/blocks/set`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ u, v, blocked }),
  }).then(asJson);
}

export function clearBlocks() {
  return fetch(`${BASE}/api/blocks`, { method: "DELETE" }).then(asJson);
}

export function nearestEdge(lat, lon, region) {
  const q = region ? `&region=${region}` : "";
  return fetch(`${BASE}/api/graph/nearest_edge?lat=${lat}&lon=${lon}${q}`).then(asJson);
}

export function computeRoute({ start, waypoints, weights, emergency, region }) {
  return fetch(`${BASE}/api/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      start: { lat: start.lat, lon: start.lon },
      waypoints: waypoints.map((w) => ({ lat: w.lat, lon: w.lon })),
      weights,
      emergency,
      region,
    }),
  }).then(asJson);
}
