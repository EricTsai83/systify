/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import type { Doc, Id } from "./_generated/dataModel";
import { getRepositorySandboxStatus, requireRepositorySandbox } from "./lib/repositorySandbox";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type SandboxStatus = Doc<"sandboxes">["status"];

type SandboxSeed = {
  status: SandboxStatus;
  ttlOffsetMs?: number; // relative to now; default +1h
  remoteId?: string;
  repoPath?: string;
};

async function seedRepo(
  t: ReturnType<typeof convexTest>,
  args: { sandbox: SandboxSeed | null },
): Promise<{
  repository: Doc<"repositories">;
  sandboxId: Id<"sandboxes"> | null;
}> {
  return await t.run(async (ctx) => {
    const ownerTokenIdentifier = "tok|fixture";
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/repo-sandbox-fixture",
      sourceRepoFullName: "acme/repo-sandbox-fixture",
      sourceRepoOwner: "acme",
      sourceRepoName: "repo-sandbox-fixture",
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 0,
      color: "blue",
      lastAccessedAt: Date.now(),
    });

    let sandboxId: Id<"sandboxes"> | null = null;
    if (args.sandbox) {
      const ttlExpiresAt = Date.now() + (args.sandbox.ttlOffsetMs ?? 60 * 60_000);
      sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: args.sandbox.remoteId ?? "",
        status: args.sandbox.status,
        workDir: "/workspace",
        repoPath: args.sandbox.repoPath ?? "",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      await ctx.db.patch(repositoryId, { latestSandboxId: sandboxId });
    }

    const repository = await ctx.db.get(repositoryId);
    if (!repository) throw new Error("seedRepo: repository not found after insert");
    return { repository, sandboxId };
  });
}

describe("getRepositorySandboxStatus", () => {
  test("returns available + sandbox row when sandbox is ready and remote metadata is populated", async () => {
    const t = convexTest(schema, modules);
    const { repository, sandboxId } = await seedRepo(t, {
      sandbox: { status: "ready", remoteId: "remote-fixture", repoPath: "/workspace/repo" },
    });

    const result = await t.run(async (ctx) => getRepositorySandboxStatus(ctx, repository));

    expect(result.sandboxModeStatus).toEqual({ reasonCode: "available", message: null });
    expect(Object.keys(result.sandboxModeStatus).sort()).toEqual(["message", "reasonCode"]);
    expect(result.sandbox?._id).toBe(sandboxId);
  });

  // Pins the archived/failed split: archiving is a normal lifecycle event
  // (Daytona auto-archives after the idle interval) and should surface as a
  // warning, while `failed` is a genuine error. Conflating the two caused the
  // top-bar StatusPill to render "Sandbox error" for every archived repo.
  test("archived sandbox surfaces as expired (warning), not unavailable (error)", async () => {
    const t = convexTest(schema, modules);
    const { repository } = await seedRepo(t, { sandbox: { status: "archived" } });

    const result = await t.run(async (ctx) => getRepositorySandboxStatus(ctx, repository));

    expect(result.sandboxModeStatus.reasonCode).toBe("sandbox_expired");
  });

  test("failed sandbox surfaces as unavailable (error)", async () => {
    const t = convexTest(schema, modules);
    const { repository } = await seedRepo(t, { sandbox: { status: "failed" } });

    const result = await t.run(async (ctx) => getRepositorySandboxStatus(ctx, repository));

    expect(result.sandboxModeStatus.reasonCode).toBe("sandbox_unavailable");
  });

  test("ttl-expired ready sandbox surfaces as expired", async () => {
    const t = convexTest(schema, modules);
    const { repository } = await seedRepo(t, {
      sandbox: { status: "ready", ttlOffsetMs: -1_000 },
    });

    const result = await t.run(async (ctx) => getRepositorySandboxStatus(ctx, repository));

    expect(result.sandboxModeStatus.reasonCode).toBe("sandbox_expired");
  });

  test("provisioning sandbox is not available even with remote metadata", async () => {
    const t = convexTest(schema, modules);
    const { repository } = await seedRepo(t, { sandbox: { status: "provisioning" } });

    const result = await t.run(async (ctx) => getRepositorySandboxStatus(ctx, repository));

    expect(result.sandboxModeStatus.reasonCode).toBe("sandbox_provisioning");
  });

  test("ready sandbox without remote metadata surfaces as provisioning", async () => {
    const t = convexTest(schema, modules);
    const { repository } = await seedRepo(t, {
      sandbox: { status: "ready", remoteId: undefined, repoPath: undefined },
    });

    const result = await t.run(async (ctx) => getRepositorySandboxStatus(ctx, repository));

    expect(result.sandboxModeStatus.reasonCode).toBe("sandbox_provisioning");
  });

  test("stopped sandbox surfaces as expired", async () => {
    const t = convexTest(schema, modules);
    const { repository } = await seedRepo(t, { sandbox: { status: "stopped" } });

    const result = await t.run(async (ctx) => getRepositorySandboxStatus(ctx, repository));

    expect(result.sandboxModeStatus.reasonCode).toBe("sandbox_expired");
  });

  test("repository without latestSandboxId surfaces as missing_sandbox with null sandbox row", async () => {
    const t = convexTest(schema, modules);
    const { repository } = await seedRepo(t, { sandbox: null });

    const result = await t.run(async (ctx) => getRepositorySandboxStatus(ctx, repository));

    expect(result.sandboxModeStatus.reasonCode).toBe("missing_sandbox");
    expect(result.sandbox).toBeNull();
  });
});

describe("requireRepositorySandbox", () => {
  test("returns sandbox row when available", async () => {
    const t = convexTest(schema, modules);
    const { repository, sandboxId } = await seedRepo(t, {
      sandbox: { status: "ready", remoteId: "remote-fixture", repoPath: "/workspace/repo" },
    });

    const result = await t.run(async (ctx) => requireRepositorySandbox(ctx, repository));

    expect(result.sandbox._id).toBe(sandboxId);
  });

  test("throws with the classifier's message when sandbox is missing", async () => {
    const t = convexTest(schema, modules);
    const { repository } = await seedRepo(t, { sandbox: null });

    await expect(t.run(async (ctx) => requireRepositorySandbox(ctx, repository))).rejects.toThrow(
      /no sandbox is ready for this repository/,
    );
  });

  test("throws with the classifier's message when sandbox is failed", async () => {
    const t = convexTest(schema, modules);
    const { repository } = await seedRepo(t, { sandbox: { status: "failed" } });

    await expect(t.run(async (ctx) => requireRepositorySandbox(ctx, repository))).rejects.toThrow(/sandbox failed/);
  });
});
