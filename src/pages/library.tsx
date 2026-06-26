import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import {
  BookOpenIcon,
  CaretDownIcon,
  CircleIcon,
  FoldersIcon,
  LightningIcon,
  PaperPlaneTiltIcon,
  SparkleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import {
  AppSidebarLeft,
  AppSidebarRight,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_WIDTH_STORAGE_KEY,
  LIBRARY_ASK_DEFAULT_WIDTH,
  LIBRARY_ASK_MAX_WIDTH,
  LIBRARY_ASK_WIDTH_STORAGE_KEY,
} from "@/components/app-sidebar";
import { GenerateSystemDesignDialog } from "@/components/generate-system-design-dialog";
import { LibraryShell } from "@/components/library-shell";
import { LibraryTree } from "@/components/library-tree";
import { Logo } from "@/components/logo";
import { RepositoryModeSwitcher } from "@/components/repository-mode-switcher";
import { ScreenState } from "@/components/screen-state";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { useArtifactViewState } from "@/hooks/use-artifact-view-state";
import { useLibraryTabs } from "@/hooks/use-library-tabs";
import { isViewerFeatureEnabled, useViewerAccess } from "@/hooks/use-viewer-access";
import {
  DEFAULT_AUTHENTICATED_PATH,
  libraryPath,
  modeAwareThreadPath,
  repositoryPath,
  withLibraryAskParam,
} from "@/route-paths";
import type { ArtifactId, RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
import { readString, writeString } from "@/lib/storage";
import { applyTouchRepositoryOptimistic } from "@/lib/repository-mutations";
import { DEMO_MODE_COPY } from "@/lib/demo-content";
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const ACTIVE_REPOSITORY_STORAGE_KEY = "systify.activeRepositoryId";
const PENDING_LIBRARY_ASK_SEND_BUTTON_STATES = ["Ask", "Asking..."] as const;

/**
 * Library service mode entry point.
 *
 * Mounted at:
 *   - `/r/:repositoryId/library`               → docs navigator.
 *   - `/r/:repositoryId/library/a/:artifactId` → shell with the artifact
 *                                                open in the active tab.
 *
 * The active Library Ask thread is carried as a `?ask=:threadId` query
 * param on either of those URLs.
 */
export function LibraryPage() {
  const params = useParams<{ repositoryId?: string; artifactId?: string }>();
  const [searchParams] = useSearchParams();
  const urlRepositoryId = (params.repositoryId ?? null) as RepositoryId | null;
  const urlArtifactId = (params.artifactId ?? null) as ArtifactId | null;
  const urlAskThreadId = (searchParams.get("ask") ?? null) as ThreadId | null;

  if (!urlRepositoryId) {
    return (
      <ScreenState
        title="Missing repository"
        description="The link is missing a repository id. Return to your chat to continue."
      />
    );
  }

  return <LibraryRepository repositoryId={urlRepositoryId} artifactId={urlArtifactId} askThreadId={urlAskThreadId} />;
}

function LibraryRepository({
  repositoryId,
  artifactId,
  askThreadId,
}: {
  repositoryId: RepositoryId;
  artifactId: ArtifactId | null;
  askThreadId: ThreadId | null;
}) {
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const viewerAccess = useViewerAccess();

  const repositories = useQuery(api.repositoryPreferences.listRepositoriesForSwitcher);
  const authorizedRepositoryIds = useQuery(api.repositoryPreferences.listOwnedRepositoryIdsById, {
    repositoryIds: [repositoryId],
  });
  const baseTouchRepository = useMutation(api.repositoryPreferences.touchRepository);
  const touchRepository = useMemo(
    () => baseTouchRepository.withOptimisticUpdate(applyTouchRepositoryOptimistic),
    [baseTouchRepository],
  );

  const isAuthorizedForRepository = useMemo(() => {
    if (authorizedRepositoryIds === undefined) return null;
    return (authorizedRepositoryIds as ReadonlyArray<string>).includes(repositoryId);
  }, [authorizedRepositoryIds, repositoryId]);
  const canLoadRepositoryData = isAuthorizedForRepository === true;

  useEffect(() => {
    if (!repositoryId) return;
    // Avoid persisting an active-repository pointer (or touching the server)
    // before we know the viewer is authorized for this repo. Otherwise a
    // stale URL would poison localStorage and trip a server error.
    if (isAuthorizedForRepository !== true) return;
    writeString(ACTIVE_REPOSITORY_STORAGE_KEY, repositoryId);
    void touchRepository({ repositoryId, mode: "library" }).catch(() => {});
  }, [touchRepository, repositoryId, isAuthorizedForRepository]);

  const currentRepository = useMemo(
    () => repositories?.find((repo) => repo._id === repositoryId) ?? null,
    [repositories, repositoryId],
  );
  const hasLocalRepositoryIntent = readString(ACTIVE_REPOSITORY_STORAGE_KEY) === repositoryId;

  const tabs = useLibraryTabs(canLoadRepositoryData ? repositoryId : null, canLoadRepositoryData ? artifactId : null);

  const allArtifacts = useQuery(
    api.artifacts.listMetadataByRepositoryWithFreshness,
    canLoadRepositoryData ? { repositoryId } : "skip",
  );
  const sandboxActivityStatus = useQuery(
    api.repositories.getSandboxActivityStatus,
    canLoadRepositoryData ? { repositoryId } : "skip",
  );
  const { isUnseen, markViewed } = useArtifactViewState(canLoadRepositoryData ? repositoryId : null);

  const hasArtifacts = allArtifacts === undefined ? undefined : allArtifacts.length > 0;

  useEffect(() => {
    if (!canLoadRepositoryData) return;
    if (tabs.activeArtifactId) {
      markViewed(tabs.activeArtifactId);
    }
  }, [canLoadRepositoryData, tabs.activeArtifactId, markViewed]);

  const [isGenerateDialogOpen, setIsGenerateDialogOpen] = useState(false);
  const openGenerateDialog = useCallback(() => setIsGenerateDialogOpen(true), []);
  const accessLoadingReason = viewerAccess === undefined ? "Loading access…" : undefined;
  const importDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "repoImport") ? undefined : DEMO_MODE_COPY.importDisabled);
  const libraryAskDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "libraryAsk") ? undefined : DEMO_MODE_COPY.libraryAskDisabled);
  const generateSystemDesignDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "generateSystemDesign")
      ? isViewerFeatureEnabled(viewerAccess, "sandboxGrounding")
        ? undefined
        : DEMO_MODE_COPY.sandboxDisabled
      : DEMO_MODE_COPY.generateDisabled);
  const premiumModelsDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "premiumModels") ? undefined : DEMO_MODE_COPY.premiumModelsDisabled);
  const highReasoningDisabledReason =
    accessLoadingReason ??
    (isViewerFeatureEnabled(viewerAccess, "highReasoning") ? undefined : DEMO_MODE_COPY.highReasoningDisabled);
  const artifactDraftDisabledReason = libraryAskDisabledReason ?? generateSystemDesignDisabledReason;

  const handleSwitchRepository = useCallback(
    (id: RepositoryId) => {
      void navigate(repositoryPath(id));
    },
    [navigate],
  );

  const handleSelectLibraryThread = useCallback(
    (threadId: ThreadId | null, options?: { replace?: boolean }) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (threadId) {
            next.set("ask", threadId);
          } else {
            next.delete("ask");
          }
          return next;
        },
        { replace: options?.replace ?? false },
      );
    },
    [setSearchParams],
  );

  const handleRailError = useCallback((message: string | null) => {
    if (!message) return;
    toast.error(message);
  }, []);
  const handleImported = useCallback(
    (importedRepositoryId: RepositoryId, threadId: ThreadId | null, threadMode: ThreadMode | null) => {
      if (threadId && threadMode) {
        void navigate(modeAwareThreadPath(importedRepositoryId, threadId, threadMode));
      } else {
        void navigate(libraryPath(importedRepositoryId));
      }
    },
    [navigate],
  );

  // Library only renders when the viewer owns the URL repository. Use the
  // complete owner-repo set (not the recency-limited switcher list) so a
  // repo outside the top-20 cache isn't mistakenly bounced to the landing.
  useEffect(() => {
    if (isAuthorizedForRepository === null) return;
    if (!isAuthorizedForRepository) {
      void navigate(DEFAULT_AUTHENTICATED_PATH, { replace: true });
    }
  }, [isAuthorizedForRepository, navigate]);

  const artifactProbe = useQuery(api.artifacts.getById, canLoadRepositoryData && artifactId ? { artifactId } : "skip");
  useEffect(() => {
    if (!artifactId) return;
    if (repositories === undefined || !currentRepository) return;
    if (artifactProbe === undefined) return;
    if (artifactProbe === null || artifactProbe.repositoryId !== repositoryId) {
      void navigate(withLibraryAskParam(libraryPath(repositoryId), askThreadId), { replace: true });
    }
  }, [artifactId, artifactProbe, askThreadId, currentRepository, navigate, repositoryId, repositories]);

  const askThreadProbe = useQuery(
    api.chat.threads.getThreadSummary,
    canLoadRepositoryData && askThreadId ? { threadId: askThreadId } : "skip",
  );
  useEffect(() => {
    if (!askThreadId) return;
    if (askThreadProbe === undefined) return;
    if (askThreadProbe === null || askThreadProbe.repositoryId !== repositoryId || askThreadProbe.mode !== "library") {
      handleSelectLibraryThread(null, { replace: true });
    }
  }, [askThreadId, askThreadProbe, handleSelectLibraryThread, repositoryId]);

  if (isAuthorizedForRepository === null && (hasLocalRepositoryIntent || currentRepository)) {
    return (
      <PendingLibraryShell
        repositoryId={repositoryId}
        repositoryName={currentRepository?.sourceRepoFullName ?? "Library"}
      />
    );
  }
  if (repositories === undefined || isAuthorizedForRepository === null) {
    return <ScreenState title="Loading…" description="Loading your repository." isLoading />;
  }
  // Bounce to the landing has been scheduled by the effect above; render a
  // loading state in the meantime to avoid flashing repo-scoped chrome with
  // a stale/unauthorized id.
  if (!isAuthorizedForRepository) {
    return <ScreenState title="Loading…" description="Redirecting…" isLoading />;
  }

  return (
    <>
      <AppSidebarLeft
        repositories={repositories}
        activeRepositoryId={repositoryId}
        onSwitchRepository={handleSwitchRepository}
        selectedThreadId={null}
        onSelectThread={() => {}}
        onDeleteThread={() => {}}
        onImported={handleImported}
        onError={handleRailError}
        importDisabledReason={importDisabledReason}
        libraryRepositoryId={repositoryId}
        libraryArtifacts={allArtifacts}
        libraryActiveArtifactId={tabs.activeArtifactId}
        onSelectLibraryArtifact={tabs.openTab}
        isUnseen={isUnseen}
      />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:px-4">
          <SidebarTrigger side="left" />
          <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground md:text-base">
            {currentRepository?.sourceRepoFullName ?? "Library"}
          </h1>
          <LibraryLiveSourceBadge status={sandboxActivityStatus} />
          <LibraryDesignDocsMenu
            className="ml-auto"
            onShowNavigator={tabs.showNavigator}
            onGenerate={openGenerateDialog}
            generateDisabledReason={generateSystemDesignDisabledReason}
          />
          <SidebarTrigger side="right" />
        </header>
        <div className="flex min-h-0 min-w-0 flex-1">
          <LibraryShell repositoryId={repositoryId} tabs={tabs} allArtifacts={allArtifacts} />
        </div>
      </SidebarInset>
      <AppSidebarRight
        activeRepositoryId={repositoryId}
        askThreadId={askThreadId}
        activeArtifactId={tabs.activeArtifactId}
        hasArtifacts={hasArtifacts}
        onSelectArtifact={tabs.openTab}
        onSelectAskThread={handleSelectLibraryThread}
        onGenerate={openGenerateDialog}
        askDisabledReason={libraryAskDisabledReason}
        generateDisabledReason={generateSystemDesignDisabledReason}
        artifactDraftDisabledReason={artifactDraftDisabledReason}
        liveSourceStatus={sandboxActivityStatus}
        premiumModelsDisabledReason={premiumModelsDisabledReason}
        highReasoningDisabledReason={highReasoningDisabledReason}
      />
      <GenerateSystemDesignDialog
        open={isGenerateDialogOpen}
        onOpenChange={setIsGenerateDialogOpen}
        repositoryId={repositoryId}
        disabledReason={generateSystemDesignDisabledReason}
        premiumModelsDisabledReason={premiumModelsDisabledReason}
        highReasoningDisabledReason={highReasoningDisabledReason}
      />
    </>
  );
}

