import { useEffect, useState } from "react";
import { SPEED_OPTIONS, MAX_SPEED } from "./constants";

const EMERGENCY_PRESET = { speed: 0, time: 45, safety: 30, traffic: 25, economy: 0 };

// Log-scale mapping so the slider gives usable resolution across the whole
// 1-1000x range instead of cramming 1-50x into the first few percent.
function speedToSlider(speed) {
  return Math.round((Math.log(speed) / Math.log(MAX_SPEED)) * 1000);
}
function sliderToSpeed(pos) {
  return Math.max(1, Math.round(Math.pow(MAX_SPEED, pos / 1000)));
}

function SpeedControl({ value, onChange }) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const n = Math.max(1, Math.min(MAX_SPEED, Math.round(Number(text)) || 1));
    setText(String(n));
    if (n !== value) onChange(n);
  };

  return (
    <div className="speed-custom">
      <input
        type="range"
        min={0}
        max={1000}
        value={speedToSlider(value)}
        onChange={(e) => onChange(sliderToSpeed(Number(e.target.value)))}
      />
      <div className="speed-custom-input">
        <input
          type="number"
          min={1}
          max={MAX_SPEED}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <span>×</span>
      </div>
    </div>
  );
}

// Keeps the three weights summing to 100: the slider being dragged takes
// (or gives back) share proportionally from/to the other two, preserving
// their relative ratio to each other.
function rebalanceWeights(weights, changedKey, rawValue) {
  const newValue = Math.max(0, Math.min(100, rawValue));
  const otherKeys = Object.keys(weights).filter((k) => k !== changedKey);
  const otherSum = otherKeys.reduce((s, k) => s + weights[k], 0);
  const remaining = 100 - newValue;

  const next = { ...weights, [changedKey]: newValue };
  if (otherSum > 0) {
    otherKeys.forEach((k) => {
      next[k] = (weights[k] / otherSum) * remaining;
    });
  } else {
    otherKeys.forEach((k) => {
      next[k] = remaining / otherKeys.length;
    });
  }
  return next;
}

function Slider({ label, value, onChange, pct, disabled }) {
  return (
    <div className="slider-row">
      <div className="slider-label">
        <span>{label}</span>
        <span className="slider-pct">{pct}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function compassPoint(heading) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(heading / 22.5) % 16];
}

