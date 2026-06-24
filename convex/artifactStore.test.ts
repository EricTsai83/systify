/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  insertTestArtifact,
  insertTestArtifactFolder,
  insertTestRepository,
  insertTestThread,
} from "../test/convex/fixtures";
import { replaceArtifactInFolderWrite, updateArtifactWrite } from "./lib/artifactWrites";
import { createTestConvex, type SystifyTestConvex } from "../test/convex/harness";
import { withPausedConvexScheduler } from "../test/convex/scheduler";

const OWNER = "user|artifact-store-test";
const OTHER_OWNER = "user|artifact-store-other";

async function seedThread(t: SystifyTestConvex): Promise<Id<"threads">> {
  return await insertTestThread(t, {
    ownerTokenIdentifier: OWNER,
    title: "design conversation",
    mode: "discuss",
  });
}

async function seedRepository(t: SystifyTestConvex): Promise<Id<"repositories">> {
  return await insertTestRepository(t, {
    ownerTokenIdentifier: OWNER,
  });
}

async function seedArtifactFolder(
  t: SystifyTestConvex,
  args: {
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier?: string;
  },
): Promise<Id<"artifactFolders">> {
  return await insertTestArtifactFolder(t, {
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier ?? OWNER,
  });
}

async function seedArtifact(
  t: SystifyTestConvex,
  args: {
    threadId?: Id<"threads">;
    repositoryId?: Id<"repositories">;
    ownerTokenIdentifier?: string;
    kind?: "architecture_diagram" | "design_review";
    title?: string;
    summary?: string;
    contentMarkdown?: string;
    folderId?: Id<"artifactFolders">;
  },
): Promise<Id<"artifacts">> {
  return await insertTestArtifact(t, {
    threadId: args.threadId,
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier ?? OWNER,
    kind: args.kind,
    title: args.title,
    summary: args.summary,
    contentMarkdown: args.contentMarkdown,
    folderId: args.folderId,
  });
}

describe("ArtifactStore — parent invariant", () => {
  test("rejects creation when neither threadId nor repositoryId is provided", async () => {
    const t = createTestConvex();

    await expect(
      t.mutation(internal.artifactStore.createArtifact, {
        ownerTokenIdentifier: OWNER,
        kind: "architecture_diagram",
        title: "orphan",
        summary: "no parent",
        contentMarkdown: "# x",
      }),
    ).rejects.toThrow(/at least one parent/i);
  });

  test("accepts a thread-only parent and persists with no repositoryId", async () => {
    const t = createTestConvex();
    const threadId = await seedThread(t);

    const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "architecture_diagram",
      title: "Diagram 001",
      summary: "pick A over B",
      contentMarkdown: "# Decision",
    });

    const stored = await t.query(internal.artifactStore.getArtifact, { artifactId });
    expect(stored).not.toBeNull();
    expect(stored!.threadId).toBe(threadId);
    expect(stored!.repositoryId).toBeUndefined();
    expect(stored!.kind).toBe("architecture_diagram");
    expect(stored!.version).toBe(1);
  });

  test("accepts a repository-only parent and persists with no threadId", async () => {
    await withPausedConvexScheduler(async () => {
      const t = createTestConvex();
      const repositoryId = await seedRepository(t);

      const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
        repositoryId,
        ownerTokenIdentifier: OWNER,
        kind: "architecture_diagram",
        title: "Modules",
        summary: "top-level modules",
        contentMarkdown: "graph TD; A --> B",
      });

      const stored = await t.query(internal.artifactStore.getArtifact, { artifactId });
      expect(stored).not.toBeNull();
      expect(stored!.repositoryId).toBe(repositoryId);
      expect(stored!.threadId).toBeUndefined();
      expect(stored!.kind).toBe("architecture_diagram");
    });
  });

  test("accepts both thread and repository parents simultaneously", async () => {
    await withPausedConvexScheduler(async () => {
      const t = createTestConvex();
      const threadId = await seedThread(t);
      const repositoryId = await seedRepository(t);

      const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
        threadId,
        repositoryId,
        ownerTokenIdentifier: OWNER,
        kind: "design_review",
        title: "risk",
        summary: "design review",
        contentMarkdown: "## Risk",
      });

      const stored = await t.query(internal.artifactStore.getArtifact, { artifactId });
      expect(stored!.threadId).toBe(threadId);
      expect(stored!.repositoryId).toBe(repositoryId);
    });
  });
});

