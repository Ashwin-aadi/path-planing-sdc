import { useEffect, useMemo, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  Marker,
  Polyline,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";

function pinIcon(color) {
  return L.divIcon({
    className: "",
    html: `<div style="
      width:18px;height:18px;border-radius:50% 50% 50% 0;
      background:${color};transform:rotate(-45deg);
      border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.5);
    "></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 18],
  });
}

function numberedIcon(n) {
  return L.divIcon({
    className: "",
    html: `<div style="
      width:22px;height:22px;border-radius:50%;
      background:#dc2626;color:white;font:600 12px system-ui;
      display:flex;align-items:center;justify-content:center;
      border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.5);
    ">${n}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

const obstacleIcon = L.divIcon({
  className: "",
  html: `<div style="
    width:20px;height:20px;display:flex;align-items:center;justify-content:center;
    background:#f59e0b;color:#1f2430;font:700 12px system-ui;border-radius:4px;
    transform:rotate(45deg);border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.5);
  "><span style="transform:rotate(-45deg)">!</span></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

const startIcon = pinIcon("#2563eb");

// Directional arrow, rotated to the current heading (0deg = north, clockwise) —
// used in place of the plain pin whenever a heading (real compass/GPS course,
// or the simulated drive's look-ahead bearing) is actually known.
function headingIcon(heading, color = "#2563eb") {
  return L.divIcon({
    className: "",
    html: `<div style="
      width:26px;height:26px;transform:rotate(${heading}deg);
      display:flex;align-items:center;justify-content:center;
    "><svg width="24" height="24" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,.6))">
      <path d="M12 2 L19 21 L12 16.5 L5 21 Z" fill="${color}" stroke="white" stroke-width="1.2"/>
    </svg></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

// react-leaflet only applies MapContainer's `center` prop once, at mount —
// this re-centers the live map whenever `center` changes afterward (e.g. a
// region switch), without needing to remount the whole map.
function Recenter({ center }) {
  const map = useMap();
  useEffect(() => {
    if (center) map.setView([center.lat, center.lon], map.getZoom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center]);
  return null;
}

// Pans (with animation) to a search-selected location. `target` carries a
// monotonic `seq` so picking the same result twice in a row still flies —
// a plain lat/lon object wouldn't change and the effect wouldn't re-fire.
function FlyTo({ target }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lon], Math.max(map.getZoom(), 15));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return null;
}

function MapClickHandler({ onMapClick }) {
  useMapEvents({
    click(e) {
      onMapClick({ lat: e.latlng.lat, lon: e.latlng.lng });
    },
  });
  return null;
}

function boundsToBox(leafletBounds) {
  return {
    min_lat: leafletBounds.getSouth(), max_lat: leafletBounds.getNorth(),
    min_lon: leafletBounds.getWest(), max_lon: leafletBounds.getEast(),
  };
}

function contains(outer, inner) {
  return (
    inner.min_lat >= outer.min_lat && inner.max_lat <= outer.max_lat &&
    inner.min_lon >= outer.min_lon && inner.max_lon <= outer.max_lon
  );
}

function BoundsWatcher({ onBoundsChange }) {
  const loadedRef = useRef(null);

  const maybeFetch = (map) => {
    const view = boundsToBox(map.getBounds());
    if (loadedRef.current && contains(loadedRef.current, view)) return;
    const padded = boundsToBox(map.getBounds().pad(0.3));
    loadedRef.current = padded;
    onBoundsChange(padded);
  };

  const map = useMapEvents({
    moveend: () => maybeFetch(map),
  });
  useEffect(() => {
    maybeFetch(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function edgeKey(u, v) {
  return u < v ? `${u}_${v}` : `${v}_${u}`;
}

export default function MapView({
  center,
  currentLocation,
  setCurrentLocation,
  heading,
  locationMode,
  flyTarget,
  running,
  destinations,
  onRemoveDestination,
  obstacles,
  onRemoveObstacle,
  onMapClick,
  onBoundsChange,
  edgesGeoJson,
  edgesKey,
  blockedSet,
  onRoadRightClick,
  routeCoords,
}) {
  const geoJsonRef = useRef(null);

  // react-leaflet's GeoJSON only invokes onEachFeature once, at layer
  // creation — the "contextmenu" listener registered inside it would
  // otherwise keep whatever onRoadRightClick closure existed at that
  // moment forever (stale `running`/`blockedSet`). Route through a ref
  // that's kept current every render so the listener always calls the
  // latest handler.
  const onRoadRightClickRef = useRef(onRoadRightClick);
  useEffect(() => {
    onRoadRightClickRef.current = onRoadRightClick;
  }, [onRoadRightClick]);

  const styleFn = useMemo(
    () => (feature) => {
      const key = edgeKey(feature.properties.u, feature.properties.v);
      const blocked = blockedSet.has(key);
      return {
        color: blocked ? "#dc2626" : "#94a3b8",
        weight: blocked ? 4 : 2,
        opacity: blocked ? 0.9 : 0.55,
        dashArray: blocked ? "6 4" : null,
      };
    },
    [blockedSet]
  );

  useEffect(() => {
    // Leaflet's GeoJSON layer only applies the style function at creation
    // time; re-apply it explicitly whenever which roads are blocked changes.
    geoJsonRef.current?.setStyle(styleFn);
  }, [styleFn]);

  const onEachFeature = (feature, layer) => {
    layer.on("contextmenu", (e) => {
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
      onRoadRightClickRef.current(feature.properties.u, feature.properties.v, {
        lat: e.latlng.lat,
        lon: e.latlng.lng,
      });
    });
  };

  if (!center) return <div className="map-loading">Loading map…</div>;

  return (
    <MapContainer center={[center.lat, center.lon]} zoom={14} className="map" preferCanvas={true}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <MapClickHandler onMapClick={onMapClick} />
      <BoundsWatcher onBoundsChange={onBoundsChange} />
      <Recenter center={center} />
      <FlyTo target={flyTarget} />

      {edgesGeoJson && (
        <GeoJSON
          key={edgesKey}
          ref={geoJsonRef}
          data={edgesGeoJson}
          style={styleFn}
          onEachFeature={onEachFeature}
        />
      )}

      {routeCoords && routeCoords.length > 1 && (
        <Polyline
          // While driving, the still-to-cover track renders charcoal black
          // (the covered part behind the car is already trimmed off by App);
          // when planning, the full route shows in dark green.
          pathOptions={{ color: running ? "#28282b" : "#16a34a", weight: 5, opacity: 0.9 }}
          positions={routeCoords.map((p) => [p.lat, p.lon])}
        />
      )}

      {currentLocation && (
        <Marker
          position={[currentLocation.lat, currentLocation.lon]}
          icon={heading != null ? headingIcon(heading) : startIcon}
          draggable={!running && locationMode === "mock"}
          eventHandlers={{
            dragend: (e) => {
              const { lat, lng } = e.target.getLatLng();
              setCurrentLocation({ lat, lon: lng });
            },
          }}
        />
      )}

      {destinations.map((d, i) => (
        <Marker
          key={d.id}
          position={[d.lat, d.lon]}
          icon={numberedIcon(i + 1)}
          eventHandlers={{
            click: () => onRemoveDestination(d.id),
          }}
        />
      ))}

      {obstacles.map((o) => (
        <Marker
          key={o.id}
          position={[o.lat, o.lon]}
          icon={obstacleIcon}
          eventHandlers={{
            click: () => onRemoveObstacle(o.id),
          }}
        />
      ))}
    </MapContainer>
  );
}
