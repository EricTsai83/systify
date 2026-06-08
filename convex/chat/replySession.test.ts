/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createTestConvex, type SystifyTestConvex } from "../../test/convex/harness";

const mocks = vi.hoisted(() => {
  class MockSandboxPreparationError extends Error {
    readonly reason: string;
    readonly userFacingMessage: string;

    constructor(message: string, reason = "live_source_unavailable") {
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
    hasProviderApiKey: vi.fn(),
    consume: vi.fn(),
  };
});

vi.mock("../lib/sandboxLiveness", () => ({
  ensureSandboxReady: mocks.ensureSandboxReady,
  SandboxPreparationError: mocks.MockSandboxPreparationError,
}));

vi.mock("../daytona", () => ({
  getSandboxFsClient: mocks.getSandboxFsClient,
}));

vi.mock("./sandboxTools", () => ({
  createSandboxTools: mocks.createSandboxTools,
}));

vi.mock("../lib/providerEnv", () => ({
  hasProviderApiKey: mocks.hasProviderApiKey,
}));

vi.mock("./replyStreamController", () => ({
  createReplyStreamController: () => ({
    startCancellationPolling: vi.fn(),
    stopCancellationPolling: vi.fn(),
    getCancellationState: vi.fn(() => ({ wasCancelled: false, generationAborted: false })),
    getBufferedText: vi.fn(() => ""),
    getTelemetry: vi.fn(() => ({ hadTools: false, toolInvocations: 0, toolErrors: 0 })),
    consume: mocks.consume,
  }),
  formatReplyStreamError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const OWNER = "user|reply-session";

function replyActionArgs(ids: {
  threadId: Id<"threads">;
  userMessageId: Id<"messages">;
  assistantMessageId: Id<"messages">;
  jobId: Id<"jobs">;
}) {
  return {
    threadId: ids.threadId,
    userMessageId: ids.userMessageId,
    assistantMessageId: ids.assistantMessageId,
    jobId: ids.jobId,
  };
}

async function seedSandboxGroundedReply(t: SystifyTestConvex) {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier: OWNER,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/reply-session",
      sourceRepoFullName: "acme/reply-session",
      sourceRepoOwner: "acme",
      sourceRepoName: "reply-session",
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 1,
      color: "blue",
      lastAccessedAt: Date.now(),
    });
    const sandboxId = await ctx.db.insert("sandboxes", {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      provider: "daytona",
      sourceAdapter: "git_clone",
      remoteId: "remote-prepared",
      status: "ready",
      workDir: "/workspace",
      repoPath: "/workspace/repo",
      cpuLimit: 2,
      memoryLimitGiB: 4,
      diskLimitGiB: 10,
      ttlExpiresAt: Date.now() + 60_000,
      autoStopIntervalMinutes: 10,
      autoArchiveIntervalMinutes: 60,
      autoDeleteIntervalMinutes: 1440,
      networkBlockAll: false,
    });
    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      title: "Reply session",
      mode: "discuss",
      lastMessageAt: Date.now(),
    });
    const jobId = await ctx.db.insert("jobs", {
      repositoryId,
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "chat",
      status: "queued",
      stage: "queued",
      progress: 0,
      costCategory: "system_design",
      triggerSource: "user",
      leaseExpiresAt: Date.now() + 60_000,
    });
    const userMessageId = await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier: OWNER,
      role: "user",
      status: "completed",
      mode: "discuss",
      groundSandbox: true,
      content: "Inspect the live source.",
      provider: "openai",
      modelName: "gpt-5.5",
    });
    const assistantMessageId = await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier: OWNER,
      role: "assistant",
      status: "pending",
      mode: "discuss",
      groundSandbox: true,
      content: "",
      provider: "openai",
      modelName: "gpt-5.5",
    });
    await ctx.db.insert("messageStreams", {
      repositoryId,
      threadId,
      jobId,
      assistantMessageId,
      ownerTokenIdentifier: OWNER,
      compactedContent: "",
      compactedThroughSequence: -1,
      nextSequence: 0,
      startedAt: Date.now(),
      lastAppendedAt: Date.now(),
    });

    return { repositoryId, sandboxId, threadId, jobId, userMessageId, assistantMessageId };
  });
}

beforeEach(() => {
  mocks.ensureSandboxReady.mockReset();
  mocks.getSandboxFsClient.mockReset().mockResolvedValue({ readFile: vi.fn() });
  mocks.createSandboxTools.mockReset().mockReturnValue({ read_file: {} });
  mocks.hasProviderApiKey.mockReset().mockReturnValue(true);
  mocks.consume.mockReset().mockResolvedValue({ kind: "completed", finalDelta: "Live answer.", usage: {} });
});

describe("runAssistantReplySession live-source preparation", () => {
  test("prepares live source and passes prepared sandbox tooling to the stream controller", async () => {
    const t = createTestConvex();
    const ids = await seedSandboxGroundedReply(t);
    mocks.ensureSandboxReady.mockResolvedValue({
      sandboxId: ids.sandboxId,
      remoteId: "remote-prepared",
      repoPath: "/workspace/repo",
    });

    await t.action(internal.chat.generation.generateAssistantReply, replyActionArgs(ids));

    expect(mocks.ensureSandboxReady).toHaveBeenCalledWith(
      expect.anything(),
      {
        repositoryId: ids.repositoryId,
        ownerTokenIdentifier: OWNER,
      },
      expect.any(Function),
    );
    expect(mocks.getSandboxFsClient).toHaveBeenCalledWith("remote-prepared");
    expect(mocks.createSandboxTools).toHaveBeenCalledWith(expect.anything(), "/workspace/repo");
    expect(mocks.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        replyContext: expect.objectContaining({
          sandboxTooling: {
            sandboxId: ids.sandboxId,
            remoteId: "remote-prepared",
            repoPath: "/workspace/repo",
          },
        }),
        sandboxTools: { read_file: {} },
      }),
    );
  });

  test("fails the assistant message when live source preparation fails", async () => {
    const t = createTestConvex();
    const ids = await seedSandboxGroundedReply(t);
    mocks.ensureSandboxReady.mockRejectedValue(new mocks.MockSandboxPreparationError("raw provider error"));

    await t.action(internal.chat.generation.generateAssistantReply, replyActionArgs(ids));

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(ids.jobId),
      assistant: await ctx.db.get(ids.assistantMessageId),
    }));
    expect(state.job?.status).toBe("failed");
    expect(state.assistant?.status).toBe("failed");
    expect(state.assistant?.errorMessage).toBe("Live source couldn't be prepared. Retry the message.");
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  test("does not call the model when cancellation lands during preparation", async () => {
    const t = createTestConvex();
    const ids = await seedSandboxGroundedReply(t);
    mocks.ensureSandboxReady.mockImplementation(async (ctx) => {
      await ctx.runMutation(internal.chat.streaming.markAssistantReplyCancelled, {
        assistantMessageId: ids.assistantMessageId,
        jobId: ids.jobId,
        reason: "Cancelled by user.",
      });
      return {
        sandboxId: ids.sandboxId as Id<"sandboxes">,
        remoteId: "remote-prepared",
        repoPath: "/workspace/repo",
      };
    });

    await t.action(internal.chat.generation.generateAssistantReply, replyActionArgs(ids));

    expect(mocks.consume).not.toHaveBeenCalled();
  });
});
