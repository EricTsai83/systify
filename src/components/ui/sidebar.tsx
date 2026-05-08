/* eslint-disable react-refresh/only-export-components */
import * as React from "react";
import { List } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
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

export function Sidebar({ children, className }: { children: React.ReactNode; className?: string }) {
  const { isSheetMode, open, openMobile, setOpenMobile } = useSidebar();

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
    <aside
      data-state={open ? "open" : "closed"}
      className={cn(
        "hidden shrink-0 flex-col overflow-hidden border-r border-border bg-background transition-[width] duration-200 ease-out [will-change:width] xl:flex",
        open ? "w-72" : "w-0 border-r-0",
        className,
      )}
    >
      <div className="flex h-full w-72 flex-col">{children}</div>
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
