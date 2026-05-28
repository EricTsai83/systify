import { useCallback, useState } from "react";
import type { Doc } from "../../convex/_generated/dataModel";
import { FolderNavigator } from "@/components/folder-navigator";
import { useArtifactViewState } from "@/hooks/use-artifact-view-state";
import type { ArtifactId, FolderId, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

const EMPTY_ARTIFACTS: Doc<"artifacts">[] = [];

/**
 * ArtifactPanel — right-rail surface for browsing repository artifacts.
 *
 * The panel is read-only: clicking an artifact opens the standalone
 * Reader (`/r/:rid/library/a/:aid`) via `onOpenInReader`, and citation
 * clicks from chat route through the same callback so the Reader is the
 * canonical long-form reading experience.
 *
 * Generation entry points for repository-scoped artifacts (System Design,
 * failure-mode analysis) live in the top bar / chat composer, not here —
 * the panel exists purely to navigate what already exists.
 */
export function ArtifactPanel({
  repositoryId,
  artifacts = EMPTY_ARTIFACTS,
  isVisible = true,
  className,
  onOpenInReader,
  onSelectFolder,
  selectedFolderId,
}: {
  /**
   * Repository the panel's folder tree is scoped to. `null` for a thread
   * without an attached repo — the navigator hides itself in that state.
   */
  repositoryId: RepositoryId | null;
  /**
   * Repo-level artifacts surfaced through `getRepositoryDetail`. Passed in
   * (rather than queried inside the panel) so the desktop chat surface can
   * keep its single subscription and the panel doesn't have to refetch.
   */
  artifacts?: ReadonlyArray<Doc<"artifacts">>;
  isVisible?: boolean;
  className?: string;
  /**
   * Open an artifact in the standalone Reader. This is the only navigation
   * entry the panel exposes for artifact rows — citation clicks from chat
   * route through the same callback, so the Reader is the canonical place
   * to read long-form content.
   */
  onOpenInReader?: (artifactId: ArtifactId) => void;
  onSelectFolder?: (folderId: FolderId | null) => void;
  selectedFolderId?: FolderId | null;
}) {
  const { isUnseen, markViewed } = useArtifactViewState(repositoryId);
  // Internal fallback when the caller doesn't provide a controlled
  // `selectedFolderId`. The chat right rail leaves selection uncontrolled.
  // Library reader callers keep external control by passing
  // `selectedFolderId` + `onSelectFolder` themselves.
  const [internalSelectedFolderId, setInternalSelectedFolderId] = useState<FolderId | null>(null);
  // Reset uncontrolled folder selection when the repository changes so a
  // stale folder ID from the previous repo doesn't leak into the navigator.
  // Tracked via setState-during-render (React's recommended pattern for
  // prop-driven resets) so we don't take a cascading-effect hit.
  const [trackedRepositoryId, setTrackedRepositoryId] = useState<RepositoryId | null>(repositoryId);
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
  // Clicking a row in the panel always routes through `onOpenInReader`,
  // so it is the single chokepoint where we record the activation. The
  // Library shell has multiple activation entry points (URL, tab strip,
  // keyboard) so it observes `tabs.activeArtifactId` instead.
  const handleSelectArtifact = useCallback(
    (artifactId: ArtifactId) => {
      markViewed(artifactId);
      onOpenInReader?.(artifactId);
    },
    [markViewed, onOpenInReader],
  );

  if (!isVisible) {
    return (
      <aside
        aria-label="Repository and thread artifacts"
        className={cn("flex h-full min-h-0 w-80 shrink-0 flex-col border-l border-border bg-muted/20", className)}
      >
        <ArtifactPanelHeader />
      </aside>
    );
  }

  return (
    <aside
      aria-label="Repository and thread artifacts"
      className={cn("flex h-full min-h-0 w-80 shrink-0 flex-col border-l border-border bg-muted/20", className)}
    >
      <ArtifactPanelHeader />

      {repositoryId ? (
        <FolderNavigator
          repositoryId={repositoryId}
          artifacts={artifacts}
          selectedFolderId={effectiveSelectedFolderId}
          onSelectArtifact={handleSelectArtifact}
          onSelectFolder={handleSelectFolder}
          isUnseen={isUnseen}
          className="border-l-0"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 py-8">
          <p className="text-center text-[12px] text-muted-foreground">
            Attach a repository to explore generated artifacts.
          </p>
        </div>
      )}
    </aside>
  );
}

function ArtifactPanelHeader() {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
      <div className="flex flex-col">
        <span className="text-sm font-semibold">Results</span>
        <span className="text-[11px] text-muted-foreground">Repository intelligence and folders.</span>
      </div>
    </div>
  );
}
