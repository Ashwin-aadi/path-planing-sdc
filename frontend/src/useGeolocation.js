import { useEffect, useRef, useState } from "react";

function extractHeading(event) {
  // iOS Safari exposes a ready-to-use compass bearing directly.
  if (typeof event.webkitCompassHeading === "number") return event.webkitCompassHeading;
  // Standard DeviceOrientationEvent: alpha=0 means the device top points at
  // north, increasing counter-clockwise — the widely-used web-compass
  // conversion (360 - alpha) turns that into a clockwise-from-north bearing.
  // Consumer magnetometers drift and need per-device calibration, so this
  // stays a rough "which way am I facing" cue, not survey-grade orientation.
  if (event.absolute && event.alpha != null) return (360 - event.alpha) % 360;
  return null;
}

const ORIENTATION_EVENT =
  typeof window !== "undefined" && "ondeviceorientationabsolute" in window
    ? "deviceorientationabsolute"
    : "deviceorientation";

/** Live GPS position + best-effort compass heading. Heading prefers the
 * device orientation sensor (works while stationary); falls back to GPS
 * course-over-ground (coords.heading), which the spec only populates while
 * actually moving. `active` gates both watches so nothing runs in mock mode. */
export function useGeolocation(active) {
  const [position, setPosition] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [gpsHeading, setGpsHeading] = useState(null);
  const [compassHeading, setCompassHeading] = useState(null);
  const [error, setError] = useState(null);
  const [compassPermission, setCompassPermission] = useState("unknown");
  const watchIdRef = useRef(null);
  const orientationAttachedRef = useRef(false);

  useEffect(() => {
    if (!active) {
      setPosition(null);
      setError(null);
      return;
    }
    if (!("geolocation" in navigator)) {
      setError("Geolocation not supported by this browser");
      return;
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setAccuracy(pos.coords.accuracy);
        setGpsHeading(Number.isFinite(pos.coords.heading) ? pos.coords.heading : null);
        setError(null);
      },
      (err) => setError(err.message),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
    return () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    };
  }, [active]);

  const handleOrientation = (event) => {
    const heading = extractHeading(event);
    if (heading != null) setCompassHeading(heading);
  };

  useEffect(() => {
    if (!active) return;
    if (typeof DeviceOrientationEvent === "undefined") {
      setCompassPermission("unavailable");
      return;
    }
    // iOS 13+ gates orientation events behind an explicit user-gesture
    // permission prompt; every other browser exposes them directly.
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      setCompassPermission((p) => (p === "granted" ? p : "needs-request"));
      return;
    }
    window.addEventListener(ORIENTATION_EVENT, handleOrientation);
    orientationAttachedRef.current = true;
    setCompassPermission("granted");
    return () => {
      window.removeEventListener(ORIENTATION_EVENT, handleOrientation);
      orientationAttachedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const requestCompassPermission = async () => {
    if (typeof DeviceOrientationEvent === "undefined" || typeof DeviceOrientationEvent.requestPermission !== "function") {
      return;
    }
    try {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result === "granted") {
        if (!orientationAttachedRef.current) {
          window.addEventListener(ORIENTATION_EVENT, handleOrientation);
          orientationAttachedRef.current = true;
        }
        setCompassPermission("granted");
      } else {
        setCompassPermission("denied");
      }
    } catch {
      setCompassPermission("denied");
    }
  };

  const heading = compassHeading != null ? compassHeading : gpsHeading;

  return {
    position, accuracy, heading, compassHeading, gpsHeading, error,
    compassPermission, requestCompassPermission,
  };
}
