import { useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import "./App.css";
import MapView from "./MapView";
import ControlPanel from "./ControlPanel";
import {
  getBounds, getEdges, setBlock, clearBlocks, computeRoute, nearestEdge,
} from "./api";
import { cumulativeDistances, pointAtDistance } from "./geo";
import { DEFAULT_SPEED } from "./constants";

const EMERGENCY_WEIGHTS = { speed: 0, time: 60, safety: 40 };
const MIN_PLAYBACK_MS = 6000; // floor only, so very short hops don't look instantaneous

function edgeKey(u, v) {
  return u < v ? `${u}_${v}` : `${v}_${u}`;
}

function App() {
  const [center, setCenter] = useState(null);
  const [mockLocation, setMockLocation] = useState(null);
  const [destinations, setDestinations] = useState([]);
  const nextDestId = useRef(1);

  const [obstacles, setObstacles] = useState([]);
  const nextObstacleId = useRef(1);

  const [edgesGeoJson, setEdgesGeoJson] = useState(null);
  const [blockedSet, setBlockedSet] = useState(new Set());

  const [weights, setWeights] = useState({ speed: 33, time: 34, safety: 33 });
  const [emergency, setEmergency] = useState(false);

  const [mode, setMode] = useState("addDestination"); // 'setLocation' | 'addDestination' | 'addObstacle'
  const [locationMode, setLocationMode] = useState("mock");

  const [routeData, setRouteData] = useState(null);
  const [routeError, setRouteError] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);

  const [running, setRunning] = useState(false);
  const [simPosition, setSimPosition] = useState(null);
  const [speedMultiplier, setSpeedMultiplier] = useState(DEFAULT_SPEED);

  const debounceRef = useRef(null);
  const animFrameRef = useRef(null);
  const simRef = useRef(null);
  const rerouteSeqRef = useRef(0);

  useEffect(() => {
    getBounds().then((b) => {
      setCenter(b.center);
      setMockLocation(b.center);
    });
    getEdges().then((fc) => {
      setEdgesGeoJson(fc);
      const blocked = new Set();
      for (const f of fc.features) {
        if (f.properties.blocked) blocked.add(edgeKey(f.properties.u, f.properties.v));
      }
      setBlockedSet(blocked);
    });
  }, []);

  const effectiveWeights = emergency ? EMERGENCY_WEIGHTS : weights;

  // Normal debounced auto-reroute — suspended while a run is animating,
  // since position updates during a run go through the simulation loop
  // instead, and mid-run obstacle reroutes are handled explicitly.
  useEffect(() => {
    if (running || !mockLocation || destinations.length === 0) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setRouteLoading(true);
      setRouteError(null);
      try {
        const data = await computeRoute({
          start: mockLocation,
          waypoints: destinations.map(({ lat, lon }) => ({ lat, lon })),
          weights: effectiveWeights,
          emergency,
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
  }, [mockLocation, destinations, weights, emergency, blockedSet, running]);

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
    setSimPosition(pos);

    if (fraction < 1) {
      animFrameRef.current = requestAnimationFrame(tick);
    } else {
      setMockLocation(pos);
      setDestinations([]);
      setSimPosition(null);
      setRunning(false);
      simRef.current = null;
    }
  }

  const handleRun = () => {
    if (running || !routeData || destinations.length === 0 || !mockLocation) return;
    setMode("addObstacle");
    startSimFromRoute(routeData, destinations, mockLocation);
  };

  const handleStop = () => {
    if (!running) return;
    cancelAnimationFrame(animFrameRef.current);
    const s = simRef.current;
    if (s && simPosition) {
      const elapsed = s.startTime !== null ? performance.now() - s.startTime : 0;
      const targetDist = Math.min(1, elapsed / s.durationMs) * s.total;
      setDestinations(remainingDestinationsAt(s, targetDist));
      setMockLocation(simPosition);
    }
    setSimPosition(null);
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
      });
      if (rerouteSeqRef.current !== mySeq) return; // superseded by a newer reroute
      setRouteData(data);
      setDestinations(remaining);
      startSimFromRoute(data, remaining, currentPos);
    } catch (err) {
      if (rerouteSeqRef.current !== mySeq) return;
      setRouteError(err.message);
      setDestinations(remaining);
      setMockLocation(currentPos);
      setSimPosition(null);
      setRunning(false);
      simRef.current = null;
    } finally {
      if (rerouteSeqRef.current === mySeq) setRouteLoading(false);
    }
  }

  // --- Obstacles --------------------------------------------------------

  const handlePlaceObstacleAt = async (latlon) => {
    try {
      const res = await nearestEdge(latlon.lat, latlon.lon);
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
      if (running) return;
      setMockLocation(latlon);
    } else if (mode === "addDestination") {
      if (running) return;
      handleAddDestination(latlon);
    } else if (mode === "addObstacle") {
      handlePlaceObstacleAt(latlon);
    }
  };

  const routeCoords = useMemo(() => routeData?.path, [routeData]);
  const displayLocation = running ? simPosition : mockLocation;

  return (
    <div className="app">
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
      />
      <MapView
        center={center}
        mockLocation={displayLocation}
        setMockLocation={setMockLocation}
        running={running}
        destinations={destinations}
        onRemoveDestination={handleRemoveDestination}
        obstacles={obstacles}
        onRemoveObstacle={handleRemoveObstacle}
        onMapClick={handleMapClick}
        edgesGeoJson={edgesGeoJson}
        blockedSet={blockedSet}
        onRoadRightClick={handleRoadRightClick}
        routeCoords={routeCoords}
      />
    </div>
  );
}

export default App;
