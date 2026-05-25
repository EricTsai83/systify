import { useParams } from "react-router-dom";
import { RepositoryShell } from "@/components/repository-shell";
import type { ThreadId, WorkspaceId } from "@/lib/types";

/**
 * Discuss service mode entry point.
 *
 * Mounted at:
 *   - `/w/:workspaceId/discuss`              → workspace landing.
 *   - `/w/:workspaceId/discuss/:threadId`    → canonical thread URL.
 */
export function DiscussPage() {
  const params = useParams<{ workspaceId?: string; threadId?: string }>();
  const urlWorkspaceId = (params.workspaceId ?? null) as WorkspaceId | null;
  const urlThreadId = (params.threadId ?? null) as ThreadId | null;

  return <RepositoryShell urlWorkspaceId={urlWorkspaceId} urlThreadId={urlThreadId} />;
}
