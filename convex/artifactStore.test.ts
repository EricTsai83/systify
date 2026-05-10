/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const OWNER = "user|artifact-store-test";
const OTHER_OWNER = "user|artifact-store-other";

async function seedThread(t: ReturnType<typeof convexTest>): Promise<Id<"threads">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("threads", {
      ownerTokenIdentifier: OWNER,
      title: "design conversation",
      mode: "discuss",
      lastMessageAt: Date.now(),
    }),
  );
}

async function seedRepository(t: ReturnType<typeof convexTest>): Promise<Id<"repositories">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("repositories", {
      ownerTokenIdentifier: OWNER,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/widget",
      sourceRepoFullName: "acme/widget",
      sourceRepoOwner: "acme",
      sourceRepoName: "widget",
      visibility: "unknown",
      accessMode: "private",
      importStatus: "idle",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 0,
    }),
  );
}

async function seedArtifactFolder(
  t: ReturnType<typeof convexTest>,
  args: {
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier?: string;
  },
): Promise<Id<"artifactFolders">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("artifactFolders", {
      ownerTokenIdentifier: args.ownerTokenIdentifier ?? OWNER,
      repositoryId: args.repositoryId,
      name: "Feature folder",
      sortOrder: 1,
    }),
  );
}

describe("ArtifactStore — parent invariant", () => {
  test("rejects creation when neither threadId nor repositoryId is provided", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(internal.artifactStore.createArtifact, {
        ownerTokenIdentifier: OWNER,
        kind: "adr",
        title: "orphan",
        summary: "no parent",
        contentMarkdown: "# x",
        source: "llm",
      }),
    ).rejects.toThrow(/at least one parent/i);
  });

  test("accepts a thread-only parent and persists with no repositoryId", async () => {
    const t = convexTest(schema, modules);
    const threadId = await seedThread(t);

    const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "adr",
      title: "ADR 001",
      summary: "pick A over B",
      contentMarkdown: "# Decision",
      source: "llm",
    });

    const stored = await t.query(internal.artifactStore.getArtifact, { artifactId });
    expect(stored).not.toBeNull();
    expect(stored!.threadId).toBe(threadId);
    expect(stored!.repositoryId).toBeUndefined();
    expect(stored!.kind).toBe("adr");
    expect(stored!.version).toBe(1);
  });

  test("accepts a repository-only parent and persists with no threadId", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t);

    const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      kind: "architecture_diagram",
      title: "Modules",
      summary: "top-level modules",
      contentMarkdown: "graph TD; A --> B",
      source: "heuristic",
    });

    const stored = await t.query(internal.artifactStore.getArtifact, { artifactId });
    expect(stored).not.toBeNull();
    expect(stored!.repositoryId).toBe(repositoryId);
    expect(stored!.threadId).toBeUndefined();
    expect(stored!.kind).toBe("architecture_diagram");
  });

  test("accepts both thread and repository parents simultaneously", async () => {
    const t = convexTest(schema, modules);
    const threadId = await seedThread(t);
    const repositoryId = await seedRepository(t);

    const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      repositoryId,
      ownerTokenIdentifier: OWNER,
      kind: "failure_mode_analysis",
      title: "risk",
      summary: "failure modes",
      contentMarkdown: "## Risk",
      source: "sandbox",
    });

    const stored = await t.query(internal.artifactStore.getArtifact, { artifactId });
    expect(stored!.threadId).toBe(threadId);
    expect(stored!.repositoryId).toBe(repositoryId);
  });
});

