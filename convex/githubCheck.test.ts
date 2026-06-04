/// <reference types="vite/client" />

import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

async function insertRepositoryForCheck(
  t: ReturnType<typeof createTestConvex>,
  options?: {
    ownerTokenIdentifier?: string;
    lastCheckedForUpdatesAt?: number;
  },
) {
  const ownerTokenIdentifier = options?.ownerTokenIdentifier ?? "user|github-check";
  const repositoryId = await t.run(async (ctx) => {
    return await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/repo",
      sourceRepoFullName: "acme/repo",
      sourceRepoOwner: "acme",
      sourceRepoName: "repo",
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
      lastSyncedCommitSha: "local-sha",
      lastCheckedForUpdatesAt: options?.lastCheckedForUpdatesAt,
    });
  });
  return { repositoryId, ownerTokenIdentifier };
}

describe("githubCheck.checkForUpdates", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("throttles checks made within the last 60 seconds", async () => {
    const t = createTestConvex();
    const now = Date.now();
    const { repositoryId, ownerTokenIdentifier } = await insertRepositoryForCheck(t, {
      lastCheckedForUpdatesAt: now - 30_000,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.action(api.githubCheck.checkForUpdates, { repositoryId });

    expect(fetchMock).not.toHaveBeenCalled();

    const repository = await t.run(async (ctx) => await ctx.db.get(repositoryId));
    expect(repository?.latestRemoteSha).toBeUndefined();
    expect(repository?.lastCheckedForUpdatesAt).toBe(now - 30_000);
  });

  test("handles GitHub authorization failure without updating remote SHA", async () => {
    const t = createTestConvex();
    const previousCheckAt = Date.now() - 120_000;
    const { repositoryId, ownerTokenIdentifier } = await insertRepositoryForCheck(t, {
      lastCheckedForUpdatesAt: previousCheckAt,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.action(api.githubCheck.checkForUpdates, { repositoryId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("[github-check] acme/repo#main: 401 Unauthorized");

    const repository = await t.run(async (ctx) => await ctx.db.get(repositoryId));
    expect(repository?.latestRemoteSha).toBeUndefined();
    expect(repository?.lastCheckedForUpdatesAt ?? 0).toBeGreaterThan(previousCheckAt);
  });

  test("falls back to unauthenticated SHA check when installation token fails", async () => {
    const t = createTestConvex();
    const { repositoryId, ownerTokenIdentifier } = await insertRepositoryForCheck(t, {
      lastCheckedForUpdatesAt: Date.now() - 120_000,
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("githubInstallations", {
        ownerTokenIdentifier,
        installationId: 12345,
        accountLogin: "acme",
        accountType: "User",
        status: "active",
        repositorySelection: "all",
        connectedAt: Date.now(),
      });
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ object: { sha: "remote-sha-fallback" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.action(api.githubCheck.checkForUpdates, { repositoryId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/repos/acme/repo/git/ref/heads/main");
    expect(options.headers).toMatchObject({
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "systify",
    });
    const authHeader = (options.headers as Record<string, string>).Authorization;
    expect(authHeader).toBeUndefined();
    expect(
      warnSpy.mock.calls.some(
        (args) =>
          args[0] === "[github-check] Failed to get GitHub token:" &&
          (args[1] instanceof Error || typeof args[1] === "string"),
      ),
    ).toBe(true);

    const repository = await t.run(async (ctx) => await ctx.db.get(repositoryId));
    expect(repository?.latestRemoteSha).toBe("remote-sha-fallback");
    expect(repository?.lastCheckedForUpdatesAt ?? 0).toBeGreaterThan(0);
  });

  test("updates remote SHA only when GitHub returns a branch SHA", async () => {
    const t = createTestConvex();
    const { repositoryId, ownerTokenIdentifier } = await insertRepositoryForCheck(t, {
      lastCheckedForUpdatesAt: Date.now() - 120_000,
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: { sha: "remote-sha-1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.action(api.githubCheck.checkForUpdates, { repositoryId });

    const afterFirstCheck = await t.run(async (ctx) => await ctx.db.get(repositoryId));
    expect(afterFirstCheck?.latestRemoteSha).toBe("remote-sha-1");
    const firstCheckedAt = afterFirstCheck?.lastCheckedForUpdatesAt;
    expect(firstCheckedAt).toBeTruthy();

    const resetCheckedAt = Date.now() - 120_000;
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, {
        lastCheckedForUpdatesAt: resetCheckedAt,
      });
    });
    await viewer.action(api.githubCheck.checkForUpdates, { repositoryId });

    const afterSecondCheck = await t.run(async (ctx) => await ctx.db.get(repositoryId));
    expect(afterSecondCheck?.latestRemoteSha).toBe("remote-sha-1");
    expect(afterSecondCheck?.lastCheckedForUpdatesAt ?? 0).toBeGreaterThan(resetCheckedAt);
  });
});
