/* eslint-disable react-refresh/only-export-components */
import * as React from "react";
import { useLocation } from "react-router-dom";
import { ChatCircleText, List } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { readString, writeString } from "@/lib/storage";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";

type SidebarSideState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
};

type SidebarContextValue = {
  isMobile: boolean;
  isSheetMode: boolean;
  left: SidebarSideState;
  right: SidebarSideState;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);
const SIDEBAR_DOCKED_QUERY = "(min-width: 1280px)";

// Desktop sidebar is user-resizable from the right edge. The minimum is the
// designed content width — chrome (logo, switcher, thread rows) is laid out to
// stay legible at this size; below it the repository switcher and thread titles
// start clipping. The shared maximum keeps the sidebar from eating more than a
// reasonable share of the viewport at 1280px (the smallest docked breakpoint);
// Library Ask carries a full chat surface and can override `maxWidth` to a
// roomier ceiling.
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_WIDTH_STORAGE_KEY = "systify.sidebar.width";

function clampSidebarWidth(value: number, maxWidth: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_MIN_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxWidth, Math.round(value)));
}

// Width is keyed so each surface can keep its own memory: Discuss
// uses the slim default; Library Ask carries a full chat panel and passes a
// roomier key + default. Both still clamp to the configured min/max bounds.
function readStoredSidebarWidth(storageKey: string, fallback: number, maxWidth: number): number {
  const stored = readString(storageKey);
  if (!stored) return clampSidebarWidth(fallback, maxWidth);
  return clampSidebarWidth(Number.parseInt(stored, 10), maxWidth);
}

function persistSidebarWidth(storageKey: string, value: number): void {
  writeString(storageKey, String(value));
}

export function useSidebar(): SidebarSideState;
export function useSidebar(side: "left" | "right"): SidebarSideState;
export function useSidebar(side: "left" | "right" = "left"): SidebarSideState {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within a SidebarProvider");
  return side === "right" ? ctx.right : ctx.left;
}

export function useSidebarLayout() {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebarLayout must be used within a SidebarProvider");
  return {
    isMobile: ctx.isMobile,
    isSheetMode: ctx.isSheetMode,
  };
}

