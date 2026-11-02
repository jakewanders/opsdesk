/** "23h 59m", "4m 05s", "less than a minute": the time left on a demo, from whole seconds supplied by the server. */
export function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return "less than a minute";
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Moments the countdown announces to a screen reader (seconds left). The visible text updates silently. */
export const ANNOUNCE_AT = [3600, 600, 300, 60, 0] as const;

/** The first announce threshold at or below `seconds`, or null above the highest. */
export function announceBand(seconds: number): number | null {
  for (const t of [...ANNOUNCE_AT].sort((a, b) => a - b)) if (seconds <= t) return t;
  return null;
}

/** What the live region says when the countdown enters a band: an accurate "less than" statement. */
export function bandLabel(band: number): string {
  switch (band) {
    case 0:
      return "This demo has ended.";
    case 60:
      return "Less than a minute left in this demo.";
    case 300:
      return "Less than 5 minutes left in this demo.";
    case 600:
      return "Less than 10 minutes left in this demo.";
    default:
      return "Less than an hour left in this demo.";
  }
}
