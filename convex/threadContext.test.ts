/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const OWNER = "user|thread-context-test";
const OTHER_OWNER = "user|thread-context-other";

/**
 * The Plan-04 feature gate is consulted inside `enrichThreadContext` via
 * `getSandboxFeatureGate(viewer)`, which reads `process.env`. The
 * pre-existing test suite was written before the gate existed and
 * therefore expects the resolver to return its lifecycle-derived shape;
 * to keep those tests honest about *that* contract (separate from the
 * gate), we open the gate for the duration of every test in this file
 * via the wildcard allowlist. Closed-gate behavior is exercised in the
 * dedicated describe block at the bottom.
 */
function withSandboxFeatureGateOpen() {
  let priorEnabled: string | undefined;
  let priorAllowlist: string | undefined;

  beforeEach(() => {
    priorEnabled = process.env.SANDBOX_MODE_ENABLED;
    priorAllowlist = process.env.SANDBOX_BETA_ALLOWLIST;
    process.env.SANDBOX_MODE_ENABLED = "true";
    process.env.SANDBOX_BETA_ALLOWLIST = "*";
  });

  afterEach(() => {
    if (priorEnabled === undefined) {
      delete process.env.SANDBOX_MODE_ENABLED;
    } else {
      process.env.SANDBOX_MODE_ENABLED = priorEnabled;
    }
    if (priorAllowlist === undefined) {
      delete process.env.SANDBOX_BETA_ALLOWLIST;
    } else {
      process.env.SANDBOX_BETA_ALLOWLIST = priorAllowlist;
    }
  });
}

interface SeedOptions {
  withRepository?: boolean;
  sandboxStatus?: "provisioning" | "ready" | "stopped" | "archived" | "failed" | null;
  ownerTokenIdentifier?: string;
}

async function seedThread(
  t: ReturnType<typeof convexTest>,
  options: SeedOptions = {},
): Promise<{
  threadId: Id<"threads">;
  repositoryId: Id<"repositories"> | null;
  sandboxId: Id<"sandboxes"> | null;
}> {
  const owner = options.ownerTokenIdentifier ?? OWNER;
  return await t.run(async (ctx) => {
    let repositoryId: Id<"repositories"> | null = null;
    let sandboxId: Id<"sandboxes"> | null = null;

    if (options.withRepository) {
      repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier: owner,
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
      });

      if (options.sandboxStatus) {
        sandboxId = await ctx.db.insert("sandboxes", {
          repositoryId,
          ownerTokenIdentifier: owner,
          provider: "daytona",
          sourceAdapter: "git_clone",
          remoteId: "remote-1",
          status: options.sandboxStatus,
          workDir: "/work",
          repoPath: "/work/repo",
          cpuLimit: 1,
          memoryLimitGiB: 1,
          diskLimitGiB: 5,
          ttlExpiresAt: Date.now() + 60_000,
          autoStopIntervalMinutes: 10,
          autoArchiveIntervalMinutes: 30,
          autoDeleteIntervalMinutes: 60,
          networkBlockAll: false,
        });

        await ctx.db.patch(repositoryId, { latestSandboxId: sandboxId });
      }
    }

    const threadId = await ctx.db.insert("threads", {
      repositoryId: repositoryId ?? undefined,
      ownerTokenIdentifier: owner,
      title: "thread",
      mode: "discuss",
      lastMessageAt: Date.now(),
    });

    return { threadId, repositoryId, sandboxId };
  });
}

describe("getThreadContext (internal)", () => {
  withSandboxFeatureGateOpen();

  test("returns null when the thread does not exist", async () => {
    const t = convexTest(schema, modules);
    const fakeId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("threads", {
        ownerTokenIdentifier: OWNER,
        title: "temp",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId: fakeId,
    });
    expect(result).toBeNull();
  });

  test("thread without a repository: only discuss mode is available", async () => {
    const t = convexTest(schema, modules);
    const { threadId } = await seedThread(t, { withRepository: false });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result).not.toBeNull();
    expect(result!.attachedRepository).toBeNull();
    expect(result!.sandboxStatus).toBeNull();
    expect(result!.chatModes.availableModes).toEqual(["discuss"]);
    expect(result!.chatModes.defaultMode).toBe("discuss");
    expect(Object.keys(result!.chatModes.disabledReasons).sort()).toEqual(["docs", "sandbox"]);
  });

  test("thread with repository but no sandbox: discuss + docs available", async () => {
    const t = convexTest(schema, modules);
    const { threadId, repositoryId } = await seedThread(t, { withRepository: true });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.attachedRepository?._id).toBe(repositoryId);
    expect(result!.sandboxStatus).toBeNull();
    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.defaultMode).toBe("docs");
    expect(Object.keys(result!.chatModes.disabledReasons)).toEqual(["sandbox"]);
  });

  test("thread with repository and ready sandbox: all three modes available, default docs", async () => {
    const t = convexTest(schema, modules);
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("ready");
    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs", "sandbox"]);
    expect(result!.chatModes.defaultMode).toBe("docs");
    expect(result!.chatModes.disabledReasons).toEqual({});
  });

  test("thread with stopped sandbox maps to expired in resolver input", async () => {
    const t = convexTest(schema, modules);
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "stopped",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("stopped");
    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/expired|provision a new sandbox/i);
  });

  test("thread with archived sandbox maps to expired in resolver input", async () => {
    const t = convexTest(schema, modules);
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "archived",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("archived");
    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/expired|provision a new sandbox/i);
  });

  test("thread with provisioning sandbox surfaces a provisioning hint for sandbox mode", async () => {
    const t = convexTest(schema, modules);
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "provisioning",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("provisioning");
    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/provisioning/i);
  });

  test("thread with failed sandbox surfaces a failed hint for sandbox mode", async () => {
    const t = convexTest(schema, modules);
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "failed",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("failed");
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/failed|provision a new sandbox/i);
  });
});

