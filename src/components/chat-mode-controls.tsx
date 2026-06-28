import { MagnifyingGlassIcon, PlusIcon, SidebarIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { useShouldShowChatModeControls } from "@/hooks/use-chat-mode-controls-visibility";
import { cn } from "@/lib/utils";

export function ChatModeControls({
  onSearchThreads,
  onNewThread,
  className,
  showSidebarToggle = true,
}: {
  onSearchThreads: () => void;
  onNewThread: () => void;
  className?: string;
  showSidebarToggle?: boolean;
}) {
  const { toggle } = useSidebar("left");
  const shouldShow = useShouldShowChatModeControls();

  if (!shouldShow) {
    return null;
  }

  return (
    <div
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-0.5 border border-border/60 bg-muted/25 p-0.5",
        className,
      )}
      aria-label="Chat navigation controls"
    >
      {showSidebarToggle ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:bg-background/80 hover:text-foreground"
          onClick={toggle}
          aria-label="Toggle sidebar"
        >
          <SidebarIcon size={16} weight="regular" />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:bg-background/80 hover:text-foreground"
        onClick={onSearchThreads}
        aria-label="Search threads"
      >
        <MagnifyingGlassIcon size={16} weight="regular" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:bg-background/80 hover:text-foreground"
        onClick={onNewThread}
        aria-label="New thread"
      >
        <PlusIcon size={16} weight="regular" />
      </Button>
    </div>
  );
}
