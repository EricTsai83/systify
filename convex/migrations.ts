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
const THREAD_MIGRATION_BATCH_SIZE = 100;
const MESSAGE_MIGRATION_BATCH_SIZE = 200;
const FOLDER_BACKFILL_BATCH_SIZE = 200;

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

/**
 * Phase 3: archive legacy Design Docs threads and move their persisted mode
 * literal to `ask` so the eventual schema narrow has no `docs` rows left.
 *
 * This is intentionally a lock, not a delete. Users can still read the
 * history, but `chat.sendMessage` rejects additional writes and points them
 * at Library Ask / Lab so no new `docs` turns are created during the narrow.
 */
export const lockLegacyDocsThreads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("threads")
      .withIndex("by_mode", (q) => q.eq("mode", "docs"))
      .take(THREAD_MIGRATION_BATCH_SIZE);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_mode", (q) => q.eq("mode", "docs"))
      .take(MESSAGE_MIGRATION_BATCH_SIZE);

    if (rows.length === 0 && messages.length === 0) {
      return { processedThreads: 0, processedMessages: 0, done: true };
    }

    const now = Date.now();
    for (const thread of rows) {
      await ctx.db.patch(thread._id, {
        mode: "ask",
        lockedAt: thread.lockedAt ?? now,
      });
    }
    for (const message of messages) {
      await ctx.db.patch(message._id, { mode: "ask" });
    }

    const hasMore = rows.length === THREAD_MIGRATION_BATCH_SIZE || messages.length === MESSAGE_MIGRATION_BATCH_SIZE;
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.migrations.lockLegacyDocsThreads, {});
      return { processedThreads: rows.length, processedMessages: messages.length, done: false };
    }

    return { processedThreads: rows.length, processedMessages: messages.length, done: true };
  },
});

/**
 * Phase 3: convert legacy `sandbox` rows to the post-restructure `lab`
 * literal. Threads and messages are processed independently so the migration
 * remains bounded and can resume safely.
 */
export const convertSandboxToLab = internalMutation({
  args: {},
  handler: async (ctx) => {
    const sandboxThreads = await ctx.db
      .query("threads")
      .withIndex("by_mode", (q) => q.eq("mode", "sandbox"))
      .take(THREAD_MIGRATION_BATCH_SIZE);
    for (const thread of sandboxThreads) {
      await ctx.db.patch(thread._id, { mode: "lab" });
    }

    const sandboxMessages = await ctx.db
      .query("messages")
      .withIndex("by_mode", (q) => q.eq("mode", "sandbox"))
      .take(MESSAGE_MIGRATION_BATCH_SIZE);
    for (const message of sandboxMessages) {
      await ctx.db.patch(message._id, { mode: "lab" });
    }

    const hasMore =
      sandboxThreads.length === THREAD_MIGRATION_BATCH_SIZE || sandboxMessages.length === MESSAGE_MIGRATION_BATCH_SIZE;
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.migrations.convertSandboxToLab, {});
    }

    return {
      processedThreads: sandboxThreads.length,
      processedMessages: sandboxMessages.length,
      done: !hasMore,
    };
  },
});

export const startLegacyModeMigration = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.migrations.lockLegacyDocsThreads, {});
    await ctx.scheduler.runAfter(0, internal.migrations.convertSandboxToLab, {});
    return { scheduled: true };
  },
});

/**
 * Backfill `pinnedAt` on seeded System Design folders (`systemKey` set) that
 * were created before the folder-pin feature shipped. Post-feature inserts in
 * `ensureSystemDesignFolders` stamp `pinnedAt` at seed time; this migration
 * brings legacy rows up to the same state so existing users see the System
 * Design tree pinned to the top by default — matching the experience a fresh
 * repository gets.
 *
 * Sentinel value: each row gets `pinnedAt = folder._creationTime`, i.e. the
 * moment the folder was actually seeded. This is honest semantically (the
 * folder was conceptually "pinned at seed time") and avoids the lie of
 * stamping `Date.now()` onto rows that have existed for weeks. The navigator
 * currently ignores the timestamp value for ordering (pinned folders sort
 * alphabetically) but the field is still load-bearing for the pinned/unpinned
 * partition; future ordering changes would inherit a sensible value.
 *
 * Bounded via `paginate` so the scan does not need an index dedicated to
 * one-shot migration work. Self-reschedules until `isDone`. Already-patched
 * rows are skipped via the in-handler `pinnedAt === undefined` check, so
 * re-running the migration after deploy is safe.
 */
export const backfillSystemDesignFolderPinnedAt = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("artifactFolders")
      .paginate({ numItems: FOLDER_BACKFILL_BATCH_SIZE, cursor: args.cursor });

    let patched = 0;
    for (const folder of result.page) {
      if (folder.systemKey !== undefined && folder.pinnedAt === undefined) {
        await ctx.db.patch(folder._id, { pinnedAt: folder._creationTime });
        patched += 1;
      }
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillSystemDesignFolderPinnedAt, {
        cursor: result.continueCursor,
      });
    }

    return { processed: result.page.length, patched, done: result.isDone };
  },
});

/**
 * Idempotent entry point for ad-hoc dashboard runs. Kicks off the bounded
 * backfill loop above and returns once the first batch lands; the scheduler
 * carries the cursor forward.
 */
export const startSystemDesignFolderPinnedAtBackfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.migrations.backfillSystemDesignFolderPinnedAt, {
      cursor: null,
    });
    return { scheduled: true };
  },
});
