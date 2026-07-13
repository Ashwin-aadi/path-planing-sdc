"""Rough traffic heuristic — no free live-traffic API exists without a
metered/paid key (Google, TomTom, HERE all require billing), so this
approximates typical time-of-day congestion instead of real live data.
Documented explicitly as a heuristic; see config.py for the tunable
constants and astar.py for how it enters the routing cost."""

from datetime import datetime, timedelta, timezone

from app import config

IST = timezone(timedelta(hours=5, minutes=30))


def _in_any_range(hour, ranges):
    return any(lo <= hour < hi for lo, hi in ranges)


def congestion_factor(now=None):
    """Scalar in [0, 1] describing how "peak" the current time of day is,
    in IST (Prayagraj's timezone). 1.0 = full rush-hour congestion,
    0 = quiet late-night roads."""
    now = now or datetime.now(IST)
    hour = now.hour + now.minute / 60

    if _in_any_range(hour, config.TRAFFIC_PEAK_HOURS):
        return config.TRAFFIC_PEAK_FACTOR
    if _in_any_range(hour, config.TRAFFIC_MODERATE_HOURS):
        return config.TRAFFIC_MODERATE_FACTOR
    return config.TRAFFIC_OFFPEAK_FACTOR
