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

/** Compass bearing (0-360, 0 = north) from point a to point b. */
export function bearingDeg(a, b) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Signed smallest angle to rotate bearing `a` into bearing `b`, in (-180, 180]. Positive = clockwise/right. */
export function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}

const TURN_SAMPLE_STEP_M = 20;
const TURN_THRESHOLD_DEG = 28;
const TURN_MERGE_DIST_M = 40;

/** Turn points along a route, found by resampling at a fixed spacing and
 * watching for bearing jumps between consecutive samples. Real intersections
 * produce one sharp jump; a curving road's own OSM geometry doesn't, since
 * its vertices are dense along the curve and each per-sample turn stays small. */
export function computeManeuvers(path, cumDist) {
  const total = cumDist[cumDist.length - 1];
  if (total < TURN_SAMPLE_STEP_M * 2) return [];

  const samples = [];
  for (let d = 0; d <= total; d += TURN_SAMPLE_STEP_M) {
    samples.push({ dist: d, pt: pointAtDistance(path, cumDist, d) });
  }
  if (samples[samples.length - 1].dist < total) {
    samples.push({ dist: total, pt: pointAtDistance(path, cumDist, total) });
  }

  const bearings = [];
  for (let i = 0; i < samples.length - 1; i++) {
    bearings.push(bearingDeg(samples[i].pt, samples[i + 1].pt));
  }

  const raw = [];
  for (let i = 1; i < bearings.length; i++) {
    const diff = angleDiff(bearings[i - 1], bearings[i]);
    if (Math.abs(diff) >= TURN_THRESHOLD_DEG) {
      raw.push({ dist: samples[i].dist, angle: diff });
    }
  }

  // Merge candidates from the same physical intersection, keeping the sharpest.
  const merged = [];
  for (const m of raw) {
    const last = merged[merged.length - 1];
    if (last && m.dist - last.dist <= TURN_MERGE_DIST_M) {
      if (Math.abs(m.angle) > Math.abs(last.angle)) merged[merged.length - 1] = m;
    } else {
      merged.push(m);
    }
  }

  return merged.map((m) => ({ dist: m.dist, angle: m.angle, direction: describeDirection(m.angle) }));
}

function describeDirection(angle) {
  const abs = Math.abs(angle);
  const side = angle > 0 ? "right" : "left";
  if (abs >= 150) return "u-turn";
  if (abs >= 100) return `sharp ${side}`;
  if (abs >= 45) return side;
  return `slight ${side}`;
}

/** First upcoming maneuver at or after `currentDist` (small negative tolerance
 * so one just passed isn't re-announced), or null if none remain. */
export function nextManeuver(maneuvers, currentDist) {
  for (const m of maneuvers) {
    if (m.dist >= currentDist - 5) return m;
  }
  return null;
}

/** Closest-point-on-polyline projection: returns { along, offDist }, the
 * cumulative distance along `path` of the point nearest to `pt`, and how far
 * off the route `pt` actually is. Uses a flat/planar approximation per
 * segment (fine at city scale) instead of exact great-circle segment math,
 * since this runs on every live location update. */
export function projectToPath(path, cumDist, pt) {
  let bestDist = Infinity;
  let bestAlong = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.lon - a.lon, dy = b.lat - a.lat;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((pt.lon - a.lon) * dx + (pt.lat - a.lat) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const proj = { lat: a.lat + dy * t, lon: a.lon + dx * t };
    const d = haversineM(pt, proj);
    if (d < bestDist) {
      bestDist = d;
      bestAlong = cumDist[i - 1] + t * (cumDist[i] - cumDist[i - 1]);
    }
  }
  return { along: bestAlong, offDist: bestDist };
}

/** Path points from `along` meters onward, starting with the interpolated
 * split point — the not-yet-driven remainder of the route, so the covered
 * part behind the vehicle can disappear while driving. */
export function remainingPathFrom(path, cumDist, along) {
  const total = cumDist[cumDist.length - 1];
  const d = Math.max(0, Math.min(total, along));
  const pt = pointAtDistance(path, cumDist, d);
  let i = 1;
  while (i < cumDist.length && cumDist[i] < d) i++;
  return [pt, ...path.slice(i)];
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
