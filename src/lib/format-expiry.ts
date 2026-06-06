export function formatExpiry(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) {
    return "Expired";
  }

  const secondMs = 1000;
  const minuteMs = 60 * secondMs;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (ms >= dayMs) {
    const days = Math.floor(ms / dayMs);
    return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (ms >= hourMs) {
    const hours = Math.floor(ms / hourMs);
    return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (ms >= minuteMs) {
    const minutes = Math.floor(ms / minuteMs);
    return `Expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const seconds = Math.max(1, Math.floor(ms / secondMs));
  return `Expires in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}
