import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Morph, morphName } from "./morph";

describe("morphName", () => {
  it("is the same for a list row and its detail page, and unique per entity and id", () => {
    expect(morphName("customer", "c1")).toBe(morphName("customer", "c1"));
    expect(morphName("customer", "c1")).not.toBe(morphName("customer", "c2"));
    expect(morphName("customer", "c1")).not.toBe(morphName("opportunity", "c1"));
  });
});

describe("Morph", () => {
  it("gives bare text an element to carry the name (React names elements, never text)", () => {
    const { container } = render(
      <Morph entity="opportunity" id="d1">
        Alpha retrofit
      </Morph>,
    );
    const span = container.querySelector("span");
    expect(span).not.toBeNull();
    expect(span).toHaveTextContent("Alpha retrofit");
  });

  it("renders its children untouched", () => {
    render(
      <Morph entity="customer" id="c1">
        <h1>Acme Plumbing</h1>
      </Morph>,
    );
    expect(screen.getByRole("heading", { name: "Acme Plumbing" })).toBeInTheDocument();
  });
});
