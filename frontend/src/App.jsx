import { useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import "./App.css";
import MapView from "./MapView";
import ControlPanel from "./ControlPanel";
import { getBounds, getEdges, toggleBlock, clearBlocks, computeRoute } from "./api";

const EMERGENCY_WEIGHTS = { speed: 60, time: 40, safety: 0 };

function App() {
  const [center, setCenter] = useState(null);
  const [mockLocation, setMockLocation] = useState(null);
  const [destination, setDestination] = useState(null);

  const [edgesGeoJson, setEdgesGeoJson] = useState(null);
  const [blockedSet, setBlockedSet] = useState(new Set());

  const [weights, setWeights] = useState({ speed: 33, time: 34, safety: 33 });
  const [emergency, setEmergency] = useState(false);

  const [locationMode, setLocationMode] = useState("mock");

  const [routeData, setRouteData] = useState(null);
  const [routeError, setRouteError] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);

  const debounceRef = useRef(null);

  useEffect(() => {
    getBounds().then((b) => {
      setCenter(b.center);
      setMockLocation(b.center);
    });
    getEdges().then((fc) => {
      setEdgesGeoJson(fc);
      const blocked = new Set();
      for (const f of fc.features) {
        if (f.properties.blocked) {
          const { u, v } = f.properties;
          blocked.add(u < v ? `${u}_${v}` : `${v}_${u}`);
        }
      }
      setBlockedSet(blocked);
    });
  }, []);

  const effectiveWeights = emergency ? EMERGENCY_WEIGHTS : weights;

  useEffect(() => {
    if (!mockLocation || !destination) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setRouteLoading(true);
      setRouteError(null);
      try {
        const data = await computeRoute({
          start: mockLocation,
          end: destination,
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
  }, [mockLocation, destination, weights, emergency, blockedSet]);

  const handleToggleBlock = async (u, v) => {
    const res = await toggleBlock(u, v);
    setBlockedSet((prev) => {
      const next = new Set(prev);
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      if (res.blocked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const handleClearBlocks = async () => {
    await clearBlocks();
    setBlockedSet(new Set());
  };

  const routeCoords = useMemo(() => routeData?.path, [routeData]);

  return (
    <div className="app">
      <ControlPanel
        weights={weights}
        setWeights={setWeights}
        emergency={emergency}
        setEmergency={setEmergency}
        locationMode={locationMode}
        setLocationMode={setLocationMode}
        routeData={routeData}
        routeError={routeError}
        routeLoading={routeLoading}
        blockedCount={blockedSet.size}
        onClearBlocks={handleClearBlocks}
        hasDestination={!!destination}
      />
      <MapView
        center={center}
        mockLocation={mockLocation}
        setMockLocation={setMockLocation}
        destination={destination}
        setDestination={setDestination}
        edgesGeoJson={edgesGeoJson}
        blockedSet={blockedSet}
        onToggleBlock={handleToggleBlock}
        routeCoords={routeCoords}
      />
    </div>
  );
}

export default App;