describe("ArtifactStore — folder integrity", () => {
  test("accepts a folder in the artifact repository scope", async () => {
    await withPausedConvexScheduler(async () => {
      const t = createTestConvex();
      const repositoryId = await seedRepository(t);
      const folderId = await seedArtifactFolder(t, { repositoryId });

      const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
        repositoryId,
        ownerTokenIdentifier: OWNER,
        kind: "architecture_diagram",
        title: "Diagram 001",
        summary: "s",
        contentMarkdown: "m",
        folderId,
      });

      const stored = await t.query(internal.artifactStore.getArtifact, { artifactId });
      expect(stored!.folderId).toBe(folderId);
    });
  });

  test("rejects a missing or deleted folder", async () => {
    const t = createTestConvex();
    const repositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, { repositoryId });
    await t.run(async (ctx) => {
      await ctx.db.delete(folderId);
    });

    await expect(
      t.mutation(internal.artifactStore.createArtifact, {
        repositoryId,
        ownerTokenIdentifier: OWNER,
        kind: "architecture_diagram",
        title: "Diagram 001",
        summary: "s",
        contentMarkdown: "m",
        folderId,
      }),
    ).rejects.toThrow(/folder not found/i);
  });

  test("rejects a folder from another repository", async () => {
    const t = createTestConvex();
    const repositoryId = await seedRepository(t);
    const otherRepositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, { repositoryId: otherRepositoryId });

    await expect(
      t.mutation(internal.artifactStore.createArtifact, {
        repositoryId,
        ownerTokenIdentifier: OWNER,
        kind: "architecture_diagram",
        title: "Diagram 001",
        summary: "s",
        contentMarkdown: "m",
        folderId,
      }),
    ).rejects.toThrow(/different repository/i);
  });

  test("rejects a repository folder for a repo-less artifact", async () => {
    const t = createTestConvex();
    const threadId = await seedThread(t);
    const repositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, { repositoryId });

    await expect(
      t.mutation(internal.artifactStore.createArtifact, {
        threadId,
        ownerTokenIdentifier: OWNER,
        kind: "architecture_diagram",
        title: "Diagram 001",
        summary: "s",
        contentMarkdown: "m",
        folderId,
      }),
    ).rejects.toThrow(/repo-less/i);
  });

  test("rejects a folder owned by another user", async () => {
    const t = createTestConvex();
    const repositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, {
      repositoryId,
      ownerTokenIdentifier: OTHER_OWNER,
    });

    await expect(
      t.mutation(internal.artifactStore.createArtifact, {
        repositoryId,
        ownerTokenIdentifier: OWNER,
        kind: "architecture_diagram",
        title: "Diagram 001",
        summary: "s",
        contentMarkdown: "m",
        folderId,
      }),
    ).rejects.toThrow(/folder not found/i);
  });

  test("moveToFolder accepts a folder in the artifact repository scope", async () => {
    const t = createTestConvex();
    const repositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, { repositoryId });
    const artifactId = await seedArtifact(t, { repositoryId });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.mutation(api.artifacts.moveToFolder, { artifactId, folderId });

    const stored = await t.query(internal.artifactStore.getArtifact, { artifactId });
    expect(stored!.folderId).toBe(folderId);
  });

  test("moveToFolder rejects a missing or deleted folder", async () => {
    const t = createTestConvex();
    const repositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, { repositoryId });
    const artifactId = await seedArtifact(t, { repositoryId });
    await t.run(async (ctx) => {
      await ctx.db.delete(folderId);
    });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await expect(viewer.mutation(api.artifacts.moveToFolder, { artifactId, folderId })).rejects.toThrow(
      /folder not found/i,
    );
  });

  test("moveToFolder rejects a folder from another repository", async () => {
    const t = createTestConvex();
    const repositoryId = await seedRepository(t);
    const otherRepositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, { repositoryId: otherRepositoryId });
    const artifactId = await seedArtifact(t, { repositoryId });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await expect(viewer.mutation(api.artifacts.moveToFolder, { artifactId, folderId })).rejects.toThrow(
      /different repository/i,
    );
  });

  test("moveToFolder rejects a repository folder for a repo-less artifact", async () => {
    const t = createTestConvex();
    const threadId = await seedThread(t);
    const repositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, { repositoryId });
    const artifactId = await seedArtifact(t, { threadId });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await expect(viewer.mutation(api.artifacts.moveToFolder, { artifactId, folderId })).rejects.toThrow(/repo-less/i);
  });

  test("moveToFolder rejects a folder owned by another user", async () => {
    const t = createTestConvex();
    const repositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, {
      repositoryId,
      ownerTokenIdentifier: OTHER_OWNER,
    });
    const artifactId = await seedArtifact(t, { repositoryId });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await expect(viewer.mutation(api.artifacts.moveToFolder, { artifactId, folderId })).rejects.toThrow(
      /folder not found/i,
    );
  });

  test("moveToFolder rejects moves into a full folder", async () => {
    const t = createTestConvex();
    const repositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, { repositoryId });
    const artifactId = await seedArtifact(t, { repositoryId });

    await t.run(async (ctx) => {
      for (let index = 0; index < 200; index += 1) {
        await ctx.db.insert("artifacts", {
          repositoryId,
          ownerTokenIdentifier: OWNER,
          kind: "architecture_diagram",
          title: `Seed ${index}`,
          summary: "s",
          contentMarkdown: "m",
          version: 1,
          updatedAt: Date.now(),
          folderId,
        });
      }
    });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await expect(viewer.mutation(api.artifacts.moveToFolder, { artifactId, folderId })).rejects.toThrow(
      /at most 200 artifacts/i,
    );
  });
});

