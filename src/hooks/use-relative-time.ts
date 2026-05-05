import { useEffect, useState } from "react";
import { formatRelativeTime, formatTimeUntil } from "@/lib/format";

/**
 * Schedules a tick whose cadence adapts to how far the timestamp is from now,
 * regardless of direction. Same heuristic for "X ago" and "in X" labels — the
 * closer to `now`, the more often we re-render so transitions land promptly.
 *
 *  - within 1 minute    → every 10 s
 *  - within 1 hour      → every 30 s
 *  - otherwise          → every 60 s
 *
 * Returns a cleanup that stops both the active tick and the recalibration
 * timer.
 */
function scheduleAdaptiveTicks(timestamp: number, onTick: () => void): () => void {
  function scheduleInterval(): ReturnType<typeof setInterval> {
    const distanceSeconds = Math.floor(Math.abs(Date.now() - timestamp) / 1000);
    const ms =
      distanceSeconds < 60
        ? 10_000
        : distanceSeconds < 3600
          ? 30_000
          : 60_000;
    return setInterval(onTick, ms);
  }

  let id = scheduleInterval();
  // Re-calibrate cadence every 60 s so the bucket follows the timestamp as it
  // ages or approaches.
  const recalibrate = setInterval(() => {
    clearInterval(id);
    id = scheduleInterval();
  }, 60_000);

  return () => {
    clearInterval(id);
    clearInterval(recalibrate);
  };
}

/**
 * Returns a live-updating relative time string for a *past* timestamp
 * (e.g. "3 min ago"). The cadence adapts to the age of the timestamp via
 * `scheduleAdaptiveTicks`.
 */
export function useRelativeTime(timestamp: number | undefined): string | null {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (timestamp == null) {
      return;
    }
    return scheduleAdaptiveTicks(timestamp, () => setTick((value) => value + 1));
  }, [timestamp]);

  return timestamp != null ? formatRelativeTime(timestamp) : null;
}

/**
 * Returns a live-updating forward-looking time string for a *future*
 * timestamp (e.g. "in 23 min"). Mirrors `useRelativeTime`'s cadence so a
 * 30-minute deadline updates every 30 s near the boundary and every minute
 * earlier on. Non-positive deltas collapse to "soon" via `formatTimeUntil`.
 */
export function useTimeUntil(timestamp: number | undefined): string | null {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (timestamp == null) {
      return;
    }
    return scheduleAdaptiveTicks(timestamp, () => setTick((value) => value + 1));
  }, [timestamp]);

  return timestamp != null ? formatTimeUntil(timestamp) : null;
}
