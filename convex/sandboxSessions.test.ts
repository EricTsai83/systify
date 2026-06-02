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

describe("idle sandbox session auto-pause", () => {
  test("lists only active sessions beyond their idle timeout", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t);
    const now = Date.now();
    const staleSessionId = await t.run(async (ctx) =>
      ctx.db.insert("sandboxSessions", {
        ownerTokenIdentifier: OWNER,
        repositoryId,
        status: "active",
        startedAt: now - 30 * 60_000,
        lastActivityAt: now - 11 * 60_000,
        lastResumedAt: now - 30 * 60_000,
        idleAutoPauseMinutes: 10,
        spentCents: 0,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("sandboxSessions", {
        ownerTokenIdentifier: OWNER,
        repositoryId,
        status: "active",
        startedAt: now - 30 * 60_000,
        lastActivityAt: now - 5 * 60_000,
        lastResumedAt: now - 30 * 60_000,
        idleAutoPauseMinutes: 10,
        spentCents: 0,
      });
      await ctx.db.insert("sandboxSessions", {
        ownerTokenIdentifier: OWNER,
        repositoryId,
        status: "paused",
        startedAt: now - 30 * 60_000,
        lastActivityAt: now - 20 * 60_000,
        lastResumedAt: now - 30 * 60_000,
        idleAutoPauseMinutes: 10,
        spentCents: 0,
      });
    });

    const candidates = await t.query(internal.sandboxSessions.listAutoPauseCandidates, {
      now,
      limit: 10,
    });

    expect(candidates.map((session) => session._id)).toEqual([staleSessionId]);
  });

  test("rechecks idleness before marking a session paused", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t);
    const now = Date.now();
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sandboxSessions", {
        ownerTokenIdentifier: OWNER,
        repositoryId,
        status: "active",
        startedAt: now - 30 * 60_000,
        lastActivityAt: now - 11 * 60_000,
        lastResumedAt: now - 30 * 60_000,
        idleAutoPauseMinutes: 10,
        spentCents: 0,
      }),
    );

    await t.run(async (ctx) => {
      await ctx.db.patch(sessionId, { lastActivityAt: now });
    });

    const result = await t.mutation(internal.sandboxSessions.markSessionPausedByIdle, {
      sessionId,
      now,
    });
    const stored = await t.run(async (ctx) => ctx.db.get(sessionId));

    expect(result.paused).toBe(false);
    expect(stored?.status).toBe("active");
    expect(stored?.pausedAt).toBeUndefined();
  });
});
