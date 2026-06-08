import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { recordThreadCreatedInHistory } from "../chat/historyState";
import { getDefaultThreadMode } from "./chatMode";
import { makeRepositoryTitle, parseGitHubUrl, type ParsedGitHubUrl } from "./github";
import { isOwnedBy } from "./ownedDocs";
import { pickNextRepositoryColor, touchRepositoryLastAccessed } from "./repositoryPalette";
import { consumeImportRateLimit, IMPORT_JOB_LEASE_MS, throwOperationAlreadyInProgress } from "./rateLimit";
import { enqueueJob } from "./jobs";

const IMPORT_ACCESS_MODE = "private" as const;
const IMPORT_CANDIDATE_TAKE = 10;

type QueuedRepositoryImport = {
  jobId: Id<"jobs">;
  importId: Id<"imports">;
};

type StartedRepositoryImport = QueuedRepositoryImport & {
  repositoryId: Id<"repositories">;
};

type StartedRepositoryImportWithThread = StartedRepositoryImport & {
  defaultThreadId: Id<"threads">;
  defaultThreadMode: Doc<"threads">["mode"];
};

type OwnerImportContext = {
  ownerTokenIdentifier: string;
};

type PreparedRepositoryForImport = {
  repository: Doc<"repositories">;
  wasCreated: boolean;
};

/**
 * Repository import intake.
 *
 * Registered Convex mutations are the adapters at this seam: they authenticate
 * and check feature access, then delegate the lifecycle for repository import
 * creation, sync, job enqueueing, and default-thread repair here.
 */
export async function startRepositoryImportFromUrl(
  ctx: MutationCtx,
  args: OwnerImportContext & {
    url: string;
    branch?: string;
  },
): Promise<StartedRepositoryImportWithThread> {
  const parsed = parseGitHubUrl(args.url);
  await assertActiveGitHubInstallation(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    missingMessage: "Please connect your GitHub account first to import repositories.",
  });

  const prepared = await prepareRepositoryForImport(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    parsed,
    branch: args.branch,
  });
  const { repository } = prepared;

  if (isRepositoryImportInFlight(repository)) {
    throwOperationAlreadyInProgress(
      "repositoryImportInFlight",
      "An import is already in progress for this repository.",
    );
  }

  await consumeImportRateLimit(ctx, args.ownerTokenIdentifier);

  if (!prepared.wasCreated) {
    await touchRepositoryLastAccessed(ctx, { repositoryId: repository._id });
  }

  const defaultThread = await ensureRepositoryDefaultThread(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repository,
  });

  await ctx.db.patch(repository._id, {
    accessMode: IMPORT_ACCESS_MODE,
    defaultThreadId: defaultThread.defaultThreadId,
  });

  const queued = await enqueueRepositoryImport(ctx, {
    repositoryId: repository._id,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    sourceUrl: parsed.normalizedUrl,
    branch: args.branch ?? parsed.branch ?? repository.defaultBranch,
  });

  return {
    repositoryId: repository._id,
    ...queued,
    ...defaultThread,
  };
}

export async function startRepositorySyncImport(
  ctx: MutationCtx,
  args: OwnerImportContext & {
    repository: Doc<"repositories">;
  },
): Promise<QueuedRepositoryImport> {
  await assertActiveGitHubInstallation(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    missingMessage: "Please connect your GitHub account first to sync repositories.",
  });

  if (isRepositoryImportInFlight(args.repository)) {
    throwOperationAlreadyInProgress("repositoryImportInFlight", "A sync is already in progress for this repository.");
  }

  await consumeImportRateLimit(ctx, args.ownerTokenIdentifier);

  return await enqueueRepositoryImport(ctx, {
    repositoryId: args.repository._id,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    sourceUrl: args.repository.sourceUrl,
    branch: args.repository.defaultBranch,
    clearLatestRemoteSha: true,
  });
}

async function assertActiveGitHubInstallation(
  ctx: MutationCtx,
  args: {
    ownerTokenIdentifier: string;
    missingMessage: string;
  },
): Promise<void> {
  const installation = await ctx.db
    .query("githubInstallations")
    .withIndex("by_ownerTokenIdentifier_and_status", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("status", "active"),
    )
    .first();

  if (!installation) {
    throw new Error(args.missingMessage);
  }
}

