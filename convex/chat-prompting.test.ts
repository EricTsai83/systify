import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "./chat/prompting";
import type { ChatMode } from "./chatModeResolver";

/**
 * Per-mode system-prompt invariants.
 *
 * The point of these tests is *not* to pin down the exact wording — future
 * iterations of these prompts will keep adding sections (a citation contract,
 * a step budget, a tool-usage section once tools are wired). The wording
 * will drift; what must not drift are the mode-distinguishing properties
 * that make the three prompts a useful design contract:
 *
 *   - `discuss` is training-only — it should not present itself as an
 *     analyst that has access to "the repository", and it should bounce
 *     code-specific questions to the other two modes.
 *   - `docs` is artifact-grounded — it must tell the model that artifacts
 *     are the single source of truth.
 *   - `sandbox` is "no tools in this version" — it must tell the model it
 *     cannot literally inspect the source tree, without promising specific
 *     future capability.
 *
 * Two cross-cutting style invariants are also enforced:
 *
 *   - Prompts must not embed UI display labels (drift safety).
 *   - The sandbox prompt must not promise future product capability (no
 *     roadmap leak via the model).
 *
 * Each prompt must also be a non-empty string and the three must be
 * distinct, otherwise `buildSystemPrompt` is effectively a no-op.
 */
describe("buildSystemPrompt", () => {
  test("discuss prompt does not pretend to have access to a repository", () => {
    const prompt = buildSystemPrompt("discuss");

    // Done criterion: the discuss prompt must not assume a repository
    // exists. Searching for the literal "repository" is the simplest
    // tripwire — any future edit that re-introduces the word (even via a
    // paraphrase like "imported repository") will fail this and force a
    // re-review.
    expect(prompt).not.toMatch(/repository/i);

    // The prompt should still concretely tell the model not to invent
    // "your codebase" / "your repo" references — otherwise the model can
    // simply use those phrases without ever saying the word "repository".
    expect(prompt.toLowerCase()).toContain("your codebase");
  });

  test("docs prompt makes design artifacts the sole source of truth", () => {
    const prompt = buildSystemPrompt("docs");

    expect(prompt.toLowerCase()).toContain("artifact");
    // "Sole source of truth" framing is what stops the model from mixing
    // in training-data guesses; this is the contract docs mode promises
    // the user.
    expect(prompt.toLowerCase()).toMatch(/sole source of truth|only source/);
  });

  test("sandbox prompt acknowledges the absence of file/exec tools in this version", () => {
    const prompt = buildSystemPrompt("sandbox");

    // The model must know it cannot literally read files or run commands
    // in this version, otherwise it will fabricate "I checked X and saw
    // Y" output. We assert a negation near "tool" rather than pinning a
    // specific phrasing so future polish doesn't break the invariant.
    expect(prompt.toLowerCase()).toContain("tool");
    expect(prompt).toMatch(/(?:no|not|don't|do not|without)[^.]*tool/i);
  });

  test("sandbox prompt does not promise future product capability (no roadmap leak)", () => {
    const prompt = buildSystemPrompt("sandbox");

    // System prompts ship to users today via the model's responses; they
    // are not the place to promise future product capability. Names and
    // timelines for upcoming tools belong in the plan that wires them,
    // not in a v1 prompt — promised tools that get renamed or delayed
    // would silently mislead the user via the model.
    expect(prompt).not.toMatch(/upcoming|future|will be given|will have|next version|coming soon/i);
  });

  test("prompts do not embed UI display labels (drift safety)", () => {
    // The chat-panel `MODE_CATALOG` is the single source of truth for the
    // mode display labels users see. Embedding those labels in system
    // prompts would couple LLM behavior to UI copy: renaming "Design
    // Docs" → e.g. "Source Docs" in `MODE_CATALOG` would silently change
    // what the model recommends without a code review on this file.
    // Prompts must refer to other modes by their *capability* (e.g. "an
    // artifact-grounded mode") rather than by UI label.
    //
    // We exclude "Sandbox" because it is both a UI label and standard
    // engineering vocabulary; banning the substring would forbid
    // legitimate descriptive uses ("a live-sandbox mode") that are not
    // UI-coupled.
    const uiOnlyLabels = ["General Chat", "Design Docs"];
    const modes: ChatMode[] = ["discuss", "docs", "sandbox"];
    for (const mode of modes) {
      const prompt = buildSystemPrompt(mode);
      for (const label of uiOnlyLabels) {
        expect(prompt).not.toContain(label);
      }
    }
  });

  test("each mode receives a distinct, non-empty prompt", () => {
    const modes: ChatMode[] = ["discuss", "docs", "sandbox"];
    const prompts = modes.map((mode) => buildSystemPrompt(mode));

    for (const prompt of prompts) {
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
    }

    // If two modes ever return the same prompt the entire mode-aware
    // refactor is silently broken — the user sees three pills but the
    // model sees one prompt. This guard keeps that regression visible.
    expect(new Set(prompts).size).toBe(modes.length);
  });
});
