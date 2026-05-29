import type { Id } from "../_generated/dataModel";
import type { ChatMode } from "../lib/chatMode";
import { MAX_CONTEXT_ARTIFACTS } from "../lib/constants";
import type { ReplyContext } from "./context";

/**
 * UI language for the degraded heuristic response. The chat UI is currently
 * English-only, so we default to "en". The i18n map below is intentionally
 * preserved so additional locales can be plugged in once the UI starts
 * persisting a per-thread/per-user language hint (e.g. on `ReplyContext`).
 */
type UILanguage = "en" | "zh";

function getUILanguage(_context: ReplyContext): UILanguage {
  return "en";
}

/**
 * Per-mode system prompts. The two surviving modes have distinct contracts
 * with the model:
 *
 *   - `discuss` (DB literal): two independent grounding axes —
 *     {@link GroundingFlags}. When both are off the prompt is training-only
 *     and forbids the model from pretending to see code. Enabling
 *     `groundLibrary` adds the artifact-citation contract; enabling
 *     `groundSandbox` adds the live-tool citation contract; both on adds
 *     a combined-citation rule.
 *   - `library` (DB literal): artifact-grounded reader / Ask surface.
 *     The supplied artifacts are the only source of truth; the model
 *     must say "the artifacts are silent on that" rather than guess.
 *
 * Two style invariants worth preserving across every variant (and tested
 * in `chat-prompting.test.ts`):
 *
 *   1. **Refer to capabilities, not DB literals.** Prompts refer to
 *      grounding sources by their *capability* ("an artifact-grounded
 *      response", "a live-sandbox response"), never by the DB literal or
 *      UI label directly. UI copy can then be renamed without silently
 *      changing what the LLM tells the user.
 *   2. **No product roadmap.** Prompts describe the *current* capability
 *      gap rather than promising future tools.
 *
 * Strings live in module-scoped constants so future tweaks — a citation
 * contract, a step-budget hint — can compose them without re-deriving the
 * whole block.
 */
const DISCUSS_BASELINE = [
  "You are a senior software architect helping the user think through ideas in a free-form discussion.",
].join(" ");

const DISCUSS_UNGROUNDED = [
  "This reply is not grounded in any artifact or live source, so answer from general architecture knowledge and reasoning only.",
  "Never assume the user has a specific project, codebase, or files in mind, and never refer to 'your codebase' or 'your repo' as if you can see one.",
  "If the user asks about specific code, suggest they enable the Library grounding toggle (for indexed design documents) or the Sandbox grounding toggle (for line-precise checks against current source) to get a grounded answer.",
  "Be concrete, mention likely trade-offs, and state uncertainty when reasoning is speculative.",
].join(" ");

/**
 * Shared `[A#]` artifact citation contract used by both Library Mode and
 * Discuss with Library grounding. Extracted so the two prompts cannot
 * drift on the rule the citation lint / frontend resolver care about.
 */
const ARTIFACT_CITATION_CONTRACT = [
  "Each artifact in the prompt is numbered as `[A1]`, `[A2]`, …; cite every factual claim sourced from artifacts by appending the matching `[A#]` token immediately after the claim, so the user can trace each statement back to a specific artifact.",
  "If the artifacts do not cover the question, say so explicitly — never fabricate file paths, line numbers, or code-level claims that are not present in an artifact, and do not invent `[A#]` tokens for artifacts that were not supplied.",
].join(" ");

const DISCUSS_LIBRARY_RULES = [
  "This reply is grounded in the attached project's design artifacts (architecture overviews, diagrams, deep analyses, design reviews, etc.) supplied in the user prompt.",
  ARTIFACT_CITATION_CONTRACT,
  "Be concrete, mention likely boundaries, and state uncertainty when evidence is weak.",
].join(" ");

/**
 * Sandbox tool contract — read-only access to the attached project's live
 * source tree. The prompt deliberately:
 *
 *   - Tells the model the repo root is the implicit anchor (so it does not
 *     try absolute paths the path validator will reject anyway).
 *   - Names the structured error envelope shape so the model knows that
 *     `{ ok: false, errorCode, message }` is a successful tool *call* with
 *     a useful error to *report* (not a fatal failure to retry blindly).
 *   - Reinforces a `[path:line-range]` citation habit — the model is now
 *     positioned to know exact line numbers, so unverified claims stand out.
 *   - Caps tool usage to the step budget configured in `generation.ts`
 *     (currently 8) so the model knows when to stop drilling.
 *   - Anchors `run_shell` as *read-only inspection only* (`grep` / `find` /
 *     `git log` / `tree` / `wc`). The deny list is a last-mile filter; the
 *     system prompt is the first line of defense.
 *   - Forbids network egress at the prompt layer. Daytona's network policy
 *     is a separate enforcement layer documented in
 *     `docs/sandbox-mode-system-design.md`, but stating the rule here stops
 *     the LLM from attempting `curl example.com` and burning a step on a
 *     guaranteed failure.
 */
