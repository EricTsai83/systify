/* eslint-disable react-refresh/only-export-components */
import * as React from "react";
import { List } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { readString, writeString } from "@/lib/storage";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";

type SidebarContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  isMobile: boolean;
  isSheetMode: boolean;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);
const SIDEBAR_DOCKED_QUERY = "(min-width: 1280px)";

// Desktop sidebar is user-resizable from the right edge. The minimum is the
// designed content width — chrome (logo, switcher, thread rows) is laid out to
// stay legible at this size; below it the workspace switcher and thread titles
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

// Width is keyed so each surface can keep its own memory: Discuss/Lab share
// the slim default; Library Ask carries a full chat panel and passes a
// roomier key + default. Both still clamp to the configured min/max bounds.
function readStoredSidebarWidth(storageKey: string, fallback: number, maxWidth: number): number {
  const stored = readString(storageKey);
  if (!stored) return clampSidebarWidth(fallback, maxWidth);
  return clampSidebarWidth(Number.parseInt(stored, 10), maxWidth);
}

function persistSidebarWidth(storageKey: string, value: number): void {
  writeString(storageKey, String(value));
}

export function useSidebar() {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within a SidebarProvider");
  return ctx;
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
  const [open, setOpen] = React.useState(defaultOpen);
  const [openMobile, setOpenMobile] = React.useState(false);

  React.useEffect(() => {
    const mediaQuery = window.matchMedia(SIDEBAR_DOCKED_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDockedViewport(event.matches);
      if (event.matches) {
        setOpenMobile(false);
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const toggle = React.useCallback(() => {
    if (isSheetMode) setOpenMobile((v) => !v);
    else setOpen((v) => !v);
  }, [isSheetMode]);

  const value = React.useMemo<SidebarContextValue>(
    () => ({ open, setOpen, toggle, isMobile, isSheetMode, openMobile, setOpenMobile }),
    [open, toggle, isMobile, isSheetMode, openMobile],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function Sidebar({
  children,
  className,
  widthStorageKey = SIDEBAR_WIDTH_STORAGE_KEY,
  defaultWidth = SIDEBAR_MIN_WIDTH,
  maxWidth = SIDEBAR_MAX_WIDTH,
}: {
  children: React.ReactNode;
  className?: string;
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
  const { isSheetMode, open, openMobile, setOpenMobile } = useSidebar();
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
        const next = clampSidebarWidth(startWidth + (moveEvent.clientX - startX), maxWidth);
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
    [width, widthStorageKey, maxWidth],
  );

  const handleResizeKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 32 : 8;
      let next: number | null = null;
      if (event.key === "ArrowLeft") next = -step;
      else if (event.key === "ArrowRight") next = step;
      else if (event.key === "Home") {
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
        const updated = clampSidebarWidth(current + (next ?? 0), maxWidth);
        persistSidebarWidth(widthStorageKey, updated);
        return updated;
      });
    },
    [widthStorageKey, maxWidth],
  );

  if (isSheetMode) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          side="left"
          className={cn(
            "w-[min(18rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] bg-background p-0 data-[state=closed]:duration-200 data-[state=open]:duration-200",
            className,
          )}
          hideClose
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Repository list and settings</SheetDescription>
          <div className="flex h-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    // Width animates because the sidebar must reflow chat (push UX) — the
    // SidebarTrigger lives at TopBar's left edge, so an absolute-positioned
    // overlay would cover the close affordance. `will-change: width` promotes
    // the wrapper to its own compositor layer to keep the 200ms toggle cheap.
    // Transition is suppressed during active drag so the right edge tracks
    // the cursor 1:1; open/close toggles still animate.
    <aside
      data-state={open ? "open" : "closed"}
      style={{ width: open ? width : 0 }}
      className={cn(
        "relative hidden shrink-0 flex-col overflow-hidden border-r border-border bg-background motion-safe:duration-200 motion-safe:ease-out [will-change:width] xl:flex",
        isResizing ? "transition-none" : "motion-safe:transition-[width] motion-reduce:transition-none",
        open ? "" : "border-r-0",
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
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none data-[resizing=true]:bg-primary/60"
        />
      ) : null}
    </aside>
  );
}

export function SidebarHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex items-center gap-2 border-b border-border px-4 py-3", className)}>{children}</div>;
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

export function SidebarTrigger({ className }: { className?: string }) {
  const { toggle } = useSidebar();
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={toggle}
      aria-label="Toggle sidebar"
    >
      <List weight="bold" />
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
