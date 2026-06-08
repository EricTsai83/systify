/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const { deleteSandboxMock, getRemoteSandboxDetailsMock } = vi.hoisted(() => ({
  deleteSandboxMock: vi.fn(),
  getRemoteSandboxDetailsMock: vi.fn(),
}));

vi.mock("./daytona", () => ({
  deleteSandbox: deleteSandboxMock,
  getRemoteSandboxDetails: getRemoteSandboxDetailsMock,
  isSystifyManagedSandbox: (labels: Record<string, string> | undefined) => labels?.app === "systify",
}));

async function seedRepository(t: ReturnType<typeof convexTest>, ownerTokenIdentifier: string) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: `https://github.com/acme/${ownerTokenIdentifier}`,
      sourceRepoFullName: `acme/${ownerTokenIdentifier}`,
      sourceRepoOwner: "acme",
      sourceRepoName: ownerTokenIdentifier,
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
  });
}

describe("daytona webhook processing", () => {
  beforeEach(() => {
    deleteSandboxMock.mockReset();
    getRemoteSandboxDetailsMock.mockReset();
  });

  test("ingestValidatedEvent deduplicates repeated deliveries", async () => {
    const t = convexTest(schema, modules);

    const first = await t.mutation(internal.daytonaWebhooks.ingestValidatedEvent, {
      dedupeKey: "sandbox.created:remote-1:123:started",
      eventType: "sandbox.created",
      remoteId: "remote-1",
      organizationId: "org-1",
      eventTimestamp: 123,
      normalizedState: "started",
      payloadJson: '{"event":"sandbox.created"}',
    });
    const second = await t.mutation(internal.daytonaWebhooks.ingestValidatedEvent, {
      dedupeKey: "sandbox.created:remote-1:123:started",
      eventType: "sandbox.created",
      remoteId: "remote-1",
      organizationId: "org-1",
      eventTimestamp: 123,
      normalizedState: "started",
      payloadJson: '{"event":"sandbox.created"}',
    });

    expect(first.kind).toBe("enqueued");
    expect(second.kind).toBe("duplicate");

    const storedEvents = await t.run(async (ctx) => {
      return await ctx.db
        .query("daytonaWebhookEvents")
        .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", "sandbox.created:remote-1:123:started"))
        .take(10);
    });
    expect(storedEvents).toHaveLength(1);
  });

  test("processEvent updates known sandbox projection and coarse sandbox state", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t, "user|known-sandbox");
    const now = Date.now();

    const ids = await t.run(async (ctx) => {
      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier: "user|known-sandbox",
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-known",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: now + 60_000,
        autoStopIntervalMinutes: 10,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      const eventId = await ctx.db.insert("daytonaWebhookEvents", {
        dedupeKey: "sandbox.state.updated:remote-known",
        eventType: "sandbox.state.updated",
        remoteId: "remote-known",
        organizationId: "org-1",
        eventTimestamp: now,
        normalizedState: "stopped",
        payloadJson: '{"event":"sandbox.state.updated"}',
        status: "received",
        attemptCount: 0,
        nextAttemptAt: now,
        receivedAt: now,
        retentionExpiresAt: now + 1_000,
      });
      return { sandboxId, eventId };
    });

    const result = await t.mutation(internal.daytonaWebhooks.processEvent, {
      eventId: ids.eventId,
    });

    expect(result.kind).toBe("processed_known");

    const state = await t.run(async (ctx) => ({
      sandbox: await ctx.db.get(ids.sandboxId),
      event: await ctx.db.get(ids.eventId),
      observation: await ctx.db
        .query("sandboxRemoteObservations")
        .withIndex("by_remoteId", (q) => q.eq("remoteId", "remote-known"))
        .unique(),
    }));

    expect(state.sandbox?.status).toBe("stopped");
    expect(state.event?.status).toBe("processed");
    expect(state.observation?.discoveryStatus).toBe("known");
    expect(state.observation?.lastObservedState).toBe("stopped");
  });

  test("processEvent does not advance provisioning sandboxes before clone completes", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t, "user|provisioning-webhook");
    const now = Date.now();

    const ids = await t.run(async (ctx) => {
      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier: "user|provisioning-webhook",
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-provisioning",
        status: "provisioning",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: now + 60_000,
        autoStopIntervalMinutes: 10,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      const eventId = await ctx.db.insert("daytonaWebhookEvents", {
        dedupeKey: "sandbox.state.updated:remote-provisioning",
        eventType: "sandbox.state.updated",
        remoteId: "remote-provisioning",
        organizationId: "org-1",
        eventTimestamp: now,
        normalizedState: "started",
        payloadJson: '{"event":"sandbox.state.updated"}',
        status: "received",
        attemptCount: 0,
        nextAttemptAt: now,
        receivedAt: now,
        retentionExpiresAt: now + 1_000,
      });
      return { sandboxId, eventId };
    });

    const result = await t.mutation(internal.daytonaWebhooks.processEvent, {
      eventId: ids.eventId,
    });

    expect(result.kind).toBe("processed_known");

    const state = await t.run(async (ctx) => ({
      sandbox: await ctx.db.get(ids.sandboxId),
      observation: await ctx.db
        .query("sandboxRemoteObservations")
        .withIndex("by_remoteId", (q) => q.eq("remoteId", "remote-provisioning"))
        .unique(),
    }));

    expect(state.sandbox?.status).toBe("provisioning");
    expect(state.observation?.discoveryStatus).toBe("known");
    expect(state.observation?.lastObservedState).toBe("started");
  });

  test("processEvent does not resurrect failed sandboxes from late started events", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t, "user|failed-webhook");
    const now = Date.now();

    const ids = await t.run(async (ctx) => {
      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier: "user|failed-webhook",
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-failed",
        status: "failed",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: now + 60_000,
        autoStopIntervalMinutes: 10,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
        lastErrorMessage: "Provisioning failed before clone completed.",
      });
      const eventId = await ctx.db.insert("daytonaWebhookEvents", {
        dedupeKey: "sandbox.state.updated:remote-failed",
        eventType: "sandbox.state.updated",
        remoteId: "remote-failed",
        organizationId: "org-1",
        eventTimestamp: now,
        normalizedState: "started",
        payloadJson: '{"event":"sandbox.state.updated"}',
        status: "received",
        attemptCount: 0,
        nextAttemptAt: now,
        receivedAt: now,
        retentionExpiresAt: now + 1_000,
      });
      return { sandboxId, eventId };
    });

    const result = await t.mutation(internal.daytonaWebhooks.processEvent, {
      eventId: ids.eventId,
    });

    expect(result.kind).toBe("processed_known");

    const state = await t.run(async (ctx) => ({
      sandbox: await ctx.db.get(ids.sandboxId),
      observation: await ctx.db
        .query("sandboxRemoteObservations")
        .withIndex("by_remoteId", (q) => q.eq("remoteId", "remote-failed"))
        .unique(),
    }));

    expect(state.sandbox?.status).toBe("failed");
    expect(state.sandbox?.lastErrorMessage).toBe("Provisioning failed before clone completed.");
    expect(state.observation?.discoveryStatus).toBe("known");
    expect(state.observation?.lastObservedState).toBe("started");
  });

  test("processEvent ignores stale out-of-order events", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t, "user|stale-event");
    const newerTimestamp = Date.now();
    const olderTimestamp = newerTimestamp - 10_000;

    const ids = await t.run(async (ctx) => {
      await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier: "user|stale-event",
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-stale",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: newerTimestamp + 60_000,
        autoStopIntervalMinutes: 10,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      await ctx.db.insert("sandboxRemoteObservations", {
        remoteId: "remote-stale",
        organizationId: "org-1",
        lastObservedState: "started",
        lastObservedAt: newerTimestamp,
        lastWebhookAt: newerTimestamp,
        lastAcceptedEventAt: newerTimestamp,
        discoveryStatus: "known",
        firstSeenAt: newerTimestamp,
      });
      const eventId = await ctx.db.insert("daytonaWebhookEvents", {
        dedupeKey: "sandbox.state.updated:remote-stale",
        eventType: "sandbox.state.updated",
        remoteId: "remote-stale",
        organizationId: "org-1",
        eventTimestamp: olderTimestamp,
        normalizedState: "stopped",
        payloadJson: '{"event":"sandbox.state.updated"}',
        status: "received",
        attemptCount: 0,
        nextAttemptAt: olderTimestamp,
        receivedAt: olderTimestamp,
        retentionExpiresAt: olderTimestamp + 1_000,
      });
      return { eventId };
    });

    const result = await t.mutation(internal.daytonaWebhooks.processEvent, {
      eventId: ids.eventId,
    });

    expect(result.kind).toBe("stale_ignored");

    const state = await t.run(async (ctx) => ({
      event: await ctx.db.get(ids.eventId),
      observation: await ctx.db
        .query("sandboxRemoteObservations")
        .withIndex("by_remoteId", (q) => q.eq("remoteId", "remote-stale"))
        .unique(),
    }));

    expect(state.event?.status).toBe("ignored");
    expect(state.observation?.lastObservedState).toBe("started");
    expect(state.observation?.lastAcceptedEventAt).toBe(newerTimestamp);
  });

  test("processEvent accepts equal-timestamp events when dedupe already handled duplicates", async () => {
    const t = convexTest(schema, modules);
    const repositoryId = await seedRepository(t, "user|equal-timestamp");
    const timestamp = Date.now();

    const ids = await t.run(async (ctx) => {
      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier: "user|equal-timestamp",
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-equal",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: timestamp + 60_000,
        autoStopIntervalMinutes: 10,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      await ctx.db.insert("sandboxRemoteObservations", {
        remoteId: "remote-equal",
        sandboxId,
        repositoryId,
        organizationId: "org-1",
        lastObservedState: "started",
        lastObservedAt: timestamp,
        lastWebhookAt: timestamp,
        lastAcceptedEventAt: timestamp,
        discoveryStatus: "known",
        firstSeenAt: timestamp,
      });
      const eventId = await ctx.db.insert("daytonaWebhookEvents", {
        dedupeKey: "sandbox.state.updated:remote-equal",
        eventType: "sandbox.state.updated",
        remoteId: "remote-equal",
        organizationId: "org-1",
        eventTimestamp: timestamp,
        normalizedState: "stopped",
        payloadJson: '{"event":"sandbox.state.updated"}',
        status: "received",
        attemptCount: 0,
        nextAttemptAt: timestamp,
        receivedAt: timestamp,
        retentionExpiresAt: timestamp + 1_000,
      });
      return { sandboxId, eventId };
    });

    const result = await t.mutation(internal.daytonaWebhooks.processEvent, {
      eventId: ids.eventId,
    });

    expect(result.kind).toBe("processed_known");

    const state = await t.run(async (ctx) => ({
      sandbox: await ctx.db.get(ids.sandboxId),
      event: await ctx.db.get(ids.eventId),
      observation: await ctx.db
        .query("sandboxRemoteObservations")
        .withIndex("by_remoteId", (q) => q.eq("remoteId", "remote-equal"))
        .unique(),
    }));

    expect(state.sandbox?.status).toBe("stopped");
    expect(state.event?.status).toBe("processed");
    expect(state.observation?.lastObservedState).toBe("stopped");
    expect(state.observation?.lastAcceptedEventAt).toBe(timestamp);
  });

  test("confirmUnknownRemote deletes confirmed orphan sandboxes", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("sandboxRemoteObservations", {
        remoteId: "remote-orphan",
        organizationId: "org-1",
        lastObservedState: "started",
        lastObservedAt: now - 20_000,
        lastWebhookAt: now - 20_000,
        lastAcceptedEventAt: now - 20_000,
        discoveryStatus: "unknown_pending_confirmation",
        firstSeenAt: now - 20_000,
        confirmAfterAt: now - 1_000,
      });
    });

    getRemoteSandboxDetailsMock.mockResolvedValue({
      exists: true,
      remoteId: "remote-orphan",
      organizationId: "org-1",
      labels: { app: "systify" },
      state: "started",
    });
    deleteSandboxMock.mockResolvedValue(undefined);

    const result = await t.action(internal.daytonaWebhooksNode.confirmUnknownRemote, {
      remoteId: "remote-orphan",
    });

    expect(result.kind).toBe("deleted");
    expect(deleteSandboxMock).toHaveBeenCalledWith("remote-orphan");

    const observation = await t.query(internal.daytonaWebhooks.getObservationByRemoteId, {
      remoteId: "remote-orphan",
    });
    expect(observation?.discoveryStatus).toBe("deleted");
    expect(observation?.deletedAt).toBeTypeOf("number");
  });

  test("confirmUnknownRemote leaves externally managed sandboxes untouched", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("sandboxRemoteObservations", {
        remoteId: "remote-external",
        organizationId: "org-1",
        lastObservedState: "started",
        lastObservedAt: now - 20_000,
        lastWebhookAt: now - 20_000,
        lastAcceptedEventAt: now - 20_000,
        discoveryStatus: "unknown_pending_confirmation",
        firstSeenAt: now - 20_000,
        confirmAfterAt: now - 1_000,
      });
    });

    getRemoteSandboxDetailsMock.mockResolvedValue({
      exists: true,
      remoteId: "remote-external",
      organizationId: "org-1",
      labels: {},
      state: "started",
    });

    const result = await t.action(internal.daytonaWebhooksNode.confirmUnknownRemote, {
      remoteId: "remote-external",
    });

    expect(result.kind).toBe("gone");
    expect(deleteSandboxMock).not.toHaveBeenCalled();

    const observation = await t.query(internal.daytonaWebhooks.getObservationByRemoteId, {
      remoteId: "remote-external",
    });
    expect(observation?.discoveryStatus).toBe("ignored");
    expect(observation?.confirmAfterAt).toBeUndefined();
  });

  test("confirmUnknownRemote ignores observations only after an explicit not-found lookup", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("sandboxRemoteObservations", {
        remoteId: "remote-gone",
        organizationId: "org-1",
        lastObservedState: "destroyed",
        lastObservedAt: now - 20_000,
        lastWebhookAt: now - 20_000,
        lastAcceptedEventAt: now - 20_000,
        discoveryStatus: "unknown_pending_confirmation",
        firstSeenAt: now - 20_000,
        confirmAfterAt: now - 1_000,
      });
    });

    getRemoteSandboxDetailsMock.mockResolvedValue({
      exists: false,
      remoteId: "remote-gone",
      state: "destroyed",
      errorKind: "not_found",
    });

    const result = await t.action(internal.daytonaWebhooksNode.confirmUnknownRemote, {
      remoteId: "remote-gone",
    });

    expect(result.kind).toBe("gone");
    expect(deleteSandboxMock).not.toHaveBeenCalled();

    const observation = await t.query(internal.daytonaWebhooks.getObservationByRemoteId, {
      remoteId: "remote-gone",
    });
    expect(observation?.discoveryStatus).toBe("ignored");
    expect(observation?.confirmAfterAt).toBeUndefined();
  });

  test("confirmUnknownRemote schedules a retry when Daytona lookup fails", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("sandboxRemoteObservations", {
        remoteId: "remote-transient",
        organizationId: "org-1",
        lastObservedState: "started",
        lastObservedAt: now - 20_000,
        lastWebhookAt: now - 20_000,
        lastAcceptedEventAt: now - 20_000,
        discoveryStatus: "unknown_pending_confirmation",
        firstSeenAt: now - 20_000,
        confirmAfterAt: now - 1_000,
      });
    });

    getRemoteSandboxDetailsMock.mockRejectedValue(new Error("temporary Daytona failure"));

    const result = await t.action(internal.daytonaWebhooksNode.confirmUnknownRemote, {
      remoteId: "remote-transient",
    });

    expect(result.kind).toBe("retry_scheduled");
    expect(deleteSandboxMock).not.toHaveBeenCalled();

    const observation = await t.query(internal.daytonaWebhooks.getObservationByRemoteId, {
      remoteId: "remote-transient",
    });
    expect(observation?.discoveryStatus).toBe("unknown_pending_confirmation");
    expect(observation?.confirmAfterAt).toBeGreaterThan(now);
  });

  test("cleanupOldWebhookEvents deletes expired inbox rows", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("daytonaWebhookEvents", {
        dedupeKey: "expired-event",
        eventType: "sandbox.created",
        remoteId: "remote-expired",
        organizationId: "org-1",
        eventTimestamp: now - 10_000,
        normalizedState: "started",
        payloadJson: '{"event":"sandbox.created"}',
        status: "processed",
        attemptCount: 1,
        nextAttemptAt: now - 10_000,
        receivedAt: now - 10_000,
        processedAt: now - 9_000,
        retentionExpiresAt: now - 1_000,
      });
    });

    const result = await t.mutation(internal.daytonaWebhooks.cleanupOldWebhookEvents, {});

    expect(result.deletedCount).toBe(1);

    const remaining = await t.run(async (ctx) => {
      return await ctx.db
        .query("daytonaWebhookEvents")
        .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", "expired-event"))
        .unique();
    });
    expect(remaining).toBeNull();
  });

  test.each(["processed", "ignored", "dead_letter"] as const)(
    "markEventRetryable leaves terminal %s events unchanged",
    async (status) => {
      const t = convexTest(schema, modules);
      const now = Date.now();

      const eventId = await t.run(async (ctx) => {
        return await ctx.db.insert("daytonaWebhookEvents", {
          dedupeKey: `terminal-${status}`,
          eventType: "sandbox.created",
          remoteId: `remote-${status}`,
          organizationId: "org-1",
          eventTimestamp: now - 10_000,
          normalizedState: "started",
          payloadJson: '{"event":"sandbox.created"}',
          status,
          attemptCount: 1,
          nextAttemptAt: now - 10_000,
          receivedAt: now - 10_000,
          processedAt: now - 9_000,
          lastErrorMessage: "original error",
          retentionExpiresAt: now + 60_000,
        });
      });

      await t.mutation(internal.daytonaWebhooks.markEventRetryable, {
        eventId,
        errorMessage: "new error",
        retryAt: now + 30_000,
      });

      const event = await t.run(async (ctx) => {
        return await ctx.db.get(eventId);
      });

      expect(event?.status).toBe(status);
      expect(event?.nextAttemptAt).toBe(now - 10_000);
      expect(event?.processedAt).toBe(now - 9_000);
      expect(event?.lastErrorMessage).toBe("original error");
    },
  );
});
