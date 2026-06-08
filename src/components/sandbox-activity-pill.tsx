import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { CircleIcon, CircleHalfIcon } from "@phosphor-icons/react";
import type { RepositoryId } from "@/lib/types";
import { api } from "../../convex/_generated/api";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * Chat-side status pill for the repository's live source. Three visual
 * states map to the lazy preparation lifecycle the backend exposes:
 *
 *   - idle           → "Live source will prepare on send"
 *   - preparing      → "Preparing live source… {progress}%"
 *   - ready          → "Live source ready  (stops in X min)"
 *   - expiring_soon  → same shape as ready, amber colouring
 *
 * Hidden when the thread has no repository attached or when the viewer
 * isn't in a sandbox-tooled mode (chat-panel decides whether to mount us).
 */
export function SandboxActivityPill({ repositoryId }: { repositoryId: RepositoryId }) {
  const status = useQuery(api.repositories.getSandboxActivityStatus, { repositoryId });

  // Tick once a minute so "stops in N min" stays current while the chat
  // panel is open. `Date.now()` is impure for React's purity rules, so
  // the live clock lives in state and an effect drives the interval.
  // The setter is only called on the timer callback, never as a sync
  // setState within the effect body.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      clearInterval(id);
    };
  }, []);

  if (status === undefined || status === null) {
    return null;
  }

  // All states share the same outer flex-col + same inner pill row
  // height (`min-h-7`), so transitions across the lifecycle
  // (idle → preparing → ready) don't change the bubble's height and
  // shove the message list around.
  const pillRowClass = "flex min-h-7 items-center gap-2 rounded-md border px-3 py-1.5 text-xs";

  if (status.kind === "idle") {
    return (
      <div className="flex flex-col gap-1">
        <div className={cn(pillRowClass, "border-border/50 bg-muted/30")}>
          <CircleIcon size={12} className="shrink-0 text-muted-foreground" weight="regular" />
          <span className="min-w-0 flex-1 text-muted-foreground">Live source will prepare on send</span>
        </div>
      </div>
    );
  }

  if (status.kind === "preparing") {
    const progressPct = status.activeJob ? Math.round(status.activeJob.progress * 100) : null;
    const stage = status.activeJob?.stage ?? "Preparing live source…";
    return (
      <div className="flex flex-col gap-1">
        <div className={cn(pillRowClass, "border-border/50 bg-blue-500/10")}>
          <Spinner size={12} className="shrink-0 text-blue-500" />
          <span className="min-w-0 flex-1 truncate text-blue-700 dark:text-blue-300">{stage}</span>
          {progressPct !== null ? (
            <span className="shrink-0 tabular-nums text-[11px] text-blue-700/80 dark:text-blue-300/80">
              {progressPct}%
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  const remainingMs = nowMs === null ? 0 : (status.sandbox?.ttlExpiresAt ?? 0) - nowMs;
  const remainingMinutes = Math.max(0, Math.floor(remainingMs / 60_000));
  const isExpiringSoon = status.kind === "expiring_soon";
  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          pillRowClass,
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
    </div>
  );
}
