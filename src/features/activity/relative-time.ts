const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * An instant in words, relative to `now`: "just now", "5 minutes ago", "3 hours ago", "Yesterday", "12 days ago". Beyond 30
 * days the caller shows the date instead (returns null). Always shown next to the full timestamp, never alone. A time in
 * the future (clock skew) reads "just now".
 */
export function relativeTime(iso: string, now: Date): string | null {
  const diff = now.getTime() - new Date(iso).getTime();
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) {
    const n = Math.floor(diff / MINUTE);
    return `${n} ${n === 1 ? "minute" : "minutes"} ago`;
  }
  if (diff < DAY) {
    const n = Math.floor(diff / HOUR);
    return `${n} ${n === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(diff / DAY);
  if (days === 1) return "Yesterday";
  if (days <= 30) return `${days} days ago`;
  return null;
}
