"""Loads the local drivable OSM graph once, caches it to disk, and
precomputes per-edge cost components so route requests don't have to."""

import math
import os
import pickle
import threading

import networkx as nx
import osmnx as ox
from shapely.geometry import LineString, Point, box
from shapely.strtree import STRtree

from app import config
from app.elevation import fetch_elevations

# Fastest road class defines the reference speed used to convert every
# preference (speed/safety) into an equivalent-time cost, in seconds.
REF_SPEED_KPH = max(config.HWY_SPEEDS_KPH.values())
REF_SPEED_MPS = REF_SPEED_KPH / 3.6
MAX_SPEED_KPH = REF_SPEED_KPH

# Every edge keeps at least this fraction of its pure-distance time cost,
# regardless of slider weights. Guarantees no edge is ever free (needed for
# A*/Dijkstra correctness) and keeps the haversine heuristic admissible.
FLOOR_FRACTION = 0.05

_graphs = {}       # region_id -> graph
_node_indexes = {}  # region_id -> (STRtree, [node_id, ...]) aligned by position
_edge_indexes = {}  # region_id -> (STRtree, [(u, v, key), ...]) aligned by position
_graph_lock = threading.Lock()  # serializes building/loading so concurrent
# requests for a not-yet-cached region wait for the one already in progress
# instead of each kicking off their own redundant (slow) rebuild.


def _first(value):
    """OSM tags are sometimes lists (multiple values on a way); take the first."""
    return value[0] if isinstance(value, list) else value


def _prune_to_largest_scc(G):
    """A weakly-connected drive graph can still have nodes that are only
    reachable in one direction (typically one-way streets clipped at the
    bounding-box edge) — every path through them is a dead end for A*.
    Dropping everything outside the largest strongly connected component
    guarantees any two remaining nodes are mutually reachable, so routing
    between two points on the loaded map never fails for graph-topology
    reasons — only real (user-placed) blockages can do that."""
    if G.number_of_nodes() == 0:
        return G
    largest = max(nx.strongly_connected_components(G), key=len)
    if len(largest) == G.number_of_nodes():
        return G
    dropped = G.number_of_nodes() - len(largest)
    print(f"[graph] dropping {dropped} node(s) outside the largest strongly connected component")
    return G.subgraph(largest).copy()


def _add_elevation(G):
    """Fetch elevation for every node (Open-Elevation, free/no key) and
    store it as a node attribute. Falls back to flat terrain (elevation=0
    everywhere, so grade/economy costs become neutral) if the free API is
    unreachable — slope is a nice-to-have, not something worth breaking
    graph loading over."""
    node_ids = list(G.nodes())
    coords = [(G.nodes[n]["y"], G.nodes[n]["x"]) for n in node_ids]
    try:
        elevations = fetch_elevations(coords)
        print(f"[elevation] fetched {len(node_ids)} node elevations from Open-Elevation")
    except Exception as e:
        print(f"[elevation] fetch failed ({e}); falling back to flat terrain")
        elevations = [0.0] * len(node_ids)
    for n, elev in zip(node_ids, elevations):
        G.nodes[n]["elevation"] = elev
    return G


def region_cache_ready(region_id):
    """Cheap on-disk check (no load) — lets /api/regions warn the frontend
    before it triggers a slow first-time OSM download + elevation fetch."""
    return os.path.exists(config.REGIONS[region_id]["cache_path"])


