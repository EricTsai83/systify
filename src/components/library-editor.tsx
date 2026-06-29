import { useCallback, useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { CheckIcon, CopySimpleIcon, MinusIcon, PlusIcon, SlidersHorizontalIcon, XIcon } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Markdown, type MermaidRepairRequest } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { useLocalStorageEnum } from "@/hooks/use-persisted-state";
import { toUserErrorMessage } from "@/lib/errors";
import type { ArtifactId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Reader text-size preference. The Library editor renders long-form
 * artifacts, so a viewer can scale the markdown body up or down for
 * comfortable reading; the choice persists per browser via
 * `useLocalStorageEnum`.
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
const READER_TOOLBAR_STATES = ["collapsed", "expanded"] as const;
const UPDATED_AT_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** The CSS `zoom` multiplier for a stored text-size rung. */
function fontSizeZoom(size: FontSize): number {
  return Number(size) / 100;
}

/**
 * Library editor (center pane).
 *
 * Renders one artifact in the IDE-style shell with a floating reader toolbar
 * over the rendered body. The shell relies on the inner ScrollArea for
 * long-form reading — no minimap, no outline rail.
 */
export function LibraryEditor({ artifactId, className }: { artifactId: ArtifactId; className?: string }) {
  const artifact = useQuery(api.artifacts.getById, { artifactId });
  const versions = useQuery(api.artifactVersions.listByArtifact, { artifactId });
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const historicalVersion = useQuery(
    api.artifactVersions.getVersion,
    selectedVersion !== null && artifact !== undefined && artifact !== null && selectedVersion !== artifact.version
      ? { artifactId, version: selectedVersion }
      : "skip",
  );
  const repairMermaidBlock = useAction(api.artifactMermaidRepairNode.repairArtifactMermaidBlock);
  const [toolbarState, setToolbarState] = useLocalStorageEnum(
    "systify.library.readerToolbar",
    READER_TOOLBAR_STATES,
    "collapsed",
  );
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    setSelectedVersion(null);
  }, [artifactId]);

  const [copied, setCopied] = useState(false);
  const [, runCopy] = useAsyncCallback(async () => {
    if (!artifact) return;
    const copySource = selectedVersion !== null && selectedVersion !== artifact.version ? historicalVersion : artifact;
    if (!copySource) return;
    try {
      await navigator.clipboard.writeText(copySource.contentMarkdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Browsers without clipboard API support — leave the affordance idle.
    }
  });

  const [fontSize, setFontSize] = useLocalStorageEnum("systify.library.fontSize", FONT_SIZE_STEPS, DEFAULT_FONT_SIZE);
  const handleRepairMermaid = useCallback(
    async ({ chart, error }: MermaidRepairRequest) => {
      if (!artifact) return;

      try {
        const result = await repairMermaidBlock({
          artifactId: artifact._id,
          chart,
          error,
        });
        if (!result.updated) {
          throw new Error("The repair did not change this diagram.");
        }
        toast.success("Diagram repaired.");
      } catch (caught) {
        throw new Error(toUserErrorMessage(caught, "Couldn't repair this diagram."));
      }
    },
    [artifact, repairMermaidBlock],
  );

  if (artifact === undefined) {
    return <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)} />;
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

  const displayedVersion = selectedVersion ?? artifact.version;
  const isHistoricalVersion = displayedVersion !== artifact.version;
  const displayedArtifact = isHistoricalVersion ? historicalVersion : artifact;
  const selectedVersionMetadata = versions?.find((version) => version.version === displayedVersion);
  const displayedUpdatedAt = selectedVersionMetadata?.createdAt ?? artifact.updatedAt ?? artifact._creationTime;
  const selectedRenderFormat =
    displayedArtifact?.renderFormat ?? selectedVersionMetadata?.renderFormat ?? artifact.renderFormat;
  const isHtmlArtifact = selectedRenderFormat === "html";
  const versionIsLoading = displayedArtifact === undefined;
  const versionIsMissing = displayedArtifact === null;
  const copyIsDisabled = versionIsLoading || versionIsMissing;
  const toolbarExpanded = toolbarState === "expanded";
  const toolbarLayoutTransition = shouldReduceMotion
    ? { duration: 0 }
    : ({ duration: 0.22, ease: [0.23, 1, 0.32, 1] } as const);
  const toolbarContentTransition = shouldReduceMotion
    ? { duration: 0 }
    : ({ duration: 0.22, ease: [0.23, 1, 0.32, 1] } as const);

  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", className)}>
      <motion.div
        layout
        transition={toolbarLayoutTransition}
        className={cn(
          "absolute top-3 right-4 z-10 flex max-w-[calc(100%-2rem)] flex-row-reverse items-center overflow-hidden border border-border bg-background/95 shadow-sm backdrop-blur",
          toolbarExpanded ? "p-0.5" : "p-0",
        )}
        data-testid="reader-toolbar"
      >
        <motion.div
          layout
          animate={{
            height: toolbarExpanded ? 24 : 28,
            width: toolbarExpanded ? 24 : 28,
          }}
          transition={toolbarLayoutTransition}
          className="shrink-0"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-full w-full p-0"
            aria-label={toolbarExpanded ? "Collapse reader tools" : "Expand reader tools"}
            aria-expanded={toolbarExpanded}
            aria-controls="library-reader-tools"
            onClick={() => setToolbarState(toolbarExpanded ? "collapsed" : "expanded")}
          >
            {toolbarExpanded ? <XIcon size={12} weight="bold" /> : <SlidersHorizontalIcon size={13} weight="bold" />}
          </Button>
        </motion.div>

        <motion.div
          id="library-reader-tools"
          aria-hidden={!toolbarExpanded}
          inert={!toolbarExpanded ? true : undefined}
          animate={{
            width: toolbarExpanded ? "auto" : 0,
            opacity: toolbarExpanded ? 1 : 0,
          }}
          transition={toolbarContentTransition}
          className={cn(
            "flex max-w-[calc(100vw-6rem)] flex-nowrap items-center gap-1 overflow-hidden whitespace-nowrap",
            !toolbarExpanded && "pointer-events-none",
          )}
        >
          <ArtifactVersionSelect
            versions={versions}
            currentVersion={artifact.version}
            selectedVersion={displayedVersion}
            onChange={(version) => setSelectedVersion(version === artifact.version ? null : version)}
          />
          {!isHtmlArtifact ? <FontSizeControl value={fontSize} onChange={setFontSize} /> : null}
          <ReaderToolbarSeparator />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-14 shrink-0 gap-1 px-1.5 text-[11px]"
            onClick={() => void runCopy()}
            disabled={copyIsDisabled}
            aria-label="Copy markdown"
            tabIndex={toolbarExpanded ? undefined : -1}
          >
            {copied ? <CheckIcon size={13} weight="bold" /> : <CopySimpleIcon size={13} weight="bold" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <ReaderToolbarSeparator className="mr-1" />
        </motion.div>
      </motion.div>

      <ScrollArea className="min-h-0 flex-1">
        <article
          // `min-h` gives the reader a stable floor so the loading skeleton, a
          // short artifact, and the missing-version notice all occupy roughly
          // the same height — the body no longer snaps shorter when a brief
          // artifact resolves. HTML artifacts render their own `h-[70vh]`
          // viewer, which already exceeds this floor.
          className={cn(
            "mx-auto flex min-h-[60vh] w-full flex-col gap-4 px-6 py-8",
            isHtmlArtifact ? "max-w-6xl" : "max-w-[68ch]",
          )}
        >
          {versionIsLoading ? (
            <Skeleton className="h-[50vh] w-full" />
          ) : versionIsMissing ? (
            <p className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm leading-6 text-destructive">
              This artifact version is not available.
            </p>
          ) : (
            <>
              {isHtmlArtifact ? (
                <ArtifactHtmlViewer
                  artifactId={artifact._id as ArtifactId}
                  version={isHistoricalVersion ? displayedVersion : undefined}
                />
              ) : (
                <div key={`${artifact._id}:${displayedVersion}`} style={{ zoom: fontSizeZoom(fontSize) }}>
                  <Markdown onRepairMermaid={isHistoricalVersion ? undefined : handleRepairMermaid}>
                    {displayedArtifact.contentMarkdown}
                  </Markdown>
                </div>
              )}
              <p className="border-t border-border pt-3 text-right text-[11px] text-muted-foreground">
                Updated {UPDATED_AT_FORMATTER.format(displayedUpdatedAt)}
              </p>
            </>
          )}
        </article>
      </ScrollArea>
    </div>
  );
}

