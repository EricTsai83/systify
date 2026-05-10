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
 * Plan 04 + 08 — sandbox prompt. The model now has three read-only tools
 * available:
 *
 *   - `read_file({ path })` returns the UTF-8 contents of a file under the
 *     repository root, capped at 64 KiB.
 *   - `list_dir({ path })` returns the entries (dirs first, alphabetical) of
 *     a directory under the repository root, capped at 200 entries.
 *   - `run_shell({ command, workdir?, timeout_seconds? })` runs a shell
 *     command inside the sandbox. Output is capped at 32 KiB; the workdir
 *     is pinned inside the repository; obviously-destructive commands
 *     (`rm -rf /`, fork bombs, `mkfs`, `dd`, `sudo`, system shutdown,
 *     network pipe-to-shell) are blocked and return
 *     `errorCode: 'command_blocked'`.
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
 *   - Plan 08: anchors `run_shell` as *read-only inspection only*
 *     (`grep` / `find` / `git log` / `tree` / `wc`). The deny list is a
 *     last-mile filter; the system prompt is the first line of defense
 *     because the LLM controls what it tries.
 *   - Plan 08: forbids network egress at the prompt layer. Daytona's
 *     network policy is a separate enforcement layer documented in
 *     `docs/sandbox-mode-system-design.md`, but stating the rule here
 *     stops the LLM from even attempting `curl example.com`, which would
 *     burn a step on a guaranteed failure.
 */
const SYSTEM_PROMPT_SANDBOX = [
  "You are a senior architect with read-only access to the attached project's live source tree via three tools: `read_file({ path })`, `list_dir({ path })`, and `run_shell({ command, workdir?, timeout_seconds? })`. Paths and workdirs are always relative to the repository root.",
  "When the user asks about specific files, modules, line ranges, or behavior, USE THE TOOLS to verify rather than guess from the artifact summaries. A short `list_dir` followed by a targeted `read_file` is almost always the right opening move; reach for `run_shell` when you need composition (`grep -rn`, `find -name`, `git log --oneline`, `wc -l`).",
  "Use `run_shell` for read-only inspection commands ONLY: `grep`, `find`, `git log`, `git diff`, `tree`, `wc`, `head`, `tail`, `cat`, `ls`. Do not modify files, install packages, or attempt network egress — the sandbox is read-only by policy and outbound network is unavailable. Destructive commands (`rm -rf /`, fork bombs, `mkfs`, `dd`, `sudo`, `shutdown`, piping `curl`/`wget` into a shell) are blocked at the tool layer and return `errorCode: 'command_blocked'` with a reason; do not retry the same shape, rephrase as a non-destructive read.",
  "`run_shell` returns a non-zero `exitCode` for commands that succeeded but found nothing (e.g. `grep` exits 1 with no matches). Treat that as data, not error — combine it with the textual output to decide your next step.",
  "Each tool returns either `{ ok: true, ... }` or `{ ok: false, errorCode, message }`. Treat error envelopes as ordinary information — surface the errorCode to the user when it is meaningful (e.g. `path_outside_repo`, `invalid_path`, `command_blocked`, `command_timeout`), and try a corrected path or command instead of repeating the same call.",
  "Cite every claim about the codebase as `[path/to/file.ts:line-line]` so the user can jump to the exact source you read. If you state something you did not verify with a tool, prefix it with `Unverified:`.",
  "Stay within the per-reply tool budget (you have at most 8 tool calls). When the budget is nearly spent, stop drilling and write the best answer you can with what you have.",
].join(" ");

/**
 * Three-mode restructure — Library Ask system prompt.
 *
 * Phase 1 ships the constant; Phase 2's `chat/context.ts` Ask branch is
 * what feeds it into the LLM. The contract:
 *
 *   - LLM is told it has NO live source access and NO tools. The
 *     generation action enforces this by passing `tools: undefined` for
 *     `mode === "ask"` (assertion in `generation.ts`).
 *   - Each retrieved chunk arrives as `[A1#section]`, `[A2#section]`,
 *     etc. The LLM cites every factual claim with the matching token, and
 *     the frontend turns the token into a deep-link to the artifact +
 *     heading.
 *   - When the user's question genuinely needs live source, the LLM emits
 *     a single-line structured handoff (`{"type":"lab_handoff_offer",
 *     ...}`) and stops. Phase 2's `chat/parsing.ts` parses that line and
 *     the frontend renders two buttons (Best-effort / Open in Lab). This
 *     keeps the cost-transparency invariant intact: Library Ask never
 *     silently spins up a sandbox.
 */
const SYSTEM_PROMPT_ASK = [
  "You answer questions about the design artifacts retrieved for this conversation.",
  "The user's question is augmented with the most relevant chunks from the workspace's artifact corpus, shown as `[A1#section]`, `[A2#section]`, … . Your sole source of truth is those retrieved chunks.",
  "You do NOT have access to live source code, the file system, or any tools. Cite every factual claim with the matching `[A#]` token. If a chunk does not contain enough information to answer, say so explicitly — do not extrapolate.",
  'If the user\'s question requires reading the live tree (specific file contents, line numbers, current code state, or verifying that an artifact still matches reality), STOP and respond with this exact structured JSON object on its own line, followed by a brief explanation:\n\n```{"type":"lab_handoff_offer","reason":"<one sentence>","suggestedLabPrompt":"<draft prompt>"}```\n\nThen wait for the user\'s choice. NEVER fabricate file paths, line numbers, or function signatures.',
].join(" ");

