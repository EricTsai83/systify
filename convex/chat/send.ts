import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import { chatModeValidator } from "../lib/chatMode";
import { reasoningEffortValidator } from "../lib/llmCatalog";
import { llmProviderValidator } from "../lib/llmProvider";
import { startChatTurnInExistingThread, startChatTurnInNewThread } from "./chatTurnIntake";

export const sendMessageStartingNewThread = mutation({
  args: {
    /**
     * Repository this thread is bound to, or `undefined` for a repoless
     * thread (lives at `/chat/:threadId`). Library mode requires an
     * attached repository; Discuss is the only mode legal for a repoless
     * thread.
     */
    repositoryId: v.optional(v.id("repositories")),
    content: v.string(),
    mode: chatModeValidator,
    title: v.optional(v.string()),
    /**
     * Library Ask artifact scope used only for first-send creation. Existing
     * thread sends read the scope from the thread row.
     */
    artifactContext: v.optional(v.array(v.id("artifacts"))),
    /**
     * Discuss-only grounding flags. Ignored for `library` mode. Either
     * may be omitted; both default to `false`.
     */
    groundLibrary: v.optional(v.boolean()),
    groundSandbox: v.optional(v.boolean()),
    /**
     * Composer-picked `(provider, modelName)` pair. Both must be present
     * together to take effect; a half-set pair (provider but no model,
     * or vice versa) is rejected so the resolver never has to silently
     * fall back when the user thought they picked something.
     *
     * Validated against {@link MODEL_CATALOG} before any side-effect lands.
     * Once persisted, the assistant reply is attributed to this pair on
     * `messages.provider` / `messages.modelName`.
     */
    provider: v.optional(llmProviderValidator),
    modelName: v.optional(v.string()),
    /**
     * Per-message reasoning effort override. When set, overrides the
     * catalog entry's default for this message only.
     */
    reasoningEffort: v.optional(reasoningEffortValidator),
  },
  handler: async (ctx, args) => {
    return await startChatTurnInNewThread(ctx, args);
  },
});

export const sendMessage = mutation({
  args: {
    threadId: v.id("threads"),
    content: v.string(),
    mode: v.optional(chatModeValidator),
    /**
     * Discuss-only grounding flags (see `sendMessageStartingNewThread`).
     * Both default to `false` when omitted.
     */
    groundLibrary: v.optional(v.boolean()),
    groundSandbox: v.optional(v.boolean()),
    /**
     * Composer-picked `(provider, modelName)`. Both must be present
     * together. The mutation rejects:
     *
     *   - Half-set pairs (only one field provided).
     *   - Picks not in {@link MODEL_CATALOG}.
     *   - Picks whose provider differs from this thread's
     *     `lockedProvider` (`thread_provider_locked` ConvexError) — the
     *     frontend mirrors this constraint by hiding the locked-out
     *     provider's options in the picker.
     *
     * Switching model tier within the locked provider is always allowed.
     */
    provider: v.optional(llmProviderValidator),
    modelName: v.optional(v.string()),
    /**
     * Per-message reasoning effort override. When set, overrides the
     * catalog entry's default for this message only.
     */
    reasoningEffort: v.optional(reasoningEffortValidator),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ jobId: Id<"jobs">; userMessageId: Id<"messages">; assistantMessageId: Id<"messages"> }> => {
    return await startChatTurnInExistingThread(ctx, args);
  },
});
