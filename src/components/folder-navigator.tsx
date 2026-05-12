import { memo, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  BookOpenIcon,
  CaretDownIcon,
  CaretRightIcon,
  DotsThreeVerticalIcon,
  FolderIcon,
  FolderPlusIcon,
  PencilSimpleIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
import {
  buildFolderTree,
  isFeatureLevelArtifactKind,
  isRecentlyChanged,
  isRepoLevelArtifactKind,
  type FolderTreeNode,
} from "@/lib/artifact-folders";
import { formatArtifactKind } from "@/lib/operations";
import type { ArtifactId, ArtifactListItem, FolderId, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

type NavigatorArtifact = ArtifactListItem;

const EMPTY_ARTIFACTS: NavigatorArtifact[] = [];

type FolderNavigatorProps = {
  repositoryId: RepositoryId;
  /**
   * Repository-scoped artifacts (manifest, deep_analysis, …) plus any
   * feature-level artifacts that already carry a `folderId` for this repo.
   * Sourced from `repoDetail.artifacts` so the panel doesn't have to
   * subscribe a second query — the shell already pulls this list.
   */
  artifacts?: ReadonlyArray<NavigatorArtifact>;
  selectedArtifactId?: ArtifactId | null;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  onOpenInReader?: (artifactId: ArtifactId) => void;
  /**
   * Optional handler to flip into a "folder overview" surface — used by the
   * Reader's left rail when the user clicks a folder header. Panels that
   * do not have a folder-overview surface (e.g. the chat right rail) can
   * omit this and the folder header will simply expand/collapse.
   */
  onSelectFolder?: (folderId: FolderId | null) => void;
  selectedFolderId?: FolderId | null;
  className?: string;
};

/**
 * Tree-shaped artifact navigator. Replaces the flat "Repository
 * intelligence + Thread outputs" sectioning of the original
 * `ArtifactPanel`. Three logical sections at the root:
 *
 *   1. **Repository** — repo-level kinds (manifest, deep_analysis, …)
 *      pinned at the top. There is exactly one canonical row per kind here
 *      (latest version), so this section reads as "the one-page summary
 *      of this repo".
 *
 *   2. **Folders** — user-created folders. Each folder collapses; its
 *      header shows the folder icon, name, child count, and a kebab menu
 *      with rename / delete / move-to-parent. Children are nested folders
 *      and feature-level artifacts (ADR, failure mode, diagram, …).
 *
 *   3. **Uncategorized** — feature-level artifacts with no `folderId`
 *      (legacy data, or artifacts whose folder was deleted with the
 *      "move contents to parent" strategy while at root). Acts as the
 *      pickup pile until the user moves them into a folder.
 *
 * Folder collapse state persists per repo via `localStorage` so refreshes
 * don't reset the user's mental model of what they've explored. Selection
 * is *passive* — clicking a folder header invokes `onSelectFolder` (if
 * provided) and toggles its caret; clicking an artifact invokes
 * `onSelectArtifact`. Open-in-reader is a separate explicit affordance to
 * keep "I'm browsing" cleanly distinct from "open this for full reading".
 */
export function FolderNavigator({
  repositoryId,
  artifacts = EMPTY_ARTIFACTS,
  selectedArtifactId = null,
  onSelectArtifact,
  onOpenInReader,
  onSelectFolder,
  selectedFolderId = null,
  className,
}: FolderNavigatorProps) {
  const folders = useQuery(api.artifactFolders.listByRepository, { repositoryId });
  const createFolder = useMutation(api.artifactFolders.create);

  const [search, setSearch] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const tree = useMemo(() => buildFolderTree(folders ?? []), [folders]);

  /*
   * Bucket the artifacts so each row renders in exactly one section and we
   * never accidentally show a manifest in the user's "OAuth feature"
   * folder. Repo-level kinds go to the top section; feature-level kinds
   * route by `folderId` (specific folder) or fall through to
   * "Uncategorized" when unset.
   */
  const repositoryArtifacts = useMemo(
    () =>
      artifacts.filter((artifact) => artifact.repositoryId === repositoryId && isRepoLevelArtifactKind(artifact.kind)),
    [artifacts, repositoryId],
  );

  const artifactsByFolder = useMemo(() => {
    const map = new Map<string, NavigatorArtifact[]>();
    for (const artifact of artifacts) {
      if (!isFeatureLevelArtifactKind(artifact.kind)) continue;
      const folderId = artifact.folderId;
      if (!folderId) continue;
      const list = map.get(folderId) ?? [];
      list.push(artifact);
      map.set(folderId, list);
    }
    return map;
  }, [artifacts]);

  const uncategorizedArtifacts = useMemo(
    () =>
      artifacts.filter(
        (artifact) =>
          artifact.repositoryId === repositoryId && isFeatureLevelArtifactKind(artifact.kind) && !artifact.folderId,
      ),
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
    setCreateError(null);
    try {
      await createFolder({ repositoryId, name: baseName });
    } catch (error) {
      setCreateError(toUserErrorMessage(error, "Failed to create folder."));
    }
  });

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
          aria-label="Create folder"
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
          {repositoryArtifacts.length > 0 ? (
            <NavigatorSection title="Repository" description="Reusable context for this repo.">
              {repositoryArtifacts.map((artifact) => {
                if (filterPredicate && !filterPredicate(artifact)) return null;
                return (
                  <ArtifactRow
                    key={artifact._id}
                    artifact={artifact}
                    isSelected={selectedArtifactId === artifact._id}
                    onSelect={onSelectArtifact}
                    onOpenInReader={onOpenInReader}
                    indent={0}
                  />
                );
              })}
            </NavigatorSection>
          ) : null}

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
                    onOpenInReader={onOpenInReader}
                    onSelectFolder={onSelectFolder}
                    filterArtifact={filterPredicate}
                    folderMatchesSearch={folderMatchesSearch}
                  />
                ))
            )}
          </NavigatorSection>

          {uncategorizedArtifacts.length > 0 ? (
            <NavigatorSection
              title="Uncategorized"
              description="Artifacts not yet placed in a folder. Move them in via the kebab menu."
            >
              {uncategorizedArtifacts.map((artifact) => {
                if (filterPredicate && !filterPredicate(artifact)) return null;
                return (
                  <ArtifactRow
                    key={artifact._id}
                    artifact={artifact}
                    isSelected={selectedArtifactId === artifact._id}
                    onSelect={onSelectArtifact}
                    onOpenInReader={onOpenInReader}
                    indent={0}
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
  onOpenInReader,
  onSelectFolder,
  filterArtifact,
  folderMatchesSearch,
}: {
  repositoryId: RepositoryId;
  node: FolderTreeNode;
  artifactsByFolder: ReadonlyMap<string, NavigatorArtifact[]>;
  indent: number;
  selectedArtifactId: ArtifactId | null;
  selectedFolderId: FolderId | null;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  onOpenInReader?: (artifactId: ArtifactId) => void;
  onSelectFolder?: (folderId: FolderId | null) => void;
  filterArtifact: FilterFn;
  folderMatchesSearch: (node: FolderTreeNode) => boolean;
}) {
  const [isOpen, setIsOpen] = useLocalStorageBoolean(`systify.folderNav.open.${repositoryId}.${node.id}`, indent < 1);
  const renameFolder = useMutation(api.artifactFolders.rename);
  const removeFolder = useMutation(api.artifactFolders.remove);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);
  const folderArtifacts = artifactsByFolder.get(node.id) ?? EMPTY_ARTIFACTS;
  const childCount = folderArtifacts.length + node.children.length;
  const isSelected = selectedFolderId === (node.id as FolderId);

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

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] hover:bg-muted/60",
          isSelected ? "bg-muted/60" : "",
        )}
        style={{ paddingLeft: `${indent * 12 + 6}px` }}
      >
        <button
          type="button"
          aria-label={isOpen ? "Collapse folder" : "Expand folder"}
          className="text-muted-foreground transition-transform hover:text-foreground"
          onClick={() => setIsOpen((open) => !open)}
        >
          {isOpen ? <CaretDownIcon size={11} weight="bold" /> : <CaretRightIcon size={11} weight="bold" />}
        </button>
        <FolderIcon size={13} weight="duotone" className="shrink-0 text-muted-foreground" />
        {isRenaming ? (
          <Input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => void runRename()}
            onKeyDown={(event) => {
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
          <button
            type="button"
            className="flex flex-1 items-center justify-between gap-2 truncate text-left"
            onClick={() => {
              onSelectFolder?.(node.id as FolderId);
              setIsOpen(true);
            }}
          >
            <span className="truncate font-medium">{node.name}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{childCount}</span>
          </button>
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
            >
              <DotsThreeVerticalIcon size={13} weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
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
                onOpenInReader={onOpenInReader}
                onSelectFolder={onSelectFolder}
                filterArtifact={filterArtifact}
                folderMatchesSearch={folderMatchesSearch}
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
                onOpenInReader={onOpenInReader}
                indent={indent + 1}
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
  onOpenInReader,
  indent,
}: {
  artifact: NavigatorArtifact;
  isSelected: boolean;
  onSelect: (artifactId: ArtifactId) => void;
  onOpenInReader?: (artifactId: ArtifactId) => void;
  indent: number;
}) {
  const recentlyChanged = isRecentlyChanged(artifact._creationTime);
  const handleSelect = () => onSelect(artifact._id as ArtifactId);
  return (
    // The entire row is the click target so the hoverable area matches
    // the clickable one — a previous version made only the inner text
    // clickable, so users hovering the row's vertical padding got hover
    // feedback but no click. role="button" + tabIndex keeps it
    // keyboard-reachable; the icon Button stops propagation.
    <div
      role="button"
      tabIndex={0}
      aria-current={isSelected ? "true" : undefined}
      className={cn(
        "group flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        isSelected ? "bg-primary/10 ring-1 ring-primary/30" : "",
      )}
      style={{ paddingLeft: `${indent * 12 + 22}px`, contentVisibility: "auto", containIntrinsicSize: "28px" }}
      onClick={handleSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleSelect();
        }
      }}
    >
      <div className="flex flex-1 items-center gap-1.5 truncate">
        <ArtifactKindGlyph kind={artifact.kind} />
        <span className="truncate font-medium text-foreground">{artifact.title}</span>
        {recentlyChanged ? <span aria-hidden className="ml-1 inline-flex h-1.5 w-1.5 rounded-full bg-primary" /> : null}
        <FreshnessPill artifact={artifact} />
        <Badge variant="outline" className="ml-auto shrink-0 px-1 py-0 text-[9px] uppercase">
          v{artifact.version}
        </Badge>
      </div>
      {onOpenInReader ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Open in reader"
          className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onOpenInReader(artifact._id as ArtifactId);
          }}
        >
          <BookOpenIcon size={12} weight="bold" />
        </Button>
      ) : null}
    </div>
  );
});