describe("ArtifactStore — folder integrity", () => {
  test("accepts a folder in the artifact repository scope", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, { repositoryId });

    const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      kind: "adr",
      title: "ADR 001",
      summary: "s",
      contentMarkdown: "m",
      source: "llm",
      folderId,
    });

    const stored = await t.query(internal.artifactStore.getArtifact, { artifactId });
    expect(stored!.folderId).toBe(folderId);
  });

  test("rejects a missing or deleted folder", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, { repositoryId });
    await t.run(async (ctx) => {
      await ctx.db.delete(folderId);
    });

    await expect(
      t.mutation(internal.artifactStore.createArtifact, {
        repositoryId,
        ownerTokenIdentifier: OWNER,
        kind: "adr",
        title: "ADR 001",
        summary: "s",
        contentMarkdown: "m",
        source: "llm",
        folderId,
      }),
    ).rejects.toThrow(/folder not found/i);
  });

  test("rejects a folder from another repository", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t);
    const otherRepositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, { repositoryId: otherRepositoryId });

    await expect(
      t.mutation(internal.artifactStore.createArtifact, {
        repositoryId,
        ownerTokenIdentifier: OWNER,
        kind: "adr",
        title: "ADR 001",
        summary: "s",
        contentMarkdown: "m",
        source: "llm",
        folderId,
      }),
    ).rejects.toThrow(/different repository/i);
  });

  test("rejects a repository folder for a repo-less artifact", async () => {
    const t = convexTest(schema, modules);
    const threadId = await seedThread(t);
    const repositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, { repositoryId });

    await expect(
      t.mutation(internal.artifactStore.createArtifact, {
        threadId,
        ownerTokenIdentifier: OWNER,
        kind: "adr",
        title: "ADR 001",
        summary: "s",
        contentMarkdown: "m",
        source: "llm",
        folderId,
      }),
    ).rejects.toThrow(/repo-less/i);
  });

  test("rejects a folder owned by another user", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t);
    const folderId = await seedArtifactFolder(t, {
      repositoryId,
      ownerTokenIdentifier: OTHER_OWNER,
    });

    await expect(
      t.mutation(internal.artifactStore.createArtifact, {
        repositoryId,
        ownerTokenIdentifier: OWNER,
        kind: "adr",
        title: "ADR 001",
        summary: "s",
        contentMarkdown: "m",
        source: "llm",
        folderId,
      }),
    ).rejects.toThrow(/folder not found/i);
  });
});

describe("ArtifactStore — filters", () => {
  test("listByThread returns only artifacts attached to the requested thread", async () => {
    const t = convexTest(schema, modules);
    const threadA = await seedThread(t);
    const threadB = await seedThread(t);

    await t.mutation(internal.artifactStore.createArtifact, {
      threadId: threadA,
      ownerTokenIdentifier: OWNER,
      kind: "adr",
      title: "A1",
      summary: "s",
      contentMarkdown: "m",
      source: "llm",
    });
    await t.mutation(internal.artifactStore.createArtifact, {
      threadId: threadB,
      ownerTokenIdentifier: OWNER,
      kind: "adr",
      title: "B1",
      summary: "s",
      contentMarkdown: "m",
      source: "llm",
    });

    const aArtifacts = await t.query(internal.artifactStore.listByThread, { threadId: threadA });
    const bArtifacts = await t.query(internal.artifactStore.listByThread, { threadId: threadB });

    expect(aArtifacts.map((artifact) => artifact.title)).toEqual(["A1"]);
    expect(bArtifacts.map((artifact) => artifact.title)).toEqual(["B1"]);
  });

  test("listByThreadAndKind filters by kind within a thread", async () => {
    const t = convexTest(schema, modules);
    const threadId = await seedThread(t);

    await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "adr",
      title: "ADR 1",
      summary: "s",
      contentMarkdown: "m",
      source: "llm",
    });
    await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "failure_mode_analysis",
      title: "FMA 1",
      summary: "s",
      contentMarkdown: "m",
      source: "sandbox",
    });

    const adrs = await t.query(internal.artifactStore.listByThreadAndKind, {
      threadId,
      kind: "adr",
    });
    const fmas = await t.query(internal.artifactStore.listByThreadAndKind, {
      threadId,
      kind: "failure_mode_analysis",
    });

    expect(adrs.map((artifact) => artifact.title)).toEqual(["ADR 1"]);
    expect(fmas.map((artifact) => artifact.title)).toEqual(["FMA 1"]);
  });

  test("listByRepository returns only artifacts attached to the requested repository", async () => {
    const t = convexTest(schema, modules);
    const repoA = await seedRepository(t);
    const repoB = await seedRepository(t);

    await t.mutation(internal.artifactStore.createArtifact, {
      repositoryId: repoA,
      ownerTokenIdentifier: OWNER,
      kind: "architecture_diagram",
      title: "A diagram",
      summary: "s",
      contentMarkdown: "graph TD; A --> A",
      source: "heuristic",
    });
    await t.mutation(internal.artifactStore.createArtifact, {
      repositoryId: repoB,
      ownerTokenIdentifier: OWNER,
      kind: "architecture_diagram",
      title: "B diagram",
      summary: "s",
      contentMarkdown: "graph TD; B --> B",
      source: "heuristic",
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
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t);

    await t.mutation(internal.artifactStore.createArtifact, {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      kind: "architecture_diagram",
      title: "diagram",
      summary: "s",
      contentMarkdown: "graph TD;",
      source: "heuristic",
    });
    await t.mutation(internal.artifactStore.createArtifact, {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      kind: "risk_report",
      title: "risks",
      summary: "s",
      contentMarkdown: "m",
      source: "sandbox",
    });

    const diagrams = await t.query(internal.artifactStore.listByRepositoryAndKind, {
      repositoryId,
      kind: "architecture_diagram",
    });
    const risks = await t.query(internal.artifactStore.listByRepositoryAndKind, {
      repositoryId,
      kind: "risk_report",
    });

    expect(diagrams.map((artifact) => artifact.kind)).toEqual(["architecture_diagram"]);
    expect(risks.map((artifact) => artifact.kind)).toEqual(["risk_report"]);
  });
});