describe("ArtifactStore — filters", () => {
  test("listByThread returns only artifacts attached to the requested thread", async () => {
    const t = createTestConvex();
    const threadA = await seedThread(t);
    const threadB = await seedThread(t);

    await seedArtifact(t, {
      threadId: threadA,
      title: "A1",
    });
    await seedArtifact(t, {
      threadId: threadB,
      title: "B1",
    });

    const aArtifacts = await t.query(internal.artifactStore.listByThread, { threadId: threadA });
    const bArtifacts = await t.query(internal.artifactStore.listByThread, { threadId: threadB });

    expect(aArtifacts.map((artifact) => artifact.title)).toEqual(["A1"]);
    expect(bArtifacts.map((artifact) => artifact.title)).toEqual(["B1"]);
  });

  test("listByThreadAndKind filters by kind within a thread", async () => {
    const t = createTestConvex();
    const threadId = await seedThread(t);

    await seedArtifact(t, {
      threadId,
      title: "Diagram 1",
    });
    await seedArtifact(t, {
      threadId,
      kind: "design_review",
      title: "Review 1",
    });

    const diagrams = await t.query(internal.artifactStore.listByThreadAndKind, {
      threadId,
      kind: "architecture_diagram",
    });
    const reviews = await t.query(internal.artifactStore.listByThreadAndKind, {
      threadId,
      kind: "design_review",
    });

    expect(diagrams.map((artifact) => artifact.title)).toEqual(["Diagram 1"]);
    expect(reviews.map((artifact) => artifact.title)).toEqual(["Review 1"]);
  });

  test("listByRepository returns only artifacts attached to the requested repository", async () => {
    const t = createTestConvex();
    const repoA = await seedRepository(t);
    const repoB = await seedRepository(t);

    await seedArtifact(t, {
      repositoryId: repoA,
      title: "A diagram",
      contentMarkdown: "graph TD; A --> A",
    });
    await seedArtifact(t, {
      repositoryId: repoB,
      title: "B diagram",
      contentMarkdown: "graph TD; B --> B",
    });

    const aArtifacts = await t.query(internal.artifactStore.listByRepository, {
      repositoryId: repoA,
    });
    const bArtifacts = await t.query(internal.artifactStore.listByRepository, {
      repositoryId: repoB,
    });

    expect(aArtifacts.map((artifact) => artifact.title)).toEqual(["A diagram"]);
    expect(bArtifacts.map((artifact) => artifact.title)).toEqual(["B diagram"]);
  });

  test("listByRepositoryAndKind filters by kind within a repository", async () => {
    const t = createTestConvex();
    const repositoryId = await seedRepository(t);

    await seedArtifact(t, {
      repositoryId,
      title: "diagram",
      contentMarkdown: "graph TD;",
    });
    await seedArtifact(t, {
      repositoryId,
      kind: "design_review",
      title: "risks",
    });

    const diagrams = await t.query(internal.artifactStore.listByRepositoryAndKind, {
      repositoryId,
      kind: "architecture_diagram",
    });
    const reviews = await t.query(internal.artifactStore.listByRepositoryAndKind, {
      repositoryId,
      kind: "design_review",
    });

    expect(diagrams.map((artifact) => artifact.kind)).toEqual(["architecture_diagram"]);
    expect(reviews.map((artifact) => artifact.kind)).toEqual(["design_review"]);
  });

  test("listFailedArtifactsForReindex skips feature-not-included failures", async () => {
    const t = createTestConvex();
    const repositoryId = await seedRepository(t);
    const retryableId = await seedArtifact(t, {
      repositoryId,
      title: "retryable",
    });
    const entitlementDeniedId = await seedArtifact(t, {
      repositoryId,
      title: "entitlement denied",
    });
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.patch(retryableId, {
        chunkingStatus: "failed",
        chunkingFailureReason: "embedding_failed",
        lastChunkedAt: now - 60_000,
        lastChunkedVersion: 1,
      });
      await ctx.db.patch(entitlementDeniedId, {
        chunkingStatus: "failed",
        chunkingFailureReason: "feature_not_included",
        lastChunkedAt: now - 60_000,
        lastChunkedVersion: 1,
      });
    });

    const result = await t.query(internal.artifactStore.listFailedArtifactsForReindex, {
      cutoff: now,
      limit: 10,
    });

    expect(result.map((artifact) => artifact._id)).toEqual([retryableId]);
  });
});