export function SidebarProvider({
  defaultOpen = true,
  children,
}: {
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const isMobile = useIsMobile();
  const [isDockedViewport, setIsDockedViewport] = React.useState<boolean>(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return window.matchMedia(SIDEBAR_DOCKED_QUERY).matches;
  });
  const isSheetMode = isMobile || !isDockedViewport;
  const [openLeft, setOpenLeft] = React.useState(defaultOpen);
  const [openMobileLeft, setOpenMobileLeft] = React.useState(false);
  const [openRight, setOpenRight] = React.useState(defaultOpen);
  const [openMobileRight, setOpenMobileRight] = React.useState(false);

  React.useEffect(() => {
    const mediaQuery = window.matchMedia(SIDEBAR_DOCKED_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDockedViewport(event.matches);
      if (event.matches) {
        setOpenMobileLeft(false);
        setOpenMobileRight(false);
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Mobile-Sheet cleanup on every URL change. The provider is mounted in
  // ProtectedLayout so it survives route transitions and this effect can
  // actually fire on the destination page. Two things happen here:
  //
  //   1. `setOpenMobile(false)` — collapse the Sheet state so that when the
  //      user navigates back to a sidebar-mounting route, the Sheet is closed.
  //
  //   2. Reset `body.style.pointerEvents`. Radix's DismissableLayer (used by
  //      both the Sheet and the ProfileCard DropdownMenu inside it) tracks a
  //      module-level `originalBodyPointerEvents` snapshot. When the Sheet
  //      opens it captures `""` → sets body to `"none"`; the nested Dropdown
  //      then captures `"none"` → sets body to `"none"` again. If the user
  //      taps a Dropdown link that points at a route which doesn't render the
  //      Sheet (e.g. /archive, /resources), both layers unmount in the same
  //      tick and the "last layer to clean up" restores body to the stale
  //      `"none"` snapshot — leaving the destination page covered by an
  //      invisible click shield. Resetting it here on every navigation
  //      unsticks the page; nothing else in this app touches
  //      `body.style.pointerEvents`, so the reset is safe.
  const { pathname } = useLocation();
  React.useEffect(() => {
    setOpenMobileLeft(false);
    setOpenMobileRight(false);
    if (typeof document !== "undefined") {
      document.body.style.pointerEvents = "";
    }
  }, [pathname]);

  const toggleLeft = React.useCallback(() => {
    if (isSheetMode) setOpenMobileLeft((v) => !v);
    else setOpenLeft((v) => !v);
  }, [isSheetMode]);

  const toggleRight = React.useCallback(() => {
    if (isSheetMode) setOpenMobileRight((v) => !v);
    else setOpenRight((v) => !v);
  }, [isSheetMode]);

  const value = React.useMemo<SidebarContextValue>(
    () => ({
      isMobile,
      isSheetMode,
      left: {
        open: openLeft,
        setOpen: setOpenLeft,
        toggle: toggleLeft,
        openMobile: openMobileLeft,
        setOpenMobile: setOpenMobileLeft,
      },
      right: {
        open: openRight,
        setOpen: setOpenRight,
        toggle: toggleRight,
        openMobile: openMobileRight,
        setOpenMobile: setOpenMobileRight,
      },
    }),
    [openLeft, toggleLeft, openMobileLeft, openRight, toggleRight, openMobileRight, isMobile, isSheetMode],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function Sidebar({
  children,
  className,
  side = "left",
  widthStorageKey = SIDEBAR_WIDTH_STORAGE_KEY,
  defaultWidth = SIDEBAR_MIN_WIDTH,
  maxWidth = SIDEBAR_MAX_WIDTH,
}: {
  children: React.ReactNode;
  className?: string;
  /** Which side of the viewport this sidebar attaches to. */
  side?: "left" | "right";
  /** localStorage key for the resizable width. Defaults to the shared key. */
  widthStorageKey?: string;
  /** Width to use when nothing is stored yet. Clamped to the min/max bounds. */
  defaultWidth?: number;
  /**
   * Upper bound for resizing on this sidebar instance. Defaults to the
   * shared cap; Library Ask raises it because its content slot is a full
   * chat surface and benefits from extra horizontal room.
   */
  maxWidth?: number;
}) {
  const { isSheetMode } = React.useContext(SidebarContext) ?? { isSheetMode: false };
  const sideState = useSidebar(side);
  const { open, openMobile, setOpenMobile } = sideState;
  const [width, setWidth] = React.useState<number>(() =>
    readStoredSidebarWidth(widthStorageKey, defaultWidth, maxWidth),
  );
  const [isResizing, setIsResizing] = React.useState(false);

  React.useEffect(() => {
    setWidth(readStoredSidebarWidth(widthStorageKey, defaultWidth, maxWidth));
  }, [widthStorageKey, defaultWidth, maxWidth]);

  // Restore body cursor/select if the component unmounts mid-drag so the page
  // doesn't end up stuck with a col-resize cursor or text selection disabled.
  React.useEffect(() => {
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  const handleResizePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();

      const startX = event.clientX;
      const startWidth = width;
      setIsResizing(true);
      // Anchor cursor + suppress selection globally so the user can drag past
      // the 4px hit strip without the cursor flipping back to default over
      // chat content.
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handleMove = (moveEvent: PointerEvent) => {
        // Right sidebar: dragging left (negative delta) grows the sidebar
        const delta = side === "right" ? -(moveEvent.clientX - startX) : moveEvent.clientX - startX;
        const next = clampSidebarWidth(startWidth + delta, maxWidth);
        setWidth(next);
      };

      const handleEnd = () => {
        setIsResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleEnd);
        window.removeEventListener("pointercancel", handleEnd);
        setWidth((current) => {
          persistSidebarWidth(widthStorageKey, current);
          return current;
        });
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleEnd);
      window.addEventListener("pointercancel", handleEnd);
    },
    [width, widthStorageKey, maxWidth, side],
  );

  const handleResizeKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 32 : 8;
      let next: number | null = null;
      // Right sidebar: ArrowLeft grows, ArrowRight shrinks (opposite of left)
      if (side === "right") {
        if (event.key === "ArrowLeft") next = step;
        else if (event.key === "ArrowRight") next = -step;
      } else {
        if (event.key === "ArrowLeft") next = -step;
        else if (event.key === "ArrowRight") next = step;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setWidth(() => {
          persistSidebarWidth(widthStorageKey, SIDEBAR_MIN_WIDTH);
          return SIDEBAR_MIN_WIDTH;
        });
        return;
      } else if (event.key === "End") {
        event.preventDefault();
        setWidth(() => {
          const clamped = clampSidebarWidth(maxWidth, maxWidth);
          persistSidebarWidth(widthStorageKey, clamped);
          return clamped;
        });
        return;
      }
      if (next === null) return;
      event.preventDefault();
      setWidth((current) => {
        const updated = clampSidebarWidth(current + next, maxWidth);
        persistSidebarWidth(widthStorageKey, updated);
        return updated;
      });
    },
    [widthStorageKey, maxWidth, side],
  );

  const sheetSide = side === "right" ? "right" : "left";

  if (isSheetMode) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          side={sheetSide}
          className={cn(
            "top-[var(--systify-demo-banner-height,0px)] h-[calc(100dvh-var(--systify-demo-banner-height,0px))] w-[min(18rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] bg-background p-0 data-[state=closed]:duration-200 data-[state=open]:duration-200",
            className,
          )}
          overlayClassName="top-[var(--systify-demo-banner-height,0px)]"
          hideClose
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Repository list and settings</SheetDescription>
          <div className="flex h-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  const isLeftSide = side === "left";
  const borderClass = isLeftSide ? "border-r" : "border-l";
  const resizeEdgeClass = isLeftSide ? "right-0" : "left-0";

  return (
    // Width animates because the sidebar must reflow chat (push UX) — the
    // SidebarTrigger lives at TopBar's left edge, so an absolute-positioned
    // overlay would cover the close affordance. `will-change: width` promotes
    // the wrapper to its own compositor layer to keep the 200ms toggle cheap.
    // Transition is suppressed during active drag so the right edge tracks
    // the cursor 1:1; open/close toggles still animate.
    <aside
      data-state={open ? "open" : "closed"}
      data-side={side}
      style={{ width: open ? width : 0, [isLeftSide ? "left" : "right"]: 0 }}
      className={cn(
        "relative hidden shrink-0 flex-col overflow-hidden bg-background motion-safe:duration-200 motion-safe:ease-out will-change-[width] xl:flex",
        borderClass,
        "border-border",
        isResizing ? "transition-none" : "motion-safe:transition-[width] motion-reduce:transition-none",
        open ? "" : isLeftSide ? "border-r-0" : "border-l-0",
        className,
      )}
    >
      <div className="flex h-full flex-col" style={{ width }}>
        {children}
      </div>
      {open ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={maxWidth}
          aria-valuenow={width}
          tabIndex={0}
          data-resizing={isResizing ? "true" : "false"}
          onPointerDown={handleResizePointerDown}
          onKeyDown={handleResizeKeyDown}
          className={cn(
            "absolute top-0 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none data-[resizing=true]:bg-primary/60",
            resizeEdgeClass,
          )}
        />
      ) : null}
    </aside>
  );
}

export function SidebarHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-12 shrink-0 items-center gap-2 border-b border-border px-4", className)}>{children}</div>
  );
}

