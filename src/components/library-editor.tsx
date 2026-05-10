import { forwardRef, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { CaretRightIcon, CheckIcon, CopySimpleIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { ArtifactMarkdown } from "@/components/artifact-markdown";
import { MermaidRenderer } from "@/components/mermaid-renderer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { extractHeadings, type MarkdownHeading } from "@/lib/markdown-headings";
import { formatArtifactKind } from "@/lib/operations";
import type { ArtifactId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Three-mode restructure — Library editor (center pane).
 *
 * Renders one artifact in the IDE-style shell: breadcrumb at top,
 * artifact metadata header, then the rendered body. Forwards a ref to
 * the scrolling viewport so the minimap can observe scroll events
 * directly without prop-drilling another callback.
 *
 * Architecture vs. {@link ArtifactReader}: the legacy Reader is the
 * standalone `/w/:wid/a/:aid` surface (kept for one release cycle as
 * a redirect target). LibraryEditor is the in-shell variant — no back
 * button, no folder sheet (the shell already mounts the tree), and
 * scrolling is observable to the minimap via the forwarded ref.
 */
export const LibraryEditor = forwardRef<
  HTMLDivElement,
  {
    artifactId: ArtifactId;
    /**
     * Optional callback invoked once the headings list resolves. The
     * shell uses this to feed the minimap and to support `findHeading
     * IdByPath` deep-link resolution.
     */
    onHeadingsChange?: (headings: ReadonlyArray<MarkdownHeading>) => void;
    className?: string;
  }
>(function LibraryEditor({ artifactId, onHeadingsChange, className }, scrollViewportRef) {
  const artifact = useQuery(api.artifacts.getById, { artifactId });
  const folder = useQuery(api.artifactFolders.getById, artifact?.folderId ? { folderId: artifact.folderId } : "skip");

  const [copied, setCopied] = useState(false);
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

  const contentMarkdown = artifact?.contentMarkdown ?? null;
  // Recompute headings only when the artifact body changes so the
  // effect below does not re-emit on unrelated renders.
  const headings = useMemo(() => (contentMarkdown ? extractHeadings(contentMarkdown) : []), [contentMarkdown]);
  const headingsHandler = useCallback(
    (next: ReadonlyArray<MarkdownHeading>) => {
      onHeadingsChange?.(next);
    },
    [onHeadingsChange],
  );
  // Notify the shell after render to avoid update-during-render warnings.
  useEffect(() => {
    if (artifact) {
      headingsHandler(headings);
    }
  }, [artifact, headings, headingsHandler]);

  if (artifact === undefined) {
    return <EditorSkeleton className={className} />;
  }
  if (artifact === null) {
    return (
      <div className={cn("flex flex-1 items-center justify-center px-6 py-10", className)}>
        <div className="w-full max-w-md text-center">
          <h2 className="text-base font-semibold text-foreground">Artifact not found</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The artifact may have been deleted, or you no longer have access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex min-w-0 flex-1 flex-col", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background/80 px-4 py-2 backdrop-blur">
        <LibraryBreadcrumb folderName={folder?.name ?? null} title={artifact.title} />
        <div className="ml-auto flex items-center gap-1">
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
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportRef={scrollViewportRef}>
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
        </article>
      </ScrollArea>
    </div>
  );
});

export function LibraryBreadcrumb({ folderName, title }: { folderName: string | null; title: string }) {
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

function EditorSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-1 flex-col gap-3 px-6 py-8", className)}>
      <div className="h-7 w-2/3 animate-pulse rounded bg-muted/60" />
      <div className="h-4 w-1/3 animate-pulse rounded bg-muted/60" />
      <div className="mt-4 flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, idx) => (
          <div key={idx} className="h-3 w-full animate-pulse rounded bg-muted/40" />
        ))}
      </div>
    </div>
  );
}
