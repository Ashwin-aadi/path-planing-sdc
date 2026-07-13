"""In-memory blocked-edge store (phase 1: no persistence needed)."""

blocked_edges = set()  # set of frozenset({u, v})


def toggle(u, v):
    key = frozenset((u, v))
    if key in blocked_edges:
        blocked_edges.discard(key)
        return False
    blocked_edges.add(key)
    return True


def set_blocked(u, v, blocked):
    key = frozenset((u, v))
    if blocked:
        blocked_edges.add(key)
    else:
        blocked_edges.discard(key)
    return blocked


def as_list():
    return [tuple(k) for k in blocked_edges]


def clear():
    blocked_edges.clear()
