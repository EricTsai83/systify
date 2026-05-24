import { v, type Infer } from "convex/values";

/**
 * Canonical chat-mode vocabulary, shared by the persisted DB enum
 * (`threads.mode`, `messages.mode`, `workspaces.lastMode`) and the workspace
 * shell's URL router (`/w/:wid/discuss | library | lab`). Defining it once
 * keeps DB literals, URL segments, and UI labels in lockstep — adding a new
 * mode is a single-place edit.
 *
 *   - `discuss` — LLM training only; no repo, no sandbox. Pre-design talk.
 *   - `library` — read-mostly artifact reader with chunk-retrieval RAG over
 *                 the workspace's artifacts (Library Ask).
 *   - `lab`     — sandbox-backed mode. Live filesystem + execution in a
 *                 Daytona sandbox; the canonical source of truth for the
 *                 current code state.
 */
export const chatModeValidator = v.union(v.literal("discuss"), v.literal("library"), v.literal("lab"));

/**
 * TS twin of {@link chatModeValidator}. Use this everywhere a mode literal
 * is expected so adding a new mode to the validator surfaces downstream as
 * a compile error rather than a silent stale literal.
 */
export type ChatMode = Infer<typeof chatModeValidator>;
