import { useState } from "react";
import { useQuery } from "convex/react";
import { CaretRightIcon, CheckIcon, CopySimpleIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { ArtifactMarkdown } from "@/components/artifact-markdown";
import { MermaidRenderer } from "@/components/mermaid-renderer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { formatRelativeTime } from "@/lib/format";
import { formatArtifactKind } from "@/lib/operations";
import type { ArtifactFreshness, ArtifactId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Three-mode restructure — Library editor (center pane).
 *
 * Renders one artifact in the IDE-style shell: breadcrumb at top,
 * artifact metadata header, then the rendered body. The shell relies
 * on the inner ScrollArea for long-form reading — no minimap, no
 * outline rail.
 */
export function LibraryEditor({ artifactId, className }: { artifactId: ArtifactId; className?: string }) {
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
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background/80 px-4 py-2 backdrop-blur">
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

      <ScrollArea className="min-h-0 flex-1">
        <article className="mx-auto flex w-full max-w-[68ch] flex-col gap-4 px-6 py-8">
          <header className="flex flex-col gap-3 border-b border-border pb-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[10px] uppercase">
                {formatArtifactKind(artifact.kind)}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {new Date(artifact._creationTime).toLocaleString()}
              </span>
              <span className="text-[11px] text-muted-foreground">·</span>
              <span className="text-[11px] capitalize text-muted-foreground">{artifact.source}</span>
              <span className="text-[11px] text-muted-foreground">·</span>
              <FreshnessStatus freshness={artifact.freshness} lastVerifiedAt={artifact.lastVerifiedAt} />
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
}

/**
 * Inline verification status shown in the Reader header. Replaces the
 * colored-dot freshness indicator that used to live in the folder
 * navigator — the navigator is for finding artifacts, but verification
 * is a property of the artifact itself, so it belongs next to the rest
 * of the metadata (kind, version, source) where the user is already
 * scanning for context. Colors mirror the canonical freshness ramp
 * (fresh = emerald, aging = amber, stale = red, unverified = muted).
 */
function FreshnessStatus({
  freshness,
  lastVerifiedAt,
}: {
  freshness: ArtifactFreshness;
  lastVerifiedAt: number | undefined;
}) {
  const verifiedAge = lastVerifiedAt ? formatRelativeTime(lastVerifiedAt) : null;

  switch (freshness) {
    case "fresh":
      return (
        <span className="text-[11px] text-emerald-600 dark:text-emerald-400">
          {verifiedAge ? `Verified ${verifiedAge} · Fresh` : "Fresh"}
        </span>
      );
    case "aging":
      return (
        <span className="text-[11px] text-amber-600 dark:text-amber-400">
          {verifiedAge ? `Verified ${verifiedAge} · Aging` : "Aging"}
        </span>
      );
    case "stale":
      return (
        <span className="text-[11px] text-red-600 dark:text-red-500">
          {verifiedAge ? `Verified ${verifiedAge} · Stale — re-verify in Lab` : "Stale — re-verify in Lab"}
        </span>
      );
    case "unverified":
      return <span className="text-[11px] text-muted-foreground">Not verified against live code</span>;
    default: {
      const _exhaustive: never = freshness;
      return _exhaustive;
    }
  }
}

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
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-4 w-1/3" />
      <div className="mt-4 flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, idx) => (
          <Skeleton key={idx} className="h-3 w-full" />
        ))}
      </div>
    </div>
  );
}