export function SidebarContent({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}>{children}</div>;
}

export function SidebarFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-3 border-t border-border px-4 py-4", className)}>{children}</div>;
}

export function SidebarSection({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-2 px-3 py-3", className)}>{children}</div>;
}

export function SidebarTrigger({ className, side = "left" }: { className?: string; side?: "left" | "right" }) {
  const { toggle } = useSidebar(side);
  // Distinct glyphs per side so the two triggers in the Library header read as
  // separate controls at a glance. Left carries the repository nav (threads /
  // tree) — the hamburger is the universal "menu" affordance. Right carries
  // the Library Ask chat surface, so the chat bubble points the user at what
  // the toggle reveals.
  const TriggerIcon = side === "right" ? ChatCircleText : List;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={toggle}
      aria-label={`Toggle ${side} sidebar`}
    >
      <TriggerIcon weight="bold" />
    </Button>
  );
}

export function SidebarMenuButton({
  children,
  className,
  selected,
  "aria-current": ariaCurrent,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-auto w-full cursor-pointer justify-start gap-2 rounded-none border px-3 py-2 text-left transition-colors",
        selected
          ? "border-transparent border-l-2 border-l-primary bg-muted text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        className,
      )}
      aria-current={ariaCurrent ?? (selected ? "page" : undefined)}
      {...props}
    >
      {children}
    </Button>
  );
}

export function SidebarInset({ children }: { children: React.ReactNode }) {
  return <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</main>;
}