function LocationSearch({ onSearch, onSelectResult, modeHint }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Only ever searches on explicit submit, never per-keystroke — Nominatim's
  // free-tier usage policy disallows autocomplete-style query-as-you-type.
  const handleSubmit = async (e) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const res = await onSearch(q);
      setResults(res.results);
      if (res.results.length === 0) setError("No matches found.");
    } catch (err) {
      setResults([]);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePick = (result) => {
    onSelectResult(result);
    setResults([]);
    setQuery(result.label);
  };

  return (
    <section>
      <h2>Search location</h2>
      <form className="search-row" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Search a place, e.g. Gwalior Fort"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={loading || !query.trim()}>
          {loading ? "…" : "Search"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {results.length > 0 && (
        <ul className="search-results">
          {results.map((r, i) => (
            <li key={i}>
              <button className="search-result-item" onClick={() => handlePick(r)}>
                {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        Free OSM place search (no API key) — a result is applied using the current map tool ({modeHint}).
      </p>
    </section>
  );
}

export default function ControlPanel({
  weights,
  setWeights,
  emergency,
  setEmergency,
  mode,
  setMode,
  locationMode,
  setLocationMode,
  running,
  onRun,
  onStop,
  speedMultiplier,
  onSetSpeed,
  routeData,
  routeError,
  routeLoading,
  onClearBlocks,
  destinations,
  onRemoveDestination,
  obstacles,
  onRemoveObstacle,
  regions,
  region,
  onRegionChange,
  regionStatus,
  geo,
  heading,
  upcomingManeuver,
  distanceRemainingM,
  onSearch,
  onSelectSearchResult,
}) {
  const shown = emergency ? EMERGENCY_PRESET : weights;
  const pct = (v) => Math.round(v);
  const handleWeightChange = (key, v) => setWeights((w) => rebalanceWeights(w, key, v));

  const canRun = !running && destinations.length > 0 && !!routeData && locationMode === "mock";
  const currentRegionInfo = regions.find((r) => r.id === region);
  const modeHint =
    mode === "setLocation" ? "sets location" : mode === "addObstacle" ? "adds obstacle" : "adds destination";

  return (
    <div className="panel">
      <h1>Route Planner</h1>
      <p className="subtitle">Phase 2 — A* over live OpenStreetMap data, real GPS + orientation</p>

      <section>
        <h2>Region</h2>
        <select
          className="region-select"
          value={region || ""}
          onChange={(e) => onRegionChange(e.target.value)}
          disabled={!regions.length}
        >
          {regions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}{!r.ready ? " (first load takes ~1-2 min)" : ""}
            </option>
          ))}
        </select>
        {regionStatus?.loading && (
          <p className="hint">
            Loading {currentRegionInfo?.label || "map"}
            {currentRegionInfo && !currentRegionInfo.ready ? " — first time here, downloading + processing OSM data, this can take a minute or two…" : "…"}
          </p>
        )}
        {regionStatus?.error && <p className="error">{regionStatus.error}</p>}
        <p className="hint">Switch regions manually, or enable real location below to auto-detect it from GPS.</p>
      </section>

      <LocationSearch onSearch={onSearch} onSelectResult={onSelectSearchResult} modeHint={modeHint} />

      <section>
        <h2>Location source</h2>
        <div className="toggle-row">
          <button
            className={locationMode === "mock" ? "toggle-btn active" : "toggle-btn"}
            onClick={() => setLocationMode("mock")}
          >
            Mock location
          </button>
          <button
            className={locationMode === "real" ? "toggle-btn active" : "toggle-btn"}
            onClick={() => setLocationMode("real")}
          >
            Real GPS location
          </button>
        </div>
        {locationMode === "real" && (
          <div className="gps-status">
            {geo.error && <p className="error">{geo.error}</p>}
            {!geo.error && !geo.position && <p className="hint">Waiting for a GPS fix…</p>}
            {geo.position && (
              <p className="hint">
                Fix acquired{geo.accuracy != null ? ` (±${Math.round(geo.accuracy)}m)` : ""}.
              </p>
            )}
            {geo.compassPermission === "needs-request" && (
              <button className="secondary-btn" onClick={geo.requestCompassPermission}>
                Enable compass
              </button>
            )}
            {geo.compassPermission === "denied" && (
              <p className="hint">Compass permission denied — heading will fall back to GPS course while moving.</p>
            )}
            {geo.compassPermission === "unavailable" && (
              <p className="hint">No orientation sensor on this device/browser — heading uses GPS course while moving.</p>
            )}
          </div>
        )}
      </section>

      {(heading != null || (routeData && (upcomingManeuver || distanceRemainingM != null))) && (
        <section>
          <h2>Orientation &amp; direction</h2>
          {heading != null && (
            <div className="stat-row">
              <span>Heading</span>
              <span>{Math.round(heading)}° {compassPoint(heading)}</span>
            </div>
          )}
          {routeData && distanceRemainingM != null && (
            <div className="stat-row">
              <span>Remaining</span>
              <span>{formatDistance(distanceRemainingM)}</span>
            </div>
          )}
          {routeData && (
            <p className="direction-hint">
              {upcomingManeuver
                ? `In ${formatDistance(upcomingManeuver.remainingM)}, ${upcomingManeuver.direction === "u-turn" ? "make a U-turn" : `turn ${upcomingManeuver.direction}`}`
                : "Continue straight — arriving soon"}
            </p>
          )}
        </section>
      )}

      <section>
        <h2>Map tool</h2>
        <div className="toolbar">
          <button
            className={mode === "setLocation" ? "tool-btn active" : "tool-btn"}
            disabled={running || locationMode === "real"}
            title={locationMode === "real" ? "Location follows real GPS in this mode" : undefined}
            onClick={() => setMode("setLocation")}
          >
            📍 Set location
          </button>
          <button
            className={mode === "addDestination" ? "tool-btn active" : "tool-btn"}
            disabled={running}
            onClick={() => setMode("addDestination")}
          >
            🚩 Add destination
          </button>
          <button
            className={mode === "addObstacle" ? "tool-btn active" : "tool-btn"}
            onClick={() => setMode("addObstacle")}
          >
            ⚠ Add obstacle
          </button>
        </div>
        <p className="hint">
          Pick a tool, then click the map. The active tool stays selected until you change it.
          Right-click any road always toggles an obstacle there too.
        </p>
      </section>

      <section>
        <h2>Route mode</h2>
        <Slider
          label="Speed (favor high speed-limit roads)"
          value={weights.speed}
          pct={pct(shown.speed)}
          disabled={emergency}
          onChange={(v) => handleWeightChange("speed", v)}
        />
        <Slider
          label="Time (minimize ETA)"
          value={weights.time}
          pct={pct(shown.time)}
          disabled={emergency}
          onChange={(v) => handleWeightChange("time", v)}
        />
        <Slider
          label="Safety (broad roads, avoid highways)"
          value={weights.safety}
          pct={pct(shown.safety)}
          disabled={emergency}
          onChange={(v) => handleWeightChange("safety", v)}
        />
        <Slider
          label="Traffic (avoid current congestion)"
          value={weights.traffic}
          pct={pct(shown.traffic)}
          disabled={emergency}
          onChange={(v) => handleWeightChange("traffic", v)}
        />
        <Slider
          label="Economy (fuel-efficient driving)"
          value={weights.economy}
          pct={pct(shown.economy)}
          disabled={emergency}
          onChange={(v) => handleWeightChange("economy", v)}
        />
        <p className="hint">
          Traffic is a rough time-of-day heuristic, not live data (no free live-traffic API exists).
          Economy accounts for cruising speed, stop-and-go roads, and uphill grade.
        </p>
      </section>

      <section>
        <button
          className={emergency ? "emergency-btn active" : "emergency-btn"}
          onClick={() => setEmergency((e) => !e)}
        >
          {emergency ? "Emergency mode ON" : "Emergency mode"}
        </button>
        {emergency && (
          <p className="hint">Overrides sliders: fastest ETA with safety still weighted in, no bias toward raw road speed.</p>
        )}
      </section>

      <section>
        <h2>Drive</h2>
        {!running ? (
          <button className="run-btn" onClick={onRun} disabled={!canRun}>
            ▶ Run
          </button>
        ) : (
          <button className="run-btn stop" onClick={onStop}>
            ⏹ Stop
          </button>
        )}
        {locationMode === "real" && (
          <p className="hint">Drive simulation is mock-location only — with real GPS the route just follows you live.</p>
        )}
        {locationMode === "mock" && !canRun && !running && (
          <p className="hint">Add at least one destination to enable Run.</p>
        )}
        {running && (
          <p className="hint">Driving the route — add an obstacle to force a live reroute.</p>
        )}

        <div className="speed-row">
          {SPEED_OPTIONS.map((s) => (
            <button
              key={s}
              className={speedMultiplier === s ? "speed-btn active" : "speed-btn"}
              onClick={() => onSetSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
        <SpeedControl value={speedMultiplier} onChange={onSetSpeed} />
        <p className="hint">Playback speed, up to 1000×{running ? " — adjusts the current drive live" : ""}.</p>
      </section>

      <section>
        <h2>Destinations</h2>
        <p className="hint">Select "Add destination", then click the map. Click a numbered pin, or its × here, to remove it.</p>
        {destinations.length === 0 && <p className="hint">No destinations yet.</p>}
        {destinations.length > 0 && (
          <ul className="dest-list">
            {destinations.map((d, i) => (
              <li key={d.id} className="dest-row">
                <span className="dest-num">{i + 1}</span>
                <span className="dest-coords">
                  {d.lat.toFixed(5)}, {d.lon.toFixed(5)}
                </span>
                <button className="dest-remove" onClick={() => onRemoveDestination(d.id)} title="Remove">
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Obstacles</h2>
        <p className="hint">Select "Add obstacle", then click a road (or right-click any road directly). The route reroutes automatically — even mid-drive.</p>
        {obstacles.length === 0 && <p className="hint">No obstacles placed.</p>}
        {obstacles.length > 0 && (
          <ul className="dest-list">
            {obstacles.map((o) => (
              <li key={o.id} className="dest-row">
                <span className="obstacle-icon">⚠</span>
                <span className="dest-coords">
                  {o.lat.toFixed(5)}, {o.lon.toFixed(5)}
                </span>
                <button className="dest-remove" onClick={() => onRemoveObstacle(o.id)} title="Remove">
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="secondary-btn" onClick={onClearBlocks} disabled={obstacles.length === 0}>
          Clear all obstacles
        </button>
      </section>

      <section>
        <h2>Route info</h2>
        {destinations.length === 0 && <p className="hint">Add a destination to compute a route.</p>}
        {routeLoading && <p className="hint">Calculating route…</p>}
        {routeError && <p className="error">{routeError}</p>}
        {routeData && !routeLoading && (
          <div className="stats">
            <div className="stat-row">
              <span>Distance</span>
              <span>{(routeData.distance_m / 1000).toFixed(2)} km</span>
            </div>
            <div className="stat-row">
              <span>Estimated time</span>
              <span>{formatEta(routeData.eta_s)}</span>
            </div>
            <div className="stat-row">
              <span>Traffic delay</span>
              <span>+{Math.round(routeData.traffic_delay_s)}s ({Math.round(routeData.congestion_factor * 100)}% congestion)</span>
            </div>
            <div className="stat-row">
              <span>Route computed in</span>
              <span>{routeData.compute_ms.toFixed(1)} ms</span>
            </div>
            <div className="stat-row">
              <span>Nodes expanded (A*)</span>
              <span>{routeData.nodes_expanded}</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function formatEta(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function formatDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}
