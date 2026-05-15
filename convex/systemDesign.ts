import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { requireActiveRepositoryForOwner } from "./lib/repositoryAccess";
import {
  ensureSystemDesignFolders,
  SYSTEM_DESIGN_KIND_GENERATOR,
  SYSTEM_DESIGN_KIND_TITLES,
  SYSTEM_DESIGN_KIND_TO_FOLDER,
  SYSTEM_DESIGN_KINDS,
  type SystemDesignKind,
} from "./lib/systemDesign";
import { createArtifactInMutation } from "./artifactStore";
import { completeRunningJob, failRunningJob, markQueuedJobRunning, updateRunningJobProgress } from "./jobLifecycle";

/**
 * Library System Design generation entry point.
 *
 * The user opens the Generate System Design dialog from the Library panel,
 * ticks the kinds they want, and submits — this mutation validates the
 * request, ensures the default folder tree exists, creates a tracking job,
 * and schedules the Node action that performs the actual generation.
 *
 * The job uses the existing `deep_analysis` kind because generation is
 * sandbox-backed and LLM-driven; folding it into the existing accounting and
 * cost-cap path keeps the operational surface area small. Progress and final
 * status flow back to the UI through the standard job subscription.
 */
const systemDesignKindValidator = v.union(
  v.literal("manifest"),
  v.literal("readme_summary"),
  v.literal("architecture_overview"),
  v.literal("data_model_overview"),
  v.literal("api_surface_overview"),
  v.literal("deployment_overview"),
  v.literal("security_overview"),
  v.literal("operations_overview"),
);

export const requestSystemDesignGeneration = mutation({
  args: {
    repositoryId: v.id("repositories"),
    selections: v.array(systemDesignKindValidator),
  },
  handler: async (ctx, args): Promise<{ jobId: Id<"jobs"> }> => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await requireActiveRepositoryForOwner(ctx, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    if (args.selections.length === 0) {
      throw new Error("Select at least one document to generate.");
    }

    const uniqueSelections = Array.from(new Set(args.selections)) as SystemDesignKind[];

    await ensureSystemDesignFolders(ctx, {
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    const jobId = await ctx.db.insert("jobs", {
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
      kind: "deep_analysis",
      status: "queued",
      stage: "queued",
      progress: 0,
      costCategory: "deep_analysis",
      triggerSource: "user",
      outputSummary: buildJobSummary(uniqueSelections, "queued"),
    });

    await ctx.scheduler.runAfter(0, internal.systemDesignNode.runSystemDesignGeneration, {
      jobId,
      repositoryId: repository._id,
      ownerTokenIdentifier: identity.tokenIdentifier,
      selections: uniqueSelections,
    });

    return { jobId };
  },
});

/**
 * Listing helper: surface the most recent generation job for the repo so the
 * UI can render the "Generating 3 of 5…" pill above the folder navigator and
 * disable the Generate button while a job is in-flight.
 */
export const getActiveSystemDesignJob = query({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<Doc<"jobs"> | null> => {
    const identity = await requireViewerIdentity(ctx);
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      return null;
    }
    return await mostRecentActiveDesignJob(ctx, args.repositoryId);
  },
});

async function mostRecentActiveDesignJob(ctx: QueryCtx, repositoryId: Id<"repositories">): Promise<Doc<"jobs"> | null> {
  const jobs = await ctx.db
    .query("jobs")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .order("desc")
    .take(20);
  return (
    jobs.find((job) => job.kind === "deep_analysis" && (job.status === "queued" || job.status === "running")) ?? null
  );
}

export const markGenerationStarted = internalMutation({
  args: { jobId: v.id("jobs"), selections: v.array(systemDesignKindValidator) },
  handler: async (ctx, args): Promise<{ started: boolean }> => {
    const result = await markQueuedJobRunning(ctx, {
      jobId: args.jobId,
      expectedKind: "deep_analysis",
      stage: "running",
      progress: 0,
      startedAt: Date.now(),
    });
    if (result) {
      await ctx.db.patch(args.jobId, {
        outputSummary: buildJobSummary(args.selections as SystemDesignKind[], "running"),
      });
    }
    return { started: result !== null };
  },
});

export const updateGenerationProgress = internalMutation({
  args: {
    jobId: v.id("jobs"),
    completedCount: v.number(),
    totalCount: v.number(),
    stage: v.string(),
  },
  handler: async (ctx, args) => {
    const progress = args.totalCount === 0 ? 0 : args.completedCount / args.totalCount;
    await updateRunningJobProgress(ctx, {
      jobId: args.jobId,
      expectedKind: "deep_analysis",
      stage: args.stage,
      progress,
    });
  },
});

export const completeGeneration = internalMutation({
  args: {
    jobId: v.id("jobs"),
    selections: v.array(systemDesignKindValidator),
    succeededCount: v.number(),
    failedCount: v.number(),
  },
  handler: async (ctx, args) => {
    const summary =
      args.failedCount === 0
        ? `Generated ${args.succeededCount} of ${args.selections.length} document${
            args.selections.length === 1 ? "" : "s"
          }.`
        : `Generated ${args.succeededCount} of ${args.selections.length}; ${args.failedCount} failed.`;
    await completeRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "deep_analysis",
      completedAt: Date.now(),
      outputSummary: summary,
      progress: 1,
    });
  },
});

export const failGeneration = internalMutation({
  args: { jobId: v.id("jobs"), errorMessage: v.string() },
  handler: async (ctx, args) => {
    await failRunningJob(ctx, {
      jobId: args.jobId,
      expectedKind: "deep_analysis",
      completedAt: Date.now(),
      errorMessage: args.errorMessage,
    });
  },
});

