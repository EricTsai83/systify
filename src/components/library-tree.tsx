import { useCallback, useState } from "react";
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
  // Uncontrolled fallback so "+ Create folder" can target whatever the user
  // last clicked even when no parent lifts selection. Mirrors the pattern in
  // `artifact-panel.tsx` — without it `selectedFolderId` stays null and every
  // new folder lands at the root.
  const [internalSelectedFolderId, setInternalSelectedFolderId] = useState<FolderId | null>(null);
  // Reset on repo switch so a folder ID from the previous repo can't leak
  // into the navigator. setState-during-render is React's recommended pattern
  // for prop-driven resets.
  const [trackedRepositoryId, setTrackedRepositoryId] = useState<RepositoryId>(repositoryId);
  if (trackedRepositoryId !== repositoryId) {
    setTrackedRepositoryId(repositoryId);
    setInternalSelectedFolderId(null);
  }
  const isFolderSelectionControlled = selectedFolderId !== undefined;
  const effectiveSelectedFolderId = isFolderSelectionControlled ? selectedFolderId : internalSelectedFolderId;
  const handleSelectFolder = useCallback(
    (folderId: FolderId | null) => {
      if (!isFolderSelectionControlled) {
        setInternalSelectedFolderId(folderId);
      }
      onSelectFolder?.(folderId);
    },
    [isFolderSelectionControlled, onSelectFolder],
  );

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
        selectedFolderId={effectiveSelectedFolderId}
        onSelectArtifact={onSelectArtifact}
        onSelectFolder={handleSelectFolder}
        isUnseen={isUnseen}
        className="min-h-0 flex-1 border-0"
      />
    </div>
  );
}
