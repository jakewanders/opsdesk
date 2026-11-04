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
  it("renders its children untouched", () => {
    render(
      <Morph entity="customer" id="c1">
        <h1>Acme Plumbing</h1>
      </Morph>,
    );
    expect(screen.getByRole("heading", { name: "Acme Plumbing" })).toBeInTheDocument();
  });
});
