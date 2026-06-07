import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { LlmProvider, ModelPreferenceScope, PickableModelEntry, ReasoningEffort } from "@/lib/types";

type ModelPick = {
  provider: LlmProvider;
  modelName: string;
};

const MODEL_ACCESS_LOADING_REASON = "Loading model access...";

export function useModelAccessDisabledReason({
  modelPick,
  reasoningEffort,
  preferenceScope,
  premiumModelsDisabledReason,
  highReasoningDisabledReason,
}: {
  modelPick: ModelPick | null | undefined;
  reasoningEffort: ReasoningEffort | null | undefined;
  preferenceScope: ModelPreferenceScope;
  premiumModelsDisabledReason?: string;
  highReasoningDisabledReason?: string;
}): string | null {
  const shouldCheckPremiumModel =
    premiumModelsDisabledReason !== undefined && modelPick !== null && modelPick !== undefined;
  const catalogEntries = useQuery(
    api.llmCatalog.listPickableModels,
    shouldCheckPremiumModel ? { preferenceScope } : "skip",
  );

  return getModelAccessDisabledReason({
    modelPick,
    reasoningEffort,
    catalogEntries,
    premiumModelsDisabledReason,
    highReasoningDisabledReason,
    modelCatalogLoading: shouldCheckPremiumModel && catalogEntries === undefined,
  });
}

export function getModelAccessDisabledReason({
  modelPick,
  reasoningEffort,
  catalogEntries,
  premiumModelsDisabledReason,
  highReasoningDisabledReason,
  modelCatalogLoading = false,
}: {
  modelPick: ModelPick | null | undefined;
  reasoningEffort: ReasoningEffort | null | undefined;
  catalogEntries: readonly PickableModelEntry[] | undefined;
  premiumModelsDisabledReason?: string;
  highReasoningDisabledReason?: string;
  modelCatalogLoading?: boolean;
}): string | null {
  const modelReason = getPremiumModelDisabledReason({
    modelPick,
    catalogEntries,
    premiumModelsDisabledReason,
    modelCatalogLoading,
  });
  return modelReason ?? getHighReasoningDisabledReason(reasoningEffort, highReasoningDisabledReason);
}

function getPremiumModelDisabledReason({
  modelPick,
  catalogEntries,
  premiumModelsDisabledReason,
  modelCatalogLoading,
}: {
  modelPick: ModelPick | null | undefined;
  catalogEntries: readonly PickableModelEntry[] | undefined;
  premiumModelsDisabledReason?: string;
  modelCatalogLoading: boolean;
}): string | null {
  if (!premiumModelsDisabledReason || !modelPick) {
    return null;
  }
  if (modelCatalogLoading) {
    return MODEL_ACCESS_LOADING_REASON;
  }
  const selectedEntry = catalogEntries?.find(
    (entry) => entry.provider === modelPick.provider && entry.modelName === modelPick.modelName,
  );
  return selectedEntry?.capability === "sandbox" ? premiumModelsDisabledReason : null;
}

function getHighReasoningDisabledReason(
  reasoningEffort: ReasoningEffort | null | undefined,
  highReasoningDisabledReason: string | undefined,
): string | null {
  if (!highReasoningDisabledReason) {
    return null;
  }
  return reasoningEffort === "high" || reasoningEffort === "xhigh" ? highReasoningDisabledReason : null;
}
