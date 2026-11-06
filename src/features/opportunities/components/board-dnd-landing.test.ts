import { describe, expect, it } from "vitest";
import { landingPoint } from "./board-dnd";

const rect = (left: number, top: number, w: number, h: number) =>
  ({
    left,
    top,
    right: left + w,
    bottom: top + h,
    width: w,
    height: h,
    x: left,
    y: top,
  }) as DOMRect;

describe("landingPoint", () => {
  it("is just under the header of the column the card was dropped on", () => {
    const column = document.createElement("section");
    const header = document.createElement("header");
    column.append(header);
    column.getBoundingClientRect = () => rect(400, 100, 200, 600);
    header.getBoundingClientRect = () => rect(408, 108, 184, 40);
    expect(landingPoint(column)).toEqual({ x: 408, y: 156 });
  });

  it("falls back to the column's top, and to null when the column is not on the page", () => {
    const column = document.createElement("section");
    column.getBoundingClientRect = () => rect(10, 20, 100, 100);
    expect(landingPoint(column)).toEqual({ x: 18, y: 28 });
    expect(landingPoint(null)).toBeNull();
  });
});
