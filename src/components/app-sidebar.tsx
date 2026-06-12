import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { Doc } from "../../convex/_generated/dataModel";
import { LibraryAskPanel } from "@/components/library-ask-panel";
import { LibraryTree } from "@/components/library-tree";
import { ProfileCard } from "@/components/profile-card";
import { RepositoryModeSwitcher } from "@/components/repository-mode-switcher";
import { RepositoryThreadsRail, RepolessChatsRail } from "@/components/repository-threads-rail";
import { RepositorySelector } from "@/components/repository-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
  useSidebarLayout,
} from "@/components/ui/sidebar";
import { Logo } from "@/components/logo";
import { resolveEffectiveChatMode, useChatMode } from "@/hooks/use-service-mode";
import { DEFAULT_AUTHENTICATED_PATH } from "@/route-paths";
import type { ArtifactId, ArtifactListItem, OnImportedCallback, RepositoryId, ThreadId, ThreadMode } from "@/lib/types";

const LEFT_SIDEBAR_WIDTH_STORAGE_KEY = "systify.sidebar.width";
const LEFT_SIDEBAR_DEFAULT_WIDTH = 380;
const LEFT_SIDEBAR_MAX_WIDTH = 480;

const LIBRARY_ASK_WIDTH_STORAGE_KEY = "systify.sidebar.width.libraryAsk";
const LIBRARY_ASK_DEFAULT_WIDTH = 400;
const LIBRARY_ASK_MAX_WIDTH = 720;

type AppSidebarLeftProps = {
  repositories: Doc<"repositories">[] | undefined;
  activeRepositoryId: RepositoryId | null;
  onSwitchRepository: (id: RepositoryId) => void;
  onImported: OnImportedCallback;
  onError: (message: string | null) => void;
  selectedThreadId: ThreadId | null;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onDeleteThread: (id: ThreadId) => void;
  /**
   * Lets the active shell own "New thread" navigation. Repository Discuss
   * sends users to its explicit draft route; repoless chat returns to
   * `/chat`. In both cases the backend thread is still created on first send.
   */
  onRequestNewThread?: () => void;
  /**
   * Library-mode payload. The page hoists these so the same artifact query
   * powers the left sidebar's tree, the right sidebar's Ask panel, and the
   * editor — switching modes mounts/unmounts the tree without re-fetching.
   */
  libraryRepositoryId?: RepositoryId | null;
  libraryArtifacts?: ReadonlyArray<ArtifactListItem>;
  libraryActiveArtifactId?: ArtifactId | null;
  onSelectLibraryArtifact?: (id: ArtifactId) => void;
  onGenerate?: () => void;
  importDisabledReason?: string;
  generateDisabledReason?: string;
  isUnseen?: (artifact: ArtifactListItem) => boolean;
};

/**
 * Left repository sidebar — shared across all service modes.
 */
