/// <reference types="vite/client" />

import { describe, expect, test, vi, beforeEach } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createRateLimitedTestConvex } from "../test/convex/harness";
import { insertTestArtifact } from "../test/convex/fixtures";

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
    generateViaGateway: vi.fn(),
    generateObjectViaGateway: vi.fn(),
    retrieveArtifactChunks: vi.fn(),
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
  generateViaGateway: mocks.generateViaGateway,
  generateObjectViaGateway: mocks.generateObjectViaGateway,
}));

vi.mock("./lib/artifactRag", () => ({
  retrieveArtifactChunks: mocks.retrieveArtifactChunks,
}));

const OWNER = "user|artifact-draft-node";

const VALID_HTML_REPORT = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Executive report</title>
</head>
<body>
  <main><h1>Executive report</h1><p>Runtime evidence.</p><a href="#sources">Sources</a></main>
</body>
</html>`;

const INVALID_HTML_REPORT = VALID_HTML_REPORT.replace("</body>", "<script>alert(1)</script></body>");

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
      description: "",
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

async function seedHtmlDraftRun(t: ReturnType<typeof createRateLimitedTestConvex>) {
  const { repositoryId, jobId, draftId } = await seedDraftRun(t);
  const sourceArtifactId = await insertTestArtifact(t, {
    ownerTokenIdentifier: OWNER,
    repositoryId,
    title: "Architecture overview",
    description: "Architecture description.",
    contentMarkdown: "# Architecture\n\nRuntime evidence.",
    version: 4,
  });
  const sourceChunkId = await t.run(async (ctx) =>
    ctx.db.insert("artifactChunks", {
      ownerTokenIdentifier: OWNER,
      repositoryId,
      artifactId: sourceArtifactId,
      artifactVersion: 4,
      chunkIndex: 0,
      headingPath: ["Runtime"],
      startOffset: 0,
      endOffset: 17,
      content: "Runtime evidence.",
    }),
  );
  await t.run(async (ctx) => {
    await ctx.db.patch(draftId, {
      outputFormat: "html",
      title: "Executive report",
      prompt: "Create a polished executive report.",
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.4-mini",
    });
  });
  mocks.retrieveArtifactChunks.mockResolvedValue([
    {
      chunkId: sourceChunkId,
      artifactId: sourceArtifactId,
      artifactVersion: 4,
      artifactTitle: "Architecture overview",
      artifactKind: "architecture_overview",
      headingPath: ["Runtime"],
      content: "Runtime evidence.",
      lexicalScore: 1,
      semanticScore: 0.9,
      rrfScore: 0.03,
    },
  ]);

  return { repositoryId, jobId, draftId, sourceArtifactId, sourceChunkId };
}

beforeEach(() => {
  mocks.ensureSandboxReady.mockReset();
  mocks.getSandboxFsClient.mockReset().mockResolvedValue({ readFile: vi.fn() });
  mocks.createSandboxTools.mockReset().mockReturnValue({});
  mocks.generateViaGateway.mockReset().mockResolvedValue({
    text: "# Generated runbook\n\nPrepared from the codebase.",
    usage: { inputTokens: 100, outputTokens: 200, cachedInputTokens: 30, reasoningTokens: 40 },
    costUsd: 0.2,
    steps: [],
    rawResponseId: "response_draft",
  });
  mocks.generateObjectViaGateway.mockReset().mockResolvedValue({
    object: {
      title: "Generated runbook",
      description: "Codebase-backed operations notes.",
      contentMarkdown: "# Generated runbook\n\nPrepared from the codebase.",
      changeSummary: "Created a new artifact.",
    },
    usage: { inputTokens: 12, outputTokens: 34, cachedInputTokens: 3, cacheWriteTokens: 5 },
    costUsd: 0.01,
    steps: [],
    rawResponseId: "response_1",
  });
  mocks.retrieveArtifactChunks.mockReset().mockResolvedValue([
    {
      chunkId: "chunk_html_1" as Id<"artifactChunks">,
      artifactId: "artifact_html_source" as Id<"artifacts">,
      artifactVersion: 4,
      artifactTitle: "Architecture overview",
      artifactKind: "architecture_overview",
      headingPath: ["Runtime"],
      content: "Library evidence about the runtime architecture.",
      lexicalScore: 1,
      semanticScore: 0.9,
      rrfScore: 0.03,
    },
  ]);
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
      usageEvents: await ctx.db.query("userUsageEvents").take(10),
    }));
    expect(mocks.ensureSandboxReady).toHaveBeenCalledWith(
      expect.anything(),
      { repositoryId, ownerTokenIdentifier: OWNER },
      expect.any(Function),
    );
    expect(mocks.getSandboxFsClient).toHaveBeenCalledWith("remote-ready");
    expect(mocks.generateViaGateway).toHaveBeenCalled();
    expect(mocks.generateObjectViaGateway).toHaveBeenCalled();
    const draftArgs = mocks.generateViaGateway.mock.calls[0]?.[2];
    expect(draftArgs?.tools).toEqual({});
    expect(draftArgs?.prepareStep({ stepNumber: 10 })?.system).toContain(
      "prioritize producing the schema-valid object",
    );
    const gatewayArgs = mocks.generateObjectViaGateway.mock.calls[0]?.[2];
    expect(
      gatewayArgs?.schema.safeParse({
        title: "Generated runbook",
        description: "Codebase-backed operations notes.",
        contentMarkdown: "# Generated runbook",
        changeSummary: null,
      }).success,
    ).toBe(true);
    expect(
      gatewayArgs?.schema.safeParse({
        title: "Generated runbook",
        description: "Codebase-backed operations notes.",
        contentMarkdown: "# Generated runbook",
      }).success,
    ).toBe(false);
    expect(gatewayArgs?.tools).toBeUndefined();
    expect(gatewayArgs?.prompt).toContain("# Generated runbook");
    expect(state.draft?.status).toBe("ready");
    expect(state.draft?.title).toBe("Generated runbook");
    expect(state.draft?.sandboxId).toBe(sandboxId);
    expect(state.draft?.alignedImportCommitSha).toBe("commit-123");
    expect(state.job?.status).toBe("completed");
    expect(state.job?.stage).toBe("Ready to review");
  });

  test("treats the codebase as the source of truth when updating an existing artifact", async () => {
    const t = createRateLimitedTestConvex();
    const { repositoryId, sandboxId, jobId, draftId } = await seedDraftRun(t);
    const targetArtifactId = await insertTestArtifact(t, {
      ownerTokenIdentifier: OWNER,
      repositoryId,
      title: "Architecture overview",
      description: "Old architecture description.",
      contentMarkdown: "# Architecture overview\n\nOld statement that must be verified.",
      version: 3,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(draftId, {
        operation: "update",
        prompt: "Refresh the architecture overview.",
        title: "Architecture overview",
        targetArtifactId,
        targetArtifactVersion: 3,
      });
    });
    mocks.ensureSandboxReady.mockResolvedValue({
      sandboxId,
      remoteId: "remote-ready",
      repoPath: "/workspace/repo",
    });

    await t.action(internal.libraryArtifactDraftsNode.runArtifactDraft, {
      draftId,
      jobId,
      repositoryId,
      ownerTokenIdentifier: OWNER,
    });

    const draftArgs = mocks.generateViaGateway.mock.calls[0]?.[2];
    expect(draftArgs).toMatchObject({
      system: expect.stringContaining("The repository codebase is the single source of truth"),
      prompt: expect.stringContaining("Target artifact to revise"),
    });
    expect(draftArgs).toMatchObject({
      system: expect.stringContaining("Existing Library artifacts are not factual sources"),
      prompt: expect.stringContaining("verify every factual claim against the repository code"),
    });
    expect(draftArgs).toMatchObject({
      system: expect.stringContaining("the codebase wins"),
      prompt: expect.stringContaining("Old statement that must be verified."),
    });
    const gatewayArgs = mocks.generateObjectViaGateway.mock.calls[0]?.[2];
    expect(gatewayArgs).toMatchObject({
      system: expect.stringContaining("You convert a codebase-grounded artifact draft"),
      schemaDescription: "A codebase-grounded Library artifact draft for human review before applying.",
    });
  });

  test("generates HTML drafts from Library RAG without preparing a sandbox", async () => {
    const t = createRateLimitedTestConvex();
    const { repositoryId, jobId, draftId } = await seedDraftRun(t);
    const sourceArtifactId = await insertTestArtifact(t, {
      ownerTokenIdentifier: OWNER,
      repositoryId,
      title: "Architecture overview",
      description: "Architecture description.",
      contentMarkdown: "# Architecture\n\nRuntime evidence.",
      version: 4,
    });
    const sourceChunkId = await t.run(async (ctx) =>
      ctx.db.insert("artifactChunks", {
        ownerTokenIdentifier: OWNER,
        repositoryId,
        artifactId: sourceArtifactId,
        artifactVersion: 4,
        chunkIndex: 0,
        headingPath: ["Runtime"],
        startOffset: 0,
        endOffset: 17,
        content: "Runtime evidence.",
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(draftId, {
        outputFormat: "html",
        title: "Executive report",
        prompt: "Create a polished executive report.",
        generatedByProvider: "openai",
        generatedByModel: "gpt-5.4-mini",
      });
    });
    mocks.retrieveArtifactChunks.mockResolvedValue([
      {
        chunkId: sourceChunkId,
        artifactId: sourceArtifactId,
        artifactVersion: 4,
        artifactTitle: "Architecture overview",
        artifactKind: "architecture_overview",
        headingPath: ["Runtime"],
        content: "Runtime evidence.",
        lexicalScore: 1,
        semanticScore: 0.9,
        rrfScore: 0.03,
      },
    ]);
    mocks.generateObjectViaGateway.mockResolvedValueOnce({
      object: {
        title: "Executive report",
        description: "A Library-grounded executive report.",
        contentMarkdown: "# Executive report\n\nRuntime evidence [S1].",
        html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Executive report</title>
</head>
<body>
  <main><h1>Executive report</h1><p>Runtime evidence.</p><a href="#sources">Sources</a></main>
</body>
</html>`,
      },
      usage: { inputTokens: 50, outputTokens: 70 },
      costUsd: 0.03,
      steps: [],
      rawResponseId: "response_html",
    });

    await t.action(internal.libraryArtifactDraftsNode.runArtifactDraft, {
      draftId,
      jobId,
      repositoryId,
      ownerTokenIdentifier: OWNER,
    });

    const state = await t.run(async (ctx) => ({
      draft: await ctx.db.get(draftId),
      job: await ctx.db.get(jobId),
      usageEvents: await ctx.db.query("userUsageEvents").take(10),
    }));
    expect(mocks.ensureSandboxReady).not.toHaveBeenCalled();
    expect(mocks.getSandboxFsClient).not.toHaveBeenCalled();
    expect(mocks.generateViaGateway).not.toHaveBeenCalled();
    expect(mocks.retrieveArtifactChunks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ownerTokenIdentifier: OWNER,
        repositoryId,
        query: "Create a polished executive report.",
      }),
    );
    expect(mocks.generateObjectViaGateway).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ capability: "library" }),
      expect.objectContaining({ schemaName: "library_html_report_draft" }),
    );
    expect(state.draft?.status).toBe("ready");
    expect(state.draft?.outputFormat).toBe("html");
    expect(state.draft?.htmlStorageId).toBeDefined();
    expect(state.draft?.htmlHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state.draft?.htmlByteLength).toBeGreaterThan(0);
    expect(state.draft?.sourceArtifacts).toEqual([
      { artifactId: sourceArtifactId, version: 4, title: "Architecture overview" },
    ]);
    expect(state.draft?.sourceChunkIds).toEqual([sourceChunkId]);
    expect(state.job?.status).toBe("completed");
    expect(state.job?.sandboxId).toBeUndefined();
    expect(state.usageEvents).toHaveLength(1);
    expect(state.usageEvents[0]).toMatchObject({
      ownerTokenIdentifier: OWNER,
      feature: "systemDesign",
      costUsd: 0.03,
      inputTokens: 50,
      outputTokens: 70,
    });
    expect(state.usageEvents[0]?.sourceId).toMatch(new RegExp(`^artifactDraft:${jobId}:`));

    const applyResult = await t
      .withIdentity({ tokenIdentifier: OWNER })
      .mutation(api.libraryArtifactDrafts.applyDraft, {
        draftId,
      });
    const applied = await t.run(async (ctx) => {
      const artifact = await ctx.db.get(applyResult.artifactId);
      const version = await ctx.db
        .query("artifactVersions")
        .withIndex("by_artifactId_and_version", (q) => q.eq("artifactId", applyResult.artifactId).eq("version", 1))
        .unique();
      return { artifact, version, draft: await ctx.db.get(draftId) };
    });
    expect(applied.artifact?.renderFormat).toBe("html");
    expect(applied.artifact?.lastVerifiedAt).toBeUndefined();
    expect(applied.artifact?.currentVersionId).toBe(applied.version?._id);
    expect(applied.version?.htmlStorageId).toBe(state.draft?.htmlStorageId);
    expect(applied.version?.sourceChunkIds).toEqual([sourceChunkId]);
    expect(applied.draft?.status).toBe("applied");

    const metadata = await t
      .withIdentity({ tokenIdentifier: OWNER })
      .query(api.artifacts.listMetadataByRepositoryWithFreshness, { repositoryId });
    const htmlMetadata = metadata.find((artifact) => artifact._id === applyResult.artifactId);
    expect(htmlMetadata?.renderFormat).toBe("html");
    expect(htmlMetadata).not.toHaveProperty("contentMarkdown");

    const storageId = applied.version?.htmlStorageId;
    expect(storageId).toBeDefined();
    await t.withIdentity({ tokenIdentifier: OWNER }).mutation(api.artifacts.remove, {
      artifactId: applyResult.artifactId,
    });
    const cleanup = await t.run(async (ctx) => ({
      versions: await ctx.db
        .query("artifactVersions")
        .withIndex("by_artifactId", (q) => q.eq("artifactId", applyResult.artifactId))
        .collect(),
      storageUrl: storageId ? await ctx.storage.getUrl(storageId) : "missing",
    }));
    expect(cleanup.versions).toHaveLength(0);
    expect(cleanup.storageUrl).toBeNull();
  });

  test("repairs invalid HTML and succeeds, accumulating repair usage", async () => {
    const t = createRateLimitedTestConvex();
    const { repositoryId, jobId, draftId } = await seedHtmlDraftRun(t);
    mocks.generateObjectViaGateway
      .mockResolvedValueOnce({
        object: {
          title: "Executive report",
          description: "A Library-grounded executive report.",
          contentMarkdown: "# Executive report\n\nRuntime evidence [S1].",
          html: INVALID_HTML_REPORT,
        },
        usage: { inputTokens: 50, outputTokens: 70 },
        costUsd: 0.03,
        steps: [],
        rawResponseId: "response_html_invalid",
      })
      .mockResolvedValueOnce({
        object: {
          title: "Executive report",
          description: "A Library-grounded executive report.",
          contentMarkdown: "# Executive report\n\nRuntime evidence [S1].",
          html: VALID_HTML_REPORT,
        },
        usage: { inputTokens: 20, outputTokens: 30 },
        costUsd: 0.02,
        steps: [],
        rawResponseId: "response_html_repaired",
      });

    await t.action(internal.libraryArtifactDraftsNode.runArtifactDraft, {
      draftId,
      jobId,
      repositoryId,
      ownerTokenIdentifier: OWNER,
    });

    const state = await t.run(async (ctx) => ({
      draft: await ctx.db.get(draftId),
      usageEvents: await ctx.db.query("userUsageEvents").take(10),
    }));
    expect(mocks.generateObjectViaGateway).toHaveBeenCalledTimes(2);
    expect(mocks.generateObjectViaGateway.mock.calls[0]?.[2]).toMatchObject({
      schemaName: "library_html_report_draft",
    });
    expect(mocks.generateObjectViaGateway.mock.calls[1]?.[2]).toMatchObject({
      schemaName: "library_html_report_repair",
    });
    expect(state.draft?.status).toBe("ready");
    expect(state.draft?.outputFormat).toBe("html");
    expect(state.usageEvents).toHaveLength(1);
    expect(state.usageEvents[0]?.costUsd).toBe(0.05);
    expect(state.usageEvents[0]).toMatchObject({
      inputTokens: 70,
      outputTokens: 100,
    });
  });

  test("fails the draft when HTML is still invalid after max repair attempts", async () => {
    const t = createRateLimitedTestConvex();
    const { repositoryId, jobId, draftId } = await seedHtmlDraftRun(t);
    mocks.generateObjectViaGateway.mockResolvedValue({
      object: {
        title: "Executive report",
        description: "A Library-grounded executive report.",
        contentMarkdown: "# Executive report\n\nRuntime evidence [S1].",
        html: INVALID_HTML_REPORT,
      },
      usage: { inputTokens: 50, outputTokens: 70 },
      costUsd: 0.03,
      steps: [],
      rawResponseId: "response_html_invalid",
    });

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
    expect(mocks.generateObjectViaGateway).toHaveBeenCalledTimes(3);
    expect(mocks.generateObjectViaGateway.mock.calls[0]?.[2]).toMatchObject({
      schemaName: "library_html_report_draft",
    });
    expect(mocks.generateObjectViaGateway.mock.calls[1]?.[2]).toMatchObject({
      schemaName: "library_html_report_repair",
    });
    expect(mocks.generateObjectViaGateway.mock.calls[2]?.[2]).toMatchObject({
      schemaName: "library_html_report_repair",
    });
    expect(state.draft?.status).toBe("failed");
    expect(state.draft?.errorMessage).toMatch(
      /^Artifact draft failed\. Regenerate to try again\. \(ref: artifactdraft_/,
    );
    expect(state.job?.status).toBe("failed");
  });

  test("fails the draft when repository code access preparation fails", async () => {
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
    expect(state.draft?.errorMessage).toBe("Repository code access was not available.");
    expect(state.job?.status).toBe("failed");
    expect(mocks.generateViaGateway).not.toHaveBeenCalled();
    expect(mocks.generateObjectViaGateway).not.toHaveBeenCalled();
  });
});
