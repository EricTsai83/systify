import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  CaretDownIcon,
  CircleNotchIcon,
  FileTextIcon,
  GraphIcon,
  LightningIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MermaidRenderer } from "@/components/mermaid-renderer";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import { formatArtifactKind } from "@/lib/operations";
import type { ArtifactId, SandboxModeStatus, ThreadId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * ArtifactPanel — slot-based right-side panel showing artifacts attached to
 * the current thread (PRD #19, "Modules to build (frontend)" + US 23 "all
 * artifacts associated with a thread visible in a side panel, so that I can
 * review them without leaving the conversation").
 *
 * The panel is *kind-dispatched*: each artifact's `kind` selects a renderer.
 * For now only `architecture_diagram` has a custom renderer (MermaidRenderer);
 * everything else falls back to a markdown-ish `<pre>` block. The dispatcher
 * is a single `kindRenderers` map so adding ADR / failure-mode renderers in
 * Phase 4 is a one-line change.
 *
 * The panel also hosts the generation CTA for the upstream artifact kind in
 * scope on this branch — a "Generate architecture diagram" affordance that
 * routes through `requestArchitectureDiagram`. Generation is gated on having
 * a repository attached to the thread; the CTA is hidden otherwise so the
 * empty state is honest about the current capability.
 */
export function ArtifactPanel({
  threadId,
  repositoryArtifacts = [],
  hasAttachedRepository,
  sandboxModeStatus,
  isVisible = true,
  className,
  selectedArtifactId = null,
  onArtifactSelectionConsumed,
}: {
  threadId: ThreadId | null;
  repositoryArtifacts?: Doc<"artifacts">[];
  hasAttachedRepository: boolean;
  sandboxModeStatus: SandboxModeStatus | null;
  isVisible?: boolean;
  className?: string;
  /**
   * Plan 02: when a `[A#]` citation in chat is clicked, the shell publishes
   * the resolved artifact id here. This panel scrolls the matching card
   * into view and applies a transient highlight so the user sees where
   * they landed; once consumed, the panel calls
   * `onArtifactSelectionConsumed` so subsequent clicks on the same `[A#]`
   * retrigger the scroll/highlight cycle.
   */
  selectedArtifactId?: ArtifactId | null;
  onArtifactSelectionConsumed?: () => void;
}) {
  // Query is scoped to thread-level artifacts. A diagram is double-parented
  // (thread + repo), so it shows up here. ADRs and failure modes will follow
  // the same pattern in Phase 4.
  const artifacts = useQuery(api.artifacts.listByThread, threadId && isVisible ? { threadId } : "skip");
  const artifactCount = artifacts?.length ?? 0;
  const repositoryIntelligence = repositoryArtifacts.filter(
    (artifact) => artifact.kind === "manifest" || artifact.kind === "deep_analysis",
  );
  const [actionsOpen, setActionsOpen] = useState<boolean | null>(null);
  const effectiveActionsOpen = actionsOpen ?? artifactCount === 0;

  return (
    <aside
      aria-label="Repository and thread artifacts"
      className={cn("flex h-full min-h-0 w-80 shrink-0 flex-col border-l border-border bg-muted/20", className)}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex flex-col">
          <span className="text-sm font-semibold">Results</span>
          <span className="text-[11px] text-muted-foreground">Repository intelligence and conversation outputs.</span>
        </div>
      </div>

      {threadId ? (
        <div className="border-b border-border px-4 py-3">
          <ArtifactActions
            threadId={threadId}
            hasAttachedRepository={hasAttachedRepository}
            sandboxModeStatus={sandboxModeStatus}
            open={effectiveActionsOpen}
            onOpenChange={setActionsOpen}
          />
        </div>
      ) : null}

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-3 p-4">
          {repositoryIntelligence.length > 0 ? (
            <ArtifactSection title="Repository intelligence" description="Reusable context available across this repo.">
              {repositoryIntelligence.map((artifact: Doc<"artifacts">) => (
                <ArtifactCard
                  key={artifact._id}
                  artifact={artifact}
                  isSelected={selectedArtifactId === artifact._id}
                  onSelectionConsumed={onArtifactSelectionConsumed}
                  featured={artifact.kind === "deep_analysis"}
                />
              ))}
            </ArtifactSection>
          ) : hasAttachedRepository ? (
            <EmptyArtifactState
              title="No repository intelligence yet"
              description="Run deep analysis to create reusable context for future conversations."
            />
          ) : null}

          <ArtifactSection title="Thread outputs" description="Artifacts produced from this conversation.">
            {threadId === null ? (
              <EmptyArtifactState
                title="No conversation selected"
                description="Pick or start a thread to see its artifacts here."
              />
            ) : artifacts === undefined ? null : artifacts.length === 0 ? (
              <EmptyArtifactState
                title="No artifacts yet"
                description={
                  hasAttachedRepository
                    ? "Generate an architecture diagram to start grounding this thread."
                    : "Attach a repository to start producing diagrams, ADRs, and failure-mode analyses."
                }
              />
            ) : (
              artifacts.map((artifact: Doc<"artifacts">) => (
                <ArtifactCard
                  key={artifact._id}
                  artifact={artifact}
                  isSelected={selectedArtifactId === artifact._id}
                  onSelectionConsumed={onArtifactSelectionConsumed}
                />
              ))
            )}
          </ArtifactSection>
        </div>
      </ScrollArea>
    </aside>
  );
}

function ArtifactActions({
  threadId,
  hasAttachedRepository,
  sandboxModeStatus,
  open,
  onOpenChange,
}: {
  threadId: ThreadId;
  hasAttachedRepository: boolean;
  sandboxModeStatus: SandboxModeStatus | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [subsystem, setSubsystem] = useState("");
  const [activeTab, setActiveTab] = useState<"diagram" | "adr" | "failure">("diagram");
  const captureAdr = useMutation(api.designArtifacts.captureAdr);
  const requestFailureMode = useMutation(api.designArtifacts.requestFailureModeAnalysis);
  const requestDiagram = useMutation(api.architectureDiagram.requestArchitectureDiagram);
  const sandboxReady = sandboxModeStatus?.reasonCode === "available";

  const [diagramError, setDiagramError] = useState<string | null>(null);
  const [adrError, setAdrError] = useState<string | null>(null);
  const [failureError, setFailureError] = useState<string | null>(null);

  const [isDiagramPending, runDiagram] = useAsyncCallback(async () => {
    setDiagramError(null);
    try {
      await requestDiagram({ threadId, depth: "module" });
    } catch (err) {
      setDiagramError(toUserErrorMessage(err, "Failed to generate architecture diagram."));
    }
  });

  const [isAdrPending, runAdr] = useAsyncCallback(async () => {
    setAdrError(null);
    try {
      await captureAdr({ threadId });
    } catch (err) {
      setAdrError(toUserErrorMessage(err, "Failed to capture ADR."));
    }
  });

  const [isFailurePending, runFailureMode] = useAsyncCallback(async () => {
    setFailureError(null);
    try {
      await requestFailureMode({
        threadId,
        subsystem: subsystem.trim(),
      });
    } catch (err) {
      setFailureError(toUserErrorMessage(err, "Failed to start failure mode analysis."));
    }
  });

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="flex flex-col gap-2">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="justify-between gap-2">
          <span>+ Generate</span>
          <CaretDownIcon
            size={12}
            weight="bold"
            className={cn("transition-transform duration-200", open ? "rotate-180" : "")}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as "diagram" | "adr" | "failure")}
          className="flex flex-col gap-2"
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="diagram" className="px-2 py-1.5 text-[11px]">
              Diagram
            </TabsTrigger>
            <TabsTrigger value="adr" className="px-2 py-1.5 text-[11px]">
              ADR
            </TabsTrigger>
            <TabsTrigger value="failure" className="px-2 py-1.5 text-[11px]">
              Failure
            </TabsTrigger>
          </TabsList>

          <TabsContent value="diagram">
            <ActionRow
              pending={isDiagramPending}
              onClick={() => void runDiagram()}
              caption={
                hasAttachedRepository
                  ? "Module-level Mermaid graph from your repo's structure."
                  : "Attach a repository to enable diagram generation."
              }
              error={diagramError}
              onDismiss={() => setDiagramError(null)}
              buttonLabel="Generate architecture diagram"
              pendingLabel="Generating diagram…"
              icon={<GraphIcon size={14} weight="bold" />}
              disabled={!hasAttachedRepository || isDiagramPending}
            />
          </TabsContent>

          <TabsContent value="adr">
            <ActionRow
              pending={isAdrPending}
              onClick={() => void runAdr()}
              caption={
                hasAttachedRepository
                  ? "One-click ADR in Context / Decision / Consequences / Alternatives format."
                  : "Attach a repository to enable ADR capture."
              }
              error={adrError}
              onDismiss={() => setAdrError(null)}
              buttonLabel="Capture as ADR"
              pendingLabel="Capturing ADR…"
              icon={<FileTextIcon size={14} weight="bold" />}
              variant="outline"
              disabled={!hasAttachedRepository || isAdrPending}
            />
          </TabsContent>

          <TabsContent value="failure">
            <div className="flex flex-col gap-2">
              <Input
                value={subsystem}
                onChange={(event) => setSubsystem(event.target.value)}
                placeholder="API and data access"
              />
              <ActionRow
                pending={isFailurePending}
                onClick={() => void runFailureMode()}
                caption={
                  hasAttachedRepository
                    ? sandboxReady
                      ? "Sandbox-backed scan that records component, blast radius, mitigation, and code references."
                      : (sandboxModeStatus?.message ?? "Sandbox is not ready yet. Sync and wait for ready state.")
                    : "Attach a repository to enable failure mode analysis."
                }
                error={failureError}
                onDismiss={() => setFailureError(null)}
                buttonLabel="Run failure mode analysis"
                pendingLabel="Running failure mode analysis…"
                icon={<WarningCircleIcon size={14} weight="bold" />}
                variant="outline"
                disabled={!hasAttachedRepository || !sandboxReady || isFailurePending || !subsystem.trim()}
              />
            </div>
          </TabsContent>
        </Tabs>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ActionRow({
  pending,
  onClick,
  caption,
  error,
  onDismiss,
  buttonLabel,
  pendingLabel,
  icon,
  disabled,
  variant = "default",
}: {
  pending: boolean;
  onClick: () => void;
  caption: string;
  error: string | null;
  onDismiss: () => void;
  buttonLabel: string;
  pendingLabel: string;
  icon: ReactNode;
  disabled?: boolean;
  variant?: "default" | "outline";
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant={variant}
        size="sm"
        disabled={disabled}
        onClick={onClick}
        className="justify-center gap-2"
      >
        {pending ? (
          <>
            <CircleNotchIcon size={14} className="animate-spin" weight="bold" />
            {pendingLabel}
          </>
        ) : (
          <>
            {icon}
            {buttonLabel}
          </>
        )}
      </Button>
      <p className="text-[11px] text-muted-foreground">{caption}</p>
      <InlineError error={error} onClear={onDismiss} />
    </div>
  );
}

function InlineError({ error, onClear }: { error: string | null; onClear: () => void }) {
  if (!error) {
    return null;
  }
  return (
    <Alert
      variant="destructive"
      className="grid-cols-[auto_1fr_auto] items-start gap-2 rounded-md border-destructive/40 bg-destructive/5 p-2 text-[11px]"
    >
      <WarningCircleIcon size={12} weight="bold" className="mt-0.5 shrink-0" />
      <AlertDescription className="text-[11px] text-destructive">{error}</AlertDescription>
      <Button
        type="button"
        onClick={onClear}
        variant="ghost"
        size="icon"
        className="size-4 text-destructive/70 hover:text-destructive"
        aria-label="Dismiss error"
      >
        <XIcon size={10} weight="bold" />
      </Button>
    </Alert>
  );
}

function ArtifactCard({
  artifact,
  isSelected = false,
  onSelectionConsumed,
  featured = false,
}: {
  artifact: Doc<"artifacts">;
  isSelected?: boolean;
  onSelectionConsumed?: () => void;
  featured?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Scroll-into-view + transient highlight when the citation jump targets
  // this card. We clear the selection (`onSelectionConsumed`) once the
  // highlight animation is over so a follow-up click on the same `[A#]`
  // re-runs the effect — without this, React would see the same id and
  // skip the effect on the next click.
  useEffect(() => {
    if (!isSelected) {
      return;
    }
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = window.setTimeout(() => {
      onSelectionConsumed?.();
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [isSelected, onSelectionConsumed]);

  // The shared `Card` component is not a `forwardRef`, so we hang the
  // scroll-target ref off a thin wrapper. The wrapper is also where the
  // transient highlight ring lives; keeping it on the wrapper rather than
  // the Card means the ring sits *outside* the card border, which reads
  // visually as "this card is the one I jumped to".
  return (
    <div
      ref={cardRef}
      data-testid={`artifact-card-${artifact._id}`}
      className={cn(
        "rounded-md transition-shadow duration-300",
        isSelected ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : "",
      )}
    >
      <Card className={cn(featured ? "border-primary/40 bg-primary/5" : "")}>
        <CardHeader className="flex flex-row items-start justify-between gap-3 p-3 pb-2">
          <div className="min-w-0">
            <h4 className="truncate text-sm font-semibold">{artifact.title}</h4>
            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{artifact.summary}</p>
          </div>
          <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
            {formatArtifactKind(artifact.kind)}
          </Badge>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <ArtifactBody artifact={artifact} />
          <ArtifactFooter artifact={artifact} />
        </CardContent>
      </Card>
    </div>
  );
}

function ArtifactSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</h3>
        <p className="text-[11px] text-muted-foreground/80">{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Kind dispatcher. New artifact kinds with bespoke renderers (ADR, failure
 * mode analysis, etc.) plug in here so the rest of the panel — header,
 * footer, scrolling — stays uniform across kinds.
 */
function ArtifactBody({ artifact }: { artifact: Doc<"artifacts"> }) {
  const renderer = kindRenderers[artifact.kind] ?? defaultArtifactRenderer;
  return renderer(artifact);
}

const kindRenderers: Partial<Record<Doc<"artifacts">["kind"], (artifact: Doc<"artifacts">) => ReactNode>> = {
  architecture_diagram: (artifact) => <MermaidRenderer source={artifact.contentMarkdown} />,
};

function defaultArtifactRenderer(artifact: Doc<"artifacts">): ReactNode {
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-[11px] leading-snug text-muted-foreground">
      {artifact.contentMarkdown}
    </pre>
  );
}

function ArtifactFooter({ artifact }: { artifact: Doc<"artifacts"> }) {
  return (
    <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <LightningIcon size={10} weight="bold" />
        <span className="capitalize">{artifact.source}</span>
        <span aria-hidden="true">·</span>
        <span>v{artifact.version}</span>
      </span>
      <time
        dateTime={new Date(artifact._creationTime).toISOString()}
        className="tabular-nums"
        title={new Date(artifact._creationTime).toLocaleString()}
      >
        {formatRelative(artifact._creationTime)}
      </time>
    </div>
  );
}

function formatRelative(timestamp: number) {
  const diffMs = Date.now() - timestamp;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${Math.max(seconds, 1)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function EmptyArtifactState({ title, description }: { title: string; description: string }) {
  return (
    <Card className="animate-in border-dashed bg-background/50 text-center fade-in duration-300">
      <CardHeader className="gap-1 p-4">
        <CardTitle className="text-xs">{title}</CardTitle>
        <CardDescription className="text-[11px]">{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}
