import { describe, expect, test } from "vitest";
import { buildCitationMap, buildSystemPrompt, buildUserPrompt } from "./chat/prompting";
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

function makeContext(
  overrides: Partial<ReplyContext> & { artifacts?: ReplyContext["artifacts"] } = {},
): ReplyContext {
  return {
    ownerTokenIdentifier: "owner|test",
    mode: "docs",
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
    expect(prompt).toMatch(/(?:never|do not|do not refer|do not mention).*your codebase/i);
  });

  test("docs prompt makes design artifacts the sole source of truth", () => {
    const prompt = buildSystemPrompt("docs");

    expect(prompt.toLowerCase()).toContain("artifact");
    // "Sole source of truth" framing is what stops the model from mixing
    // in training-data guesses; this is the contract docs mode promises
    // the user.
    expect(prompt.toLowerCase()).toMatch(/sole source of truth|only source/);
  });

  test("sandbox prompt names the read_file and list_dir tools (Plan 04)", () => {
    const prompt = buildSystemPrompt("sandbox");

    // Plan 04 wires real `read_file` / `list_dir` tools. The system prompt
    // must name them so the model picks them up — the AI SDK exposes the
    // tool descriptions but the prompt's "USE THE TOOLS" framing is what
    // actually gets the model to *prefer* tool calls over guessing from
    // the artifact summaries.
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("list_dir");
  });

  test("sandbox prompt teaches the structured error envelope shape", () => {
    const prompt = buildSystemPrompt("sandbox");

    // Tool errors are *values*, not throws (see `sandboxTools.ts`). The
    // model needs to know an `{ ok: false, errorCode, message }` envelope
    // is signal — not a fatal failure to retry blindly. Without this hint
    // the model often loops on the same bad path or surrenders.
    expect(prompt).toContain("errorCode");
    // Specific error codes the validator emits should appear so the
    // model can react with named handling.
    expect(prompt).toMatch(/path_outside_repo|invalid_path/);
  });

  test("sandbox prompt enforces a per-reply citation contract pointing at file:line", () => {
    const prompt = buildSystemPrompt("sandbox");

    // The model now knows exact line numbers (it can `read_file` to find
    // them), so the citation contract is stricter than docs mode's
    // artifact-level `[A#]` — every claim must point at `[path:line-line]`.
    expect(prompt).toMatch(/\[path[^\]]*line[^\]]*\]/i);
    // The "Unverified:" prefix is the bargain we make with the model when
    // a claim cannot be backed by a tool result; tested separately so
    // the contract isn't accidentally dropped.
    expect(prompt).toContain("Unverified:");
  });

  test("sandbox prompt mentions the per-reply tool-call budget so the model knows when to stop", () => {
    const prompt = buildSystemPrompt("sandbox");

    // The literal `8` mirrors `SANDBOX_STEP_BUDGET` in `generation.ts`.
    // The two values must agree — if the budget changes, this assertion
    // will catch the prompt drift that would otherwise silently mislead
    // the model. (Plan 11 turns this into a per-step injected counter.)
    expect(prompt).toMatch(/at most 8/);
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

  /**
   * Plan 02 docs-mode citation contract. The system prompt must now
   * actively instruct the model to cite each claim with `[A#]`. Without
   * this contract the model has no incentive to emit the tokens that
   * Plan 02's frontend rewrites into clickable links.
   */
  test("docs prompt teaches the [A#] citation contract", () => {
    const prompt = buildSystemPrompt("docs");

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
