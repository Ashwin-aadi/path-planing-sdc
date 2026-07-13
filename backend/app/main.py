from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app import config, state
from app.astar import NoRouteFound, astar_route
from app.graph_loader import (
    edge_latlon_coords, get_graph, graph_bounds, haversine_m, nearest_edge, nearest_node,
)
from app.models import BlockRequest, LatLon, RouteRequest, RouteResponse, SetBlockRequest, Weights

app = FastAPI(title="Path Planning Robotics — Phase 1 Routing API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _warm_graph():
    get_graph()  # build/load once at startup instead of on first request


@app.get("/api/health")
def health():
    G = get_graph()
    return {"status": "ok", "nodes": G.number_of_nodes(), "edges": G.number_of_edges()}


@app.get("/api/graph/bounds")
def bounds():
    return graph_bounds()


@app.get("/api/graph/edges")
def edges():
    """Dedupe (u,v)/(v,u) pairs of the same road into one line for rendering
    and road-blocking clicks; A* itself still respects true one-way direction."""
    G = get_graph()
    # Prefer whichever direction of a two-way pair actually carries geometry,
    # instead of whatever direction the edge iterator happens to see first.
    chosen = {}
    for u, v, k, d in G.edges(keys=True, data=True):
        pair = frozenset((u, v))
        if pair not in chosen or (d.get("geometry") is not None and chosen[pair][3].get("geometry") is None):
            chosen[pair] = (u, v, k, d)

    features = []
    for pair, (u, v, k, d) in chosen.items():
        coords = [[round(lon, 6), round(lat, 6)] for lat, lon in edge_latlon_coords(G, u, v, k)]

        features.append({
            "type": "Feature",
            "properties": {
                "u": u, "v": v,
                "highway": d.get("highway"),
                "blocked": pair in state.blocked_edges,
            },
            "geometry": {"type": "LineString", "coordinates": coords},
        })

    return {"type": "FeatureCollection", "features": features}


@app.get("/api/graph/nearest_edge")
def nearest_edge_lookup(lat: float, lon: float):
    result = nearest_edge(lat, lon)
    if result is None:
        raise HTTPException(404, "No roads in graph")
    dist_m, u, v, snap_lat, snap_lon = result
    if dist_m > config.MAX_SNAP_DIST_M:
        raise HTTPException(400, f"That point is {round(dist_m)}m from the nearest road — outside the mapped area")
    return {
        "u": u, "v": v,
        "dist_m": round(dist_m, 1),
        "snapped": {"lat": snap_lat, "lon": snap_lon},
    }


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
    G = get_graph()

    weights = config.EMERGENCY_WEIGHTS if req.emergency else req.weights.model_dump()
    total = sum(weights.values())
    if total <= 0:
        raise HTTPException(400, "At least one weight must be > 0")
    weights = {k: v / total for k, v in weights.items()}

    stops = [req.start] + req.waypoints
    snapped = [nearest_node(p.lat, p.lon) for p in stops]  # [(node_id, snap_dist), ...]

    for i, (_, snap_dist) in enumerate(snapped):
        if snap_dist > config.MAX_SNAP_DIST_M:
            label = "Start" if i == 0 else f"Destination {i}"
            raise HTTPException(
                400, f"{label} is {round(snap_dist)}m from the nearest road — outside the mapped area"
            )

    full_coords = []
    distance_m = 0.0
    eta_s = 0.0
    compute_ms = 0.0
    nodes_expanded = 0
    leg_distances_m = []

    for leg in range(len(snapped) - 1):
        leg_start = snapped[leg][0]
        leg_end = snapped[leg + 1][0]
        try:
            node_path, edge_keys, stats = astar_route(
                G, leg_start, leg_end, weights, blocked=state.blocked_edges
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
            distance_m += d["length"]
            eta_s += d["travel_time_s"]
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
    )