def _build_graph(region_id):
    region = config.REGIONS[region_id]
    os.makedirs(config.CACHE_DIR, exist_ok=True)
    ox.settings.use_cache = True
    ox.settings.cache_folder = config.CACHE_DIR

    cache_path = region["cache_path"]
    if os.path.exists(cache_path):
        # Pickle instead of GraphML/XML: this graph is already fully typed
        # and pruned at save time, so loading is a straight deserialize —
        # no XML parsing, no re-casting floats. That pure-Python parsing
        # work was slow enough on a throttled free-tier CPU to hold the
        # GIL and stall the whole single-worker process for minutes.
        with open(cache_path, "rb") as f:
            return pickle.load(f)

    print(f"[graph] building '{region_id}' from OpenStreetMap (dist={region['radius_m']}m) — this can take a while")
    G = ox.graph_from_point(
        (region["center_lat"], region["center_lon"]),
        dist=region["radius_m"],
        network_type="drive",
        simplify=True,
    )
    G = ox.routing.add_edge_speeds(
        G, hwy_speeds=config.HWY_SPEEDS_KPH, fallback=config.FALLBACK_SPEED_KPH
    )
    G = ox.routing.add_edge_travel_times(G)

    G = _prune_to_largest_scc(G)
    G = _add_elevation(G)

    for u, v, d in G.edges(data=True):
        hwy = _first(d.get("highway"))
        length_m = float(d["length"])
        speed_kph = float(d["speed_kph"])

        safety_penalty = config.SAFETY_PENALTY.get(hwy, config.FALLBACK_SAFETY_PENALTY)
        speed_penalty = max(0.0, 1.0 - speed_kph / MAX_SPEED_KPH)
        traffic_susceptibility = config.TRAFFIC_SUSCEPTIBILITY.get(hwy, config.FALLBACK_TRAFFIC_SUSCEPTIBILITY)
        stop_penalty = config.ECONOMY_STOP_PENALTY.get(hwy, config.FALLBACK_ECONOMY_STOP_PENALTY)

        elev_u = G.nodes[u].get("elevation", 0.0)
        elev_v = G.nodes[v].get("elevation", 0.0)
        grade = (elev_v - elev_u) / length_m if length_m > 0 else 0.0
        speed_dev = (speed_kph - config.ECONOMY_OPTIMAL_SPEED_KPH) / config.ECONOMY_OPTIMAL_SPEED_KPH
        economy_penalty = speed_dev ** 2 + stop_penalty + max(0.0, grade) * config.ECONOMY_SLOPE_FACTOR

        travel_time_s = float(d["travel_time"])

        d["highway"] = hwy or "unclassified"
        d["speed_kph"] = speed_kph
        d["travel_time_s"] = travel_time_s
        d["safety_penalty"] = safety_penalty
        d["speed_cost_s"] = length_m * speed_penalty / REF_SPEED_MPS
        d["safety_cost_s"] = length_m * safety_penalty / REF_SPEED_MPS
        d["floor_s"] = FLOOR_FRACTION * length_m / REF_SPEED_MPS
        d["grade"] = grade
        d["economy_cost_s"] = length_m * economy_penalty / REF_SPEED_MPS
        d["traffic_susceptibility"] = traffic_susceptibility
        # Static part of the traffic cost; multiplied by the request-time
        # congestion_factor(hour) in astar.edge_weight — see config.py.
        d["traffic_base_s"] = travel_time_s * traffic_susceptibility * config.TRAFFIC_IMPACT
        d.pop("travel_time", None)

    with open(cache_path, "wb") as f:
        pickle.dump(G, f, protocol=pickle.HIGHEST_PROTOCOL)
    return G


def dedup_edge_pairs(G):
    """One representative (u, v, key, data) per undirected road pair,
    preferring whichever direction actually carries a real (curved)
    geometry. Shared by the spatial index and the /api/graph/edges route
    so both agree on exactly which direction represents each road."""
    chosen = {}
    for u, v, k, d in G.edges(keys=True, data=True):
        pair = frozenset((u, v))
        if pair not in chosen or (d.get("geometry") is not None and chosen[pair][3].get("geometry") is None):
            chosen[pair] = (u, v, k, d)
    return chosen


