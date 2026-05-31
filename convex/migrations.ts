import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { logInfo } from "./lib/observability";

/**
 * One-off backfill for the `kindFailureReason` widen-backfill-narrow
 * rollout (see `convex/schema.ts` `kindFailureReason` comment).
 *
 * Rewrites every persisted `jobs.kindFailures[].reason === "other"`
 * occurrence to `"transport_other"`. After this mutation completes
 * with `done === true` AND `rewritten === 0` on a fresh full sweep,
 * the operator is safe to deploy the follow-up commit that drops
 * `other` from the `kindFailureReason` union.
 *
 * Operator usage (single batch — manually re-invoke until done):
 *   $ bunx convex run migrations:rewriteLegacyKindFailureReason
 *
 * Operator usage (auto-chain through the table, up to 50 batches per call):
 *   $ bunx convex run migrations:rewriteLegacyKindFailureReason \
 *       '{"maxBatches": 50}'
 *
 * The mutation is paginated by cursor so each invocation processes
 * exactly one page; passing `cursor` resumes from the prior page.
 * `maxBatches > 1` chains continuations via the scheduler so the
 * operator does not have to bookkeep cursors manually.
 *
 * Idempotent on a clean table: re-running after completion returns
 * `rewritten: 0` and walks the table without writes.
 */
const BATCH_SIZE = 200;

export const rewriteLegacyKindFailureReason = internalMutation({
  args: {
    /**
     * Resume cursor from the previous batch's `continueCursor`. Omit
     * on first invocation to start at the beginning of the table.
     * `null` is the canonical "start of table" cursor per Convex
     * pagination.
     */
    cursor: v.optional(v.union(v.string(), v.null())),
    /**
     * Maximum chained continuations this run will schedule via the
     * scheduler. `1` (default) processes a single page and stops.
     * Larger values let the operator launch the sweep with one
     * invocation; bounded at 50 to keep a runaway loop locally
     * recoverable.
     */
    maxBatches: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const maxBatches = Math.max(1, Math.min(args.maxBatches ?? 1, 50));
    const cursor = args.cursor ?? null;
    const page = await ctx.db.query("jobs").paginate({ numItems: BATCH_SIZE, cursor });
    let rewritten = 0;
    let scanned = 0;
    for (const job of page.page) {
      scanned += 1;
      const failures = job.kindFailures;
      if (!failures || failures.length === 0) continue;
      let dirty = false;
      const next = failures.map((entry) => {
        if (entry.reason === "other") {
          dirty = true;
          return { ...entry, reason: "transport_other" as const };
        }
        return entry;
      });
      if (dirty) {
        await ctx.db.patch(job._id, { kindFailures: next });
        rewritten += 1;
      }
    }
    logInfo("migration", "rewriteLegacyKindFailureReason", {
      scanned,
      rewritten,
      done: page.isDone,
      nextCursor: page.continueCursor,
    });
    if (!page.isDone && maxBatches > 1) {
      await ctx.scheduler.runAfter(0, internal.migrations.rewriteLegacyKindFailureReason, {
        cursor: page.continueCursor,
        maxBatches: maxBatches - 1,
      });
    }
    return {
      scanned,
      rewritten,
      done: page.isDone,
      nextCursor: page.continueCursor,
    };
  },
});
