import { describe, expect, test } from "vitest";
import { buildCitationMap, buildDiscussSystemPrompt, buildSystemPrompt, buildUserPrompt } from "./chat/prompting";
import type { ChatMode } from "./chatModeResolver";
import type { Id } from "./_generated/dataModel";
import type { ReplyContext } from "./chat/context";
import { MAX_CONTEXT_ARTIFACTS } from "./lib/constants";

/**
 * Test helpers for the docs-citation tests below. We mint deterministic
 * fake `Id<"artifacts">` strings rather than going through `convexTest` —
 * the prompt builders are pure functions over a `ReplyContext`, so a
 * fixture is sufficient and keeps the tests fast.
 */
function makeArtifactId(suffix: string): Id<"artifacts"> {
  return `artifact_${suffix}` as unknown as Id<"artifacts">;
}

function makeContext(overrides: Partial<ReplyContext> & { artifacts?: ReplyContext["artifacts"] } = {}): ReplyContext {
  return {
    ownerTokenIdentifier: "owner|test",
    mode: "library",
    groundLibrary: false,
    groundSandbox: false,
    artifacts: [],
    chunks: [],
    messages: [],
    sourceRepoFullName: "acme/widget",
    repositorySummary: undefined,
    readmeSummary: undefined,
    architectureSummary: undefined,
    ...overrides,
  };
}

/**
 * Per-mode + per-grounding-flag system-prompt invariants.
 *
 * The point of these tests is *not* to pin down the exact wording — future
 * iterations of these prompts will keep adding sections. The wording will
 * drift; what must not drift are the mode-distinguishing properties that
 * make the prompts a useful design contract:
 *
 *   - Ungrounded Discuss is training-only — it should not present itself as an
 *     analyst that has access to "the repository", and it should bounce
 *     code-specific questions to the grounding toggles.
 *   - Library is artifact-grounded — it must tell the model that artifacts
 *     are the single source of truth.
 *   - Discuss with `groundSandbox: true` must wire the read_file / list_dir /
 *     run_shell tools and the `[path:line]` citation contract.
 *   - Discuss with `groundLibrary: true` shares the `[A#]` artifact citation
 *     contract with Library mode (via the shared ARTIFACT_CITATION_CONTRACT
 *     constant), and when both grounding axes are on a combined-citation
 *     rule disambiguates the two citation forms.
 */
