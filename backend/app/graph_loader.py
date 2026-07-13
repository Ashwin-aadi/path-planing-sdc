"""Loads the local drivable OSM graph once, caches it to disk, and
precomputes per-edge cost components so route requests don't have to."""

import math
import os

import networkx as nx
import osmnx as ox
from shapely.geometry import LineString, Point

from app import config

# Fastest road class defines the reference speed used to convert every
# preference (speed/safety) into an equivalent-time cost, in seconds.
REF_SPEED_KPH = max(config.HWY_SPEEDS_KPH.values())
REF_SPEED_MPS = REF_SPEED_KPH / 3.6
MAX_SPEED_KPH = REF_SPEED_KPH

# Every edge keeps at least this fraction of its pure-distance time cost,
# regardless of slider weights. Guarantees no edge is ever free (needed for
# A*/Dijkstra correctness) and keeps the haversine heuristic admissible.
FLOOR_FRACTION = 0.05

_graph = None


def _first(value):
    """OSM tags are sometimes lists (multiple values on a way); take the first."""
    return value[0] if isinstance(value, list) else value


def _build_graph():
    os.makedirs(config.CACHE_DIR, exist_ok=True)
    ox.settings.use_cache = True
    ox.settings.cache_folder = config.CACHE_DIR

    if os.path.exists(config.GRAPHML_PATH):
        G = ox.load_graphml(config.GRAPHML_PATH)
        # graphml round-trips numeric attrs as strings; osmnx's loader restores
        # the well-known ones, but our custom cost attrs need re-typing.
        for _, _, d in G.edges(data=True):
            for key in ("length", "speed_kph", "travel_time_s", "speed_cost_s",
                        "safety_cost_s", "safety_penalty", "floor_s"):
                if key in d:
                    d[key] = float(d[key])
        for _, d in G.nodes(data=True):
            d["y"] = float(d["y"])
            d["x"] = float(d["x"])
        return G

    G = ox.graph_from_point(
        (config.CENTER_LAT, config.CENTER_LON),
        dist=config.GRAPH_RADIUS_M,
        network_type="drive",
        simplify=True,
    )
    G = ox.routing.add_edge_speeds(
        G, hwy_speeds=config.HWY_SPEEDS_KPH, fallback=config.FALLBACK_SPEED_KPH
    )
    G = ox.routing.add_edge_travel_times(G)

    for u, v, d in G.edges(data=True):
        hwy = _first(d.get("highway"))
        length_m = float(d["length"])
        speed_kph = float(d["speed_kph"])

        safety_penalty = config.SAFETY_PENALTY.get(hwy, config.FALLBACK_SAFETY_PENALTY)
        speed_penalty = max(0.0, 1.0 - speed_kph / MAX_SPEED_KPH)

        d["highway"] = hwy or "unclassified"
        d["speed_kph"] = speed_kph
        d["travel_time_s"] = float(d["travel_time"])
        d["safety_penalty"] = safety_penalty
        d["speed_cost_s"] = length_m * speed_penalty / REF_SPEED_MPS
        d["safety_cost_s"] = length_m * safety_penalty / REF_SPEED_MPS
        d["floor_s"] = FLOOR_FRACTION * length_m / REF_SPEED_MPS
        d.pop("travel_time", None)

    ox.save_graphml(G, config.GRAPHML_PATH)
    return G


def get_graph():
    global _graph
    if _graph is None:
        _graph = _build_graph()
    return _graph


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def nearest_node(lat, lon):
    """Brute-force nearest node by haversine distance. The graph is small
    (~6k nodes) so a linear scan is fast enough and avoids requiring
    scikit-learn just for a KD-tree lookup."""
    G = get_graph()
    best_node, best_dist = None, float("inf")
    for node_id, d in G.nodes(data=True):
        dist = haversine_m(lat, lon, d["y"], d["x"])
        if dist < best_dist:
            best_node, best_dist = node_id, dist
    return best_node, best_dist


def edge_latlon_coords(G, u, v, key):
    """Real road shape for one directed edge, as (lat, lon) tuples ordered
    u -> v. osmnx orients each direction's geometry independently, so this
    is safe to use directly without re-checking orientation per call."""
    d = G[u][v][key]
    geom = d.get("geometry")
    if geom is not None:
        return [(lat, lon) for lon, lat in geom.coords]
    return [
        (G.nodes[u]["y"], G.nodes[u]["x"]),
        (G.nodes[v]["y"], G.nodes[v]["x"]),
    ]


def nearest_edge(lat, lon):
    """Snap a click point to the nearest road (for obstacle placement),
    brute force over the deduped undirected pairs. Returns
    (dist_m, u, v, snapped_lat, snapped_lon) or None if the graph is empty."""
    G = get_graph()
    pt = Point(lon, lat)
    seen = set()
    best = None

    for u, v, k, d in G.edges(keys=True, data=True):
        pair = frozenset((u, v))
        if pair in seen:
            continue
        seen.add(pair)

        geom = d.get("geometry")
        if geom is None:
            geom = LineString([
                (G.nodes[u]["x"], G.nodes[u]["y"]),
                (G.nodes[v]["x"], G.nodes[v]["y"]),
            ])

        nearest_pt = geom.interpolate(geom.project(pt))
        dist_m = haversine_m(lat, lon, nearest_pt.y, nearest_pt.x)
        if best is None or dist_m < best[0]:
            best = (dist_m, u, v, nearest_pt.y, nearest_pt.x)

    return best


def graph_bounds():
    G = get_graph()
    lats = [d["y"] for _, d in G.nodes(data=True)]
    lons = [d["x"] for _, d in G.nodes(data=True)]
    return {
        "center": {"lat": config.CENTER_LAT, "lon": config.CENTER_LON},
        "min_lat": min(lats), "max_lat": max(lats),
        "min_lon": min(lons), "max_lon": max(lons),
    }
