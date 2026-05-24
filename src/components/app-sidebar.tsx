import { useMemo } from "react";
import type { Doc } from "../../convex/_generated/dataModel";
import { LibraryAskPanel } from "@/components/library-ask-panel";
import { LibraryTree } from "@/components/library-tree";
import { ProfileCard } from "@/components/profile-card";
import { WorkspaceModeSwitcher } from "@/components/workspace-mode-switcher";
import { WorkspaceThreadsRail } from "@/components/workspace-threads-rail";
import { WorkspaceSelector } from "@/components/workspace-switcher";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";
import { Logo } from "@/components/logo";
import { useChatMode } from "@/hooks/use-service-mode";
import type {
  ArtifactId,
  ArtifactListItem,
  ChatMode,
  OnImportedCallback,
  RepositoryId,
  ThreadId,
  ThreadMode,
  WorkspaceId,
} from "@/lib/types";

// Both sidebars share `clampSidebarWidth`'s configured min (240); the left
// sidebar lives at a unified default across all modes so switching modes
// never reshuffles the layout. Library Ask gets its own width memory + a
// roomier ceiling because it carries a full chat surface (thread tabs,
// conversation, composer) where the slim thread rail does not.
const LEFT_SIDEBAR_WIDTH_STORAGE_KEY = "systify.sidebar.width";
const LEFT_SIDEBAR_DEFAULT_WIDTH = 380;
const LEFT_SIDEBAR_MAX_WIDTH = 480;

const LIBRARY_ASK_WIDTH_STORAGE_KEY = "systify.sidebar.width.libraryAsk";
const LIBRARY_ASK_DEFAULT_WIDTH = 400;
const LIBRARY_ASK_MAX_WIDTH = 720;

type AppSidebarLeftProps = {
  repositories: Doc<"repositories">[] | undefined;
  workspaces: Doc<"workspaces">[] | undefined;
  activeWorkspaceId: WorkspaceId | null;
  onSwitchWorkspace: (id: WorkspaceId) => void;
  onImported: OnImportedCallback;
  onError: (message: string | null) => void;
  selectedThreadId: ThreadId | null;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onDeleteThread: (id: ThreadId) => void;
  /**
   * Forwarded to {@link WorkspaceThreadsRail.onRequestNewThread} — when
   * supplied, the "New Thread" button navigates to the workspace mode URL
   * (no thread id) instead of pre-creating an orphan thread. Optional so
   * legacy callers that still want immediate-create can omit it.
   */
  onRequestNewThread?: () => void;
  /**
   * Library-mode payload. The page hoists these so the same artifact query
   * powers the left sidebar's tree, the right sidebar's Ask panel, and the
   * editor — switching modes mounts/unmounts the tree without re-fetching.
   * `null` when the active workspace has no attached repository (the page
   * redirects to Discuss in that case, but the prop is still typed null-safe
   * so the rail variant doesn't need any of the library fields).
   */
  libraryRepositoryId?: RepositoryId | null;
  libraryArtifacts?: ReadonlyArray<ArtifactListItem>;
  libraryActiveArtifactId?: ArtifactId | null;
  onSelectLibraryArtifact?: (id: ArtifactId) => void;
  onGenerate?: () => void;
  isUnseen?: (artifact: ArtifactListItem) => boolean;
};

/**
 * Left workspace sidebar — shared across all service modes.
 *
 * Layout, top to bottom:
 *
 *   1. Header — logo + product name.
 *   2. Service-mode switcher — Discuss / Library / Lab.
 *   3. Content — `LibraryTree` in Library mode (System Design folder tree
 *      with Generate CTA), `WorkspaceThreadsRail` everywhere else.
 *   4. Footer — profile card + workspace switcher dropdown.
 *
 * Width + storage key are unified across modes so switching modes never
 * reshuffles the layout. Library Ask moved out to {@link AppSidebarRight}.
 */