function LibraryDesignDocsMenu({
  className,
  onShowNavigator,
  onGenerate,
  generateDisabledReason,
}: {
  className?: string;
  onShowNavigator: () => void;
  onGenerate: () => void;
  generateDisabledReason?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={cn("h-8 gap-1.5 px-2.5", className)}>
          <BookOpenIcon size={14} weight="bold" />
          <span className="hidden sm:inline">{REPOSITORY_GUIDE_COPY.name}</span>
          <CaretDownIcon size={12} weight="bold" className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onShowNavigator}>
          <FoldersIcon weight="bold" />
          Open library overview
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onGenerate}
          disabled={generateDisabledReason !== undefined}
          title={generateDisabledReason}
        >
          <SparkleIcon weight="bold" />
          {REPOSITORY_GUIDE_COPY.generateAction}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PendingLibraryShell({ repositoryId, repositoryName }: { repositoryId: RepositoryId; repositoryName: string }) {
  return (
    <>
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
        <RepositoryModeSwitcher repositoryId={repositoryId} mode="library" availability={undefined} />
        <SidebarContent className="min-h-0 flex-1">
          <LibraryTree
            repositoryId={repositoryId}
            selectedArtifactId={null}
            onSelectArtifact={() => {}}
            loadFolders={false}
            canCreateFolders={false}
            className="min-h-0 flex-1"
          />
        </SidebarContent>
        <SidebarFooter className="px-3 py-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <Skeleton className="h-8 min-w-0 flex-1" />
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:px-4">
          <SidebarTrigger side="left" />
          <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground md:text-base">
            {repositoryName}
          </h1>
          <SidebarTrigger side="right" className="ml-auto" />
        </header>
        <div className="min-h-0 min-w-0 flex-1" />
      </SidebarInset>
      <Sidebar
        side="right"
        widthStorageKey={LIBRARY_ASK_WIDTH_STORAGE_KEY}
        defaultWidth={LIBRARY_ASK_DEFAULT_WIDTH}
        maxWidth={LIBRARY_ASK_MAX_WIDTH}
      >
        <PendingLibraryAskShell />
      </Sidebar>
    </>
  );
}