describe("buildSystemPrompt", () => {
  test("ungrounded discuss prompt does not pretend to have access to a repository", () => {
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
    expect(prompt).toMatch(/(?:never|do not|do not refer|do not mention).*your codebase/i);
  });

  test("library prompt makes design artifacts the sole source of truth", () => {
    const prompt = buildSystemPrompt("library");

    expect(prompt.toLowerCase()).toContain("artifact");
    // "Sole source of truth" framing is what stops the model from mixing
    // in training-data guesses; this is the contract library mode promises
    // the user.
    expect(prompt.toLowerCase()).toMatch(/sole source of truth|only source/);
  });

  test("sandbox-grounded discuss prompt names the read_file, list_dir, and run_shell tools", () => {
    const prompt = buildSystemPrompt("discuss", { groundSandbox: true });

    expect(prompt).toContain("read_file");
    expect(prompt).toContain("list_dir");
    expect(prompt).toContain("run_shell");
  });

  test("sandbox-grounded discuss prompt frames run_shell as read-only inspection", () => {
    const prompt = buildSystemPrompt("discuss", { groundSandbox: true });

    expect(prompt.toLowerCase()).toMatch(/read-only/);
    expect(prompt).toMatch(/grep|find|git log/i);
  });

  test("sandbox-grounded discuss prompt forbids network egress so the LLM does not even attempt curl", () => {
    const prompt = buildSystemPrompt("discuss", { groundSandbox: true });
    expect(prompt.toLowerCase()).toMatch(/network|egress|do not.*curl|outbound/);
  });

  test("sandbox-grounded discuss prompt teaches the command_blocked / command_timeout error codes", () => {
    const prompt = buildSystemPrompt("discuss", { groundSandbox: true });
    expect(prompt).toContain("command_blocked");
    expect(prompt).toContain("command_timeout");
  });

  test("sandbox-grounded discuss prompt teaches the structured error envelope shape", () => {
    const prompt = buildSystemPrompt("discuss", { groundSandbox: true });

    expect(prompt).toContain("errorCode");
    expect(prompt).toMatch(/path_outside_repo|invalid_path/);
  });

  test("sandbox-grounded discuss prompt enforces a per-reply citation contract pointing at file:line", () => {
    const prompt = buildSystemPrompt("discuss", { groundSandbox: true });

    expect(prompt).toMatch(/\[path[^\]]*line[^\]]*\]/i);
    expect(prompt).toContain("Unverified:");
  });

  test("sandbox-grounded discuss prompt mentions the per-reply tool-call budget so the model knows when to stop", () => {
    const prompt = buildSystemPrompt("discuss", { groundSandbox: true });

    // The literal `8` mirrors `SANDBOX_STEP_BUDGET` in `generation.ts`.
    // The two values must agree — if the budget changes, this assertion
    // will catch the prompt drift that would otherwise silently mislead
    // the model.
    expect(prompt).toMatch(/at most 8/);
  });

  test("sandbox-grounded discuss prompt does not promise future product capability (no roadmap leak)", () => {
    const prompt = buildSystemPrompt("discuss", { groundSandbox: true });

    // System prompts ship to users today via the model's responses; they
    // are not the place to promise future product capability.
    expect(prompt).not.toMatch(/upcoming|future|will be given|will have|next version|coming soon/i);
  });

  test("prompts do not embed UI display labels (drift safety)", () => {
    // Embedding UI labels in system prompts would couple LLM behavior to UI
    // copy: renaming a mode label in the UI would silently change what the
    // model recommends without a code review on this file.
    //
    // We exclude "Sandbox" because it is both a UI label and standard
    // engineering vocabulary; banning the substring would forbid
    // legitimate descriptive uses ("a live-sandbox mode") that are not
    // UI-coupled.
    const uiOnlyLabels = ["General Chat", "Design Docs"];
    const modes: ChatMode[] = ["discuss", "library"];
    for (const mode of modes) {
      const prompt = buildSystemPrompt(mode);
      for (const label of uiOnlyLabels) {
        expect(prompt).not.toContain(label);
      }
    }
  });

  test("each mode receives a distinct, non-empty prompt", () => {
    const modes: ChatMode[] = ["discuss", "library"];
    const prompts = modes.map((mode) => buildSystemPrompt(mode));

    for (const prompt of prompts) {
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
    }

    // If two modes return the same prompt the mode-aware refactor is
    // silently broken — the user sees distinct pills but the model sees
    // one prompt. This guard keeps that regression visible.
    expect(new Set(prompts).size).toBe(modes.length);
  });

  test("library prompt teaches the [A#] citation contract", () => {
    const prompt = buildSystemPrompt("library");

    // The literal `[A#]` (or an `[A1]` / `[A2]` example) must appear
    // verbatim — paraphrases like "use bracketed references" are too
    // weak to make the model emit the exact `[A1]` shape the frontend
    // rewriter looks for.
    expect(prompt).toMatch(/\[A#\]|\[A1\]/);

    // The prompt must explicitly call out *citing* (vs. merely
    // mentioning the artifacts), otherwise the model can ramble about
    // the artifacts without ever attaching a token.
    expect(prompt.toLowerCase()).toMatch(/cite/);
  });
});

/**
 * Post-Lab-collapse: `buildDiscussSystemPrompt` composes the prompt from
 * grounding flags. All four (groundLibrary, groundSandbox) combinations
 * must produce a coherent prompt; the combined-citation rule only appears
 * when *both* axes are on.
 */
