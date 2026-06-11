"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import type { ApplyMermaidRepairResult, MermaidRepairContext } from "./artifactMermaidRepair";
import type { LlmProvider } from "./lib/llmProvider";
import { getCatalogEntry } from "./lib/llmCatalog";
import { generateViaGateway } from "./lib/llmGateway";
import { SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE } from "./lib/systemDesignPlanning";
import { assertFeatureAccess, requiresHighReasoningAccess, requiresPremiumModelAccess } from "./lib/entitlements";

const MERMAID_REPAIR_CHART_MAX_CHARS = 40_000;
const MERMAID_REPAIR_ERROR_MAX_CHARS = 4_000;

const SYSTEM_PROMPT = [
  "You repair Mermaid diagram syntax.",
  "Return only valid Mermaid source code.",
  "Do not wrap the answer in markdown fences.",
  "Do not include explanations, comments about the repair, or prose.",
  "Preserve the user's intended diagram semantics and labels as much as possible.",
].join("\n");

export const repairArtifactMermaidBlock = action({
  args: {
    artifactId: v.id("artifacts"),
    chart: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args): Promise<ApplyMermaidRepairResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("You must sign in to repair diagrams.");
    }
    if (args.chart.length > MERMAID_REPAIR_CHART_MAX_CHARS) {
      throw new Error(`Diagram source must be at most ${MERMAID_REPAIR_CHART_MAX_CHARS} characters.`);
    }
    if (args.error.length > MERMAID_REPAIR_ERROR_MAX_CHARS) {
      throw new Error(`Diagram error details must be at most ${MERMAID_REPAIR_ERROR_MAX_CHARS} characters.`);
    }

    const repairContext: MermaidRepairContext = await ctx.runQuery(internal.artifactMermaidRepair.getRepairContext, {
      artifactId: args.artifactId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      chart: args.chart,
    });
    const modelChoice = resolveRepairModelChoice({
      provider: repairContext.generatedByProvider,
      modelName: repairContext.generatedByModel,
    });
    const entry = getCatalogEntry(modelChoice.provider, modelChoice.modelName);
    await assertFeatureAccess(ctx, identity, "libraryAsk");
    await assertFeatureAccess(ctx, identity, "generateSystemDesign");
    await assertFeatureAccess(ctx, identity, "sandboxGrounding");
    if (requiresPremiumModelAccess(modelChoice.provider, modelChoice.modelName)) {
      await assertFeatureAccess(ctx, identity, "premiumModels");
    }
    if (requiresHighReasoningAccess(entry?.reasoningEffort)) {
      await assertFeatureAccess(ctx, identity, "highReasoning");
    }

    const startedAt = Date.now();
    const sourceId = `mermaidRepair:${args.artifactId}:${repairContext.version}:${startedAt}`;
    await ctx.runMutation(internal.artifactMermaidRepair.reserveRepairBudget, {
      artifactId: args.artifactId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      expectedVersion: repairContext.version,
      sourceId,
      occurredAtMs: startedAt,
    });

    let result: Awaited<ReturnType<typeof generateViaGateway>>;
    try {
      result = await generateViaGateway(
        ctx,
        {
          provider: modelChoice.provider,
          modelName: modelChoice.modelName,
          ownerTokenIdentifier: identity.tokenIdentifier,
          capability: "sandbox",
          feature: "system_design",
        },
        {
          system: SYSTEM_PROMPT,
          prompt: buildRepairPrompt({ chart: args.chart, error: args.error }),
          ...(entry?.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
        },
      );
    } catch (error) {
      await ctx.runMutation(internal.artifactMermaidRepair.settleRepairUsage, {
        sourceId,
        artifactId: args.artifactId,
        ownerTokenIdentifier: identity.tokenIdentifier,
        occurredAtMs: startedAt,
      });
      throw error;
    }

    await ctx.runMutation(internal.artifactMermaidRepair.settleRepairUsage, {
      sourceId,
      artifactId: args.artifactId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      occurredAtMs: startedAt,
      totalCostUsd: result.costUsd,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      reasoningTokens: result.usage.reasoningTokens,
    });
    const repairedChart = stripMarkdownFence(result.text);
    if (!repairedChart) {
      throw new Error("The repair returned an empty diagram. Try again.");
    }

    return await ctx.runMutation(internal.artifactMermaidRepair.applyRepairedBlock, {
      artifactId: args.artifactId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      expectedVersion: repairContext.version,
      originalChart: args.chart,
      repairedChart,
    });
  },
});

function resolveRepairModelChoice(args: { provider: LlmProvider | undefined; modelName: string | undefined }): {
  provider: LlmProvider;
  modelName: string;
} {
  if (args.provider && args.modelName && getCatalogEntry(args.provider, args.modelName)?.capability === "sandbox") {
    return {
      provider: args.provider,
      modelName: args.modelName,
    };
  }

  return SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE;
}

function buildRepairPrompt(args: { chart: string; error: string }): string {
  return [
    "The Mermaid renderer failed on this diagram.",
    "",
    "Renderer error:",
    args.error,
    "",
    "Broken Mermaid source:",
    args.chart,
    "",
    "Repair the Mermaid source so it parses and renders.",
  ].join("\n");
}

export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:mermaid)?[ \t]*\r?\n([\s\S]*?)\r?\n```/i.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }

  const tildeFenced = /~~~(?:mermaid)?[ \t]*\r?\n([\s\S]*?)\r?\n~~~/i.exec(trimmed);
  if (tildeFenced?.[1] !== undefined) {
    return tildeFenced[1].trim();
  }

  return trimmed;
}