export function PendingLibraryAskShell() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="min-h-0 flex-1" />
      <div className="border-t border-border px-4 py-3">
        <InputGroup className="min-h-[9rem] overflow-hidden">
          <InputGroupTextarea
            value=""
            readOnly
            placeholder="Question about this library..."
            className="min-h-24 text-sm"
            aria-label="Library Ask input loading"
          />
          <InputGroupAddon
            align="block-end"
            className="h-11 min-h-11 flex-nowrap items-center justify-between gap-1 overflow-hidden"
          >
            <div aria-hidden="true" className="h-8 min-h-8 min-w-0 flex-1" />
            <Button type="button" size="sm" disabled title="Loading library data.">
              <PaperPlaneTiltIcon size={14} weight="fill" />
              <ButtonStateText current="Asking..." states={PENDING_LIBRARY_ASK_SEND_BUTTON_STATES} />
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}

type LibrarySandboxActivityStatus = ReturnType<typeof useQuery<typeof api.repositories.getSandboxActivityStatus>>;

export function LibraryLiveSourceBadge({ status }: { status: LibrarySandboxActivityStatus | undefined }) {
  const presentation = getLibraryLiveSourcePresentation(status);
  const Icon = presentation.icon;

  return (
    <Badge
      variant="outline"
      title={presentation.title}
      aria-label={presentation.title}
      className={cn("ml-2 h-6 shrink-0 gap-1.5 px-2 text-[11px] font-medium", presentation.className)}
    >
      <Icon size={10} weight="fill" className={presentation.iconClassName} aria-hidden="true" />
      <span>{presentation.label}</span>
    </Badge>
  );
}

function getLibraryLiveSourcePresentation(status: LibrarySandboxActivityStatus | undefined) {
  if (status == null) {
    return {
      label: "Code access",
      title: "Repository code access status is loading",
      icon: CircleIcon,
      className: "border-border bg-card text-muted-foreground",
      iconClassName: "animate-pulse text-muted-foreground",
    };
  }

  if (status.kind === "ready" || status.kind === "expiring_soon") {
    return {
      label: "Code access active",
      title:
        status.kind === "expiring_soon"
          ? "Repository code access is active and will auto-archive soon"
          : "Repository code access is active",
      icon: LightningIcon,
      className: "border-success/35 bg-success/10 text-success",
      iconClassName: "text-success",
    };
  }

  if (status.kind === "preparing") {
    return {
      label: "Code access starting",
      title: "Repository code access is starting",
      icon: CircleIcon,
      className: "border-primary/35 bg-primary/10 text-primary",
      iconClassName: "animate-pulse text-primary",
    };
  }

  return {
    label: "Code access idle",
    title: "Repository code access starts when a task needs current repository files.",
    icon: WarningCircleIcon,
    className: "border-border bg-card text-muted-foreground",
    iconClassName: "text-muted-foreground",
  };
}
