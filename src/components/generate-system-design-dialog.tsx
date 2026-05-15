import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CircleNotchIcon, FileTextIcon, SparkleIcon } from "@phosphor-icons/react";
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
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import type { RepositoryId } from "@/lib/types";

/**
 * The checklist the Generate System Design dialog renders. Order and labels
 * are deliberately hardcoded here so the dialog matches the publication
 * narrative even if the backend catalog grows additional kinds — new kinds
 * will appear as an "unrendered" warning instead of silently changing the UI
 * vocabulary. Free (heuristic) kinds are listed first so a user scanning
 * the dialog sees the no-cost options up top.
 */
const CATALOG: ReadonlyArray<{
  kind:
    | "manifest"
    | "readme_summary"
    | "architecture_overview"
    | "data_model_overview"
    | "api_surface_overview"
    | "deployment_overview"
    | "security_overview"
    | "operations_overview";
  title: string;
  description: string;
  cost: "free" | "llm";
  defaultChecked: boolean;
}> = [
  {
    kind: "manifest",
    title: "Repository Manifest",
    description: "Languages, package managers, entrypoints, important files.",
    cost: "free",
    defaultChecked: true,
  },
  {
    kind: "architecture_overview",
    title: "Architecture Overview",
    description: "High-signal files and suggested reading order.",
    cost: "free",
    defaultChecked: true,
  },
  {
    kind: "readme_summary",
    title: "README Summary",
    description: "Purpose, audience, features, and quickstart distilled from the README.",
    cost: "llm",
    defaultChecked: false,
  },
  {
    kind: "data_model_overview",
    title: "Data Model Overview",
    description: "Persistent stores, entities, relationships, invariants.",
    cost: "llm",
    defaultChecked: false,
  },
  {
    kind: "api_surface_overview",
    title: "API Surface Overview",
    description: "Externally-visible endpoints, auth, request/response shapes.",
    cost: "llm",
    defaultChecked: false,
  },
  {
    kind: "deployment_overview",
    title: "Deployment Overview",
    description: "Runtime targets, build pipeline, infra dependencies.",
    cost: "llm",
    defaultChecked: false,
  },
  {
    kind: "security_overview",
    title: "Security Overview",
    description: "Auth, authorisation, input validation, sensitive data.",
    cost: "llm",
    defaultChecked: false,
  },
  {
    kind: "operations_overview",
    title: "Operations Overview",
    description: "Logging, metrics, tracing, alerting, run-books.",
    cost: "llm",
    defaultChecked: false,
  },
];

type Kind = (typeof CATALOG)[number]["kind"];

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

  const [selected, setSelected] = useState<Set<Kind>>(
    () => new Set(CATALOG.filter((item) => item.defaultChecked).map((item) => item.kind)),
  );
  const [error, setError] = useState<string | null>(null);
  const [previousOpen, setPreviousOpen] = useState(open);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    setError(null);
  }

  const toggle = (kind: Kind) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const counts = useMemo(() => {
    let free = 0;
    let llm = 0;
    for (const item of CATALOG) {
      if (!selected.has(item.kind)) continue;
      if (item.cost === "free") free += 1;
      else llm += 1;
    }
    return { free, llm };
  }, [selected]);

  const [isSubmitting, runSubmit] = useAsyncCallback(async () => {
    setError(null);
    const selections = Array.from(selected);
    if (selections.length === 0) {
      setError("Select at least one document to generate.");
      return;
    }
    try {
      await requestGeneration({ repositoryId, selections });
      onOpenChange(false);
    } catch (err) {
      setError(toUserErrorMessage(err, "Failed to start generation."));
    }
  });

  const jobInProgress = activeJob != null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparkleIcon size={16} weight="bold" />
            Generate System Design
          </DialogTitle>
          <DialogDescription>
            Choose which documents to include in this publication. Free docs are derived from the imported repo
            metadata; LLM-backed docs use the sandbox to inspect live source.
          </DialogDescription>
        </DialogHeader>

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
                  className="flex cursor-pointer items-start gap-3 rounded-md p-2 transition hover:bg-muted"
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
                      <span
                        className={
                          item.cost === "free"
                            ? "rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
                            : "rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                        }
                      >
                        {item.cost === "free" ? "Free" : "~1 LLM call"}
                      </span>
                    </div>
                    <p className="text-[11px] leading-snug text-muted-foreground">{item.description}</p>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="text-[12px]">{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-[11px] text-muted-foreground">
            Selected: <strong>{counts.free + counts.llm}</strong> total ({counts.free} free, {counts.llm} LLM).
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
                  <CircleNotchIcon size={14} className="mr-2 animate-spin" weight="bold" />
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
