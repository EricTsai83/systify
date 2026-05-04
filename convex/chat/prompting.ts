import type { Id } from "../_generated/dataModel";
import type { ChatMode } from "../chatModeResolver";
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
 * Per-mode system prompts. Each mode has a distinct contract with the model:
 *
 *   - `discuss` (DB literal): training-only, no repo context. The prompt
 *     deliberately avoids the word "repository" so the model is less likely
 *     to fabricate references to "your repo" / "your codebase" when the
 *     conversation has nothing attached. The language pivots on "general
 *     architecture knowledge" and explicitly bans pretending to have access
 *     to source code.
 *   - `docs` (DB literal): artifact-grounded. The supplied artifacts (ADRs,
 *     diagrams, deep analyses, …) are the *only* source of truth; the model
 *     must say "the artifacts are silent on that" rather than guess.
 *   - `sandbox` (DB literal, Plan 04): live-source-grounded. The model is
 *     given two read-only file-system tools (`read_file` / `list_dir`) that
 *     return the actual contents of the attached sandbox. The prompt
 *     instructs the model to *use the tools* before claiming anything about
 *     specific files / line ranges, and to be honest when a tool call
 *     returns an error envelope (`{ ok: false, errorCode, message }`) — that
 *     is signal, not failure.
 *
 * Two style invariants worth preserving across all three prompts (and tested
 * in `chat-prompting.test.ts`):
 *
 *   1. **No UI display labels.** Prompts refer to other modes by their
 *      *capability* ("an artifact-grounded mode", "a live-sandbox mode"),
 *      never by the UI display label from `MODE_CATALOG` ("General Chat",
 *      "Design Docs"). UI copy can then be renamed without silently changing
 *      what the LLM tells the user.
 *   2. **No product roadmap.** Prompts describe the *current* capability gap
 *      rather than promising future tools. Specific upcoming tool names live
 *      in the tool-wiring plan, not here — naming them in v1 would commit us
 *      publicly (via the model's responses) to names and timelines we may
 *      still want to revise.
 *
 * Strings live in module-scoped constants (rather than inlined into the
 * lookup) so future tweaks — a citation contract, a step-budget hint, a
 * tool-usage section once tools are wired — can compose them without
 * re-deriving the whole block.
 */
const SYSTEM_PROMPT_DISCUSS = [
  "You are a senior software architect helping the user think through ideas in a free-form discussion.",
  "This conversation is not bound to any particular codebase, so answer from general architecture knowledge and reasoning only.",
  "Never assume the user has a specific project, codebase, or files in mind, and never refer to 'your codebase' or 'your repo' as if you can see one.",
  "If the user asks about specific code, suggest they switch to an artifact-grounded mode (for indexed design documents and architecture references) or a live-sandbox mode (for line-precise checks against current source) to get a grounded answer.",
  "Be concrete, mention likely trade-offs, and state uncertainty when reasoning is speculative.",
].join(" ");

const SYSTEM_PROMPT_DOCS = [
  "You are an open source architecture analyst answering questions about the attached project.",
  "Your sole source of truth is the design artifacts (ADRs, diagrams, deep analyses, design reviews, etc.) supplied in the user prompt.",
  "Each artifact in the prompt is numbered as `[A1]`, `[A2]`, …; cite every factual claim by appending the matching `[A#]` token immediately after the claim, so the user can trace each statement back to a specific artifact.",
  "If the artifacts do not cover the question, say so explicitly — never fabricate file paths, line numbers, or code-level claims that are not present in an artifact, and do not invent `[A#]` tokens for artifacts that were not supplied.",
  "Be concrete, mention likely boundaries, and state uncertainty when evidence is weak.",
].join(" ");

/**
 * Plan 04 — sandbox prompt. The model now has two read-only tools available:
 *
 *   - `read_file({ path })` returns the UTF-8 contents of a file under the
 *     repository root, capped at 64 KiB.
 *   - `list_dir({ path })` returns the entries (dirs first, alphabetical) of
 *     a directory under the repository root, capped at 200 entries.
 *
 * The prompt deliberately:
 *
 *   - Tells the model the repo root is the implicit anchor (so it doesn't
 *     try absolute paths the path validator will reject anyway).
 *   - Names the structured error envelope shape so the model knows that
 *     `{ ok: false, errorCode, message }` is a successful tool *call* with
 *     a useful error to *report* (not a fatal failure to retry blindly).
 *   - Reinforces a `[path:line-range]` citation habit — the model is now in
 *     a position to know exact line numbers, so unverified claims should
 *     stand out.
 *   - Caps tool usage to the step budget configured in `generation.ts`
 *     (currently 8) so the model knows when to stop drilling and start
 *     answering. The literal number stays in the prompt builder rather
 *     than the action so the contract is auditable in one place.
 */
const SYSTEM_PROMPT_SANDBOX = [
  "You are a senior architect with read-only access to the attached project's live source tree via two tools: `read_file({ path })` and `list_dir({ path })`. Paths are always relative to the repository root.",
  "When the user asks about specific files, modules, line ranges, or behavior, USE THE TOOLS to verify rather than guess from the artifact summaries. A short `list_dir` followed by a targeted `read_file` is almost always the right opening move.",
  "Each tool returns either `{ ok: true, ... }` or `{ ok: false, errorCode, message }`. Treat error envelopes as ordinary information — surface the errorCode to the user when it is meaningful (e.g. `path_outside_repo`, `invalid_path`), and try a corrected path instead of repeating the same call.",
  "Cite every claim about the codebase as `[path/to/file.ts:line-line]` so the user can jump to the exact source you read. If you state something you did not verify with a tool, prefix it with `Unverified:`.",
  "Stay within the per-reply tool budget (you have at most 8 tool calls). When the budget is nearly spent, stop drilling and write the best answer you can with what you have.",
].join(" ");

/**
 * Lookup keyed by `ChatMode` so adding a new mode literal forces a compile
 * error here (TypeScript exhaustiveness on `Record<Union, T>` is stricter
 * than on a `switch` statement, which only errors on accidental fall-through
 * if the function signature explicitly returns a non-union type).
 */
const SYSTEM_PROMPTS: Record<ChatMode, string> = {
  discuss: SYSTEM_PROMPT_DISCUSS,
  docs: SYSTEM_PROMPT_DOCS,
  sandbox: SYSTEM_PROMPT_SANDBOX,
};

export function buildSystemPrompt(mode: ChatMode): string {
  return SYSTEM_PROMPTS[mode];
}

/**
 * Citation entry persisted on `messages.citationMap`. Plan 02: each entry maps
 * the `[A#]` token the model sees in the prompt back to the specific artifact
 * id, so the frontend can turn `[A1]` in the assistant's reply into a link
 * that scrolls to / highlights that artifact in the side panel.
 */
export type CitationMapEntry = { index: number; artifactId: Id<"artifacts"> };

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
  // contract in `SYSTEM_PROMPT_DOCS`. Numbering is 1-based and order-stable
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

export function buildHeuristicAnswer(
  context: ReplyContext,
  question: string,
  relevantChunks: Array<{ path: string; summary: string; content: string }>,
) {
  const language = getUILanguage(context);

  // Plan 04 — sandbox-mode degraded path. When `OPENAI_API_KEY` is missing
  // we cannot run the tool loop at all (the tools fire from inside the AI
  // SDK's streamText loop and exist purely to inform the model's next
  // turn). Pretending to use them — by, say, returning the artifact
  // summaries instead — would be the worst-of-both: the user sees a
  // confident answer that didn't actually consult the live source. Surface
  // the gap explicitly and recommend the closest fallback (`docs`/General).
  if (context.mode === "sandbox") {
    const sandboxNoKeyMessages = {
      en: [
        "`OPENAI_API_KEY` is not configured, so I cannot run the live sandbox tools (`read_file` / `list_dir`) needed to answer in Sandbox mode.",
        "",
        `Your question: ${question}`,
        "",
        "Switch to an artifact-grounded mode (Design Docs) for answers based on your existing analyses, or to General Chat for open-ended discussion. Configure `OPENAI_API_KEY` to re-enable Sandbox mode.",
      ],
      zh: [
        "目前沒有設定 `OPENAI_API_KEY`，無法在 Sandbox 模式下呼叫 `read_file` / `list_dir` 工具來實際讀取沙箱裡的程式碼。",
        "",
        `你的問題：${question}`,
        "",
        "請改用 Design Docs 模式以你的設計文件作答，或切到 General Chat 做一般討論。要恢復 Sandbox 模式，請設定 `OPENAI_API_KEY`。",
      ],
    };
    return sandboxNoKeyMessages[language].join("\n");
  }

  const noRepoNoKeyMessages = {
    en: [
      `\`OPENAI_API_KEY\` is not configured, and this thread is not bound to a repository, so I cannot provide a grounded response.`,
      "",
      `Your question: ${question}`,
      "",
      "Suggestion: Attach a repository from the sidebar and ask again to get grounded / deep mode responses.",
    ],
    zh: [
      `目前沒有設定 \`OPENAI_API_KEY\`，且這個對話尚未綁定 repository，所以無法做 grounded 回覆。`,
      "",
      `你的問題：${question}`,
      "",
      "建議：在側邊欄附加一個 repository 之後再提問，就能取得 grounded / deep 模式的回覆。",
    ],
  };

  if (!context.sourceRepoFullName) {
    return noRepoNoKeyMessages[language].join("\n");
  }

  const withRepoNoKeyMessages = {
    en: [
      `\`OPENAI_API_KEY\` is not configured, so I'm using indexed repository artifacts to answer.`,
      "",
      `Repository: ${context.sourceRepoFullName}`,
      context.repositorySummary ? `- Summary: ${context.repositorySummary}` : undefined,
      context.architectureSummary ? `- Architecture: ${context.architectureSummary}` : undefined,
      "",
      `Your question: ${question}`,
      "",
      relevantChunks.length > 0
        ? `Most relevant code references: ${relevantChunks.map((chunk) => `\`${chunk.path}\``).join(", ")}`
        : "Not enough code snippets were selected; consider running a deep analysis first.",
    ],
    zh: [
      `目前沒有設定 \`OPENAI_API_KEY\`，所以我先用已索引的 repository artifact 回答。`,
      "",
      `Repository: ${context.sourceRepoFullName}`,
      context.repositorySummary ? `- Summary: ${context.repositorySummary}` : undefined,
      context.architectureSummary ? `- Architecture: ${context.architectureSummary}` : undefined,
      "",
      `你的問題：${question}`,
      "",
      relevantChunks.length > 0
        ? `我目前最相關的線索來自：${relevantChunks.map((chunk) => `\`${chunk.path}\``).join(", ")}`
        : "目前沒有足夠的程式碼片段被選中，建議先執行一次深度分析。",
    ],
  };

  return withRepoNoKeyMessages[language].filter(Boolean).join("\n");
}
