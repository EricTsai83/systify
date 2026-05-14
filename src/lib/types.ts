import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { ChatMode, ServiceMode } from "../../convex/chatModeResolver";

export type WorkspaceId = Id<"workspaces">;
export type RepositoryId = Id<"repositories">;
export type ThreadId = Id<"threads">;
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
