import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "framer-motion";
import { BookOpenIcon, ChatCircleIcon, FlaskIcon } from "@phosphor-icons/react";
import { discussPath, labPath, libraryPath } from "@/route-paths";
import type { ServiceMode, WorkspaceId } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ServiceModeDisabledLike {
  message: string;
}

interface ServiceModeAvailability {
  availableServiceModes: ReadonlyArray<ServiceMode>;
  disabledReasons: Partial<Record<ServiceMode, ServiceModeDisabledLike>>;
}

const SERVICE_MODE_ENTRIES: ReadonlyArray<{
  value: ServiceMode;
  label: string;
  icon: typeof ChatCircleIcon;
}> = [
  { value: "discuss", label: "Discuss", icon: ChatCircleIcon },
  { value: "library", label: "Library", icon: BookOpenIcon },
  { value: "lab", label: "Lab", icon: FlaskIcon },
];

// 220ms ease-in-out-quart — the "morph beat" for cell width + pill scale.
// ease-in-out reads as "slowly shrinking / slowly growing" because both ends
// decelerate; pairs the old-cell-shrink and new-cell-grow as one symmetric
// motion. No spring bounce — width animations with bounce feel rubbery, not
// "gradual".
const MORPH_DURATION = 0.22;
const MORPH: Transition = { duration: MORPH_DURATION, ease: [0.77, 0, 0.175, 1] };
// Label entry waits for the pill + cell to finish growing, then slides in.
// ease-out-expo gives a settle-in feel after the heavier morph.
const LABEL_IN: Transition = { delay: MORPH_DURATION, duration: 0.1, ease: [0.16, 1, 0.3, 1] };
// Label exit clears quickly so it doesn't fight the narrowing cell — the cell
// finishes its 220ms morph already empty of content.
const LABEL_OUT: Transition = { duration: 0.12, ease: [0.77, 0, 0.175, 1] };

/**
 * Segmented toggle that pivots the workspace shell between the three top-level
 * service modes. Lives in the sidebar between the header and the "+ New thread"
 * button so the user's current mode is right where they are about to act.
 *
 * Design beat — only the active mode wears its label; the other two collapse
 * to icon-only chips. On switch, the OLD active cell + pill + label
 * collectively collapse back into an icon in-place (no traveling), and the
 * NEW cell's lone icon unfolds into the full framed button. Two independent
 * shrinking/growing motions running at the same instant (no shared `layoutId`)
 * — the discrete "this contracts here, that expands there" reads as switching
 * rather than a sliding pane. Within the new cell, the label is staggered to
 * appear AFTER the frame has finished growing, so the sequence reads "small
 * icon → grows into a framed button → name appears next to it".
 *
 * No hover tooltip: in a sidebar the user touches dozens of times per session
 * a hover-fired tooltip becomes visual noise. The active cell's own label
 * teaches the icon→mode mapping after one switch; screen reader users get
 * the mode name through each button's `aria-label`. The trade-off is that the
 * unlock-hint for disabled modes lives elsewhere (the workspace setup banner
 * + empty state already explain "attach a repo to unlock Library/Lab"), so
 * losing it here is redundancy reduction, not information loss.
 *
 * Motion stack (top to bottom):
 *   - `whileTap` scale on the button — instant tactile reply on press (100ms).
 *   - `AnimatePresence` pill — scale 0.5↔1 + opacity, 220ms ease-in-out.
 *   - `layout` on each button — cells resize via FLIP, 220ms ease-in-out.
 *   - `AnimatePresence` label — entry delayed 220ms (after frame settles),
 *     exit is fast (~120ms) so it clears before the narrowing cell clips it.
 *
 * All motion is gated by `useReducedMotion`: under `prefers-reduced-motion`
 * the transitions collapse to 0-duration, state still toggles correctly, no
 * `whileTap`, no entry/exit offsets.
 *
 * The component never persists state of its own — clicking a mode navigates
 * to the canonical URL (`/w/:wid/discuss`, `/w/:wid/library`, or
 * `/w/:wid/lab`), and `serviceMode` is computed by `useServiceMode` from that
 * URL. Disabled modes render for keyboard accessibility; clicking one is a no-op.
 *
 * Cost-transparency invariant: clicking `Library` NEVER provisions a sandbox.
 * This is a property of the URL the click navigates to (the Library shell
 * never starts a Lab session); the switcher itself just routes — but the
 * invariant should not be hidden behind a layer of indirection.
 */
