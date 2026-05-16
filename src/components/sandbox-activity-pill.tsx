import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CircleIcon, CircleNotchIcon, CircleHalfIcon } from "@phosphor-icons/react";
import type { RepositoryId } from "@/lib/types";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

/**
 * Chat-side status pill for the repository's live source. Three visual
 * states map to the activation lifecycle the backend exposes:
 *
 *   - idle           → "Live source inactive  [Activate]"
 *   - activating     → "Activating live source… {progress}%"
 *   - ready          → "Live source ready  (stops in X min)"
 *   - expiring_soon  → same shape as ready, amber colouring
 *
 * Hidden when the thread has no repository attached or when the viewer
 * isn't in a sandbox-tooled mode (chat-panel decides whether to mount
 * us). Clicking Activate enqueues a `sandbox_activation` job through
 * `requestSandboxActivation`.
 */
export function SandboxActivityPill({ repositoryId }: { repositoryId: RepositoryId }) {
  const status = useQuery(api.repositories.getSandboxActivityStatus, { repositoryId });
  const requestActivation = useMutation(api.repositories.requestSandboxActivation);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, activate] = useAsyncCallback(async () => {
    setErrorMessage(null);
    try {
      await requestActivation({ repositoryId });
    } catch (err) {
      setErrorMessage(toUserErrorMessage(err, "Couldn't start live source. Try again."));
    }
  });

  // Tick once a minute so "stops in N min" stays current while the chat
  // panel is open. `Date.now()` is impure for React's purity rules, so
  // the live clock lives in state and an effect drives the interval.
  // The setter is only called on the timer callback, never as a sync
  // setState within the effect body.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    // Kick off the first tick on the next macrotask so render stays pure.
    const initial = setTimeout(() => setNowMs(Date.now()), 0);
    return () => {
      clearInterval(id);
      clearTimeout(initial);
    };
  }, []);

  if (status === undefined || status === null) {
    return null;
  }

  if (status.kind === "idle") {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-1.5 text-xs">
          <CircleIcon size={12} className="shrink-0 text-muted-foreground" weight="regular" />
          <span className="min-w-0 flex-1 text-muted-foreground">Live source inactive</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void activate();
            }}
            disabled={isSubmitting}
          >
            {isSubmitting ? "Starting…" : "Activate"}
          </Button>
        </div>
        {errorMessage ? <p className="px-1 text-[11px] text-destructive">{errorMessage}</p> : null}
      </div>
    );
  }

  if (status.kind === "activating") {
    const progressPct = Math.round((status.activeJob?.progress ?? 0) * 100);
    const stage = status.activeJob?.stage ?? "Activating live source…";
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/50 bg-blue-500/10 px-3 py-1.5 text-xs">
        <CircleNotchIcon size={12} weight="bold" className="shrink-0 animate-spin text-blue-500" />
        <span className="min-w-0 flex-1 truncate text-blue-700 dark:text-blue-300">{stage}</span>
        <span className="shrink-0 tabular-nums text-[11px] text-blue-700/80 dark:text-blue-300/80">{progressPct}%</span>
      </div>
    );
  }

  const remainingMs = nowMs === null ? 0 : (status.sandbox?.ttlExpiresAt ?? 0) - nowMs;
  const remainingMinutes = Math.max(0, Math.floor(remainingMs / 60_000));
  const isExpiringSoon = status.kind === "expiring_soon";
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs",
        isExpiringSoon
          ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}
    >
      <CircleHalfIcon
        size={12}
        weight="fill"
        className={cn("shrink-0", isExpiringSoon ? "text-amber-500" : "text-emerald-500")}
      />
      <span className="min-w-0 flex-1">Live source ready</span>
      <span className="shrink-0 text-[11px]">
        {remainingMinutes > 0 ? `stops in ${remainingMinutes} min` : "stops shortly"}
      </span>
    </div>
  );
}
