import {
  type ComponentPropsWithoutRef,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
const READER_TOOLBAR_ID = "library-reader-tools";
const READER_TOOLBAR_WIDTH = "calc(100vw - 6rem)";
const READER_TOOLBAR_TRANSITION = { duration: 0.2, ease: [0.23, 1, 0.32, 1] } as const;
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
  const [toolbarExpanded, setToolbarExpanded] = useState(false);

  useEffect(() => {
    setSelectedVersion(null);
    setToolbarExpanded(false);
  }, [artifactId]);

  const [copied, setCopied] = useState(false);
  const copiedResetTimer = useRef<number | null>(null);

  const clearCopiedResetTimer = useCallback(() => {
    if (copiedResetTimer.current === null) return;
    window.clearTimeout(copiedResetTimer.current);
    copiedResetTimer.current = null;
  }, []);

  useEffect(() => clearCopiedResetTimer, [clearCopiedResetTimer]);

  const [, runCopy] = useAsyncCallback(async () => {
    if (!artifact) return;
    const copySource = selectedVersion !== null && selectedVersion !== artifact.version ? historicalVersion : artifact;
    if (!copySource) return;
    try {
      await navigator.clipboard.writeText(copySource.contentMarkdown);
      clearCopiedResetTimer();
      setCopied(true);
      copiedResetTimer.current = window.setTimeout(() => {
        copiedResetTimer.current = null;
        setCopied(false);
      }, 1600);
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

  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", className)}>
      <ReaderToolbar
        expanded={toolbarExpanded}
        onExpandedChange={setToolbarExpanded}
        versions={versions}
        currentVersion={artifact.version}
        selectedVersion={displayedVersion}
        onVersionChange={(version) => setSelectedVersion(version === artifact.version ? null : version)}
        showFontSizeControl={!isHtmlArtifact}
        fontSize={fontSize}
        onFontSizeChange={setFontSize}
        copyIsDisabled={copyIsDisabled}
        copied={copied}
        onCopy={() => void runCopy()}
      />

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

function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      setWidth((currentWidth) => {
        const nextWidth = Math.ceil(element.scrollWidth);
        return currentWidth === nextWidth ? currentWidth : nextWidth;
      });
    };

    measure();

    if (typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  return [ref, width] as const;
}

function useToolbarMotion() {
  const shouldReduceMotion = useReducedMotion();
  const reducedMotion = shouldReduceMotion === true;

  return {
    reducedMotion,
    transition: reducedMotion ? ({ duration: 0 } as const) : READER_TOOLBAR_TRANSITION,
  };
}

function ReaderToolbar({
  expanded,
  onExpandedChange,
  versions,
  currentVersion,
  selectedVersion,
  onVersionChange,
  showFontSizeControl,
  fontSize,
  onFontSizeChange,
  copyIsDisabled,
  copied,
  onCopy,
}: {
  expanded: boolean;
  onExpandedChange: Dispatch<SetStateAction<boolean>>;
  versions:
    | Array<{
        version: number;
        renderFormat: "markdown" | "html";
        createdAt: number;
      }>
    | undefined;
  currentVersion: number;
  selectedVersion: number;
  onVersionChange: (version: number) => void;
  showFontSizeControl: boolean;
  fontSize: FontSize;
  onFontSizeChange: (next: FontSize) => void;
  copyIsDisabled: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  const [toolsContentRef, toolsWidth] = useMeasuredWidth<HTMLDivElement>();
  const { reducedMotion, transition } = useToolbarMotion();
  const renderedToolsWidth = expanded ? toolsWidth : 0;

  return (
    <div
      className={cn(
        "absolute top-3 right-4 z-10 flex max-w-[calc(100%-2rem)] flex-row-reverse items-center overflow-hidden border p-0.5 transition-[background-color,border-color,box-shadow,backdrop-filter] duration-150 ease-out motion-reduce:transition-none",
        expanded
          ? "border-border bg-background/95 shadow-sm backdrop-blur"
          : "border-transparent bg-transparent shadow-none backdrop-blur-none",
      )}
      data-testid="reader-toolbar"
    >
      <div className="flex size-7 shrink-0 items-center justify-center">
        <ReaderToolbarIconButton
          aria-label={expanded ? "Collapse reader tools" : "Expand reader tools"}
          aria-expanded={expanded}
          aria-controls={READER_TOOLBAR_ID}
          onClick={() => onExpandedChange((previous) => !previous)}
        >
          {expanded ? <XIcon size={12} weight="bold" /> : <SlidersHorizontalIcon size={13} weight="bold" />}
        </ReaderToolbarIconButton>
      </div>

      <motion.div
        initial={false}
        id={READER_TOOLBAR_ID}
        aria-hidden={!expanded}
        inert={!expanded ? true : undefined}
        animate={{
          width: renderedToolsWidth,
          opacity: expanded || reducedMotion ? 1 : 0,
        }}
        transition={transition}
        className={cn("flex justify-end overflow-hidden whitespace-nowrap", !expanded && "pointer-events-none")}
        style={{ maxWidth: READER_TOOLBAR_WIDTH }}
      >
        <div ref={toolsContentRef} className="flex w-max shrink-0 flex-nowrap items-center gap-1">
          <ArtifactVersionSelect
            versions={versions}
            currentVersion={currentVersion}
            selectedVersion={selectedVersion}
            onChange={onVersionChange}
          />
          {showFontSizeControl ? <FontSizeControl value={fontSize} onChange={onFontSizeChange} /> : null}
          <ReaderToolbarSeparator />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-14 shrink-0 gap-1 px-1.5 text-[11px] active:scale-100"
            onClick={onCopy}
            disabled={copyIsDisabled}
            aria-label="Copy markdown"
            tabIndex={expanded ? undefined : -1}
          >
            {copied ? <CheckIcon size={13} weight="bold" /> : <CopySimpleIcon size={13} weight="bold" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <ReaderToolbarSeparator className="mr-1" />
        </div>
      </motion.div>
    </div>
  );
}

function ReaderToolbarIconButton({
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof Button>, "variant" | "size" | "type" | "className">) {
  return (
    <Button type="button" variant="ghost" size="sm" className="size-7 p-0 active:scale-100" {...props}>
      {children}
    </Button>
  );
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
        className="h-6 w-6 px-0 active:scale-100"
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
        className="h-6 w-6 px-0 active:scale-100"
        disabled={atMax}
        onClick={() => stepTo(1)}
        aria-label="Increase text size"
      >
        <PlusIcon size={13} weight="bold" />
      </Button>
    </div>
  );
}
