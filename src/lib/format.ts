export function formatTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

/** Returns a compact, human-friendly relative time string (e.g. "3 min ago"). */
export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Returns a compact, forward-looking time string (e.g. "in 23 min", "in 2h").
 * Non-positive deltas collapse to "soon" so a clock skew or a state that has
 * just transitioned past its deadline still renders something sensible
 * instead of a negative number.
 */
export function formatTimeUntil(timestamp: number): string {
  const seconds = Math.floor((timestamp - Date.now()) / 1000);
  if (seconds <= 0) return "soon";
  if (seconds < 60) return "in <1 min";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

/** Truncates a commit SHA to the conventional 7-char short form. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
