"""Static configuration for the routing backend."""

# MNNIT Allahabad (Motilal Nehru National Institute of Technology), Prayagraj, India
CENTER_LAT = 25.4926
CENTER_LON = 81.8662
GRAPH_RADIUS_M = 10000  # 10km radius drivable network around campus

CACHE_DIR = "./osm_cache"
GRAPHML_PATH = "./osm_cache/mnnit_area.graphml"

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

# Emergency mode overrides slider weights entirely: fastest ETA with
# meaningful regard for road safety, no bias toward raw speed-limit class.
EMERGENCY_WEIGHTS = {"speed": 0.0, "time": 0.6, "safety": 0.4}