describe("ArtifactStore — ordering", () => {
  test("listByThread returns artifacts in newest-first order", async () => {
    const t = createTestConvex();
    const threadId = await seedThread(t);

    await seedArtifact(t, {
      threadId,
      title: "first",
    });
    await seedArtifact(t, {
      threadId,
      title: "second",
    });
    await seedArtifact(t, {
      threadId,
      title: "third",
    });

    const result = await t.query(internal.artifactStore.listByThread, { threadId });
    expect(result.map((artifact) => artifact.title)).toEqual(["third", "second", "first"]);
  });

  test("listByRepository returns artifacts in newest-first order", async () => {
    const t = createTestConvex();
    const repositoryId = await seedRepository(t);

    await seedArtifact(t, {
      repositoryId,
      title: "v1",
    });
    await seedArtifact(t, {
      repositoryId,
      title: "v2",
    });

    const result = await t.query(internal.artifactStore.listByRepository, { repositoryId });
    expect(result.map((artifact) => artifact.title)).toEqual(["v2", "v1"]);
  });
});

describe("ArtifactStore — update/delete", () => {
  test("updateArtifact bumps the version monotonically", async () => {
    const t = createTestConvex();
    const threadId = await seedThread(t);

    const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "architecture_diagram",
      title: "v1",
      summary: "s",
      contentMarkdown: "m",
    });

    await t.mutation(internal.artifactStore.updateArtifact, {
      artifactId,
      title: "v2",
    });
    await t.mutation(internal.artifactStore.updateArtifact, {
      artifactId,
      title: "v3",
    });

    const stored = await t.query(internal.artifactStore.getArtifact, { artifactId });
    expect(stored!.title).toBe("v3");
    expect(stored!.version).toBe(3);
    expect(stored!.summary).toBe("s");
    expect(stored!.contentMarkdown).toBe("m");
  });

  test("updateArtifact throws when artifact not found", async () => {
    const t = createTestConvex();
    const threadId = await seedThread(t);

    // Allocate a real artifact id, then delete it so the id is well-formed
    // but does not refer to an existing document.
    const nonexistentId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("artifacts", {
        threadId,
        ownerTokenIdentifier: OWNER,
        kind: "architecture_diagram",
        title: "tombstone",
        summary: "s",
        contentMarkdown: "m",
        version: 1,
      });
      await ctx.db.delete(id);
      return id;
    });

    await expect(
      t.mutation(internal.artifactStore.updateArtifact, {
        artifactId: nonexistentId,
        title: "x",
      }),
    ).rejects.toThrow(/Artifact not found/i);
  });

  test("deleteArtifact removes the artifact", async () => {
    const t = createTestConvex();
    const threadId = await seedThread(t);

    const artifactId = await seedArtifact(t, {
      threadId,
      title: "doomed",
    });

    await t.mutation(internal.artifactStore.deleteArtifact, { artifactId });

    const stored = await t.query(internal.artifactStore.getArtifact, { artifactId });
    expect(stored).toBeNull();
  });
});

