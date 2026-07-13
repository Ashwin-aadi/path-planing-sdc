"""Static configuration for the routing backend."""

CACHE_DIR = "./osm_cache"

# Multiple demo regions so testing works wherever the device actually is —
# real GPS (Phase 2) is useless without road data under the user's feet.
# Each region gets its own cached graphml; built lazily on first use.
REGIONS = {
    "prayagraj": {
        "label": "Prayagraj (MNNIT)",
        "center_lat": 25.4926,
        "center_lon": 81.8662,
        "radius_m": 20000,
        "graphml_path": "./osm_cache/mnnit_area.graphml",
    },
    "gwalior": {
        "label": "Gwalior",
        "center_lat": 26.2183,
        "center_lon": 78.1828,
        "radius_m": 20000,
        "graphml_path": "./osm_cache/gwalior_area.graphml",
    },
}
DEFAULT_REGION = "prayagraj"

# Fallback speed table (km/h) since OSM rarely tags maxspeed in this region.
# These are approximate Indian urban defaults, not measured data — documented
# as a heuristic, not real live speed data.
HWY_SPEEDS_KPH = {
    "motorway": 90,
    "motorway_link": 60,
    "trunk": 70,
    "trunk_link": 50,
    "primary": 50,
    "primary_link": 40,
    "secondary": 40,
    "secondary_link": 35,
    "tertiary": 30,
    "tertiary_link": 25,
    "unclassified": 25,
    "residential": 20,
    "living_street": 15,
    "service": 15,
}
FALLBACK_SPEED_KPH = 25

# Safety penalty proxy per highway class: 0 = safest (broad, non-highway),
# 1 = least safe (limited-access highway or narrow/unclassified road).
# "Safety" here is an explicit heuristic (road-class based), not a real
# crash/incident dataset — documented as such since no free dataset exists.
SAFETY_PENALTY = {
    "motorway": 1.0,
    "motorway_link": 0.9,
    "trunk": 0.8,
    "trunk_link": 0.7,
    "primary": 0.1,
    "primary_link": 0.15,
    "secondary": 0.15,
    "secondary_link": 0.2,
    "tertiary": 0.25,
    "tertiary_link": 0.3,
    "unclassified": 0.45,
    "residential": 0.55,
    "living_street": 0.6,
    "service": 0.7,
}
FALLBACK_SAFETY_PENALTY = 0.5

# --- Traffic (rough heuristic, not live data) -----------------------------
# No free live-traffic API exists without a paid/metered key (Google, TomTom,
# HERE all require billing). This models typical time-of-day congestion
# instead: how much a road class's real-world speed tends to drop when
# traffic is heavy, scaled by how "peak" the current time of day is.
#
#   traffic_multiplier(edge, hour) = 1 + SUSCEPTIBILITY[hwy] * congestion_factor(hour) * TRAFFIC_IMPACT
#   traffic_cost_s(edge, hour)     = travel_time_s(edge) * SUSCEPTIBILITY[hwy] * congestion_factor(hour) * TRAFFIC_IMPACT
#
# i.e. traffic_cost_s is exactly the extra seconds traffic_multiplier adds
# on top of free-flow travel time — always >= 0, so it stays a valid A* cost.
# Susceptibility is higher for arterial roads (primary/trunk/secondary),
# since in Indian cities these carry the most through-traffic and see the
# largest absolute congestion delays; residential streets carry less volume.
TRAFFIC_SUSCEPTIBILITY = {
    "motorway": 0.85,
    "motorway_link": 0.6,
    "trunk": 0.8,
    "trunk_link": 0.55,
    "primary": 0.7,
    "primary_link": 0.5,
    "secondary": 0.55,
    "secondary_link": 0.4,
    "tertiary": 0.35,
    "tertiary_link": 0.25,
    "unclassified": 0.2,
    "residential": 0.15,
    "living_street": 0.1,
    "service": 0.1,
}
FALLBACK_TRAFFIC_SUSCEPTIBILITY = 0.3

# congestion_factor(hour) tiers, in IST (see app/traffic.py):
TRAFFIC_PEAK_HOURS = [(8, 10.5), (17, 20.5)]       # weekday rush hours
TRAFFIC_MODERATE_HOURS = [(10.5, 17), (20.5, 22)]  # daytime / evening
TRAFFIC_PEAK_FACTOR = 1.0
TRAFFIC_MODERATE_FACTOR = 0.4
TRAFFIC_OFFPEAK_FACTOR = 0.1                       # late night / early morning

# Scale constant: at maximum susceptibility (0.85) and peak congestion (1.0),
# TRAFFIC_IMPACT=0.6 means up to ~51% slower than posted/free-flow speed.
TRAFFIC_IMPACT = 0.6

# --- Economy (fuel/energy heuristic) --------------------------------------
# Not measured vehicle telemetry — a documented approximation: real fuel
# economy roughly follows a U-shaped curve around a cruising "sweet spot"
# (rises both in heavy stop-start traffic and at high highway speeds due to
# aerodynamic drag), urban roads with more intersections waste extra fuel on
# acceleration/braking cycles, and uphill grades cost more than flat roads.
#
#   speed_penalty(v)     = ((v - ECONOMY_OPTIMAL_SPEED_KPH) / ECONOMY_OPTIMAL_SPEED_KPH)^2
#   stop_penalty(hwy)    = ECONOMY_STOP_PENALTY[hwy]
#   slope_penalty(grade) = max(0, grade) * ECONOMY_SLOPE_FACTOR      (grade = rise/run; only uphill penalized)
#   economy_cost_s(edge) = length_m * (speed_penalty + stop_penalty + slope_penalty) / REF_SPEED_MPS
ECONOMY_OPTIMAL_SPEED_KPH = 50.0
ECONOMY_STOP_PENALTY = {
    "motorway": 0.0,
    "motorway_link": 0.05,
    "trunk": 0.02,
    "trunk_link": 0.08,
    "primary": 0.05,
    "primary_link": 0.1,
    "secondary": 0.1,
    "secondary_link": 0.15,
    "tertiary": 0.2,
    "tertiary_link": 0.22,
    "unclassified": 0.25,
    "residential": 0.3,
    "living_street": 0.35,
    "service": 0.35,
}
FALLBACK_ECONOMY_STOP_PENALTY = 0.2
ECONOMY_SLOPE_FACTOR = 3.0

# Emergency mode overrides slider weights entirely: fastest real (traffic-
# aware) ETA with meaningful regard for road safety, no bias toward raw
# speed-limit class or fuel economy.
EMERGENCY_WEIGHTS = {"speed": 0.0, "time": 0.45, "safety": 0.3, "traffic": 0.25, "economy": 0.0}
