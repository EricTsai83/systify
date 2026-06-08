/// <reference types="vite/client" />

import { describe, expect, test, vi, beforeEach } from "vitest";
import { internal } from "./_generated/api";
import { createRateLimitedTestConvex } from "../test/convex/harness";

const mocks = vi.hoisted(() => {
  class MockSandboxPreparationError extends Error {
    readonly reason: string;
    readonly userFacingMessage: string;

    constructor(message: string, reason = "unavailable") {
      super(message);
      this.name = "SandboxPreparationError";
      this.reason = reason;
      this.userFacingMessage = message;
    }
  }

  return {
    ensureSandboxReady: vi.fn(),
    MockSandboxPreparationError,
    getSandboxFsClient: vi.fn(),
    createSandboxTools: vi.fn(),
    generateObjectViaGateway: vi.fn(),
  };
});

vi.mock("./lib/sandboxLiveness", () => ({
  ensureSandboxReady: mocks.ensureSandboxReady,
  SandboxPreparationError: mocks.MockSandboxPreparationError,
}));

vi.mock("./daytona", () => ({
  getSandboxFsClient: mocks.getSandboxFsClient,
}));

vi.mock("./chat/sandboxTools", () => ({
  createSandboxTools: mocks.createSandboxTools,
}));

vi.mock("./lib/llmGateway", () => ({
  generateObjectViaGateway: mocks.generateObjectViaGateway,
}));

const OWNER = "user|artifact-draft-node";

async function seedDraftRun(t: ReturnType<typeof createRateLimitedTestConvex>) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("userAccessProfiles", {
      ownerTokenIdentifier: OWNER,
      email: "artifact-draft-node@example.com",
      plan: "internal",
      billingStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier: OWNER,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/drafts",
      sourceRepoFullName: "acme/drafts",
      sourceRepoOwner: "acme",
      sourceRepoName: "drafts",
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 0,
      color: "blue",
      lastAccessedAt: Date.now(),
      lastSyncedCommitSha: "commit-123",
    });
    const sandboxId = await ctx.db.insert("sandboxes", {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      provider: "daytona",
      sourceAdapter: "git_clone",
      remoteId: "remote-ready",
      status: "ready",
      workDir: "/workspace",
      repoPath: "/workspace/repo",
      cpuLimit: 2,
      memoryLimitGiB: 4,
      diskLimitGiB: 10,
      ttlExpiresAt: Date.now() + 60 * 60_000,
      autoStopIntervalMinutes: 30,
      autoArchiveIntervalMinutes: 60,
      autoDeleteIntervalMinutes: 120,
      networkBlockAll: false,
    });
    await ctx.db.patch(repositoryId, { latestSandboxId: sandboxId });
    const jobId = await ctx.db.insert("jobs", {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      kind: "artifact_draft",
      status: "queued",
      stage: "queued",
      progress: 0,
      costCategory: "system_design",
      triggerSource: "user",
      leaseExpiresAt: Date.now() + 5 * 60_000,
    });
    const draftId = await ctx.db.insert("artifactDrafts", {
      ownerTokenIdentifier: OWNER,
      repositoryId,
      jobId,
      operation: "create",
      status: "queued",
      prompt: "Draft an operations runbook.",
      title: "Operations runbook",
      summary: "",
      contentMarkdown: "",
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.5",
      promptVersion: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { repositoryId, sandboxId, jobId, draftId };
  });
}

beforeEach(() => {
  mocks.ensureSandboxReady.mockReset();
  mocks.getSandboxFsClient.mockReset().mockResolvedValue({ readFile: vi.fn() });
  mocks.createSandboxTools.mockReset().mockReturnValue({});
  mocks.generateObjectViaGateway.mockReset().mockResolvedValue({
    object: {
      title: "Generated runbook",
      summary: "Live-source-backed operations notes.",
      contentMarkdown: "# Generated runbook\n\nPrepared from Live source.",
      changeSummary: "Created a new artifact.",
    },
    usage: { inputTokens: 12, outputTokens: 34 },
    costUsd: 0.01,
    steps: [],
    rawResponseId: "response_1",
  });
});

describe("runArtifactDraft", () => {
  test("calls ensureSandboxReady and writes a ready draft on success", async () => {
    const t = createRateLimitedTestConvex();
    const { repositoryId, sandboxId, jobId, draftId } = await seedDraftRun(t);
    mocks.ensureSandboxReady.mockImplementation(
      async (_ctx, _args, onProgress?: (stage: "cloning") => Promise<void>) => {
        await onProgress?.("cloning");
        return {
          sandboxId,
          remoteId: "remote-ready",
          repoPath: "/workspace/repo",
        };
      },
    );

    await t.action(internal.libraryArtifactDraftsNode.runArtifactDraft, {
      draftId,
      jobId,
      repositoryId,
      ownerTokenIdentifier: OWNER,
    });

    const state = await t.run(async (ctx) => ({
      draft: await ctx.db.get(draftId),
      job: await ctx.db.get(jobId),
    }));
    expect(mocks.ensureSandboxReady).toHaveBeenCalledWith(
      expect.anything(),
      { repositoryId, ownerTokenIdentifier: OWNER },
      expect.any(Function),
    );
    expect(mocks.getSandboxFsClient).toHaveBeenCalledWith("remote-ready");
    expect(mocks.generateObjectViaGateway).toHaveBeenCalled();
    expect(state.draft?.status).toBe("ready");
    expect(state.draft?.title).toBe("Generated runbook");
    expect(state.draft?.sandboxId).toBe(sandboxId);
    expect(state.draft?.alignedImportCommitSha).toBe("commit-123");
    expect(state.job?.status).toBe("completed");
    expect(state.job?.stage).toBe("Ready to review");
  });

  test("fails the draft when live source preparation fails", async () => {
    const t = createRateLimitedTestConvex();
    const { repositoryId, jobId, draftId } = await seedDraftRun(t);
    mocks.ensureSandboxReady.mockRejectedValue(
      new mocks.MockSandboxPreparationError("Live source was not available.", "unavailable"),
    );

    await t.action(internal.libraryArtifactDraftsNode.runArtifactDraft, {
      draftId,
      jobId,
      repositoryId,
      ownerTokenIdentifier: OWNER,
    });

    const state = await t.run(async (ctx) => ({
      draft: await ctx.db.get(draftId),
      job: await ctx.db.get(jobId),
    }));
    expect(state.draft?.status).toBe("failed");
    expect(state.draft?.errorMessage).toBe("Live source was not available.");
    expect(state.job?.status).toBe("failed");
    expect(mocks.generateObjectViaGateway).not.toHaveBeenCalled();
  });
});
