import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time";

describe("relativeTime [SIT-257]", () => {
  const now = new Date("2026-11-10T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [60_000, "1 minute ago"],
    [5 * 60_000, "5 minutes ago"],
    [59 * 60_000, "59 minutes ago"],
    [60 * 60_000, "1 hour ago"],
    [23 * 3_600_000, "23 hours ago"],
    [24 * 3_600_000, "Yesterday"],
    [47 * 3_600_000, "Yesterday"],
    [2 * 86_400_000, "2 days ago"],
    [30 * 86_400_000, "30 days ago"],
  ])("%d ms ago reads %s", (ms, words) => expect(relativeTime(ago(ms), now)).toBe(words));
  it("beyond 30 days there are no words (the caller shows the date)", () => {
    expect(relativeTime(ago(31 * 86_400_000), now)).toBeNull();
  });
  it("a time slightly in the future (clock skew) is just now", () => {
    expect(relativeTime(new Date(now.getTime() + 5000).toISOString(), now)).toBe("just now");
  });
});
