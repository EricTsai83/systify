import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "convex/react";
import {
  ArrowLeftIcon,
  CaretRightIcon,
  CheckIcon,
  CopySimpleIcon,
  FolderIcon,
  ListBulletsIcon,
} from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { ArtifactMarkdown } from "@/components/artifact-markdown";
import { MermaidRenderer } from "@/components/mermaid-renderer";
import { FolderNavigator } from "@/components/folder-navigator";
import { FolderOverview } from "@/components/folder-overview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { MoveArtifactDialog } from "@/components/move-artifact-dialog";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { formatArtifactKind } from "@/lib/operations";
import type { ArtifactId, FolderId, RepositoryId, WorkspaceId } from "@/lib/types";
import { workspaceArtifactPath, workspaceThreadPath, workspacePath } from "@/route-paths";

type ArtifactReaderProps = {
  workspaceId: WorkspaceId;
  artifactId: ArtifactId;
};

/**
 * Reader: full-width artifact view with a folder-aware left sidebar.
 *
 * Layout (desktop ≥1024px):
 *   - Left ~320px: folder navigator (and, when the user clicks a folder
 *     header, an inline FolderOverview surface). Lets the user keep
 *     reading sibling artifacts without going back to the panel.
 *   - Right: artifact content. Breadcrumb at top (Repository / [Folder] /
 *     [Title]), ToC button on the right of the breadcrumb (opens a Sheet
 *     with the H1/H2/H3 outline), then the rendered body. A bottom row
 *     surfaces sibling navigation when the artifact is in a folder.
 *
 * Layout (mobile <1024px):
 *   - Single column with the artifact body. The folders are reachable
 *     through a top-bar "Folders" button that opens a Sheet.
 *
 * The Reader is read-mostly: it does not stream chat or run Convex
 * mutations on its critical render path. The only mutation tied to this
 * surface is "Move artifact to folder" via {@link MoveArtifactDialog}.
 */