describe("getThreadContext (public, owner-scoped)", () => {
  withSandboxFeatureGateOpen();

  test("rejects access from a different owner", async () => {
    const t = convexTest(schema, modules);
    const { threadId } = await seedThread(t, {
      withRepository: false,
      ownerTokenIdentifier: OWNER,
    });

    const intruder = t.withIdentity({ tokenIdentifier: OTHER_OWNER });
    await expect(intruder.query(api.threadContext.getThreadContext, { threadId })).rejects.toThrow();
  });

  test("returns the same shape as the internal query for the owner", async () => {
    const t = convexTest(schema, modules);
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
    });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const publicResult = await viewer.query(api.threadContext.getThreadContext, { threadId });
    const internalResult = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(publicResult).not.toBeNull();
    expect(publicResult!.thread._id).toBe(internalResult!.thread._id);
    expect(publicResult!.chatModes).toEqual(internalResult!.chatModes);
  });
});

/**
 * Plan-04 sandbox feature-flag behavior at the thread-context boundary.
 *
 * The resolver tests in `chatModeResolver.test.ts` exercise the gate as a
 * pure function. These tests close the loop by exercising the *env-driven*
 * gate through the actual `internal.threadContext.getThreadContextInternal`
 * call path — proof that `enrichThreadContext` reads the gate per-viewer
 * and applies it.
 */
describe("getThreadContext sandbox feature gate", () => {
  let priorEnabled: string | undefined;
  let priorAllowlist: string | undefined;

  beforeEach(() => {
    priorEnabled = process.env.SANDBOX_MODE_ENABLED;
    priorAllowlist = process.env.SANDBOX_BETA_ALLOWLIST;
    delete process.env.SANDBOX_MODE_ENABLED;
    delete process.env.SANDBOX_BETA_ALLOWLIST;
  });

  afterEach(() => {
    if (priorEnabled === undefined) {
      delete process.env.SANDBOX_MODE_ENABLED;
    } else {
      process.env.SANDBOX_MODE_ENABLED = priorEnabled;
    }
    if (priorAllowlist === undefined) {
      delete process.env.SANDBOX_BETA_ALLOWLIST;
    } else {
      process.env.SANDBOX_BETA_ALLOWLIST = priorAllowlist;
    }
  });

  test("flag off: ready sandbox no longer surfaces sandbox in availableModes", async () => {
    // Default env state (flag unset) — even with a fully-eligible thread,
    // sandbox mode must be hidden. The disabled tooltip explains the
    // private-beta status; the user is not stuck without an explanation.
    const t = convexTest(schema, modules);
    const { threadId } = await seedThread(t, { withRepository: true, sandboxStatus: "ready" });

    const result = await t.query(internal.threadContext.getThreadContextInternal, { threadId });

    expect(result!.sandboxStatus).toBe("ready");
    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/private beta/i);
  });

  test("flag on + viewer in allowlist: ready sandbox is selectable end-to-end", async () => {
    process.env.SANDBOX_MODE_ENABLED = "true";
    process.env.SANDBOX_BETA_ALLOWLIST = OWNER;

    const t = convexTest(schema, modules);
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
      ownerTokenIdentifier: OWNER,
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, { threadId });

    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs", "sandbox"]);
    expect(result!.chatModes.disabledReasons).toEqual({});
  });

  test("flag on + viewer NOT in allowlist: tooltip explains the allowlist requirement", async () => {
    // The internal query evaluates the gate against the *thread owner*
    // (since there is no authenticated viewer in an internal query). With
    // the owner left off the allowlist, the gate closes with the
    // not_allowlisted tooltip — that is the per-viewer signal flowing
    // through the same code the public query uses.
    process.env.SANDBOX_MODE_ENABLED = "true";
    process.env.SANDBOX_BETA_ALLOWLIST = "user|someone-else";

    const t = convexTest(schema, modules);
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
      ownerTokenIdentifier: OWNER,
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, { threadId });

    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/allowlist/i);
  });
});
