import { BookOpenIcon, FlaskIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Per-message grounding availability for the Discuss composer. Mirrors the
 * `WorkspaceModeEligibility.grounding` shape from `workspaceModeEligibility.ts`
 * but with the structured-reason `code` left as a free string — the bar
 * itself only branches on `available` and rounds the tooltip text through;
 * specific disabled-code handling (e.g. "Generate System Design" CTA on
 * `library_no_artifact`) lives in the wiring layer that supplies the
 * `onOpenGenerateSystemDesign` callback.
 */
export interface GroundingAxisLike {
  available: boolean;
  reason: {
    code: string;
    message: string;
  } | null;
  isActivatable?: boolean;
}

export interface GroundingToggleBarProps {
  groundLibrary: boolean;
  groundSandbox: boolean;
  setGroundLibrary: (v: boolean) => void;
  setGroundSandbox: (v: boolean) => void;
  /**
   * Eligibility verdict from `workspaceModeEligibility.evaluate`. `null`
   * or `undefined` while the query loads — the bar renders both toggles
   * disabled until the verdict lands so a flash of clickable toggles
   * cannot fire an immediately-rejected send mutation.
   */
  grounding:
    | {
        library: GroundingAxisLike;
        sandbox: GroundingAxisLike;
      }
    | null
    | undefined;
  /**
   * Fires when the user clicks the Sandbox toggle while it is in the
   * "activatable" sub-state (no sandbox provisioned yet / expired /
   * failed). The caller wires this to `requestSandboxActivation` and
   * leaves the toggle off until the provisioning lifecycle resolves.
   */
  onActivateSandbox?: () => void;
  /**
   * Fires when the user clicks the "Generate System Design" CTA inside
   * the Library toggle's disabled tooltip. The caller opens the
   * generate-system-design dialog.
   */
  onOpenGenerateSystemDesign?: () => void;
  /** Hides the whole bar when true (e.g. on Library Mode where it does not apply). */
  hidden?: boolean;
  className?: string;
}

/**
 * Per-message grounding toggle bar for Discuss Mode.
 *
 * Two independent pill toggles — Library (artifact RAG) and Sandbox
 * (live source tools) — that compose freely. When both axes are off the
 * reply is unbound LLM training-only chat; either or both can be on for
 * a grounded reply with the matching citation contract.
 *
 * Disabled toggles render with their tooltip-quality reason inline so a
 * glance is enough to tell *why* the option is locked. The Library
 * "no artifact" sub-state additionally renders a "Generate System
 * Design" CTA below the toggle; the Sandbox activatable sub-state
 * flips the toggle's click handler from "set state" to "activate sandbox".
 */
export function GroundingToggleBar({
  groundLibrary,
  groundSandbox,
  setGroundLibrary,
  setGroundSandbox,
  grounding,
  onActivateSandbox,
  onOpenGenerateSystemDesign,
  hidden = false,
  className,
}: GroundingToggleBarProps) {
  if (hidden) {
    return null;
  }

  const libraryAxis: GroundingAxisLike = grounding?.library ?? {
    available: false,
    reason: { code: "loading", message: "Loading grounding availability…" },
  };
  const sandboxAxis: GroundingAxisLike = grounding?.sandbox ?? {
    available: false,
    reason: { code: "loading", message: "Loading grounding availability…" },
  };

  const libraryDisabledReason = !libraryAxis.available ? libraryAxis.reason : null;
  const sandboxDisabledReason = !sandboxAxis.available ? sandboxAxis.reason : null;
  const showGenerateCta =
    libraryDisabledReason?.code === "library_no_artifact" && typeof onOpenGenerateSystemDesign === "function";

  return (
    <div
      role="group"
      aria-label="Discuss grounding toggles"
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      <GroundingPill
        label="Library"
        icon={<BookOpenIcon size={14} weight={groundLibrary && libraryAxis.available ? "fill" : "regular"} />}
        active={groundLibrary}
        available={libraryAxis.available}
        reason={libraryDisabledReason?.message}
        onToggle={() => {
          if (!libraryAxis.available) return;
          setGroundLibrary(!groundLibrary);
        }}
        testId="grounding-toggle-library"
      />
      <GroundingPill
        label="Sandbox"
        icon={<FlaskIcon size={14} weight={groundSandbox && sandboxAxis.available ? "fill" : "regular"} />}
        active={groundSandbox}
        available={sandboxAxis.available || sandboxAxis.isActivatable === true}
        reason={sandboxDisabledReason?.message}
        suffix={
          sandboxAxis.isActivatable === true && !sandboxAxis.available
            ? "click to activate"
            : !sandboxAxis.available
              ? undefined
              : "live source"
        }
        onToggle={() => {
          if (sandboxAxis.available) {
            setGroundSandbox(!groundSandbox);
            return;
          }
          if (sandboxAxis.isActivatable === true && onActivateSandbox) {
            onActivateSandbox();
          }
        }}
        testId="grounding-toggle-sandbox"
      />
      {showGenerateCta ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => onOpenGenerateSystemDesign?.()}
          data-testid="grounding-generate-cta"
        >
          Generate System Design
        </Button>
      ) : null}
    </div>
  );
}

type GroundingPillProps = {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  available: boolean;
  reason?: string;
  suffix?: string;
  onToggle: () => void;
  testId: string;
};

function GroundingPill({ label, icon, active, available, reason, suffix, onToggle, testId }: GroundingPillProps) {
  const title = available ? (suffix ? `${label} grounding (${suffix})` : `${label} grounding`) : reason;
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-disabled={!available}
      onClick={onToggle}
      title={title}
      data-testid={testId}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2 text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        active && available
          ? "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
          : available
            ? "border-border bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            : "cursor-not-allowed border-dashed border-border bg-muted/30 text-muted-foreground/70",
      )}
    >
      {icon}
      <span>{label}</span>
      {suffix && available ? (
        <span aria-hidden="true" className="text-[10px] text-muted-foreground/80">
          · {suffix}
        </span>
      ) : null}
    </button>
  );
}