describe("ArtifactWrites — version pruning", () => {
  test("prunes versions beyond the cap after exceeding MAX_ARTIFACT_VERSIONS", async () => {
    const t = createTestConvex();
    const threadId = await seedThread(t);

    const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "architecture_diagram",
      title: "v1",
      summary: "s",
      contentMarkdown: "m v1",
    });

    // Perform 54 more updates so total versions created = 55 (1 original + 54 updates).
    // After each update that pushes version > 50, pruning should fire.
    for (let i = 2; i <= 55; i += 1) {
      await t.mutation(internal.artifactStore.updateArtifact, {
        artifactId,
        title: `v${i}`,
      });
    }

    const state = await t.run(async (ctx) => {
      const artifact = await ctx.db.get(artifactId);
      const versions = await ctx.db
        .query("artifactVersions")
        .withIndex("by_artifactId", (q) => q.eq("artifactId", artifactId))
        .collect();
      return { artifact, versions };
    });

    expect(state.artifact!.version).toBe(55);
    expect(state.versions).toHaveLength(50);
    const versionNumbers = state.versions.map((v) => v.version).sort((a, b) => a - b);
    expect(versionNumbers[0]).toBe(6); // latestVersion(55) - MAX(50) + 1 = 6
    expect(versionNumbers[versionNumbers.length - 1]).toBe(55);
  });

  test("retains all versions when under the cap", async () => {
    const t = createTestConvex();
    const threadId = await seedThread(t);

    const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "architecture_diagram",
      title: "v1",
      summary: "s",
      contentMarkdown: "m v1",
    });

    for (let i = 2; i <= 10; i += 1) {
      await t.mutation(internal.artifactStore.updateArtifact, {
        artifactId,
        title: `v${i}`,
      });
    }

    const versions = await t.run(async (ctx) =>
      ctx.db
        .query("artifactVersions")
        .withIndex("by_artifactId", (q) => q.eq("artifactId", artifactId))
        .collect(),
    );

    expect(versions).toHaveLength(10);
  });

  test("currentVersionId always survives pruning and matches the artifact version", async () => {
    const t = createTestConvex();
    const threadId = await seedThread(t);

    const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "architecture_diagram",
      title: "v1",
      summary: "s",
      contentMarkdown: "m v1",
    });

    for (let i = 2; i <= 55; i += 1) {
      await t.mutation(internal.artifactStore.updateArtifact, {
        artifactId,
        title: `v${i}`,
      });
    }

    await t.run(async (ctx) => {
      const artifact = await ctx.db.get(artifactId);
      expect(artifact).not.toBeNull();
      expect(artifact!.currentVersionId).toBeDefined();
      const currentVersion = await ctx.db.get(artifact!.currentVersionId!);
      expect(currentVersion).not.toBeNull();
      expect(currentVersion!.version).toBe(artifact!.version);
    });
  });

  test("shared HTML blob is not deleted when still referenced by a retained version", async () => {
    const t = createTestConvex();
    const threadId = await seedThread(t);

    // Create an HTML artifact with an initial storage blob.
    const htmlStorageId = await t.run(async (ctx) =>
      ctx.storage.store(
        new Blob(["<!doctype html><html><head></head><body>hello</body></html>"], { type: "text/html" }),
      ),
    );

    const artifactId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("artifacts", {
        threadId,
        ownerTokenIdentifier: OWNER,
        kind: "architecture_diagram",
        title: "html artifact",
        summary: "s",
        contentMarkdown: "m",
        renderFormat: "html",
        version: 1,
        updatedAt: Date.now(),
      });
      const versionId = await ctx.db.insert("artifactVersions", {
        artifactId: id,
        version: 1,
        ownerTokenIdentifier: OWNER,
        title: "html artifact",
        summary: "s",
        contentMarkdown: "m",
        renderFormat: "html",
        htmlStorageId,
        htmlHash: "abc",
        htmlByteLength: 64,
        htmlValidationStatus: "valid",
        createdAt: Date.now(),
      });
      await ctx.db.patch(id, { currentVersionId: versionId });
      return id;
    });

    // Perform 54 title-only updates — these reuse the same htmlStorageId via
    // the `?? previousHtml.htmlStorageId` path in updateArtifactWrite.
    for (let i = 2; i <= 55; i += 1) {
      await t.run(async (ctx) => {
        await updateArtifactWrite(ctx, {
          artifactId,
          title: `html artifact v${i}`,
        });
      });
    }

    // The retained current version must still have a valid htmlStorageId.
    await t.run(async (ctx) => {
      const artifact = await ctx.db.get(artifactId);
      expect(artifact).not.toBeNull();
      const currentVersion = await ctx.db.get(artifact!.currentVersionId!);
      expect(currentVersion).not.toBeNull();
      expect(currentVersion!.htmlStorageId).toBeDefined();
      // Storage blob must still be readable (was not deleted).
      const url = await ctx.storage.getUrl(currentVersion!.htmlStorageId!);
      expect(url).not.toBeNull();
    });
  });
});