export function AppSidebarLeft(props: AppSidebarLeftProps) {
  const {
    repositories,
    activeRepositoryId,
    onSwitchRepository,
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
    importDisabledReason,
    generateDisabledReason,
    isUnseen,
  } = props;
  const navigate = useNavigate();
  const { mode, availability } = useChatMode(activeRepositoryId);
  const lastMode = useMemo(() => {
    if (!activeRepositoryId || !repositories) return null;
    return repositories.find((repo) => repo._id === activeRepositoryId)?.lastMode ?? null;
  }, [repositories, activeRepositoryId]);
  const effectiveChatMode = resolveEffectiveChatMode({ mode, lastMode, availability });

  const isLibraryMode = effectiveChatMode === "library";
  const { isSheetMode } = useSidebarLayout();
  const { setOpenMobile: setLeftSidebarOpenMobile } = useSidebar("left");

  const handleSwitchRepository = useCallback(
    (repositoryId: RepositoryId) => {
      if (isSheetMode) {
        setLeftSidebarOpenMobile(false);
      }
      onSwitchRepository(repositoryId);
    },
    [isSheetMode, onSwitchRepository, setLeftSidebarOpenMobile],
  );

  const handleSelectNoRepository = useCallback(() => {
    if (isSheetMode) {
      setLeftSidebarOpenMobile(false);
    }
    void navigate(DEFAULT_AUTHENTICATED_PATH);
  }, [isSheetMode, navigate, setLeftSidebarOpenMobile]);

  return (
    <Sidebar
      side="left"
      widthStorageKey={LEFT_SIDEBAR_WIDTH_STORAGE_KEY}
      defaultWidth={LEFT_SIDEBAR_DEFAULT_WIDTH}
      maxWidth={LEFT_SIDEBAR_MAX_WIDTH}
    >
      <SidebarHeader>
        <Logo size={26} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-lg font-semibold tracking-tight">Systify</div>
        </div>
      </SidebarHeader>

      {activeRepositoryId !== null ? (
        <RepositoryModeSwitcher
          repositoryId={activeRepositoryId}
          mode={effectiveChatMode}
          availability={availability}
        />
      ) : null}

      {isLibraryMode && libraryRepositoryId && onSelectLibraryArtifact && onGenerate ? (
        <SidebarContent className="min-h-0 flex-1 overflow-hidden">
          <LibraryTree
            repositoryId={libraryRepositoryId}
            artifacts={libraryArtifacts ?? []}
            selectedArtifactId={libraryActiveArtifactId ?? null}
            onSelectArtifact={onSelectLibraryArtifact}
            onGenerate={onGenerate}
            generateDisabledReason={generateDisabledReason}
            isUnseen={isUnseen}
            className="min-h-0 flex-1"
          />
        </SidebarContent>
      ) : activeRepositoryId === null ? (
        <SidebarContent className="flex min-h-0 flex-1 flex-col">
          <RepolessChatsRail
            selectedThreadId={selectedThreadId}
            onSelectThread={onSelectThread}
            onDeleteThread={onDeleteThread}
            onRequestNewThread={onRequestNewThread}
            onError={onError}
          />
        </SidebarContent>
      ) : (
        <SidebarContent className="flex min-h-0 flex-1 flex-col">
          <RepositoryThreadsRail
            repositoryId={activeRepositoryId}
            repositories={repositories}
            threadMode={effectiveChatMode}
            selectedThreadId={selectedThreadId}
            onSelectThread={onSelectThread}
            onDeleteThread={onDeleteThread}
            onError={onError}
            onRequestNewThread={onRequestNewThread}
          />
        </SidebarContent>
      )}

      <SidebarFooter className="px-3 py-2">
        <div className="flex items-center gap-2">
          <ProfileCard />
          <RepositorySelector
            repositories={repositories}
            activeRepositoryId={activeRepositoryId}
            onSwitchRepository={handleSwitchRepository}
            onSelectNoRepository={handleSelectNoRepository}
            onImported={onImported}
            importDisabledReason={importDisabledReason}
            portalInAnchor={isSheetMode}
          />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

type AppSidebarRightProps = {
  activeRepositoryId: RepositoryId;
  askThreadId: ThreadId | null;
  activeArtifactId: ArtifactId | null;
  /**
   * Whether the repository has at least one indexed artifact. Forwarded
   * to {@link LibraryAskPanel} so the composer locks (and the empty
   * state surfaces a Generate CTA) instead of letting the user hit the
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
  askDisabledReason?: string;
  generateDisabledReason?: string;
  artifactDraftDisabledReason?: string;
  liveSourceStatus?: { kind: "idle" | "preparing" | "ready" | "expiring_soon" };
  premiumModelsDisabledReason?: string;
  highReasoningDisabledReason?: string;
};

/**
 * Right Library-mode sidebar — mounts only in Library.
 */
export function AppSidebarRight({
  activeRepositoryId,
  askThreadId,
  activeArtifactId,
  hasArtifacts,
  onSelectArtifact,
  onSelectAskThread,
  onGenerate,
  askDisabledReason,
  generateDisabledReason,
  artifactDraftDisabledReason,
  liveSourceStatus,
  premiumModelsDisabledReason,
  highReasoningDisabledReason,
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
          repositoryId={activeRepositoryId}
          threadId={askThreadId}
          activeArtifactId={activeArtifactId}
          hasArtifacts={hasArtifacts}
          onSelectArtifact={onSelectArtifact}
          onSelectThread={onSelectAskThread}
          onGenerate={onGenerate}
          askDisabledReason={askDisabledReason}
          generateDisabledReason={generateDisabledReason}
          artifactDraftDisabledReason={artifactDraftDisabledReason}
          liveSourceStatus={liveSourceStatus}
          premiumModelsDisabledReason={premiumModelsDisabledReason}
          highReasoningDisabledReason={highReasoningDisabledReason}
        />
      </div>
    </Sidebar>
  );
}
