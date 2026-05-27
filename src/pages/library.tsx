import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { AppSidebarLeft, AppSidebarRight } from "@/components/app-sidebar";
import { GenerateSystemDesignDialog } from "@/components/generate-system-design-dialog";
import { LibraryShell } from "@/components/library-shell";
import { ScreenState } from "@/components/screen-state";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { useArtifactViewState } from "@/hooks/use-artifact-view-state";
import { useLibraryTabs } from "@/hooks/use-library-tabs";
import {
  DEFAULT_AUTHENTICATED_PATH,
  libraryPath,
  modeAwareThreadPath,
  repositoryPath,
  withLibraryAskParam,
} from "@/route-paths";
import type { ArtifactId, RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
import { writeString } from "@/lib/storage";
import { applyTouchRepositoryOptimistic } from "@/lib/repository-mutations";
import { toast } from "sonner";

const ACTIVE_REPOSITORY_STORAGE_KEY = "systify.activeRepositoryId";

/**
 * Library service mode entry point.
 *
 * Mounted at:
 *   - `/r/:repositoryId/library`               → folder overview.
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

  const repositories = useQuery(api.repositoryPreferences.listRepositoriesForSwitcher);
  const baseTouchRepository = useMutation(api.repositoryPreferences.touchRepository);
  const touchRepository = useMemo(
    () => baseTouchRepository.withOptimisticUpdate(applyTouchRepositoryOptimistic),
    [baseTouchRepository],
  );

  useEffect(() => {
    if (!repositoryId) return;
    writeString(ACTIVE_REPOSITORY_STORAGE_KEY, repositoryId);
    void touchRepository({ repositoryId, mode: "library" }).catch(() => {});
  }, [touchRepository, repositoryId]);

  const currentRepository = useMemo(
    () => repositories?.find((repo) => repo._id === repositoryId) ?? null,
    [repositories, repositoryId],
  );

  const tabs = useLibraryTabs(repositoryId, artifactId);

  const allArtifacts = useQuery(api.artifacts.listMetadataByRepositoryWithFreshness, { repositoryId });
  const { isUnseen, markViewed } = useArtifactViewState(repositoryId);

  const hasArtifacts = (allArtifacts?.length ?? 0) > 0;

  useEffect(() => {
    if (tabs.activeArtifactId) {
      markViewed(tabs.activeArtifactId);
    }
  }, [tabs.activeArtifactId, markViewed]);

  const [isGenerateDialogOpen, setIsGenerateDialogOpen] = useState(false);
  const openGenerateDialog = useCallback(() => setIsGenerateDialogOpen(true), []);

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

  // Library only renders when the repository exists. For missing
  // repositories, route the user back to the default landing.
  useEffect(() => {
    if (repositories === undefined) return;
    if (currentRepository === null) {
      void navigate(DEFAULT_AUTHENTICATED_PATH, { replace: true });
    }
  }, [currentRepository, repositories, navigate]);

  const artifactProbe = useQuery(api.artifacts.getById, artifactId ? { artifactId } : "skip");
  useEffect(() => {
    if (!artifactId) return;
    if (repositories === undefined || !currentRepository) return;
    if (artifactProbe === undefined) return;
    if (artifactProbe === null || artifactProbe.repositoryId !== repositoryId) {
      void navigate(withLibraryAskParam(libraryPath(repositoryId), askThreadId), { replace: true });
    }
  }, [artifactId, artifactProbe, askThreadId, currentRepository, navigate, repositoryId, repositories]);

  const askThreadProbe = useQuery(api.chat.threads.getThreadSummary, askThreadId ? { threadId: askThreadId } : "skip");
  useEffect(() => {
    if (!askThreadId) return;
    if (askThreadProbe === undefined) return;
    if (askThreadProbe === null || askThreadProbe.repositoryId !== repositoryId || askThreadProbe.mode !== "library") {
      handleSelectLibraryThread(null, { replace: true });
    }
  }, [askThreadId, askThreadProbe, handleSelectLibraryThread, repositoryId]);

  if (repositories === undefined) {
    return <ScreenState title="Loading…" description="Loading your repository." isLoading />;
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
        libraryRepositoryId={repositoryId}
        libraryArtifacts={allArtifacts}
        libraryActiveArtifactId={tabs.activeArtifactId}
        onSelectLibraryArtifact={tabs.openTab}
        onGenerate={openGenerateDialog}
        isUnseen={isUnseen}
      />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:px-4">
          <SidebarTrigger side="left" />
          <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground md:text-base">
            {currentRepository?.sourceRepoFullName ?? "Library"}
          </h1>
          <span className="shrink-0 text-[11px] text-muted-foreground">Read Only</span>
          <SidebarTrigger side="right" className="ml-auto" />
        </header>
        <div className="flex min-h-0 min-w-0 flex-1">
          <LibraryShell
            repositoryId={repositoryId}
            tabs={tabs}
            allArtifacts={allArtifacts}
            hasArtifacts={hasArtifacts}
          />
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
      />
      <GenerateSystemDesignDialog
        open={isGenerateDialogOpen}
        onOpenChange={setIsGenerateDialogOpen}
        repositoryId={repositoryId}
      />
    </>
  );
}
