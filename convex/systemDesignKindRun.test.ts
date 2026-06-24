/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { SYSTEM_DESIGN_KIND_DESCRIPTIONS } from "./lib/systemDesign";
import { runSystemDesignKind } from "./systemDesignKindRun";

const mocks = vi.hoisted(() => ({
  createSandboxLibraryGenerationTools: vi.fn(),
  emitMetric: vi.fn(),
  generateViaGateway: vi.fn(),
  LlmRateLimitError: class MockLlmRateLimitError extends Error {},
  logErrorWithId: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("./lib/llmGateway", () => ({
  generateViaGateway: mocks.generateViaGateway,
  LlmRateLimitError: mocks.LlmRateLimitError,
}));

vi.mock("./lib/observability", () => ({
  emitMetric: mocks.emitMetric,
  logErrorWithId: mocks.logErrorWithId,
  logWarn: mocks.logWarn,
}));

vi.mock("./lib/sandboxLibraryGeneration", () => ({
  createSandboxLibraryGenerationTools: mocks.createSandboxLibraryGenerationTools,
}));

const OWNER = "user|system-design-kind-run";
const REPOSITORY_ID = "repo_system_design_kind" as Id<"repositories">;
const JOB_ID = "job_system_design_kind" as Id<"jobs">;
const SANDBOX_ID = "sandbox_system_design_kind" as Id<"sandboxes">;
const KIND_RUN_ID = "kind_run_system_design_kind" as Id<"systemDesignKindRuns">;
const ARTIFACT_ID = "artifact_system_design_kind" as Id<"artifacts">;

const repository = {
  sourceRepoFullName: "acme/systify",
  defaultBranch: "main",
} as unknown as Doc<"repositories">;

const validReadmeMarkdown = [
  "# README Summary",
  "",
  "## Purpose",
  "Purpose text.",
  "",
  "## Services & Capabilities",
  "Services text.",
  "",
  "## Audience",
  "Audience text.",
  "",
  "## Key Operations",
  "Operations text.",
  "",
  "## Notable Constraints",
  "Constraints text.",
  "",
  "## Source",
  "Source text.",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createMockActionCtx() {
  const runQuery = vi.fn(
    async (_functionReference: unknown, _queryArgs: unknown): Promise<Doc<"artifacts"> | null> => null,
  );
  const runMutation = vi.fn(async (_functionReference: unknown, mutationArgs: unknown) => {
    if (!isRecord(mutationArgs) || !isRecord(mutationArgs.outcome)) {
      return null;
    }
    const outcomeKind = mutationArgs.outcome.kind;
    if (outcomeKind === "cached_hit") {
      return {
        finalized: true,
        status: "cached_hit",
        kindRunId: KIND_RUN_ID,
        artifactId: ARTIFACT_ID,
        countsAsSucceeded: true,
        aborted: false,
      };
    }
    if (outcomeKind === "generated") {
      return {
        finalized: true,
        status: "succeeded",
        kindRunId: KIND_RUN_ID,
        artifactId: ARTIFACT_ID,
        countsAsSucceeded: true,
        aborted: false,
      };
    }
    if (outcomeKind === "quality_rejected") {
      return {
        finalized: true,
        status: "quality_rejected",
        kindRunId: KIND_RUN_ID,
        countsAsSucceeded: false,
        aborted: false,
      };
    }
    return {
      finalized: true,
      status: "failed",
      kindRunId: KIND_RUN_ID,
      countsAsSucceeded: false,
      aborted: false,
    };
  });
  return {
    ctx: { runQuery, runMutation } as unknown as ActionCtx,
    runQuery,
    runMutation,
  };
}

function baseArgs() {
  return {
    jobId: JOB_ID,
    repositoryId: REPOSITORY_ID,
    ownerTokenIdentifier: OWNER,
    kind: "readme_summary",
    repository,
    prepared: {
      sandboxId: SANDBOX_ID,
      remoteId: "remote-1",
      repoPath: "/workspace/repo",
    },
    modelChoice: {
      provider: "openai",
      modelName: "gpt-5.5",
      reasoningEffort: undefined,
    },
    commitSha: "commit-a",
    forceRegenerate: false,
  } satisfies Parameters<typeof runSystemDesignKind>[1];
}

function finalizeArgsFrom(runMutation: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const finalizeCalls = runMutation.mock.calls.filter(([, mutationArgs]) => {
    return isRecord(mutationArgs) && isRecord(mutationArgs.outcome);
  });
  expect(finalizeCalls).toHaveLength(1);
  const args = finalizeCalls[0]?.[1];
  if (!isRecord(args)) {
    throw new Error("Expected finalize mutation args.");
  }
  return args;
}

beforeEach(() => {
  mocks.createSandboxLibraryGenerationTools.mockReset().mockResolvedValue({});
  mocks.emitMetric.mockReset();
  mocks.generateViaGateway.mockReset().mockResolvedValue({
    text: validReadmeMarkdown,
    usage: { inputTokens: 100, outputTokens: 50 },
    costUsd: 0.01,
    steps: [{}, {}],
  });
  mocks.logErrorWithId.mockReset().mockReturnValue("err_system_design_kind");
  mocks.logWarn.mockReset();
});

describe("runSystemDesignKind publication finalization", () => {
  test("success path calls finalizeKindPublication with generated outcome", async () => {
    const { ctx, runMutation } = createMockActionCtx();

    const result = await runSystemDesignKind(ctx, baseArgs());
    const finalizeArgs = finalizeArgsFrom(runMutation);

    expect(result).toMatchObject({
      status: "succeeded",
      countsAsSucceeded: true,
      aborted: false,
      artifactId: ARTIFACT_ID,
    });
    expect(finalizeArgs.outcome).toMatchObject({
      kind: "generated",
      title: "README Summary",
      description: SYSTEM_DESIGN_KIND_DESCRIPTIONS.readme_summary,
      contentMarkdown: validReadmeMarkdown,
      usage: { inputTokens: 100, outputTokens: 50 },
      totalCostUsd: 0.01,
    });
    expect(runMutation).toHaveBeenCalledTimes(2);
  });

  test("cache hit path calls only finalizeKindPublication", async () => {
    const { ctx, runQuery, runMutation } = createMockActionCtx();
    runQuery.mockResolvedValueOnce({
      _id: ARTIFACT_ID,
      contentMarkdown: "# Cached",
    } as unknown as Doc<"artifacts">);

    const result = await runSystemDesignKind(ctx, baseArgs());
    const finalizeArgs = finalizeArgsFrom(runMutation);

    expect(result).toMatchObject({
      status: "cached_hit",
      countsAsSucceeded: true,
      aborted: false,
      artifactId: ARTIFACT_ID,
    });
    expect(finalizeArgs.outcome).toEqual({
      kind: "cached_hit",
      cachedArtifactId: ARTIFACT_ID,
      outputCharLength: "# Cached".length,
    });
    expect(mocks.generateViaGateway).not.toHaveBeenCalled();
    expect(runMutation).toHaveBeenCalledTimes(1);
  });

  test("quality rejection calls finalizeKindPublication with missing sections", async () => {
    const { ctx, runMutation } = createMockActionCtx();
    mocks.generateViaGateway.mockResolvedValueOnce({
      text: "# Too short",
      usage: { inputTokens: 100, outputTokens: 20 },
      costUsd: 0.005,
      steps: [{}],
    });

    const result = await runSystemDesignKind(ctx, baseArgs());
    const finalizeArgs = finalizeArgsFrom(runMutation);

    expect(result).toMatchObject({
      status: "quality_rejected",
      countsAsSucceeded: false,
      aborted: false,
    });
    expect(finalizeArgs.outcome).toMatchObject({
      kind: "quality_rejected",
      failureReason: "output_quality",
      missingSections: [
        "Purpose",
        "Services & Capabilities",
        "Audience",
        "Key Operations",
        "Notable Constraints",
        "Source",
      ],
      usage: { inputTokens: 100, outputTokens: 20 },
      totalCostUsd: 0.005,
    });
    expect(runMutation).toHaveBeenCalledTimes(2);
  });

  test("provider error calls finalizeKindPublication with failure log", async () => {
    const { ctx, runMutation } = createMockActionCtx();
    mocks.generateViaGateway.mockRejectedValueOnce(new Error("provider unavailable"));

    const result = await runSystemDesignKind(ctx, baseArgs());
    const finalizeArgs = finalizeArgsFrom(runMutation);

    expect(result).toMatchObject({
      status: "failed",
      countsAsSucceeded: false,
      aborted: false,
    });
    expect(finalizeArgs.outcome).toMatchObject({
      kind: "failed",
      failureReason: "infra",
      failureLog: {
        errorId: "err_system_design_kind",
        message: "provider unavailable",
      },
      usage: {},
    });
    expect(runMutation).toHaveBeenCalledTimes(2);
  });
});
