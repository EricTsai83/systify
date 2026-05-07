import { WarningCircleIcon, InfoIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

type NoticeTone = "info" | "warning" | "error";

const toneClasses: Record<NoticeTone, string> = {
  info: "border-border bg-muted/50 text-foreground",
  warning: "border-primary/30 bg-primary/10 text-foreground",
  error: "border-destructive/20 bg-destructive/5 text-destructive",
};

/**
 * Reusable notice surface used everywhere a one-line system message
 * needs a tone (info / warning / error), an optional primary CTA, and
 * — since Plan 14 — an optional dismiss control. The dismiss affordance
 * lives on `AppNotice` rather than each call site so notices remain
 * visually consistent across the app: a `×` in the corner means
 * "session-local dismiss" no matter which feature surfaces it.
 *
 * The dismiss button is **purely UI**; this component does not
 * remember dismissed state. The caller controls visibility through
 * its own state (e.g. the chat panel's `dismissedHintKeys` set), which
 * keeps this component a thin presentational layer and lets each
 * surface choose the right persistence model (session, thread, or
 * forever) independently.
 */
export function AppNotice({
  title,
  message,
  tone = "info",
  actionLabel,
  onAction,
  actionDisabled = false,
  onDismiss,
  dismissLabel = "Dismiss",
  className,
}: {
  title: string;
  message: string;
  tone?: NoticeTone;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  /**
   * When set, an `×` icon button renders alongside the primary action
   * (or alone, if no action is configured) and forwards the click here.
   * Keep the handler synchronous and side-effect-free beyond
   * "remember this notice was dismissed" — the parent owns the
   * persistence model.
   */
  onDismiss?: () => void;
  /**
   * Accessible label for the dismiss icon button. The `×` glyph itself
   * is `aria-hidden`, so this is what screen readers announce.
   * Defaults to "Dismiss"; override when a more specific verb fits
   * the surface (e.g. "Hide this suggestion").
   */
  dismissLabel?: string;
  className?: string;
}) {
  const Icon = tone === "error" || tone === "warning" ? WarningCircleIcon : InfoIcon;
  const isError = tone === "error";
  const hasAction = Boolean(actionLabel && onAction);
  const hasDismiss = Boolean(onDismiss);

  return (
    <Alert
      variant={isError ? "destructive" : "default"}
      className={cn("grid-cols-[auto_1fr]", toneClasses[tone], className)}
    >
      <Icon
        size={18}
        weight="fill"
        className={cn("mt-0.5 shrink-0", isError ? "text-destructive" : "text-muted-foreground")}
      />
      <div className="min-w-0">
        <AlertTitle className="text-sm">{title}</AlertTitle>
        <AlertDescription
          className={cn("mt-0.5 text-xs leading-5", isError ? "text-destructive" : "text-muted-foreground")}
        >
          {message}
        </AlertDescription>
      </div>
      {hasAction || hasDismiss ? (
        <AlertAction className="flex items-center gap-1">
          {hasAction ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              disabled={actionDisabled}
              onClick={onAction}
            >
              {actionLabel}
            </Button>
          ) : null}
          {hasDismiss ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={dismissLabel}
              data-testid="app-notice-dismiss"
              className="h-7 w-7"
              onClick={onDismiss}
            >
              <XIcon size={12} weight="bold" />
            </Button>
          ) : null}
        </AlertAction>
      ) : null}
    </Alert>
  );
}
