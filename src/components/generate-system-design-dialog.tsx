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
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import type { RepositoryId } from "@/lib/types";

/**
 * The checklist the Generate System Design dialog renders. Order and labels
 * are deliberately hardcoded here so the dialog matches the publication
 * narrative even if the backend catalog grows additional kinds — new kinds
 * will appear as an "unrendered" warning instead of silently changing the UI
 * vocabulary. Every kind is LLM-backed: the generator opens a sandbox and
 * inspects live source, so there is no free / paid split. Order mirrors the
 * seeded System Design folder tree.
 */
const CATALOG: ReadonlyArray<{
  kind:
    | "readme_summary"
    | "architecture_overview"
    | "architecture_diagram"
    | "data_model_overview"
    | "api_surface_overview"
    | "deployment_overview"
    | "security_overview"
    | "operations_overview";
  title: string;
  description: string;
}> = [
  {
    kind: "readme_summary",
    title: "README Summary",
    description: "Purpose, services, audience, and key operations distilled from the README.",
  },
  {
    kind: "architecture_overview",
    title: "Architecture Overview",
    description: "Components, responsibilities, data and control flow, and key boundaries.",
  },
  {
    kind: "architecture_diagram",
    title: "Architecture Diagram",
    description: "Mermaid graph of components, flows, and boundaries — with legend and reading guide.",
  },
  {
    kind: "data_model_overview",
    title: "Data Model Overview",
    description: "Persistent stores, entities, relationships, invariants.",
  },
  {
    kind: "api_surface_overview",
    title: "API Surface Overview",
    description: "Externally-visible endpoints, auth, request/response shapes.",
  },
  {
    kind: "deployment_overview",
    title: "Deployment Overview",
    description: "Runtime targets, build pipeline, infra dependencies.",
  },
  {
    kind: "security_overview",
    title: "Security Overview",
    description: "Auth, authorisation, input validation, sensitive data.",
  },
  {
    kind: "operations_overview",
    title: "Operations Overview",
    description: "Logging, metrics, tracing, alerting, run-books.",
  },
];

type Kind = (typeof CATALOG)[number]["kind"];

/**
 * Default LLM pick the dialog opens with. Mirrors `DEFAULT_SYSTEM_DESIGN_*`
 * in `convex/systemDesign.ts` so the cache preview's "would skip N kinds"
 * answer matches what the backend would actually do on submit before the
 * user touches the picker. Kept in sync by hand: both places must point
 * at a sandbox-capable catalog entry — every kind drives sandbox tools, so
 * picking a non-tool model here would silently break generation.
 */
const DEFAULT_MODEL_PICK: PromptInputModelPickerValue = {
  provider: "openai",
  modelName: "gpt-5",
};

export function GenerateSystemDesignDialog({
  open,
  onOpenChange,
  repositoryId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositoryId: RepositoryId;
}) {
  const activeJob = useQuery(api.systemDesign.getActiveSystemDesignJob, { repositoryId });
  const requestGeneration = useMutation(api.systemDesign.requestSystemDesignGeneration);

  // Every document is worth generating, so the publication defaults to the
  // full set — the user unticks what they don't want rather than opting in.
  const [selected, setSelected] = useState<Set<Kind>>(() => new Set(CATALOG.map((item) => item.kind)));
  const [modelPick, setModelPick] = useState<PromptInputModelPickerValue>(DEFAULT_MODEL_PICK);
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
    selectionsArray.length === 0
      ? "skip"
      : {
          repositoryId,
          selections: selectionsArray,
          provider: modelPick.provider,
          modelName: modelPick.modelName,
        },
  );

  const toggle = (kind: Kind) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const [isSubmitting, runSubmit] = useAsyncCallback(async () => {
    setError(null);
    const selections = Array.from(selected);
    if (selections.length === 0) {
      setError("Select at least one document to generate.");
      return;
    }
    try {
      await requestGeneration({
        repositoryId,
        selections,
        provider: modelPick.provider,
        modelName: modelPick.modelName,
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
            Generate System Design
          </DialogTitle>
          <DialogDescription>
            Choose which documents to include in this publication. Each one is generated by inspecting your repository's
            live source in the sandbox (~1 LLM call each).
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Model</span>
          <PromptInputModelPicker
            value={modelPick}
            onChange={setModelPick}
            capability="sandbox"
            disabled={isSubmitting || jobInProgress}
          />
        </div>

        {jobInProgress ? (
          <Alert>
            <AlertDescription className="text-[12px]">
              A generation is already in progress for this repository. Close this dialog and watch the folder navigator
              — new artifacts will appear as each kind completes.
            </AlertDescription>
          </Alert>
        ) : null}

        <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto py-1">
          {CATALOG.map((item) => {
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
              Skip the cache and rebuild every selected document from scratch. Use when the repository's content changed
              outside of an import.
            </p>
          </div>
        </label>

        {showCacheHint ? (
          <Alert className="border-emerald-600/30 bg-emerald-600/5 text-[12px] text-emerald-900 dark:text-emerald-200">
            <AlertDescription className="text-[12px]">
              {allCached
                ? `All ${cachedCount} selected document${cachedCount === 1 ? "" : "s"} already exist for this commit and model — the run will be near-instant.`
                : `${cachedCount} of ${cachedTotal} selected document${cachedTotal === 1 ? "" : "s"} already exist for this commit and model. The run will reuse ${cachedCount === 1 ? "it" : "them"} and only generate the rest.`}
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
            Selected: <strong>{selected.size}</strong> of {CATALOG.length} documents.
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
              disabled={isSubmitting || jobInProgress || selected.size === 0}
            >
              {isSubmitting ? (
                <>
                  <Spinner size={14} className="mr-2" />
                  Starting…
                </>
              ) : (
                "Generate selected"
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
