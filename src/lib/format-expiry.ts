export function formatExpiry(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) {
    return "Expired";
  }
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) {
    return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
  }
  const hours = Math.ceil(ms / (60 * 60 * 1000));
  return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
}
