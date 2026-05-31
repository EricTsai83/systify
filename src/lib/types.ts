import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { ChatMode } from "../../convex/lib/chatMode";
import type { ModelCapability, ModelCatalogEntry, ReasoningEffort } from "../../convex/lib/llmCatalog";
import type { LlmProvider } from "../../convex/lib/llmProvider";

export type RepositoryId = Id<"repositories">;
export type ThreadId = Id<"threads">;
/**
 * Stored mode of any thread document (matches the schema-level
 * `threadMode` validator). Alias of {@link ChatMode} — DB literal, URL
 * segment, and UI label are the same word, by design.
 */
export type ThreadMode = Doc<"threads">["mode"];

/**
 * Shared signature for the post-import callback fired by `ImportRepoDialog`.
 * `threadMode` rides alongside `threadId` so the receiving shell can route
 * straight to the canonical mode-aware URL (`/r/:repositoryId/discuss/:tid`)
 * without an intermediate redirect. Carries `null` when the import did not
 * materialise a default thread (the field is purely advisory; the caller
 * falls back to a repository-level destination in that case).
 */
export type OnImportedCallback = (
  repoId: RepositoryId,
  threadId: ThreadId | null,
  threadMode: ThreadMode | null,
) => void;
export type MessageId = Id<"messages">;
export type ArtifactId = Id<"artifacts">;
export type FolderId = Id<"artifactFolders">;
export type SandboxSessionId = Id<"sandboxSessions">;
export type ArtifactChunkId = Id<"artifactChunks">;

export type ArtifactFreshness = "fresh" | "aging" | "stale" | "unverified";

export type ArtifactListItem = Pick<
  Doc<"artifacts">,
  | "_id"
  | "_creationTime"
  | "repositoryId"
  | "threadId"
  | "jobId"
  | "kind"
  | "title"
  | "summary"
  | "version"
  | "folderId"
  | "lastVerifiedAt"
  | "chunkingStatus"
  | "lastChunkedAt"
  | "lastChunkedVersion"
  | "updatedAt"
> & {
  freshness?: ArtifactFreshness;
  importDriftFromLatestSync?: true;
};

/**
 * Canonical chat mode. The frontend type and the schema-level
 * `threads.mode` / `messages.mode` enum share the exact same string
 * literals (`discuss | library`) — no mapping layer, by design.
 * Re-exported here so frontend imports do not have to reach into `convex/`
 * for the type.
 */
export type { ChatMode };

/**
 * LLM provider + catalog types shared by the composer model picker, the
 * chat lifecycle hooks, and the shells that own picker state. Re-exported
 * from the backend modules so frontend imports do not have to reach into
 * `convex/lib/*` directly.
 */
export type { LlmProvider, ModelCapability, ModelCatalogEntry, ReasoningEffort };

export type ActiveMessageStream = {
  assistantMessageId: MessageId;
  content: string;
  /**
   * Live reasoning trace for extended-thinking models. `null` when the
   * model is not reasoning-capable or the trace hasn't started yet.
   */
  reasoning: string | null;
  reasoningStartedAt: number | null;
  reasoningEndedAt: number | null;
  startedAt: number;
  lastAppendedAt: number;
};

export type SandboxModeReasonCode =
  | "available"
  | "missing_sandbox"
  | "sandbox_unavailable"
  | "sandbox_expired"
  | "sandbox_provisioning";

export type SandboxModeStatus = {
  reasonCode: SandboxModeReasonCode;
  message: string | null;
};
