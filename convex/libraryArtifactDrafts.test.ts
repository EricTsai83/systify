/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  insertTestArtifact,
  insertTestArtifactFolder,
  insertTestRepository,
  insertTestThread,
} from "../test/convex/fixtures";
import { createRateLimitedTestConvex, type SystifyTestConvex } from "../test/convex/harness";
import { withPausedConvexScheduler } from "../test/convex/scheduler";

const OWNER = "user|artifact-draft";
const OTHER_OWNER = "user|artifact-draft-other";

async function seedAccessProfile(t: SystifyTestConvex, ownerTokenIdentifier = OWNER) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userAccessProfiles", {
      ownerTokenIdentifier,
      email: `${ownerTokenIdentifier}@example.com`,
      plan: "internal",
      billingStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedRepository(t: SystifyTestConvex, ownerTokenIdentifier = OWNER) {
  return await insertTestRepository(t, {
    ownerTokenIdentifier,
    importStatus: "completed",
    lastSyncedCommitSha: "abc123",
  });
}

async function seedLibraryThread(t: SystifyTestConvex, repositoryId: Id<"repositories">) {
  return await insertTestThread(t, {
    ownerTokenIdentifier: OWNER,
    repositoryId,
    mode: "library",
    title: "Library Ask",
  });
}

async function seedJob(t: SystifyTestConvex, repositoryId: Id<"repositories">) {
  return await t.run(async (ctx) =>
    ctx.db.insert("jobs", {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      kind: "artifact_draft",
      status: "completed",
      stage: "Ready to review",
      progress: 1,
      costCategory: "system_design",
      triggerSource: "user",
    }),
  );
}

async function seedReadyDraft(
  t: SystifyTestConvex,
  args: {
    repositoryId: Id<"repositories">;
    operation: "create" | "update";
    targetArtifactId?: Id<"artifacts">;
    targetArtifactVersion?: number;
    folderId?: Id<"artifactFolders">;
    status?: Doc<"artifactDrafts">["status"];
    updatedAt?: number;
  },
) {
  const jobId = await seedJob(t, args.repositoryId);
  const now = Date.now();
  const draftId = await t.run(async (ctx) =>
    ctx.db.insert("artifactDrafts", {
      ownerTokenIdentifier: OWNER,
      repositoryId: args.repositoryId,
      jobId,
      operation: args.operation,
      status: args.status ?? "ready",
      prompt: "Draft a useful artifact.",
      targetArtifactId: args.targetArtifactId,
      targetArtifactVersion: args.targetArtifactVersion,
      folderId: args.folderId,
      title: args.operation === "create" ? "Custom runbook" : "Updated architecture",
      summary: "Updated summary",
      contentMarkdown: "# Updated\n\nCodebase-backed content.",
      changeSummary: "Refreshed from the codebase.",
      alignedImportCommitSha: "abc123",
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.5",
      promptVersion: 1,
      createdAt: now,
      updatedAt: args.updatedAt ?? now,
      generatedAt: now,
    }),
  );
  return { draftId, jobId };
}

async function seedRunningDraft(t: SystifyTestConvex, repositoryId: Id<"repositories">) {
  const now = Date.now();
  const jobId = await t.run(async (ctx) =>
    ctx.db.insert("jobs", {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      kind: "artifact_draft",
      status: "running",
      stage: "Drafting from codebase...",
      progress: 0.5,
      costCategory: "system_design",
      triggerSource: "user",
      startedAt: now,
      leaseExpiresAt: now + 60_000,
    }),
  );
  const draftId = await t.run(async (ctx) =>
    ctx.db.insert("artifactDrafts", {
      ownerTokenIdentifier: OWNER,
      repositoryId,
      jobId,
      operation: "create",
      status: "running",
      prompt: "Draft a useful artifact.",
      title: "Custom runbook",
      summary: "",
      contentMarkdown: "",
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.5",
      promptVersion: 1,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return { draftId, jobId };
}

async function seedReadySandbox(t: SystifyTestConvex, repositoryId: Id<"repositories">) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sandboxes", {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      provider: "daytona",
      sourceAdapter: "git_clone",
      remoteId: "remote-draft-ready",
      status: "ready",
      workDir: "/workspace",
      repoPath: "/workspace/repo",
      cpuLimit: 2,
      memoryLimitGiB: 4,
      diskLimitGiB: 10,
      ttlExpiresAt: Date.now() + 60_000,
      autoStopIntervalMinutes: 30,
      autoArchiveIntervalMinutes: 60,
      autoDeleteIntervalMinutes: 120,
      networkBlockAll: false,
    }),
  );
}

