import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { assertRepositoryModeEligible } from "../repositoryModeEligibility";
import { resolveDiscussGrounding, type ChatMode } from "../lib/chatMode";
import {
  isSupportedReasoningEffort,
  isUserPickableModel,
  listPickableModels,
  type ReasoningEffort,
} from "../lib/llmCatalog";
import type { LlmProvider } from "../lib/llmProvider";
import {
  applyModelPreferences,
  isModelEnabledInPreferences,
  type ModelPreferenceScope,
  type UserModelPreferences,
} from "../lib/userPreferences";
import { resolveModelForReply } from "./modelSelection";

export type ChatTurnModePlan = {
  repositoryId: Id<"repositories"> | null;
  mode: ChatMode;
  groundLibrary: boolean;
  groundSandbox: boolean;
  modelPreferenceScope: ModelPreferenceScope;
};

export type ChatTurnPlan = ChatTurnModePlan & {
  provider: LlmProvider;
  modelName: string;
  reasoningEffort?: ReasoningEffort;
};

type ModelPickerInput = {
  provider?: LlmProvider;
  modelName?: string;
  reasoningEffort?: ReasoningEffort;
};

type ThreadModelDefaults = {
  defaultModelName?: string;
  lockedProvider?: LlmProvider;
};

export const CHAT_MESSAGE_MAX_CHARS = 20_000;

export function trimChatMessageContent(content: string): string {
  const trimmedContent = content.trim();
  if (!trimmedContent) {
    throw new Error("Message content cannot be empty.");
  }
  if (trimmedContent.length > CHAT_MESSAGE_MAX_CHARS) {
    throw new Error(`Message content must be at most ${CHAT_MESSAGE_MAX_CHARS} characters.`);
  }
  return trimmedContent;
}

export function planChatTurnMode(args: {
  repositoryId: Id<"repositories"> | null;
  mode: ChatMode;
  requestedGrounding?: { groundLibrary?: boolean; groundSandbox?: boolean };
}): ChatTurnModePlan {
  const { groundLibrary, groundSandbox } = resolveDiscussGrounding(args.mode, args.requestedGrounding);
  return {
    repositoryId: args.repositoryId,
    mode: args.mode,
    groundLibrary,
    groundSandbox,
    modelPreferenceScope: pickModelPreferenceScope({
      repositoryId: args.repositoryId,
      mode: args.mode,
      groundSandbox,
    }),
  };
}

export async function assertChatTurnModeEligible(ctx: MutationCtx, plan: ChatTurnModePlan): Promise<void> {
  await assertRepositoryModeEligible(ctx, {
    repositoryId: plan.repositoryId,
    mode: plan.mode,
    groundLibrary: plan.groundLibrary,
    groundSandbox: plan.groundSandbox,
  });
}

export function completeChatTurnPlan(args: {
  modePlan: ChatTurnModePlan;
  modelPreferences: UserModelPreferences;
  picker: ModelPickerInput;
  threadDefaults?: ThreadModelDefaults;
}): ChatTurnPlan {
  assertCompletePickerPair(args.picker);
  assertPickerModelEnabled({
    picker: args.picker,
    modelPreferences: args.modelPreferences,
    modelPreferenceScope: args.modePlan.modelPreferenceScope,
  });

  const resolved = resolveModelForReply({
    mode: args.modePlan.mode,
    groundSandbox: args.modePlan.groundSandbox,
    overrideProvider: args.picker.provider,
    overrideModelName: args.picker.modelName,
    overrideReasoningEffort: args.picker.reasoningEffort,
    threadDefaultModelName: args.threadDefaults?.defaultModelName,
    lockedProvider: args.threadDefaults?.lockedProvider,
  });
  const modelChoice = ensureResolvedModelEnabled({
    provider: resolved.provider,
    modelName: resolved.modelName,
    reasoningEffort: resolved.reasoningEffort,
    modelPreferences: args.modelPreferences,
    modelPreferenceScope: args.modePlan.modelPreferenceScope,
    lockedProvider: args.threadDefaults?.lockedProvider,
  });
  assertSupportedReasoningEffortForResolvedPick(
    modelChoice.provider,
    modelChoice.modelName,
    args.picker.reasoningEffort,
  );
  assertThreadProviderLock(args.threadDefaults?.lockedProvider, modelChoice.provider);

  return {
    ...args.modePlan,
    provider: modelChoice.provider,
    modelName: modelChoice.modelName,
    ...(modelChoice.reasoningEffort !== undefined ? { reasoningEffort: modelChoice.reasoningEffort } : {}),
  };
}

