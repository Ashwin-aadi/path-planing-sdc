const BASE = "http://127.0.0.1:8000";

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

export function getBounds() {
  return fetch(`${BASE}/api/graph/bounds`).then(asJson);
}

export function getEdges() {
  return fetch(`${BASE}/api/graph/edges`).then(asJson);
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

export function nearestEdge(lat, lon) {
  return fetch(`${BASE}/api/graph/nearest_edge?lat=${lat}&lon=${lon}`).then(asJson);
}

export function computeRoute({ start, waypoints, weights, emergency }) {
  return fetch(`${BASE}/api/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      start: { lat: start.lat, lon: start.lon },
      waypoints: waypoints.map((w) => ({ lat: w.lat, lon: w.lon })),
      weights,
      emergency,
    }),
  }).then(asJson);
}
