import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { logInfo, logWarn } from "./lib/observability";

const DAYTONA_WEBHOOK_CONFIRM_WINDOW_MS = 10 * 60_000;
const DAYTONA_WEBHOOK_PROCESSING_LEASE_MS = 2 * 60_000;
const DAYTONA_WEBHOOK_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DAYTONA_WEBHOOK_MAX_ATTEMPTS = 5;
const DAYTONA_WEBHOOK_REPAIR_BATCH_SIZE = 50;
const DAYTONA_WEBHOOK_CLEANUP_BATCH_SIZE = 100;

const eventTypeValidator = v.union(v.literal("sandbox.created"), v.literal("sandbox.state.updated"));
const normalizedStateValidator = v.union(
  v.literal("started"),
  v.literal("stopped"),
  v.literal("archived"),
  v.literal("destroyed"),
  v.literal("error"),
  v.literal("unknown"),
);
const discoveryStatusValidator = v.union(
  v.literal("known"),
  v.literal("unknown_pending_confirmation"),
  v.literal("confirmed_orphan"),
  v.literal("deleted"),
  v.literal("ignored"),
);

function makeProcessedPatch(status: Doc<"daytonaWebhookEvents">["status"], now: number, lastErrorMessage?: string) {
  return {
    status,
    processedAt: now,
    processingLeaseExpiresAt: undefined,
    nextAttemptAt: now,
    lastErrorMessage,
    retentionExpiresAt: now + DAYTONA_WEBHOOK_RETENTION_MS,
  };
}

export const getObservationByRemoteId = internalQuery({
  args: {
    remoteId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sandboxRemoteObservations")
      .withIndex("by_remoteId", (q) => q.eq("remoteId", args.remoteId))
      .unique();
  },
});

export const getSandboxRecordByRemoteId = internalQuery({
  args: {
    remoteId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sandboxes")
      .withIndex("by_remoteId", (q) => q.eq("remoteId", args.remoteId))
      .unique();
  },
});

export const ingestValidatedEvent = internalMutation({
  args: {
    providerDeliveryId: v.optional(v.string()),
    dedupeKey: v.string(),
    eventType: eventTypeValidator,
    remoteId: v.string(),
    organizationId: v.string(),
    eventTimestamp: v.number(),
    normalizedState: v.optional(normalizedStateValidator),
    payloadJson: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("daytonaWebhookEvents")
      .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", args.dedupeKey))
      .unique();

    if (existing) {
      return {
        kind: "duplicate" as const,
        eventId: existing._id,
      };
    }

    const now = Date.now();
    const eventId = await ctx.db.insert("daytonaWebhookEvents", {
      providerDeliveryId: args.providerDeliveryId,
      dedupeKey: args.dedupeKey,
      eventType: args.eventType,
      remoteId: args.remoteId,
      organizationId: args.organizationId,
      eventTimestamp: args.eventTimestamp,
      normalizedState: args.normalizedState,
      payloadJson: args.payloadJson,
      status: "received",
      attemptCount: 0,
      nextAttemptAt: now,
      receivedAt: now,
      retentionExpiresAt: now + DAYTONA_WEBHOOK_RETENTION_MS,
    });

    await ctx.scheduler.runAfter(0, internal.daytonaWebhooks.processEvent, {
      eventId,
    });

    return {
      kind: "enqueued" as const,
      eventId,
    };
  },
});