function pickModelPreferenceScope(args: {
  repositoryId: Id<"repositories"> | null;
  mode: ChatMode;
  groundSandbox: boolean;
}): ModelPreferenceScope {
  if (args.groundSandbox) {
    return "sandbox";
  }
  if (args.repositoryId === null && args.mode === "discuss") {
    return "chat";
  }
  return args.mode;
}

/**
 * Reject the half-pair case where exactly one of `provider` / `modelName`
 * was supplied. We could silently ignore the orphaned field, but doing so
 * masks a real bug at the call site, usually the composer wired up one half
 * of the picker without the other. Failing loudly here keeps the contract
 * honest at the Interface.
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

function assertPickerModelEnabled(args: {
  picker: ModelPickerInput;
  modelPreferences: UserModelPreferences;
  modelPreferenceScope: ModelPreferenceScope;
}): void {
  if (args.picker.provider === undefined || args.picker.modelName === undefined) {
    return;
  }
  if (
    !isUserPickableModel(args.picker.provider, args.picker.modelName) ||
    !isModelEnabledInPreferences(
      args.modelPreferences,
      { provider: args.picker.provider, modelName: args.picker.modelName },
      args.modelPreferenceScope,
    )
  ) {
    throw new ConvexError({
      code: "unsupported_model",
      message: `Unsupported model selection: ${args.picker.provider}:${args.picker.modelName}.`,
    });
  }
}

function assertSupportedReasoningEffortForResolvedPick(
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

function ensureResolvedModelEnabled(args: {
  provider: LlmProvider;
  modelName: string;
  reasoningEffort: ReasoningEffort | undefined;
  modelPreferences: UserModelPreferences;
  modelPreferenceScope: ModelPreferenceScope;
  lockedProvider: LlmProvider | undefined;
}): {
  provider: LlmProvider;
  modelName: string;
  reasoningEffort: ReasoningEffort | undefined;
} {
  if (
    isModelEnabledInPreferences(
      args.modelPreferences,
      { provider: args.provider, modelName: args.modelName },
      args.modelPreferenceScope,
    )
  ) {
    return {
      provider: args.provider,
      modelName: args.modelName,
      reasoningEffort: args.reasoningEffort,
    };
  }

  const fallback = applyModelPreferences(
    listPickableModels({
      ...(args.lockedProvider !== undefined ? { provider: args.lockedProvider } : {}),
    }),
    args.modelPreferences,
    args.modelPreferenceScope,
  )[0];

  if (!fallback) {
    throw new ConvexError({
      code: "unsupported_model",
      message: "No enabled model is available for this chat surface.",
    });
  }

  return {
    provider: fallback.provider,
    modelName: fallback.modelName,
    reasoningEffort: fallback.reasoningEffort,
  };
}

function assertThreadProviderLock(lockedProvider: LlmProvider | undefined, resolvedProvider: LlmProvider): void {
  if (lockedProvider !== undefined && lockedProvider !== resolvedProvider) {
    throw new ConvexError({
      code: "thread_provider_locked",
      lockedProvider,
      attemptedProvider: resolvedProvider,
      message: `This thread is locked to ${lockedProvider}. Start a new chat to use ${resolvedProvider}.`,
    });
  }
}