async function prepareRepositoryForImport(
  ctx: MutationCtx,
  args: OwnerImportContext & {
    parsed: ParsedGitHubUrl;
    branch?: string;
  },
): Promise<PreparedRepositoryForImport> {
  const existing = await loadReusableRepository(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    sourceUrl: args.parsed.normalizedUrl,
  });

  if (existing) {
    return {
      repository: existing,
      wasCreated: false,
    };
  }

  const color = await pickNextRepositoryColor(ctx, args.ownerTokenIdentifier);
  const repositoryId = await ctx.db.insert("repositories", {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    sourceHost: "github",
    sourceUrl: args.parsed.normalizedUrl,
    sourceRepoFullName: args.parsed.fullName,
    sourceRepoOwner: args.parsed.owner,
    sourceRepoName: args.parsed.repo,
    defaultBranch: args.branch ?? args.parsed.branch,
    visibility: "unknown",
    accessMode: IMPORT_ACCESS_MODE,
    importStatus: "idle",
    detectedLanguages: [],
    packageManagers: [],
    entrypoints: [],
    fileCount: 0,
    color,
    lastAccessedAt: Date.now(),
  });
  const repository = await ctx.db.get(repositoryId);
  if (!repository) {
    throw new Error("Failed to create repository.");
  }
  return {
    repository,
    wasCreated: true,
  };
}

async function loadReusableRepository(
  ctx: MutationCtx,
  args: OwnerImportContext & {
    sourceUrl: string;
  },
): Promise<Doc<"repositories"> | null> {
  const candidates = await ctx.db
    .query("repositories")
    .withIndex("by_ownerTokenIdentifier_and_sourceUrl_and_deletionRequestedAt", (q) =>
      q
        .eq("ownerTokenIdentifier", args.ownerTokenIdentifier)
        .eq("sourceUrl", args.sourceUrl)
        .eq("deletionRequestedAt", undefined),
    )
    .take(IMPORT_CANDIDATE_TAKE);

  const active = candidates.find((row) => row.archivedAt === undefined);
  if (active) {
    return active;
  }

  const archived = candidates
    .filter((row) => typeof row.archivedAt === "number")
    .sort((left, right) => (right.archivedAt ?? 0) - (left.archivedAt ?? 0))[0];
  if (!archived) {
    return null;
  }

  await ctx.db.patch(archived._id, { archivedAt: undefined });
  return await ctx.db.get(archived._id);
}

async function ensureRepositoryDefaultThread(
  ctx: MutationCtx,
  args: OwnerImportContext & {
    repository: Doc<"repositories">;
  },
): Promise<{
  defaultThreadId: Id<"threads">;
  defaultThreadMode: Doc<"threads">["mode"];
}> {
  const defaultThreadRow = args.repository.defaultThreadId ? await ctx.db.get(args.repository.defaultThreadId) : null;
  const defaultThread = defaultThreadRow?.deletionRequestedAt === undefined ? defaultThreadRow : null;

  if (isOwnedBy(defaultThread, args.ownerTokenIdentifier) && defaultThread.repositoryId === args.repository._id) {
    return {
      defaultThreadId: defaultThread._id,
      defaultThreadMode: defaultThread.mode,
    };
  }

  const defaultThreadMode = getDefaultThreadMode(true);
  const defaultThreadId = await ctx.db.insert("threads", {
    repositoryId: args.repository._id,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    title: `${makeRepositoryTitle(args.repository.sourceRepoFullName)} chat`,
    mode: defaultThreadMode,
    lastMessageAt: Date.now(),
  });
  const createdThread = await ctx.db.get(defaultThreadId);
  if (!createdThread) {
    throw new Error("Failed to create default repository thread.");
  }
  await recordThreadCreatedInHistory(ctx, createdThread);

  return {
    defaultThreadId,
    defaultThreadMode,
  };
}

async function enqueueRepositoryImport(
  ctx: MutationCtx,
  args: OwnerImportContext & {
    repositoryId: Id<"repositories">;
    sourceUrl: string;
    branch?: string;
    clearLatestRemoteSha?: boolean;
  },
): Promise<QueuedRepositoryImport> {
  const jobId = await enqueueJob(ctx, {
    kind: "import",
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    costCategory: "indexing",
    triggerSource: "user",
    leaseMs: IMPORT_JOB_LEASE_MS,
  });

  const importId = await ctx.db.insert("imports", {
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    sourceUrl: args.sourceUrl,
    branch: args.branch,
    adapterKind: "git_clone",
    status: "queued",
    jobId,
  });

  await ctx.db.patch(args.repositoryId, {
    importStatus: "queued",
    ...(args.clearLatestRemoteSha ? { latestRemoteSha: undefined } : {}),
  });

  await ctx.scheduler.runAfter(0, internal.importsNode.runImportPipeline, {
    importId,
  });

  return { jobId, importId };
}

function isRepositoryImportInFlight(repository: Doc<"repositories">): boolean {
  return repository.importStatus === "queued" || repository.importStatus === "running";
}
