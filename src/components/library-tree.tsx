import { FolderNavigator } from "@/components/folder-navigator";
import type { ArtifactId, ArtifactListItem, FolderId, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Library Tree.
 *
 * Wraps {@link FolderNavigator} so the Library shell has a single import
 * surface for the left rail. Generation actions live in the Library overview
 * and blocked Ask states; this rail stays focused on artifact navigation.
 */
export function LibraryTree({
  repositoryId,
  artifacts,
  selectedArtifactId,
  onSelectArtifact,
  onSelectFolder,
  selectedFolderId,
  isUnseen,
  className,
}: {
  repositoryId: RepositoryId;
  artifacts?: ReadonlyArray<ArtifactListItem>;
  selectedArtifactId: ArtifactId | null;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  onSelectFolder?: (folderId: FolderId | null) => void;
  selectedFolderId?: FolderId | null;
  isUnseen?: (artifact: ArtifactListItem) => boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <FolderNavigator
        repositoryId={repositoryId}
        artifacts={artifacts}
        selectedArtifactId={selectedArtifactId}
        selectedFolderId={selectedFolderId}
        onSelectArtifact={onSelectArtifact}
        onSelectFolder={onSelectFolder}
        isUnseen={isUnseen}
        className="min-h-0 flex-1 border-0"
      />
    </div>
  );
}
