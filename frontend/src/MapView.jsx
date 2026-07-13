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

const startIcon = pinIcon("#2563eb");
const destIcon = pinIcon("#dc2626");

function ClickToSetDestination({ onSetDestination }) {
  useMapEvents({
    click(e) {
      onSetDestination({ lat: e.latlng.lat, lon: e.latlng.lng });
    },
  });
  return null;
}

function edgeKey(u, v) {
  return u < v ? `${u}_${v}` : `${v}_${u}`;
}

export default function MapView({
  center,
  mockLocation,
  setMockLocation,
  destination,
  setDestination,
  edgesGeoJson,
  blockedSet,
  onToggleBlock,
  routeCoords,
}) {
  const geoJsonRef = useRef(null);

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
    layer.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      onToggleBlock(feature.properties.u, feature.properties.v);
    });
  };

  if (!center) return <div className="map-loading">Loading map…</div>;

  return (
    <MapContainer center={[center.lat, center.lon]} zoom={14} className="map" preferCanvas={true}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickToSetDestination onSetDestination={setDestination} />

      {edgesGeoJson && (
        <GeoJSON
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
          draggable
          eventHandlers={{
            dragend: (e) => {
              const { lat, lng } = e.target.getLatLng();
              setMockLocation({ lat, lon: lng });
            },
          }}
        />
      )}

      {destination && (
        <Marker position={[destination.lat, destination.lon]} icon={destIcon} />
      )}
    </MapContainer>
  );
}
