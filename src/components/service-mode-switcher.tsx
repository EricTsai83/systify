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

// iOS-style critically-damped spring. `duration` + `bounce` is Framer's
// "Apple form" — easier to reason about than stiffness/damping. Subtle bounce
// (0.18) reads as "settle" rather than "playful".
const SPRING: Transition = { type: "spring", duration: 0.35, bounce: 0.18 };
// Label entry curve — ease-out-expo. Fast start, soft tail, fits an entering
// element. Delayed so the cell has expanded before the label arrives.
const LABEL_IN: Transition = { duration: 0.18, ease: [0.16, 1, 0.3, 1], delay: 0.1 };
const LABEL_OUT: Transition = { duration: 0.14, ease: [0.7, 0, 0.84, 0] };

/**
 * Segmented toggle that pivots the workspace shell between the three top-level
 * service modes. Lives in the sidebar between the header and the "+ New thread"
 * button so the user's current mode is right where they are about to act.
 *
 * Design beat — only the active mode wears its label; the other two collapse
 * to icon-only chips. The active background is a single shared element
 * (`layoutId="service-mode-active-pill"`): when the user picks a new mode the
 * pill physically slides from the old cell to the new one rather than
 * cross-fading. Combined with FLIP-driven cell resize (`layout` prop) and a
 * staggered label entry, the morph reads as a coherent gesture instead of an
 * uncoordinated shimmy.
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
 *   - `whileTap` scale on the button — instant tactile reply on press.
 *   - `layoutId` pill — the headline move; slides between active cells.
 *   - `layout` on each button — cells resize via FLIP (transform-only).
 *   - `AnimatePresence` label — fades + slides in/out with a 100ms delay so
 *     it arrives after the cell has cleared room for it.
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

  // Reduced-motion: collapse every transition to zero. Don't disable layout
  // entirely — the cell widths still need to settle on their new sizes; we
  // just want the change to happen on the same frame.
  const layoutTransition: Transition = shouldReduceMotion ? { duration: 0 } : SPRING;

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
              whileTap={isAvailable && !shouldReduceMotion ? { scale: 0.96 } : undefined}
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
               * The sliding pill — a single shared element that animates
               * between active cells via `layoutId`. When the active mode
               * changes the pill in the old cell unmounts and the one in
               * the new cell mounts; Framer Motion matches them by id and
               * runs a FLIP transform between the two positions. Net
               * effect: the white card "slides" instead of cross-fading.
               */}
              {isActive ? (
                <motion.span
                  layoutId="service-mode-active-pill"
                  transition={layoutTransition}
                  aria-hidden="true"
                  className="absolute inset-0 rounded-sm bg-background shadow-sm"
                />
              ) : null}
              <Icon size={14} weight={isActive ? "fill" : "regular"} className="relative z-10 shrink-0" />
              <AnimatePresence initial={false}>
                {isActive ? (
                  <motion.span
                    key="label"
                    // Per-state `transition` so entry and exit can use
                    // different curves: entry is ease-out-expo with a
                    // 100ms delay (lets the cell expand first), exit is
                    // a faster ease-in (exits ~20% faster than entries).
                    initial={shouldReduceMotion ? false : { opacity: 0, x: -4 }}
                    animate={{
                      opacity: 1,
                      x: 0,
                      transition: shouldReduceMotion ? { duration: 0 } : LABEL_IN,
                    }}
                    exit={{
                      opacity: 0,
                      x: shouldReduceMotion ? 0 : -4,
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
