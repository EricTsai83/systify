import { describe, expect, test } from "vitest";
import { getModelAccessDisabledReason } from "./use-model-access-disabled-reason";
import type { PickableModelEntry } from "@/lib/types";

const premiumReason = "Premium models are not available on your current plan.";
const highReasoningReason = "High reasoning is not available on your current plan.";

const sandboxModel = {
  provider: "openai",
  modelName: "gpt-5.5",
  displayName: "GPT-5.5",
  capability: "sandbox",
  reasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high"],
  supportsReasoning: true,
  supportsTools: true,
  contextWindow: 1_000_000,
  userPickable: true,
  favorite: false,
  default: false,
  defaultSource: null,
} satisfies PickableModelEntry;

const discussModel = {
  ...sandboxModel,
  modelName: "gpt-5.4-mini",
  displayName: "GPT-5.4 Mini",
  capability: "discuss",
} satisfies PickableModelEntry;

describe("getModelAccessDisabledReason", () => {
  test("blocks a selected sandbox-tier model when premium models are disabled", () => {
    expect(
      getModelAccessDisabledReason({
        modelPick: { provider: "openai", modelName: "gpt-5.5" },
        reasoningEffort: null,
        catalogEntries: [sandboxModel, discussModel],
        premiumModelsDisabledReason: premiumReason,
      }),
    ).toBe(premiumReason);
  });

  test("allows a selected discuss-tier model when only premium models are disabled", () => {
    expect(
      getModelAccessDisabledReason({
        modelPick: { provider: "openai", modelName: "gpt-5.4-mini" },
        reasoningEffort: null,
        catalogEntries: [sandboxModel, discussModel],
        premiumModelsDisabledReason: premiumReason,
      }),
    ).toBeNull();
  });

  test("blocks high reasoning overrides independently of the selected model", () => {
    expect(
      getModelAccessDisabledReason({
        modelPick: { provider: "openai", modelName: "gpt-5.4-mini" },
        reasoningEffort: "high",
        catalogEntries: [discussModel],
        highReasoningDisabledReason: highReasoningReason,
      }),
    ).toBe(highReasoningReason);
  });

  test("temporarily blocks premium checks while the catalog is still loading", () => {
    expect(
      getModelAccessDisabledReason({
        modelPick: { provider: "openai", modelName: "gpt-5.5" },
        reasoningEffort: null,
        catalogEntries: undefined,
        premiumModelsDisabledReason: premiumReason,
        modelCatalogLoading: true,
      }),
    ).toBe("Loading model access...");
  });
});
