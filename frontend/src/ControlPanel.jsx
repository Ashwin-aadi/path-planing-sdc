const EMERGENCY_PRESET = { speed: 60, time: 40, safety: 0 };

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
  locationMode,
  setLocationMode,
  routeData,
  routeError,
  routeLoading,
  blockedCount,
  onClearBlocks,
  hasDestination,
}) {
  const shown = emergency ? EMERGENCY_PRESET : weights;
  const sum = shown.speed + shown.time + shown.safety || 1;
  const pct = (v) => Math.round((v / sum) * 100);

  return (
    <div className="panel">
      <h1>Route Planner</h1>
      <p className="subtitle">Phase 1 — A* over live OpenStreetMap data</p>

      <section>
        <h2>Location</h2>
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
        <p className="hint">
          Drag the blue marker to set your start point. Click anywhere on the map to set the destination.
        </p>
      </section>

      <section>
        <h2>Route mode</h2>
        <Slider
          label="Speed (favor high speed-limit roads)"
          value={weights.speed}
          pct={pct(shown.speed)}
          disabled={emergency}
          onChange={(v) => setWeights((w) => ({ ...w, speed: v }))}
        />
        <Slider
          label="Time (minimize ETA)"
          value={weights.time}
          pct={pct(shown.time)}
          disabled={emergency}
          onChange={(v) => setWeights((w) => ({ ...w, time: v }))}
        />
        <Slider
          label="Safety (broad roads, avoid highways)"
          value={weights.safety}
          pct={pct(shown.safety)}
          disabled={emergency}
          onChange={(v) => setWeights((w) => ({ ...w, safety: v }))}
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
          <p className="hint">Overrides sliders: max speed + time priority, safety ignored.</p>
        )}
      </section>

      <section>
        <h2>Road closures</h2>
        <p className="hint">Click any road on the map to block or unblock it — the route recalculates automatically.</p>
        <div className="stat-row">
          <span>Blocked roads</span>
          <span>{blockedCount}</span>
        </div>
        <button className="secondary-btn" onClick={onClearBlocks} disabled={blockedCount === 0}>
          Clear all blocks
        </button>
      </section>

      <section>
        <h2>Route info</h2>
        {!hasDestination && <p className="hint">Click the map to set a destination.</p>}
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