export const processEvent = internalMutation({
  args: {
    eventId: v.id("daytonaWebhookEvents"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const event = await ctx.db.get(args.eventId);
    if (!event) {
      return { kind: "missing" as const };
    }

    if (event.status === "processed" || event.status === "ignored" || event.status === "dead_letter") {
      return { kind: "terminal" as const };
    }

    if (
      event.status === "processing" &&
      event.processingLeaseExpiresAt !== undefined &&
      event.processingLeaseExpiresAt > now
    ) {
      return { kind: "leased" as const };
    }

    if (event.attemptCount >= DAYTONA_WEBHOOK_MAX_ATTEMPTS) {
      await ctx.db.patch(event._id, makeProcessedPatch("dead_letter", now, event.lastErrorMessage));
      logWarn("webhook", "daytona_webhook_dead_letter", {
        eventId: event._id,
        remoteId: event.remoteId,
        eventType: event.eventType,
      });
      return { kind: "dead_letter" as const };
    }

    const nextAttemptCount = event.attemptCount + 1;
    await ctx.db.patch(event._id, {
      status: "processing",
      attemptCount: nextAttemptCount,
      processingLeaseExpiresAt: now + DAYTONA_WEBHOOK_PROCESSING_LEASE_MS,
      nextAttemptAt: now,
      processedAt: undefined,
    });

    const sandbox = await ctx.db
      .query("sandboxes")
      .withIndex("by_remoteId", (q) => q.eq("remoteId", event.remoteId))
      .unique();
    const observation = await ctx.db
      .query("sandboxRemoteObservations")
      .withIndex("by_remoteId", (q) => q.eq("remoteId", event.remoteId))
      .unique();

    if (observation && event.eventTimestamp < observation.lastAcceptedEventAt) {
      await ctx.db.patch(observation._id, {
        lastWebhookAt: now,
      });
      await ctx.db.patch(event._id, makeProcessedPatch("ignored", now));
      logInfo("webhook", "daytona_webhook_stale_ignored", {
        eventId: event._id,
        remoteId: event.remoteId,
        eventType: event.eventType,
        eventTimestamp: event.eventTimestamp,
        lastAcceptedEventAt: observation.lastAcceptedEventAt,
      });
      return { kind: "stale_ignored" as const };
    }

    const firstSeenAt = observation?.firstSeenAt ?? event.eventTimestamp;

    if (sandbox) {
      if (observation) {
        await ctx.db.patch(observation._id, {
          sandboxId: sandbox._id,
          repositoryId: sandbox.repositoryId,
          organizationId: event.organizationId,
          lastObservedState: event.normalizedState ?? "unknown",
          lastObservedAt: event.eventTimestamp,
          lastWebhookAt: now,
          lastAcceptedEventAt: event.eventTimestamp,
          discoveryStatus: "known",
          firstSeenAt,
          confirmAfterAt: undefined,
          deletedAt: undefined,
        });
      } else {
        await ctx.db.insert("sandboxRemoteObservations", {
          remoteId: event.remoteId,
          sandboxId: sandbox._id,
          repositoryId: sandbox.repositoryId,
          organizationId: event.organizationId,
          lastObservedState: event.normalizedState ?? "unknown",
          lastObservedAt: event.eventTimestamp,
          lastWebhookAt: now,
          lastAcceptedEventAt: event.eventTimestamp,
          discoveryStatus: "known",
          firstSeenAt,
        });
      }

      const sandboxPatch: Partial<Doc<"sandboxes">> = {};
      if (sandbox.status !== "provisioning" && sandbox.status !== "failed") {
        // During on-demand provisioning, the action owns the transition to
        // ready after clone succeeds. Daytona can emit `started` before the
        // repo tree exists; failed rows should likewise require an explicit
        // retry instead of being resurrected by a late state event.
        if (event.normalizedState === "stopped" && sandbox.status !== "archived") {
          sandboxPatch.status = "stopped";
          sandboxPatch.lastUsedAt = now;
        } else if (event.normalizedState === "started" && sandbox.status !== "archived") {
          sandboxPatch.status = "ready";
          sandboxPatch.lastUsedAt = now;
        } else if (
          (event.normalizedState === "archived" || event.normalizedState === "destroyed") &&
          sandbox.status !== "archived"
        ) {
          sandboxPatch.status = "archived";
          sandboxPatch.lastUsedAt = now;
        } else if (event.normalizedState === "error" && sandbox.status !== "archived") {
          sandboxPatch.status = "failed";
          sandboxPatch.lastErrorMessage = "Daytona reported a sandbox error via webhook.";
        }
      }

      if (Object.keys(sandboxPatch).length > 0) {
        await ctx.db.patch(sandbox._id, sandboxPatch);
      }

      await ctx.db.patch(event._id, makeProcessedPatch("processed", now));
      logInfo("webhook", "daytona_webhook_processed", {
        eventId: event._id,
        remoteId: event.remoteId,
        eventType: event.eventType,
        knownSandbox: true,
      });
      return { kind: "processed_known" as const };
    }

    const confirmAfterAt =
      observation?.confirmAfterAt ?? Math.max(now, firstSeenAt + DAYTONA_WEBHOOK_CONFIRM_WINDOW_MS);
    const shouldScheduleConfirm =
      !observation ||
      observation.discoveryStatus !== "unknown_pending_confirmation" ||
      observation.confirmAfterAt === undefined;

    if (observation) {
      await ctx.db.patch(observation._id, {
        organizationId: event.organizationId,
        lastObservedState: event.normalizedState ?? "unknown",
        lastObservedAt: event.eventTimestamp,
        lastWebhookAt: now,
        lastAcceptedEventAt: event.eventTimestamp,
        discoveryStatus: "unknown_pending_confirmation",
        firstSeenAt,
        confirmAfterAt,
        deletedAt: undefined,
      });
    } else {
      await ctx.db.insert("sandboxRemoteObservations", {
        remoteId: event.remoteId,
        organizationId: event.organizationId,
        lastObservedState: event.normalizedState ?? "unknown",
        lastObservedAt: event.eventTimestamp,
        lastWebhookAt: now,
        lastAcceptedEventAt: event.eventTimestamp,
        discoveryStatus: "unknown_pending_confirmation",
        firstSeenAt,
        confirmAfterAt,
      });
    }

    if (shouldScheduleConfirm) {
      await ctx.scheduler.runAfter(
        Math.max(0, confirmAfterAt - now),
        internal.daytonaWebhooksNode.confirmUnknownRemote,
        {
          remoteId: event.remoteId,
        },
      );
    }

    await ctx.db.patch(event._id, makeProcessedPatch("processed", now));
    logInfo("webhook", "daytona_webhook_unknown_remote", {
      eventId: event._id,
      remoteId: event.remoteId,
      eventType: event.eventType,
      confirmAfterAt,
    });
    return { kind: "processed_unknown" as const };
  },
});

export const markObservationKnown = internalMutation({
  args: {
    remoteId: v.string(),
    sandboxId: v.id("sandboxes"),
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const observation = await ctx.db
      .query("sandboxRemoteObservations")
      .withIndex("by_remoteId", (q) => q.eq("remoteId", args.remoteId))
      .unique();
    if (!observation) {
      return;
    }

    await ctx.db.patch(observation._id, {
      sandboxId: args.sandboxId,
      repositoryId: args.repositoryId,
      discoveryStatus: "known",
      confirmAfterAt: undefined,
      deletedAt: undefined,
      lastWebhookAt: Date.now(),
    });
  },
});

export const markObservationDeleted = internalMutation({
  args: {
    remoteId: v.string(),
  },
  handler: async (ctx, args) => {
    const observation = await ctx.db
      .query("sandboxRemoteObservations")
      .withIndex("by_remoteId", (q) => q.eq("remoteId", args.remoteId))
      .unique();
    if (!observation) {
      return;
    }

    await ctx.db.patch(observation._id, {
      sandboxId: undefined,
      repositoryId: undefined,
      discoveryStatus: "deleted",
      confirmAfterAt: undefined,
      deletedAt: Date.now(),
      lastWebhookAt: Date.now(),
    });
  },
});

export const markObservationIgnored = internalMutation({
  args: {
    remoteId: v.string(),
    discoveryStatus: discoveryStatusValidator,
  },
  handler: async (ctx, args) => {
    const observation = await ctx.db
      .query("sandboxRemoteObservations")
      .withIndex("by_remoteId", (q) => q.eq("remoteId", args.remoteId))
      .unique();
    if (!observation) {
      return;
    }

    await ctx.db.patch(observation._id, {
      discoveryStatus: args.discoveryStatus,
      confirmAfterAt: undefined,
      lastWebhookAt: Date.now(),
    });
  },
});

export const retryUnknownRemoteConfirmation = internalMutation({
  args: {
    remoteId: v.string(),
    retryAt: v.number(),
  },
  handler: async (ctx, args) => {
    const observation = await ctx.db
      .query("sandboxRemoteObservations")
      .withIndex("by_remoteId", (q) => q.eq("remoteId", args.remoteId))
      .unique();
    if (!observation || observation.discoveryStatus !== "unknown_pending_confirmation") {
      return;
    }

    await ctx.db.patch(observation._id, {
      confirmAfterAt: args.retryAt,
      lastWebhookAt: Date.now(),
    });
  },
});

export const markEventRetryable = internalMutation({
  args: {
    eventId: v.id("daytonaWebhookEvents"),
    errorMessage: v.string(),
    retryAt: v.number(),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) {
      return;
    }

    if (event.status === "processed" || event.status === "ignored" || event.status === "dead_letter") {
      return;
    }

    const now = Date.now();
    if (event.attemptCount >= DAYTONA_WEBHOOK_MAX_ATTEMPTS) {
      await ctx.db.patch(event._id, makeProcessedPatch("dead_letter", now, args.errorMessage));
      return;
    }

    await ctx.db.patch(event._id, {
      status: "retryable_error",
      processingLeaseExpiresAt: undefined,
      nextAttemptAt: args.retryAt,
      lastErrorMessage: args.errorMessage,
      processedAt: undefined,
    });
  },
});

