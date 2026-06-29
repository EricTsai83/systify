import { useCallback, useMemo, useState } from "react";
import { LibraryEditor } from "@/components/library-editor";
import { QuickOpenDialog } from "@/components/quick-open-dialog";
import { RepositoryGuideNavigator } from "@/components/repository-guide-navigator";
import { SystemDesignStatusBanner } from "@/components/system-design-status-banner";
import { useSidebar } from "@/components/ui/sidebar";
import { useLibraryShortcuts } from "@/hooks/use-library-shortcuts";
import { useWarmArtifactSubscriptions } from "@/hooks/use-warm-artifact-subscriptions";
import type { ArtifactId, ArtifactListItem, FolderId, RepositoryId } from "@/lib/types";

/**
 * Library shell — single-column desktop layout.
 *
 * The folder tree moved to the left {@link AppSidebarLeft} (Library mode)
 * and Library Ask moved to the right {@link AppSidebarRight}. This shell
 * now owns only the artifact reader and quick-open shortcuts.
 * Artifact data is hoisted to {@link LibraryPage} so the same query feeds
 * the sidebar's tree, the right sidebar's Ask panel, and the editor.
 */
export function LibraryShell({
  repositoryId,
  activeArtifactId,
  onSelectArtifact,
  allArtifacts,
}: {
  repositoryId: RepositoryId;
  activeArtifactId: ArtifactId | null;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  allArtifacts: ReadonlyArray<ArtifactListItem> | undefined;
}) {
  const artifactsById = useMemo(() => {
    const map = new Map<ArtifactId, ArtifactListItem>();
    for (const artifact of allArtifacts ?? []) {
      map.set(artifact._id as ArtifactId, artifact);
    }
    return map;
  }, [allArtifacts]);

  const warmArtifactIds = useMemo(() => (activeArtifactId ? [activeArtifactId] : []), [activeArtifactId]);

  const openFolderIds = useMemo(() => {
    const set = new Set<FolderId>();
    if (activeArtifactId) {
      const folder = artifactsById.get(activeArtifactId)?.folderId;
      if (folder) set.add(folder as FolderId);
    }
    return Array.from(set);
  }, [activeArtifactId, artifactsById]);
  useWarmArtifactSubscriptions(warmArtifactIds, openFolderIds);

  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
  const { toggle: toggleLeftSidebar } = useSidebar("left");

  useLibraryShortcuts({
    onQuickOpen: () => setIsQuickOpenOpen(true),
    // Cmd+B now toggles the left sidebar (which carries the Library tree
    // in Library mode), matching Discuss behaviour. The previous
    // separate "collapse icon rail" affordance is intentionally dropped
    // in exchange for a single muscle-memory across all modes.
    onToggleTree: toggleLeftSidebar,
  });

  const handleSelectArtifact = useCallback(
    (artifactId: ArtifactId) => {
      onSelectArtifact(artifactId);
    },
    [onSelectArtifact],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <SystemDesignStatusBanner repositoryId={repositoryId} />

      {activeArtifactId ? (
        <LibraryEditor artifactId={activeArtifactId} />
      ) : allArtifacts === undefined ? null : (
        <RepositoryGuideNavigator
          repositoryId={repositoryId}
          artifacts={allArtifacts}
          onSelectArtifact={handleSelectArtifact}
        />
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
