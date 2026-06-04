import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { LlmProvider } from "../../convex/lib/llmProvider";
import type { SystifyTestConvex } from "./harness";

const DEFAULT_OWNER = "user|convex-fixture";

type RepositoryRow = Omit<Doc<"repositories">, "_id" | "_creationTime">;
type ThreadRow = Omit<Doc<"threads">, "_id" | "_creationTime">;
type ArtifactFolderRow = Omit<Doc<"artifactFolders">, "_id" | "_creationTime">;
type ArtifactRow = Omit<Doc<"artifacts">, "_id" | "_creationTime">;
type ArtifactKind = Doc<"artifacts">["kind"];

export async function insertTestRepository(
  t: SystifyTestConvex,
  overrides: Partial<RepositoryRow> = {},
): Promise<Id<"repositories">> {
  const now = Date.now();
  const row: RepositoryRow = {
    ownerTokenIdentifier: DEFAULT_OWNER,
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
    color: "blue",
    lastAccessedAt: now,
    ...overrides,
  };

  return await t.run(async (ctx) => await ctx.db.insert("repositories", row));
}

export async function insertTestThread(
  t: SystifyTestConvex,
  overrides: Partial<ThreadRow> = {},
): Promise<Id<"threads">> {
  const row: ThreadRow = {
    ownerTokenIdentifier: DEFAULT_OWNER,
    title: "discussion",
    mode: "discuss",
    lastMessageAt: Date.now(),
    ...overrides,
  };

  return await t.run(async (ctx) => await ctx.db.insert("threads", row));
}

export async function insertTestArtifactFolder(
  t: SystifyTestConvex,
  args: {
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier?: string;
    parentFolderId?: Id<"artifactFolders">;
    name?: string;
    description?: string;
    pinnedAt?: number;
    systemKey?: string;
  },
): Promise<Id<"artifactFolders">> {
  const row: ArtifactFolderRow = {
    ownerTokenIdentifier: args.ownerTokenIdentifier ?? DEFAULT_OWNER,
    repositoryId: args.repositoryId,
    parentFolderId: args.parentFolderId,
    name: args.name ?? "Feature folder",
    description: args.description,
    pinnedAt: args.pinnedAt,
    systemKey: args.systemKey,
  };

  return await t.run(async (ctx) => await ctx.db.insert("artifactFolders", row));
}

export async function insertTestArtifact(
  t: SystifyTestConvex,
  args: {
    ownerTokenIdentifier?: string;
    threadId?: Id<"threads">;
    repositoryId?: Id<"repositories">;
    jobId?: Id<"jobs">;
    kind?: ArtifactKind;
    title?: string;
    summary?: string;
    contentMarkdown?: string;
    version?: number;
    folderId?: Id<"artifactFolders">;
    alignedImportCommitSha?: string;
    lastVerifiedAt?: number;
    chunkingStatus?: ArtifactRow["chunkingStatus"];
    updatedAt?: number;
    generatedByProvider?: LlmProvider;
    generatedByModel?: string;
    promptVersion?: number;
    kindRunId?: Id<"systemDesignKindRuns">;
  },
): Promise<Id<"artifacts">> {
  if (!args.threadId && !args.repositoryId) {
    throw new Error("Test artifact fixture requires threadId or repositoryId.");
  }

  const now = Date.now();
  const row: ArtifactRow = {
    ownerTokenIdentifier: args.ownerTokenIdentifier ?? DEFAULT_OWNER,
    threadId: args.threadId,
    repositoryId: args.repositoryId,
    jobId: args.jobId,
    kind: args.kind ?? "architecture_diagram",
    title: args.title ?? "Diagram 001",
    summary: args.summary ?? "s",
    contentMarkdown: args.contentMarkdown ?? "m",
    version: args.version ?? 1,
    folderId: args.folderId,
    alignedImportCommitSha: args.alignedImportCommitSha,
    lastVerifiedAt: args.lastVerifiedAt ?? now,
    chunkingStatus: args.chunkingStatus ?? (args.repositoryId ? "pending" : undefined),
    updatedAt: args.updatedAt ?? now,
    generatedByProvider: args.generatedByProvider,
    generatedByModel: args.generatedByModel,
    promptVersion: args.promptVersion,
    kindRunId: args.kindRunId,
  };

  return await t.run(async (ctx) => await ctx.db.insert("artifacts", row));
}