export function ServiceModeSwitcher({
  workspaceId,
  serviceMode,
  availability,
  className,
}: {
  workspaceId: WorkspaceId | null;
  serviceMode: ServiceMode;
  availability: ServiceModeAvailability | null | undefined;
  className?: string;
}) {
  const navigate = useNavigate();
  const shouldReduceMotion = useReducedMotion();

  const handleSelect = (value: ServiceMode, isAvailable: boolean) => {
    if (!workspaceId) return;
    if (value === serviceMode) return;
    if (!isAvailable) return;
    if (value === "discuss") {
      void navigate(discussPath(workspaceId));
    } else if (value === "library") {
      void navigate(libraryPath(workspaceId));
    } else if (value === "lab") {
      void navigate(labPath(workspaceId));
    }
  };

  // Reduced-motion: collapse the layout morph to zero so the cell snaps to its
  // new width on the same frame. Pill and label exits/entries get their own
  // zero-duration overrides at the call site.
  const layoutTransition: Transition = shouldReduceMotion ? { duration: 0 } : MORPH;

  return (
    <div className={cn("border-b border-border px-2 py-2", className)}>
      <div
        role="group"
        aria-label="Service mode"
        className="flex h-9 gap-1 rounded-md border border-border bg-muted/40 p-1"
      >
        {SERVICE_MODE_ENTRIES.map((entry) => {
          const isActive = serviceMode === entry.value;
          const isAvailable = availability ? availability.availableServiceModes.includes(entry.value) : true;
          const Icon = entry.icon;

          return (
            <motion.button
              key={entry.value}
              type="button"
              aria-pressed={isActive}
              aria-label={entry.label}
              aria-disabled={!isAvailable}
              // Don't use the native `disabled` attribute — handleSelect
              // already short-circuits on unavailable, and keeping the button
              // focusable means keyboard users can still Tab through every
              // mode (consistent reading order, no surprise skips).
              onClick={() => handleSelect(entry.value, isAvailable)}
              layout
              transition={layoutTransition}
              whileTap={isAvailable && !shouldReduceMotion ? { scale: 0.96, transition: { duration: 0.1 } } : undefined}
              className={cn(
                "relative flex h-full items-center justify-center overflow-hidden rounded-sm outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                isActive
                  ? "flex-1 gap-1.5 px-2 text-foreground"
                  : "w-7 flex-none text-muted-foreground hover:bg-background/60 hover:text-foreground",
                !isAvailable && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
              )}
            >
              {/*
               * Per-cell pill — when `isActive` flips, the pill in the old
               * cell exits in-place (scale 1→0.5 + fade) and a fresh pill in
               * the new cell enters from scale 0.5. Replaces the previous
               * shared `layoutId` pill so the visual reads as "this collapses,
               * that unfolds" instead of "a single background slides across".
               */}
              <AnimatePresence initial={false}>
                {isActive ? (
                  <motion.span
                    key="pill"
                    aria-hidden="true"
                    initial={shouldReduceMotion ? false : { scale: 0.5, opacity: 0 }}
                    animate={{
                      scale: 1,
                      opacity: 1,
                      transition: shouldReduceMotion ? { duration: 0 } : MORPH,
                    }}
                    exit={{
                      scale: shouldReduceMotion ? 1 : 0.5,
                      opacity: 0,
                      transition: shouldReduceMotion ? { duration: 0 } : MORPH,
                    }}
                    className="absolute inset-0 rounded-sm bg-background shadow-sm"
                  />
                ) : null}
              </AnimatePresence>
              <Icon size={14} weight={isActive ? "fill" : "regular"} className="relative z-10 shrink-0" />
              <AnimatePresence initial={false}>
                {isActive ? (
                  <motion.span
                    key="label"
                    initial={shouldReduceMotion ? false : { opacity: 0, x: -4 }}
                    animate={{
                      opacity: 1,
                      x: 0,
                      transition: shouldReduceMotion ? { duration: 0 } : LABEL_IN,
                    }}
                    exit={{
                      opacity: 0,
                      transition: shouldReduceMotion ? { duration: 0 } : LABEL_OUT,
                    }}
                    className="relative z-10 truncate text-xs font-medium"
                  >
                    {entry.label}
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
