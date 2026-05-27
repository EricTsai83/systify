/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const OWNER = "user|sandbox-session-test";

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
      color: "blue",
      lastAccessedAt: Date.now(),
    }),
  );
}

describe("recordSandboxSessionActivity", () => {
  test("rejects negative spentCentsDelta", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t);
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sandboxSessions", {
        ownerTokenIdentifier: OWNER,
        repositoryId,
        status: "active",
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        lastResumedAt: Date.now(),
        idleAutoPauseMinutes: 10,
        spentCents: 25,
      }),
    );

    await expect(
      t.mutation(internal.sandboxSessions.recordSandboxSessionActivity, {
        sessionId,
        spentCentsDelta: -5,
      }),
    ).rejects.toThrow(/spentCentsDelta cannot be negative/i);

    const stored = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(stored?.spentCents).toBe(25);
  });
});
