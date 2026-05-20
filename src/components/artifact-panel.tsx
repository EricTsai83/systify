import { memo, useCallback, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { CaretDownIcon, FileTextIcon, GraphIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FolderNavigator } from "@/components/folder-navigator";
import { FolderPicker } from "@/components/folder-picker";
import { useArtifactViewState } from "@/hooks/use-artifact-view-state";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import type { ArtifactId, FolderId, RepositoryId, SandboxModeStatus, ThreadId } from "@/lib/types";
import { cn } from "@/lib/utils";

const EMPTY_ARTIFACTS: Doc<"artifacts">[] = [];

/**
 * ArtifactPanel — right-rail surface for browsing and launching artifacts
 * from the chat. Two sections, top to bottom:
 *
 *   1. **Generate** — collapsible launcher for thread-scoped artifact
 *      kinds (architecture diagram, ADR, failure-mode analysis). Visible
 *      operation entry points, not buried in a kebab menu, so the user
 *      doesn't have to remember they exist. Generation is gated on having
 *      a repository attached to the thread; CTA captions explain the
 *      missing precondition rather than silently disabling.
 *
 *   2. **Folder navigator** — tree view replacing the original "Repository
 *      intelligence + Thread outputs" flat sections. Drives every artifact
 *      navigation in the panel: clicking a folder expands it; clicking
 *      an artifact opens the standalone Reader (`/w/:wid/a/:aid`) via
 *      `onOpenInReader`, which is where the long-form reading experience
 *      lives.
 *
 * The "Ask about this artifact" pathway is preserved through the
 * navigator's row affordances so chat workflows that pre-filled the input
 * with a templated question continue to work after this refactor.
 */
export function ArtifactPanel({
  threadId,
  repositoryId,
  artifacts = EMPTY_ARTIFACTS,
  hasAttachedRepository,
  sandboxModeStatus,
  isVisible = true,
  className,
  onOpenInReader,
  onSelectFolder,
  selectedFolderId,
}: {
  threadId: ThreadId | null;
  /**
   * Repository the panel's folder tree is scoped to. `null` for the no-repo
   * Home workspace — the navigator hides itself in that state.
   */
  repositoryId: RepositoryId | null;
  /**
   * Repo-level artifacts surfaced through `getRepositoryDetail`. Passed in
   * (rather than queried inside the panel) so the desktop chat surface can
   * keep its single subscription and the panel doesn't have to refetch.
   */
  artifacts?: ReadonlyArray<Doc<"artifacts">>;
  hasAttachedRepository: boolean;
  sandboxModeStatus: SandboxModeStatus | null;
  isVisible?: boolean;
  className?: string;
  /**
   * Open an artifact in the standalone Reader. This is the only navigation
   * entry the panel exposes for artifact rows — citation clicks from chat
   * route through the same callback, so the Reader is the canonical place
   * to read long-form content.
   */
  onOpenInReader?: (artifactId: ArtifactId) => void;
  onSelectFolder?: (folderId: FolderId | null) => void;
  selectedFolderId?: FolderId | null;
}) {
  const [actionsOpen, setActionsOpen] = useState<boolean | null>(null);
  const effectiveActionsOpen = actionsOpen ?? artifacts.length === 0;
  const { isUnseen, markViewed } = useArtifactViewState(repositoryId);
  // Clicking a row in the panel always routes through `onOpenInReader`,
  // so it is the single chokepoint where we record the activation. The
  // Library shell has multiple activation entry points (URL, tab strip,
  // keyboard) so it observes `tabs.activeArtifactId` instead.
  const handleSelectArtifact = useCallback(
    (artifactId: ArtifactId) => {
      markViewed(artifactId);
      onOpenInReader?.(artifactId);
    },
    [markViewed, onOpenInReader],
  );

  if (!isVisible) {
    return (
      <aside
        aria-label="Repository and thread artifacts"
        className={cn("flex h-full min-h-0 w-80 shrink-0 flex-col border-l border-border bg-muted/20", className)}
      >
        <ArtifactPanelHeader />
      </aside>
    );
  }

  return (
    <aside
      aria-label="Repository and thread artifacts"
      className={cn("flex h-full min-h-0 w-80 shrink-0 flex-col border-l border-border bg-muted/20", className)}
    >
      <ArtifactPanelHeader />

      {threadId ? (
        <div className="border-b border-border px-4 py-3">
          <ArtifactActions
            threadId={threadId}
            repositoryId={repositoryId}
            hasAttachedRepository={hasAttachedRepository}
            sandboxModeStatus={sandboxModeStatus}
            open={effectiveActionsOpen}
            onOpenChange={setActionsOpen}
          />
        </div>
      ) : null}

      {repositoryId ? (
        <FolderNavigator
          repositoryId={repositoryId}
          artifacts={artifacts}
          selectedFolderId={selectedFolderId ?? null}
          onSelectArtifact={handleSelectArtifact}
          onSelectFolder={onSelectFolder}
          isUnseen={isUnseen}
          className="border-l-0"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 py-8">
          <p className="text-center text-[12px] text-muted-foreground">
            Attach a repository to start producing diagrams, ADRs, and failure-mode analyses.
          </p>
        </div>
      )}
    </aside>
  );
}

function ArtifactPanelHeader() {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
      <div className="flex flex-col">
        <span className="text-sm font-semibold">Results</span>
        <span className="text-[11px] text-muted-foreground">Repository intelligence and folders.</span>
      </div>
    </div>
  );
}

function ArtifactActions({
  threadId,
  repositoryId,
  hasAttachedRepository,
  sandboxModeStatus,
  open,
  onOpenChange,
}: {
  threadId: ThreadId;
  repositoryId: RepositoryId | null;
  hasAttachedRepository: boolean;
  sandboxModeStatus: SandboxModeStatus | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [subsystem, setSubsystem] = useState("");
  const [activeTab, setActiveTab] = useState<"diagram" | "adr" | "failure">("diagram");
  // One folder pick shared across the three generation tabs — the user
  // typically wants the same destination for whatever they're generating
  // next. Resets to root on every panel mount so previous picks don't
  // silently follow the user into a new context.
  const [folderId, setFolderId] = useState<FolderId | null>(null);
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
      await requestDiagram({ threadId, depth: "module", folderId: folderId ?? undefined });
    } catch (err) {
      setDiagramError(toUserErrorMessage(err, "Failed to generate architecture diagram."));
    }
  });

  const [isAdrPending, runAdr] = useAsyncCallback(async () => {
    setAdrError(null);
    try {
      await captureAdr({ threadId, folderId: folderId ?? undefined });
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
        folderId: folderId ?? undefined,
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
        <div className="mb-2 flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Folder</span>
          <FolderPicker
            repositoryId={repositoryId}
            value={folderId}
            onChange={setFolderId}
            hint="Where should this artifact land? Pick a feature folder or leave at Repository root."
            disabled={!hasAttachedRepository}
            className="w-full"
          />
        </div>
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

const ActionRow = memo(function ActionRow({
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
            <Spinner size={14} />
            {pendingLabel}
          </>
        ) : (
          <>
            {icon}
            {buttonLabel}
          </>
        )}
      </Button>
      <p className="text-[11px] leading-snug text-muted-foreground">{caption}</p>
      {error ? (
        <Alert variant="destructive" className="relative pr-9 text-[11px]">
          <AlertDescription className="text-[11px]">{error}</AlertDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1 h-6 w-6"
            onClick={onDismiss}
            aria-label="Dismiss error"
          >
            <XIcon size={10} weight="bold" />
          </Button>
        </Alert>
      ) : null}
    </div>
  );
});
