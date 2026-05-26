/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function insertRepoWorkspace(
  t: ReturnType<typeof convexTest>,
  ownerTokenIdentifier: string,
  slug = "demo",
): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: `https://github.com/acme/${slug}`,
      sourceRepoFullName: `acme/${slug}`,
      sourceRepoOwner: "acme",
      sourceRepoName: slug,
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
      name: `acme/${slug}`,
      color: "blue",
      lastAccessedAt: Date.now(),
    });
  });
}

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
    const workspaceId = await insertRepoWorkspace(t, ownerTokenIdentifier);

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId });

    const prefs = await viewer.query(api.userPreferences.getViewerPreferences, {});
    expect(prefs?.lastActiveWorkspaceId).toBe(workspaceId);
    expect(typeof prefs?.lastActiveWorkspaceUpdatedAt).toBe("number");
  });

  test("touchWorkspace is idempotent on the same workspace", async () => {
    const ownerTokenIdentifier = "user|prefs-idempotent";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const workspaceId = await insertRepoWorkspace(t, ownerTokenIdentifier);

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId });
    const first = await viewer.query(api.userPreferences.getViewerPreferences, {});
    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId });
    const second = await viewer.query(api.userPreferences.getViewerPreferences, {});

    // Idempotent path skips the patch so the timestamp must not change.
    expect(second?.lastActiveWorkspaceUpdatedAt).toBe(first?.lastActiveWorkspaceUpdatedAt);
  });

  test("touchWorkspace switches lastActiveWorkspaceId across workspaces", async () => {
    const ownerTokenIdentifier = "user|prefs-switch";
    const t = convexTest(schema, modules);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const wsAId = await insertRepoWorkspace(t, ownerTokenIdentifier, "prefs-switch-a");
    const wsBId = await insertRepoWorkspace(t, ownerTokenIdentifier, "prefs-switch-b");

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: wsAId });
    expect((await viewer.query(api.userPreferences.getViewerPreferences, {}))?.lastActiveWorkspaceId).toBe(wsAId);

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId: wsBId });
    expect((await viewer.query(api.userPreferences.getViewerPreferences, {}))?.lastActiveWorkspaceId).toBe(wsBId);
  });

  test("getViewerPreferences hides a stored id whose workspace was deleted by another path", async () => {
    const ownerTokenIdentifier = "user|prefs-stale-id";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const workspaceId = await insertRepoWorkspace(t, ownerTokenIdentifier);
    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId });

    // Force-delete the workspace at the DB level to simulate a stale pointer
    // that escapes the deleteWorkspace cascade (e.g. legacy data).
    await t.run(async (ctx) => {
      await ctx.db.delete(workspaceId);
    });

    const prefs = await viewer.query(api.userPreferences.getViewerPreferences, {});
    expect(prefs).not.toBeNull();
    expect(prefs?.lastActiveWorkspaceId).toBeNull();
  });

  test("deleteWorkspace clears the matching lastActiveWorkspaceId via cascade", async () => {
    const ownerTokenIdentifier = "user|prefs-delete-cascade";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const workspaceId = await insertRepoWorkspace(t, ownerTokenIdentifier, "prefs-delete-cascade");
    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId });

    expect((await viewer.query(api.userPreferences.getViewerPreferences, {}))?.lastActiveWorkspaceId).toBe(workspaceId);

    await viewer.mutation(api.workspaces.deleteWorkspace, { workspaceId });

    const prefs = await viewer.query(api.userPreferences.getViewerPreferences, {});
    expect(prefs?.lastActiveWorkspaceId).toBeNull();
  });

  test("deleteWorkspace does not touch unrelated lastActiveWorkspaceId", async () => {
    const ownerTokenIdentifier = "user|prefs-delete-unrelated";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const wsAId = await insertRepoWorkspace(t, ownerTokenIdentifier, "prefs-delete-a");
    const wsBId = await insertRepoWorkspace(t, ownerTokenIdentifier, "prefs-delete-b");

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
    const aliceWorkspaceId = await insertRepoWorkspace(t, aliceToken, "prefs-alice");
    await alice.mutation(api.workspaces.touchWorkspace, { workspaceId: aliceWorkspaceId });

    const bob = t.withIdentity({ tokenIdentifier: bobToken });
    const bobPrefs = await bob.query(api.userPreferences.getViewerPreferences, {});
    expect(bobPrefs).toBeNull();
  });

  test("touchWorkspace persists mode when supplied so cross-route returns restore the user's last mode", async () => {
    // End-to-end contract for the "Archive → back to chat" round-trip:
    // visiting `/w/:wid/discuss/:tid` records "discuss" on the workspace,
    // and the next workspace-landing redirect can read that back instead
    // of bouncing the user to the structural default mode.
    const ownerTokenIdentifier = "user|prefs-service-mode";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const workspaceId = await insertRepoWorkspace(t, ownerTokenIdentifier);

    const before = (await viewer.query(api.workspaces.listWorkspaces, {}))[0];
    expect(before.lastMode).toBeUndefined();

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId, mode: "discuss" });
    const afterDiscuss = (await viewer.query(api.workspaces.listWorkspaces, {}))[0];
    expect(afterDiscuss.lastMode).toBe("discuss");

    // A subsequent touch in a different mode overwrites the pick so the
    // workspace tracks the user's most recent choice, not the first one
    // they ever made.
    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId, mode: "library" });
    const afterLibrary = (await viewer.query(api.workspaces.listWorkspaces, {}))[0];
    expect(afterLibrary.lastMode).toBe("library");
  });

  test("touchWorkspace without mode preserves the existing lastMode", async () => {
    // Workspace-switch callsites (URL → state sync, fallback effect) must
    // not clobber the destination workspace's recorded mode with `undefined`
    // — that would erase the very preference the redirect needs to read on
    // the next visit. The mode-less call path is for "the user moved
    // workspaces, we don't have a mode opinion to record".
    const ownerTokenIdentifier = "user|prefs-mode-preserve";
    const t = convexTest(schema, modules);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const workspaceId = await insertRepoWorkspace(t, ownerTokenIdentifier);

    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId, mode: "library" });
    await viewer.mutation(api.workspaces.touchWorkspace, { workspaceId });

    const preserved = (await viewer.query(api.workspaces.listWorkspaces, {}))[0];
    expect(preserved.lastMode).toBe("library");
  });
});
