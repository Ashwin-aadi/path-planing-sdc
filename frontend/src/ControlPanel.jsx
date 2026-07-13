import { SPEED_OPTIONS } from "./constants";

const EMERGENCY_PRESET = { speed: 0, time: 60, safety: 40 };

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
}) {
  const shown = emergency ? EMERGENCY_PRESET : weights;
  const pct = (v) => Math.round(v);
  const handleWeightChange = (key, v) => setWeights((w) => rebalanceWeights(w, key, v));

  const canRun = !running && destinations.length > 0 && !!routeData;

  return (
    <div className="panel">
      <h1>Route Planner</h1>
      <p className="subtitle">Phase 1 — A* over live OpenStreetMap data</p>

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
            className="toggle-btn disabled"
            title="Live GPS arrives in a later phase"
            onClick={() =>
              alert("Real GPS location is a later phase. Using mock location for now.")
            }
          >
            Real location (Phase 2)
          </button>
        </div>
      </section>

      <section>
        <h2>Map tool</h2>
        <div className="toolbar">
          <button
            className={mode === "setLocation" ? "tool-btn active" : "tool-btn"}
            disabled={running}
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
        {!canRun && !running && (
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
        <p className="hint">Playback speed{running ? " — adjusts the current drive live" : ""}.</p>
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
