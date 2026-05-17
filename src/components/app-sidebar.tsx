import { useMemo, type ReactNode } from "react";
import type { Doc } from "../../convex/_generated/dataModel";
import { LibraryAskPanel } from "@/components/library-ask-panel";
import { ProfileCard } from "@/components/profile-card";
import { ServiceModeSwitcher } from "@/components/service-mode-switcher";
import { WorkspaceThreadsRail } from "@/components/workspace-threads-rail";
import { WorkspaceSelector } from "@/components/workspace-switcher";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";
import { Logo } from "@/components/logo";
import { useServiceMode } from "@/hooks/use-service-mode";
import type { ArtifactId, OnImportedCallback, ServiceMode, ThreadId, ThreadMode, WorkspaceId } from "@/lib/types";

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
 * Library Ask gets its own width memory + a roomier default — it carries a
 * full chat surface (thread tabs, conversation, composer) where Discuss/Lab
 * show only the slim thread rail. Still resizable within the shared bounds.
 */
const LIBRARY_ASK_WIDTH_STORAGE_KEY = "systify.sidebar.width.libraryAsk";
const LIBRARY_ASK_DEFAULT_WIDTH = 360;
// Library Ask hosts the chat surface in the sidebar, so its resize ceiling is
// raised above the shared cap to give the conversation/composer more room.
const LIBRARY_ASK_MAX_WIDTH = 720;

/**
 * Props are a discriminated union on `variant`:
 *
 *   - `"threads"` (default) — Discuss/Lab. The content slot is the
 *     workspace thread rail, so the caller supplies thread-navigation
 *     callbacks.
 *   - `"libraryAsk"` — Library. The content slot is the full Library Ask
 *     panel (thread tabs, conversation, composer), so the caller supplies
 *     the active Ask thread + artifact wiring instead.
 *
 * The type system enforces the boundary — neither variant can be handed
 * the other's callbacks.
 */
type AppSidebarProps = {
  repositories: Doc<"repositories">[] | undefined;
  workspaces: Doc<"workspaces">[] | undefined;
  activeWorkspaceId: WorkspaceId | null;
  onSwitchWorkspace: (id: WorkspaceId) => void;
  onImported: OnImportedCallback;
  onError: (message: string | null) => void;
} & (
  | {
      variant?: "threads";
      selectedThreadId: ThreadId | null;
      onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
      onDeleteThread: (id: ThreadId) => void;
    }
  | {
      variant: "libraryAsk";
      askThreadId: ThreadId | null;
      activeArtifactId: ArtifactId | null;
      onSelectArtifact: (id: ArtifactId) => void;
      onSelectAskThread: (id: ThreadId | null) => void;
    }
);

/**
 * Workspace sidebar with the service-mode switcher.
 *
 * Layout, top to bottom:
 *
 *   1. Header — logo + product name. Branding is "Systify".
 *   2. Service-mode switcher — Discuss / Library / Lab.
 *   3. Content — the workspace thread rail (Discuss/Lab, see
 *      {@link WorkspaceThreadsRail}) or the full Library Ask panel
 *      (Library, see {@link LibraryAskPanel}); selected by `variant`.
 *   4. Footer — profile card + workspace switcher dropdown side-by-side.
 */
export function AppSidebar(props: AppSidebarProps) {
  const { repositories, workspaces, activeWorkspaceId, onSwitchWorkspace, onImported, onError } = props;
  const { serviceMode, availability } = useServiceMode(activeWorkspaceId);
  // `serviceMode` is `null` on transient URLs (`/chat`, `/w/:wid` workspace
  // landing, legacy `/w/:wid/t/:tid`) — fall back to the workspace's intended
  // default so the sidebar can paint a stable thread list and ServiceModeSwitcher
  // highlight while the canonicalising redirect resolves. Once the URL settles
  // on a canonical mode prefix the URL value takes over again.
  const effectiveServiceMode: ServiceMode = serviceMode ?? availability?.defaultServiceMode ?? "discuss";
  const threadModeFilter = SERVICE_MODE_TO_THREAD_MODE[effectiveServiceMode];

  const activeWorkspace = useMemo(
    () => workspaces?.find((ws) => ws._id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );

  const isLibraryAsk = props.variant === "libraryAsk";

  let content: ReactNode;
  if (props.variant === "libraryAsk") {
    // `LibraryAskPanel` needs a concrete workspace. On the Library route
    // `activeWorkspaceId` is always set, but guard so null never reaches it.
    content =
      activeWorkspaceId !== null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <LibraryAskPanel
            workspaceId={activeWorkspaceId}
            threadId={props.askThreadId}
            activeArtifactId={props.activeArtifactId}
            onSelectArtifact={props.onSelectArtifact}
            onSelectThread={props.onSelectAskThread}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col" />
      );
  } else {
    content = (
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
    );
  }

  return (
    <Sidebar
      widthStorageKey={isLibraryAsk ? LIBRARY_ASK_WIDTH_STORAGE_KEY : undefined}
      defaultWidth={isLibraryAsk ? LIBRARY_ASK_DEFAULT_WIDTH : undefined}
      maxWidth={isLibraryAsk ? LIBRARY_ASK_MAX_WIDTH : undefined}
    >
      <SidebarHeader>
        <Logo size={30} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-lg font-semibold tracking-tight">Systify</div>
        </div>
      </SidebarHeader>

      <ServiceModeSwitcher
        workspaceId={activeWorkspaceId}
        serviceMode={effectiveServiceMode}
        availability={availability}
      />

      {content}

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
