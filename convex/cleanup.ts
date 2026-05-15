/**
 * One-off Convex maintenance mutations.
 *
 * These mutations exist outside the normal app flow — they read raw DB state
 * (bypassing strongly-typed validators) so they can fix or remove rows that
 * the current schema would otherwise reject. Run via the Convex CLI:
 *
 *   npx convex run cleanup:purgeLegacyDeepAnalysisRows
 *
 * Each mutation is idempotent and safe to re-run.
 */

import { internalMutation } from "./_generated/server";

/**
 * Pre-schema-push cleanup for the `deep_analysis` → `system_design` rename.
 *
 * The old code path stored these literals that the new schema no longer
 * accepts:
 *   - `jobs.kind = "deep_analysis"` (System Design generation, FMA, legacy)
 *   - `jobs.costCategory = "deep_analysis"` (above jobs + Lab chat replies)
 *   - `artifacts.kind = "deep_analysis"` (legacy single deep-analysis output)
 *
 * Any surviving row would block `convex dev` from pushing the new schema, so
 * this mutation deletes every job and artifact carrying either literal. The
 * user is on a dev DB with no production data — re-running an import + a
 * fresh System Design generation rebuilds whatever the user actually cares
 * about.
 *
 * Reads scan the full `jobs` and `artifacts` tables — fine for a dev DB
 * with at most a few hundred rows; do not run against a production-sized
 * table without batching.
 */
export const purgeLegacyDeepAnalysisRows = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deletedJobs: number; deletedArtifacts: number }> => {
    const allJobs = await ctx.db.query("jobs").collect();
    let deletedJobs = 0;
    for (const job of allJobs) {
      if ((job.kind as string) === "deep_analysis" || (job.costCategory as string) === "deep_analysis") {
        await ctx.db.delete(job._id);
        deletedJobs += 1;
      }
    }

    const allArtifacts = await ctx.db.query("artifacts").collect();
    let deletedArtifacts = 0;
    for (const artifact of allArtifacts) {
      if ((artifact.kind as string) === "deep_analysis") {
        await ctx.db.delete(artifact._id);
        deletedArtifacts += 1;
      }
    }

    return { deletedJobs, deletedArtifacts };
  },
});
