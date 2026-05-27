import { v, type Infer } from "convex/values";

/**
 * Canonical chat-mode vocabulary, shared by the persisted DB enum
 * (`threads.mode`, `messages.mode`, `repositories.lastMode`) and the
 * repository shell's URL router (`/r/:rid/discuss | library`). Defining
 * it once keeps DB literals, URL segments, and UI labels in lockstep.
 *
 *   - `discuss` — free-form chat with per-message Library / Sandbox
 *                 grounding toggles (see `messages.groundLibrary` /
 *                 `messages.groundSandbox`). Both off → training-only.
 *   - `library` — read-mostly artifact reader with chunk-retrieval RAG
 *                 over the repository's artifacts (Library Ask).
 */
export const chatModeValidator = v.union(v.literal("discuss"), v.literal("library"));

/**
 * TS twin of {@link chatModeValidator}. Use this everywhere a mode literal
 * is expected so adding a new mode to the validator surfaces downstream as
 * a compile error rather than a silent stale literal.
 */
export type ChatMode = Infer<typeof chatModeValidator>;

/**
 * Default mode for a thread whose URL did not pin one. Lives alongside the
 * `ChatMode` type so callers that just need the default-mode rule
 * (`repositories.ts`, `chat/threads.ts`, frontend hooks) can import it
 * without pulling in the full resolver. The eligibility resolvers in
 * `lib/chatEligibility.ts` consume it too — they share the same source of
 * truth for "what does the URL land on when the user opens this
 * repository?".
 */
export function getDefaultThreadMode(hasAttachedRepo: boolean): ChatMode {
  return hasAttachedRepo ? "library" : "discuss";
}
