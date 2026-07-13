const R = 6371000;

export function haversineM(a, b) {
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dphi = ((b.lat - a.lat) * Math.PI) / 180;
  const dlmb = ((b.lon - a.lon) * Math.PI) / 180;
  const x = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlmb / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Cumulative distance (meters) at each point of a path, cumDist[0] = 0. */
export function cumulativeDistances(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + haversineM(path[i - 1], path[i]));
  }
  return cum;
}

/** Interpolated {lat, lon} at `targetDist` meters along path, given its cumDist array. */
export function pointAtDistance(path, cumDist, targetDist) {
  const total = cumDist[cumDist.length - 1];
  const d = Math.max(0, Math.min(total, targetDist));

  let lo = 0, hi = cumDist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const segStart = cumDist[i - 1];
  const segEnd = cumDist[i];
  const t = segEnd > segStart ? (d - segStart) / (segEnd - segStart) : 0;

  const a = path[i - 1];
  const b = path[i];
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
  };
}