const DISCUSS_SANDBOX_RULES = [
  "This reply has read-only access to the attached project's live source tree via three tools: `read_file({ path })`, `list_dir({ path })`, and `run_shell({ command, workdir?, timeout_seconds? })`. Paths and workdirs are always relative to the repository root.",
  "When the user asks about specific files, modules, line ranges, or behavior, USE THE TOOLS to verify rather than guess. A short `list_dir` followed by a targeted `read_file` is almost always the right opening move; reach for `run_shell` when you need composition (`grep -rn`, `find -name`, `git log --oneline`, `wc -l`).",
  "Use `run_shell` for read-only inspection commands ONLY: `grep`, `find`, `git log`, `git diff`, `tree`, `wc`, `head`, `tail`, `cat`, `ls`. Do not modify files, install packages, or attempt network egress — the sandbox is read-only by policy and outbound network is unavailable. Destructive commands (`rm -rf /`, fork bombs, `mkfs`, `dd`, `sudo`, `shutdown`, piping `curl`/`wget` into a shell) are blocked at the tool layer and return `errorCode: 'command_blocked'` with a reason; do not retry the same shape, rephrase as a non-destructive read.",
  "`run_shell` returns a non-zero `exitCode` for commands that succeeded but found nothing (e.g. `grep` exits 1 with no matches). Treat that as data, not error — combine it with the textual output to decide your next step.",
  "Each tool returns either `{ ok: true, ... }` or `{ ok: false, errorCode, message }`. Treat error envelopes as ordinary information — surface the errorCode to the user when it is meaningful (e.g. `path_outside_repo`, `invalid_path`, `command_blocked`, `command_timeout`), and try a corrected path or command instead of repeating the same call.",
  "Cite every claim about the codebase as `[path/to/file.ts:line-line]` so the user can jump to the exact source you read. If you state something you did not verify with a tool, prefix it with `Unverified:`.",
  "Stay within the per-reply tool budget (you have at most 8 tool calls). When the budget is nearly spent, stop drilling and write the best answer you can with what you have.",
].join(" ");

const DISCUSS_COMBINED_CITATION_RULES = [
  "When citing artifacts use `[A#]` tokens; when citing live code use `[path:line-line]` tokens. Pick the citation form that matches the actual evidence source for each claim — do not mix one form against the other source.",
  "If a live-tool read and an artifact disagree on a fact about the current code, treat the live tool as the source of truth, explicitly call out the divergence to the user, and cite both (artifact via `[A#]`, live source via `[path:line-line]`).",
].join(" ");

const SYSTEM_PROMPT_LIBRARY = [
  "You are an open source architecture analyst answering questions about the attached project.",
  "Your sole source of truth is the design artifacts (architecture overviews, diagrams, deep analyses, design reviews, etc.) supplied in the user prompt.",
  ARTIFACT_CITATION_CONTRACT,
  "Be concrete, mention likely boundaries, and state uncertainty when evidence is weak.",
].join(" ");

export type ExtendedChatMode = ChatMode;

/**
 * Per-message grounding flags for Discuss mode. Library mode does not use
 * these — the artifact retrieval is implicit in the mode. Both `false` or
 * absent means "training-only LLM chat".
 */
export type GroundingFlags = {
  groundLibrary?: boolean;
  groundSandbox?: boolean;
};

/**
 * Compose the Discuss system prompt from per-message grounding flags. The
 * baseline persona is constant; each enabled grounding axis appends its
 * own contract block. When both axes are on a final combined-citation
 * rule disambiguates the two citation forms and tells the model how to
 * handle artifact vs. live-source disagreement.
 */
export function buildDiscussSystemPrompt(flags: GroundingFlags): string {
  const groundLibrary = flags.groundLibrary === true;
  const groundSandbox = flags.groundSandbox === true;
  const parts: string[] = [DISCUSS_BASELINE];
  if (!groundLibrary && !groundSandbox) {
    parts.push(DISCUSS_UNGROUNDED);
  } else {
    if (groundLibrary) {
      parts.push(DISCUSS_LIBRARY_RULES);
    }
    if (groundSandbox) {
      parts.push(DISCUSS_SANDBOX_RULES);
    }
    if (groundLibrary && groundSandbox) {
      parts.push(DISCUSS_COMBINED_CITATION_RULES);
    }
  }
  return parts.join(" ");
}