describe("ArtifactStore — ordering", () => {
  test("listByThread returns artifacts in newest-first order", async () => {
    const t = convexTest(schema, modules);
    const threadId = await seedThread(t);

    await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "adr",
      title: "first",
      summary: "s",
      contentMarkdown: "m",
      source: "llm",
    });
    await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "adr",
      title: "second",
      summary: "s",
      contentMarkdown: "m",
      source: "llm",
    });
    await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "adr",
      title: "third",
      summary: "s",
      contentMarkdown: "m",
      source: "llm",
    });

    const result = await t.query(internal.artifactStore.listByThread, { threadId });
    expect(result.map((artifact) => artifact.title)).toEqual(["third", "second", "first"]);
  });

  test("listByRepository returns artifacts in newest-first order", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t);

    await t.mutation(internal.artifactStore.createArtifact, {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      kind: "architecture_diagram",
      title: "v1",
      summary: "s",
      contentMarkdown: "m",
      source: "heuristic",
    });
    await t.mutation(internal.artifactStore.createArtifact, {
      repositoryId,
      ownerTokenIdentifier: OWNER,
      kind: "architecture_diagram",
      title: "v2",
      summary: "s",
      contentMarkdown: "m",
      source: "heuristic",
    });

    const result = await t.query(internal.artifactStore.listByRepository, { repositoryId });
    expect(result.map((artifact) => artifact.title)).toEqual(["v2", "v1"]);
  });
});

describe("ArtifactStore — update/delete", () => {
  test("updateArtifact bumps the version monotonically", async () => {
    const t = convexTest(schema, modules);
    const threadId = await seedThread(t);

    const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "adr",
      title: "v1",
      summary: "s",
      contentMarkdown: "m",
      source: "llm",
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
    const t = convexTest(schema, modules);
    const threadId = await seedThread(t);

    // Allocate a real artifact id, then delete it so the id is well-formed
    // but does not refer to an existing document.
    const nonexistentId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("artifacts", {
        threadId,
        ownerTokenIdentifier: OWNER,
        kind: "adr",
        title: "tombstone",
        summary: "s",
        contentMarkdown: "m",
        source: "llm",
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
    const t = convexTest(schema, modules);
    const threadId = await seedThread(t);

    const artifactId = await t.mutation(internal.artifactStore.createArtifact, {
      threadId,
      ownerTokenIdentifier: OWNER,
      kind: "adr",
      title: "doomed",
      summary: "s",
      contentMarkdown: "m",
      source: "llm",
    });

    await t.mutation(internal.artifactStore.deleteArtifact, { artifactId });

    const stored = await t.query(internal.artifactStore.getArtifact, { artifactId });
    expect(stored).toBeNull();
  });
});
