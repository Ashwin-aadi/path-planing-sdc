import asyncio

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app import config, state
from app.astar import NoRouteFound, astar_route
from app.graph_loader import (
    dedup_edge_pairs, edge_latlon_coords, edges_in_bbox, get_graph, graph_bounds,
    nearest_edge, nearest_node, nearest_region, region_cache_ready,
)
from app.geocode import search as geocode_search
from app.models import BlockRequest, LatLon, RouteRequest, RouteResponse, SetBlockRequest, Weights
from app.traffic import congestion_factor


def _region_or_400(region):
    region = region or config.DEFAULT_REGION
    if region not in config.REGIONS:
        raise HTTPException(400, f"Unknown region '{region}'")
    return region


app = FastAPI(title="Path Planning Robotics — Phase 1 Routing API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _warm_graph():
    # Fire-and-forget in a background thread — loading/parsing an 80MB+
    # graphml (even from cache) can take a while on a slow/throttled CPU,
    # and must never block uvicorn from binding its port. Render's health
    # check (see below) doesn't depend on this finishing.
    asyncio.create_task(asyncio.to_thread(get_graph, config.DEFAULT_REGION))


@app.get("/api/regions")
def regions():
    return {
        "default": config.DEFAULT_REGION,
        "regions": [
            {
                "id": region_id,
                "label": r["label"],
                "center": {"lat": r["center_lat"], "lon": r["center_lon"]},
                "radius_m": r["radius_m"],
                "ready": region_cache_ready(region_id),
            }
            for region_id, r in config.REGIONS.items()
        ],
    }


@app.get("/api/health")
def health():
    # Pure liveness check — deliberately never touches the graph, so it
    # always answers instantly regardless of load/build state. That's what
    # Render's port scan and healthCheckPath probe, and what the keep-alive
    # workflow pings; none of them should ever wait on a graph load.
    return {"status": "ok"}


@app.get("/api/graph/bounds")
def bounds(region: str = None):
    region = _region_or_400(region)
    return graph_bounds(region)


@app.get("/api/graph/edges")
def edges(
    min_lat: float = None, max_lat: float = None, min_lon: float = None, max_lon: float = None,
    region: str = None,
):
    """Dedupe (u,v)/(v,u) pairs of the same road into one line for rendering
    and road-blocking clicks; A* itself still respects true one-way direction.
    With bounds given, only returns roads in that box — the graph now covers
    too wide an area to ship the whole thing to the browser on every load."""
    region = _region_or_400(region)
    G = get_graph(region)

    if None not in (min_lat, max_lat, min_lon, max_lon):
        refs = edges_in_bbox(min_lat, max_lat, min_lon, max_lon, region=region)
    else:
        refs = [(u, v, k) for u, v, k, _ in dedup_edge_pairs(G).values()]

    features = []
    for u, v, k in refs:
        d = G[u][v][k]
        coords = [[round(lon, 6), round(lat, 6)] for lat, lon in edge_latlon_coords(G, u, v, k)]

        features.append({
            "type": "Feature",
            "properties": {
                "u": u, "v": v,
                "highway": d.get("highway"),
                "blocked": frozenset((u, v)) in state.blocked_edges,
            },
            "geometry": {"type": "LineString", "coordinates": coords},
        })

    return {"type": "FeatureCollection", "features": features}


@app.get("/api/graph/nearest_edge")
def nearest_edge_lookup(lat: float, lon: float, region: str = None):
    region = _region_or_400(region)
    result = nearest_edge(lat, lon, region=region)
    if result is None:
        raise HTTPException(404, "No roads in graph")
    dist_m, u, v, snap_lat, snap_lon = result
    return {
        "u": u, "v": v,
        "dist_m": round(dist_m, 1),
        "snapped": {"lat": snap_lat, "lon": snap_lon},
    }


@app.get("/api/nearest_region")
def nearest_region_lookup(lat: float, lon: float):
    """Which configured region a real GPS fix falls closest to — lets the
    frontend auto-switch maps when live location is used somewhere other
    than whichever region is currently loaded."""
    region_id, dist_m = nearest_region(lat, lon)
    r = config.REGIONS[region_id]
    return {
        "region": region_id,
        "label": r["label"],
        "dist_to_center_m": round(dist_m, 1),
        "within_coverage": dist_m <= r["radius_m"],
        "ready": region_cache_ready(region_id),
    }


@app.get("/api/geocode")
def geocode(q: str, region: str = None):
    """Place-name search (free, via OSM Nominatim — see app/geocode.py),
    biased toward whichever region is currently loaded."""
    region = _region_or_400(region)
    q = q.strip()
    if not q:
        return {"results": []}
    r = config.REGIONS[region]
    try:
        results = geocode_search(q, region=(r["center_lat"], r["center_lon"], r["radius_m"]))
    except Exception as e:
        raise HTTPException(502, f"Geocoding service unavailable: {e}")
    return {"results": results}


@app.get("/api/blocks")
def list_blocks():
    return {"blocked": [{"u": u, "v": v} for u, v in state.as_list()]}


@app.post("/api/blocks/toggle")
def toggle_block(req: BlockRequest):
    now_blocked = state.toggle(req.u, req.v)
    return {"u": req.u, "v": req.v, "blocked": now_blocked}


@app.post("/api/blocks/set")
def set_block(req: SetBlockRequest):
    now_blocked = state.set_blocked(req.u, req.v, req.blocked)
    return {"u": req.u, "v": req.v, "blocked": now_blocked}


@app.delete("/api/blocks")
def clear_blocks():
    state.clear()
    return {"blocked": []}


@app.post("/api/route", response_model=RouteResponse)
def route(req: RouteRequest):
    region = _region_or_400(req.region)
    G = get_graph(region)

    weights = config.EMERGENCY_WEIGHTS if req.emergency else req.weights.model_dump()
    total = sum(weights.values())
    if total <= 0:
        raise HTTPException(400, "At least one weight must be > 0")
    weights = {k: v / total for k, v in weights.items()}

    cf = congestion_factor()

    stops = [req.start] + req.waypoints
    snapped = [nearest_node(p.lat, p.lon, region=region) for p in stops]  # [(node_id, snap_dist), ...]

    full_coords = []
    distance_m = 0.0
    eta_s = 0.0
    traffic_delay_s = 0.0
    compute_ms = 0.0
    nodes_expanded = 0
    leg_distances_m = []

    for leg in range(len(snapped) - 1):
        leg_start = snapped[leg][0]
        leg_end = snapped[leg + 1][0]
        try:
            node_path, edge_keys, stats = astar_route(
                G, leg_start, leg_end, weights, blocked=state.blocked_edges, congestion_factor=cf
            )
        except NoRouteFound:
            raise HTTPException(
                409, f"No route found for leg {leg + 1} of {len(snapped) - 1} (roads may be blocked)"
            )

        compute_ms += stats["compute_ms"]
        nodes_expanded += stats["nodes_expanded"]
        leg_distance = 0.0

        for i in range(len(node_path) - 1):
            u, v = node_path[i], node_path[i + 1]
            k = edge_keys[i]
            d = G[u][v][k]
            # Reported ETA always reflects current time-of-day congestion,
            # regardless of how the Traffic slider is weighted for route
            # choice — same real-vs-preference split as Google Maps' ETA.
            edge_delay = d["traffic_base_s"] * cf
            distance_m += d["length"]
            eta_s += d["travel_time_s"] + edge_delay
            traffic_delay_s += edge_delay
            leg_distance += d["length"]

            seg = edge_latlon_coords(G, u, v, k)
            if full_coords and full_coords[-1] == seg[0]:
                seg = seg[1:]
            full_coords.extend(seg)

        leg_distances_m.append(round(leg_distance, 1))

    path = [LatLon(lat=lat, lon=lon) for lat, lon in full_coords]

    start_node, start_snap_dist = snapped[0]
    end_node, end_snap_dist = snapped[-1]

    return RouteResponse(
        path=path,
        distance_m=round(distance_m, 1),
        eta_s=round(eta_s, 1),
        compute_ms=round(compute_ms, 2),
        nodes_expanded=nodes_expanded,
        weights_used=Weights(**weights),
        start_snapped=LatLon(lat=G.nodes[start_node]["y"], lon=G.nodes[start_node]["x"]),
        end_snapped=LatLon(lat=G.nodes[end_node]["y"], lon=G.nodes[end_node]["x"]),
        snap_dist_start_m=round(start_snap_dist, 1),
        snap_dist_end_m=round(end_snap_dist, 1),
        leg_distances_m=leg_distances_m,
        traffic_delay_s=round(traffic_delay_s, 1),
        congestion_factor=cf,
    )
