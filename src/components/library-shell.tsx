import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { BookOpenIcon, FolderIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { LibraryAskPanel } from "@/components/library-ask-panel";
import { LibraryEditor } from "@/components/library-editor";
import { LibraryTabs } from "@/components/library-tabs";
import { LibraryTree } from "@/components/library-tree";
import { QuickOpenDialog } from "@/components/quick-open-dialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useLibraryShortcuts } from "@/hooks/use-library-shortcuts";
import { useLibraryTabs } from "@/hooks/use-library-tabs";
import { useWarmArtifactSubscriptions } from "@/hooks/use-warm-artifact-subscriptions";
import type { ArtifactId, ArtifactListItem, FolderId, RepositoryId, ThreadId, WorkspaceId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Library shell — three-column desktop layout:
 *
 *   LEFT   — Library Ask (always visible): thread tabs, conversation, input.
 *   MIDDLE — Document: artifact tab strip + editor.
 *   RIGHT  — Folder tree (collapsible via Cmd+B).
 *
 * On narrow viewports the document column is the base layer and both side
 * columns move into Sheets — Ask on the left, the folder tree on the right.
 */
export function LibraryShell({
  workspaceId,
  repositoryId,
  activeArtifactId,
  askThreadId,
  onSelectLibraryThread,
}: {
  workspaceId: WorkspaceId;
  repositoryId: RepositoryId;
  activeArtifactId: ArtifactId | null;
  askThreadId: ThreadId | null;
  /**
   * Set or clear the active Ask thread (`?ask=`). The Ask panel owns thread
   * creation, the open-tab set, and deletion internally — it only needs to
   * tell the page which thread is now active.
   */
  onSelectLibraryThread: (threadId: ThreadId | null) => void;
}) {
  const allArtifacts = useQuery(api.artifacts.listMetadataByRepositoryWithFreshness, { repositoryId });

  const tabs = useLibraryTabs(workspaceId, activeArtifactId);

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

  const [isTreeOpenMobile, setIsTreeOpenMobile] = useState(false);
  const [isAskOpenMobile, setIsAskOpenMobile] = useState(false);
  const [isTreeCollapsedDesktop, setIsTreeCollapsedDesktop] = useState(false);
  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
  const [isLargeViewport, setIsLargeViewport] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const handleChange = () => setIsLargeViewport(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const handleSelectArtifact = useCallback(
    (artifactId: ArtifactId) => {
      tabs.openTab(artifactId);
      setIsTreeOpenMobile(false);
    },
    [tabs],
  );

  useLibraryShortcuts({
    onQuickOpen: () => setIsQuickOpenOpen(true),
    onCloseActiveTab: () => {
      if (tabs.activeArtifactId) {
        tabs.closeTab(tabs.activeArtifactId);
      }
    },
    onToggleTree: () => {
      if (typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches) {
        setIsTreeCollapsedDesktop((collapsed) => !collapsed);
      } else {
        setIsTreeOpenMobile((open) => !open);
      }
    },
    onFocusTab: (index) => {
      const target = tabs.openArtifactIds[index];
      if (target) tabs.activateTab(target);
    },
  });

  // The Ask column is mounted exactly once — either as the desktop column or
  // inside the mobile Sheet, never both. `LibraryAskPanel` owns stateful
  // local hooks (`useLibraryAskTabs`), so a CSS-hidden second mount would
  // diverge from the visible one. The folder tree below stays CSS-toggled
  // because it carries no such cross-mount state.
  const askPanel = (
    <LibraryAskPanel
      workspaceId={workspaceId}
      threadId={askThreadId}
      activeArtifactId={tabs.activeArtifactId}
      onSelectArtifact={tabs.openTab}
      onSelectThread={onSelectLibraryThread}
    />
  );

  const navigatorPanel = (
    <LibraryTree
      repositoryId={repositoryId}
      artifacts={allArtifacts ?? []}
      selectedArtifactId={tabs.activeArtifactId}
      onSelectArtifact={handleSelectArtifact}
      className="min-h-[160px]"
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col lg:flex-row">
      {/* LEFT: Library Ask — its own column on desktop, a Sheet on mobile.
          Rendered in exactly one place (see the `askPanel` comment). */}
      {isLargeViewport ? (
        <aside
          aria-label="Library Ask"
          className="flex min-h-0 shrink-0 overflow-hidden border-r border-border lg:w-[min(24rem,32vw)] xl:w-[min(26rem,28vw)]"
        >
          {askPanel}
        </aside>
      ) : null}

      {/* MIDDLE: Document stack */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background/80 px-4 py-2 backdrop-blur lg:hidden">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setIsAskOpenMobile(true)}
          >
            <BookOpenIcon size={13} weight="duotone" /> Ask
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setIsTreeOpenMobile(true)}
          >
            <FolderIcon size={13} weight="duotone" /> Folders
          </Button>
        </div>

        <LibraryTabs
          openArtifactIds={tabs.openArtifactIds}
          activeArtifactId={tabs.activeArtifactId}
          artifactsById={artifactsById}
          onActivate={tabs.activateTab}
          onClose={tabs.closeTab}
          onReorder={tabs.reorderTabs}
          className="shrink-0"
        />

        {tabs.activeArtifactId ? <LibraryEditor artifactId={tabs.activeArtifactId} /> : <LibraryEmptyState />}
      </div>

      {/* RIGHT: Folder tree — collapsible */}
      <aside
        aria-label="Library folder tree"
        className={cn(
          "hidden min-h-0 shrink-0 overflow-hidden border-l border-border bg-muted/20 lg:flex lg:flex-col",
          isTreeCollapsedDesktop ? "lg:w-12" : "lg:w-[min(20rem,26vw)]",
        )}
      >
        {isTreeCollapsedDesktop ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="m-2 h-8 w-8"
            aria-label="Expand Library folder tree"
            onClick={() => setIsTreeCollapsedDesktop(false)}
          >
            <FolderIcon size={14} weight="duotone" />
          </Button>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">{navigatorPanel}</div>
        )}
      </aside>

      {!isLargeViewport ? (
        <Sheet open={isAskOpenMobile} onOpenChange={setIsAskOpenMobile}>
          <SheetContent side="left" className="w-full p-0 sm:max-w-md">
            <SheetTitle className="sr-only">Library Ask</SheetTitle>
            <SheetDescription className="sr-only">
              Ask questions using retrieved artifact chunks from this workspace.
            </SheetDescription>
            {askPanel}
          </SheetContent>
        </Sheet>
      ) : null}

      <Sheet open={isTreeOpenMobile && !isLargeViewport} onOpenChange={setIsTreeOpenMobile}>
        <SheetContent side="right" className="flex w-[min(100vw,24rem)] flex-col p-0 sm:w-[min(100vw,28rem)] lg:hidden">
          <SheetTitle className="sr-only">Library folder tree</SheetTitle>
          <SheetDescription className="sr-only">
            Browse artifact folders, then return to your document column.
          </SheetDescription>
          <div className="min-h-0 flex-1 overflow-hidden">{navigatorPanel}</div>
        </SheetContent>
      </Sheet>

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

function LibraryEmptyState() {
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
