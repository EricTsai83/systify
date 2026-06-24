import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowClockwiseIcon,
  CheckIcon,
  FileHtmlIcon,
  FilePlusIcon,
  GitDiffIcon,
  ProhibitIcon,
  SparkleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { FolderPicker } from "@/components/folder-picker";
import {
  PromptInputModelPicker,
  type PromptInputModelPickerValue,
} from "@/components/ai-elements/prompt-input-model-picker";
import { PromptInputReasoningPicker } from "@/components/ai-elements/prompt-input-reasoning-picker";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import type { ArtifactId, FolderId, ReasoningEffort, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export type LibraryArtifactDraftEntry = {
  draft: Doc<"artifactDrafts">;
  job: Doc<"jobs"> | null;
};

export type LibraryArtifactDraftOperation = "create" | "update";

export type LibraryArtifactDraftIntent = {
  operation: LibraryArtifactDraftOperation;
  outputFormat: "markdown" | "html";
  title: string;
  folderId: FolderId | null;
  prompt: string;
};

export function LibraryArtifactDraftConfirmCard({
  repositoryId,
  intent,
  activeArtifactTitle,
  disabledReason,
  repositoryCodeLabel,
  modelPick,
  onModelPickChange,
  reasoningEffort,
  onReasoningEffortChange,
  premiumModelsDisabledReason,
  highReasoningDisabledReason,
  onChange,
  onCancel,
  onSubmit,
  isSubmitting,
}: {
  repositoryId: RepositoryId;
  intent: LibraryArtifactDraftIntent;
  activeArtifactTitle?: string;
  disabledReason?: string;
  repositoryCodeLabel: string;
  modelPick: PromptInputModelPickerValue | null;
  onModelPickChange: (pick: PromptInputModelPickerValue) => void;
  reasoningEffort: ReasoningEffort | null;
  onReasoningEffortChange: (effort: ReasoningEffort | null) => void;
  premiumModelsDisabledReason?: string;
  highReasoningDisabledReason?: string;
  onChange: (next: LibraryArtifactDraftIntent) => void;
  onCancel: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
}) {
  const isCreate = intent.operation === "create";
  const isHtml = intent.outputFormat === "html";
  const modelCapability = isHtml ? "library" : "sandbox";
  const preferenceScope = isHtml ? "library" : "sandbox";
  const missingTitle = isCreate && intent.title.trim().length === 0;
  const missingPrompt = isCreate && intent.prompt.trim().length === 0;
  const submitLabel = isHtml ? "Draft HTML report" : isCreate ? "Draft artifact" : "Draft update";
  const submitDisabledReason =
    disabledReason ??
    (modelPick ? undefined : "Loading models…") ??
    (missingTitle ? "Add a title for the new artifact." : undefined) ??
    (missingPrompt ? "Describe what to draft." : undefined);
  const helperText =
    submitDisabledReason ??
    (isHtml
      ? "Uses Library knowledge by default, not live source."
      : isCreate
        ? "The draft is only saved after you review and apply it."
        : "Leave instructions blank to refresh this artifact from the codebase source of truth.");
  const helperTone = disabledReason ? "text-destructive" : "text-muted-foreground";

  return (
    <div className="space-y-3" data-testid="artifact-draft-confirm-card">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          {isHtml ? (
            <FileHtmlIcon size={15} weight="bold" />
          ) : isCreate ? (
            <FilePlusIcon size={15} weight="bold" />
          ) : (
            <GitDiffIcon size={15} weight="bold" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate text-[13px] font-semibold text-foreground">
              {isHtml ? "Draft HTML report" : isCreate ? "Create artifact" : "Update open artifact"}
            </h3>
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {isHtml ? "Uses Library" : "Uses codebase"}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{repositoryCodeLabel}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {isCreate ? (
          <>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              Title
              <Input
                value={intent.title}
                onChange={(event) => onChange({ ...intent, title: event.target.value })}
                placeholder="Artifact title"
                className="h-8 text-[12px]"
                disabled={isSubmitting}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              Folder
              <FolderPicker
                repositoryId={repositoryId}
                value={intent.folderId}
                onChange={(folderId) => onChange({ ...intent, folderId })}
                disabled={isSubmitting}
              />
            </label>
          </>
        ) : (
          <div className="rounded-sm border border-border/70 bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
            Target: <span className="font-medium text-foreground">{activeArtifactTitle ?? "Open artifact"}</span>
          </div>
        )}

        <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
          {isCreate ? "Instructions" : "Instructions (optional)"}
          <Textarea
            value={intent.prompt}
            onChange={(event) => onChange({ ...intent, prompt: event.target.value })}
            placeholder={
              isCreate ? "What should this new artifact cover?" : "Optional focus, constraints, or sections to update"
            }
            className="min-h-24 resize-none text-[12px]"
            disabled={isSubmitting}
          />
        </label>

        <div className="flex items-center justify-between gap-2 rounded-sm border border-border/70 bg-muted/25 px-2 py-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Model</span>
          <div className="flex min-w-0 items-center gap-1">
            <PromptInputModelPicker
              value={modelPick}
              onChange={onModelPickChange}
              capability={modelCapability}
              preferenceScope={preferenceScope}
              disabled={isSubmitting}
              getDisabledReason={(entry) =>
                premiumModelsDisabledReason && entry.capability === "sandbox" ? premiumModelsDisabledReason : null
              }
            />
            <PromptInputReasoningPicker
              value={reasoningEffort}
              onChange={onReasoningEffortChange}
              provider={modelPick?.provider}
              modelName={modelPick?.modelName}
              preferenceScope={preferenceScope}
              disabled={isSubmitting}
              disabledReasoningEfforts={highReasoningDisabledReason ? ["high", "xhigh"] : []}
              disabledReasoningEffortMessage={highReasoningDisabledReason}
            />
          </div>
        </div>

        <p className={cn("text-[11px] leading-4", helperTone)} role={disabledReason ? "alert" : undefined}>
          {helperText}
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={onSubmit}
            disabled={isSubmitting || submitDisabledReason !== undefined}
            title={submitDisabledReason}
          >
            <SparkleIcon size={13} weight="bold" />
            <ButtonStateText current={isSubmitting ? "Drafting…" : submitLabel} states={[submitLabel, "Drafting…"]} />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function LibraryArtifactDraftCard({
  entry,
  onApplied,
  onRegenerated,
}: {
  entry: LibraryArtifactDraftEntry;
  onApplied: (artifactId: ArtifactId) => void;
  onRegenerated?: (draftId: Doc<"artifactDrafts">["_id"]) => void;
}) {
  const applyDraft = useMutation(api.libraryArtifactDrafts.applyDraft);
  const discardDraft = useMutation(api.libraryArtifactDrafts.discardDraft);
  const regenerateDraft = useMutation(api.libraryArtifactDrafts.regenerateDraft);
  const status = entry.draft.status;
  const isHtmlDraft = (entry.draft.outputFormat ?? "markdown") === "html";
  const htmlPreview = useQuery(
    api.artifactHtml.getDraftPreviewUrl,
    isHtmlDraft && status === "ready" ? { draftId: entry.draft._id } : "skip",
  );
  const targetArtifact = useQuery(
    api.artifacts.getById,
    entry.draft.targetArtifactId ? { artifactId: entry.draft.targetArtifactId } : "skip",
  );
  const targetArtifactDisabledReason = useMemo(() => {
    if (entry.draft.operation !== "update") {
      return undefined;
    }
    if (!entry.draft.targetArtifactId || entry.draft.targetArtifactVersion === undefined) {
      return "Target artifact missing or changed. Regenerate this draft before applying it.";
    }
    if (targetArtifact === undefined) {
      return "Loading target artifact…";
    }
    if (
      targetArtifact === null ||
      targetArtifact._id !== entry.draft.targetArtifactId ||
      targetArtifact.ownerTokenIdentifier !== entry.draft.ownerTokenIdentifier ||
      targetArtifact.version !== entry.draft.targetArtifactVersion
    ) {
      return "Target artifact missing or changed. Regenerate this draft before applying it.";
    }
    return undefined;
  }, [
    entry.draft.operation,
    entry.draft.ownerTokenIdentifier,
    entry.draft.targetArtifactId,
    entry.draft.targetArtifactVersion,
    targetArtifact,
  ]);
  const targetArtifactPreviewReason =
    targetArtifactDisabledReason === "Loading target artifact…" ? undefined : targetArtifactDisabledReason;

  const [isApplying, runApply] = useAsyncCallback(async () => {
    if (targetArtifactDisabledReason !== undefined) {
      toast.error(targetArtifactDisabledReason);
      return;
    }
    try {
      const result = await applyDraft({ draftId: entry.draft._id });
      onApplied(result.artifactId as ArtifactId);
      toast.success(entry.draft.operation === "create" ? "Artifact created." : "Artifact updated.");
    } catch (error) {
      toast.error(toUserErrorMessage(error, "Failed to apply draft."));
    }
  });

  const [isDiscarding, runDiscard] = useAsyncCallback(async () => {
    try {
      await discardDraft({ draftId: entry.draft._id });
    } catch (error) {
      toast.error(toUserErrorMessage(error, "Failed to discard draft."));
    }
  });

  const [isRegenerating, runRegenerate] = useAsyncCallback(async () => {
    try {
      const result = await regenerateDraft({ draftId: entry.draft._id });
      onRegenerated?.(result.draftId);
    } catch (error) {
      toast.error(toUserErrorMessage(error, "Failed to regenerate draft."));
    }
  });

  const isActive = status === "queued" || status === "running";
  const isReady = status === "ready";
  const title = isHtmlDraft
    ? "HTML report draft"
    : entry.draft.operation === "create"
      ? "New artifact draft"
      : "Artifact update draft";
  const progress = Math.round((entry.job?.progress ?? (isActive ? 0.05 : 1)) * 100);

  return (
    <div className="border border-border bg-card px-3 py-3 shadow-sm" data-testid="artifact-draft-card">
      <div className="flex items-start gap-2">
        <DraftStatusIcon status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-[13px] font-semibold text-foreground">{title}</h3>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {entry.draft.title || "Untitled artifact"}
              </p>
            </div>
            <DraftStatusBadge status={status} />
          </div>
        </div>
      </div>

      {isActive ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{entry.job?.stage ?? "Preparing code access…"}</span>
            <span className="shrink-0 tabular-nums">{progress}%</span>
          </div>
          <Progress value={progress} />
        </div>
      ) : null}

      {status === "failed" ? (
        <div className="mt-3 space-y-3">
          <p className="text-[12px] leading-5 text-destructive">
            {entry.draft.errorMessage ?? entry.job?.errorMessage ?? "Artifact draft failed."}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void runDiscard()} disabled={isDiscarding}>
              <ProhibitIcon size={13} weight="bold" />
              Discard
            </Button>
            <Button type="button" size="sm" onClick={() => void runRegenerate()} disabled={isRegenerating}>
              <ArrowClockwiseIcon size={13} weight="bold" />
              <ButtonStateText current={isRegenerating ? "Retrying…" : "Retry"} states={["Retry", "Retrying…"]} />
            </Button>
          </div>
        </div>
      ) : null}

      {isReady ? (
        <div className="mt-3 space-y-3">
          <div className="space-y-1">
            <h4 className="text-[12px] font-semibold text-foreground">{entry.draft.title}</h4>
            <p className="text-[11px] leading-4 text-muted-foreground">{entry.draft.description}</p>
            {entry.draft.changeSummary ? (
              <p className="text-[11px] leading-4 text-muted-foreground">Changes: {entry.draft.changeSummary}</p>
            ) : null}
          </div>
          {isHtmlDraft ? (
            <LibraryArtifactHtmlDraftPreview draft={entry.draft} preview={htmlPreview} />
          ) : entry.draft.operation === "update" ? (
            targetArtifactPreviewReason ? (
              <p className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
                {targetArtifactPreviewReason}
              </p>
            ) : (
              <LibraryArtifactDiffPreview
                beforeMarkdown={targetArtifact?.contentMarkdown ?? ""}
                afterMarkdown={entry.draft.contentMarkdown}
                isLoading={targetArtifact === undefined}
              />
            )
          ) : (
            <Markdown className="max-h-96 overflow-y-auto border border-border/70 bg-background px-3 py-2 text-[12px]">
              {entry.draft.contentMarkdown}
            </Markdown>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void runDiscard()}
              disabled={isDiscarding || isApplying || isRegenerating}
            >
              <ProhibitIcon size={13} weight="bold" />
              Discard
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void runRegenerate()}
              disabled={isDiscarding || isApplying || isRegenerating}
            >
              <ArrowClockwiseIcon size={13} weight="bold" />
              Regenerate
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void runApply()}
              disabled={isDiscarding || isApplying || isRegenerating || targetArtifactDisabledReason !== undefined}
              title={targetArtifactDisabledReason}
            >
              <CheckIcon size={13} weight="bold" />
              <ButtonStateText current={isApplying ? "Applying…" : "Apply"} states={["Apply", "Applying…"]} />
            </Button>
          </div>
        </div>
      ) : null}

      {status === "applied" || status === "discarded" ? (
        <p className="mt-3 text-[11px] text-muted-foreground">
          {status === "applied" ? "Applied to the Library." : "Discarded. No artifact was changed."}
        </p>
      ) : null}
    </div>
  );
}

export function LibraryArtifactDiffPreview({
  beforeMarkdown,
  afterMarkdown,
  isLoading = false,
}: {
  beforeMarkdown: string;
  afterMarkdown: string;
  isLoading?: boolean;
}) {
  const [showFull, setShowFull] = useState(false);
  const diff = useMemo(() => buildLineDiff(beforeMarkdown, afterMarkdown), [beforeMarkdown, afterMarkdown]);

  if (isLoading) {
    return <p className="text-[11px] text-muted-foreground">Loading current artifact…</p>;
  }

  return (
    <div className="space-y-2">
      <div className="max-h-72 overflow-y-auto border border-border/70 bg-background font-mono text-[11px] leading-5">
        {diff.map((line, index) => (
          <div
            key={`${line.kind}-${index}`}
            className={cn(
              "grid grid-cols-[1.5rem_1fr] gap-2 px-2",
              line.kind === "add" ? "bg-success/10 text-success" : "",
              line.kind === "remove" ? "bg-destructive/10 text-destructive" : "",
              line.kind === "context" ? "text-muted-foreground" : "",
            )}
          >
            <span className="select-none text-right">
              {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
            </span>
            <span className="whitespace-pre-wrap break-words">{line.text || " "}</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
        onClick={() => setShowFull((previous) => !previous)}
      >
        {showFull ? "Hide full proposed markdown" : "Show full proposed markdown"}
      </button>
      {showFull ? (
        <Markdown className="max-h-96 overflow-y-auto border border-border/70 bg-background px-3 py-2 text-[12px]">
          {afterMarkdown}
        </Markdown>
      ) : null}
    </div>
  );
}

function DraftStatusIcon({ status }: { status: Doc<"artifactDrafts">["status"] }) {
  const className =
    status === "failed"
      ? "bg-destructive/10 text-destructive"
      : status === "ready" || status === "applied"
        ? "bg-success/10 text-success"
        : "bg-primary/10 text-primary";
  return (
    <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full", className)}>
      {status === "failed" ? (
        <WarningCircleIcon size={15} weight="bold" />
      ) : status === "ready" || status === "applied" ? (
        <CheckIcon size={15} weight="bold" />
      ) : (
        <SparkleIcon size={15} weight="bold" />
      )}
    </span>
  );
}

function DraftStatusBadge({ status }: { status: Doc<"artifactDrafts">["status"] }) {
  const label: Record<Doc<"artifactDrafts">["status"], string> = {
    queued: "Queued",
    running: "Running",
    ready: "Ready",
    applied: "Applied",
    discarded: "Discarded",
    failed: "Failed",
  };
  return (
    <span className="shrink-0 border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {label[status]}
    </span>
  );
}

type DiffLine = {
  kind: "context" | "add" | "remove";
  text: string;
};

function buildLineDiff(beforeMarkdown: string, afterMarkdown: string): DiffLine[] {
  const before = beforeMarkdown.split("\n");
  const after = afterMarkdown.split("\n");
  if (before.length * after.length > 40_000) {
    return [
      { kind: "remove", text: `${before.length} existing lines` },
      { kind: "add", text: `${after.length} proposed lines` },
    ];
  }

  const table = Array.from({ length: before.length + 1 }, () => Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ kind: "context", text: before[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: "remove", text: before[i] });
      i += 1;
    } else {
      lines.push({ kind: "add", text: after[j] });
      j += 1;
    }
  }
  while (i < before.length) {
    lines.push({ kind: "remove", text: before[i] });
    i += 1;
  }
  while (j < after.length) {
    lines.push({ kind: "add", text: after[j] });
    j += 1;
  }

  return compactContext(lines, 3, 160);
}

function LibraryArtifactHtmlDraftPreview({
  draft,
  preview,
}: {
  draft: Doc<"artifactDrafts">;
  preview:
    | {
        url: string;
        htmlHash?: string;
        htmlByteLength?: number;
        validationErrors?: string[];
      }
    | null
    | undefined;
}) {
  if (preview === undefined) {
    return <p className="text-[11px] text-muted-foreground">Loading HTML preview…</p>;
  }
  if (preview === null) {
    return (
      <p className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
        HTML preview is not available.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
        <span>HTML {formatByteLength(preview.htmlByteLength ?? draft.htmlByteLength)}</span>
        <span className="truncate text-right">
          {(preview.htmlHash ?? draft.htmlHash)
            ? `Hash ${(preview.htmlHash ?? draft.htmlHash)?.slice(0, 12)}`
            : "Hash pending"}
        </span>
        <span>{draft.sourceArtifacts?.length ?? 0} source artifacts</span>
        <span className="text-right">{draft.sourceChunkIds?.length ?? 0} source chunks</span>
      </div>
      <iframe
        title={`${draft.title} HTML preview`}
        sandbox=""
        referrerPolicy="no-referrer"
        src={preview.url}
        className="h-96 w-full border border-border/70 bg-background"
      />
    </div>
  );
}

function formatByteLength(value: number | undefined): string {
  if (value === undefined) {
    return "size pending";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  return `${(value / 1024).toFixed(1)} KB`;
}

function compactContext(lines: DiffLine[], radius: number, maxLines: number): DiffLine[] {
  const changedIndexes = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind !== "context") {
      for (let offset = -radius; offset <= radius; offset += 1) {
        const next = index + offset;
        if (next >= 0 && next < lines.length) {
          changedIndexes.add(next);
        }
      }
    }
  });
  if (changedIndexes.size === 0) {
    return [{ kind: "context", text: "No markdown changes." }];
  }

  const compacted: DiffLine[] = [];
  let skipped = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!changedIndexes.has(index)) {
      skipped += 1;
      continue;
    }
    if (skipped > 0) {
      compacted.push({ kind: "context", text: `… ${skipped} unchanged line${skipped === 1 ? "" : "s"} …` });
      skipped = 0;
    }
    compacted.push(lines[index]);
    if (compacted.length >= maxLines) {
      compacted.push({ kind: "context", text: "… diff truncated …" });
      break;
    }
  }
  return compacted;
}
