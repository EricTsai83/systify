import { Fragment } from "react";
import { BookOpenIcon, FlaskIcon } from "@phosphor-icons/react";
import type { RepositoryModeDisabledReasonCode } from "../../convex/lib/chatEligibility";
import { Button } from "@/components/ui/button";
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
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
      readonly code: RepositoryModeDisabledReasonCode | "feature_not_included" | "loading";
      readonly message: string;
      readonly isActivatable?: boolean;
    };

export type GroundingAxisId = "library" | "sandbox";

export type GroundingAxisControl = {
  id: GroundingAxisId;
  label: string;
  active: boolean;
  verdict: GroundingAxisLike;
  onActiveChange: (next: boolean) => void;
};

export interface GroundingToggleBarProps {
  axes: readonly GroundingAxisControl[];
  /**
   * Fires when the user clicks the "Generate System Design" CTA inside
   * the Library toggle's disabled tooltip. The caller opens the
   * generate-system-design dialog.
   */
  onOpenGenerateSystemDesign?: () => void;
  generateDisabledReason?: string;
  /** Hides the whole bar when true (e.g. on Library Mode where it does not apply). */
  hidden?: boolean;
  className?: string;
}

const LOADING_GROUNDING_VERDICT: GroundingAxisLike = {
  enabled: false,
  code: "loading",
  message: "Loading grounding availability…",
};

// eslint-disable-next-line react-refresh/only-export-components
export function createDiscussGroundingAxes(input: {
  groundLibrary: boolean;
  groundSandbox: boolean;
  setGroundLibrary: (next: boolean) => void;
  setGroundSandbox: (next: boolean) => void;
  grounding:
    | {
        library: GroundingAxisLike;
        sandbox: GroundingAxisLike;
      }
    | null
    | undefined;
}): readonly GroundingAxisControl[] {
  return [
    {
      id: "library",
      label: "Library",
      active: input.groundLibrary,
      verdict: input.grounding?.library ?? LOADING_GROUNDING_VERDICT,
      onActiveChange: input.setGroundLibrary,
    },
    {
      id: "sandbox",
      label: "Sandbox",
      active: input.groundSandbox,
      verdict: input.grounding?.sandbox ?? LOADING_GROUNDING_VERDICT,
      onActiveChange: input.setGroundSandbox,
    },
  ];
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
 * Design" CTA below the toggle; recoverable Sandbox liveness states
 * stay selectable and prepare on send.
 */
export function GroundingToggleBar({
  axes,
  onOpenGenerateSystemDesign,
  generateDisabledReason,
  hidden = false,
  className,
}: GroundingToggleBarProps) {
  if (hidden) {
    return null;
  }

  const groundingItems = axes.flatMap((axis) => {
    const pill = <GroundingAxisPill key={axis.id} axis={axis} />;
    const showGenerateCta =
      axis.id === "library" &&
      !axis.verdict.enabled &&
      axis.verdict.code === "library_no_artifact" &&
      typeof onOpenGenerateSystemDesign === "function";
    if (!showGenerateCta) {
      return [pill];
    }
    return [
      pill,
      <Button
        key="generate"
        type="button"
        variant="link"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={generateDisabledReason !== undefined}
        title={generateDisabledReason}
        onClick={() => onOpenGenerateSystemDesign?.()}
        data-testid="grounding-generate-cta"
      >
        {REPOSITORY_GUIDE_COPY.generateAction}
      </Button>,
    ];
  });

  return (
    <div
      role="group"
      aria-label="Discuss grounding toggles"
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {groundingItems.map((item, index) => (
        <Fragment key={item.key ?? index}>
          {index > 0 ? <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" /> : null}
          {item}
        </Fragment>
      ))}
    </div>
  );
}

function GroundingAxisPill({ axis }: { axis: GroundingAxisControl }) {
  const enabled = axis.verdict.enabled;
  const activatable = !axis.verdict.enabled && axis.verdict.isActivatable === true;
  const available = enabled || (axis.id === "sandbox" && activatable);
  const reason = !axis.verdict.enabled ? axis.verdict.message : undefined;
  const suffix =
    axis.id === "sandbox" ? (activatable ? "prepares on send" : enabled ? "live source" : undefined) : undefined;
  const Icon = axis.id === "library" ? BookOpenIcon : FlaskIcon;
  const iconFilled = axis.active && available;

  return (
    <GroundingPill
      label={axis.label}
      icon={<Icon size={14} weight={iconFilled ? "fill" : "regular"} />}
      active={axis.active}
      available={available}
      reason={reason}
      suffix={suffix}
      onToggle={() => {
        if (available) {
          axis.onActiveChange(!axis.active);
        }
      }}
      testId={`grounding-toggle-${axis.id}`}
    />
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
        "inline-flex h-7 items-center gap-1.5 border px-2 text-xs font-medium transition-colors",
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
