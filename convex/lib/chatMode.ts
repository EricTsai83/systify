import { v, type Infer } from "convex/values";

/**
 * Canonical chat-mode vocabulary, shared by the persisted DB enum
 * (`threads.mode`, `messages.mode`, `workspaces.lastMode`) and the workspace
 * shell's URL router (`/w/:wid/discuss | library`). Defining it once keeps
 * DB literals, URL segments, and UI labels in lockstep.
 *
 *   - `discuss` — free-form chat with per-message Library / Sandbox
 *                 grounding toggles (see `messages.groundLibrary` /
 *                 `messages.groundSandbox`). Both off → training-only.
 *   - `library` — read-mostly artifact reader with chunk-retrieval RAG
 *                 over the workspace's artifacts (Library Ask).
 */
export const chatModeValidator = v.union(v.literal("discuss"), v.literal("library"));

/**
 * TS twin of {@link chatModeValidator}. Use this everywhere a mode literal
 * is expected so adding a new mode to the validator surfaces downstream as
 * a compile error rather than a silent stale literal.
 */
export type ChatMode = Infer<typeof chatModeValidator>;
