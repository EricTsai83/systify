/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("workspace management", () => {
  test("listWorkspaces returns an empty list for a fresh viewer", async () => {
    const ownerTokenIdentifier = "user|empty-list";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const workspaces = await viewer.query(api.workspaces.listWorkspaces, {});
    expect(workspaces).toEqual([]);
  });

  test("createWorkspace creates a repo-bound workspace and is idempotent on the repository", async () => {
    const ownerTokenIdentifier = "user|create-repo-workspace";
    const t = convexTest(schema, modules);
    const repositoryId = await t.run(async (ctx) =>
      ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/widget",
        sourceRepoFullName: "acme/widget",
        sourceRepoOwner: "acme",
        sourceRepoName: "widget",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      }),
    );

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const firstId = await viewer.mutation(api.workspaces.createWorkspace, { repositoryId });
    const secondId = await viewer.mutation(api.workspaces.createWorkspace, { repositoryId });
    expect(secondId).toBe(firstId);

    const workspaces = await viewer.query(api.workspaces.listWorkspaces, {});
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].repositoryId).toBe(repositoryId);
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

  test("deleteWorkspace removes empty repository workspaces", async () => {
    const ownerTokenIdentifier = "user|delete-empty-workspace";
    const t = convexTest(schema, modules);
    const workspaceId = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/empty-ws",
        sourceRepoFullName: "acme/empty-ws",
        sourceRepoOwner: "acme",
        sourceRepoName: "empty-ws",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      });
      return await ctx.db.insert("workspaces", {
        ownerTokenIdentifier,
        repositoryId,
        name: "acme/empty-ws",
        color: "blue",
        lastAccessedAt: Date.now(),
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.workspaces.deleteWorkspace, { workspaceId });

    const workspaces = await viewer.query(api.workspaces.listWorkspaces, {});
    expect(workspaces).toHaveLength(0);
  });
});
