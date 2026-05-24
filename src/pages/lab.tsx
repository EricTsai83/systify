import { useParams } from "react-router-dom";
import { RepositoryShell } from "@/components/repository-shell";
import type { ThreadId, WorkspaceId } from "@/lib/types";

/**
 * Lab service mode entry point.
 *
 * Mounted at:
 *   - `/w/:workspaceId/lab`              → workspace landing for Lab;
 *                                          defers to the shell's
 *                                          "most recent thread" behaviour.
 *   - `/w/:workspaceId/lab/:threadId`    → canonical Lab thread URL.
 *
 * Reuses {@link RepositoryShell}. The user-facing distinction between
 * Discuss and Lab is the workspace-mode-switcher highlight and the URL
 * prefix.
 */
export function LabPage() {
  const params = useParams<{ workspaceId?: string; threadId?: string }>();
  const urlWorkspaceId = (params.workspaceId ?? null) as WorkspaceId | null;
  const urlThreadId = (params.threadId ?? null) as ThreadId | null;

  return <RepositoryShell urlWorkspaceId={urlWorkspaceId} urlThreadId={urlThreadId} />;
}
