import { describe, expect, it } from "vitest";
import { announceBand, bandLabel, formatRemaining } from "./time-remaining";

describe("formatRemaining", () => {
  it("formats hours and minutes, minutes and seconds, and under a minute", () => {
    expect(formatRemaining(24 * 3600)).toBe("24h 00m");
    expect(formatRemaining(23 * 3600 + 59 * 60 + 59)).toBe("23h 59m");
    expect(formatRemaining(3600)).toBe("1h 00m");
    expect(formatRemaining(3599)).toBe("59m 59s");
    expect(formatRemaining(245)).toBe("4m 05s");
    expect(formatRemaining(60)).toBe("1m 00s");
    expect(formatRemaining(59)).toBe("less than a minute");
    expect(formatRemaining(1)).toBe("less than a minute");
  });
  it("never shows a negative or fractional time", () => {
    expect(formatRemaining(0)).toBe("less than a minute");
    expect(formatRemaining(-500)).toBe("less than a minute");
    expect(formatRemaining(61.9)).toBe("1m 01s");
  });
});

describe("announceBand", () => {
  it("is silent above an hour and speaks at the thresholds", () => {
    expect(announceBand(7200)).toBeNull();
    expect(announceBand(3601)).toBeNull();
    expect(announceBand(3600)).toBe(3600);
    expect(announceBand(601)).toBe(3600);
    expect(announceBand(600)).toBe(600);
    expect(announceBand(299)).toBe(300);
    expect(announceBand(59)).toBe(60);
    expect(announceBand(0)).toBe(0);
  });
});

describe("bandLabel", () => {
  it("says an accurate less-than statement for each band", () => {
    expect(bandLabel(3600)).toBe("Less than an hour left in this demo.");
    expect(bandLabel(600)).toBe("Less than 10 minutes left in this demo.");
    expect(bandLabel(300)).toBe("Less than 5 minutes left in this demo.");
    expect(bandLabel(60)).toBe("Less than a minute left in this demo.");
    expect(bandLabel(0)).toBe("This demo has ended.");
  });
});
