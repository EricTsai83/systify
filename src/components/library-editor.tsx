import { useState } from "react";
import { useQuery } from "convex/react";
import { CaretRightIcon, CheckIcon, CopySimpleIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { Markdown } from "@/components/markdown";
import { MermaidRenderer } from "@/components/mermaid-renderer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { useLocalStorageEnum } from "@/hooks/use-persisted-state";
import { formatRelativeTime } from "@/lib/format";
import { formatArtifactKind } from "@/lib/operations";
import type { ArtifactFreshness, ArtifactId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Reader text-size preference. The Library editor renders long-form
 * artifacts, so a viewer can scale the markdown body up or down for
 * comfortable reading; the choice persists per browser via
 * `useLocalStorageEnum`. Architecture diagrams are exempt — they render
 * as SVG, not text, so the control is hidden for them.
 *
 * Scaling uses CSS `zoom` on a wrapper around the body. `zoom` reflows
 * the content (text re-wraps within the fixed `68ch` measure) instead of
 * merely transforming it, and — unlike a `font-size` override — scales
 * the whole subtree uniformly without depending on the renderer
 * (`Streamdown`) sizing every element in relative units.
 *
 * `FONT_SIZE_STEPS` is an ordered ladder, smallest → largest, that the
 * −/+ control walks one rung per click. Each id is the `zoom` written as
 * a whole-number percentage, so `fontSizeZoom` is a plain divide and the
 * id stays self-describing in storage. Adding or removing a rung needs no
 * other change — the stepper is two buttons whatever the ladder's length.
 * A stored id outside the ladder (an older build's value, a hand-edited
 * entry) is absorbed by `useLocalStorageEnum`, which falls back to
 * `DEFAULT_FONT_SIZE`.
 */
const FONT_SIZE_STEPS = ["80", "90", "100", "110", "125", "140", "160", "180"] as const;
type FontSize = (typeof FONT_SIZE_STEPS)[number];
const DEFAULT_FONT_SIZE: FontSize = "100";

/** The CSS `zoom` multiplier for a stored text-size rung. */
function fontSizeZoom(size: FontSize): number {
  return Number(size) / 100;
}

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

  const [fontSize, setFontSize] = useLocalStorageEnum("systify.library.fontSize", FONT_SIZE_STEPS, DEFAULT_FONT_SIZE);

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

  const isDiagram = artifact.kind === "architecture_diagram";

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background/80 px-4 py-2 backdrop-blur">
        <LibraryBreadcrumb folderName={folder?.name ?? null} title={artifact.title} />
        <div className="ml-auto flex items-center gap-1.5">
          {!isDiagram ? <FontSizeControl value={fontSize} onChange={setFontSize} /> : null}
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

          {isDiagram ? (
            <MermaidRenderer source={artifact.contentMarkdown} />
          ) : (
            <div style={{ zoom: fontSizeZoom(fontSize) }}>
              <Markdown>{artifact.contentMarkdown}</Markdown>
            </div>
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

/**
 * Stepper for the Reader's text-size preference: a −/+ pair that walks
 * the `FONT_SIZE_STEPS` ladder one rung per click. Two buttons however
 * long the ladder is — each end button disables at its bound, which is
 * the only "you've hit the limit" feedback the control needs.
 */
function FontSizeControl({ value, onChange }: { value: FontSize; onChange: (next: FontSize) => void }) {
  const index = FONT_SIZE_STEPS.indexOf(value);
  const atMin = index <= 0;
  const atMax = index >= FONT_SIZE_STEPS.length - 1;

  const stepTo = (delta: number) => {
    const next = FONT_SIZE_STEPS[index + delta];
    if (next) onChange(next);
  };

  return (
    <div className="flex items-center" role="group" aria-label="Reading text size">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-8 px-0"
        disabled={atMin}
        onClick={() => stepTo(-1)}
        aria-label="Decrease text size"
      >
        <MinusIcon size={13} weight="bold" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-8 px-0"
        disabled={atMax}
        onClick={() => stepTo(1)}
        aria-label="Increase text size"
      >
        <PlusIcon size={13} weight="bold" />
      </Button>
    </div>
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
