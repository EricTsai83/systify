import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

/**
 * Three-mode restructure migrations.
 *
 * The plan widens existing tables with optional fields the rest of the
 * application can ignore. The migrations here promote those defaults into
 * concrete values so subsequent code paths can rely on the field being
 * present (rather than reading `undefined` everywhere).
 *
 * Pattern: each migration is an `internalMutation` that scans a bounded page
 * via an indexed query, patches matching rows, then reschedules itself when
 * a full page is consumed. Same self-rescheduling shape used elsewhere in
 * the codebase (`cleanupOrphanedMessages`, `deleteThreadContinuation`) so
 * we don't introduce another moving part for the next person to learn.
 *
 * To start a migration, schedule it from the dashboard or a one-off action:
 *   `await ctx.scheduler.runAfter(0, internal.migrations.backfillArtifactProducedIn, {})`
 * It is idempotent; running twice is safe.
 */

const ARTIFACT_BACKFILL_BATCH_SIZE = 200;

/**
 * Backfill `producedIn` and `chunkingStatus` on every existing artifact.
 *
 * Pre-restructure rows pre-date both columns. We pick `producedIn = "legacy"`
 * (the freshness UI surfaces these as "unverified — legacy") and
 * `chunkingStatus = "pending"` so Phase 2's chunking pipeline sweeps them
 * into the artifact-chunks table on first cron tick. `lastVerifiedAt`,
 * `lastChunkedAt`, and `lastChunkedVersion` stay undefined — they're
 * cumulative counters, not state defaults, and writing dummy values would
 * lie about when the artifact was last verified.
 *
 * Bounded scan via the `by_chunkingStatus` index: rows with
 * `chunkingStatus === undefined` come back from the `q.eq("chunkingStatus",
 * undefined)` filter, which Convex treats as a real index key (the tuple
 * `(undefined)`). Once the migration touches a row it gets `"pending"` and
 * drops out of subsequent scans — so the migration converges even with
 * concurrent writes.
 */
export const backfillArtifactProducedIn = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_chunkingStatus", (q) => q.eq("chunkingStatus", undefined))
      .take(ARTIFACT_BACKFILL_BATCH_SIZE);

    if (rows.length === 0) {
      return { processed: 0, done: true };
    }

    for (const artifact of rows) {
      // `producedIn` and `chunkingStatus` are both optional; we only patch
      // the missing ones so a partial backfill (e.g. a previous run set
      // `producedIn` but failed before `chunkingStatus`) lands cleanly on
      // re-run.
      const patch: { producedIn?: "legacy"; chunkingStatus?: "pending" } = {};
      if (artifact.producedIn === undefined) {
        patch.producedIn = "legacy";
      }
      if (artifact.chunkingStatus === undefined) {
        patch.chunkingStatus = "pending";
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(artifact._id, patch);
      }
    }

    if (rows.length === ARTIFACT_BACKFILL_BATCH_SIZE) {
      // Full page — likely more rows. Reschedule on a fresh transaction
      // so we don't blow Convex's per-mutation budget on large datasets.
      await ctx.scheduler.runAfter(0, internal.migrations.backfillArtifactProducedIn, {});
      return { processed: rows.length, done: false };
    }

    return { processed: rows.length, done: true };
  },
});

/**
 * Idempotent entry point for ad-hoc dashboard runs. Calling this kicks off
 * the bounded-batch loop above and returns once the first batch lands. The
 * scheduler picks up the rest.
 */
export const startArtifactBackfill = internalMutation({
  args: { fromCron: v.optional(v.boolean()) },
  handler: async (ctx, _args) => {
    await ctx.scheduler.runAfter(0, internal.migrations.backfillArtifactProducedIn, {});
    return { scheduled: true };
  },
});

export const backfillArtifactChunks = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.artifactIndexing.backfillPendingArtifactChunks, {});
    return { scheduled: true };
  },
});
