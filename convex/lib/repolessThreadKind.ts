export type RepolessThreadKind = "agent" | "conversation";

export type RepolessThreadKindSource = {
  agentEnabled?: boolean;
  agentRole?: string | null;
  agentInstructions?: string | null;
};

/**
 * Canonical repoless-thread kind, derived from the persisted DB fields.
 * `agentEnabled` wins when present; legacy rows without it fall back to
 * profile text so older Agent threads keep their identity.
 */
export function getRepolessThreadKind(source: RepolessThreadKindSource): RepolessThreadKind {
  const agentEnabled =
    source.agentEnabled ?? (Boolean(source.agentRole?.trim()) || Boolean(source.agentInstructions?.trim()));
  return agentEnabled ? "agent" : "conversation";
}

export function isRepolessAgentThread(source: RepolessThreadKindSource): boolean {
  return getRepolessThreadKind(source) === "agent";
}

export function getRepolessThreadKindLabel(kind: RepolessThreadKind): "Agent" | "Conversation" {
  return kind === "agent" ? "Agent" : "Conversation";
}