export const repairBacklog = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const received = await ctx.db
      .query("daytonaWebhookEvents")
      .withIndex("by_status_and_nextAttemptAt", (q) => q.eq("status", "received").lte("nextAttemptAt", now))
      .take(DAYTONA_WEBHOOK_REPAIR_BATCH_SIZE);
    const retryable = await ctx.db
      .query("daytonaWebhookEvents")
      .withIndex("by_status_and_nextAttemptAt", (q) => q.eq("status", "retryable_error").lte("nextAttemptAt", now))
      .take(DAYTONA_WEBHOOK_REPAIR_BATCH_SIZE);
    const expiredProcessing = await ctx.db
      .query("daytonaWebhookEvents")
      .withIndex("by_status_and_processingLeaseExpiresAt", (q) =>
        q.eq("status", "processing").lt("processingLeaseExpiresAt", now),
      )
      .take(DAYTONA_WEBHOOK_REPAIR_BATCH_SIZE);

    const uniqueEventIds = new Set<Id<"daytonaWebhookEvents">>();
    for (const event of [...received, ...retryable, ...expiredProcessing]) {
      uniqueEventIds.add(event._id);
    }

    for (const eventId of uniqueEventIds) {
      await ctx.scheduler.runAfter(0, internal.daytonaWebhooks.processEvent, {
        eventId,
      });
    }

    if (
      received.length === DAYTONA_WEBHOOK_REPAIR_BATCH_SIZE ||
      retryable.length === DAYTONA_WEBHOOK_REPAIR_BATCH_SIZE ||
      expiredProcessing.length === DAYTONA_WEBHOOK_REPAIR_BATCH_SIZE
    ) {
      await ctx.scheduler.runAfter(0, internal.daytonaWebhooks.repairBacklog, {});
    }

    return {
      scheduledCount: uniqueEventIds.size,
    };
  },
});

export const cleanupOldWebhookEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const oldEvents = await ctx.db
      .query("daytonaWebhookEvents")
      .withIndex("by_retentionExpiresAt", (q) => q.lt("retentionExpiresAt", now))
      .take(DAYTONA_WEBHOOK_CLEANUP_BATCH_SIZE);

    for (const event of oldEvents) {
      await ctx.db.delete(event._id);
    }

    if (oldEvents.length === DAYTONA_WEBHOOK_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.daytonaWebhooks.cleanupOldWebhookEvents, {});
    }

    return {
      deletedCount: oldEvents.length,
    };
  },
});
