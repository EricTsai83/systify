import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { FolderIcon, SparkleIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { GenerateSystemDesignDialog } from "@/components/generate-system-design-dialog";
import { LibraryEditor } from "@/components/library-editor";
import { LibraryTabs } from "@/components/library-tabs";
import { LibraryTree } from "@/components/library-tree";
import { QuickOpenDialog } from "@/components/quick-open-dialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useLibraryShortcuts } from "@/hooks/use-library-shortcuts";
import type { LibraryTabsApi } from "@/hooks/use-library-tabs";
import { useWarmArtifactSubscriptions } from "@/hooks/use-warm-artifact-subscriptions";
import type { ArtifactId, ArtifactListItem, FolderId, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Library shell — two-column desktop layout:
 *
 *   LEFT  — Document: artifact tab strip + editor.
 *   RIGHT — Folder tree (collapsible via Cmd+B).
 *
 * Library Ask is no longer a column here — it lives in the app sidebar.
 * The tab-strip state is owned by the Library page and handed in via
 * `tabs` so the sidebar's Ask panel and this document column stay in sync.
 *
 * On narrow viewports the document column is the base layer and the folder
 * tree moves into a Sheet.
 */
export function LibraryShell({ repositoryId, tabs }: { repositoryId: RepositoryId; tabs: LibraryTabsApi }) {
  const allArtifacts = useQuery(api.artifacts.listMetadataByRepositoryWithFreshness, { repositoryId });

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
  const [isTreeCollapsedDesktop, setIsTreeCollapsedDesktop] = useState(false);
  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
  const [isGenerateDialogOpen, setIsGenerateDialogOpen] = useState(false);
  const [isLargeViewport, setIsLargeViewport] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches,
  );

  const hasArtifacts = (allArtifacts?.length ?? 0) > 0;
  const openGenerateDialog = useCallback(() => setIsGenerateDialogOpen(true), []);

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

  const navigatorPanel = (
    <LibraryTree
      repositoryId={repositoryId}
      artifacts={allArtifacts ?? []}
      selectedArtifactId={tabs.activeArtifactId}
      onSelectArtifact={handleSelectArtifact}
      onGenerate={openGenerateDialog}
      className="min-h-[160px]"
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col lg:flex-row">
      {/* LEFT: Document stack */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background/80 px-4 py-2 backdrop-blur lg:hidden">
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

        {tabs.activeArtifactId ? (
          <LibraryEditor artifactId={tabs.activeArtifactId} />
        ) : (
          <LibraryEmptyState hasArtifacts={hasArtifacts} onGenerate={openGenerateDialog} />
        )}
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

      <GenerateSystemDesignDialog
        open={isGenerateDialogOpen}
        onOpenChange={setIsGenerateDialogOpen}
        repositoryId={repositoryId}
      />
    </div>
  );
}

function LibraryEmptyState({ hasArtifacts, onGenerate }: { hasArtifacts: boolean; onGenerate: () => void }) {
  if (!hasArtifacts) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-md text-center">
          <h2 className="text-base font-semibold text-foreground">No documents yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Generate the System Design starter set — a manifest, README summary, and an architecture overview — straight
            into your Library.
          </p>
          <Button type="button" size="sm" className="mt-5 gap-1.5" onClick={onGenerate}>
            <SparkleIcon size={14} weight="bold" />
            Generate System Design
          </Button>
        </div>
      </div>
    );
  }
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
