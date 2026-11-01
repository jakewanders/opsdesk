import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "@/test/axe";
import { LandingPage } from "./landing-page";

const REPO = "https://github.com/example/opsdesk";

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

describe("LandingPage", () => {
  it("has the headline, subhead, and landmarks", () => {
    render(<LandingPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "A simpler way to run your business" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Customers, pipeline, quotes, tasks, and insights in one place/),
    ).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("reaches /demo in one click from the primary call to action", () => {
    render(<LandingPage />);
    const demoLinks = screen.getAllByRole("link", { name: "Try Live Demo" });
    expect(demoLinks.length).toBeGreaterThanOrEqual(2); // header and hero
    for (const link of demoLinks) expect(link).toHaveAttribute("href", "/demo");
  });

  it("hides View Source Code when no repository URL is set", () => {
    render(<LandingPage />);
    expect(screen.queryByRole("link", { name: /View Source Code/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Source code" })).not.toBeInTheDocument();
  });

  it("shows View Source Code, opening safely, when a repository URL is set", () => {
    render(<LandingPage repoUrl={REPO} />);
    const link = screen.getByRole("link", { name: "View Source Code" });
    expect(link).toHaveAttribute("href", REPO);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByRole("link", { name: "Source code" })).toHaveAttribute("href", REPO);
  });

  it("links Technical Overview to an on-page section that exists", () => {
    const { container } = render(<LandingPage />);
    const link = screen.getByRole("link", { name: "Technical Overview" });
    expect(link).toHaveAttribute("href", "#technical-overview");
    expect(container.querySelector("#technical-overview")).not.toBeNull();
  });

  it("has three feature sections and an architecture section", () => {
    render(<LandingPage />);
    const features = screen.getByRole("region", { name: "What it covers" });
    expect(within(features).getAllByRole("article")).toHaveLength(3);
    expect(screen.getByRole("region", { name: "How it is designed" })).toBeInTheDocument();
  });

  it("discloses that it is an engineering demonstration with no certifications", () => {
    render(<LandingPage />);
    const disclosure = screen.getByRole("region", { name: "An engineering demonstration" });
    expect(disclosure).toHaveTextContent(/portfolio project, not an operating business/);
    expect(disclosure).toHaveTextContent(/not certified for HIPAA, SOC 2, or PCI DSS/);
    expect(disclosure).toHaveTextContent(/fictional/);
  });

  it("links the footer to /privacy and /terms", () => {
    render(<LandingPage />);
    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(footer.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  });

  it("contains no placeholder text, fake logos, testimonials, or invented numbers", () => {
    const { container } = render(<LandingPage repoUrl={REPO} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/lorem|ipsum|placeholder|trusted by|testimonial|customers worldwide/i);
    expect(text).not.toMatch(/[$%€£]/);
    // digits only appear inside the named standards (SOC 2); nothing like "10,000 users"
    const withoutStandards = text.replace(/SOC 2/g, "");
    expect(withoutStandards).not.toMatch(/\d/);
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("labels every illustration as an illustration, not real data", () => {
    render(<LandingPage />);
    const captions = screen.getAllByText(/Illustration of/);
    expect(captions).toHaveLength(4);
    for (const caption of captions) expect(caption).toHaveTextContent(/Not real data/);
  });

  it("makes the skip link the first focusable element", () => {
    render(<LandingPage />);
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveAttribute("href", "#main-content");
    expect(document.querySelector("a, button")).toBe(skip);
  });

  it.each(["light", "dark"] as const)("has no axe violations in the %s theme", async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const { container } = render(<LandingPage repoUrl={REPO} />);
    await expectNoA11yViolations(container);
  });
});
