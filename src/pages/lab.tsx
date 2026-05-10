import { useParams } from "react-router-dom";
import { SidebarProvider } from "@/components/ui/sidebar";
import { RepositoryShell } from "@/components/repository-shell";
import type { ThreadId, WorkspaceId } from "@/lib/types";

/**
 * Three-mode restructure — Lab service mode entry point.
 *
 * Mounted at:
 *   - `/w/:workspaceId/lab`              → workspace landing for Lab.
 *                                           Phase 2 will route to the
 *                                           workspace's active lab
 *                                           session here; Phase 1 simply
 *                                           defers to the shell's
 *                                           "most recent thread"
 *                                           behaviour.
 *   - `/w/:workspaceId/lab/:threadId`    → canonical Lab thread URL.
 *
 * Phase 1 reuses {@link RepositoryShell}. The user-facing distinction
 * between Discuss and Lab in v1 is the service-mode-switcher highlight
 * and the URL prefix; Phase 2 layers in the LabStatusBar (running-time,
 * cost, pause/stop), the Lab session lifecycle, and the explicit
 * sandbox-confirm dialog.
 */
export function LabPage() {
  const params = useParams<{ workspaceId?: string; threadId?: string }>();
  const urlWorkspaceId = (params.workspaceId ?? null) as WorkspaceId | null;
  const urlThreadId = (params.threadId ?? null) as ThreadId | null;

  return (
    <SidebarProvider>
      <RepositoryShell urlWorkspaceId={urlWorkspaceId} urlThreadId={urlThreadId} />
    </SidebarProvider>
  );
}
