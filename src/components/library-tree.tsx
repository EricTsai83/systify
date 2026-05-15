import { useState } from "react";
import { SparkleIcon } from "@phosphor-icons/react";
import { FolderNavigator } from "@/components/folder-navigator";
import { GenerateSystemDesignDialog } from "@/components/generate-system-design-dialog";
import { Button } from "@/components/ui/button";
import type { ArtifactId, ArtifactListItem, FolderId, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Three-mode restructure — Library Tree.
 *
 * Wraps {@link FolderNavigator} so the Library shell has a single import
 * surface for the right rail. Adds a header bar above the navigator carrying
 * the **Generate System Design** action — the only top-level entry point for
 * the publication flow that drops a starter set of artifacts into the seeded
 * System Design folders.
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
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex flex-col">
          <span className="text-[12px] font-semibold">System Design</span>
          <span className="text-[10px] text-muted-foreground">Folder tree + publication</span>
        </div>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setDialogOpen(true)}>
          <SparkleIcon size={12} weight="bold" />
          Generate
        </Button>
      </div>

      <FolderNavigator
        repositoryId={repositoryId}
        artifacts={artifacts}
        selectedArtifactId={selectedArtifactId}
        selectedFolderId={selectedFolderId ?? null}
        onSelectArtifact={onSelectArtifact}
        onSelectFolder={onSelectFolder}
        className="min-h-0 flex-1 border-0"
      />

      <GenerateSystemDesignDialog open={dialogOpen} onOpenChange={setDialogOpen} repositoryId={repositoryId} />
    </div>
  );
}
