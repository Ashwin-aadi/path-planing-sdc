"""Custom weighted A* over the cached OSM graph.

f(n) = g(n) + h(n), where g(n) is the accumulated blended cost (time / speed /
safety, per user slider weights) and h(n) is an admissible haversine-based
lower bound (see graph_loader.FLOOR_FRACTION for why it stays admissible).
"""

import heapq
import time

from app.graph_loader import REF_SPEED_MPS, FLOOR_FRACTION, haversine_m


class NoRouteFound(Exception):
    pass


def edge_weight(data, weights):
    """Blend the three preference costs (all already expressed in seconds)
    plus the fixed floor that guarantees a positive, admissible cost."""
    return (
        data["floor_s"]
        + weights["time"] * data["travel_time_s"]
        + weights["speed"] * data["speed_cost_s"]
        + weights["safety"] * data["safety_cost_s"]
    )


def _best_parallel_edge_cost(G, u, v, weights, blocked):
    """A MultiDiGraph can have >1 edge between the same u,v; use the
    cheapest one under current weights (ties broken arbitrarily)."""
    if blocked and frozenset((u, v)) in blocked:
        return None, None
    best_key, best_cost = None, None
    for k, data in G[u][v].items():
        cost = edge_weight(data, weights)
        if best_cost is None or cost < best_cost:
            best_key, best_cost = k, cost
    return best_key, best_cost


def astar_route(G, start, goal, weights, blocked=None):
    """weights: dict with 'time', 'speed', 'safety' keys summing to 1.
    blocked: set of frozenset({u, v}) pairs to treat as impassable.
    Returns (node_path, edge_keys, stats) or raises NoRouteFound."""
    t0 = time.perf_counter()

    goal_lat, goal_lon = G.nodes[goal]["y"], G.nodes[goal]["x"]

    def h(n):
        d = G.nodes[n]
        dist = haversine_m(d["y"], d["x"], goal_lat, goal_lon)
        return FLOOR_FRACTION * dist / REF_SPEED_MPS

    g_score = {start: 0.0}
    came_from = {}
    open_heap = [(h(start), start)]
    visited = set()
    expanded = 0

    while open_heap:
        _, u = heapq.heappop(open_heap)
        if u in visited:
            continue
        visited.add(u)
        expanded += 1

        if u == goal:
            break

        for v in G[u]:
            if v in visited:
                continue
            key, cost = _best_parallel_edge_cost(G, u, v, weights, blocked)
            if cost is None:
                continue
            tentative = g_score[u] + cost
            if tentative < g_score.get(v, float("inf")):
                g_score[v] = tentative
                came_from[v] = (u, key)
                heapq.heappush(open_heap, (tentative + h(v), v))

    elapsed_ms = (time.perf_counter() - t0) * 1000

    if goal not in came_from and goal != start:
        raise NoRouteFound(f"No path between {start} and {goal}")

    node_path = [goal]
    edge_keys = []
    while node_path[-1] != start:
        u, key = came_from[node_path[-1]]
        edge_keys.append(key)
        node_path.append(u)
    node_path.reverse()
    edge_keys.reverse()

    return node_path, edge_keys, {
        "compute_ms": round(elapsed_ms, 2),
        "nodes_expanded": expanded,
        "cost": g_score.get(goal, 0.0),
    }
