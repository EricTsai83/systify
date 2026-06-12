import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { requireViewerIdentity } from "../lib/auth";
import type { ChatMode } from "../lib/chatMode";
import { assertFeatureAccess, requiresHighReasoningAccess, requiresPremiumModelAccess } from "../lib/entitlements";
import { enqueueJob, findActiveJob } from "../lib/jobs";
import type { ReasoningEffort } from "../lib/llmCatalog";
import type { LlmProvider } from "../lib/llmProvider";
import { requireOwnedDoc } from "../lib/ownedDocs";
import {
  CHAT_JOB_LEASE_MS,
  assertSandboxDailyCostBudget,
  consumeChatGlobalRateLimit,
  consumeChatRateLimit,
  consumeDaytonaGlobalRateLimit,
  getSandboxReplyEstimateCents,
  getLeaseRetryAfterMs,
  throwOperationAlreadyInProgress,
} from "../lib/rateLimit";
import { requireActiveRepositoryForViewer } from "../lib/repositoryAccess";
import { NEW_THREAD_DEFAULT_TITLE } from "../lib/threadDefaults";
import { CHAT_REPLY_BUDGET_ESTIMATE_USD, reserveUserUsageBudget } from "../lib/userCost";
import { loadViewerModelPreferences } from "../lib/userPreferences";
import { recordThreadActivityInHistory, recordThreadCreatedInHistory } from "./historyState";
import { requireActiveOwnedThread } from "./threadAccess";
import { drainThreadMessageArtifacts, normalizeAgentProfile } from "./threads";
import {
  assertChatTurnModeEligible,
  completeChatTurnPlan,
  planChatTurnMode,
  trimChatMessageContent,
} from "./sendPlanning";

const ASK_THREAD_MAX_ARTIFACT_CONTEXT = 20;

type ViewerIdentity = {
  tokenIdentifier: string;
  email?: string | null;
};

type ModelPickerInput = {
  provider?: LlmProvider;
  modelName?: string;
  reasoningEffort?: ReasoningEffort;
};

type GroundingInput = {
  groundLibrary?: boolean;
  groundSandbox?: boolean;
};

type StartThreadInput = ModelPickerInput &
  GroundingInput & {
    repositoryId?: Id<"repositories">;
    content: string;
    mode: ChatMode;
    title?: string;
    artifactContext?: Id<"artifacts">[];
    singleTurnEnabled?: boolean;
    agentRole?: string;
    agentInstructions?: string;
  };

type ExistingThreadInput = ModelPickerInput &
  GroundingInput & {
    threadId: Id<"threads">;
    content: string;
    mode?: ChatMode;
  };

type QueuedChatTurn = {
  jobId: Id<"jobs">;
  userMessageId: Id<"messages">;
  assistantMessageId: Id<"messages">;
};

export type ExistingThreadChatTurnResult =
  | QueuedChatTurn
  | {
      status: "singleTurnResetPending";
      message: string;
    };

type StartedChatTurn = QueuedChatTurn & {
  threadId: Id<"threads">;
  mode: ChatMode;
};

async function assertChatTurnFeatureAccess(
  ctx: MutationCtx,
  identity: ViewerIdentity,
  turnPlan: {
    mode: ChatMode;
    groundSandbox: boolean;
    provider: LlmProvider;
    modelName: string;
    reasoningEffort?: ReasoningEffort;
  },
) {
  await assertFeatureAccess(ctx, identity, turnPlan.mode === "library" ? "libraryAsk" : "chatSend");
  if (turnPlan.groundSandbox) {
    await assertFeatureAccess(ctx, identity, "sandboxGrounding");
  }
  if (requiresPremiumModelAccess(turnPlan.provider, turnPlan.modelName)) {
    await assertFeatureAccess(ctx, identity, "premiumModels");
  }
  if (requiresHighReasoningAccess(turnPlan.reasoningEffort)) {
    await assertFeatureAccess(ctx, identity, "highReasoning");
  }
}

async function getActiveChatJobForThread(ctx: MutationCtx, threadId: Id<"threads">, now: number) {
  return await findActiveJob(ctx, {
    kind: "chat",
    scope: { type: "thread", id: threadId },
    now,
  });
}

async function assertLibraryAskArtifactContext(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories"> | undefined;
    mode: ChatMode;
    artifactContext: Id<"artifacts">[];
  },
): Promise<void> {
  if (args.artifactContext.length > 0 && args.mode !== "library") {
    throw new Error("Artifact scope is only supported for Library Ask threads.");
  }
  if (args.artifactContext.length > 0 && args.repositoryId === undefined) {
    throw new Error("Artifact scope requires an attached repository.");
  }
  if (args.artifactContext.length > ASK_THREAD_MAX_ARTIFACT_CONTEXT) {
    throw new Error(
      `Library Ask scope filter accepts at most ${ASK_THREAD_MAX_ARTIFACT_CONTEXT} artifacts (got ${args.artifactContext.length}).`,
    );
  }
  for (const artifactId of args.artifactContext) {
    const { doc: artifact } = await requireOwnedDoc(ctx, artifactId, {
      notFoundMessage: "Artifact not found.",
    });
    if (artifact.repositoryId !== args.repositoryId) {
      throw new Error("Artifact is not in this repository.");
    }
  }
}

