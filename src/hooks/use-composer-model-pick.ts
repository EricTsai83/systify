import { useCallback, useMemo, useState } from "react";
import { useDefaultModelPick, type DefaultModelPick } from "@/hooks/use-default-model-pick";
import type { LlmProvider, ModelPreferenceScope, ReasoningEffort, ThreadId, UserPickableCapability } from "@/lib/types";

export interface ComposerModelPickValue {
  provider: LlmProvider;
  modelName: string;
}

export interface ThreadScopedModelPick {
  threadId: ThreadId | null;
  provider: LlmProvider | null;
  modelName: string | null;
}

export interface ThreadScopedReasoningPick {
  threadId: ThreadId | null;
  effort: ReasoningEffort | null;
}

export interface ComposerModelPickResolution {
  selectedProvider: LlmProvider | null;
  selectedModelName: string | null;
}

export function resolveComposerModelPick(args: {
  threadId: ThreadId | null;
  explicitPick: ThreadScopedModelPick | null;
  defaultModelPick: DefaultModelPick | undefined;
  threadLockedProvider: LlmProvider | null;
  threadDefaultModelName: string | null;
}): ComposerModelPickResolution {
  const userPickedModel = args.explicitPick?.threadId === args.threadId ? args.explicitPick : null;
  return {
    selectedProvider: userPickedModel?.provider ?? args.defaultModelPick?.provider ?? args.threadLockedProvider ?? null,
    selectedModelName: userPickedModel?.modelName ?? args.defaultModelPick?.modelName ?? args.threadDefaultModelName,
  };
}

/**
 * Owns composer model-picker state for thread-based chat surfaces:
 * explicit thread-scoped picks, provider-lock fallback, default model
 * resolution, and per-message reasoning override.
 */
export function useComposerModelPick(args: {
  threadId: ThreadId | null;
  capability: UserPickableCapability;
  preferenceScope: ModelPreferenceScope;
  threadLockedProvider?: LlmProvider | null;
  threadDefaultModelName?: string | null;
}): {
  selectedProvider: LlmProvider | null;
  selectedModelName: string | null;
  selectedModel: ComposerModelPickValue | null;
  setSelectedModel: (next: ComposerModelPickValue) => void;
  selectedReasoningEffort: ReasoningEffort | null;
  setSelectedReasoningEffort: (next: ReasoningEffort | null) => void;
} {
  const threadLockedProvider = args.threadLockedProvider ?? null;
  const threadDefaultModelName = args.threadDefaultModelName ?? null;
  const [modelByThread, setModelByThread] = useState<Record<string, ThreadScopedModelPick>>({});
  const [reasoningByThread, setReasoningByThread] = useState<Record<string, ThreadScopedReasoningPick>>({});
  const threadKey = args.threadId ?? "__new_thread__";

  const defaultModelPick = useDefaultModelPick({
    capability: args.capability,
    preferenceScope: args.preferenceScope,
    threadLockedProvider,
    threadDefaultModelName,
  });

  const { selectedProvider, selectedModelName } = useMemo(
    () =>
      resolveComposerModelPick({
        threadId: args.threadId,
        explicitPick: modelByThread[threadKey] ?? null,
        defaultModelPick,
        threadLockedProvider,
        threadDefaultModelName,
      }),
    [args.threadId, defaultModelPick, modelByThread, threadDefaultModelName, threadKey, threadLockedProvider],
  );

  const selectedModel = useMemo<ComposerModelPickValue | null>(
    () => (selectedProvider && selectedModelName ? { provider: selectedProvider, modelName: selectedModelName } : null),
    [selectedModelName, selectedProvider],
  );

  const setSelectedModel = useCallback(
    (next: ComposerModelPickValue) => {
      setModelByThread((prev) => ({
        ...prev,
        [threadKey]: { threadId: args.threadId, provider: next.provider, modelName: next.modelName },
      }));
    },
    [args.threadId, threadKey],
  );

  const selectedReasoningEffort = reasoningByThread[threadKey]?.effort ?? null;
  const setSelectedReasoningEffort = useCallback(
    (next: ReasoningEffort | null) => {
      setReasoningByThread((prev) => ({
        ...prev,
        [threadKey]: { threadId: args.threadId, effort: next },
      }));
    },
    [args.threadId, threadKey],
  );

  return {
    selectedProvider,
    selectedModelName,
    selectedModel,
    setSelectedModel,
    selectedReasoningEffort,
    setSelectedReasoningEffort,
  };
}
