/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const OWNER = "user|artifact-views-test";
const OTHER_OWNER = "user|artifact-views-other";

async function seedRepository(
  t: ReturnType<typeof makeHarness>,
  ownerTokenIdentifier: string = OWNER,
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("repositories", {
      ownerTokenIdentifier,
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

async function seedRepoArtifact(
  t: ReturnType<typeof makeHarness>,
  args: { repositoryId: Id<"repositories">; ownerTokenIdentifier?: string },
): Promise<Id<"artifacts">> {
  return await t.mutation(internal.artifactStore.createArtifact, {
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier ?? OWNER,
    kind: "adr",
    title: "ADR 001",
    summary: "s",
    contentMarkdown: "m",
    source: "llm",
  });
}

async function seedThreadArtifact(t: ReturnType<typeof makeHarness>): Promise<Id<"artifacts">> {
  const threadId = await t.run(async (ctx) =>
    ctx.db.insert("threads", {
      ownerTokenIdentifier: OWNER,
      title: "discussion",
      mode: "discuss",
      lastMessageAt: Date.now(),
    }),
  );
  return await t.mutation(internal.artifactStore.createArtifact, {
    threadId,
    ownerTokenIdentifier: OWNER,
    kind: "adr",
    title: "ADR thread",
    summary: "s",
    contentMarkdown: "m",
    source: "llm",
  });
}

/**
 * `convexTest` is generic, but `ReturnType<typeof convexTest>` drops the
 * schema type parameter — which means the inner `ctx.db.query("artifactViews")`
 * falls back to `SystemIndexes` and can't see our custom `by_artifactId`
 * index. Capturing the schema-bound test instance via the harness
 * factory below keeps the index types intact in helpers.
 */
function makeHarness() {
  return convexTest(schema, modules);
}

async function countViews(t: ReturnType<typeof makeHarness>, artifactId: Id<"artifacts">): Promise<number> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("artifactViews")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifactId))
      .collect();
    return rows.length;
  });
}

describe("artifactViews.markViewed", () => {
  test("inserts a row on first view", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t);
    const artifactId = await seedRepoArtifact(t, { repositoryId });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.mutation(api.artifactViews.markViewed, { artifactId, repositoryId });

    expect(await countViews(t, artifactId)).toBe(1);
  });

  test("is idempotent — repeat calls update the existing row in place", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t);
    const artifactId = await seedRepoArtifact(t, { repositoryId });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.mutation(api.artifactViews.markViewed, { artifactId, repositoryId });
    await viewer.mutation(api.artifactViews.markViewed, { artifactId, repositoryId });
    await viewer.mutation(api.artifactViews.markViewed, { artifactId, repositoryId });

    expect(await countViews(t, artifactId)).toBe(1);
  });

  test("silently no-ops when the artifact is owned by another user", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t, OTHER_OWNER);
    const artifactId = await seedRepoArtifact(t, { repositoryId, ownerTokenIdentifier: OTHER_OWNER });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.mutation(api.artifactViews.markViewed, { artifactId, repositoryId });

    expect(await countViews(t, artifactId)).toBe(0);
  });

  test("rejects when the supplied repositoryId does not match the artifact", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t);
    const otherRepositoryId = await seedRepository(t);
    const artifactId = await seedRepoArtifact(t, { repositoryId });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await expect(
      viewer.mutation(api.artifactViews.markViewed, { artifactId, repositoryId: otherRepositoryId }),
    ).rejects.toThrow(/does not belong/i);
    expect(await countViews(t, artifactId)).toBe(0);
  });

  test("rejects for a thread-only artifact (no repositoryId)", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t);
    const artifactId = await seedThreadArtifact(t);

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await expect(viewer.mutation(api.artifactViews.markViewed, { artifactId, repositoryId })).rejects.toThrow(
      /does not belong/i,
    );
    expect(await countViews(t, artifactId)).toBe(0);
  });
});

