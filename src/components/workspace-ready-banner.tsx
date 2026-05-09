import { CheckCircleIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useLocalStorageBoolean } from "@/hooks/use-persisted-state";
import { cn } from "@/lib/utils";
import type { ArtifactId } from "@/lib/types";

const WELCOMED_STORAGE_KEY_PREFIX = "systify.workspace.welcomed.";

type WorkspaceReadyBannerProps = {
  repository: Doc<"repositories">;
  latestDeepAnalysis: Doc<"artifacts"> | null;
  onView: (artifactId: ArtifactId) => void;
  className?: string;
};

/**
 * "Your workspace is ready" handoff banner — fires once per repository
 * the first time a `deep_analysis` artifact lands. Replaces the
 * silent-completion behaviour where the user had to notice a status
 * card change inside the (possibly closed) StatusPanel to learn that
 * setup was done.
 *
 * Dismissal is stored per-repository in localStorage so the banner
 * doesn't keep returning across reloads. We deliberately do NOT key on
 * the artifact id: a future "Refresh analysis" creates a new artifact
 * but is *not* a workspace-ready event — the user already knows the
 * workspace works. Per-repo keying matches the user's mental model of
 * "I've onboarded this repo".
 *
 * Per the design discussion, this is a visual banner only — we do not
 * write a system message into the thread, so the chat history stays a
 * pure record of user/assistant turns.
 */
export function WorkspaceReadyBanner({ repository, latestDeepAnalysis, onView, className }: WorkspaceReadyBannerProps) {
  const [isDismissed, setIsDismissed, isHydrated] = useLocalStorageBoolean(
    `${WELCOMED_STORAGE_KEY_PREFIX}${repository._id}`,
    false,
  );

  // Wait for hydration before deciding to show — without this, the
  // banner would flash in for one frame on every reload before
  // localStorage tells us "already dismissed".
  if (!isHydrated || isDismissed || !latestDeepAnalysis) {
    return null;
  }

  const handleView = () => {
    onView(latestDeepAnalysis._id);
    setIsDismissed(true);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="workspace-ready-banner"
      className={cn(
        "flex shrink-0 items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2.5 md:px-6",
        className,
      )}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/20 text-primary">
        <CheckCircleIcon size={14} weight="bold" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold leading-tight">Your workspace is ready</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          A reusable analysis has been generated. Conversations can now cite it.
        </p>
      </div>
      <Button type="button" variant="default" size="sm" onClick={handleView} className="shrink-0">
        View analysis
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setIsDismissed(true)}
        aria-label="Dismiss workspace ready banner"
        className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
      >
        Dismiss
      </Button>
    </div>
  );
}
