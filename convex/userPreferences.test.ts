/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("userPreferences", () => {
  test("getViewerPreferences returns null before any workspace activation", async () => {
    const ownerTokenIdentifier = "user|prefs-empty";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const prefs = await viewer.query(api.userPreferences.getViewerPreferences, {});
    expect(prefs).toBeNull();
  });

  test("touchWorkspace upserts lastActiveWorkspaceId atomically with lastAccessedAt", async () => {
    const ownerTokenIdentifier = "user|prefs-touch";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await viewer.mutation(api.workspaces.initializeWorkspaces, {});
    const workspaces = await viewer.query(api.workspaces.listWorkspaces, {});
    const homeId = workspaces[0]._id;

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: homeId });

    const prefs = await viewer.query(api.userPreferences.getViewerPreferences, {});
    expect(prefs?.lastActiveWorkspaceId).toBe(homeId);
    expect(typeof prefs?.lastActiveWorkspaceUpdatedAt).toBe("number");
  });

  test("touchWorkspace is idempotent on the same workspace", async () => {
    const ownerTokenIdentifier = "user|prefs-idempotent";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await viewer.mutation(api.workspaces.initializeWorkspaces, {});
    const workspaces = await viewer.query(api.workspaces.listWorkspaces, {});
    const homeId = workspaces[0]._id;

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: homeId });
    const first = await viewer.query(api.userPreferences.getViewerPreferences, {});
    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: homeId });
    const second = await viewer.query(api.userPreferences.getViewerPreferences, {});

    // Idempotent path skips the patch so the timestamp must not change.
    expect(second?.lastActiveWorkspaceUpdatedAt).toBe(first?.lastActiveWorkspaceUpdatedAt);
  });

  test("touchWorkspace switches lastActiveWorkspaceId across workspaces", async () => {
    const ownerTokenIdentifier = "user|prefs-switch";
    const t = convexTest(schema, modules);

    const repositoryId = await t.run(async (ctx) =>
      ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/prefs-switch",
        sourceRepoFullName: "acme/prefs-switch",
        sourceRepoOwner: "acme",
        sourceRepoName: "prefs-switch",
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
    await viewer.mutation(api.workspaces.initializeWorkspaces, {});
    const repoWorkspaceId = await viewer.mutation(api.workspaces.createWorkspace, { repositoryId });
    const home = (await viewer.query(api.workspaces.listWorkspaces, {})).find((ws) => !ws.repositoryId);
    if (!home) throw new Error("home workspace missing");

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: home._id });
    expect((await viewer.query(api.userPreferences.getViewerPreferences, {}))?.lastActiveWorkspaceId).toBe(home._id);

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: repoWorkspaceId });
    expect((await viewer.query(api.userPreferences.getViewerPreferences, {}))?.lastActiveWorkspaceId).toBe(
      repoWorkspaceId,
    );
  });

  test("getViewerPreferences hides a stored id whose workspace was deleted by another path", async () => {
    const ownerTokenIdentifier = "user|prefs-stale-id";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await viewer.mutation(api.workspaces.initializeWorkspaces, {});
    const workspaces = await viewer.query(api.workspaces.listWorkspaces, {});
    const homeId = workspaces[0]._id;
    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: homeId });

    // Force-delete the workspace at the DB level to simulate a stale pointer
    // that escapes the deleteWorkspace cascade (e.g. legacy data).
    await t.run(async (ctx) => {
      await ctx.db.delete(homeId);
    });

    const prefs = await viewer.query(api.userPreferences.getViewerPreferences, {});
    expect(prefs).not.toBeNull();
    expect(prefs?.lastActiveWorkspaceId).toBeNull();
  });

  test("deleteWorkspace clears the matching lastActiveWorkspaceId via cascade", async () => {
    const ownerTokenIdentifier = "user|prefs-delete-cascade";
    const t = convexTest(schema, modules);

    const repositoryId = await t.run(async (ctx) =>
      ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/prefs-delete-cascade",
        sourceRepoFullName: "acme/prefs-delete-cascade",
        sourceRepoOwner: "acme",
        sourceRepoName: "prefs-delete-cascade",
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
    await viewer.mutation(api.workspaces.initializeWorkspaces, {});
    const repoWorkspaceId: Id<"workspaces"> = await viewer.mutation(api.workspaces.createWorkspace, { repositoryId });
    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: repoWorkspaceId });

    expect((await viewer.query(api.userPreferences.getViewerPreferences, {}))?.lastActiveWorkspaceId).toBe(
      repoWorkspaceId,
    );

    await viewer.mutation(api.workspaces.deleteWorkspace, { workspaceId: repoWorkspaceId });

    const prefs = await viewer.query(api.userPreferences.getViewerPreferences, {});
    expect(prefs?.lastActiveWorkspaceId).toBeNull();
  });

  test("deleteWorkspace does not touch unrelated lastActiveWorkspaceId", async () => {
    const ownerTokenIdentifier = "user|prefs-delete-unrelated";
    const t = convexTest(schema, modules);

    const [repoAId, repoBId] = await t.run(async (ctx) => {
      return [
        await ctx.db.insert("repositories", {
          ownerTokenIdentifier,
          sourceHost: "github",
          sourceUrl: "https://github.com/acme/repo-a",
          sourceRepoFullName: "acme/repo-a",
          sourceRepoOwner: "acme",
          sourceRepoName: "repo-a",
          defaultBranch: "main",
          visibility: "private",
          accessMode: "private",
          importStatus: "completed",
          detectedLanguages: [],
          packageManagers: [],
          entrypoints: [],
          fileCount: 0,
        }),
        await ctx.db.insert("repositories", {
          ownerTokenIdentifier,
          sourceHost: "github",
          sourceUrl: "https://github.com/acme/repo-b",
          sourceRepoFullName: "acme/repo-b",
          sourceRepoOwner: "acme",
          sourceRepoName: "repo-b",
          defaultBranch: "main",
          visibility: "private",
          accessMode: "private",
          importStatus: "completed",
          detectedLanguages: [],
          packageManagers: [],
          entrypoints: [],
          fileCount: 0,
        }),
      ];
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.workspaces.initializeWorkspaces, {});
    const wsAId: Id<"workspaces"> = await viewer.mutation(api.workspaces.createWorkspace, { repositoryId: repoAId });
    const wsBId: Id<"workspaces"> = await viewer.mutation(api.workspaces.createWorkspace, { repositoryId: repoBId });

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: wsAId });
    await viewer.mutation(api.workspaces.deleteWorkspace, { workspaceId: wsBId });

    const prefs = await viewer.query(api.userPreferences.getViewerPreferences, {});
    expect(prefs?.lastActiveWorkspaceId).toBe(wsAId);
  });

  test("getViewerPreferences refuses to leak another viewer's preference", async () => {
    const aliceToken = "user|prefs-alice";
    const bobToken = "user|prefs-bob";
    const t = convexTest(schema, modules);

    const alice = t.withIdentity({ tokenIdentifier: aliceToken });
    await alice.mutation(api.workspaces.initializeWorkspaces, {});
    const aliceWorkspaces = await alice.query(api.workspaces.listWorkspaces, {});
    await alice.mutation(api.workspaces.touchWorkspace, { workspaceId: aliceWorkspaces[0]._id });

    const bob = t.withIdentity({ tokenIdentifier: bobToken });
    const bobPrefs = await bob.query(api.userPreferences.getViewerPreferences, {});
    expect(bobPrefs).toBeNull();
  });

  test("touchWorkspace persists serviceMode when supplied so cross-route returns restore the user's last mode", async () => {
    // End-to-end contract for the "Archive → back to chat" round-trip:
    // visiting `/w/:wid/discuss/:tid` records "discuss" on the workspace,
    // and the next workspace-landing redirect can read that back instead
    // of bouncing the user to the structural default mode.
    const ownerTokenIdentifier = "user|prefs-service-mode";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await viewer.mutation(api.workspaces.initializeWorkspaces, {});
    const workspaces = await viewer.query(api.workspaces.listWorkspaces, {});
    const homeId = workspaces[0]._id;

    expect(workspaces[0].lastServiceMode).toBeUndefined();

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: homeId, serviceMode: "discuss" });
    const afterDiscuss = await viewer.query(api.workspaces.listWorkspaces, {});
    expect(afterDiscuss[0].lastServiceMode).toBe("discuss");

    // A subsequent touch in a different mode overwrites the pick so the
    // workspace tracks the user's most recent choice, not the first one
    // they ever made.
    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: homeId, serviceMode: "lab" });
    const afterLab = await viewer.query(api.workspaces.listWorkspaces, {});
    expect(afterLab[0].lastServiceMode).toBe("lab");
  });

  test("touchWorkspace without serviceMode preserves the existing lastServiceMode", async () => {
    // Workspace-switch callsites (URL → state sync, fallback effect) must
    // not clobber the destination workspace's recorded mode with `undefined`
    // — that would erase the very preference the redirect needs to read on
    // the next visit. The serviceMode-less call path is for "the user moved
    // workspaces, we don't have a mode opinion to record".
    const ownerTokenIdentifier = "user|prefs-service-mode-preserve";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await viewer.mutation(api.workspaces.initializeWorkspaces, {});
    const homeId = (await viewer.query(api.workspaces.listWorkspaces, {}))[0]._id;

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: homeId, serviceMode: "library" });
    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: homeId });

    const preserved = await viewer.query(api.workspaces.listWorkspaces, {});
    expect(preserved[0].lastServiceMode).toBe("library");
  });
});
