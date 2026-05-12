import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { FolderIcon } from "@phosphor-icons/react";
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
 * Three-mode restructure — Library shell.
 *
 * Two-column desktop layout (≥1024px):
 *
 *   ┌──────────┬───────────────────────────┐
 *   │ Library  │  Tab bar                  │
 *   │ Tree     ├───────────────────────────┤
 *   │ (280px)  │  Breadcrumb / Editor body │
 *   │          │                           │
 *   └──────────┴───────────────────────────┘
 *
 * Mid viewports collapse the tree to a 48px icon column; Cmd+B
 * toggles. Small (<1024px): single column with the tree in a Sheet.
 *
 * The shell does not render any chat surface — Library Read is, by
 * invariant, not a streaming chat (Library Ask in Phase 2 mounts a
 * separate panel). This split is what lets us avoid pulling the chat
 * subscription / sandbox SDK chunks into the Library bundle.
 *
 * Wiring:
 *   - `useLibraryTabs` owns the tab strip (URL ↔ localStorage round-trip).
 *   - `useLibraryShortcuts` binds Cmd+P, Cmd+W, Cmd+B, Alt+1..9.
 */
export function LibraryShell({
  workspaceId,
  repositoryId,
  /**
   * Active artifact id derived from the route. `null` when the URL is
   * `/w/:wid/library` (no active tab); the shell renders a folder
   * overview placeholder for that state.
   */
  activeArtifactId,
  isAskOpen,
  askThreadId,
  onOpenAsk,
  onCloseAsk,
  onAskThreadCreated,
}: {
  workspaceId: WorkspaceId;
  repositoryId: RepositoryId;
  activeArtifactId: ArtifactId | null;
  isAskOpen: boolean;
  askThreadId: ThreadId | null;
  onOpenAsk: () => void;
  onCloseAsk: () => void;
  onAskThreadCreated: (threadId: ThreadId) => void;
}) {
  // Pull the workspace's full artifact list once: powers the tree, the
  // tab strip's title resolution, and the quick-open dialog. The query
  // is bounded at 200 rows server-side; Phase 3 swaps the navigator for
  // a virtualized variant when artifacts.length > 50.
  const allArtifacts = useQuery(api.artifacts.listMetadataByRepositoryWithFreshness, { repositoryId });

  const tabs = useLibraryTabs(workspaceId, activeArtifactId);

  const artifactsById = useMemo(() => {
    const map = new Map<ArtifactId, ArtifactListItem>();
    for (const artifact of allArtifacts ?? []) {
      map.set(artifact._id as ArtifactId, artifact);
    }
    return map;
  }, [allArtifacts]);

  // Hold Convex subscriptions open for every open tab so switching between
  // tabs is instant — see `useWarmArtifactSubscriptions`. The tab strip is
  // already MRU-bounded (`MAX_OPEN_TABS`), so the working set stays small
  // without a separate retention hook.
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

  // Wire keyboard shortcuts. The shortcut handlers stay close to the
  // shell so they can read the current tab list without a round-trip
  // through context.
  useLibraryShortcuts({
    onQuickOpen: () => setIsQuickOpenOpen(true),
    onCloseActiveTab: () => {
      if (tabs.activeArtifactId) {
        tabs.closeTab(tabs.activeArtifactId);
      }
    },
    onToggleTree: () => {
      // Mobile prefers the Sheet pattern; desktop collapses the column.
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

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Desktop tree rail */}
      <aside
        aria-label="Library tree"
        className={cn(
          "hidden shrink-0 flex-col border-r border-border bg-muted/20 lg:flex",
          isTreeCollapsedDesktop ? "w-12" : "w-72",
        )}
      >
        {isTreeCollapsedDesktop ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="m-2 h-8 w-8"
            aria-label="Expand library tree"
            onClick={() => setIsTreeCollapsedDesktop(false)}
          >
            <FolderIcon size={14} weight="duotone" />
          </Button>
        ) : (
          <LibraryTree
            repositoryId={repositoryId}
            artifacts={allArtifacts ?? []}
            selectedArtifactId={tabs.activeArtifactId}
            onSelectArtifact={handleSelectArtifact}
          />
        )}
      </aside>

      {/* Center column — tab strip + editor */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background/80 px-4 py-2 backdrop-blur lg:hidden">
          <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => setIsTreeOpenMobile(true)}>
            <FolderIcon size={13} weight="duotone" /> Folders
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onOpenAsk}>
            Ask
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

        <div className="hidden shrink-0 justify-end border-b border-border bg-background/60 px-4 py-2 lg:flex">
          <Button type="button" variant="outline" size="sm" onClick={onOpenAsk}>
            Ask Library
          </Button>
        </div>

        {tabs.activeArtifactId ? <LibraryEditor artifactId={tabs.activeArtifactId} /> : <LibraryEmptyState />}
      </div>

      {isAskOpen ? (
        <div className="hidden lg:block">
          <LibraryAskPanel
            workspaceId={workspaceId}
            threadId={askThreadId}
            activeArtifactId={tabs.activeArtifactId}
            onThreadCreated={onAskThreadCreated}
            onSelectArtifact={tabs.openTab}
          />
        </div>
      ) : null}

      {/* Mobile Ask sheet */}
      <Sheet open={isAskOpen && !isLargeViewport} onOpenChange={(open) => (open ? onOpenAsk() : onCloseAsk())}>
        <SheetContent side="right" className="w-full p-0 sm:max-w-md lg:hidden">
          <SheetTitle className="sr-only">Library Ask</SheetTitle>
          <SheetDescription className="sr-only">
            Ask questions using retrieved artifact chunks from this workspace.
          </SheetDescription>
          <LibraryAskPanel
            workspaceId={workspaceId}
            threadId={askThreadId}
            activeArtifactId={tabs.activeArtifactId}
            onThreadCreated={onAskThreadCreated}
            onSelectArtifact={tabs.openTab}
          />
        </SheetContent>
      </Sheet>

      {/* Mobile tree sheet */}
      <Sheet open={isTreeOpenMobile} onOpenChange={setIsTreeOpenMobile}>
        <SheetContent side="left" className="w-80 p-0 sm:w-96">
          <SheetTitle className="sr-only">Library</SheetTitle>
          <SheetDescription className="sr-only">
            Browse folders and artifacts. Selecting an artifact opens it in the editor.
          </SheetDescription>
          <div className="flex h-full min-h-0 flex-col">
            <LibraryTree
              repositoryId={repositoryId}
              artifacts={allArtifacts ?? []}
              selectedArtifactId={tabs.activeArtifactId}
              onSelectArtifact={handleSelectArtifact}
            />
          </div>
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
          Pick an artifact from the tree, or press <kbd className="font-mono text-[11px]">⌘ P</kbd> to search.
        </p>
      </div>
    </div>
  );
}
