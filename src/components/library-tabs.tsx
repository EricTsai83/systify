import { memo, useRef, useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import type { ArtifactId, ArtifactListItem } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Three-mode restructure — Library tab strip.
 *
 * Renders the open-tab list above the editor, mirroring the IDE chrome
 * users already know. Click activates, middle-click closes, drag
 * reorders. Overflow scrolls horizontally with edge gradients so the
 * user can see there's more on either side without an extra "show
 * more" affordance.
 *
 * The component is a controlled view — all state lives in the
 * `useLibraryTabs` hook owned by the shell. We deliberately do NOT
 * pull in `dnd-kit` for reorder; HTML5 drag-and-drop covers the use
 * case in <30 lines and ships zero kilobytes.
 */
export interface LibraryTabsProps {
  openArtifactIds: ReadonlyArray<ArtifactId>;
  activeArtifactId: ArtifactId | null;
  /**
   * Lookup keyed by artifact id. The shell already loads every artifact
   * for the tree, so passing the map avoids extra subscriptions in the
   * tab component.
   */
  artifactsById: ReadonlyMap<ArtifactId, ArtifactListItem>;
  onActivate: (artifactId: ArtifactId) => void;
  onClose: (artifactId: ArtifactId) => void;
  onReorder: (nextOrder: ReadonlyArray<ArtifactId>) => void;
  /**
   * Optional trailing slot pinned to the right of the tab strip. Lets
   * the shell hang affordances like "Ask Library" alongside the tabs
   * instead of burning a whole row on a single button.
   */
  actions?: React.ReactNode;
  /**
   * Classes merged onto the actions wrapper — use `hidden lg:flex` when
   * the contents are desktop-only so the wrapper's padding/border don't
   * leave an empty bar at narrower viewports.
   */
  actionsClassName?: string;
  className?: string;
}

export const LibraryTabs = memo(function LibraryTabs({
  openArtifactIds,
  activeArtifactId,
  artifactsById,
  onActivate,
  onClose,
  onReorder,
  actions,
  actionsClassName,
  className,
}: LibraryTabsProps) {
  const dragSourceRef = useRef<ArtifactId | null>(null);
  const [dragOverId, setDragOverId] = useState<ArtifactId | null>(null);

  if (openArtifactIds.length === 0) {
    if (!actions) return null;
    return (
      <div
        className={cn(
          "items-center justify-end border-b border-border bg-background px-2 py-1",
          actionsClassName ?? "flex",
          className,
        )}
      >
        {actions}
      </div>
    );
  }

  const handleDragStart = (artifactId: ArtifactId) => (event: React.DragEvent) => {
    dragSourceRef.current = artifactId;
    event.dataTransfer.effectAllowed = "move";
    // Setting some data is required for Firefox to fire `dragover` events
    // on the targets — the value itself is unused.
    event.dataTransfer.setData("text/plain", artifactId);
  };

  const handleDragOver = (artifactId: ArtifactId) => (event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dragOverId !== artifactId) {
      setDragOverId(artifactId);
    }
  };

  const handleDrop = (targetId: ArtifactId) => (event: React.DragEvent) => {
    event.preventDefault();
    const sourceId = dragSourceRef.current;
    dragSourceRef.current = null;
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;
    const nextOrder: ArtifactId[] = [];
    for (const id of openArtifactIds) {
      if (id === sourceId) continue;
      if (id === targetId) {
        nextOrder.push(sourceId, targetId);
      } else {
        nextOrder.push(id);
      }
    }
    if (!nextOrder.includes(sourceId)) {
      // The source was the rightmost tab and we dropped onto a tab to
      // its left — handled by the loop above. The fallback here covers
      // dropping onto the same id (no-op short-circuit above) plus
      // future "drop after last" gestures.
      nextOrder.push(sourceId);
    }
    onReorder(nextOrder);
  };

  const handleDragEnd = () => {
    dragSourceRef.current = null;
    setDragOverId(null);
  };

  return (
    <div className={cn("relative flex items-center border-b border-border bg-background", className)}>
      <ScrollArea className="min-w-0 flex-1">
        <ul role="tablist" aria-label="Open artifacts" className="flex items-center gap-px px-1 py-1">
          {openArtifactIds.map((artifactId) => {
            const artifact = artifactsById.get(artifactId);
            const isActive = activeArtifactId === artifactId;
            const isDropTarget = dragOverId === artifactId;
            return (
              <li key={artifactId} role="presentation" className="shrink-0">
                <div
                  role="tab"
                  tabIndex={isActive ? 0 : -1}
                  aria-selected={isActive}
                  draggable
                  onDragStart={handleDragStart(artifactId)}
                  onDragOver={handleDragOver(artifactId)}
                  onDrop={handleDrop(artifactId)}
                  onDragEnd={handleDragEnd}
                  onClick={() => onActivate(artifactId)}
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      onClose(artifactId);
                    }
                  }}
                  className={cn(
                    "group flex max-w-[220px] cursor-pointer items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-xs transition-colors",
                    isActive
                      ? "border-primary bg-muted/60 text-foreground"
                      : "border-transparent bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                    isDropTarget && "ring-1 ring-primary/40",
                  )}
                >
                  <span className="min-w-0 truncate">{artifact?.title ?? "Untitled"}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0 opacity-50 transition-opacity hover:opacity-100"
                    aria-label={`Close ${artifact?.title ?? "tab"}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose(artifactId);
                    }}
                  >
                    <XIcon size={10} weight="bold" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-4 bg-gradient-to-r from-background to-transparent"
      />
      {actions ? (
        <div className={cn("shrink-0 items-center border-l border-border px-2 py-1", actionsClassName ?? "flex")}>
          {actions}
        </div>
      ) : (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-4 bg-gradient-to-l from-background to-transparent"
        />
      )}
    </div>
  );
});
