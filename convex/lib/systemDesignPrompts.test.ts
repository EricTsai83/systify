import { describe, expect, it } from "vitest";
import {
  EXPECTED_SECTIONS,
  LLM_PROMPTS,
  STEP_BUDGET_BY_KIND,
  SYSTEM_DESIGN_PROMPT_VERSIONS,
  budgetSuffix,
  getKindRunConfig,
  validateMermaidBlock,
  validateRequiredSections,
} from "./systemDesignPrompts";
import { SYSTEM_DESIGN_KINDS } from "./systemDesign";

describe("systemDesignPrompts maps", () => {
  it("covers every SystemDesignKind", () => {
    for (const kind of SYSTEM_DESIGN_KINDS) {
      expect(LLM_PROMPTS[kind]).toBeTruthy();
      expect(SYSTEM_DESIGN_PROMPT_VERSIONS[kind]).toBeGreaterThanOrEqual(1);
      expect(EXPECTED_SECTIONS[kind].length).toBeGreaterThan(0);
      expect(STEP_BUDGET_BY_KIND[kind]).toBeGreaterThan(0);
    }
  });

  it("ships uniform step budget at the documented initial seed", () => {
    for (const kind of SYSTEM_DESIGN_KINDS) {
      // PR-A2 ships uniform 20; eval-driven differentiation lands later.
      expect(STEP_BUDGET_BY_KIND[kind]).toBe(20);
    }
  });

  it("getKindRunConfig bundles the four pieces of state", () => {
    const config = getKindRunConfig("readme_summary");
    expect(config.prompt).toBe(LLM_PROMPTS.readme_summary);
    expect(config.promptVersion).toBe(SYSTEM_DESIGN_PROMPT_VERSIONS.readme_summary);
    expect(config.expectedSections).toBe(EXPECTED_SECTIONS.readme_summary);
    expect(config.stepBudget).toBe(STEP_BUDGET_BY_KIND.readme_summary);
  });

  it("budgetSuffix includes the budget number", () => {
    expect(budgetSuffix(17)).toContain("17 sandbox tool calls");
  });
});

describe("validateRequiredSections", () => {
  it("accepts a document with every section as ## heading", () => {
    const markdown = [
      "# README Summary",
      "",
      "## Purpose",
      "Body.",
      "## Services & Capabilities",
      "Body.",
      "## Audience",
      "## Key Operations",
      "## Notable Constraints",
      "## Source",
    ].join("\n");
    const result = validateRequiredSections(markdown, EXPECTED_SECTIONS.readme_summary);
    expect(result.ok).toBe(true);
    expect(result.missingSections).toEqual([]);
  });

  it("lists missing sections in the order they were declared", () => {
    const markdown = ["# Architecture Overview", "## System Shape", "## Data & Control Flow"].join("\n");
    const result = validateRequiredSections(markdown, EXPECTED_SECTIONS.architecture_overview);
    expect(result.ok).toBe(false);
    expect(result.missingSections).toEqual([
      "Components & Responsibilities",
      "Boundaries & Integrations",
      "Where to Look First",
    ]);
  });

  it("tolerates trailing punctuation and casing variations", () => {
    const markdown = [
      "## purpose:",
      "## SERVICES & CAPABILITIES",
      "## audience.",
      "## key operations",
      "## notable constraints",
      "## source",
    ].join("\n");
    const result = validateRequiredSections(markdown, EXPECTED_SECTIONS.readme_summary);
    expect(result.ok).toBe(true);
  });

  it("accepts ### in addition to ## as heading levels", () => {
    const markdown = [
      "### Purpose",
      "### Services & Capabilities",
      "### Audience",
      "### Key Operations",
      "### Notable Constraints",
      "### Source",
    ].join("\n");
    const result = validateRequiredSections(markdown, EXPECTED_SECTIONS.readme_summary);
    expect(result.ok).toBe(true);
  });

  it("rejects sections present only as bullets / body text", () => {
    const markdown = ["# Doc", "Purpose: something.", "- Services & Capabilities here"].join("\n");
    const result = validateRequiredSections(markdown, ["Purpose", "Services & Capabilities"]);
    expect(result.ok).toBe(false);
    expect(result.missingSections).toEqual(["Purpose", "Services & Capabilities"]);
  });
});

describe("validateMermaidBlock", () => {
  it("accepts a fenced ```mermaid block", () => {
    const markdown = ["# Architecture Diagram", "", "```mermaid", "graph TD", "  a --> b", "```"].join("\n");
    expect(validateMermaidBlock(markdown)).toBe(true);
  });

  it("accepts ```mermaid with leading whitespace", () => {
    const markdown = "```  mermaid\ngraph LR\n```";
    expect(validateMermaidBlock(markdown)).toBe(true);
  });

  it("rejects a document with no mermaid block", () => {
    const markdown = "## Legend\nSome text.";
    expect(validateMermaidBlock(markdown)).toBe(false);
  });

  it("rejects a document that only mentions mermaid without a fence", () => {
    const markdown = "We could render this in mermaid later.";
    expect(validateMermaidBlock(markdown)).toBe(false);
  });

  it("rejects an unterminated mermaid fence", () => {
    const markdown = ["# Architecture Diagram", "", "```mermaid", "graph TD", "  a --> b"].join("\n");
    expect(validateMermaidBlock(markdown)).toBe(false);
  });

  it("accepts tilde mermaid fences", () => {
    const markdown = ["~~~mermaid", "graph TD", "  a --> b", "~~~"].join("\n");
    expect(validateMermaidBlock(markdown)).toBe(true);
  });
});
