import { useParams } from "react-router-dom";
import { SidebarProvider } from "@/components/ui/sidebar";
import { RepositoryShell } from "@/components/repository-shell";
import type { ThreadId, WorkspaceId } from "@/lib/types";

/**
 * Workspace entry point. The route layer mounts this component at three URLs:
 *
 *   - `/chat`                          → no-selection landing; RepositoryShell
 *                                         redirects into the most recently used
 *                                         workspace's most recent thread.
 *   - `/w/:workspaceId`                → workspace landing; redirects into that
 *                                         workspace's most recent thread or
 *                                         renders the empty state when there
 *                                         are none.
 *   - `/w/:workspaceId/t/:threadId`    → canonical thread URL.
 *
 * The page itself does not read or validate the params; it just hands them to
 * the shell so that workspace-wide URL ↔ state syncing lives in exactly one
 * place. RepositoryShell is responsible for the navigate-to-most-recent-thread
 * fallback and for surfacing a recoverable empty state when a stale or
 * unauthorised id is hit.
 *
 * The repository id is intentionally *not* part of the URL: each repo
 * workspace is 1:1 with its repository, so the shell derives the repo id
 * synchronously from the cached `listWorkspaces` query using `urlWorkspaceId`.
 * Carrying both would invite drift between the two, and the workspace id is
 * the more general handle (the no-repo "Home" workspace exists too).
 */
export function ChatPage() {
  const params = useParams<{ workspaceId?: string; threadId?: string }>();
  const urlWorkspaceId = (params.workspaceId ?? null) as WorkspaceId | null;
  const urlThreadId = (params.threadId ?? null) as ThreadId | null;

  return (
    <SidebarProvider>
      <RepositoryShell urlWorkspaceId={urlWorkspaceId} urlThreadId={urlThreadId} />
    </SidebarProvider>
  );
}
