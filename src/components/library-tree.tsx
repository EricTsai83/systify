import { FolderNavigator } from "@/components/folder-navigator";
import type { ArtifactId, ArtifactListItem, FolderId, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Three-mode restructure — Library Tree.
 *
 * Wraps {@link FolderNavigator} so the Library shell has a single
 * import surface for the left rail and so future Library-only
 * enhancements land in one file rather than mutating the shared
 * navigator. Clicking a row opens the artifact in the editor.
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
      onSelectFolder={onSelectFolder}
      className={cn("h-full min-h-0", className)}
    />
  );
}
