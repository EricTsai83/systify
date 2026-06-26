import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { applyModelPreferences, isModelEnabledInPreferences, type UserModelPreferences } from "./userPreferences";
import {
  isSupportedReasoningEffort,
  isUserPickableModel,
  listPickableModels,
  ROLE_MODELS,
  type ReasoningEffort,
} from "./llmCatalog";
import type { LlmProvider } from "./llmProvider";
import { isSystemDesignKind, SYSTEM_DESIGN_KIND_TITLES, type SystemDesignKind } from "./systemDesign";

export const SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE = {
  provider: ROLE_MODELS.defaultSystemDesign.provider,
  modelName: ROLE_MODELS.defaultSystemDesign.modelName,
} satisfies {
  provider: LlmProvider;
  modelName: string;
};

export type SystemDesignModelChoice = {
  provider: LlmProvider;
  modelName: string;
  reasoningEffort?: ReasoningEffort;
};

type SystemDesignModelPickerInput = {
  provider?: LlmProvider;
  modelName?: string;
  reasoningEffort?: ReasoningEffort;
};

export type SystemDesignGenerationPlan = {
  selections: SystemDesignKind[];
  modelChoice: SystemDesignModelChoice;
};

export function normalizeSystemDesignSelections(selections: readonly Doc<"artifacts">["kind"][]): SystemDesignKind[] {
  return Array.from(new Set(selections)).filter(isSystemDesignKind);
}

export function planSystemDesignGenerationRequest(args: {
  selections: readonly Doc<"artifacts">["kind"][];
  modelPreferences: UserModelPreferences;
  picker: SystemDesignModelPickerInput;
}): SystemDesignGenerationPlan {
  const selections = normalizeSystemDesignSelections(args.selections);
  if (selections.length === 0) {
    throw new Error("Select at least one document to generate.");
  }

  return {
    selections,
    modelChoice: resolveSystemDesignRequestModelChoice({
      modelPreferences: args.modelPreferences,
      picker: args.picker,
    }),
  };
}

export function resolveSystemDesignRequestModelChoice(args: {
  modelPreferences: UserModelPreferences;
  picker: SystemDesignModelPickerInput;
}): SystemDesignModelChoice {
  assertCompleteSystemDesignModelPick(args.picker);

  let provider = args.picker.provider ?? SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE.provider;
  let modelName = args.picker.modelName ?? SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE.modelName;

  if (
    args.picker.provider === undefined &&
    !isModelEnabledInPreferences(args.modelPreferences, { provider, modelName }, "sandbox")
  ) {
    const firstEnabledSandbox = applyModelPreferences(
      listPickableModels({ capability: "sandbox" }),
      args.modelPreferences,
      "sandbox",
    )[0];
    if (firstEnabledSandbox) {
      provider = firstEnabledSandbox.provider;
      modelName = firstEnabledSandbox.modelName;
    }
  }

  if (
    !isUserPickableModel(provider, modelName, "sandbox") ||
    !isModelEnabledInPreferences(args.modelPreferences, { provider, modelName }, "sandbox")
  ) {
    throw new ConvexError({
      code: "invalid_model_pick",
      message: `Unsupported model selection: ${provider}:${modelName}`,
    });
  }

  if (!isSupportedReasoningEffort(provider, modelName, args.picker.reasoningEffort)) {
    throw new ConvexError({
      code: "unsupported_reasoning_effort",
      message: `Unsupported reasoning effort "${args.picker.reasoningEffort}" for ${provider}:${modelName}.`,
    });
  }

  return {
    provider,
    modelName,
    ...(args.picker.reasoningEffort !== undefined ? { reasoningEffort: args.picker.reasoningEffort } : {}),
  };
}

export function resolveSystemDesignCachePreviewModel(args: {
  provider?: LlmProvider;
  modelName?: string;
}): Pick<SystemDesignModelChoice, "provider" | "modelName"> {
  const provider = args.provider ?? SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE.provider;
  const modelName = args.modelName ?? SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE.modelName;

  if (
    (args.provider !== undefined || args.modelName !== undefined) &&
    !isUserPickableModel(provider, modelName, "sandbox")
  ) {
    return SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE;
  }

  return { provider, modelName };
}

export function buildSystemDesignJobSummary(
  selections: readonly SystemDesignKind[],
  state: "queued" | "running",
): string {
  const titles = selections.map((kind) => SYSTEM_DESIGN_KIND_TITLES[kind]);
  const verb = state === "queued" ? "Queued" : "Generating";
  if (titles.length === 0) {
    return `${verb} design docs`;
  }
  if (titles.length <= 2) {
    return `${verb} ${titles.join(" + ")}`;
  }
  return `${verb} ${titles.length} design docs`;
}

function assertCompleteSystemDesignModelPick(args: { provider?: LlmProvider; modelName?: string }): void {
  if ((args.provider === undefined) !== (args.modelName === undefined)) {
    throw new ConvexError({
      code: "invalid_model_pick",
      message: "provider and modelName must be supplied together.",
    });
  }
}