/**
 * Internal-only query loading the context the Node action needs to run the
 * generators. Returns `null` when the repository is missing or no longer
 * owned by the viewer that scheduled the job — the action treats that as a
 * cancellation and skips work.
 */
export const getGenerationContext = internalQuery({
  args: { repositoryId: v.id("repositories") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    repository: Doc<"repositories">;
    folders: Array<{ systemKey: string; folderId: Id<"artifactFolders"> }>;
    activeSandbox: Doc<"sandboxes"> | null;
  } | null> => {
    const repository = await ctx.db.get(args.repositoryId);
    if (!repository) return null;

    const folders = await ctx.db
      .query("artifactFolders")
      .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
      .collect();

    const activeSandbox = repository.latestSandboxId ? await ctx.db.get(repository.latestSandboxId) : null;

    return {
      repository,
      folders: folders
        .filter((folder) => folder.systemKey !== undefined)
        .map((folder) => ({ systemKey: folder.systemKey as string, folderId: folder._id })),
      activeSandbox,
    };
  },
});

/**
 * Internal-only artifact persister called by the Node action once a kind's
 * markdown is ready. Resolves the destination folder by `systemKey`, replaces
 * any existing artifact of the same kind in the same folder (so re-running
 * the publication overwrites rather than accumulates), and writes the new
 * row through the standard `createArtifactInMutation` path so chunking +
 * indexing kick in automatically.
 */
/**
 * Read every `repoFiles` row for the repo. The heuristic generators in
 * `systemDesignNode.ts` consume this list to recompute languages,
 * entrypoints, and important-file annotations without re-cloning the repo.
 *
 * Bounded by `take(2000)` because Convex queries cannot collect unbounded
 * rows; 2000 is well above the typical small-to-medium repo file count
 * and below the per-transaction read cap. Repositories larger than that
 * will silently lose the tail — acceptable for a heuristic doc, but flagged
 * via a `logWarn` in the action when truncation is detected.
 */
export const listRepoFilesForHeuristics = internalQuery({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<Doc<"repoFiles">[]> => {
    return await ctx.db
      .query("repoFiles")
      .withIndex("by_repositoryId_and_path", (q) => q.eq("repositoryId", args.repositoryId))
      .take(2000);
  },
});

/**
 * Find a single README chunk for the repo so the heuristic README-summary
 * generator can drop a representative excerpt into the artifact. The first
 * `readme`-kinded chunk is sufficient: the import pipeline only writes one
 * chunk per README file at byte zero.
 */
export const findReadmeChunkForHeuristics = internalQuery({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args): Promise<{ path: string; content: string } | null> => {
    const candidates = await ctx.db
      .query("repoChunks")
      .withIndex("by_repositoryId_and_path", (q) => q.eq("repositoryId", args.repositoryId))
      .take(50);
    const readme = candidates.find((row) => row.chunkKind === "readme");
    if (!readme) return null;
    return { path: readme.path, content: readme.content };
  },
});

export const persistGeneratedArtifact = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
    jobId: v.id("jobs"),
    kind: systemDesignKindValidator,
    title: v.string(),
    summary: v.string(),
    contentMarkdown: v.string(),
    source: v.union(v.literal("heuristic"), v.literal("llm"), v.literal("sandbox")),
    alignedImportCommitSha: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ artifactId: Id<"artifacts"> }> => {
    const folderKey = SYSTEM_DESIGN_KIND_TO_FOLDER[args.kind as SystemDesignKind];
    const targetFolder = await ctx.db
      .query("artifactFolders")
      .withIndex("by_repositoryId_and_systemKey", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("systemKey", folderKey),
      )
      .unique();

    if (targetFolder === null) {
      throw new Error(`Destination folder for ${args.kind} (systemKey=${folderKey}) is missing.`);
    }

    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_repositoryId_and_folderId", (q) =>
        q.eq("repositoryId", args.repositoryId).eq("folderId", targetFolder._id),
      )
      .collect();
    const stale = existing.find((row) => row.kind === args.kind);
    if (stale) {
      await ctx.db.delete(stale._id);
    }

    const artifactId = await createArtifactInMutation(ctx, {
      repositoryId: args.repositoryId,
      jobId: args.jobId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      kind: args.kind,
      title: args.title,
      summary: args.summary,
      contentMarkdown: args.contentMarkdown,
      source: args.source,
      folderId: targetFolder._id,
      alignedImportCommitSha: args.alignedImportCommitSha,
    });

    return { artifactId };
  },
});

function buildJobSummary(selections: SystemDesignKind[], state: "queued" | "running"): string {
  const titles = selections.map((kind) => SYSTEM_DESIGN_KIND_TITLES[kind]);
  const verb = state === "queued" ? "Queued" : "Generating";
  if (titles.length === 0) {
    return `${verb} System Design documents`;
  }
  if (titles.length <= 2) {
    return `${verb} ${titles.join(" + ")}`;
  }
  return `${verb} ${titles.length} System Design documents`;
}

/**
 * Convenience export consumed by the dialog catalog so the client doesn't
 * need to re-derive the per-kind metadata table. Co-locating it here keeps
 * the source of truth on the server.
 */
export const SYSTEM_DESIGN_CATALOG = SYSTEM_DESIGN_KINDS.map((kind) => ({
  kind,
  title: SYSTEM_DESIGN_KIND_TITLES[kind],
  generator: SYSTEM_DESIGN_KIND_GENERATOR[kind],
}));
