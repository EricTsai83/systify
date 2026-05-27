import { BookOpenIcon, FlaskIcon } from "@phosphor-icons/react";
import type { RepositoryModeDisabledReasonCode } from "../../convex/lib/chatEligibility";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Per-message grounding availability for the Discuss composer. Mirrors the
 * discriminated `AxisVerdict` / `SandboxGroundingVerdict` shape exposed by
 * `repositoryModeEligibility.evaluate`. The code field is constrained to
 * `RepositoryModeDisabledReasonCode | "loading"` so backend additions to
 * the disabled-reason enum surface as compile errors here (the `"loading"`
 * sentinel covers the placeholder verdict the bar renders while the
 * eligibility query is still in flight). The bar only branches on
 * `enabled`; specific disabled-code handling (e.g. "Generate System Design"
 * CTA on `library_no_artifact`) lives in the wiring layer that supplies
 * the `onOpenGenerateSystemDesign` callback.
 */
export type GroundingAxisLike =
  | { readonly enabled: true }
  | {
      readonly enabled: false;
      readonly code: RepositoryModeDisabledReasonCode | "loading";
      readonly message: string;
      readonly isActivatable?: boolean;
    };

export interface GroundingToggleBarProps {
  groundLibrary: boolean;
  groundSandbox: boolean;
  setGroundLibrary: (v: boolean) => void;
  setGroundSandbox: (v: boolean) => void;
  /**
   * Eligibility verdict from `repositoryModeEligibility.evaluate`. `null`
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
    enabled: false,
    code: "loading",
    message: "Loading grounding availability…",
  };
  const sandboxAxis: GroundingAxisLike = grounding?.sandbox ?? {
    enabled: false,
    code: "loading",
    message: "Loading grounding availability…",
  };

  const libraryEnabled = libraryAxis.enabled;
  const sandboxEnabled = sandboxAxis.enabled;
  const sandboxIsActivatable = !sandboxAxis.enabled && sandboxAxis.isActivatable === true;
  const libraryDisabledMessage = !libraryAxis.enabled ? libraryAxis.message : undefined;
  const sandboxDisabledMessage = !sandboxAxis.enabled ? sandboxAxis.message : undefined;
  const showGenerateCta =
    !libraryAxis.enabled &&
    libraryAxis.code === "library_no_artifact" &&
    typeof onOpenGenerateSystemDesign === "function";

  return (
    <div
      role="group"
      aria-label="Discuss grounding toggles"
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      <GroundingPill
        label="Library"
        icon={<BookOpenIcon size={14} weight={groundLibrary && libraryEnabled ? "fill" : "regular"} />}
        active={groundLibrary}
        available={libraryEnabled}
        reason={libraryDisabledMessage}
        onToggle={() => {
          if (!libraryEnabled) return;
          setGroundLibrary(!groundLibrary);
        }}
        testId="grounding-toggle-library"
      />
      <GroundingPill
        label="Sandbox"
        icon={<FlaskIcon size={14} weight={groundSandbox && sandboxEnabled ? "fill" : "regular"} />}
        active={groundSandbox}
        available={sandboxEnabled || sandboxIsActivatable}
        reason={sandboxDisabledMessage}
        suffix={sandboxIsActivatable ? "click to activate" : !sandboxEnabled ? undefined : "live source"}
        onToggle={() => {
          if (sandboxEnabled) {
            setGroundSandbox(!groundSandbox);
            return;
          }
          if (sandboxIsActivatable && onActivateSandbox) {
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
