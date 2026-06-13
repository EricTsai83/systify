import { describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import { embedWithAccounting } from "./embeddingAccounting";

describe("embedWithAccounting", () => {
  test("gateway failure releases the lifecycle reservation and rethrows", async () => {
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
    expect(runMutation.mock.calls[0]?.[1]).toMatchObject({
      sourceId: "libraryRetrieval:message:query",
      feature: "libraryRetrievalEmbedding",
    });
    expect(runMutation.mock.calls[1]?.[1]).toMatchObject({
      sourceId: "libraryRetrieval:message:query",
      feature: "libraryRetrievalEmbedding",
    });
  });
});
