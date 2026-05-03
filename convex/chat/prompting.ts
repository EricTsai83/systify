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
 *   - `sandbox` (DB literal): in v1 the prompt makes clear the model has no
 *     direct file-reading or shell-execution capability and must answer using
 *     only the artifacts and code excerpts present in the user prompt; it
 *     also flags claims it would normally verify against the live source so
 *     the user knows which parts are unverified.
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
  "If the artifacts do not cover the question, say so explicitly — never fabricate file paths, line numbers, or code-level claims that are not present in an artifact.",
  "Be concrete, mention likely boundaries, and state uncertainty when evidence is weak.",
].join(" ");

const SYSTEM_PROMPT_SANDBOX = [
  "You are a senior architect with read-only knowledge of the attached project's source tree.",
  "In this version, you do not have file-reading or shell-execution tools available, so answer using only the design artifacts and code excerpts provided in the user prompt.",
  "Explicitly flag any claim you would normally verify by inspecting a file or running a command, so the user knows which parts are unverified rather than directly checked.",
  "Be concrete, cite specific files and line ranges when the provided context contains them, and state uncertainty when evidence is weak.",
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

export function buildUserPrompt(
  context: ReplyContext,
  question: string,
  relevantChunks: Array<{ path: string; summary: string; content: string }>,
) {
  const artifactSection = context.artifacts
    .slice(0, MAX_CONTEXT_ARTIFACTS)
    .map((artifact) => `## ${artifact.title}\n${artifact.summary}\n${artifact.contentMarkdown.slice(0, 1400)}`)
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

  return withRepoNoKeyMessages[language]
    .filter(Boolean)
    .join("\n");
}
