import { describe, expect, test } from "vitest";
import { SYSTEM_DESIGN_KINDS, SYSTEM_DESIGN_KIND_TITLES } from "../../convex/lib/systemDesign";
import { REPOSITORY_GUIDE_SECTIONS, REPOSITORY_GUIDE_SECTION_TITLES } from "./repository-guide-catalog";

describe("repository guide catalog", () => {
  test("matches backend System Design kind order and titles", () => {
    expect(REPOSITORY_GUIDE_SECTIONS.map((section) => section.kind)).toEqual(SYSTEM_DESIGN_KINDS);
    expect(REPOSITORY_GUIDE_SECTION_TITLES).toEqual(SYSTEM_DESIGN_KIND_TITLES);
  });

  test("keeps every rendered section complete", () => {
    const seen = new Set<string>();

    for (const section of REPOSITORY_GUIDE_SECTIONS) {
      expect(section.title.trim()).toBeTruthy();
      expect(section.description.trim()).toBeTruthy();
      expect(seen.has(section.kind)).toBe(false);
      seen.add(section.kind);
    }
  });
});
