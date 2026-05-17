import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { ChatMode, ServiceMode } from "../../convex/chatModeResolver";

export type WorkspaceId = Id<"workspaces">;
export type RepositoryId = Id<"repositories">;
export type ThreadId = Id<"threads">;
/**
 * Stored mode of any thread document (matches the schema-level
 * `threadMode` validator). Distinct from {@link ChatMode}, which only
 * covers the three Discuss sub-modes the chat composer exposes to the
 * user — `ThreadMode` is the broader union that includes `ask` and `lab`
 * threads owned by other service modes.
 */
export type ThreadMode = Doc<"threads">["mode"];

/**
 * Shared signature for the post-import callback fired by `ImportRepoDialog`.
 * `threadMode` rides alongside `threadId` so the receiving shell can route
 * straight to the canonical mode-aware URL (`/w/:wid/discuss/:tid`) instead
 * of bouncing through the legacy mode-agnostic redirect. Carries `null` when
 * the import did not materialise a default thread (the field is purely
 * advisory; the caller falls back to a workspace-level destination in that
 * case).
 */
export type OnImportedCallback = (
  repoId: RepositoryId,
  threadId: ThreadId | null,
  workspaceId: WorkspaceId,
  threadMode: ThreadMode | null,
) => void;
export type MessageId = Id<"messages">;
export type ArtifactId = Id<"artifacts">;
export type FolderId = Id<"artifactFolders">;
export type LabSessionId = Id<"labSessions">;
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
  | "source"
  | "version"
  | "folderId"
  | "producedIn"
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
 * UI-level chat mode the user picks in the ChatPanel selector. The frontend
 * type and the schema-level `threads.mode` / `messages.mode` enum share the
 * exact same string literals (`discuss | docs | sandbox`) — there is no
 * mapping layer between them, by design (PRD §"Architectural reversal":
 * "Frontend and backend share the same mode enum"). Re-exported here so
 * frontend imports do not have to reach into `convex/` for the type.
 */
export type { ChatMode };

/**
 * Three-mode restructure — top-level user-intent enum surfaced by the
 * workspace shell's vertical service mode switcher. Re-exported via
 * `lib/types` so frontend code never reaches into `convex/` directly
 * (the project's import boundary).
 */
export type { ServiceMode };

export type ActiveMessageStream = {
  assistantMessageId: MessageId;
  content: string;
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
