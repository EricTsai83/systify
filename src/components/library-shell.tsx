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

const ASK_PANEL_WIDTH_STORAGE_KEY = "systify.library.askPanelWidth";
const ASK_PANEL_DEFAULT_WIDTH = 360;
const ASK_PANEL_MIN_WIDTH = 280;
const ASK_PANEL_MAX_WIDTH = 800;

function clampAskPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return ASK_PANEL_DEFAULT_WIDTH;
  return Math.max(ASK_PANEL_MIN_WIDTH, Math.min(ASK_PANEL_MAX_WIDTH, Math.round(value)));
}

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

  // Width of the Library Ask panel on desktop. Min/max are enforced both
  // here (so the persisted value never drifts out of range) and via CSS
  // (so a smaller viewport on a later visit can't make the panel cover
  // the editor). Mobile renders inside a Sheet and ignores this value.
  const [askPanelWidth, setAskPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return ASK_PANEL_DEFAULT_WIDTH;
    try {
      const stored = window.localStorage.getItem(ASK_PANEL_WIDTH_STORAGE_KEY);
      if (stored !== null) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed)) {
          return clampAskPanelWidth(parsed);
        }
      }
    } catch {
      // localStorage unavailable — fall through to default.
    }
    return ASK_PANEL_DEFAULT_WIDTH;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(ASK_PANEL_WIDTH_STORAGE_KEY, String(askPanelWidth));
    } catch {
      // localStorage denied — width remains in-memory for this session.
    }
  }, [askPanelWidth]);

  const handleAskPanelResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = askPanelWidth;

      const handleMove = (moveEvent: MouseEvent) => {
        // Handle sits on the panel's left edge: dragging left widens, right narrows.
        const delta = startX - moveEvent.clientX;
        setAskPanelWidth(clampAskPanelWidth(startWidth + delta));
      };
      const handleUp = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [askPanelWidth],
  );

  const handleAskPanelResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 16;
    // Left arrow widens (handle is on the left edge); right arrow narrows.
    setAskPanelWidth((current) => clampAskPanelWidth(current + (event.key === "ArrowLeft" ? step : -step)));
  }, []);

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
          actions={
            <Button
              type="button"
              variant={isAskOpen ? "secondary" : "outline"}
              size="sm"
              onClick={isAskOpen ? onCloseAsk : onOpenAsk}
              aria-pressed={isAskOpen}
              aria-expanded={isAskOpen}
            >
              Ask Library
            </Button>
          }
          actionsClassName="hidden lg:flex"
          className="shrink-0"
        />

        {tabs.activeArtifactId ? <LibraryEditor artifactId={tabs.activeArtifactId} /> : <LibraryEmptyState />}
      </div>

      {isAskOpen ? (
        <div
          className="relative hidden shrink-0 lg:block"
          style={{ width: askPanelWidth, minWidth: ASK_PANEL_MIN_WIDTH, maxWidth: "60vw" }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize Library Ask panel"
            tabIndex={0}
            className="absolute inset-y-0 left-0 z-10 w-1 -translate-x-1/2 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40 active:bg-primary/60"
            onMouseDown={handleAskPanelResizeStart}
            onKeyDown={handleAskPanelResizeKeyDown}
          />
          <LibraryAskPanel
            workspaceId={workspaceId}
            threadId={askThreadId}
            activeArtifactId={tabs.activeArtifactId}
            onThreadCreated={onAskThreadCreated}
            onSelectArtifact={tabs.openTab}
            onClose={onCloseAsk}
          />
        </div>
      ) : null}

      {/* Mobile Ask sheet — panel header already exposes a close button, so suppress Sheet's built-in X to avoid two dismiss affordances. */}
      <Sheet open={isAskOpen && !isLargeViewport} onOpenChange={(open) => (open ? onOpenAsk() : onCloseAsk())}>
        <SheetContent side="right" hideClose className="w-full p-0 sm:max-w-md lg:hidden">
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
            onClose={onCloseAsk}
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
