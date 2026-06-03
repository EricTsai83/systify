/**
 * Prompt hash snapshot test.
 *
 * Each `SystemDesignKind`'s prompt has a stored FNV-1a 32-bit hash
 * and a stored expected `SYSTEM_DESIGN_PROMPT_VERSIONS` value. The
 * test fails when either drifts:
 *
 *   1. Hash mismatch — someone edited `LLM_PROMPTS[kind]` without
 *      updating this file. They must bump the version in
 *      `convex/lib/systemDesignPrompts.ts` AND paste the new hash
 *      into the snapshot below. The artifact cache keys on
 *      `promptVersion`, so a silent prompt edit would leave
 *      production serving stale cached artifacts.
 *
 *   2. Version mismatch — someone updated the snapshot hash but
 *      forgot to bump the version (or vice versa).
 *
 * The hash function is FNV-1a 32-bit — deterministic, no deps,
 * works in every JS runtime including vitest's `edge-runtime`.
 * Hash values are inline so the snapshot lives with its assertions;
 * no separate `.snap` file to keep in sync.
 *
 * To regenerate snapshots after an intentional edit:
 *   1. Read the failure message — it prints the new hash for the
 *      changed kind.
 *   2. Bump `SYSTEM_DESIGN_PROMPT_VERSIONS[kind]` in
 *      `convex/lib/systemDesignPrompts.ts`.
 *   3. Update both `hash` and `version` for that kind in
 *      `PROMPT_SNAPSHOTS` below.
 *   4. Re-run the test.
 */

import { describe, expect, it } from "vitest";
import { LLM_PROMPTS, SYSTEM_DESIGN_PROMPT_VERSIONS } from "./lib/systemDesignPrompts";
import { SYSTEM_DESIGN_KINDS, type SystemDesignKind } from "./lib/systemDesign";

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const PROMPT_SNAPSHOTS: Record<SystemDesignKind, { hash: string; version: number }> = {
  readme_summary: { hash: "56be4fcd", version: 1 },
  architecture_overview: { hash: "8db19e7c", version: 1 },
  architecture_diagram: { hash: "d67eada1", version: 1 },
  data_model_overview: { hash: "5a940a04", version: 1 },
  api_surface_overview: { hash: "f14deb4c", version: 1 },
  deployment_overview: { hash: "1ada6806", version: 1 },
  security_overview: { hash: "a47572e1", version: 2 },
  operations_overview: { hash: "de4dd1b4", version: 1 },
};

describe("System Design prompt snapshot", () => {
  for (const kind of SYSTEM_DESIGN_KINDS) {
    it(`${kind} — prompt hash matches snapshot`, () => {
      const actualHash = fnv1a32(LLM_PROMPTS[kind]);
      const expected = PROMPT_SNAPSHOTS[kind];
      expect(
        actualHash,
        `Prompt for "${kind}" changed without an updated snapshot.\n` +
          `  Stored hash: ${expected.hash}\n` +
          `  Actual hash: ${actualHash}\n\n` +
          `If this edit is intentional:\n` +
          `  1. Bump SYSTEM_DESIGN_PROMPT_VERSIONS["${kind}"] in convex/lib/systemDesignPrompts.ts\n` +
          `  2. Update PROMPT_SNAPSHOTS["${kind}"] in this file to { hash: "${actualHash}", version: <new-version> }\n` +
          `Skipping the version bump would leave production cached artifacts stale.`,
      ).toBe(expected.hash);
    });

    it(`${kind} — stored version matches current SYSTEM_DESIGN_PROMPT_VERSIONS`, () => {
      const stored = PROMPT_SNAPSHOTS[kind].version;
      const actual = SYSTEM_DESIGN_PROMPT_VERSIONS[kind];
      expect(
        stored,
        `Version drift for "${kind}":\n` +
          `  PROMPT_SNAPSHOTS["${kind}"].version = ${stored}\n` +
          `  SYSTEM_DESIGN_PROMPT_VERSIONS["${kind}"] = ${actual}\n\n` +
          `Update both in the same commit. Snapshot hash and version always bump together.`,
      ).toBe(actual);
    });
  }
});
