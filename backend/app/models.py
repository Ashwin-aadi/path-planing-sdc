from typing import Literal, Optional

from pydantic import BaseModel, Field


class LatLon(BaseModel):
    lat: float
    lon: float


class Weights(BaseModel):
    speed: float = Field(ge=0)
    time: float = Field(ge=0)
    safety: float = Field(ge=0)
    traffic: float = Field(ge=0)
    economy: float = Field(ge=0)


class RouteRequest(BaseModel):
    start: LatLon
    waypoints: list[LatLon] = Field(min_length=1)
    weights: Weights
    emergency: bool = False


class BlockRequest(BaseModel):
    u: int
    v: int


class SetBlockRequest(BaseModel):
    u: int
    v: int
    blocked: bool


class RouteResponse(BaseModel):
    path: list[LatLon]
    distance_m: float
    eta_s: float
    compute_ms: float
    nodes_expanded: int
    weights_used: Weights
    start_snapped: LatLon
    end_snapped: LatLon
    snap_dist_start_m: float
    snap_dist_end_m: float
    leg_distances_m: list[float]
    traffic_delay_s: float
    congestion_factor: float
