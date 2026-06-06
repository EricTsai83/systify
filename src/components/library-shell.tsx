import { useCallback, useMemo, useState } from "react";
import { LibraryEditor } from "@/components/library-editor";
import { LibraryTabs } from "@/components/library-tabs";
import { QuickOpenDialog } from "@/components/quick-open-dialog";
import { SystemDesignStatusBanner } from "@/components/system-design-status-banner";
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
import { useSidebar } from "@/components/ui/sidebar";
import { useLibraryShortcuts } from "@/hooks/use-library-shortcuts";
import type { LibraryTabsApi } from "@/hooks/use-library-tabs";
import { useWarmArtifactSubscriptions } from "@/hooks/use-warm-artifact-subscriptions";
import type { ArtifactId, ArtifactListItem, FolderId, RepositoryId } from "@/lib/types";

/**
 * Library shell — single-column desktop layout.
 *
 * The folder tree moved to the left {@link AppSidebarLeft} (Library mode)
 * and Library Ask moved to the right {@link AppSidebarRight}. This shell
 * now owns only the artifact tab strip + editor + tab-aware shortcuts.
 * Artifact data is hoisted to {@link LibraryPage} so the same query feeds
 * the sidebar's tree, the right sidebar's Ask panel, and the editor.
 */
export function LibraryShell({
  repositoryId,
  tabs,
  allArtifacts,
  hasArtifacts,
}: {
  repositoryId: RepositoryId;
  tabs: LibraryTabsApi;
  allArtifacts: ReadonlyArray<ArtifactListItem> | undefined;
  hasArtifacts: boolean;
}) {
  const artifactsById = useMemo(() => {
    const map = new Map<ArtifactId, ArtifactListItem>();
    for (const artifact of allArtifacts ?? []) {
      map.set(artifact._id as ArtifactId, artifact);
    }
    return map;
  }, [allArtifacts]);

  const openFolderIds = useMemo(() => {
    const set = new Set<FolderId>();
    for (const id of tabs.openArtifactIds) {
      const folder = artifactsById.get(id)?.folderId;
      if (folder) set.add(folder as FolderId);
    }
    return Array.from(set);
  }, [tabs.openArtifactIds, artifactsById]);
  useWarmArtifactSubscriptions(tabs.openArtifactIds, openFolderIds);

  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
  const { toggle: toggleLeftSidebar } = useSidebar("left");

  useLibraryShortcuts({
    onQuickOpen: () => setIsQuickOpenOpen(true),
    onCloseActiveTab: () => {
      if (tabs.activeArtifactId) {
        tabs.closeTab(tabs.activeArtifactId);
      }
    },
    // Cmd+B now toggles the left sidebar (which carries the Library tree
    // in Library mode), matching Discuss behaviour. The previous
    // separate "collapse icon rail" affordance is intentionally dropped
    // in exchange for a single muscle-memory across all modes.
    onToggleTree: toggleLeftSidebar,
    onFocusTab: (index) => {
      const target = tabs.openArtifactIds[index];
      if (target) tabs.activateTab(target);
    },
  });

  const handleSelectArtifact = useCallback(
    (artifactId: ArtifactId) => {
      tabs.openTab(artifactId);
    },
    [tabs],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <SystemDesignStatusBanner repositoryId={repositoryId} />

      <LibraryTabs
        openArtifactIds={tabs.openArtifactIds}
        activeArtifactId={tabs.activeArtifactId}
        artifactsById={artifactsById}
        onActivate={tabs.activateTab}
        onClose={tabs.closeTab}
        onReorder={tabs.reorderTabs}
        className="shrink-0"
      />

      {tabs.activeArtifactId ? (
        <LibraryEditor artifactId={tabs.activeArtifactId} />
      ) : allArtifacts === undefined ? null : (
        <LibraryEmptyState hasArtifacts={hasArtifacts} />
      )}

      <QuickOpenDialog
        open={isQuickOpenOpen}
        onOpenChange={setIsQuickOpenOpen}
        artifacts={allArtifacts ?? []}
        onSelect={(artifactId) => {
          handleSelectArtifact(artifactId);
        }}
      />
    </div>
  );
}

function LibraryEmptyState({ hasArtifacts }: { hasArtifacts: boolean }) {
  if (!hasArtifacts) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-md text-center">
          <h2 className="text-base font-semibold text-foreground">No documents yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">{REPOSITORY_GUIDE_COPY.emptyLibraryDescription}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10">
      <div className="w-full max-w-md text-center">
        <h2 className="text-base font-semibold text-foreground">No artifact open</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Pick an artifact from the folder tree, or press <kbd className="font-mono text-[11px]">⌘ P</kbd> to search.
        </p>
      </div>
    </div>
  );
}
