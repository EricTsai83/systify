import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FileTextIcon, SparkleIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  PromptInputModelPicker,
  type PromptInputModelPickerValue,
} from "@/components/ai-elements/prompt-input-model-picker";
import { PromptInputReasoningPicker } from "@/components/ai-elements/prompt-input-reasoning-picker";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { useDefaultModelPick } from "@/hooks/use-default-model-pick";
import { useModelAccessDisabledReason } from "@/hooks/use-model-access-disabled-reason";
import { toUserErrorMessage } from "@/lib/errors";
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
import { REPOSITORY_GUIDE_SECTIONS, type RepositoryGuideKind } from "@/lib/repository-guide-catalog";
import type { ReasoningEffort, RepositoryId } from "@/lib/types";

export function GenerateSystemDesignDialog({
  open,
  onOpenChange,
  repositoryId,
  disabledReason,
  premiumModelsDisabledReason,
  highReasoningDisabledReason,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositoryId: RepositoryId;
  disabledReason?: string;
  premiumModelsDisabledReason?: string;
  highReasoningDisabledReason?: string;
}) {
  const activeJob = useQuery(api.systemDesign.getActiveSystemDesignJob, { repositoryId });
  const requestGeneration = useMutation(api.systemDesign.requestSystemDesignGeneration);

  // Every document is worth generating, so the publication defaults to the
  // full set — the user unticks what they don't want rather than opting in.
  const [selected, setSelected] = useState<Set<RepositoryGuideKind>>(
    () => new Set(REPOSITORY_GUIDE_SECTIONS.map((item) => item.kind)),
  );
  // Default model resolves through the same cascade the dialog used
  // to hardcode: capability default sourced from `ROLE_MODELS` on the
  // server. `useDefaultModelPick` returns `undefined` while loading
  // so the picker shows its placeholder for one paint instead of
  // flashing a stale default.
  const defaultPick = useDefaultModelPick({ capability: "sandbox", preferenceScope: "sandbox" });
  const [userPick, setUserPick] = useState<PromptInputModelPickerValue | null>(null);
  const modelPick: PromptInputModelPickerValue | null = userPick ?? defaultPick ?? null;
  const setModelPick = (next: PromptInputModelPickerValue) => setUserPick(next);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(null);
  const [forceRegenerate, setForceRegenerate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previousOpen, setPreviousOpen] = useState(open);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    setError(null);
  }

  // Cache preview — the backend already knows which selected kinds have a
  // fresh artifact aligned to the repo's last-imported commit + this exact
  // (provider, model, promptVersion). We surface that number so the user
  // can make an informed call about whether toggling "force regenerate"
  // would save money or waste it.
  const selectionsArray = useMemo(() => Array.from(selected), [selected]);
  const cachedStatus = useQuery(
    api.systemDesign.getCachedSelectionStatus,
    selectionsArray.length === 0 || !modelPick
      ? "skip"
      : {
          repositoryId,
          selections: selectionsArray,
          provider: modelPick.provider,
          modelName: modelPick.modelName,
        },
  );
  const modelAccessDisabledReason = useModelAccessDisabledReason({
    modelPick,
    reasoningEffort,
    preferenceScope: "sandbox",
    premiumModelsDisabledReason,
    highReasoningDisabledReason,
  });
  const submitDisabledReason = disabledReason ?? modelAccessDisabledReason ?? undefined;

  const toggle = (kind: RepositoryGuideKind) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const [isSubmitting, runSubmit] = useAsyncCallback(async () => {
    setError(null);
    if (submitDisabledReason) {
      setError(submitDisabledReason);
      return;
    }
    const selections = Array.from(selected);
    if (selections.length === 0) {
      setError(`Select at least one ${REPOSITORY_GUIDE_COPY.sectionName} to generate.`);
      return;
    }
    if (!modelPick) {
      // `useDefaultModelPick` returns undefined until the catalog
      // query resolves. The submit button is disabled in that
      // window, but guard the call site too so the mutation never
      // receives a half-set picker pair.
      setError("Loading models — try again in a moment.");
      return;
    }
    try {
      await requestGeneration({
        repositoryId,
        selections,
        provider: modelPick.provider,
        modelName: modelPick.modelName,
        ...(reasoningEffort !== null ? { reasoningEffort } : {}),
        forceRegenerate: forceRegenerate || undefined,
      });
      onOpenChange(false);
    } catch (err) {
      setError(toUserErrorMessage(err, "Failed to start generation."));
    }
  });

  const jobInProgress = activeJob != null;
  // Defensive reads: guard each field independently. The same `useQuery`
  // mock is shared across multiple queries in the test harness, so the
  // route that returns a non-cached-status payload (e.g. a `Doc<"jobs">`
  // for `getActiveSystemDesignJob`) must not crash here. In production
  // Convex's typed projection guarantees the shape.
  const cachedCount = cachedStatus?.cachedKinds?.length ?? 0;
  const cachedTotal = cachedStatus?.total ?? 0;
  // When the user has toggled "Regenerate even if cached" we hide the
  // cache-hit hint because it no longer reflects what the run will do.
  const showCacheHint = !forceRegenerate && cachedTotal > 0 && cachedCount > 0;
  const allCached = cachedTotal > 0 && cachedCount === cachedTotal;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparkleIcon size={16} weight="bold" />
            {REPOSITORY_GUIDE_COPY.generateAction}
          </DialogTitle>
          <DialogDescription>
            Choose which guide sections to create. Each section is generated by inspecting this repository's live source
            (~1 LLM call each).
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Model</span>
          <div className="flex items-center gap-1">
            <PromptInputModelPicker
              value={modelPick}
              onChange={setModelPick}
              capability="sandbox"
              preferenceScope="sandbox"
              disabled={isSubmitting || jobInProgress}
              getDisabledReason={(entry) =>
                premiumModelsDisabledReason && entry.capability === "sandbox" ? premiumModelsDisabledReason : null
              }
            />
            <PromptInputReasoningPicker
              value={reasoningEffort}
              onChange={setReasoningEffort}
              provider={modelPick?.provider}
              modelName={modelPick?.modelName}
              preferenceScope="sandbox"
              disabled={isSubmitting || jobInProgress}
              disabledReasoningEfforts={highReasoningDisabledReason ? ["high", "xhigh"] : []}
              disabledReasoningEffortMessage={highReasoningDisabledReason}
            />
          </div>
        </div>

        {jobInProgress ? (
          <Alert>
            <AlertDescription className="text-[12px]">
              A Repository Guide run is already in progress. Close this dialog and watch the folder navigator — new
              guide sections will appear as they complete.
            </AlertDescription>
          </Alert>
        ) : null}

        {disabledReason ? (
          <Alert>
            <AlertDescription className="text-[12px]">{disabledReason}</AlertDescription>
          </Alert>
        ) : null}

        <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto py-1">
          {REPOSITORY_GUIDE_SECTIONS.map((item) => {
            const checked = selected.has(item.kind);
            return (
              <li key={item.kind}>
                <label
                  className="flex cursor-pointer items-start gap-3 p-2 transition hover:bg-muted"
                  htmlFor={`gen-${item.kind}`}
                >
                  <input
                    id={`gen-${item.kind}`}
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-primary"
                    checked={checked}
                    onChange={() => toggle(item.kind)}
                    disabled={isSubmitting || jobInProgress}
                  />
                  <div className="flex flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <FileTextIcon size={12} weight="bold" className="text-muted-foreground" />
                      <span className="text-[13px] font-medium">{item.title}</span>
                    </div>
                    <p className="text-[11px] leading-snug text-muted-foreground">{item.description}</p>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>

        <label
          className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 px-2 py-1.5"
          htmlFor="gen-force-regenerate"
        >
          <input
            id="gen-force-regenerate"
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={forceRegenerate}
            onChange={(e) => setForceRegenerate(e.target.checked)}
            disabled={isSubmitting || jobInProgress}
          />
          <div className="flex flex-1 flex-col gap-0.5">
            <span className="text-[12px] font-medium">Regenerate even if cached</span>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Skip the cache and rebuild every selected guide section from scratch. Use when the repository's content
              changed outside of an import.
            </p>
          </div>
        </label>

        {showCacheHint ? (
          <Alert className="border-emerald-600/30 bg-emerald-600/5 text-[12px] text-emerald-900 dark:text-emerald-200">
            <AlertDescription className="text-[12px]">
              {allCached
                ? `All ${cachedCount} selected ${cachedCount === 1 ? REPOSITORY_GUIDE_COPY.sectionName : REPOSITORY_GUIDE_COPY.sectionNamePlural} already exist for this commit and model — the run will be near-instant.`
                : `${cachedCount} of ${cachedTotal} selected ${cachedTotal === 1 ? REPOSITORY_GUIDE_COPY.sectionName : REPOSITORY_GUIDE_COPY.sectionNamePlural} already exist for this commit and model. The run will reuse ${cachedCount === 1 ? "it" : "them"} and only generate the rest.`}
            </AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="text-[12px]">{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-[11px] text-muted-foreground">
            Selected: <strong>{selected.size}</strong> of {REPOSITORY_GUIDE_SECTIONS.length}{" "}
            {REPOSITORY_GUIDE_COPY.sectionNamePlural}.
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void runSubmit()}
              disabled={submitDisabledReason !== undefined || isSubmitting || jobInProgress || selected.size === 0}
              title={submitDisabledReason}
            >
              {isSubmitting ? (
                <>
                  <Spinner size={14} className="mr-2" />
                  Starting…
                </>
              ) : (
                REPOSITORY_GUIDE_COPY.generateSelectedAction
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
