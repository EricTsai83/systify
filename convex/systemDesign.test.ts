/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  return convexTest(schema, modules);
}

async function insertRepository(t: ReturnType<typeof createTestConvex>, ownerTokenIdentifier: string) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/system-design",
      sourceRepoFullName: "acme/system-design",
      sourceRepoOwner: "acme",
      sourceRepoName: "system-design",
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 1,
      color: "blue",
      lastAccessedAt: Date.now(),
    });
  });
}

describe("getCachedSelectionStatus", () => {
  test("deduplicates repeated selections before reporting totals", async () => {
    const ownerTokenIdentifier = "user|cached-selection-dedupe";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.query(api.systemDesign.getCachedSelectionStatus, {
      repositoryId,
      selections: ["readme_summary", "readme_summary", "security_overview"],
    });

    expect(result.total).toBe(2);
    expect(result.cachedKinds).toEqual([]);
    expect(result.pendingKinds).toEqual(["readme_summary", "security_overview"]);
  });
});