def _build_spatial_indexes(G):
    node_ids = list(G.nodes())
    node_geoms = [Point(G.nodes[n]["x"], G.nodes[n]["y"]) for n in node_ids]
    node_index = (STRtree(node_geoms), node_ids)

    edge_geoms, edge_refs = [], []
    for u, v, k, d in dedup_edge_pairs(G).values():
        geom = d.get("geometry")
        if geom is None:
            geom = LineString([
                (G.nodes[u]["x"], G.nodes[u]["y"]),
                (G.nodes[v]["x"], G.nodes[v]["y"]),
            ])
        edge_geoms.append(geom)
        edge_refs.append((u, v, k))
    edge_index = (STRtree(edge_geoms), edge_geoms, edge_refs)

    return node_index, edge_index


def get_graph(region=None):
    region = region or config.DEFAULT_REGION
    with _graph_lock:
        if region not in _graphs:
            # Free-tier hosting has limited RAM — keep only one region's
            # graph (plus its spatial indexes) resident at a time. Switching
            # regions reloads from the on-disk cache (fast) rather than a
            # full rebuild, so this only costs a couple seconds.
            _graphs.clear()
            _node_indexes.clear()
            _edge_indexes.clear()
            G = _build_graph(region)
            _graphs[region] = G
            _node_indexes[region], _edge_indexes[region] = _build_spatial_indexes(G)
        return _graphs[region]


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def nearest_node(lat, lon, region=None):
    """Nearest node via an R-tree spatial index (STRtree) — avoids a
    linear scan over every node on each lookup, which stops scaling once
    the graph covers more than a small neighborhood."""
    region = region or config.DEFAULT_REGION
    G = get_graph(region)
    tree, node_ids = _node_indexes[region]
    idx = tree.nearest(Point(lon, lat))
    node_id = node_ids[idx]
    d = G.nodes[node_id]
    return node_id, haversine_m(lat, lon, d["y"], d["x"])


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


def nearest_edge(lat, lon, region=None):
    """Snap a click point to the nearest road (for obstacle placement) via
    an R-tree spatial index over the deduped undirected pairs. Returns
    (dist_m, u, v, snapped_lat, snapped_lon) or None if the graph is empty."""
    region = region or config.DEFAULT_REGION
    get_graph(region)
    tree, geoms, refs = _edge_indexes[region]
    if not geoms:
        return None

    pt = Point(lon, lat)
    idx = tree.nearest(pt)
    geom = geoms[idx]
    u, v, k = refs[idx]

    nearest_pt = geom.interpolate(geom.project(pt))
    dist_m = haversine_m(lat, lon, nearest_pt.y, nearest_pt.x)
    return dist_m, u, v, nearest_pt.y, nearest_pt.x


def edges_in_bbox(min_lat, max_lat, min_lon, max_lon, region=None):
    """Road pairs (u, v, key) whose geometry falls in the given lat/lon box,
    via the edge R-tree. Lets the frontend load only what's on screen
    instead of the whole graph, which stops scaling once the map covers
    a wide area."""
    region = region or config.DEFAULT_REGION
    get_graph(region)
    tree, geoms, refs = _edge_indexes[region]
    query_box = box(min_lon, min_lat, max_lon, max_lat)
    idxs = tree.query(query_box)
    return [refs[i] for i in idxs]


def graph_bounds(region=None):
    region = region or config.DEFAULT_REGION
    G = get_graph(region)
    lats = [d["y"] for _, d in G.nodes(data=True)]
    lons = [d["x"] for _, d in G.nodes(data=True)]
    r = config.REGIONS[region]
    return {
        "region": region,
        "center": {"lat": r["center_lat"], "lon": r["center_lon"]},
        "min_lat": min(lats), "max_lat": max(lats),
        "min_lon": min(lons), "max_lon": max(lons),
    }


def nearest_region(lat, lon):
    """Which configured region's center is closest to a real GPS fix —
    used to auto-switch regions when live location comes from somewhere
    other than the currently loaded map (e.g. testing away from campus)."""
    best_id, best_dist = None, None
    for region_id, r in config.REGIONS.items():
        d = haversine_m(lat, lon, r["center_lat"], r["center_lon"])
        if best_dist is None or d < best_dist:
            best_id, best_dist = region_id, d
    return best_id, best_dist