export function AppSidebarLeft(props: AppSidebarLeftProps) {
  const {
    repositories,
    workspaces,
    activeWorkspaceId,
    onSwitchWorkspace,
    onImported,
    onError,
    selectedThreadId,
    onSelectThread,
    onDeleteThread,
    onRequestNewThread,
    libraryRepositoryId,
    libraryArtifacts,
    libraryActiveArtifactId,
    onSelectLibraryArtifact,
    onGenerate,
    isUnseen,
  } = props;
  const { mode, availability } = useChatMode(activeWorkspaceId);
  // `mode` is `null` on transient URLs (`/chat`, `/w/:wid` workspace
  // landing, legacy `/w/:wid/t/:tid`) — fall back to the workspace's intended
  // default so the sidebar paints a stable thread list and WorkspaceModeSwitcher
  // highlight while the canonicalising redirect resolves.
  const effectiveChatMode: ChatMode = mode ?? availability?.defaultMode ?? "discuss";

  const activeWorkspace = useMemo(
    () => workspaces?.find((ws) => ws._id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );

  const isLibraryMode = effectiveChatMode === "library";

  return (
    <Sidebar
      side="left"
      widthStorageKey={LEFT_SIDEBAR_WIDTH_STORAGE_KEY}
      defaultWidth={LEFT_SIDEBAR_DEFAULT_WIDTH}
      maxWidth={LEFT_SIDEBAR_MAX_WIDTH}
    >
      <SidebarHeader>
        <Logo size={30} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-lg font-semibold tracking-tight">Systify</div>
        </div>
      </SidebarHeader>

      <WorkspaceModeSwitcher workspaceId={activeWorkspaceId} mode={effectiveChatMode} availability={availability} />

      {isLibraryMode && libraryRepositoryId && onSelectLibraryArtifact && onGenerate ? (
        <SidebarContent className="min-h-0 flex-1 overflow-hidden">
          <LibraryTree
            repositoryId={libraryRepositoryId}
            artifacts={libraryArtifacts ?? []}
            selectedArtifactId={libraryActiveArtifactId ?? null}
            onSelectArtifact={onSelectLibraryArtifact}
            onGenerate={onGenerate}
            isUnseen={isUnseen}
            className="min-h-0 flex-1"
          />
        </SidebarContent>
      ) : (
        <SidebarContent className="flex min-h-0 flex-1 flex-col">
          <WorkspaceThreadsRail
            workspaceId={activeWorkspaceId}
            repositories={repositories}
            threadMode={effectiveChatMode}
            selectedThreadId={selectedThreadId}
            onSelectThread={onSelectThread}
            onDeleteThread={onDeleteThread}
            onError={onError}
            onRequestNewThread={onRequestNewThread}
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

type AppSidebarRightProps = {
  activeWorkspaceId: WorkspaceId;
  askThreadId: ThreadId | null;
  activeArtifactId: ArtifactId | null;
  /**
   * Whether the workspace has at least one indexed artifact. Forwarded to
   * {@link LibraryAskPanel} so the composer locks (and the empty state
   * surfaces a Generate CTA) instead of letting the user hit the
   * `library_no_artifact` backend gate on submit.
   */
  hasArtifacts: boolean;
  onSelectArtifact: (id: ArtifactId) => void;
  onSelectAskThread: (id: ThreadId | null) => void;
  /**
   * Open the Generate System Design dialog. The page owns the dialog state
   * so the Ask panel and the editor empty state share one dialog instance.
   */
  onGenerate?: () => void;
};

/**
 * Right Library-mode sidebar — mounts only in Library.
 *
 * Carries the full Library Ask surface (thread tabs, conversation, composer,
 * history popover). No header/footer chrome — the panel ships its own. Width
 * + storage key are independent of the left sidebar so users can size the
 * two surfaces separately.
 */
export function AppSidebarRight({
  activeWorkspaceId,
  askThreadId,
  activeArtifactId,
  hasArtifacts,
  onSelectArtifact,
  onSelectAskThread,
  onGenerate,
}: AppSidebarRightProps) {
  return (
    <Sidebar
      side="right"
      widthStorageKey={LIBRARY_ASK_WIDTH_STORAGE_KEY}
      defaultWidth={LIBRARY_ASK_DEFAULT_WIDTH}
      maxWidth={LIBRARY_ASK_MAX_WIDTH}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <LibraryAskPanel
          workspaceId={activeWorkspaceId}
          threadId={askThreadId}
          activeArtifactId={activeArtifactId}
          hasArtifacts={hasArtifacts}
          onSelectArtifact={onSelectArtifact}
          onSelectThread={onSelectAskThread}
          onGenerate={onGenerate}
        />
      </div>
    </Sidebar>
  );
}
