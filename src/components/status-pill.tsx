import { useMemo, type ButtonHTMLAttributes, type Ref } from "react";
import { ArrowsClockwiseIcon, CircleNotchIcon, SparkleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useRelativeTime } from "@/hooks/use-relative-time";
import { cn } from "@/lib/utils";
import {
  isUserRelevantActiveJob,
  presentRepositoryIntelligenceSurface,
  presentSandboxSurface,
  type OperationTone,
} from "@/lib/operations";
import type { SandboxModeStatus } from "@/lib/types";

type PillTone = "idle" | "active" | "info" | "warning" | "error";

type PillState = {
  tone: PillTone;
  label: string;
  icon: "spinner" | "alert" | "sparkle" | "sync" | null;
  /** Optional secondary copy used in the tooltip; main label stays compact. */
  detail?: string;
};

/**
 * StatusPill props split into "pill data" (fields that drive the visual state)
 * and forwarded button attributes. The `Omit` prevents callers from
 * accidentally overriding the few attributes that are load-bearing for the
 * pill identity (`type`, `aria-label`, `data-testid`) while still letting
 * Radix's PopoverTrigger / TooltipTrigger inject `onClick`, `aria-expanded`,
 * `data-state`, and a forwarded ref via the asChild Slot mechanism.
 */
type StatusPillProps = {
  repository: Doc<"repositories">;
  sandboxModeStatus: SandboxModeStatus;
  jobs: Doc<"jobs">[];
  activeDeepAnalysisJob: Doc<"jobs"> | null;
  hasRemoteUpdates: boolean;
  isSyncing: boolean;
  isOpen: boolean;
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type" | "aria-pressed" | "aria-label" | "data-testid">;

/**
 * Compact "system status" indicator that lives in the top bar. Replaces the
 * always-visible Repository Status Deck as the primary entry point — clicking
 * the pill opens the StatusPanel where the user can see the full breakdown.
 *
 * The pill condenses three independent surfaces (repository intelligence,
 * sandbox, deep analysis) into a single worst-state-wins tone so the user sees
 * one coherent signal:
 *
 *   error   → import or sandbox failed (something is genuinely blocking)
 *   warning → updates available, sandbox expired, sandbox missing
 *   active  → a user-relevant job is running
 *   info    → idle but with something noteworthy (no analysis yet)
 *   idle    → everything is healthy and unremarkable
 *
 * The label is intentionally short — a long string in a top-bar chip steals
 * attention from the chat. The tooltip carries the longer "what does this
 * mean" copy.
 */
export function StatusPill({
  repository,
  sandboxModeStatus,
  jobs,
  activeDeepAnalysisJob,
  hasRemoteUpdates,
  isSyncing,
  isOpen,
  ref,
  className,
  ...buttonProps
}: StatusPillProps) {
  const state = useMemo(
    () =>
      derivePillState({
        repository,
        sandboxModeStatus,
        jobs,
        activeDeepAnalysisJob,
        hasRemoteUpdates,
        isSyncing,
      }),
    [repository, sandboxModeStatus, jobs, activeDeepAnalysisJob, hasRemoteUpdates, isSyncing],
  );

  const lastSyncedLabel = useRelativeTime(repository.lastImportedAt);
  // The "Synced 5m ago" suffix only appears in the idle state — every other
  // state already conveys a more important signal in its label and adding the
  // suffix would dilute it.
  const labelText = state.tone === "idle" && lastSyncedLabel ? `Synced ${lastSyncedLabel}` : state.label;
  const tooltipText = state.detail ?? labelText;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={ref}
            type="button"
            variant={state.tone === "error" ? "destructive" : "outline"}
            size="sm"
            aria-pressed={isOpen}
            aria-label="Repository status"
            data-testid="status-pill"
            className={cn(
              "h-8 min-w-[6.5rem] gap-1.5 px-3 text-xs",
              state.tone !== "error" && pillToneClassName(state.tone),
              className,
            )}
            {...buttonProps}
          >
            <PillIcon icon={state.icon} />
            <span className="truncate">{labelText}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PillIcon({ icon }: { icon: PillState["icon"] }) {
  if (!icon) return null;
  switch (icon) {
    case "spinner":
      return <CircleNotchIcon size={12} weight="bold" className="animate-spin" />;
    case "alert":
      return <WarningCircleIcon size={12} weight="bold" />;
    case "sparkle":
      return <SparkleIcon size={12} weight="bold" />;
    case "sync":
      return <ArrowsClockwiseIcon size={12} weight="bold" />;
  }
}

function derivePillState(input: {
  repository: Doc<"repositories">;
  sandboxModeStatus: SandboxModeStatus;
  jobs: Doc<"jobs">[];
  activeDeepAnalysisJob: Doc<"jobs"> | null;
  hasRemoteUpdates: boolean;
  isSyncing: boolean;
}): PillState {
  const intelligence = presentRepositoryIntelligenceSurface({
    importStatus: input.repository.importStatus,
    isSyncing: input.isSyncing,
    hasRemoteUpdates: input.hasRemoteUpdates,
  });
  const sandbox = presentSandboxSurface({
    sandboxModeStatus: input.sandboxModeStatus,
    sandbox: null,
  });

  const intelligenceFailed = intelligence.tone === "error";
  const sandboxFailed = sandbox.tone === "error";
  if (intelligenceFailed || sandboxFailed) {
    return {
      tone: "error",
      label: intelligenceFailed ? "Sync failed" : "Sandbox error",
      icon: "alert",
      detail: intelligenceFailed
        ? "Repository import failed. Open the panel to retry."
        : (input.sandboxModeStatus.message ?? "Sandbox is unavailable. Open the panel for details."),
    };
  }

  // Active beats warning — when something is running, the user wants progress
  // visibility more than they want a "consider syncing" nudge.
  const hasActiveJob = input.jobs.some(isUserRelevantActiveJob) || Boolean(input.activeDeepAnalysisJob);
  if (hasActiveJob || input.isSyncing) {
    return {
      tone: "active",
      label: input.activeDeepAnalysisJob ? "Analyzing…" : "Syncing…",
      icon: "spinner",
      detail: input.activeDeepAnalysisJob
        ? "A repository-wide deep analysis is running."
        : "Repository sync is running.",
    };
  }

  if (input.hasRemoteUpdates) {
    return {
      tone: "warning",
      label: "Updates ready",
      icon: "sync",
      detail: "New commits are available on the remote. Open the panel to sync.",
    };
  }

  if (sandbox.tone === "warning") {
    return {
      tone: "warning",
      label: "Sandbox idle",
      icon: "alert",
      detail: input.sandboxModeStatus.message ?? "Sandbox needs a refresh before live analysis.",
    };
  }

  return {
    tone: "idle",
    label: "Ready",
    icon: null,
    detail: "Repository is up to date. Open the panel for details.",
  };
}

function pillToneClassName(tone: PillTone) {
  switch (tone) {
    case "warning":
      return "border-amber-500 bg-card text-amber-700 hover:bg-muted dark:text-amber-400";
    case "active":
      return "border-primary bg-card text-primary hover:bg-muted";
    case "info":
      return "border-border bg-card text-foreground hover:bg-muted hover:border-foreground/30";
    case "error":
    case "idle":
    default:
      return "border-border bg-card text-muted-foreground hover:bg-muted hover:border-foreground/30 hover:text-foreground";
  }
}

/** Re-exported so callers don't have to import the operations tone enum. */
export type StatusPillTone = OperationTone;
