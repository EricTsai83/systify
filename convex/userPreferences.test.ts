/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { createTestConvex } from "../test/convex/harness";

const OWNER = "user|customization-owner";

async function insertRepositoryForOwner(t: ReturnType<typeof createTestConvex>, ownerTokenIdentifier: string) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/customization",
      sourceRepoFullName: "acme/customization",
      sourceRepoOwner: "acme",
      sourceRepoName: "customization",
      visibility: "private",
      accessMode: "private",
      importStatus: "idle",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 0,
      color: "blue",
      lastAccessedAt: Date.now(),
    });
  });
}

describe("user preferences customization", () => {
  test("updates viewer customization with normalized traits and bounded instructions", async () => {
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });

    await viewer.mutation(api.userPreferences.updateViewerCustomization, {
      traits: [" Direct ", "direct", "Detail   oriented", ""],
      customInstructions: "Prefer concise answers.",
    });

    const preferences = await viewer.query(api.userPreferences.getViewerPreferences, {});

    expect(preferences).toMatchObject({
      lastActiveRepositoryId: null,
      lastActiveRepositoryUpdatedAt: null,
      traits: ["Direct", "Detail oriented"],
      customInstructions: "Prefer concise answers.",
    });
    expect(preferences?.customizationUpdatedAt).toEqual(expect.any(Number));
  });

  test("preserves repository preference fields when customization is updated", async () => {
    const t = createTestConvex();
    const repositoryId = await insertRepositoryForOwner(t, OWNER);
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });

    await viewer.mutation(api.repositoryPreferences.touchRepository, { repositoryId });
    await viewer.mutation(api.userPreferences.updateViewerCustomization, {
      traits: ["Pragmatic"],
      customInstructions: "",
    });

    const preferences = await viewer.query(api.userPreferences.getViewerPreferences, {});

    expect(preferences?.lastActiveRepositoryId).toBe(repositoryId);
    expect(preferences?.lastActiveRepositoryUpdatedAt).toEqual(expect.any(Number));
    expect(preferences?.traits).toEqual(["Pragmatic"]);
  });

  test("writes customization migration sentinel when defaults match a legacy row", async () => {
    const t = createTestConvex();
    const repositoryId = await insertRepositoryForOwner(t, OWNER);
    const lastActiveRepositoryUpdatedAt = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("userPreferences", {
        ownerTokenIdentifier: OWNER,
        lastActiveRepositoryId: repositoryId,
        lastActiveRepositoryUpdatedAt,
      });
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });

    await viewer.mutation(api.userPreferences.updateViewerCustomization, {
      traits: [],
      customInstructions: "",
    });

    const preferences = await viewer.query(api.userPreferences.getViewerPreferences, {});

    expect(preferences).toMatchObject({
      lastActiveRepositoryId: repositoryId,
      lastActiveRepositoryUpdatedAt,
      traits: [],
      customInstructions: "",
    });
    expect(preferences?.customizationUpdatedAt).toEqual(expect.any(Number));
  });
});
