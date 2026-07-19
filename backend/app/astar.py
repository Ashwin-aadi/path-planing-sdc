"""Bidirectional weighted A* over the cached OSM graph.

Two searches run simultaneously — forward from the start over normal edges,
backward from the goal over reversed edges — and meet in the middle,
expanding roughly half the nodes plain A* would on city-scale graphs.

Both are guided by the balanced (Ikeda et al.) potential

    pf(n) = (h_f(n) - h_b(n)) / 2        pb(n) = -pf(n)

where h_f/h_b are the admissible haversine lower bounds to the goal/start
(see graph_loader.FLOOR_FRACTION for why they stay admissible and
consistent). Because pf + pb is constant, both searches' reweighted edge
costs stay non-negative and the classic termination rule applies: once
top_f + top_b >= mu (the best start-goal path found so far), mu is optimal.
"""

import heapq
import time

from app.graph_loader import REF_SPEED_MPS, FLOOR_FRACTION, haversine_m


class NoRouteFound(Exception):
    pass


def edge_weight(data, weights, congestion_factor):
    """Blend the five preference costs (all already expressed in seconds)
    plus the fixed floor that guarantees a positive, admissible cost.
    Traffic is the only time-varying term — traffic_base_s is precomputed
    per edge, scaled here by the current time-of-day congestion factor."""
    return (
        data["floor_s"]
        + weights["time"] * data["travel_time_s"]
        + weights["speed"] * data["speed_cost_s"]
        + weights["safety"] * data["safety_cost_s"]
        + weights["traffic"] * data["traffic_base_s"] * congestion_factor
        + weights["economy"] * data["economy_cost_s"]
    )


def _best_parallel_edge_cost(G, u, v, weights, blocked, congestion_factor):
    """A MultiDiGraph can have >1 edge between the same u,v; use the
    cheapest one under current weights (ties broken arbitrarily)."""
    if blocked and frozenset((u, v)) in blocked:
        return None, None
    best_key, best_cost = None, None
    for k, data in G[u][v].items():
        cost = edge_weight(data, weights, congestion_factor)
        if best_cost is None or cost < best_cost:
            best_key, best_cost = k, cost
    return best_key, best_cost


def bidirectional_astar_route(G, start, goal, weights, blocked=None, congestion_factor=0.0):
    """weights: dict with 'time', 'speed', 'safety', 'traffic', 'economy'
    keys summing to 1. blocked: set of frozenset({u, v}) pairs to treat as
    impassable. congestion_factor: current time-of-day traffic scalar in
    [0, 1] (see app/traffic.py) — only affects routing when the traffic
    weight is > 0, since it only scales the traffic cost term.
    Returns (node_path, edge_keys, stats) or raises NoRouteFound."""
    t0 = time.perf_counter()

    if start == goal:
        return [start], [], {"compute_ms": 0.0, "nodes_expanded": 0, "cost": 0.0}

    s_lat, s_lon = G.nodes[start]["y"], G.nodes[start]["x"]
    g_lat, g_lon = G.nodes[goal]["y"], G.nodes[goal]["x"]
    h_scale = FLOOR_FRACTION / REF_SPEED_MPS

    def pf(n):
        d = G.nodes[n]
        h_fwd = haversine_m(d["y"], d["x"], g_lat, g_lon)   # lower bound to goal
        h_bwd = haversine_m(d["y"], d["x"], s_lat, s_lon)   # lower bound to start
        return h_scale * (h_fwd - h_bwd) / 2.0

    inf = float("inf")
    g_f = {start: 0.0}
    g_b = {goal: 0.0}
    came_f = {}  # node -> (prev_node, edge_key), walking back toward start
    came_b = {}  # node -> (next_node, edge_key), walking forward toward goal
    open_f = [(pf(start), start)]
    open_b = [(-pf(goal), goal)]
    closed_f = set()
    closed_b = set()
    expanded = 0

    mu = inf      # best complete start->goal cost discovered so far
    meet = None   # node where the two searches join on that best path

    def try_meet(n):
        # Called on every g improvement from either side, so mu always
        # equals the best sum over nodes both searches have priced.
        nonlocal mu, meet
        gf, gb = g_f.get(n), g_b.get(n)
        if gf is not None and gb is not None and gf + gb < mu:
            mu = gf + gb
            meet = n

    while open_f or open_b:
        top_f = open_f[0][0] if open_f else inf
        top_b = open_b[0][0] if open_b else inf
        if mu <= top_f + top_b:
            break

        if top_f <= top_b:
            _, u = heapq.heappop(open_f)
            if u in closed_f:
                continue
            closed_f.add(u)
            expanded += 1
            for v in G[u]:
                if v in closed_f:
                    continue
                key, cost = _best_parallel_edge_cost(G, u, v, weights, blocked, congestion_factor)
                if cost is None:
                    continue
                tentative = g_f[u] + cost
                if tentative < g_f.get(v, inf):
                    g_f[v] = tentative
                    came_f[v] = (u, key)
                    heapq.heappush(open_f, (tentative + pf(v), v))
                    try_meet(v)
        else:
            _, u = heapq.heappop(open_b)
            if u in closed_b:
                continue
            closed_b.add(u)
            expanded += 1
            # Backward search relaxes the graph's reversed edges: for each
            # real edge p -> u, extend the (u ... goal) suffix to p.
            for p in G.pred[u]:
                if p in closed_b:
                    continue
                key, cost = _best_parallel_edge_cost(G, p, u, weights, blocked, congestion_factor)
                if cost is None:
                    continue
                tentative = g_b[u] + cost
                if tentative < g_b.get(p, inf):
                    g_b[p] = tentative
                    came_b[p] = (u, key)
                    heapq.heappush(open_b, (tentative - pf(p), p))
                    try_meet(p)

    elapsed_ms = (time.perf_counter() - t0) * 1000

    if meet is None:
        raise NoRouteFound(f"No path between {start} and {goal}")

    # Stitch the two half-paths together at the meeting node.
    node_path = [meet]
    edge_keys = []
    n = meet
    while n != start:
        u, key = came_f[n]
        node_path.append(u)
        edge_keys.append(key)
        n = u
    node_path.reverse()
    edge_keys.reverse()
    n = meet
    while n != goal:
        nxt, key = came_b[n]
        node_path.append(nxt)
        edge_keys.append(key)
        n = nxt

    return node_path, edge_keys, {
        "compute_ms": round(elapsed_ms, 2),
        "nodes_expanded": expanded,
        "cost": mu,
    }