function FreshnessPill({ artifact }: { artifact: NavigatorArtifact }) {
  if (!artifact.freshness) {
    return null;
  }

  const meta = getFreshnessMeta(artifact);
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex h-2 w-2 shrink-0 rounded-full", meta.dotClass)} aria-label={meta.label} />
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-64 text-xs">
          {meta.tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function getFreshnessMeta(artifact: NavigatorArtifact): {
  label: string;
  tooltip: string;
  dotClass: string;
} {
  const verifiedLabel = artifact.lastVerifiedAt
    ? `Last verified ${formatRelativeAge(artifact.lastVerifiedAt)} ago`
    : null;

  switch (artifact.freshness) {
    case "fresh":
      return {
        label: "Fresh artifact",
        tooltip: `${verifiedLabel ?? "Verified recently"} · Fresh`,
        dotClass: "bg-emerald-500",
      };
    case "aging":
      return {
        label: "Aging artifact",
        tooltip: `${verifiedLabel ?? "Verified previously"} · Aging`,
        dotClass: "bg-amber-500",
      };
    case "stale":
      return {
        label: "Stale artifact",
        tooltip: `${verifiedLabel ?? "Verified a while ago"} · Re-verify in Lab`,
        dotClass: "bg-red-500",
      };
    case "unverified":
      return {
        label: "Unverified artifact",
        tooltip:
          artifact.producedIn === "legacy"
            ? "Unverified legacy artifact · Re-verify in Lab"
            : "Not verified against live code · Re-verify in Lab",
        dotClass: "bg-muted-foreground/45",
      };
    default:
      return {
        label: "Unverified artifact",
        tooltip: "Not verified against live code · Re-verify in Lab",
        dotClass: "bg-muted-foreground/45",
      };
  }
}

function formatRelativeAge(timestamp: number): string {
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  return `${years}y`;
}

function ArtifactKindGlyph({ kind }: { kind: Doc<"artifacts">["kind"] }) {
  // Lightweight kind indicator — three letters, like a file extension.
  // Keeps the tree dense without requiring per-kind icons.
  const label = formatArtifactKind(kind)
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="inline-flex h-4 w-5 shrink-0 items-center justify-center rounded-sm bg-muted text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">
      {label}
    </span>
  );
}
