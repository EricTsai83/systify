import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  DotsThreeVerticalIcon,
  FolderPlusIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { useLocalStorageBoolean } from "@/hooks/use-persisted-state";
import { toUserErrorMessage } from "@/lib/errors";
import { buildFolderTree, type FolderTreeNode } from "@/lib/artifact-folders";
import { formatArtifactKind } from "@/lib/operations";
import type { ArtifactId, ArtifactListItem, FolderId, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

type NavigatorArtifact = ArtifactListItem;

const EMPTY_ARTIFACTS: NavigatorArtifact[] = [];

type FolderNavigatorProps = {
  repositoryId: RepositoryId;
  /**
   * Every artifact for this repo, regardless of kind. Routing is by
   * `folderId` only — see the component docstring for the section split.
   * Sourced from the shell's existing artifact subscription so the panel
   * doesn't have to spin up a second query.
   */
  artifacts?: ReadonlyArray<NavigatorArtifact>;
  selectedArtifactId?: ArtifactId | null;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  /**
   * Optional handler to flip into a "folder overview" surface — used by the
   * Reader's left rail when the user clicks a folder header. Panels that
   * do not have a folder-overview surface (e.g. the chat right rail) can
   * omit this and the folder header will simply expand/collapse.
   */
  onSelectFolder?: (folderId: FolderId | null) => void;
  selectedFolderId?: FolderId | null;
  /**
   * Predicate that decides whether an artifact still has an unread "changed
   * since you last looked" dot. Owned by the parent so the per-viewer view
   * state survives the navigator unmounting; omit to disable the dot.
   */
  isUnseen?: (artifact: NavigatorArtifact) => boolean;
  className?: string;
};

/**
 * Tree-shaped artifact navigator. Two logical sections at the root:
 *
 *   1. **Folders** — every folder for the repo, including the seeded
 *      System Design folders (Overview, Architecture, …) that carry a
 *      `systemKey`. Seeded folders default-expanded; user-created folders
 *      start collapsed. Each folder header shows name + child count and a
 *      kebab menu with rename / delete-and-move-contents-up. Children are
 *      nested folders and any artifact placed via `folderId`.
 *
 *   2. **Repository root** — artifacts with no `folderId`. The name mirrors
 *      the FolderPicker's "Repository root" option so the same destination
 *      reads the same way on both surfaces. Typical contents are
 *      `+ Generate`-produced artifacts the user left at root, plus legacy
 *      rows.
 *
 * Routing is single-source: `folderId` decides placement, full stop. There
 * is no separate kind-based "Repository" pin — repo-level System Design
 * kinds (manifest, README summary, …) land in their seeded folders via
 * `SYSTEM_DESIGN_KIND_TO_FOLDER` at write time.
 *
 * Folder collapse state persists per repo via `localStorage` so refreshes
 * don't reset the user's mental model of what they've explored. Selection
 * is *passive* — clicking a folder header invokes `onSelectFolder` (if
 * provided) and toggles its caret; clicking an artifact invokes
 * `onSelectArtifact`.
 */
export function FolderNavigator({
  repositoryId,
  artifacts = EMPTY_ARTIFACTS,
  selectedArtifactId = null,
  onSelectArtifact,
  onSelectFolder,
  selectedFolderId = null,
  isUnseen,
  className,
}: FolderNavigatorProps) {
  const folders = useQuery(api.artifactFolders.listByRepository, { repositoryId });
  const createFolder = useMutation(api.artifactFolders.create);

  const [search, setSearch] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  // VS Code-style nested create: after `createFolder` returns we hand the
  // tree two one-shot signals — `pendingExpand…` flips the new folder's
  // parent open so the child can mount, and `pendingRename…` puts the new
  // child into inline-rename mode so the user names it immediately. Each
  // branch consumes its matching signal and clears it.
  const [pendingExpandFolderId, setPendingExpandFolderId] = useState<FolderId | null>(null);
  const [pendingRenameFolderId, setPendingRenameFolderId] = useState<FolderId | null>(null);
  const consumePendingExpand = useCallback(() => setPendingExpandFolderId(null), []);
  const consumePendingRename = useCallback(() => setPendingRenameFolderId(null), []);

  const tree = useMemo(() => buildFolderTree(folders ?? []), [folders]);

  const selectedFolderName = useMemo(() => {
    if (!selectedFolderId || !folders) return null;
    return folders.find((folder) => folder._id === selectedFolderId)?.name ?? null;
  }, [folders, selectedFolderId]);

  const artifactsByFolder = useMemo(() => {
    const map = new Map<string, NavigatorArtifact[]>();
    for (const artifact of artifacts) {
      const folderId = artifact.folderId;
      if (!folderId) continue;
      const list = map.get(folderId) ?? [];
      list.push(artifact);
      map.set(folderId, list);
    }
    return map;
  }, [artifacts]);

  const uncategorizedArtifacts = useMemo(
    () => artifacts.filter((artifact) => artifact.repositoryId === repositoryId && !artifact.folderId),
    [artifacts, repositoryId],
  );

  const filterPredicate = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return null;
    return (artifact: NavigatorArtifact) => {
      const haystack = `${artifact.title} ${artifact.summary} ${formatArtifactKind(artifact.kind)}`.toLowerCase();
      return haystack.includes(needle);
    };
  }, [search]);

  // `folderMatchesSearch` is a plain recursive function on purpose: a
  // useCallback that references itself in its own dependency array would
  // either form a forward-reference (lint error) or stale-closure cycle.
  // The function closes over `filterPredicate` / `artifactsByFolder` /
  // `search`, all of which are recomputed every render anyway, so there's
  // nothing meaningful to memoise.
  const needle = search.trim().toLowerCase();
  const folderMatchesSearch = (node: FolderTreeNode): boolean => {
    if (!filterPredicate) return true;
    if (node.name.toLowerCase().includes(needle)) return true;
    const folderArtifacts = artifactsByFolder.get(node.id) ?? [];
    if (folderArtifacts.some(filterPredicate)) return true;
    return node.children.some(folderMatchesSearch);
  };

  const [isCreating, runCreateFolder] = useAsyncCallback(async () => {
    const baseName = "New folder";
    const parentFolderId = selectedFolderId ?? undefined;
    setCreateError(null);
    try {
      const newFolderId = await createFolder({ repositoryId, name: baseName, parentFolderId });
      // Expand the parent (if any) so the new branch can actually mount, then
      // hand selection to the new folder and pop it into rename mode so the
      // next "+" press creates deeper and the user can name it inline.
      if (parentFolderId) {
        setPendingExpandFolderId(parentFolderId);
      }
      setPendingRenameFolderId(newFolderId);
      onSelectFolder?.(newFolderId);
    } catch (error) {
      setCreateError(toUserErrorMessage(error, "Failed to create folder."));
    }
  });

  const createButtonLabel = selectedFolderName ? `Create folder in ${selectedFolderName}` : "Create folder at root";

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search folders & artifacts"
          className="h-8 text-[12px]"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={createButtonLabel}
          title={createButtonLabel}
          disabled={isCreating}
          onClick={() => void runCreateFolder()}
        >
          <FolderPlusIcon size={16} weight="bold" />
        </Button>
      </div>

      {createError ? (
        <div className="flex items-start justify-between gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          <span>{createError}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            className="shrink-0 text-destructive/80 hover:text-destructive"
            onClick={() => setCreateError(null)}
          >
            <XIcon size={10} weight="bold" />
          </button>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          <NavigatorSection title="Folders" description="Group artifacts by feature, decision, or subsystem.">
            {tree.length === 0 ? (
              <p className="px-1 text-[11px] text-muted-foreground/80">
                No folders yet. Click the folder-plus icon above to create one.
              </p>
            ) : (
              tree
                .filter((node) => folderMatchesSearch(node))
                .map((node) => (
                  <FolderTreeBranch
                    key={node.id}
                    repositoryId={repositoryId}
                    node={node}
                    artifactsByFolder={artifactsByFolder}
                    indent={0}
                    selectedArtifactId={selectedArtifactId}
                    selectedFolderId={selectedFolderId}
                    onSelectArtifact={onSelectArtifact}
                    onSelectFolder={onSelectFolder}
                    filterArtifact={filterPredicate}
                    folderMatchesSearch={folderMatchesSearch}
                    isUnseen={isUnseen}
                    pendingExpandFolderId={pendingExpandFolderId}
                    pendingRenameFolderId={pendingRenameFolderId}
                    onConsumePendingExpand={consumePendingExpand}
                    onConsumePendingRename={consumePendingRename}
                  />
                ))
            )}
          </NavigatorSection>

          {uncategorizedArtifacts.length > 0 ? (
            <NavigatorSection
              title="Repository root"
              description="Artifacts left at root (no folder). Move them into a folder via the kebab menu."
            >
              {uncategorizedArtifacts.map((artifact) => {
                if (filterPredicate && !filterPredicate(artifact)) return null;
                return (
                  <ArtifactRow
                    key={artifact._id}
                    artifact={artifact}
                    isSelected={selectedArtifactId === artifact._id}
                    onSelect={onSelectArtifact}
                    indent={0}
                    isUnseen={isUnseen ? isUnseen(artifact) : false}
                  />
                );
              })}
            </NavigatorSection>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

function NavigatorSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="px-1">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</h3>
        <p className="text-[10px] text-muted-foreground/70">{description}</p>
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  );
}

type FilterFn = ((artifact: NavigatorArtifact) => boolean) | null;

function FolderTreeBranch({
  repositoryId,
  node,
  artifactsByFolder,
  indent,
  selectedArtifactId,
  selectedFolderId,
  onSelectArtifact,
  onSelectFolder,
  filterArtifact,
  folderMatchesSearch,
  isUnseen,
  pendingExpandFolderId,
  pendingRenameFolderId,
  onConsumePendingExpand,
  onConsumePendingRename,
}: {
  repositoryId: RepositoryId;
  node: FolderTreeNode;
  artifactsByFolder: ReadonlyMap<string, NavigatorArtifact[]>;
  indent: number;
  selectedArtifactId: ArtifactId | null;
  selectedFolderId: FolderId | null;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  onSelectFolder?: (folderId: FolderId | null) => void;
  filterArtifact: FilterFn;
  folderMatchesSearch: (node: FolderTreeNode) => boolean;
  isUnseen?: (artifact: NavigatorArtifact) => boolean;
  pendingExpandFolderId: FolderId | null;
  pendingRenameFolderId: FolderId | null;
  onConsumePendingExpand: () => void;
  onConsumePendingRename: () => void;
}) {
  const [isOpen, setIsOpen] = useLocalStorageBoolean(
    `systify.folderNav.open.${repositoryId}.${node.id}`,
    indent < 1 || node.systemKey !== undefined,
  );
  const renameFolder = useMutation(api.artifactFolders.rename);
  const removeFolder = useMutation(api.artifactFolders.remove);
  const setFolderPinned = useMutation(api.artifactFolders.setPinned);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);
  const folderArtifacts = artifactsByFolder.get(node.id) ?? EMPTY_ARTIFACTS;
  const childCount = folderArtifacts.length + node.children.length;
  const isSelected = selectedFolderId === (node.id as FolderId);
  const isPinned = node.pinnedAt !== undefined;

  const [isRenamePending, runRename] = useAsyncCallback(async () => {
    const next = draftName.trim();
    if (!next || next === node.name) {
      setIsRenaming(false);
      setDraftName(node.name);
      return;
    }
    try {
      await renameFolder({ folderId: node.id as FolderId, name: next });
    } catch {
      // Surface inline; reset to known-good name.
      setDraftName(node.name);
    } finally {
      setIsRenaming(false);
    }
  });

  const [isRemovePending, runRemoveMoveContents] = useAsyncCallback(async () => {
    try {
      await removeFolder({ folderId: node.id as FolderId, strategy: "moveContentsToParent" });
    } catch {
      // The mutation surfaces a server error; we leave the folder visible
      // so the user can retry instead of silently failing.
    }
  });

  const [isPinPending, runTogglePin] = useAsyncCallback(async () => {
    try {
      await setFolderPinned({ folderId: node.id as FolderId, pinned: !isPinned });
    } catch {
      // Toggling the pin is non-destructive; if it fails the navigator stays
      // in the prior state and the user can retry from the menu.
    }
  });

  useEffect(() => {
    if (pendingExpandFolderId !== (node.id as FolderId)) return;
    setIsOpen(true);
    onConsumePendingExpand();
  }, [node.id, onConsumePendingExpand, pendingExpandFolderId, setIsOpen]);

  useEffect(() => {
    if (pendingRenameFolderId !== (node.id as FolderId)) return;
    // Empty draft so the user types the name from scratch (VS Code parity).
    // Blur or Escape keep the seeded "New folder" name — see `runRename`.
    setDraftName("");
    setIsRenaming(true);
    onConsumePendingRename();
  }, [node.id, onConsumePendingRename, pendingRenameFolderId]);

  // Whole-row activation: clicking anywhere on the row toggles
  // expand/collapse and selects the folder, so the caret no longer needs to
  // be a separate hit target. Children that own their own click semantics
  // (rename input, kebab) call `stopPropagation` so they don't double-fire.
  const handleRowActivate = () => {
    setIsOpen((open) => !open);
    onSelectFolder?.(node.id as FolderId);
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={isRenaming ? -1 : 0}
        aria-expanded={isOpen}
        aria-label={node.name}
        className={cn(
          "group flex cursor-pointer items-center gap-1 px-1.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          isSelected ? "bg-primary/10 ring-1 ring-primary/40 hover:bg-primary/15" : "hover:bg-muted/60",
        )}
        style={{ paddingLeft: `${indent * 12 + 6}px` }}
        onClick={handleRowActivate}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && event.currentTarget === event.target) {
            event.preventDefault();
            handleRowActivate();
          }
        }}
      >
        <span aria-hidden className="text-muted-foreground">
          {isOpen ? <CaretDownIcon size={11} weight="bold" /> : <CaretRightIcon size={11} weight="bold" />}
        </span>
        {isRenaming ? (
          <Input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => void runRename()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                void runRename();
              } else if (event.key === "Escape") {
                setIsRenaming(false);
                setDraftName(node.name);
              }
            }}
            className="h-6 flex-1 text-[12px]"
            disabled={isRenamePending}
          />
        ) : (
          <span className="flex flex-1 items-center justify-between gap-2 truncate text-left">
            <span className="truncate font-medium">{node.name}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground">
              {isPinned ? (
                <PushPinIcon size={10} weight="fill" aria-label="Pinned" className="text-muted-foreground" />
              ) : null}
              {childCount}
            </span>
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
              aria-label="Folder actions"
              disabled={isRemovePending}
              onClick={(event) => event.stopPropagation()}
            >
              <DotsThreeVerticalIcon size={13} weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void runTogglePin()} disabled={isPinPending}>
              {isPinned ? (
                <>
                  <PushPinSlashIcon size={12} weight="bold" /> Unpin
                </>
              ) : (
                <>
                  <PushPinIcon size={12} weight="bold" /> Pin to top
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setIsRenaming(true);
                setDraftName(node.name);
              }}
            >
              <PencilSimpleIcon size={12} weight="bold" /> Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void runRemoveMoveContents()} className="text-destructive">
              <TrashIcon size={12} weight="bold" /> Delete (move contents up)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isOpen ? (
        <div className="flex flex-col gap-0.5">
          {node.children
            .filter((child) => folderMatchesSearch(child))
            .map((child) => (
              <FolderTreeBranch
                key={child.id}
                repositoryId={repositoryId}
                node={child}
                artifactsByFolder={artifactsByFolder}
                indent={indent + 1}
                selectedArtifactId={selectedArtifactId}
                selectedFolderId={selectedFolderId}
                onSelectArtifact={onSelectArtifact}
                onSelectFolder={onSelectFolder}
                filterArtifact={filterArtifact}
                folderMatchesSearch={folderMatchesSearch}
                isUnseen={isUnseen}
                pendingExpandFolderId={pendingExpandFolderId}
                pendingRenameFolderId={pendingRenameFolderId}
                onConsumePendingExpand={onConsumePendingExpand}
                onConsumePendingRename={onConsumePendingRename}
              />
            ))}
          {folderArtifacts.map((artifact) => {
            if (filterArtifact && !filterArtifact(artifact)) return null;
            return (
              <ArtifactRow
                key={artifact._id}
                artifact={artifact}
                isSelected={selectedArtifactId === artifact._id}
                onSelect={onSelectArtifact}
                indent={indent + 1}
                isUnseen={isUnseen ? isUnseen(artifact) : false}
              />
            );
          })}
          {folderArtifacts.length === 0 && node.children.length === 0 ? (
            <p
              className="px-1 py-1 text-[10px] italic text-muted-foreground/70"
              style={{ paddingLeft: `${(indent + 1) * 12 + 12}px` }}
            >
              Empty folder.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const ArtifactRow = memo(function ArtifactRow({
  artifact,
  isSelected,
  onSelect,
  indent,
  isUnseen,
}: {
  artifact: NavigatorArtifact;
  isSelected: boolean;
  onSelect: (artifactId: ArtifactId) => void;
  indent: number;
  isUnseen: boolean;
}) {
  const handleSelect = () => onSelect(artifact._id as ArtifactId);
  return (
    // The entire row is the click target so the hoverable area matches
    // the clickable one. role="button" + tabIndex keeps it keyboard-reachable.
    <div
      role="button"
      tabIndex={0}
      aria-current={isSelected ? "true" : undefined}
      className={cn(
        "group flex cursor-pointer items-center gap-1 px-1.5 py-1 text-left text-[12px] hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        isSelected ? "bg-primary/10 ring-1 ring-primary/30" : "",
      )}
      style={{ paddingLeft: `${indent * 12 + 22}px`, contentVisibility: "auto", containIntrinsicSize: "28px" }}
      onClick={handleSelect}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && event.currentTarget === event.target) {
          event.preventDefault();
          handleSelect();
        }
      }}
    >
      <div className="flex flex-1 items-center gap-1.5 truncate">
        <span className="truncate font-medium text-foreground">{artifact.title}</span>
        {artifact.importDriftFromLatestSync ? (
          <span
            role="img"
            title="This artifact's aligned import revision differs from the latest repository sync."
            className="inline-flex shrink-0 text-amber-600 dark:text-amber-400"
            aria-label="Import snapshot drift versus latest sync"
          >
            <ArrowsClockwiseIcon size={12} weight="bold" />
          </span>
        ) : null}
        {isUnseen ? <span aria-hidden className="ml-1 inline-flex h-1.5 w-1.5 rounded-full bg-primary" /> : null}
      </div>
    </div>
  );
});