/**
 * Resolve the system prompt for a given mode + flags. Library Mode ignores
 * the flags (grounding is implicit in the mode). Discuss Mode composes the
 * prompt from the flags via {@link buildDiscussSystemPrompt}.
 */
export function buildSystemPrompt(mode: ChatMode, flags: GroundingFlags = {}): string {
  if (mode === "library") {
    return SYSTEM_PROMPT_LIBRARY;
  }
  return buildDiscussSystemPrompt(flags);
}

/**
 * Citation entry persisted on `messages.citationMap`. Each entry maps the
 * `[A#]` token the model sees in the prompt back to the specific artifact
 * id, so the frontend can turn `[A1]` in the assistant's reply into a link
 * that scrolls to / highlights that artifact in the side panel.
 */
export type CitationMapEntry = {
  index: number;
  artifactId: Id<"artifacts">;
  chunkId?: Id<"artifactChunks">;
  headingPath?: string[];
};

/**
 * Numbered artifact list that ends up in the assistant message's
 * `citationMap`. Capped at the same `MAX_CONTEXT_ARTIFACTS` slice the prompt
 * uses so frontend `[A#]` resolution and the prompt the model saw stay in
 * lockstep — anything past the slice is invisible to the model and must not
 * resolve to a citation client-side either.
 */
export function buildCitationMap(context: ReplyContext): CitationMapEntry[] {
  return context.artifacts
    .slice(0, MAX_CONTEXT_ARTIFACTS)
    .map((artifact, index) => ({ index: index + 1, artifactId: artifact.id }));
}