describe("buildDiscussSystemPrompt composability", () => {
  test("both flags off: ungrounded discuss baseline (no citation contracts)", () => {
    const prompt = buildDiscussSystemPrompt({ groundLibrary: false, groundSandbox: false });

    // Should match what `buildSystemPrompt("discuss")` returns (the default
    // composes both flags as false).
    expect(prompt).toBe(buildSystemPrompt("discuss"));

    // No artifact contract, no sandbox tool contract, no combined citation rule.
    expect(prompt).not.toMatch(/\[A#\]/);
    expect(prompt).not.toContain("read_file");
    expect(prompt).not.toMatch(/\[path[^\]]*line[^\]]*\]/i);
  });

  test("library only: composes the artifact citation contract without the sandbox tool block", () => {
    const prompt = buildDiscussSystemPrompt({ groundLibrary: true, groundSandbox: false });

    // The artifact citation contract appears.
    expect(prompt).toMatch(/\[A#\]|\[A1\]/);
    expect(prompt.toLowerCase()).toContain("artifact");

    // The sandbox tool contract does NOT appear.
    expect(prompt).not.toContain("read_file");
    expect(prompt).not.toContain("list_dir");
    expect(prompt).not.toContain("run_shell");
  });

  test("sandbox only: composes the sandbox tool contract without the artifact citation contract", () => {
    const prompt = buildDiscussSystemPrompt({ groundLibrary: false, groundSandbox: true });

    // The sandbox tool contract appears.
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("list_dir");
    expect(prompt).toContain("run_shell");
    expect(prompt).toMatch(/\[path[^\]]*line[^\]]*\]/i);

    // No artifact citation contract.
    expect(prompt).not.toMatch(/\[A#\]/);
  });

  test("both flags on: composes both contracts plus a combined-citation rule", () => {
    const prompt = buildDiscussSystemPrompt({ groundLibrary: true, groundSandbox: true });

    // Both contracts appear.
    expect(prompt).toMatch(/\[A#\]|\[A1\]/);
    expect(prompt).toContain("read_file");
    expect(prompt).toMatch(/\[path[^\]]*line[^\]]*\]/i);

    // The combined-citation rule is the only block that fires only when
    // both grounding axes are on — it disambiguates the two citation forms
    // and tells the model how to handle artifact-vs-live disagreement.
    expect(prompt.toLowerCase()).toMatch(/live|source of truth|disagree|divergence/);
  });

  test("the combined-citation rule appears only when both axes are on", () => {
    const both = buildDiscussSystemPrompt({ groundLibrary: true, groundSandbox: true });
    const libraryOnly = buildDiscussSystemPrompt({ groundLibrary: true, groundSandbox: false });
    const sandboxOnly = buildDiscussSystemPrompt({ groundLibrary: false, groundSandbox: true });

    // Cheap test: the combined prompt should be strictly longer than either
    // single-axis prompt because it appends the combined-citation rule on
    // top of both single-axis contracts.
    expect(both.length).toBeGreaterThan(libraryOnly.length);
    expect(both.length).toBeGreaterThan(sandboxOnly.length);

    // Composition contract: the both-on prompt is the union of both
    // contracts plus a divergence rule. The single-axis prompts should
    // NOT mention "disagree" / "divergence" / live-vs-artifact wording.
    expect(libraryOnly.toLowerCase()).not.toMatch(/disagree|divergence/);
    expect(sandboxOnly.toLowerCase()).not.toMatch(/disagree|divergence/);
  });

  test("buildSystemPrompt('discuss', flags) is a thin wrapper around buildDiscussSystemPrompt(flags)", () => {
    // Two calling conventions, one underlying composition. Anyone updating
    // the dispatch in `buildSystemPrompt` must not silently break the
    // per-flag composition.
    const flagsCases: Array<{ groundLibrary: boolean; groundSandbox: boolean }> = [
      { groundLibrary: false, groundSandbox: false },
      { groundLibrary: true, groundSandbox: false },
      { groundLibrary: false, groundSandbox: true },
      { groundLibrary: true, groundSandbox: true },
    ];
    for (const flags of flagsCases) {
      expect(buildSystemPrompt("discuss", flags)).toBe(buildDiscussSystemPrompt(flags));
    }
  });
});

describe("buildUserPrompt artifact numbering", () => {
  test("prefixes each rendered artifact with a 1-based [A#] marker", () => {
    const context = makeContext({
      artifacts: [
        {
          id: makeArtifactId("alpha"),
          title: "Architecture diagram",
          summary: "Module boundaries.",
          contentMarkdown: "graph TD\nA-->B",
        },
        {
          id: makeArtifactId("beta"),
          title: "Risk hotspots",
          summary: "Top 3 risks identified.",
          contentMarkdown: "1. coupling\n2. flaky tests\n3. db migration",
        },
      ],
    });

    const prompt = buildUserPrompt(context, "What does the diagram say?", []);

    // Both markers must show up in the rendered artifact section. This
    // is the contract that the system-prompt citation hint relies on:
    // if `[A1]` / `[A2]` aren't on the input side, the model can't
    // emit them on the output side.
    expect(prompt).toContain("## [A1] Architecture diagram");
    expect(prompt).toContain("## [A2] Risk hotspots");
  });

  test("numbering restarts at 1 per prompt and never exceeds MAX_CONTEXT_ARTIFACTS", () => {
    // Generate 1 more artifact than the prompt slice to confirm the cap
    // is enforced. Anything past the slice would be invisible to the
    // model but visible in the citation map; both must agree on the
    // visible window.
    const overflow = MAX_CONTEXT_ARTIFACTS + 1;
    const context = makeContext({
      artifacts: Array.from({ length: overflow }, (_, index) => ({
        id: makeArtifactId(`art-${index}`),
        title: `Artifact ${index}`,
        summary: `Summary ${index}`,
        contentMarkdown: `Body ${index}`,
      })),
    });

    const prompt = buildUserPrompt(context, "Summarize.", []);

    // First marker is `[A1]`, last one is exactly `[A${MAX_CONTEXT_ARTIFACTS}]`.
    expect(prompt).toContain("[A1]");
    expect(prompt).toContain(`[A${MAX_CONTEXT_ARTIFACTS}]`);
    // The artifact past the cap (`Artifact ${overflow - 1}`) has its
    // *title* sliced out of the prompt entirely. Asserting the marker
    // [A${MAX_CONTEXT_ARTIFACTS + 1}] is absent is the cleaner check.
    expect(prompt).not.toContain(`[A${MAX_CONTEXT_ARTIFACTS + 1}]`);
  });
});

describe("buildCitationMap", () => {
  test("returns 1-based entries that pair each [A#] with its artifact id", () => {
    const alphaId = makeArtifactId("alpha");
    const betaId = makeArtifactId("beta");
    const context = makeContext({
      artifacts: [
        { id: alphaId, title: "Alpha", summary: "", contentMarkdown: "" },
        { id: betaId, title: "Beta", summary: "", contentMarkdown: "" },
      ],
    });

    const map = buildCitationMap(context);

    // Index numbering is 1-based to mirror the `[A1]` token the model
    // sees; the artifact ids are returned in the *same* order the
    // prompt rendered them, so the frontend can resolve `[A1]` →
    // `alphaId` without any further bookkeeping.
    expect(map).toEqual([
      { index: 1, artifactId: alphaId },
      { index: 2, artifactId: betaId },
    ]);
  });

  test("caps at MAX_CONTEXT_ARTIFACTS so the map and prompt stay in lockstep", () => {
    const overflow = MAX_CONTEXT_ARTIFACTS + 2;
    const context = makeContext({
      artifacts: Array.from({ length: overflow }, (_, index) => ({
        id: makeArtifactId(`art-${index}`),
        title: `Artifact ${index}`,
        summary: "",
        contentMarkdown: "",
      })),
    });

    const map = buildCitationMap(context);

    // Same cap as `buildUserPrompt`: a frontend that resolves
    // `[A${MAX_CONTEXT_ARTIFACTS + 1}]` against this map must get
    // `undefined` (i.e. fall through to plain text), not a phantom
    // mapping for an artifact the model never saw.
    expect(map).toHaveLength(MAX_CONTEXT_ARTIFACTS);
    expect(map[map.length - 1]?.index).toBe(MAX_CONTEXT_ARTIFACTS);
  });

  test("returns an empty map when no artifacts are in scope", () => {
    // discuss / unattached threads have no artifacts; an empty map
    // signals "no resolvable citations" so the generation pipeline can
    // skip persisting the field on `messages.citationMap`.
    const map = buildCitationMap(makeContext({ artifacts: [] }));
    expect(map).toEqual([]);
  });
});