async function assertChatTurnBudgetsAndRateLimits(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories"> | null;
    groundSandbox: boolean;
  },
): Promise<void> {
  if (args.groundSandbox) {
    await assertSandboxDailyCostBudget(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      estimateCents: getSandboxReplyEstimateCents(),
    });
  }
  await consumeChatRateLimit(ctx, args.ownerTokenIdentifier);
  await consumeChatGlobalRateLimit(ctx);
  if (args.groundSandbox) {
    await consumeDaytonaGlobalRateLimit(ctx);
  }
}

async function ensureSandboxSessionForTurn(
  ctx: MutationCtx,
  args: {
    threadId: Id<"threads">;
    groundSandbox: boolean;
  },
): Promise<Id<"sandboxSessions"> | undefined> {
  if (!args.groundSandbox) {
    return undefined;
  }
  return await ctx.runMutation(internal.sandboxSessions.ensureSandboxSessionForThread, {
    threadId: args.threadId,
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
): Promise<QueuedChatTurn> {
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
  if (args.thread.lockedProvider === undefined) {
    threadPatch.lockedProvider = args.provider;
  }
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

  if (args.thread.lastAssistantMessageAt === undefined) {
    await ctx.scheduler.runAfter(0, internal.chat.titlesNode.generateThreadTitle, {
      threadId: args.thread._id,
      userMessageId,
    });
  }

  return { jobId, userMessageId, assistantMessageId };
}

export async function startChatTurnInNewThread(ctx: MutationCtx, args: StartThreadInput): Promise<StartedChatTurn> {
  const identity = await requireViewerIdentity(ctx);
  const modelPreferences = await loadViewerModelPreferences(ctx, identity.tokenIdentifier);
  const repositoryId = args.repositoryId;
  const trimmedContent = trimChatMessageContent(args.content);
  const singleTurnEnabled = args.singleTurnEnabled === true;
  const hasAgentProfileArgs =
    args.singleTurnEnabled !== undefined || args.agentRole !== undefined || args.agentInstructions !== undefined;
  if (repositoryId !== undefined && hasAgentProfileArgs) {
    throw new Error("Single-turn Agent Profile is only supported for repoless chat threads.");
  }
  const agentProfile = normalizeAgentProfile({
    agentRole: args.agentRole,
    agentInstructions: args.agentInstructions,
  });

  let repository: Doc<"repositories"> | null = null;
  if (repositoryId) {
    const result = await requireActiveRepositoryForViewer(ctx, {
      repositoryId,
      notFoundMessage: "Repository not found.",
      archivedMessage: "This repository is archived. Restore it to continue chatting.",
    });
    repository = result.repository;
  }

  const modePlan = planChatTurnMode({
    repositoryId: repositoryId ?? null,
    mode: args.mode,
    requestedGrounding: args,
  });
  const artifactContext = args.artifactContext ?? [];
  await assertLibraryAskArtifactContext(ctx, {
    repositoryId,
    mode: modePlan.mode,
    artifactContext,
  });
  await assertChatTurnModeEligible(ctx, modePlan);

  const turnPlan = completeChatTurnPlan({
    modePlan,
    modelPreferences,
    picker: args,
  });
  await assertChatTurnFeatureAccess(ctx, identity, turnPlan);

  const now = Date.now();
  await assertChatTurnBudgetsAndRateLimits(ctx, {
    ownerTokenIdentifier: identity.tokenIdentifier,
    repositoryId: turnPlan.repositoryId,
    groundSandbox: turnPlan.groundSandbox,
  });

  const title =
    repositoryId === undefined && agentProfile.agentRole !== undefined ? agentProfile.agentRole : args.title;

  const threadId = await ctx.db.insert("threads", {
    repositoryId,
    ownerTokenIdentifier: identity.tokenIdentifier,
    title: title ?? NEW_THREAD_DEFAULT_TITLE,
    mode: turnPlan.mode,
    lastMessageAt: now,
    ...(repositoryId === undefined
      ? {
          singleTurnEnabled,
          agentRole: agentProfile.agentRole,
          agentInstructions: agentProfile.agentInstructions,
          ...(agentProfile.agentRole !== undefined || agentProfile.agentInstructions !== undefined
            ? { agentUpdatedAt: now }
            : {}),
        }
      : {}),
    ...(turnPlan.mode === "library" && artifactContext.length > 0 ? { artifactContext } : {}),
    ...(turnPlan.mode === "discuss"
      ? {
          defaultGroundLibrary: turnPlan.groundLibrary,
          defaultGroundSandbox: turnPlan.groundSandbox,
        }
      : {}),
  });

  const thread = (await ctx.db.get(threadId))!;
  await recordThreadCreatedInHistory(ctx, thread);
  const sandboxSessionId = await ensureSandboxSessionForTurn(ctx, {
    threadId,
    groundSandbox: turnPlan.groundSandbox,
  });

  const queuedTurn = await insertChatTurn(ctx, {
    thread,
    repository,
    mode: turnPlan.mode,
    groundLibrary: turnPlan.groundLibrary,
    groundSandbox: turnPlan.groundSandbox,
    provider: turnPlan.provider,
    modelName: turnPlan.modelName,
    reasoningEffort: turnPlan.reasoningEffort,
    trimmedContent,
    ownerTokenIdentifier: identity.tokenIdentifier,
    now,
    sandboxSessionId,
  });

  return {
    threadId,
    ...queuedTurn,
    mode: turnPlan.mode,
  };
}

export async function startChatTurnInExistingThread(
  ctx: MutationCtx,
  args: ExistingThreadInput,
): Promise<ExistingThreadChatTurnResult> {
  const { identity, doc: thread } = await requireActiveOwnedThread(ctx, args.threadId, {
    notFoundMessage: "Thread not found.",
  });
  const modelPreferences = await loadViewerModelPreferences(ctx, identity.tokenIdentifier);

  let repository: Doc<"repositories"> | null = null;
  if (thread.repositoryId) {
    const result = await requireActiveRepositoryForViewer(ctx, {
      repositoryId: thread.repositoryId,
      notFoundMessage: "Thread not found.",
      archivedMessage: "This repository is archived. Restore it to continue chatting.",
    });
    repository = result.repository;
  }

  const modePlan = planChatTurnMode({
    repositoryId: thread.repositoryId ?? null,
    mode: args.mode ?? thread.mode,
    requestedGrounding: args,
  });
  await assertChatTurnModeEligible(ctx, modePlan);

  const turnPlan = completeChatTurnPlan({
    modePlan,
    modelPreferences,
    picker: args,
    threadDefaults: {
      defaultModelName: thread.defaultModelName,
      lockedProvider: thread.lockedProvider,
    },
  });
  await assertChatTurnFeatureAccess(ctx, identity, turnPlan);

  const trimmedContent = trimChatMessageContent(args.content);
  const now = Date.now();
  const activeJob = await getActiveChatJobForThread(ctx, args.threadId, now);
  if (activeJob) {
    throwOperationAlreadyInProgress(
      "threadChatInFlight",
      "An assistant reply is already in progress for this thread.",
      getLeaseRetryAfterMs(activeJob.leaseExpiresAt, now),
    );
  }
  if (thread.singleTurnEnabled === true) {
    if (thread.repositoryId !== undefined) {
      throw new Error("Single-turn is only supported for repoless chat threads.");
    }
    if (thread.singleTurnResetPending === true) {
      throw new Error("Previous messages are still being cleared for this single-turn thread.");
    }
    const result = await drainThreadMessageArtifacts(ctx, {
      threadId: args.threadId,
      maxMessages: 500,
      maxStreams: 500,
    });
    if (result.messagesRemain || result.streamsRemain || result.streamBudgetExhausted) {
      await ctx.db.patch(args.threadId, { singleTurnResetPending: true });
      await ctx.scheduler.runAfter(0, internal.chat.threads.continueRepolessSingleTurnReset, {
        threadId: args.threadId,
      });
      return {
        status: "singleTurnResetPending",
        message: "Previous messages are being cleared in background; try again later.",
      };
    }
    await ctx.db.patch(args.threadId, { lastAssistantMessageAt: undefined });
  }

  await assertChatTurnBudgetsAndRateLimits(ctx, {
    ownerTokenIdentifier: identity.tokenIdentifier,
    repositoryId: turnPlan.repositoryId,
    groundSandbox: turnPlan.groundSandbox,
  });
  const sandboxSessionId = await ensureSandboxSessionForTurn(ctx, {
    threadId: args.threadId,
    groundSandbox: turnPlan.groundSandbox,
  });

  return await insertChatTurn(ctx, {
    thread,
    repository,
    mode: turnPlan.mode,
    groundLibrary: turnPlan.groundLibrary,
    groundSandbox: turnPlan.groundSandbox,
    provider: turnPlan.provider,
    modelName: turnPlan.modelName,
    reasoningEffort: turnPlan.reasoningEffort,
    trimmedContent,
    ownerTokenIdentifier: identity.tokenIdentifier,
    now,
    sandboxSessionId,
  });
}
