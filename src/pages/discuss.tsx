import { useParams } from "react-router-dom";
import { SidebarProvider } from "@/components/ui/sidebar";
import { RepositoryShell } from "@/components/repository-shell";
import type { ThreadId, WorkspaceId } from "@/lib/types";

/**
 * Three-mode restructure — Discuss service mode entry point.
 *
 * Mounted at:
 *   - `/w/:workspaceId/discuss`              → workspace landing for
 *                                               Discuss; the shell picks
 *                                               the most recent discuss
 *                                               thread or shows the
 *                                               empty state.
 *   - `/w/:workspaceId/discuss/:threadId`    → canonical thread URL.
 *
 * Phase 1 reuses {@link RepositoryShell} as-is. The shell already knows
 * how to resolve workspace + thread params and render the chat panel —
 * the only difference for Discuss is the URL prefix the
 * service-mode-switcher highlights. Phase 2 swaps the heavy shell for a
 * dedicated Discuss shell once the Lab session lifecycle lands and the
 * service modes diverge meaningfully.
 */
export function DiscussPage() {
  const params = useParams<{ workspaceId?: string; threadId?: string }>();
  const urlWorkspaceId = (params.workspaceId ?? null) as WorkspaceId | null;
  const urlThreadId = (params.threadId ?? null) as ThreadId | null;

  return (
    <SidebarProvider>
      <RepositoryShell urlWorkspaceId={urlWorkspaceId} urlThreadId={urlThreadId} />
    </SidebarProvider>
  );
}
