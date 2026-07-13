import { useEffect, useMemo, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  Marker,
  Polyline,
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
  mockLocation,
  setMockLocation,
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
          positions={routeCoords.map((p) => [p.lat, p.lon])}
          pathOptions={{ color: "#16a34a", weight: 5, opacity: 0.9 }}
        />
      )}

      {mockLocation && (
        <Marker
          position={[mockLocation.lat, mockLocation.lon]}
          icon={startIcon}
          draggable={!running}
          eventHandlers={{
            dragend: (e) => {
              const { lat, lng } = e.target.getLatLng();
              setMockLocation({ lat, lon: lng });
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
