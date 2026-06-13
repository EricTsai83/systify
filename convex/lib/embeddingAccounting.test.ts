import { describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { embedWithAccounting } from "./embeddingAccounting";

function functionReferenceName(reference: unknown): string {
  return getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
}

describe("embedWithAccounting", () => {
  test("gateway failure releases the lifecycle reservation and rethrows", async () => {
    const reserveEmbeddingMutation = internal.lib.usageAccountingMutations.reserveUsageLifecycle;
    const releaseEmbeddingMutation = internal.lib.usageAccountingMutations.releaseUsageLifecycle;
    const runMutation = vi.fn(async (_functionReference: unknown, _args: unknown) => ({
      reserved: false,
      periodKey: null,
    }));
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      embedWithAccounting(ctx, {
        values: ["architecture"],
        sourceId: "libraryRetrieval:message:query",
        ownerTokenIdentifier: "user|embedding-failure-release",
        repositoryId: null,
        usageFeature: "libraryRetrieval",
        gatewayFeature: "chat",
        modelName: "not-a-catalog-model",
      }),
    ).rejects.toThrow("unsupported model pick");

    expect(runMutation).toHaveBeenCalledTimes(2);
    expect(functionReferenceName(runMutation.mock.calls[0]?.[0])).toBe(getFunctionName(reserveEmbeddingMutation));
    expect(runMutation.mock.calls[0]?.[1]).toMatchObject({
      sourceId: "libraryRetrieval:message:query",
      feature: "libraryRetrievalEmbedding",
    });
    expect(functionReferenceName(runMutation.mock.calls[1]?.[0])).toBe(getFunctionName(releaseEmbeddingMutation));
    expect(runMutation.mock.calls[1]?.[1]).toMatchObject({
      sourceId: "libraryRetrieval:message:query",
      feature: "libraryRetrievalEmbedding",
    });
  });
});