export function ArtifactReader({ workspaceId, artifactId }: ArtifactReaderProps) {
  const navigate = useNavigate();
  const artifact = useQuery(api.artifacts.getById, { artifactId });
  const folder = useQuery(api.artifactFolders.getById, artifact?.folderId ? { folderId: artifact.folderId } : "skip");

  const repositoryId = artifact?.repositoryId ?? null;
  const folderArtifacts = useQuery(
    api.artifacts.listByFolder,
    artifact?.folderId ? { folderId: artifact.folderId } : "skip",
  );

  const [tocOpen, setTocOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [activeSidebarFolderId, setActiveSidebarFolderId] = useState<FolderId | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const repositoryArtifacts = useRepositoryArtifacts(repositoryId);

  const handleSelectArtifact = useCallback(
    (id: ArtifactId) => {
      void navigate(workspaceArtifactPath(workspaceId, id));
      setFoldersOpen(false);
      setActiveSidebarFolderId(null);
    },
    [navigate, workspaceId],
  );

  const [, runCopy] = useAsyncCallback(async () => {
    if (!artifact) return;
    try {
      await navigator.clipboard.writeText(artifact.contentMarkdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Browsers without clipboard API support — leave the affordance idle.
    }
  });

  // Loading + not-found states. We treat "definitely null" as not-found so a
  // bookmarked URL whose artifact got deleted on another device shows a
  // recoverable surface instead of an empty body.
  if (artifact === undefined) {
    return <ReaderSkeleton />;
  }
  if (artifact === null) {
    return <ReaderNotFound workspaceId={workspaceId} />;
  }

  const headings = extractHeadings(artifact.contentMarkdown);

  const siblingArtifacts = artifact.folderId ? (folderArtifacts ?? []) : [];
  const siblingIndex = siblingArtifacts.findIndex((entry) => entry._id === artifact._id);
  const previousSibling = siblingIndex > 0 ? siblingArtifacts[siblingIndex - 1] : null;
  const nextSibling =
    siblingIndex >= 0 && siblingIndex < siblingArtifacts.length - 1 ? siblingArtifacts[siblingIndex + 1] : null;

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Desktop folder rail */}
      <aside aria-label="Folders" className="hidden w-80 shrink-0 flex-col border-r border-border bg-muted/20 lg:flex">
        <Tabs value={activeSidebarFolderId ? "folder" : "tree"} className="flex h-full min-h-0 flex-col">
          <TabsList className="m-2 grid grid-cols-2">
            <TabsTrigger value="tree" onClick={() => setActiveSidebarFolderId(null)}>
              All folders
            </TabsTrigger>
            <TabsTrigger value="folder" disabled={activeSidebarFolderId === null}>
              {activeSidebarFolderId ? "Folder" : "Folder"}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="tree" className="flex min-h-0 flex-1 flex-col">
            {repositoryId ? (
              <FolderNavigator
                repositoryId={repositoryId}
                artifacts={repositoryArtifacts}
                selectedArtifactId={artifact._id as ArtifactId}
                selectedFolderId={null}
                onSelectArtifact={handleSelectArtifact}
                onOpenInReader={handleSelectArtifact}
                onSelectFolder={(id) => setActiveSidebarFolderId(id)}
              />
            ) : (
              <p className="px-3 py-2 text-[12px] text-muted-foreground">This artifact is not bound to a repository.</p>
            )}
          </TabsContent>
          <TabsContent value="folder" className="flex min-h-0 flex-1 flex-col">
            {activeSidebarFolderId ? (
              <FolderOverview
                folderId={activeSidebarFolderId}
                onSelectArtifact={handleSelectArtifact}
                onAfterDelete={() => setActiveSidebarFolderId(null)}
              />
            ) : null}
          </TabsContent>
        </Tabs>
      </aside>

      {/* Right pane — artifact content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background/80 px-4 py-3 backdrop-blur">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              if (artifact.threadId) {
                void navigate(workspaceThreadPath(workspaceId, artifact.threadId as Id<"threads">));
              } else {
                void navigate(workspacePath(workspaceId));
              }
            }}
          >
            <ArrowLeftIcon size={13} weight="bold" /> Back
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 lg:hidden"
            onClick={() => setFoldersOpen(true)}
          >
            <FolderIcon size={13} weight="duotone" /> Folders
          </Button>

          <ReaderBreadcrumb folderName={folder?.name ?? null} title={artifact.title} />

          <div className="ml-auto flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => setMoveOpen(true)}>
              <FolderIcon size={13} weight="bold" /> Move
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => void runCopy()}
              aria-label="Copy markdown"
            >
              {copied ? <CheckIcon size={13} weight="bold" /> : <CopySimpleIcon size={13} weight="bold" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            {headings.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => setTocOpen(true)}
                aria-label="Open outline"
              >
                <ListBulletsIcon size={13} weight="bold" /> Outline
              </Button>
            ) : null}
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <article className="mx-auto flex w-full max-w-[68ch] flex-col gap-4 px-6 py-8">
            <header className="flex flex-col gap-3 border-b border-border pb-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="text-[10px] uppercase">
                  {formatArtifactKind(artifact.kind)}
                </Badge>
                <Badge variant="outline" className="text-[10px] uppercase">
                  v{artifact.version}
                </Badge>
                <span className="text-[11px] text-muted-foreground">
                  {new Date(artifact._creationTime).toLocaleString()}
                </span>
                <span className="text-[11px] text-muted-foreground">·</span>
                <span className="text-[11px] capitalize text-muted-foreground">{artifact.source}</span>
              </div>
              <h1 className="text-2xl font-semibold leading-tight tracking-tight">{artifact.title}</h1>
              <p className="text-[14px] text-muted-foreground">{artifact.summary}</p>
            </header>

            {artifact.kind === "architecture_diagram" ? (
              <MermaidRenderer source={artifact.contentMarkdown} />
            ) : (
              <ArtifactMarkdown
                source={artifact.contentMarkdown}
                className="border-0 bg-transparent [&_[data-slot=scroll-area-viewport]]:max-h-none"
              />
            )}

            {artifact.folderId ? (
              <SiblingNav workspaceId={workspaceId} previous={previousSibling} next={nextSibling} />
            ) : null}
          </article>
        </ScrollArea>
      </div>

      {/* Mobile folder sheet */}
      <Sheet open={foldersOpen} onOpenChange={setFoldersOpen}>
        <SheetContent side="left" className="w-80 p-0 sm:w-96">
          <SheetTitle className="sr-only">Folders</SheetTitle>
          <SheetDescription className="sr-only">Browse and switch between folders and artifacts.</SheetDescription>
          <div className="flex h-full min-h-0 flex-col">
            {repositoryId ? (
              <FolderNavigator
                repositoryId={repositoryId}
                artifacts={repositoryArtifacts}
                selectedArtifactId={artifact._id as ArtifactId}
                onSelectArtifact={handleSelectArtifact}
                onOpenInReader={handleSelectArtifact}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      {/* Outline sheet */}
      <Sheet open={tocOpen} onOpenChange={setTocOpen}>
        <SheetContent side="right" className="w-72 p-0">
          <SheetTitle className="sr-only">Outline</SheetTitle>
          <SheetDescription className="sr-only">Quick jumps to sections in this artifact.</SheetDescription>
          <ScrollArea className="h-full">
            <nav className="flex flex-col gap-1 p-3">
              <h3 className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Outline
              </h3>
              {headings.map((entry, index) => (
                <a
                  key={`${entry.id}-${index}`}
                  href={`#${entry.id}`}
                  className="rounded px-2 py-1 text-[12px] text-foreground hover:bg-muted/60"
                  style={{ paddingLeft: `${entry.level * 8}px` }}
                  onClick={() => setTocOpen(false)}
                >
                  {entry.text}
                </a>
              ))}
            </nav>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <MoveArtifactDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        artifactId={artifact._id as ArtifactId}
        repositoryId={repositoryId}
        currentFolderId={(artifact.folderId ?? null) as FolderId | null}
      />
    </div>
  );
}

function ReaderBreadcrumb({ folderName, title }: { folderName: string | null; title: string }) {
  return (
    <nav aria-label="Artifact breadcrumb" className="flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">
      <span>Repository</span>
      <CaretRightIcon size={10} weight="bold" />
      {folderName ? (
        <>
          <span className="truncate text-foreground">{folderName}</span>
          <CaretRightIcon size={10} weight="bold" />
        </>
      ) : null}
      <span className="truncate font-medium text-foreground">{title}</span>
    </nav>
  );
}

function SiblingNav({
  workspaceId,
  previous,
  next,
}: {
  workspaceId: WorkspaceId;
  previous: Doc<"artifacts"> | null;
  next: Doc<"artifacts"> | null;
}) {
  if (!previous && !next) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border pt-4 text-[12px]">
      {previous ? (
        <Link
          to={workspaceArtifactPath(workspaceId, previous._id as ArtifactId)}
          className="group flex max-w-[45%] flex-col gap-0.5 truncate"
        >
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Previous</span>
          <span className="truncate font-medium text-foreground group-hover:underline">{previous.title}</span>
        </Link>
      ) : (
        <span aria-hidden />
      )}
      {next ? (
        <Link
          to={workspaceArtifactPath(workspaceId, next._id as ArtifactId)}
          className="group flex max-w-[45%] flex-col gap-0.5 truncate text-right"
        >
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Next</span>
          <span className="truncate font-medium text-foreground group-hover:underline">{next.title}</span>
        </Link>
      ) : (
        <span aria-hidden />
      )}
    </div>
  );
}

function ReaderSkeleton() {
  return (
    <div className="flex h-full min-h-0 w-full">
      <aside className="hidden w-80 shrink-0 flex-col gap-2 border-r border-border bg-muted/20 p-4 lg:flex">
        <div className="h-6 w-40 animate-pulse rounded bg-muted/60" />
        <div className="h-4 w-full animate-pulse rounded bg-muted/60" />
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted/60" />
      </aside>
      <div className="flex flex-1 flex-col gap-3 px-6 py-8">
        <div className="h-7 w-2/3 animate-pulse rounded bg-muted/60" />
        <div className="h-4 w-1/3 animate-pulse rounded bg-muted/60" />
        <div className="mt-4 flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="h-3 w-full animate-pulse rounded bg-muted/40" />
          ))}
        </div>
      </div>
    </div>
  );
}

