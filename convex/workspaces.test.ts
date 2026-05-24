/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("workspace initialization", () => {
  test("initializeWorkspaces creates exactly one Home workspace without a repository", async () => {
    const ownerTokenIdentifier = "user|home-workspace";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await viewer.mutation(api.workspaces.initializeWorkspaces, {});
    await viewer.mutation(api.workspaces.initializeWorkspaces, {});

    const workspaces = await viewer.query(api.workspaces.listWorkspaces, {});
    const homeWorkspaces = workspaces.filter((workspace) => !workspace.repositoryId);

    expect(workspaces).toHaveLength(1);
    expect(homeWorkspaces).toHaveLength(1);
    expect(homeWorkspaces[0].name).toBe("Home");
  });

  test("public createWorkspace cannot create another no-repo workspace", async () => {
    const ownerTokenIdentifier = "user|no-empty-workspace";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await viewer.mutation(api.workspaces.initializeWorkspaces, {});
    await expect(
      viewer.mutation(api.workspaces.createWorkspace, {} as { repositoryId: Id<"repositories"> }),
    ).rejects.toThrow();

    const workspaces = await viewer.query(api.workspaces.listWorkspaces, {});
    expect(workspaces.filter((workspace) => !workspace.repositoryId)).toHaveLength(1);
  });

  test("initializeWorkspaces normalizes legacy no-repo workspaces and moves repo threads out of Home", async () => {
    const ownerTokenIdentifier = "user|legacy-home-repair";
    const t = convexTest(schema, modules);
    const { legacyHomeId, duplicateHomeId, repositoryId, repoThreadId, homeThreadId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/legacy-repair",
        sourceRepoFullName: "acme/legacy-repair",
        sourceRepoOwner: "acme",
        sourceRepoName: "legacy-repair",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      });
      const legacyHomeId = await ctx.db.insert("workspaces", {
        ownerTokenIdentifier,
        name: "General",
        color: "blue",
        lastAccessedAt: 1,
      });
      const duplicateHomeId = await ctx.db.insert("workspaces", {
        ownerTokenIdentifier,
        name: "Scratch",
        color: "emerald",
        lastAccessedAt: 2,
      });
      const repoThreadId = await ctx.db.insert("threads", {
        workspaceId: legacyHomeId,
        repositoryId,
        ownerTokenIdentifier,
        title: "Repo thread in legacy home",
        mode: "library",
        lastMessageAt: Date.now(),
      });
      const homeThreadId = await ctx.db.insert("threads", {
        workspaceId: duplicateHomeId,
        ownerTokenIdentifier,
        title: "Design note",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });

      return { legacyHomeId, duplicateHomeId, repositoryId, repoThreadId, homeThreadId };
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.workspaces.initializeWorkspaces, {});

    const state = await t.run(async (ctx) => {
      const workspaces = await ctx.db
        .query("workspaces")
        .withIndex("by_ownerTokenIdentifier_and_lastAccessedAt", (q) =>
          q.eq("ownerTokenIdentifier", ownerTokenIdentifier),
        )
        .take(10);
      return {
        workspaces,
        legacyHome: await ctx.db.get(legacyHomeId),
        duplicateHome: await ctx.db.get(duplicateHomeId),
        repoThread: await ctx.db.get(repoThreadId),
        homeThread: await ctx.db.get(homeThreadId),
      };
    });

    const noRepoWorkspaces = state.workspaces.filter((workspace) => !workspace.repositoryId);
    const repoWorkspace = state.workspaces.find((workspace) => workspace.repositoryId === repositoryId);

    expect(noRepoWorkspaces).toHaveLength(1);
    expect(noRepoWorkspaces[0].name).toBe("Home");
    expect(state.legacyHome?.name).toBe("Home");
    expect(state.duplicateHome).toBeNull();
    expect(repoWorkspace).toBeDefined();
    expect(state.repoThread?.workspaceId).toBe(repoWorkspace?._id);
    expect(state.homeThread?.workspaceId).toBe(noRepoWorkspaces[0]._id);
  });

  test("deleteWorkspace rejects repository workspaces that still have conversations", async () => {
    const ownerTokenIdentifier = "user|delete-workspace-guard";
    const t = convexTest(schema, modules);
    const workspaceId = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/delete-workspace-guard",
        sourceRepoFullName: "acme/delete-workspace-guard",
        sourceRepoOwner: "acme",
        sourceRepoName: "delete-workspace-guard",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      });
      const workspaceId = await ctx.db.insert("workspaces", {
        ownerTokenIdentifier,
        repositoryId,
        name: "acme/delete-workspace-guard",
        color: "blue",
        lastAccessedAt: Date.now(),
      });
      await ctx.db.insert("threads", {
        workspaceId,
        repositoryId,
        ownerTokenIdentifier,
        title: "Repo thread",
        mode: "library",
        lastMessageAt: Date.now(),
      });
      return workspaceId;
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await expect(viewer.mutation(api.workspaces.deleteWorkspace, { workspaceId })).rejects.toThrow(
      "Repository workspaces with conversations cannot be deleted.",
    );
  });
});
