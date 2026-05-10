import { FolderNavigator } from "@/components/folder-navigator";
import type { ArtifactId, ArtifactListItem, FolderId, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Three-mode restructure — Library Tree.
 *
 * Phase 1 wraps the existing {@link FolderNavigator} so the Library
 * shell has a single import surface for the left rail and so future
 * Library-only enhancements (per-kind icons in Phase 1, freshness
 * pills in Phase 3, virtualization above 50 rows in Phase 3) land in
 * one file rather than mutating the shared navigator. The current
 * behaviour is identical to FolderNavigator's — clicking a row opens
 * the artifact in the editor, hover shows the open-in-reader action.
 *
 * The wrapper exists today so Phase 2/3 changes don't require a code
 * sweep across consumers.
 */
export function LibraryTree({
  repositoryId,
  artifacts,
  selectedArtifactId,
  onSelectArtifact,
  onSelectFolder,
  selectedFolderId,
  className,
}: {
  repositoryId: RepositoryId;
  artifacts?: ReadonlyArray<ArtifactListItem>;
  selectedArtifactId: ArtifactId | null;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  onSelectFolder?: (folderId: FolderId | null) => void;
  selectedFolderId?: FolderId | null;
  className?: string;
}) {
  return (
    <FolderNavigator
      repositoryId={repositoryId}
      artifacts={artifacts}
      selectedArtifactId={selectedArtifactId}
      selectedFolderId={selectedFolderId ?? null}
      onSelectArtifact={onSelectArtifact}
      // Library Tree always opens in the editor (the IDE shell IS the
      // reader), so `onOpenInReader` and `onSelectArtifact` are the
      // same operation here. The folder-navigator distinguishes them
      // only for the legacy artifact panel.
      onOpenInReader={onSelectArtifact}
      onSelectFolder={onSelectFolder}
      className={cn("h-full min-h-0", className)}
    />
  );
}
