import { useMemo } from "react";
import type { Doc } from "../../convex/_generated/dataModel";
import { ProfileCard } from "@/components/profile-card";
import { ServiceModeSwitcher } from "@/components/service-mode-switcher";
import { WorkspaceThreadsRail } from "@/components/workspace-threads-rail";
import { WorkspaceSelector } from "@/components/workspace-switcher";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";
import { Logo } from "@/components/logo";
import { useServiceMode } from "@/hooks/use-service-mode";
import type { RepositoryId, ServiceMode, ThreadId, WorkspaceId } from "@/lib/types";

/**
 * Service-mode → thread-mode mapping for the sidebar's thread query. Each
 * service mode owns a single thread mode (Discuss → discuss threads,
 * Library → Library Ask threads, Lab → lab threads); filtering the list
 * by this mode keeps each mode's sidebar from showing the others' threads.
 */
const SERVICE_MODE_TO_THREAD_MODE: Record<ServiceMode, "discuss" | "ask" | "lab"> = {
  discuss: "discuss",
  library: "ask",
  lab: "lab",
};

/**
 * Props are a discriminated union on `suppressThreadNavigation`: the Library
 * IDE page moves thread navigation into the Library shell, so that variant
 * carries only chrome and does not accept (or need) thread-navigation
 * callbacks. Every other surface drives a thread list and must supply them.
 */
type AppSidebarProps = {
  repositories: Doc<"repositories">[] | undefined;
  workspaces: Doc<"workspaces">[] | undefined;
  activeWorkspaceId: WorkspaceId | null;
  onSwitchWorkspace: (id: WorkspaceId) => void;
  onImported: (repoId: RepositoryId, threadId: ThreadId | null, workspaceId: WorkspaceId) => void;
  onError: (message: string | null) => void;
} & (
  | { suppressThreadNavigation: true }
  | {
      suppressThreadNavigation?: false;
      selectedThreadId: ThreadId | null;
      onSelectThread: (id: ThreadId | null) => void;
      onDeleteThread: (id: ThreadId) => void;
    }
);

/**
 * Thread-first sidebar with workspace switcher.
 *
 * Layout, top to bottom:
 *
 *   1. Header — logo + product name. Branding is "Systify".
 *   2. "+ New thread" CTA — creates a thread scoped to the active workspace.
 *   3. Pinned + threads — see {@link WorkspaceThreadsRail}.
 *   5. Footer — profile card + workspace switcher dropdown side-by-side.
 */
export function AppSidebar(props: AppSidebarProps) {
  const { repositories, workspaces, activeWorkspaceId, onSwitchWorkspace, onImported, onError } = props;
  const { serviceMode, availability } = useServiceMode(activeWorkspaceId);
  const threadModeFilter = SERVICE_MODE_TO_THREAD_MODE[serviceMode];

  const activeWorkspace = useMemo(
    () => workspaces?.find((ws) => ws._id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );

  return (
    <Sidebar>
      <SidebarHeader>
        <Logo size={30} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-lg font-semibold tracking-tight">Systify</div>
        </div>
      </SidebarHeader>

      <ServiceModeSwitcher workspaceId={activeWorkspaceId} serviceMode={serviceMode} availability={availability} />

      {props.suppressThreadNavigation ? (
        <SidebarContent className="flex min-h-0 flex-1 flex-col">
          <div className="sr-only">Thread navigation moves into the Library column in this mode.</div>
        </SidebarContent>
      ) : (
        <SidebarContent className="flex min-h-0 flex-1 flex-col">
          <WorkspaceThreadsRail
            workspaceId={activeWorkspaceId}
            repositories={repositories}
            threadMode={threadModeFilter}
            selectedThreadId={props.selectedThreadId}
            onSelectThread={props.onSelectThread}
            onDeleteThread={props.onDeleteThread}
            onError={onError}
            showRepoBadge={!activeWorkspace?.repositoryId}
          />
        </SidebarContent>
      )}

      <SidebarFooter className="px-3 py-2">
        <div className="flex items-center gap-2">
          <ProfileCard />
          <WorkspaceSelector
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSwitchWorkspace={onSwitchWorkspace}
            onImported={onImported}
          />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
