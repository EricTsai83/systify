import { memo, useCallback, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { CaretDownIcon, FileTextIcon, XIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { FolderNavigator } from "@/components/folder-navigator";
import { FolderPicker } from "@/components/folder-picker";
import { useArtifactViewState } from "@/hooks/use-artifact-view-state";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import type { ArtifactId, FolderId, RepositoryId, ThreadId } from "@/lib/types";
import { cn } from "@/lib/utils";

const EMPTY_ARTIFACTS: Doc<"artifacts">[] = [];

/**
 * ArtifactPanel — right-rail surface for browsing and launching artifacts
 * from the chat. Two sections, top to bottom:
 *
 *   1. **Generate** — collapsible launcher for the ADR capture flow. The
 *      richer System Design generation (README summary, architecture
 *      overview, architecture diagram, …) is launched from the top-bar
 *      `Generate System Design` dialog because it is a multi-kind LLM
 *      publication, not a one-shot artifact. ADR stays in the right rail
 *      because it is a single thread-scoped capture the user typically
 *      wants alongside the in-progress chat.
 *
 *   2. **Folder navigator** — tree view replacing the original "Repository
 *      intelligence + Thread outputs" flat sections. Drives every artifact
 *      navigation in the panel: clicking a folder expands it; clicking
 *      an artifact opens the standalone Reader (`/r/:rid/library/a/:aid`) via
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
  isVisible = true,
  className,
  onOpenInReader,
  onSelectFolder,
  selectedFolderId,
}: {
  threadId: ThreadId | null;
  /**
   * Repository the panel's folder tree is scoped to. `null` for a thread
   * without an attached repo — the navigator hides itself in that state.
   */
  repositoryId: RepositoryId | null;
  /**
   * Repo-level artifacts surfaced through `getRepositoryDetail`. Passed in
   * (rather than queried inside the panel) so the desktop chat surface can
   * keep its single subscription and the panel doesn't have to refetch.
   */
  artifacts?: ReadonlyArray<Doc<"artifacts">>;
  hasAttachedRepository: boolean;
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
  // Internal fallback when the caller doesn't provide a controlled
  // `selectedFolderId`. The chat right rail leaves selection uncontrolled,
  // so we own the state here and share it between FolderNavigator (where
  // the user clicks a folder) and ArtifactActions (where the picker shows
  // the same destination). Library reader callers keep external control by
  // passing `selectedFolderId` + `onSelectFolder` themselves.
  const [internalSelectedFolderId, setInternalSelectedFolderId] = useState<FolderId | null>(null);
  const isFolderSelectionControlled = selectedFolderId !== undefined;
  const effectiveSelectedFolderId = isFolderSelectionControlled ? selectedFolderId : internalSelectedFolderId;
  const handleSelectFolder = useCallback(
    (folderId: FolderId | null) => {
      if (!isFolderSelectionControlled) {
        setInternalSelectedFolderId(folderId);
      }
      onSelectFolder?.(folderId);
    },
    [isFolderSelectionControlled, onSelectFolder],
  );
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
            folderId={effectiveSelectedFolderId}
            onFolderChange={handleSelectFolder}
            open={effectiveActionsOpen}
            onOpenChange={setActionsOpen}
          />
        </div>
      ) : null}

      {repositoryId ? (
        <FolderNavigator
          repositoryId={repositoryId}
          artifacts={artifacts}
          selectedFolderId={effectiveSelectedFolderId}
          onSelectArtifact={handleSelectArtifact}
          onSelectFolder={handleSelectFolder}
          isUnseen={isUnseen}
          className="border-l-0"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 py-8">
          <p className="text-center text-[12px] text-muted-foreground">
            Attach a repository to capture ADRs and explore generated artifacts.
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
  folderId,
  onFolderChange,
  open,
  onOpenChange,
}: {
  threadId: ThreadId;
  repositoryId: RepositoryId | null;
  hasAttachedRepository: boolean;
  // The destination folder for the next generated artifact. Controlled by
  // the parent panel so it stays in sync with the navigator's selection —
  // clicking a folder below seeds this picker, and changing the picker
  // here highlights the matching folder below.
  folderId: FolderId | null;
  onFolderChange: (folderId: FolderId | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const captureAdr = useMutation(api.designArtifacts.captureAdr);

  const [adrError, setAdrError] = useState<string | null>(null);

  const [isAdrPending, runAdr] = useAsyncCallback(async () => {
    setAdrError(null);
    try {
      await captureAdr({ threadId, folderId: folderId ?? undefined });
    } catch (err) {
      setAdrError(toUserErrorMessage(err, "Failed to capture ADR."));
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
      <CollapsibleContent className="flex flex-col gap-2 pt-1">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Folder</span>
          <FolderPicker
            repositoryId={repositoryId}
            value={folderId}
            onChange={onFolderChange}
            hint="Where should this ADR land? Pick a feature folder or leave at Repository root."
            disabled={!hasAttachedRepository}
            className="w-full"
          />
        </div>
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