function ReaderToolbarSeparator({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("h-4 w-px shrink-0 bg-border", className)} />;
}

function ArtifactVersionSelect({
  versions,
  currentVersion,
  selectedVersion,
  onChange,
}: {
  versions:
    | Array<{
        version: number;
        renderFormat: "markdown" | "html";
        createdAt: number;
      }>
    | undefined;
  currentVersion: number;
  selectedVersion: number;
  onChange: (version: number) => void;
}) {
  if (!versions || versions.length <= 1) {
    return null;
  }

  return (
    <Select value={String(selectedVersion)} onValueChange={(value) => onChange(Number(value))}>
      <SelectTrigger className="h-6 w-24 shrink-0 px-1.5 text-[11px]" aria-label="Artifact version">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {versions.map((version) => (
            <SelectItem key={version.version} value={String(version.version)}>
              v{version.version}
              {version.version === currentVersion ? " current" : ""}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function ArtifactHtmlViewer({ artifactId, version }: { artifactId: ArtifactId; version?: number }) {
  const preview = useQuery(
    api.artifactHtml.getPreviewUrl,
    version === undefined ? { artifactId } : { artifactId, version },
  );

  if (preview === undefined) {
    return <Skeleton className="h-[70vh] w-full" />;
  }
  if (preview === null) {
    return (
      <p className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm leading-6 text-destructive">
        HTML report preview is not available.
      </p>
    );
  }

  return (
    <iframe
      title="HTML report preview"
      sandbox=""
      referrerPolicy="no-referrer"
      src={preview.url}
      className="h-[70vh] w-full border border-border bg-background"
    />
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
    <div className="flex shrink-0 items-center" role="group" aria-label="Reading text size">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 w-6 px-0"
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
        className="h-6 w-6 px-0"
        disabled={atMax}
        onClick={() => stepTo(1)}
        aria-label="Increase text size"
      >
        <PlusIcon size={13} weight="bold" />
      </Button>
    </div>
  );
}