export function buildUserPrompt(
  context: ReplyContext,
  question: string,
  relevantChunks: Array<{ path: string; summary: string; content: string }>,
) {
  // Each artifact gets a `[A1]`, `[A2]`, … prefix matching the citation
  // contract in `SYSTEM_PROMPT_LIBRARY`. Numbering is 1-based and order-stable
  // with `buildCitationMap` (same slice, same iteration order) so the
  // frontend can resolve each `[A#]` token in the model's reply back to a
  // specific artifact id without re-deriving the mapping.
  const artifactSection = context.artifacts
    .slice(0, MAX_CONTEXT_ARTIFACTS)
    .map(
      (artifact, index) =>
        `## [A${index + 1}] ${artifact.title}\n${artifact.summary}\n${artifact.contentMarkdown.slice(0, 1400)}`,
    )
    .join("\n\n");
  const chunkSection = relevantChunks
    .map((chunk) => `### ${chunk.path}\n${chunk.summary}\n${chunk.content.slice(0, 1200)}`)
    .join("\n\n");

  const hasRepoContext =
    !!context.sourceRepoFullName ||
    !!context.repositorySummary ||
    context.artifacts.length > 0 ||
    relevantChunks.length > 0;

  return [
    context.sourceRepoFullName ? `Repository: ${context.sourceRepoFullName}` : undefined,
    context.repositorySummary ? `Repository summary: ${context.repositorySummary}` : undefined,
    context.readmeSummary ? `README summary: ${context.readmeSummary}` : undefined,
    context.architectureSummary ? `Architecture summary: ${context.architectureSummary}` : undefined,
    ...(hasRepoContext
      ? [
          "",
          "Artifacts:",
          artifactSection || "No artifacts were pre-selected.",
          "",
          "Relevant code excerpts:",
          chunkSection || "No highly relevant chunks were pre-selected.",
          "",
        ]
      : ["No repository is attached to this thread; answer from general architecture knowledge."]),
    `User question: ${question}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * Code-excerpt fixture passed by the relevance pipeline into the heuristic
 * fallback. Lifted out of `buildHeuristicAnswer`'s parameter list so the
 * `HEURISTIC_MESSAGES` table below can name the type without referring to a
 * local that hasn't been declared at module scope.
 */
type HeuristicChunk = { readonly path: string; readonly summary: string; readonly content: string };

/**
 * Per-language builders for the no-API-key degraded path. Three branches
 * mirror `buildHeuristicAnswer`'s control flow:
 *
 *   - `sandbox`: thread is in sandbox mode but the model can't run.
 *   - `noRepo`:  thread has no repository attached.
 *   - `withRepo`: thread has a repository; answer from indexed artifacts.
 *
 * `withRepo` returns `Array<string | undefined>` (rather than `string[]`)
 * because the optional summary lines (`repositorySummary`,
 * `architectureSummary`) are folded in conditionally — emitting `undefined`
 * keeps the per-language builder declarative. The caller filters before
 * joining so the produced markdown has no blank rows from absent fields.
 *
 * `summaries` is a `Partial<ReplyContext>` so the builder doesn't carry the
 * whole `ReplyContext` shape (which the messages do not need); only the
 * three string fields it actually reads are used.
 */
type HeuristicMessageBuilders = {
  readonly sandbox: (question: string) => string[];
  readonly noRepo: (question: string) => string[];
  readonly withRepo: (
    question: string,
    chunks: ReadonlyArray<HeuristicChunk>,
    summaries: Partial<ReplyContext>,
  ) => Array<string | undefined>;
};

const HEURISTIC_MESSAGES: Record<UILanguage, HeuristicMessageBuilders> = {
  en: {
    sandbox: (question) => [
      "`OPENAI_API_KEY` is not configured, so I cannot run the live sandbox tools (`read_file` / `list_dir` / `run_shell`) needed to answer with sandbox grounding.",
      "",
      `Your question: ${question}`,
      "",
      "Turn off the Sandbox toggle to ask without live-source grounding, or enable Library grounding to lean on existing artifacts. Configure `OPENAI_API_KEY` to re-enable sandbox grounding.",
    ],
    noRepo: (question) => [
      "`OPENAI_API_KEY` is not configured, and this thread is not bound to a repository, so I cannot provide a grounded response.",
      "",
      `Your question: ${question}`,
      "",
      "Suggestion: Attach a repository from the sidebar and ask again to get grounded / deep mode responses.",
    ],
    withRepo: (question, chunks, summaries) => [
      "`OPENAI_API_KEY` is not configured, so I'm using indexed repository artifacts to answer.",
      "",
      `Repository: ${summaries.sourceRepoFullName ?? "(unknown)"}`,
      summaries.repositorySummary ? `- Summary: ${summaries.repositorySummary}` : undefined,
      summaries.architectureSummary ? `- Architecture: ${summaries.architectureSummary}` : undefined,
      "",
      `Your question: ${question}`,
      "",
      chunks.length > 0
        ? `Most relevant code references: ${chunks.map((chunk) => `\`${chunk.path}\``).join(", ")}`
        : "Not enough code snippets were selected; consider running a system design first.",
    ],
  },
  zh: {
    sandbox: (question) => [
      "目前沒有設定 `OPENAI_API_KEY`，無法呼叫 `read_file` / `list_dir` / `run_shell` 工具來實際讀取沙箱裡的程式碼。",
      "",
      `你的問題：${question}`,
      "",
      "請關掉 Sandbox 開關以一般方式回覆，或改開 Library 開關用既有 artifact 作答。要恢復 sandbox grounding，請設定 `OPENAI_API_KEY`。",
    ],
    noRepo: (question) => [
      "目前沒有設定 `OPENAI_API_KEY`，且這個對話尚未綁定 repository，所以無法做 grounded 回覆。",
      "",
      `你的問題：${question}`,
      "",
      "建議：在側邊欄附加一個 repository 之後再提問，就能取得 grounded / deep 模式的回覆。",
    ],
    withRepo: (question, chunks, summaries) => [
      "目前沒有設定 `OPENAI_API_KEY`，所以我先用已索引的 repository artifact 回答。",
      "",
      `Repository: ${summaries.sourceRepoFullName ?? "(unknown)"}`,
      summaries.repositorySummary ? `- Summary: ${summaries.repositorySummary}` : undefined,
      summaries.architectureSummary ? `- Architecture: ${summaries.architectureSummary}` : undefined,
      "",
      `你的問題：${question}`,
      "",
      chunks.length > 0
        ? `我目前最相關的線索來自：${chunks.map((chunk) => `\`${chunk.path}\``).join(", ")}`
        : "目前沒有足夠的程式碼片段被選中，建議先執行一次深度分析。",
    ],
  },
};

export function buildHeuristicAnswer(
  context: ReplyContext,
  question: string,
  relevantChunks: ReadonlyArray<HeuristicChunk>,
) {
  const language = getUILanguage(context);

  // Sandbox-grounded Discuss reply with no API key: the model can't run
  // the live tools, so surface a dead-end message rather than letting the
  // heuristic fallback produce text that pretends to have inspected the
  // sandbox.
  if (context.groundSandbox === true) {
    return HEURISTIC_MESSAGES[language].sandbox(question).join("\n");
  }

  if (!context.sourceRepoFullName) {
    return HEURISTIC_MESSAGES[language].noRepo(question).join("\n");
  }

  // `withRepo` may emit `undefined` placeholders for absent optional summary
  // fields. Filtering with a typed predicate (rather than `.filter(Boolean)`)
  // narrows the array element type back to `string` so `.join` operates on a
  // `string[]` and the ESLint / `noUncheckedIndexedAccess` future-toggle would
  // not trip.
  return HEURISTIC_MESSAGES[language]
    .withRepo(question, relevantChunks, context)
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
