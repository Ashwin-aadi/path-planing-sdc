import { useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import "./App.css";
import MapView from "./MapView";
import ControlPanel from "./ControlPanel";
import {
  getBounds, getEdges, setBlock, clearBlocks, computeRoute, nearestEdge, getRegions, getNearestRegion, geocodeSearch,
} from "./api";
import {
  cumulativeDistances, pointAtDistance, bearingDeg, computeManeuvers, nextManeuver, projectToPath,
} from "./geo";
import { useGeolocation } from "./useGeolocation";
import { DEFAULT_SPEED } from "./constants";

const EMERGENCY_WEIGHTS = { speed: 0, time: 45, safety: 30, traffic: 25, economy: 0 };
const MIN_PLAYBACK_MS = 6000; // floor only, so very short hops don't look instantaneous

function edgeKey(u, v) {
  return u < v ? `${u}_${v}` : `${v}_${u}`;
}

function App() {
  const [center, setCenter] = useState(null);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false); // mobile only — panel is an overlay there, see App.css
  const [destinations, setDestinations] = useState([]);
  const nextDestId = useRef(1);

  const [obstacles, setObstacles] = useState([]);
  const nextObstacleId = useRef(1);

  const [edgesGeoJson, setEdgesGeoJson] = useState(null);
  const [edgesKey, setEdgesKey] = useState(0);
  const [mapBounds, setMapBounds] = useState(null);
  const [blockedSet, setBlockedSet] = useState(new Set());
  const edgesFetchSeq = useRef(0);

  const [weights, setWeights] = useState({ speed: 20, time: 20, safety: 20, traffic: 20, economy: 20 });
  const [emergency, setEmergency] = useState(false);

  const [mode, setMode] = useState("addDestination"); // 'setLocation' | 'addDestination' | 'addObstacle'
  const [locationMode, setLocationMode] = useState("mock"); // 'mock' | 'real'

  const [regions, setRegions] = useState([]);
  const [region, setRegion] = useState(null);
  const [regionStatus, setRegionStatus] = useState(null); // null | {loading:true} | {error}
  const regionAutoDetectRef = useRef(false);

  const [routeData, setRouteData] = useState(null);
  const [routeError, setRouteError] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);

  const [running, setRunning] = useState(false);
  const [simPosition, setSimPosition] = useState(null);
  const [simHeading, setSimHeading] = useState(null);
  const [speedMultiplier, setSpeedMultiplier] = useState(DEFAULT_SPEED);

  const [flyTarget, setFlyTarget] = useState(null);
  const flySeqRef = useRef(0);

  const debounceRef = useRef(null);
  const animFrameRef = useRef(null);
  const simRef = useRef(null);
  const rerouteSeqRef = useRef(0);

  const geo = useGeolocation(locationMode === "real");

  // --- Regions ------------------------------------------------------------

  useEffect(() => {
    getRegions().then((r) => {
      setRegions(r.regions);
      setRegion(r.default);
    });
  }, []);

  // Loads (and, first time only, triggers the backend to build) whichever
  // region is selected. Runs once at startup and again on every switch.
  useEffect(() => {
    if (!region) return;
    let cancelled = false;
    setRegionStatus({ loading: true });
    getBounds(region)
      .then((b) => {
        if (cancelled) return;
        setCenter(b.center);
        setCurrentLocation(b.center);
        setRegionStatus(null);
        setRegions((prev) => prev.map((r) => (r.id === region ? { ...r, ready: true } : r)));
      })
      .catch((err) => {
        if (cancelled) return;
        setRegionStatus({ error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [region]);

  const handleRegionChange = (newRegion) => {
    if (!newRegion || newRegion === region) return;
    setDestinations([]);
    setObstacles([]);
    setBlockedSet(new Set());
    setEdgesGeoJson(null);
    setEdgesKey((k) => k + 1);
    setRouteData(null);
    setRouteError(null);
    setMapBounds(null);
    setRegion(newRegion);
  };

  // First real GPS fix after switching to "real" mode: auto-load whichever
  // region actually covers where the device is, so testing away from the
  // default demo city (e.g. Gwalior) doesn't route against the wrong map.
  useEffect(() => {
    if (locationMode !== "real") {
      regionAutoDetectRef.current = false;
      return;
    }
    if (!geo.position || regionAutoDetectRef.current) return;
    regionAutoDetectRef.current = true;
    getNearestRegion(geo.position.lat, geo.position.lon).then((res) => {
      if (res.region !== region) handleRegionChange(res.region);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationMode, geo.position]);

  // While in real mode (and not mid drive-simulation), location tracks the GPS fix directly.
  useEffect(() => {
    if (locationMode === "real" && geo.position && !running) {
      setCurrentLocation(geo.position);
    }
  }, [locationMode, geo.position, running]);

  // "Set location" has nothing to do in real mode (location comes from GPS) —
  // avoid leaving the map tool stuck there with no effect.
  useEffect(() => {
    if (locationMode === "real" && mode === "setLocation") setMode("addDestination");
  }, [locationMode, mode]);

  // The graph now spans a wide area, so only the roads visible in the
  // current viewport (plus padding) are fetched — re-fetched whenever the
  // map settles after a pan/zoom (including the recenter that follows a
  // region switch). A sequence guard drops stale responses if a fetch from
  // an earlier viewport resolves after a newer one.
  useEffect(() => {
    if (!mapBounds || !region) return;
    const mySeq = ++edgesFetchSeq.current;
    getEdges(mapBounds, region).then((fc) => {
      if (edgesFetchSeq.current !== mySeq) return;
      setEdgesGeoJson(fc);
      setEdgesKey((k) => k + 1);
      setBlockedSet((prev) => {
        const next = new Set(prev);
        for (const f of fc.features) {
          const key = edgeKey(f.properties.u, f.properties.v);
          if (f.properties.blocked) next.add(key);
          else next.delete(key);
        }
        return next;
      });
    });
  }, [mapBounds, region]);

  const effectiveWeights = emergency ? EMERGENCY_WEIGHTS : weights;

  // Normal debounced auto-reroute — suspended while a run is animating,
  // since position updates during a run go through the simulation loop
  // instead, and mid-run obstacle reroutes are handled explicitly.
  useEffect(() => {
    if (running || !currentLocation || destinations.length === 0) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setRouteLoading(true);
      setRouteError(null);
      try {
        const data = await computeRoute({
          start: currentLocation,
          waypoints: destinations.map(({ lat, lon }) => ({ lat, lon })),
          weights: effectiveWeights,
          emergency,
          region,
        });
        setRouteData(data);
      } catch (err) {
        setRouteData(null);
        setRouteError(err.message);
      } finally {
        setRouteLoading(false);
      }
    }, 400);

    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLocation, destinations, weights, emergency, blockedSet, running, region]);

  const handleAddDestination = (latlon) => {
    setDestinations((prev) => [...prev, { ...latlon, id: nextDestId.current++ }]);
  };

  const handleRemoveDestination = (id) => {
    setDestinations((prev) => prev.filter((d) => d.id !== id));
  };

  const handleClearBlocks = async () => {
    await clearBlocks();
    setBlockedSet(new Set());
    setObstacles([]);
  };

  // --- Run simulation -------------------------------------------------

  function playbackDurationFor(etaSeconds, multiplier) {
    return Math.max(MIN_PLAYBACK_MS, (etaSeconds / multiplier) * 1000);
  }

  function startSimFromRoute(data, destsAtStart, startPoint) {
    const path = data.path;
    const cumDist = cumulativeDistances(path);
    const total = cumDist[cumDist.length - 1];

    const legBoundaries = [];
    let acc = 0;
    for (const legDist of data.leg_distances_m) {
      acc += legDist;
      legBoundaries.push(acc);
    }

    simRef.current = {
      path, cumDist, total, legBoundaries,
      destinations: destsAtStart,
      startTime: null,
      etaSeconds: data.eta_s,
      durationMs: playbackDurationFor(data.eta_s, speedMultiplier),
    };
    setRunning(true);
    setSimPosition(startPoint);
    animFrameRef.current = requestAnimationFrame(tick);
  }

  // Changing speed mid-run rescales the remaining animation without
  // jumping the car's current position: same fraction traveled, new pace.
  const handleSetSpeed = (multiplier) => {
    setSpeedMultiplier(multiplier);
    const s = simRef.current;
    if (s && running) {
      const now = performance.now();
      const elapsed = s.startTime !== null ? now - s.startTime : 0;
      const fraction = Math.min(1, elapsed / s.durationMs);
      const newDuration = playbackDurationFor(s.etaSeconds, multiplier);
      s.durationMs = newDuration;
      s.startTime = now - fraction * newDuration;
    }
  };

  function remainingDestinationsAt(s, targetDist) {
    let passed = 0;
    for (const b of s.legBoundaries) {
      if (targetDist >= b - 1) passed++;
      else break;
    }
    return s.destinations.slice(passed);
  }

  function tick(now) {
    const s = simRef.current;
    if (!s) return;
    if (s.startTime === null) s.startTime = now;
    const elapsed = now - s.startTime;
    const fraction = Math.min(1, elapsed / s.durationMs);
    const targetDist = fraction * s.total;
    const pos = pointAtDistance(s.path, s.cumDist, targetDist);
    const lookahead = pointAtDistance(s.path, s.cumDist, Math.min(s.total, targetDist + 5));
    setSimPosition(pos);
    setSimHeading(bearingDeg(pos, lookahead));

    if (fraction < 1) {
      animFrameRef.current = requestAnimationFrame(tick);
    } else {
      setCurrentLocation(pos);
      setDestinations([]);
      setSimPosition(null);
      setSimHeading(null);
      setRunning(false);
      simRef.current = null;
    }
  }

  const handleRun = () => {
    if (running || !routeData || destinations.length === 0 || !currentLocation || locationMode !== "mock") return;
    setMode("addObstacle");
    setPanelOpen(false); // no-op on desktop; on mobile, show the map while driving
    startSimFromRoute(routeData, destinations, currentLocation);
  };

  const handleStop = () => {
    if (!running) return;
    cancelAnimationFrame(animFrameRef.current);
    const s = simRef.current;
    if (s && simPosition) {
      const elapsed = s.startTime !== null ? performance.now() - s.startTime : 0;
      const targetDist = Math.min(1, elapsed / s.durationMs) * s.total;
      setDestinations(remainingDestinationsAt(s, targetDist));
      setCurrentLocation(simPosition);
    }
    setSimPosition(null);
    setSimHeading(null);
    setRunning(false);
    simRef.current = null;
  };

  async function rerouteDuringRun() {
    const s = simRef.current;
    if (!s || !running) return;

    const mySeq = ++rerouteSeqRef.current;
    const elapsed = s.startTime !== null ? performance.now() - s.startTime : 0;
    const targetDist = Math.min(1, elapsed / s.durationMs) * s.total;
    const currentPos = pointAtDistance(s.path, s.cumDist, targetDist);
    const remaining = remainingDestinationsAt(s, targetDist);

    if (remaining.length === 0) return;

    cancelAnimationFrame(animFrameRef.current);
    setRouteLoading(true);
    setRouteError(null);
    try {
      const data = await computeRoute({
        start: currentPos,
        waypoints: remaining.map(({ lat, lon }) => ({ lat, lon })),
        weights: effectiveWeights,
        emergency,
        region,
      });
      if (rerouteSeqRef.current !== mySeq) return; // superseded by a newer reroute
      setRouteData(data);
      setDestinations(remaining);
      startSimFromRoute(data, remaining, currentPos);
    } catch (err) {
      if (rerouteSeqRef.current !== mySeq) return;
      setRouteError(err.message);
      setDestinations(remaining);
      setCurrentLocation(currentPos);
      setSimPosition(null);
      setSimHeading(null);
      setRunning(false);
      simRef.current = null;
    } finally {
      if (rerouteSeqRef.current === mySeq) setRouteLoading(false);
    }
  }

  // --- Obstacles --------------------------------------------------------

  const handlePlaceObstacleAt = async (latlon) => {
    try {
      const res = await nearestEdge(latlon.lat, latlon.lon, region);
      const { u, v, snapped } = res;
      const key = edgeKey(u, v);
      if (blockedSet.has(key)) return;

      await setBlock(u, v, true);
      setBlockedSet((prev) => new Set(prev).add(key));
      setObstacles((prev) => [...prev, { id: nextObstacleId.current++, u, v, lat: snapped.lat, lon: snapped.lon }]);
      if (running) rerouteDuringRun();
    } catch (err) {
      setRouteError(err.message);
    }
  };

  const handleRemoveObstacle = async (id) => {
    const obs = obstacles.find((o) => o.id === id);
    if (!obs) return;
    setObstacles((prev) => prev.filter((o) => o.id !== id));
    await setBlock(obs.u, obs.v, false);
    setBlockedSet((prev) => {
      const next = new Set(prev);
      next.delete(edgeKey(obs.u, obs.v));
      return next;
    });
    if (running) rerouteDuringRun();
  };

  const handleRoadRightClick = async (u, v, latlon) => {
    const key = edgeKey(u, v);
    if (blockedSet.has(key)) {
      const obs = obstacles.find((o) => edgeKey(o.u, o.v) === key);
      if (obs) {
        await handleRemoveObstacle(obs.id);
      } else {
        await setBlock(u, v, false);
        setBlockedSet((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        if (running) rerouteDuringRun();
      }
    } else {
      await setBlock(u, v, true);
      setBlockedSet((prev) => new Set(prev).add(key));
      setObstacles((prev) => [...prev, { id: nextObstacleId.current++, u, v, lat: latlon.lat, lon: latlon.lon }]);
      if (running) rerouteDuringRun();
    }
  };

  // --- Map click dispatch -------------------------------------------------

  const handleMapClick = (latlon) => {
    if (mode === "setLocation") {
      if (running || locationMode !== "mock") return;
      setCurrentLocation(latlon);
    } else if (mode === "addDestination") {
      if (running) return;
      handleAddDestination(latlon);
    } else if (mode === "addObstacle") {
      handlePlaceObstacleAt(latlon);
    }
  };

  // --- Place-name search (free OSM Nominatim geocoding) -------------------

  const handleSearch = (query) => geocodeSearch(query, region);

  // Picking a result behaves exactly like clicking the map there — same
  // setLocation/addDestination/addObstacle dispatch — plus panning the map
  // there so the choice is visible even if it's off-screen.
  const handleSelectSearchResult = ({ lat, lon }) => {
    setFlyTarget({ lat, lon, seq: ++flySeqRef.current });
    handleMapClick({ lat, lon });
    setPanelOpen(false); // no-op on desktop; on mobile, reveal the map so the pick is visible
  };

  const routeCoords = useMemo(() => routeData?.path, [routeData]);
  const displayLocation = running ? simPosition : currentLocation;

  // --- Orientation & direction assistance --------------------------------

  const routeGeom = useMemo(() => {
    if (!routeData) return null;
    const cumDist = cumulativeDistances(routeData.path);
    return {
      path: routeData.path,
      cumDist,
      total: cumDist[cumDist.length - 1],
      maneuvers: computeManeuvers(routeData.path, cumDist),
    };
  }, [routeData]);

  const progress = useMemo(() => {
    if (!routeGeom || !displayLocation) return null;
    return projectToPath(routeGeom.path, routeGeom.cumDist, displayLocation);
  }, [routeGeom, displayLocation]);

  const upcomingManeuver = useMemo(() => {
    if (!routeGeom || !progress) return null;
    const m = nextManeuver(routeGeom.maneuvers, progress.along);
    if (!m) return null;
    return { ...m, remainingM: Math.max(0, m.dist - progress.along) };
  }, [routeGeom, progress]);

  const distanceRemainingM = routeGeom && progress ? Math.max(0, routeGeom.total - progress.along) : null;

  // Real GPS/compass heading while driving live; a synthetic look-ahead
  // bearing along the route while animating a simulated run; otherwise no
  // meaningful "facing direction" to show.
  const heading = locationMode === "real" ? geo.heading : running ? simHeading : null;

  return (
    <div className={panelOpen ? "app panel-open" : "app"}>
      <button
        className="mobile-panel-toggle"
        onClick={() => setPanelOpen((o) => !o)}
        aria-label={panelOpen ? "Close controls" : "Open controls"}
      >
        {panelOpen ? "✕" : "☰"}
      </button>
      <ControlPanel
        weights={weights}
        setWeights={setWeights}
        emergency={emergency}
        setEmergency={setEmergency}
        mode={mode}
        setMode={setMode}
        locationMode={locationMode}
        setLocationMode={setLocationMode}
        running={running}
        onRun={handleRun}
        onStop={handleStop}
        speedMultiplier={speedMultiplier}
        onSetSpeed={handleSetSpeed}
        routeData={routeData}
        routeError={routeError}
        routeLoading={routeLoading}
        onClearBlocks={handleClearBlocks}
        destinations={destinations}
        onRemoveDestination={handleRemoveDestination}
        obstacles={obstacles}
        onRemoveObstacle={handleRemoveObstacle}
        regions={regions}
        region={region}
        onRegionChange={handleRegionChange}
        regionStatus={regionStatus}
        geo={geo}
        heading={heading}
        upcomingManeuver={upcomingManeuver}
        distanceRemainingM={distanceRemainingM}
        onSearch={handleSearch}
        onSelectSearchResult={handleSelectSearchResult}
      />
      <MapView
        center={center}
        currentLocation={displayLocation}
        setCurrentLocation={setCurrentLocation}
        heading={heading}
        locationMode={locationMode}
        flyTarget={flyTarget}
        running={running}
        destinations={destinations}
        onRemoveDestination={handleRemoveDestination}
        obstacles={obstacles}
        onRemoveObstacle={handleRemoveObstacle}
        onMapClick={handleMapClick}
        onBoundsChange={setMapBounds}
        edgesGeoJson={edgesGeoJson}
        edgesKey={edgesKey}
        blockedSet={blockedSet}
        onRoadRightClick={handleRoadRightClick}
        routeCoords={routeCoords}
      />
    </div>
  );
}

export default App;