function ReaderNotFound({ workspaceId }: { workspaceId: WorkspaceId }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10">
      <div className="w-full max-w-md text-center">
        <h2 className="text-base font-semibold text-foreground">Artifact not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The artifact may have been deleted, or you no longer have access. Return to the workspace to keep working.
        </p>
        <Button asChild className="mt-5" variant="default">
          <Link to={workspacePath(workspaceId)}>Back to workspace</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * Returns *every* artifact in the repo so the FolderNavigator can render
 * the complete tree (not just the few rows `getRepositoryDetail`
 * surfaces for the status deck). The query is bounded server-side to 200
 * entries; for larger repositories we'll paginate per-folder via
 * {@link api.artifacts.listByFolder} when the navigator hits the limit.
 */
function useRepositoryArtifacts(repositoryId: RepositoryId | null): ReadonlyArray<Doc<"artifacts">> {
  const artifacts = useQuery(api.artifacts.listByRepository, repositoryId ? { repositoryId } : "skip");
  return useMemo(() => artifacts ?? [], [artifacts]);
}

const HEADING_REGEX = /^(#{1,3})\s+(.+?)\s*#*\s*$/gm;

function extractHeadings(source: string): Array<{ id: string; level: number; text: string }> {
  const out: Array<{ id: string; level: number; text: string }> = [];
  const seen = new Map<string, number>();
  let match: RegExpExecArray | null;
  HEADING_REGEX.lastIndex = 0;
  while ((match = HEADING_REGEX.exec(source))) {
    const level = match[1].length;
    const text = match[2].trim();
    const baseId =
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "section";
    const count = seen.get(baseId) ?? 0;
    seen.set(baseId, count + 1);
    const id = count === 0 ? baseId : `${baseId}-${count}`;
    out.push({ id, level, text });
  }
  return out;
}