describe("libraryArtifactDrafts", () => {
  test("request create draft inserts job and draft", async () => {
    await withPausedConvexScheduler(async () => {
      const t = createRateLimitedTestConvex();
      await seedAccessProfile(t);
      const repositoryId = await seedRepository(t);
      const threadId = await seedLibraryThread(t, repositoryId);
      const folderId = await insertTestArtifactFolder(t, { repositoryId, ownerTokenIdentifier: OWNER });
      const viewer = t.withIdentity({ tokenIdentifier: OWNER });

      const result = await viewer.mutation(api.libraryArtifactDrafts.requestDraft, {
        repositoryId,
        threadId,
        operation: "create",
        title: "Runbook",
        folderId,
        prompt: "Create an operations runbook.",
        provider: "openai",
        modelName: "gpt-5.5",
      });

      const state = await t.run(async (ctx) => ({
        job: await ctx.db.get(result.jobId),
        draft: await ctx.db.get(result.draftId),
      }));
      expect(state.job?.kind).toBe("artifact_draft");
      expect(state.job?.repositoryId).toBe(repositoryId);
      expect(state.job?.threadId).toBe(threadId);
      expect(state.job?.costCategory).toBe("system_design");
      expect(state.draft?.status).toBe("queued");
      expect(state.draft?.operation).toBe("create");
      expect(state.draft?.folderId).toBe(folderId);
      expect(state.draft?.generatedByModel).toBe("gpt-5.5");
    });
  });

  test("request update draft validates artifact ownership and repository", async () => {
    await withPausedConvexScheduler(async () => {
      const t = createRateLimitedTestConvex();
      await seedAccessProfile(t);
      await seedAccessProfile(t, OTHER_OWNER);
      const repositoryId = await seedRepository(t);
      const otherRepositoryId = await seedRepository(t, OTHER_OWNER);
      const otherArtifactId = await insertTestArtifact(t, {
        repositoryId: otherRepositoryId,
        ownerTokenIdentifier: OTHER_OWNER,
      });
      const viewer = t.withIdentity({ tokenIdentifier: OWNER });

      await expect(
        viewer.mutation(api.libraryArtifactDrafts.requestDraft, {
          repositoryId,
          operation: "update",
          targetArtifactId: otherArtifactId,
          prompt: "Refresh it.",
          provider: "openai",
          modelName: "gpt-5.5",
        }),
      ).rejects.toThrow(/target artifact not found/i);
    });
  });

  test("apply create writes a custom_document artifact", async () => {
    await withPausedConvexScheduler(async () => {
      const t = createRateLimitedTestConvex();
      await seedAccessProfile(t);
      const repositoryId = await seedRepository(t);
      const folderId = await insertTestArtifactFolder(t, { repositoryId, ownerTokenIdentifier: OWNER });
      const { draftId } = await seedReadyDraft(t, { repositoryId, operation: "create", folderId });
      const viewer = t.withIdentity({ tokenIdentifier: OWNER });

      const result = await viewer.mutation(api.libraryArtifactDrafts.applyDraft, { draftId });

      const state = await t.run(async (ctx) => ({
        artifact: await ctx.db.get(result.artifactId),
        version: await ctx.db
          .query("artifactVersions")
          .withIndex("by_artifactId_and_version", (q) => q.eq("artifactId", result.artifactId).eq("version", 1))
          .unique(),
        draft: await ctx.db.get(draftId),
      }));
      expect(state.artifact?.kind).toBe("custom_document");
      expect(state.artifact?.folderId).toBe(folderId);
      expect(state.artifact?.renderFormat ?? "markdown").toBe("markdown");
      expect(state.artifact?.currentVersionId).toBe(state.version?._id);
      expect(state.artifact?.lastVerifiedAt).toEqual(expect.any(Number));
      expect(state.artifact?.alignedImportCommitSha).toBe("abc123");
      expect(state.artifact?.generatedByModel).toBe("gpt-5.5");
      expect(state.version?.contentMarkdown).toContain("Codebase-backed content");
      expect(state.draft?.status).toBe("applied");
    });
  });

  test("apply create rejects an archived repository without writing an artifact", async () => {
    await withPausedConvexScheduler(async () => {
      const t = createRateLimitedTestConvex();
      await seedAccessProfile(t);
      const repositoryId = await seedRepository(t);
      const { draftId } = await seedReadyDraft(t, { repositoryId, operation: "create" });
      await t.run(async (ctx) => {
        await ctx.db.patch(repositoryId, { archivedAt: Date.now() });
      });
      const viewer = t.withIdentity({ tokenIdentifier: OWNER });

      await expect(viewer.mutation(api.libraryArtifactDrafts.applyDraft, { draftId })).rejects.toThrow(/archived/i);

      const artifacts = await t.run(async (ctx) =>
        ctx.db
          .query("artifacts")
          .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
          .take(10),
      );
      expect(artifacts).toHaveLength(0);
    });
  });

  test("apply update checks version guard and does not modify on mismatch", async () => {
    await withPausedConvexScheduler(async () => {
      const t = createRateLimitedTestConvex();
      await seedAccessProfile(t);
      const repositoryId = await seedRepository(t);
      const artifactId = await insertTestArtifact(t, {
        repositoryId,
        ownerTokenIdentifier: OWNER,
        title: "Original",
        summary: "Original summary",
        contentMarkdown: "# Original",
        version: 2,
      });
      const { draftId } = await seedReadyDraft(t, {
        repositoryId,
        operation: "update",
        targetArtifactId: artifactId,
        targetArtifactVersion: 1,
      });
      const viewer = t.withIdentity({ tokenIdentifier: OWNER });

      await expect(viewer.mutation(api.libraryArtifactDrafts.applyDraft, { draftId })).rejects.toThrow(
        /changed since the draft was generated/i,
      );

      const artifact = await t.run(async (ctx) => await ctx.db.get(artifactId));
      expect(artifact?.title).toBe("Original");
      expect(artifact?.contentMarkdown).toBe("# Original");
      expect(artifact?.version).toBe(2);
    });
  });

  test("apply update patches the target artifact when version matches", async () => {
    await withPausedConvexScheduler(async () => {
      const t = createRateLimitedTestConvex();
      await seedAccessProfile(t);
      const repositoryId = await seedRepository(t);
      const artifactId = await insertTestArtifact(t, {
        repositoryId,
        ownerTokenIdentifier: OWNER,
        title: "Original",
        summary: "Original summary",
        contentMarkdown: "# Original",
        version: 1,
      });
      const { draftId } = await seedReadyDraft(t, {
        repositoryId,
        operation: "update",
        targetArtifactId: artifactId,
        targetArtifactVersion: 1,
      });
      const viewer = t.withIdentity({ tokenIdentifier: OWNER });

      const result = await viewer.mutation(api.libraryArtifactDrafts.applyDraft, { draftId });

      const state = await t.run(async (ctx) => ({
        artifact: await ctx.db.get(artifactId),
        version: await ctx.db
          .query("artifactVersions")
          .withIndex("by_artifactId_and_version", (q) => q.eq("artifactId", artifactId).eq("version", 2))
          .unique(),
        draft: await ctx.db.get(draftId),
      }));
      expect(result.artifactId).toBe(artifactId);
      expect(state.artifact?.title).toBe("Updated architecture");
      expect(state.artifact?.contentMarkdown).toContain("Codebase-backed content");
      expect(state.artifact?.version).toBe(2);
      expect(state.artifact?.currentVersionId).toBe(state.version?._id);
      expect(state.version?.title).toBe("Updated architecture");
      expect(state.artifact?.lastVerifiedAt).toEqual(expect.any(Number));
      expect(state.artifact?.chunkingStatus).toBe("pending");
      expect(state.draft?.status).toBe("applied");
    });
  });

  test("discard does not modify the target artifact", async () => {
    const t = createRateLimitedTestConvex();
    await seedAccessProfile(t);
    const repositoryId = await seedRepository(t);
    const artifactId = await insertTestArtifact(t, {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      title: "Original",
      contentMarkdown: "# Original",
      version: 1,
    });
    const { draftId } = await seedReadyDraft(t, {
      repositoryId,
      operation: "update",
      targetArtifactId: artifactId,
      targetArtifactVersion: 1,
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });

    await viewer.mutation(api.libraryArtifactDrafts.discardDraft, { draftId });

    const state = await t.run(async (ctx) => ({
      artifact: await ctx.db.get(artifactId),
      draft: await ctx.db.get(draftId),
    }));
    expect(state.artifact?.title).toBe("Original");
    expect(state.artifact?.contentMarkdown).toBe("# Original");
    expect(state.artifact?.version).toBe(1);
    expect(state.draft?.status).toBe("discarded");
  });

  test("recent repository drafts omit applied and discarded drafts", async () => {
    const t = createRateLimitedTestConvex();
    await seedAccessProfile(t);
    const repositoryId = await seedRepository(t);
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const baseUpdatedAt = Date.now();
    const statuses = ["queued", "running", "ready", "failed", "applied", "discarded"] satisfies ReadonlyArray<
      Doc<"artifactDrafts">["status"]
    >;

    for (const [index, status] of statuses.entries()) {
      await seedReadyDraft(t, {
        repositoryId,
        operation: "create",
        status,
        updatedAt: baseUpdatedAt + index,
      });
    }

    const entries = await viewer.query(api.libraryArtifactDrafts.listRecentByRepository, { repositoryId });

    expect(entries.map((entry) => entry.draft.status)).toEqual(["failed", "ready", "running", "queued"]);
  });

  test("regenerate discards the replaced draft after enqueueing a retry", async () => {
    await withPausedConvexScheduler(async () => {
      const t = createRateLimitedTestConvex();
      await seedAccessProfile(t);
      const repositoryId = await seedRepository(t);
      const { draftId } = await seedReadyDraft(t, {
        repositoryId,
        operation: "create",
        status: "failed",
      });
      const viewer = t.withIdentity({ tokenIdentifier: OWNER });

      const result = await viewer.mutation(api.libraryArtifactDrafts.regenerateDraft, { draftId });

      const state = await t.run(async (ctx) => ({
        originalDraft: await ctx.db.get(draftId),
        replacementDraft: await ctx.db.get(result.draftId),
        replacementJob: await ctx.db.get(result.jobId),
      }));
      expect(state.originalDraft?.status).toBe("discarded");
      expect(state.originalDraft?.discardedAt).toEqual(expect.any(Number));
      expect(state.replacementDraft?.status).toBe("queued");
      expect(state.replacementDraft?.operation).toBe("create");
      expect(state.replacementJob?.status).toBe("queued");
    });
  });

  test("request draft fails when entitlements are missing", async () => {
    const t = createRateLimitedTestConvex();
    const repositoryId = await seedRepository(t);
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });

    await expect(
      viewer.mutation(api.libraryArtifactDrafts.requestDraft, {
        repositoryId,
        operation: "create",
        title: "Runbook",
        prompt: "Create a runbook.",
        provider: "openai",
        modelName: "gpt-5.5",
      }),
    ).rejects.toThrow(/not available on your current plan/i);
  });

  test("markDraftReady fails without storing generated markdown after repository archive", async () => {
    const t = createRateLimitedTestConvex();
    await seedAccessProfile(t);
    const repositoryId = await seedRepository(t);
    const { draftId, jobId } = await seedRunningDraft(t, repositoryId);
    const sandboxId = await seedReadySandbox(t, repositoryId);
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { archivedAt: Date.now() });
    });

    const result = await t.mutation(internal.libraryArtifactDrafts.markDraftReady, {
      draftId,
      jobId,
      title: "Generated runbook",
      summary: "Generated summary",
      contentMarkdown: "# Generated private content",
      outputFormat: "markdown",
      sandboxId,
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.5",
      promptVersion: 1,
      totalCostUsd: 0.01,
      sourceId: `artifactDraft:${jobId}:archived`,
    });

    const state = await t.run(async (ctx) => ({
      draft: await ctx.db.get(draftId),
      job: await ctx.db.get(jobId),
    }));

    expect(result).toEqual({ ready: false });
    expect(state.draft?.status).toBe("failed");
    expect(state.draft?.contentMarkdown).toBe("");
    expect(state.draft?.errorMessage).toBe("Repository is no longer active.");
    expect(state.job?.status).toBe("failed");
  });
});
