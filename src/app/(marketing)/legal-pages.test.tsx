import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "@/test/axe";
import { LEGAL_LAST_UPDATED } from "./_components/legal-page";
import PrivacyPage, { metadata as privacyMetadata } from "./privacy/page";
import TermsPage, { metadata as termsMetadata } from "./terms/page";

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

const PAGES = [
  ["Privacy", PrivacyPage, privacyMetadata],
  ["Terms", TermsPage, termsMetadata],
] as const;

describe.each(PAGES)("%s page", (title, Page, metadata) => {
  it("has one h1, a last-updated date, and h2 sections", () => {
    render(<Page />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByText(`Last updated ${LEGAL_LAST_UPDATED}`)).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThanOrEqual(5);
  });

  it("has landmarks, a skip link, and links home and to the other legal page", () => {
    render(<Page />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute(
      "href",
      "#main-content",
    );
    const legalNav = within(screen.getByRole("navigation", { name: "Legal" }));
    expect(legalNav.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(legalNav.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
  });

  it("says the product is still being built and the copy will be re-checked", () => {
    render(<Page />);
    expect(screen.getByRole("note")).toHaveTextContent(/still being built/);
    expect(screen.getByRole("note")).toHaveTextContent(/checked against what/);
  });

  it("has a title and description in its metadata", () => {
    expect(String(metadata.title)).toContain(title);
    expect(String(metadata.description).length).toBeGreaterThan(40);
  });

  it("makes no certification, compliance, or legal-advice claims", () => {
    const { container } = render(<Page />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\b(HIPAA|SOC 2|PCI DSS)[- ](compliant|certified|ready)\b/i);
    expect(text).not.toMatch(/\bGDPR[- ]compliant\b/i);
    expect(text).not.toMatch(/we (do not|don't|never) (collect|store|track)/i);
    // "does not claim that no data is collected" is the honest statement, not the forbidden claim.
    expect(text).not.toMatch(/(?<!claim that\s)no data (is|are|was) (collected|stored)/i);
    expect(text).toMatch(/not legal advice/i);
  });

  it("has no placeholder text and no invented contact details", () => {
    const { container } = render(<Page />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/lorem|ipsum|TODO|TBD|\[.*\]/i);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // no email addresses
    expect(text).not.toMatch(/\+?\d[\d\s().-]{8,}\d/); // no phone numbers
  });

  it.each(["light", "dark"] as const)("has no axe violations in the %s theme", async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const { container } = render(<Page />);
    await expectNoA11yViolations(container);
  });
});

describe("Privacy page content", () => {
  it("covers the topics the issue requires, honestly", () => {
    const { container } = render(<PrivacyPage />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/anonymous identity/);
    expect(text).toMatch(/cookie/i);
    expect(text).toMatch(/24 hours/);
    expect(text).toMatch(/fictional/);
    expect(text).toMatch(/technical identifiers/);
    expect(text).toMatch(/does\s+not\s+claim that no data is collected/);
    expect(text).toMatch(/optional/i);
    expect(text).toMatch(/until you archive or delete it/);
    expect(text).toMatch(/Nothing deletes real workspaces\s+automatically/);
  });

  it("states what is true today about analytics and local storage", () => {
    const { container } = render(<PrivacyPage />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/No analytics are collected today/);
    expect(text).toMatch(/local\s+storage/);
  });
});

describe("Terms page content", () => {
  it("states the demonstration, fictional-data, uptime, and certification terms", () => {
    const { container } = render(<TermsPage />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/portfolio demonstration/);
    expect(text).toMatch(/fictional/i);
    expect(text).toMatch(/Do not enter real customer records/);
    expect(text).toMatch(/No uptime guarantee/);
    expect(text).toMatch(/not certified or audited for HIPAA, SOC 2, PCI DSS/);
    expect(text).toMatch(/not an operating\s+business/);
  });

  it("links to the privacy page for data handling", () => {
    render(<TermsPage />);
    const inBody = within(screen.getByRole("main"));
    expect(inBody.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  });
});
