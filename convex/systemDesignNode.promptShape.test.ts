// @vitest-environment node
/**
 * Prompt validator ↔ fixture contract test.
 *
 * For each `SystemDesignKind`, the matching fixture markdown under
 * `convex/eval/systemDesign/fixtures/<kind>.md` must satisfy the
 * structural validators that the production generator applies to
 * LLM output. The validators come from
 * `convex/lib/systemDesignPrompts.ts`:
 *
 *   - `validateRequiredSections(text, EXPECTED_SECTIONS[kind]).ok === true`
 *   - For `architecture_diagram`: `validateMermaidBlock(text) === true`
 *
 * The fixtures double as "known-good" examples that:
 *
 *   1. Pin the section vocabulary the prompts ask for. If the prompt
 *      edit changes a section name, the fixture must update too.
 *   2. Guard the validator from drift. A regex tweak that
 *      accidentally rejects valid output fails this test before
 *      shipping.
 *
 * `// @vitest-environment node` overrides the project-wide
 * `edge-runtime` so `node:fs/promises` is available — the fixtures
 * are real files on disk, not bundled string constants.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYSTEM_DESIGN_KINDS } from "./lib/systemDesign";
import { EXPECTED_SECTIONS, validateMermaidBlock, validateRequiredSections } from "./lib/systemDesignPrompts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "eval", "systemDesign", "fixtures");

describe("System Design prompt-shape ↔ fixture contract", () => {
  for (const kind of SYSTEM_DESIGN_KINDS) {
    it(`${kind} — fixture passes validateRequiredSections`, async () => {
      const fixture = await readFile(path.join(FIXTURE_DIR, `${kind}.md`), "utf8");
      const result = validateRequiredSections(fixture, EXPECTED_SECTIONS[kind]);
      expect(
        result.ok,
        `Fixture for "${kind}" is missing required sections: ${result.missingSections.join(", ")}.\n` +
          `If the prompt changed which sections are required:\n` +
          `  1. Update EXPECTED_SECTIONS["${kind}"] in convex/lib/systemDesignPrompts.ts\n` +
          `  2. Update convex/eval/systemDesign/fixtures/${kind}.md so the headings match.\n` +
          `If the validator changed:\n` +
          `  1. Decide whether the new behaviour is intended.\n` +
          `  2. Update the fixture OR revert the validator.`,
      ).toBe(true);
    });

    if (kind === "architecture_diagram") {
      it(`${kind} — fixture contains a Mermaid block`, async () => {
        const fixture = await readFile(path.join(FIXTURE_DIR, `${kind}.md`), "utf8");
        expect(
          validateMermaidBlock(fixture),
          `Fixture for "${kind}" is missing a fenced \`\`\`mermaid block.\n` +
            `The architecture_diagram prompt requires one; update the fixture if the prompt changed.`,
        ).toBe(true);
      });
    }
  }
});
