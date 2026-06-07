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

  test("updates viewer model preferences and filters pickable catalog entries", async () => {
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });

    await viewer.mutation(api.userPreferences.updateViewerModelPreferences, {
      scope: "chat",
      enabledModels: [{ provider: "openai", modelName: "gpt-5.4-mini" }],
      favoriteModels: [
        { provider: "openai", modelName: "gpt-5.4-mini" },
        { provider: "openai", modelName: "gpt-5.4-mini" },
        { provider: "anthropic", modelName: "claude-haiku-4-5" },
      ],
      defaultModel: { provider: "openai", modelName: "gpt-5.4-mini" },
    });

    const preferences = await viewer.query(api.userPreferences.getViewerModelPreferences, {});
    expect(preferences.scopes.chat.favoriteModels).toEqual([{ provider: "openai", modelName: "gpt-5.4-mini" }]);
    expect(preferences.scopes.chat.defaultModel).toEqual({ provider: "openai", modelName: "gpt-5.4-mini" });
    expect(preferences.scopes.chat.disabledModels).toEqual([{ provider: "anthropic", modelName: "claude-haiku-4-5" }]);

    const pickerModels = await viewer.query(api.llmCatalog.listPickableModels, {
      capability: "discuss",
      preferenceScope: "chat",
    });
    expect(pickerModels.map((entry) => `${entry.provider}:${entry.modelName}`)).toEqual(["openai:gpt-5.4-mini"]);

    const settingsRows = await viewer.query(api.llmCatalog.listModelSettings, { scope: "chat" });
    expect(settingsRows.find((entry) => entry.modelName === "gpt-5.4-mini")).toMatchObject({
      enabled: true,
      favorite: true,
      default: true,
    });
    expect(settingsRows.find((entry) => entry.modelName === "claude-haiku-4-5")).toMatchObject({
      enabled: false,
      favorite: false,
    });
  });

  test("rejects scope updates without any compatible enabled models", async () => {
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });

    await expect(
      viewer.mutation(api.userPreferences.updateViewerModelPreferences, {
        scope: "chat",
        enabledModels: [{ provider: "openai", modelName: "gpt-5.5" }],
        favoriteModels: [],
      }),
    ).rejects.toThrow(/At least one model must remain selectable/);
  });

  test("uses the first enabled sandbox model when the default sandbox model is disabled", async () => {
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });

    await viewer.mutation(api.userPreferences.updateViewerModelPreferences, {
      scope: "sandbox",
      enabledModels: [{ provider: "anthropic", modelName: "claude-opus-4-8" }],
      favoriteModels: [],
    });

    await expect(
      viewer.mutation(api.userPreferences.updateViewerModelPreferences, {
        scope: "sandbox",
        enabledModels: [],
        favoriteModels: [],
      }),
    ).rejects.toThrow(/At least one model must remain selectable/);

    await expect(
      viewer.query(api.llmCatalog.getDefaultModelPick, { capability: "sandbox", preferenceScope: "sandbox" }),
    ).resolves.toEqual({
      provider: "anthropic",
      modelName: "claude-opus-4-8",
    });
  });

  test("updates Library model settings against the shared discuss-tier catalog", async () => {
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });

    await viewer.mutation(api.userPreferences.updateViewerModelPreferences, {
      scope: "library",
      enabledModels: [{ provider: "openai", modelName: "gpt-5.4-mini" }],
      favoriteModels: [],
      defaultModel: { provider: "openai", modelName: "gpt-5.4-mini" },
    });

    const settingsRows = await viewer.query(api.llmCatalog.listModelSettings, { scope: "library" });
    expect(settingsRows.map((entry) => entry.capability)).toEqual(["discuss", "discuss"]);
    expect(settingsRows.find((entry) => entry.modelName === "gpt-5.4-mini")).toMatchObject({
      enabled: true,
      default: true,
    });
    expect(settingsRows.find((entry) => entry.modelName === "claude-haiku-4-5")).toMatchObject({
      enabled: false,
    });
  });
});