/**
 * Three-mode restructure — superset of `ChatMode` covering the new
 * persisted thread modes (`ask`, `lab`). The legacy `ChatMode` stays
 * narrow so the existing 3-arg resolver tests and the per-thread mode
 * selector keep their exhaustiveness; this superset is what the prompt
 * builder and the generation action read so they can serve every
 * thread-mode literal that may live in the database during the
 * transition.
 */
export type ExtendedChatMode = ChatMode | "ask" | "lab";

/**
 * Lookup keyed by `ExtendedChatMode` so adding a new mode literal forces
 * a compile error here (TypeScript exhaustiveness on `Record<Union, T>`
 * is stricter than on a `switch` statement, which only errors on
 * accidental fall-through if the function signature explicitly returns a
 * non-union type).
 *
 * Rules of the table:
 *   - `ask` returns the new chunk-cited prompt and is enforced tool-free
 *     by `generation.ts`.
 *   - `lab` reuses the existing sandbox prompt verbatim — Phase 1
 *     persists `lab` as a synonym for `sandbox`, and the prompt language
 *     is identical (Phase 3 narrows `sandbox` away).
 */
const SYSTEM_PROMPTS: Record<ExtendedChatMode, string> = {
  discuss: SYSTEM_PROMPT_DISCUSS,
  docs: SYSTEM_PROMPT_DOCS,
  sandbox: SYSTEM_PROMPT_SANDBOX,
  ask: SYSTEM_PROMPT_ASK,
  lab: SYSTEM_PROMPT_SANDBOX,
};

export function buildSystemPrompt(mode: ExtendedChatMode): string {
  return SYSTEM_PROMPTS[mode];
}

/**
 * Citation entry persisted on `messages.citationMap`. Plan 02: each entry maps
 * the `[A#]` token the model sees in the prompt back to the specific artifact
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
  if (context.mode === "ask") {
    return (context.artifactChunks ?? []).map((chunk, index) => ({
      index: index + 1,
      artifactId: chunk.artifactId,
      chunkId: chunk.chunkId,
      headingPath: chunk.headingPath,
    }));
  }
  return context.artifacts
    .slice(0, MAX_CONTEXT_ARTIFACTS)
    .map((artifact, index) => ({ index: index + 1, artifactId: artifact.id }));
}

export function buildUserPrompt(
  context: ReplyContext,
  question: string,
  relevantChunks: Array<{ path: string; summary: string; content: string }>,
) {
  if (context.mode === "ask") {
    const artifactChunkSection = (context.artifactChunks ?? [])
      .map((chunk, index) => {
        const sectionPath = chunk.headingPath.length > 0 ? chunk.headingPath.join(" › ") : "Overview";
        const citationToken = `[A${index + 1}#${slugSectionPath(chunk.headingPath)}]`;
        return `## ${citationToken} ${chunk.artifactTitle} › ${sectionPath}\n${chunk.content.slice(0, 1400)}`;
      })
      .join("\n\n");

    return [
      context.sourceRepoFullName ? `Repository: ${context.sourceRepoFullName}` : undefined,
      "Retrieved artifact chunks:",
      artifactChunkSection || "No artifact chunks were retrieved for this question.",
      "",
      `The user's question:\n${question}`,
      "",
      "Cite every factual claim with the matching [A#] token. If chunks are insufficient, say so.",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

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

function slugSectionPath(headingPath: string[]): string {
  if (headingPath.length === 0) {
    return "overview";
  }
  const slug = headingPath
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "section";
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
      "`OPENAI_API_KEY` is not configured, so I cannot run the live sandbox tools (`read_file` / `list_dir` / `run_shell`) needed to answer in Sandbox mode.",
      "",
      `Your question: ${question}`,
      "",
      "Switch to an artifact-grounded mode (Design Docs) for answers based on your existing analyses, or to General Chat for open-ended discussion. Configure `OPENAI_API_KEY` to re-enable Sandbox mode.",
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
        : "Not enough code snippets were selected; consider running a deep analysis first.",
    ],
  },
  zh: {
    sandbox: (question) => [
      "目前沒有設定 `OPENAI_API_KEY`，無法在 Sandbox 模式下呼叫 `read_file` / `list_dir` / `run_shell` 工具來實際讀取沙箱裡的程式碼。",
      "",
      `你的問題：${question}`,
      "",
      "請改用 Design Docs 模式以你的設計文件作答，或切到 General Chat 做一般討論。要恢復 Sandbox 模式，請設定 `OPENAI_API_KEY`。",
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

  // Three-mode restructure: `lab` is the new persisted literal that
  // replaces `sandbox`. The heuristic answer is identical (no API key →
  // no LLM tools → degrade to "set OPENAI_API_KEY to enable Lab").
  if (context.mode === "sandbox" || context.mode === "lab") {
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
