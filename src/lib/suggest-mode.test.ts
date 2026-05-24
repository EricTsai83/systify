import { describe, expect, test } from "vitest";
import { suggestMode } from "./suggest-mode";
import type { ChatMode } from "./types";

const ALL_MODES: readonly ChatMode[] = ["discuss", "library", "lab"];

/**
 * Plan 14 — `suggestMode` is the pure heuristic powering the inline
 * "Switch to …" hint above the composer. The composer is shielded from
 * any unnecessary work by `useMemo`, but the heuristic itself must be
 * predictable across every (input, currentMode, availableModes) tuple
 * the user can produce.
 *
 * The cases below cover:
 *
 *   - both heuristics in their happy paths,
 *   - mode-gating (only fires when the suggested mode would actually be
 *     selectable in the selector),
 *   - "no nudge" defaults for empty / generic input,
 *   - rule precedence when two heuristics could fire,
 *   - resilience to apostrophe variants and leading whitespace,
 *   - stable `key` values used by the session-level dismiss set.
 */
describe("suggestMode — file-path → lab heuristic", () => {
  test("nudges discuss → lab when the input mentions a .ts source file", () => {
    const result = suggestMode("Walk me through convex/chat/send.ts line 80.", "discuss", ALL_MODES);
    expect(result).not.toBeNull();
    expect(result?.suggested).toBe("lab");
    expect(result?.key).toBe("specific-file:lab");
    // The reason copy is part of the user-visible contract — anchor the
    // assertion on it so any future drift forces a deliberate update
    // (and a re-review of how the message reads in the UI).
    expect(result?.reason).toBe(
      "This question references a specific file. Lab mode would give a more accurate answer.",
    );
  });

  test("nudges library → lab for the same heuristic", () => {
    // Library mode has artifacts but cannot resolve concrete file:line ranges,
    // so a library-mode answer about a specific file would have to invent
    // line numbers. Lab is unambiguously a better fit.
    const result = suggestMode("Why does src/components/chat-panel.tsx re-render so often?", "library", ALL_MODES);
    expect(result?.suggested).toBe("lab");
  });

  test("recognises every supported source extension", () => {
    // The extension list mirrors the regex in the implementation. If
    // someone narrows the regex without updating this fixture, the
    // failure must surface here rather than be discovered in production.
    const samples = [
      "Read convex/foo.ts",
      "Read src/component.tsx",
      "Read src/legacy.js",
      "Read src/legacy.jsx",
      "Read scripts/build.py",
      "Read crates/core/src/lib.rs",
      "Read internal/api/handler.go",
    ];
    for (const sample of samples) {
      const result = suggestMode(sample, "discuss", ALL_MODES);
      expect(result?.suggested).toBe("lab");
    }
  });

  test("does not fire when lab is not in availableModes (suggestion would bounce off disabled state)", () => {
    // The hint must always be actionable — if lab is gated by the
    // rollout %, the repo isn't attached, or quotas ran out, suppressing
    // the suggestion is more useful than showing a [Switch] button that
    // does nothing.
    expect(suggestMode("Look at convex/foo.ts", "discuss", ["discuss", "library"])).toBeNull();
  });

  test("does not fire when the user is already in lab", () => {
    // A file mention in lab mode is the *expected* shape, not a
    // suggestion to switch.
    expect(suggestMode("Look at convex/foo.ts", "lab", ALL_MODES)).toBeNull();
  });

  test("is anchored on word boundaries — bare extension strings do not fire", () => {
    // "switched to ts" or "the .ts ecosystem" should not trigger; only
    // a path-shaped token followed by a recognized extension.
    expect(suggestMode("we switched to ts last quarter", "discuss", ALL_MODES)).toBeNull();
    expect(suggestMode("tell me about the .ts ecosystem", "discuss", ALL_MODES)).toBeNull();
  });

  test("ignores non-source extensions (markdown / config files)", () => {
    // Markdown / TOML / JSON files live in design artifacts (library mode)
    // or repo config — lab grounding is not a clear win for them, so
    // the heuristic stays out of the way.
    expect(suggestMode("Look at README.md", "discuss", ALL_MODES)).toBeNull();
    expect(suggestMode("Check Cargo.toml", "discuss", ALL_MODES)).toBeNull();
    expect(suggestMode("What's in package.json?", "discuss", ALL_MODES)).toBeNull();
  });
});

describe("suggestMode — open-ended → discuss heuristic", () => {
  test("nudges library → discuss for 'how should I' prefixes", () => {
    const result = suggestMode("How should I structure auth in this app?", "library", ALL_MODES);
    expect(result?.suggested).toBe("discuss");
    expect(result?.key).toBe("open-ended:discuss");
    expect(result?.reason).toBe("This sounds open-ended; Discuss might be better.");
  });

  test('nudges lab → discuss for "what\'s the best way to" prefixes', () => {
    const result = suggestMode("What's the best way to memoize a selector?", "lab", ALL_MODES);
    expect(result?.suggested).toBe("discuss");
  });

  test("tolerates curly apostrophes and missing apostrophes (mobile keyboard auto-correct)", () => {
    // Mobile keyboards auto-correct `'` → `’`. Without explicit support
    // the hint would silently disappear for a non-trivial fraction of
    // mobile users; that fail-quiet behavior is the kind of bug that
    // never gets reported.
    expect(suggestMode("What’s the best way to handle errors?", "lab", ALL_MODES)?.suggested).toBe("discuss");
    expect(suggestMode("Whats the best way to handle errors?", "lab", ALL_MODES)?.suggested).toBe("discuss");
  });

  test("matches case-insensitively and tolerates leading whitespace", () => {
    expect(suggestMode("HOW SHOULD I scale this?", "library", ALL_MODES)?.suggested).toBe("discuss");
    expect(suggestMode("   how should I scale this?", "library", ALL_MODES)?.suggested).toBe("discuss");
  });

  test("does not fire when already in discuss (no useful switch target)", () => {
    expect(suggestMode("How should I scale this?", "discuss", ALL_MODES)).toBeNull();
  });

  test("does not fire when the prefix is buried mid-sentence", () => {
    // "I'm wondering how should I scale this" is a real but rare phrasing;
    // we keep the heuristic anchored to message-start to avoid catching
    // every reflective question that mentions the words in passing.
    expect(suggestMode("I'm wondering how should I scale this?", "library", ALL_MODES)).toBeNull();
  });
});

describe("suggestMode — rule precedence and defaults", () => {
  test("file-path rule beats open-ended rule when both could fire", () => {
    // "How should I refactor convex/foo.ts?" is open-ended *and* mentions
    // a file. Lab grounding still pays off here because the answer
    // benefits from reading the file, even if the question is phrased
    // open-endedly. Order in the implementation matters.
    const result = suggestMode("How should I refactor convex/foo.ts for testability?", "library", ALL_MODES);
    expect(result?.suggested).toBe("lab");
    expect(result?.key).toBe("specific-file:lab");
  });

  test("returns null for empty / whitespace-only input", () => {
    expect(suggestMode("", "discuss", ALL_MODES)).toBeNull();
    expect(suggestMode("    ", "discuss", ALL_MODES)).toBeNull();
    expect(suggestMode("\n\t", "discuss", ALL_MODES)).toBeNull();
  });

  test("returns null for generic prose with no path mention and no open-ended prefix", () => {
    expect(suggestMode("Explain CQRS to me.", "library", ALL_MODES)).toBeNull();
    expect(suggestMode("What are the trade-offs of optimistic locking?", "discuss", ALL_MODES)).toBeNull();
  });
});
