import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { assertRepositoryModeEligible } from "../repositoryModeEligibility";
import { requireViewerIdentity } from "../lib/auth";
import { chatModeValidator, resolveDiscussGrounding, type ChatMode } from "../lib/chatMode";
import { enqueueJob, findActiveJob } from "../lib/jobs";
import {
  isSupportedReasoningEffort,
  isUserPickableModel,
  reasoningEffortValidator,
  type ReasoningEffort,
} from "../lib/llmCatalog";
import { llmProviderValidator, type LlmProvider } from "../lib/llmProvider";
import { requireActiveRepositoryForViewer } from "../lib/repositoryAccess";
import { requireOwnedDoc } from "../lib/ownedDocs";
import { NEW_THREAD_DEFAULT_TITLE } from "../lib/threadDefaults";
import {
  CHAT_JOB_LEASE_MS,
  consumeChatGlobalRateLimit,
  consumeChatRateLimit,
  getLeaseRetryAfterMs,
  throwOperationAlreadyInProgress,
} from "../lib/rateLimit";
import { CHAT_REPLY_BUDGET_ESTIMATE_USD, reserveUserUsageBudget } from "../lib/userCost";
import { resolveModelForReply } from "./modelSelection";
import { recordThreadActivityInHistory, recordThreadCreatedInHistory } from "./historyState";
import { requireActiveOwnedThread } from "./threadAccess";

const ASK_THREAD_MAX_ARTIFACT_CONTEXT = 20;

async function getActiveChatJobForThread(ctx: MutationCtx, threadId: Id<"threads">, now: number) {
  return await findActiveJob(ctx, {
    kind: "chat",
    scope: { type: "thread", id: threadId },
    now,
  });
}