describe("artifactViews.ensureRepositoryBootstrap", () => {
  test("inserts a bootstrap row when none exists and is observable via the query", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t);

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const before = await viewer.query(api.artifactViews.listViewStateByRepository, { repositoryId });
    expect(before.bootstrapPending).toBe(true);

    await viewer.mutation(api.artifactViews.ensureRepositoryBootstrap, { repositoryId });

    const after = await viewer.query(api.artifactViews.listViewStateByRepository, { repositoryId });
    expect(after.bootstrapPending).toBe(false);
    expect(after.bootstrap).toBeGreaterThanOrEqual(before.bootstrap);
  });

  test("is idempotent — repeat calls preserve the original bootstrapAt", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t);

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.mutation(api.artifactViews.ensureRepositoryBootstrap, { repositoryId });
    const first = await viewer.query(api.artifactViews.listViewStateByRepository, { repositoryId });

    // Force a measurable gap then re-call. The bootstrap must not move.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await viewer.mutation(api.artifactViews.ensureRepositoryBootstrap, { repositoryId });
    await viewer.mutation(api.artifactViews.ensureRepositoryBootstrap, { repositoryId });

    const second = await viewer.query(api.artifactViews.listViewStateByRepository, { repositoryId });
    expect(second.bootstrap).toBe(first.bootstrap);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("repositoryViewerBootstraps")
        .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
          q.eq("ownerTokenIdentifier", OWNER).eq("repositoryId", repositoryId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("silently no-ops when the repository is owned by another user", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t, OTHER_OWNER);

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.mutation(api.artifactViews.ensureRepositoryBootstrap, { repositoryId });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("repositoryViewerBootstraps")
        .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
          q.eq("ownerTokenIdentifier", OWNER).eq("repositoryId", repositoryId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("artifactViews.listViewStateByRepository", () => {
  test("flags bootstrapPending=true with repo creation time as placeholder until bootstrap row is written", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t);

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const state = await viewer.query(api.artifactViews.listViewStateByRepository, { repositoryId });

    expect(state.bootstrapPending).toBe(true);
    expect(state.views).toEqual({});
    const repository = await t.run((ctx) => ctx.db.get(repositoryId));
    expect(state.bootstrap).toBe(repository!._creationTime);
  });

  test("returns the stored bootstrap with bootstrapPending=false once the anchor is written", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t);

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.mutation(api.artifactViews.ensureRepositoryBootstrap, { repositoryId });

    const state = await viewer.query(api.artifactViews.listViewStateByRepository, { repositoryId });
    expect(state.bootstrapPending).toBe(false);
    const stored = await t.run((ctx) =>
      ctx.db
        .query("repositoryViewerBootstraps")
        .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
          q.eq("ownerTokenIdentifier", OWNER).eq("repositoryId", repositoryId),
        )
        .unique(),
    );
    expect(state.bootstrap).toBe(stored!.bootstrapAt);
  });

  test("returns the viewer's view records keyed by artifact id", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t);
    const a = await seedRepoArtifact(t, { repositoryId });
    const b = await seedRepoArtifact(t, { repositoryId });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.mutation(api.artifactViews.markViewed, { artifactId: a, repositoryId });
    await viewer.mutation(api.artifactViews.markViewed, { artifactId: b, repositoryId });

    const state = await viewer.query(api.artifactViews.listViewStateByRepository, { repositoryId });
    expect(Object.keys(state.views).sort()).toEqual([a, b].sort());
    expect(state.views[a]).toBeTypeOf("number");
    expect(state.views[b]).toBeTypeOf("number");
  });

  test("does not leak view records across viewers", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t);
    const artifactId = await seedRepoArtifact(t, { repositoryId });

    // Owner views the artifact; another user's query must not see it.
    const owner = t.withIdentity({ tokenIdentifier: OWNER });
    await owner.mutation(api.artifactViews.markViewed, { artifactId, repositoryId });

    // The other user owns a separate copy of the repo for the query to
    // succeed at all — listViewStateByRepository rejects cross-owner repo
    // access, which is the test for the unowned-repo path below.
    const otherRepositoryId = await seedRepository(t, OTHER_OWNER);
    const otherViewer = t.withIdentity({ tokenIdentifier: OTHER_OWNER });
    const otherState = await otherViewer.query(api.artifactViews.listViewStateByRepository, {
      repositoryId: otherRepositoryId,
    });
    expect(otherState.views).toEqual({});
  });

  test("returns an empty fallback when the repository is not owned by the viewer", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t, OTHER_OWNER);

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const state = await viewer.query(api.artifactViews.listViewStateByRepository, { repositoryId });
    expect(state).toEqual({ bootstrap: 0, views: {}, bootstrapPending: false });
  });
});

describe("artifactViews — cascade delete", () => {
  test("removes the viewer's view record when the underlying artifact is deleted", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t);
    const artifactId = await seedRepoArtifact(t, { repositoryId });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.mutation(api.artifactViews.markViewed, { artifactId, repositoryId });
    expect(await countViews(t, artifactId)).toBe(1);

    await t.mutation(internal.artifactStore.deleteArtifact, { artifactId });

    expect(await countViews(t, artifactId)).toBe(0);
  });

  test("removes view records and bootstrap row when the repository is cascade-deleted", async () => {
    const t = makeHarness();
    const repositoryId = await seedRepository(t);
    const artifactId = await seedRepoArtifact(t, { repositoryId });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.mutation(api.artifactViews.markViewed, { artifactId, repositoryId });
    await viewer.mutation(api.artifactViews.ensureRepositoryBootstrap, { repositoryId });

    await t.mutation(internal.repositories.cascadeDeleteRepository, { repositoryId });

    const remainingViews = await t.run((ctx) =>
      ctx.db
        .query("artifactViews")
        .withIndex("by_artifactId", (q) => q.eq("artifactId", artifactId))
        .collect(),
    );
    const remainingBootstraps = await t.run((ctx) =>
      ctx.db
        .query("repositoryViewerBootstraps")
        .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
          q.eq("ownerTokenIdentifier", OWNER).eq("repositoryId", repositoryId),
        )
        .collect(),
    );
    expect(remainingViews).toHaveLength(0);
    expect(remainingBootstraps).toHaveLength(0);
  });
});
