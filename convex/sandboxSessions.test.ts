/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const OWNER = "user|sandbox-session-test";
type SandboxSessionStatus = Doc<"sandboxSessions">["status"];

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

async function seedAccessProfile(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userAccessProfiles", {
      ownerTokenIdentifier: OWNER,
      plan: "internal",
      billingStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedSandboxSession(
  t: ReturnType<typeof convexTest>,
  args: {
    repositoryId: Id<"repositories">;
    status: SandboxSessionStatus;
    startedAt: number;
    spentCents: number;
  },
): Promise<Id<"sandboxSessions">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("sandboxSessions", {
      ownerTokenIdentifier: OWNER,
      repositoryId: args.repositoryId,
      status: args.status,
      startedAt: args.startedAt,
      lastActivityAt: args.startedAt,
      lastResumedAt: args.startedAt,
      idleAutoPauseMinutes: 15,
      spentCents: args.spentCents,
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
        idleAutoPauseMinutes: 15,
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

describe("getSandboxSessionCostSummary", () => {
  test("returns an old active session as current but excludes old spend", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const oldStartedAt = todayStart.getTime() - 60_000;
    const todayStartedAt = todayStart.getTime() + 60_000;
    const activeSessionId = await seedSandboxSession(t, {
      repositoryId,
      status: "active",
      startedAt: oldStartedAt,
      spentCents: 125,
    });
    await seedSandboxSession(t, {
      repositoryId,
      status: "ended",
      startedAt: oldStartedAt,
      spentCents: 200,
    });
    await seedSandboxSession(t, {
      repositoryId,
      status: "ended",
      startedAt: todayStartedAt,
      spentCents: 30,
    });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const summary = await viewer.query(api.sandboxSessions.getSandboxSessionCostSummary, { repositoryId });

    expect(summary.current?._id).toBe(activeSessionId);
    expect(summary.current?.status).toBe("active");
    expect(summary.todaySpentCents).toBe(30);
    expect(summary.now).toEqual(expect.any(Number));
  });

  test("includes multiple sessions from today in spend", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartedAt = todayStart.getTime() + 60_000;

    await seedSandboxSession(t, {
      repositoryId,
      status: "ended",
      startedAt: todayStartedAt,
      spentCents: 30,
    });
    await seedSandboxSession(t, {
      repositoryId,
      status: "stopped",
      startedAt: todayStartedAt + 60_000,
      spentCents: 45,
    });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const summary = await viewer.query(api.sandboxSessions.getSandboxSessionCostSummary, { repositoryId });

    expect(summary.current).toBeUndefined();
    expect(summary.todaySpentCents).toBe(75);
  });
});

describe("startSandboxSession", () => {
  test("starts in starting state when the latest sandbox is expired", async () => {
    const t = convexTest(schema, modules);
    await seedAccessProfile(t);
    const repositoryId = await seedRepository(t);
    const sandboxId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier: OWNER,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-expired",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() - 1_000,
        autoStopIntervalMinutes: 15,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      await ctx.db.patch(repositoryId, { latestSandboxId: id });
      return id;
    });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const sessionId = await viewer.mutation(api.sandboxSessions.startSandboxSession, { repositoryId });

    const session = await t.run(async (ctx) => await ctx.db.get(sessionId));
    expect(session).toMatchObject({
      sandboxId,
      status: "starting",
    });
  });
});