async function insertChatTurn(
  ctx: MutationCtx,
  args: {
    thread: Doc<"threads">;
    repository: Doc<"repositories"> | null;
    mode: ChatMode;
    /**
     * Discuss-mode grounding flags persisted on both the user and
     * assistant messages so the generation action can read them off
     * the queued user message. Unset on Library-mode turns.
     */
    groundLibrary?: boolean;
    groundSandbox?: boolean;
    /**
     * Resolved `(provider, modelName)` pair for this reply. Pinned on both
     * the user and the assistant message at insertion time so a later
     * picker change in the composer cannot retroactively re-attribute
     * an already-finished turn. The thread's `lockedProvider` /
     * `defaultModelName` patches happen alongside the message inserts.
     */
    provider: LlmProvider;
    modelName: string;
    /**
     * Per-message reasoning effort override resolved upstream. When
     * present, persisted on both message rows so the generation action
     * reads it off the assistant placeholder (mirroring the
     * provider / modelName / grounding pattern). `undefined` falls
     * through to the catalog entry's default at gateway time.
     */
    reasoningEffort?: ReasoningEffort;
    trimmedContent: string;
    ownerTokenIdentifier: string;
    now: number;
    sandboxSessionId?: Id<"sandboxSessions">;
  },
): Promise<{ jobId: Id<"jobs">; userMessageId: Id<"messages">; assistantMessageId: Id<"messages"> }> {
  // Sandbox-grounded Discuss replies use tool calls and the heavier model
  // tier, so they bill against the `system_design` budget line and the
  // daily sandbox cost cap rather than the chat budget.
  const jobId = await enqueueJob(ctx, {
    kind: "chat",
    threadId: args.thread._id,
    repositoryId: args.thread.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    sandboxId: args.repository?.latestSandboxId,
    costCategory: args.groundSandbox ? "system_design" : "chat",
    triggerSource: "user",
    leaseMs: CHAT_JOB_LEASE_MS,
  });

  const userMessageId = await ctx.db.insert("messages", {
    repositoryId: args.thread.repositoryId,
    threadId: args.thread._id,
    jobId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    role: "user",
    status: "completed",
    mode: args.mode,
    content: args.trimmedContent,
    // Persist grounding flags only when truthy; an unset field reads as
    // "false" on the generation path, so storing `false` would just waste
    // doc bytes on every legacy-equivalent turn.
    ...(args.groundLibrary === true ? { groundLibrary: true } : {}),
    ...(args.groundSandbox === true ? { groundSandbox: true } : {}),
    provider: args.provider,
    modelName: args.modelName,
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
  });

  const assistantMessageId = await ctx.db.insert("messages", {
    repositoryId: args.thread.repositoryId,
    threadId: args.thread._id,
    jobId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    role: "assistant",
    status: "pending",
    mode: args.mode,
    content: "",
    ...(args.groundLibrary === true ? { groundLibrary: true } : {}),
    ...(args.groundSandbox === true ? { groundSandbox: true } : {}),
    provider: args.provider,
    modelName: args.modelName,
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
  });

  await ctx.db.insert("messageStreams", {
    repositoryId: args.thread.repositoryId,
    threadId: args.thread._id,
    jobId,
    assistantMessageId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    compactedContent: "",
    compactedThroughSequence: -1,
    nextSequence: 0,
    startedAt: args.now,
    lastAppendedAt: args.now,
  });

  // Update thread defaults so the composer pre-fills the toggles with the
  // user's most recent preference on the next visit. Library-mode turns
  // skip the grounding defaults — those are a Discuss-only concept — but
  // the model picker default is set on every send regardless of mode.
  const threadPatch: {
    mode: ChatMode;
    lastMessageAt: number;
    sandboxSessionId?: Id<"sandboxSessions">;
    defaultGroundLibrary?: boolean;
    defaultGroundSandbox?: boolean;
    lockedProvider?: LlmProvider;
    defaultModelName?: string;
  } = {
    mode: args.mode,
    lastMessageAt: args.now,
    ...(args.sandboxSessionId !== undefined && { sandboxSessionId: args.sandboxSessionId }),
  };
  if (args.mode === "discuss") {
    threadPatch.defaultGroundLibrary = args.groundLibrary === true;
    threadPatch.defaultGroundSandbox = args.groundSandbox === true;
  }
  // First message in the thread locks the provider; thereafter
  // `sendMessage` rejects mismatched picks before reaching this helper
  // so the patch is a no-op on subsequent turns.
  if (args.thread.lockedProvider === undefined) {
    threadPatch.lockedProvider = args.provider;
  }
  // Always refresh `defaultModelName` so reopening the thread restores
  // the user's last pick within the locked provider.
  threadPatch.defaultModelName = args.modelName;
  await ctx.db.patch(args.thread._id, threadPatch);
  const updatedThread = await ctx.db.get(args.thread._id);
  if (updatedThread) {
    await recordThreadActivityInHistory(ctx, updatedThread);
  }

  await reserveUserUsageBudget(ctx, {
    sourceId: `message:${assistantMessageId}`,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    feature: "chat",
    estimatedCostUsd: CHAT_REPLY_BUDGET_ESTIMATE_USD,
    occurredAtMs: args.now,
  });

  await ctx.scheduler.runAfter(0, internal.chat.generation.generateAssistantReply, {
    threadId: args.thread._id,
    userMessageId,
    assistantMessageId,
    jobId,
  });

  // Fire-and-forget title autogen on the first user message of a thread.
  // The Vercel-AI-Chatbot pattern: a parallel scheduler tick runs the
  // (cheap) summary LLM call without blocking the assistant streaming
  // path, then patches the thread row only if the title is still the
  // default literal. `lastAssistantMessageAt === undefined` is the cheapest
  // "first message" probe — it flips to a number the moment the assistant
  // streaming path lands a delta, so subsequent user messages never
  // re-trigger autogen.
  if (args.thread.lastAssistantMessageAt === undefined) {
    await ctx.scheduler.runAfter(0, internal.chat.titlesNode.generateThreadTitle, {
      threadId: args.thread._id,
      userMessageId,
    });
  }

  return { jobId, userMessageId, assistantMessageId };
}

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
    const identity = await requireViewerIdentity(ctx);
    const repositoryId = args.repositoryId;

    const trimmedContent = args.content.trim();
    if (!trimmedContent) {
      throw new Error("Message content cannot be empty.");
    }

    let repository: Doc<"repositories"> | null = null;
    if (repositoryId) {
      const result = await requireActiveRepositoryForViewer(ctx, {
        repositoryId,
        notFoundMessage: "Repository not found.",
        archivedMessage: "This repository is archived. Restore it to continue chatting.",
      });
      repository = result.repository;
    }

    const artifactContext = args.artifactContext ?? [];
    if (artifactContext.length > 0 && args.mode !== "library") {
      throw new Error("Artifact scope is only supported for Library Ask threads.");
    }
    if (artifactContext.length > 0 && !repositoryId) {
      throw new Error("Artifact scope requires an attached repository.");
    }
    if (artifactContext.length > ASK_THREAD_MAX_ARTIFACT_CONTEXT) {
      throw new Error(
        `Library Ask scope filter accepts at most ${ASK_THREAD_MAX_ARTIFACT_CONTEXT} artifacts (got ${artifactContext.length}).`,
      );
    }
    for (const artifactId of artifactContext) {
      const { doc: artifact } = await requireOwnedDoc(ctx, artifactId, {
        notFoundMessage: "Artifact not found.",
      });
      if (artifact.repositoryId !== repositoryId) {
        throw new Error("Artifact is not in this repository.");
      }
    }

    await assertRepositoryModeEligible(ctx, {
      repositoryId,
      mode: args.mode,
      groundLibrary: args.groundLibrary === true,
      groundSandbox: args.groundSandbox === true,
    });

    const groundLibrary = args.groundLibrary === true;
    const groundSandbox = args.groundSandbox === true;

    // Validate the picker pick (if both pieces present) and resolve the
    // effective `(provider, modelName)` for this reply. A brand-new
    // thread has no `lockedProvider` yet — the resolved pick becomes the
    // lock once `insertChatTurn` patches the thread row below. A half-set
    // pair is rejected up front so the resolver never has to distinguish
    // "intentional half-pick" from "missing arg".
    assertCompletePickerPair(args);
    if (
      args.provider !== undefined &&
      args.modelName !== undefined &&
      !isUserPickableModel(args.provider, args.modelName)
    ) {
      throw new ConvexError({
        code: "unsupported_model",
        message: `Unsupported model selection: ${args.provider}:${args.modelName}.`,
      });
    }
    const resolved = resolveModelForReply({
      mode: args.mode,
      groundSandbox,
      overrideProvider: args.provider,
      overrideModelName: args.modelName,
      overrideReasoningEffort: args.reasoningEffort,
    });
    assertSupportedReasoningEffort(resolved.provider, resolved.modelName, args.reasoningEffort);

    const now = Date.now();

    await consumeChatRateLimit(ctx, identity.tokenIdentifier);
    await consumeChatGlobalRateLimit(ctx);

    const title = args.title ?? NEW_THREAD_DEFAULT_TITLE;

    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      title,
      mode: args.mode,
      lastMessageAt: now,
      ...(args.mode === "library" && artifactContext.length > 0 ? { artifactContext } : {}),
      ...(args.mode === "discuss"
        ? {
            defaultGroundLibrary: groundLibrary,
            defaultGroundSandbox: groundSandbox,
          }
        : {}),
    });

    const thread = (await ctx.db.get(threadId))!;
    await recordThreadCreatedInHistory(ctx, thread);

    let sandboxSessionId: Id<"sandboxSessions"> | undefined;
    if (groundSandbox) {
      sandboxSessionId = await ctx.runMutation(internal.sandboxSessions.ensureSandboxSessionForThread, {
        threadId,
      });
    }

    const { jobId, userMessageId, assistantMessageId } = await insertChatTurn(ctx, {
      thread,
      repository,
      mode: args.mode,
      groundLibrary,
      groundSandbox,
      provider: resolved.provider,
      modelName: resolved.modelName,
      reasoningEffort: resolved.reasoningEffort,
      trimmedContent,
      ownerTokenIdentifier: identity.tokenIdentifier,
      now,
      sandboxSessionId,
    });

    return {
      threadId,
      jobId,
      userMessageId,
      assistantMessageId,
      mode: args.mode,
    };
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
    const { identity, doc: thread } = await requireActiveOwnedThread(ctx, args.threadId, {
      notFoundMessage: "Thread not found.",
    });

    let repository: Doc<"repositories"> | null = null;
    if (thread.repositoryId) {
      const result = await requireActiveRepositoryForViewer(ctx, {
        repositoryId: thread.repositoryId,
        notFoundMessage: "Thread not found.",
        archivedMessage: "This repository is archived. Restore it to continue chatting.",
      });
      repository = result.repository;
    }

    const mode = args.mode ?? thread.mode;
    // Library grounding makes no sense in Library Mode (it's the same
    // thing); Sandbox grounding only applies in Discuss. The resolver
    // coerces both to false on Library-mode turns so a stale composer
    // toggle does not accidentally tag a Library reply with grounding
    // metadata. Same rule used by `getReplyContext` on the read path.
    const { groundLibrary, groundSandbox } = resolveDiscussGrounding(mode, args);

    // `assertRepositoryModeEligible` covers the unsatisfiable-grounding case
    // (`no_repository_attached`) with the same structured ConvexError it
    // uses for the read path, so we don't need a separate plain-Error
    // pre-check here.
    await assertRepositoryModeEligible(ctx, {
      repositoryId: thread.repositoryId,
      mode,
      groundLibrary,
      groundSandbox,
    });

    // Validate the picker pair (catalog membership + half-pair shape)
    // BEFORE resolving so the resolver only ever sees a clean override.
    assertCompletePickerPair(args);
    if (
      args.provider !== undefined &&
      args.modelName !== undefined &&
      !isUserPickableModel(args.provider, args.modelName)
    ) {
      throw new ConvexError({
        code: "unsupported_model",
        message: `Unsupported model selection: ${args.provider}:${args.modelName}.`,
      });
    }

    // Resolve the effective `(provider, modelName)` pair using the
    // override → thread default → capability default cascade. The
    // resolved provider is what we enforce the lock against — picking a
    // non-locked-provider model returns the failed pick verbatim so the
    // error message is precise. The capability-default layer also gets the
    // lock so a thread whose persisted `defaultModelName` drifted out of
    // the catalog still falls back to its own provider's tier instead of
    // the global openai default.
    const resolved = resolveModelForReply({
      mode,
      groundSandbox,
      overrideProvider: args.provider,
      overrideModelName: args.modelName,
      overrideReasoningEffort: args.reasoningEffort,
      threadDefaultModelName: thread.defaultModelName,
      lockedProvider: thread.lockedProvider,
    });
    assertSupportedReasoningEffort(resolved.provider, resolved.modelName, args.reasoningEffort);

    if (thread.lockedProvider !== undefined && thread.lockedProvider !== resolved.provider) {
      throw new ConvexError({
        code: "thread_provider_locked",
        lockedProvider: thread.lockedProvider,
        attemptedProvider: resolved.provider,
        message: `This thread is locked to ${thread.lockedProvider}. Start a new chat to use ${resolved.provider}.`,
      });
    }

    const trimmedContent = args.content.trim();
    if (!trimmedContent) {
      throw new Error("Message content cannot be empty.");
    }

    const now = Date.now();
    const activeJob = await getActiveChatJobForThread(ctx, args.threadId, now);

    if (activeJob) {
      throwOperationAlreadyInProgress(
        "threadChatInFlight",
        "An assistant reply is already in progress for this thread.",
        getLeaseRetryAfterMs(activeJob.leaseExpiresAt, now),
      );
    }

    await consumeChatRateLimit(ctx, identity.tokenIdentifier);
    await consumeChatGlobalRateLimit(ctx);

    let sandboxSessionId: Id<"sandboxSessions"> | undefined;
    if (groundSandbox) {
      sandboxSessionId = await ctx.runMutation(internal.sandboxSessions.ensureSandboxSessionForThread, {
        threadId: args.threadId,
      });
    }

    return await insertChatTurn(ctx, {
      thread,
      repository,
      mode,
      groundLibrary,
      groundSandbox,
      provider: resolved.provider,
      modelName: resolved.modelName,
      reasoningEffort: resolved.reasoningEffort,
      trimmedContent,
      ownerTokenIdentifier: identity.tokenIdentifier,
      now,
      sandboxSessionId,
    });
  },
});

/**
 * Reject the half-pair case where exactly one of `provider` / `modelName`
 * was supplied. We could silently ignore the orphaned field, but doing
 * so masks a real bug at the call site — usually the composer wired up
 * one half of the picker without the other. Failing loudly here keeps
 * the contract honest at the API boundary.
 */
function assertCompletePickerPair(args: { provider?: LlmProvider; modelName?: string }): void {
  const hasProvider = args.provider !== undefined;
  const hasModelName = args.modelName !== undefined;
  if (hasProvider !== hasModelName) {
    throw new ConvexError({
      code: "incomplete_model_pick",
      message: "Both provider and modelName must be supplied together, or both omitted.",
    });
  }
}

function assertSupportedReasoningEffort(
  provider: LlmProvider,
  modelName: string,
  reasoningEffort: ReasoningEffort | undefined,
): void {
  if (!isSupportedReasoningEffort(provider, modelName, reasoningEffort)) {
    throw new ConvexError({
      code: "unsupported_reasoning_effort",
      message: `Unsupported reasoning effort "${reasoningEffort}" for ${provider}:${modelName}.`,
    });
  }
}
