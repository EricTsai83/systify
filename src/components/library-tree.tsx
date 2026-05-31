import { SparkleIcon } from "@phosphor-icons/react";
import { FolderNavigator } from "@/components/folder-navigator";
import { Button } from "@/components/ui/button";
import type { ArtifactId, ArtifactListItem, FolderId, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Library Tree.
 *
 * Wraps {@link FolderNavigator} so the Library shell has a single import
 * surface for the right rail. Adds a header bar above the navigator carrying
 * the **Generate System Design** action — the publication flow that drops a
 * starter set of artifacts into the seeded System Design folders. The dialog
 * itself is hoisted to {@link LibraryShell} so the empty-state CTA can share it.
 */
export function LibraryTree({
  repositoryId,
  artifacts,
  selectedArtifactId,
  onSelectArtifact,
  onSelectFolder,
  selectedFolderId,
  onGenerate,
  isUnseen,
  className,
}: {
  repositoryId: RepositoryId;
  artifacts?: ReadonlyArray<ArtifactListItem>;
  selectedArtifactId: ArtifactId | null;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  onSelectFolder?: (folderId: FolderId | null) => void;
  selectedFolderId?: FolderId | null;
  onGenerate: () => void;
  isUnseen?: (artifact: ArtifactListItem) => boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">System Design Documents</span>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onGenerate}>
          <SparkleIcon size={12} weight="bold" />
          Generate
        </Button>
      </div>

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