describe("ArtifactWrites — generated replacement", () => {
  test("replaces stale folder artifact and applies write side effects together", async () => {
    await withPausedConvexScheduler(async () => {
      const t = createTestConvex();
      const repositoryId = await seedRepository(t);
      const folderId = await seedArtifactFolder(t, { repositoryId });
      const staleArtifactId = await seedArtifact(t, {
        repositoryId,
        folderId,
        kind: "architecture_diagram",
        title: "Old architecture",
        contentMarkdown: "# Old",
      });

      await t.run(async (ctx) => {
        await ctx.db.insert("artifactChunks", {
          ownerTokenIdentifier: OWNER,
          repositoryId,
          artifactId: staleArtifactId,
          artifactVersion: 1,
          chunkIndex: 0,
          headingPath: ["Old"],
          startOffset: 0,
          endOffset: 5,
          content: "# Old",
        });
        await ctx.db.insert("artifactViews", {
          ownerTokenIdentifier: OWNER,
          repositoryId,
          artifactId: staleArtifactId,
          viewedAt: Date.now(),
        });
      });

      const artifactId = await t.run(
        async (ctx) =>
          await replaceArtifactInFolderWrite(ctx, {
            repositoryId,
            folderId,
            ownerTokenIdentifier: OWNER,
            kind: "architecture_diagram",
            title: "New architecture",
            summary: "New summary",
            contentMarkdown: "# New",
            alignedImportCommitSha: "commit-1",
            generatedByProvider: "openai",
            generatedByModel: "gpt-5.5",
            promptVersion: 7,
          }),
      );

      const state = await t.run(async (ctx) => ({
        staleArtifact: await ctx.db.get(staleArtifactId),
        replacement: await ctx.db.get(artifactId),
        staleChunks: await ctx.db
          .query("artifactChunks")
          .withIndex("by_artifactId_and_chunkIndex", (q) => q.eq("artifactId", staleArtifactId))
          .collect(),
        staleViews: await ctx.db
          .query("artifactViews")
          .withIndex("by_artifactId", (q) => q.eq("artifactId", staleArtifactId))
          .collect(),
      }));

      expect(state.staleArtifact).toBeNull();
      expect(state.staleChunks).toEqual([]);
      expect(state.staleViews).toEqual([]);
      expect(state.replacement).toMatchObject({
        repositoryId,
        folderId,
        ownerTokenIdentifier: OWNER,
        kind: "architecture_diagram",
        title: "New architecture",
        version: 1,
        chunkingStatus: "pending",
        alignedImportCommitSha: "commit-1",
        generatedByProvider: "openai",
        generatedByModel: "gpt-5.5",
        promptVersion: 7,
      });
      expect(state.replacement?.lastVerifiedAt).toEqual(expect.any(Number));
      expect(state.replacement?.updatedAt).toEqual(expect.any(Number));
    });
  });
});
