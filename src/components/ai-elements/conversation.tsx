"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import type { UseChatScrollResult } from "./use-chat-scroll";

/**
 * Context for the conversation's scroll controller. `Conversation` is
 * the only producer; `ConversationContent` and `ConversationScrollButton`
 * read from it so the consuming surface can keep the existing
 * `<Conversation><ConversationContent>…</ConversationContent>
 * <ConversationScrollButton /></Conversation>` shape without threading
 * a half-dozen props through every layer.
 *
 * The context is non-null inside the tree; consumers that read it
 * outside a `Conversation` get a runtime error with a clear message
 * (no silent fallbacks that paper over a wiring bug).
 */
const ConversationScrollContext = createContext<UseChatScrollResult | null>(null);

function useConversationScroll(): UseChatScrollResult {
  const ctx = useContext(ConversationScrollContext);
  if (!ctx) {
    throw new Error("Conversation subcomponents must be rendered inside <Conversation>.");
  }
  return ctx;
}

export type ConversationProps = ComponentProps<"div"> & {
  /**
   * Scroll controller from `useChatScroll`. The parent owns the hook
   * call so it can read `didPrependRef` synchronously alongside its
   * own render-time state (e.g. the entrance-animation skip in
   * `chat-panel.tsx`). The conversation just adopts the refs and
   * publishes the bag through context.
   */
  scroll: UseChatScrollResult;
};

export const Conversation = ({ className, scroll, children, ...props }: ConversationProps) => {
  const { setScrollContainer } = scroll;
  return (
    <ConversationScrollContext.Provider value={scroll}>
      <div className={cn("relative flex min-h-0 flex-1 flex-col", className)} {...props}>
        <div
          ref={setScrollContainer}
          className="flex-1 overflow-y-auto"
          // `role="log"` so screen readers treat the scrollable region as
          // a log of conversation turns. `aria-live` is NOT set here —
          // the in-flight bubble's content slot is the only place we
          // want announcements; pushing live-region semantics onto the
          // whole list would re-announce every prior turn on every
          // subscription tick.
          role="log"
        >
          {children}
        </div>
      </div>
    </ConversationScrollContext.Provider>
  );
};

export type ConversationContentProps = ComponentProps<"div"> & {
  /**
   * Whether the paginated query reports `CanLoadMore`. The top
   * sentinel only mounts while true so an Exhausted conversation pays
   * no observer cost.
   */
  showLoadOlderSentinel?: boolean;
};

export const ConversationContent = ({
  className,
  showLoadOlderSentinel = false,
  children,
  ...props
}: ConversationContentProps) => {
  const { setContent, setSentinel } = useConversationScroll();
  return (
    <div ref={setContent} className={cn("flex flex-col gap-8 p-4", className)} {...props}>
      {showLoadOlderSentinel ? (
        // Sentinel is intentionally tiny + visually empty. The
        // IntersectionObserver inside `useChatScroll` fires
        // `onLoadOlder` once the sentinel enters the (container-
        // relative) viewport with a 320px top margin — older history
        // is in flight before the user runs out of content to scroll
        // up through. The wrapper preserves the `flex-col gap-8`
        // rhythm so the first message doesn't snap closer to the top
        // when the sentinel mounts.
        <div
          ref={setSentinel}
          data-testid="conversation-load-older-sentinel"
          aria-hidden="true"
          className="h-px w-full"
        />
      ) : null}
      {children}
    </div>
  );
};

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn("flex size-full flex-col items-center justify-center gap-3 p-8 text-center", className)}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({ className, ...props }: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useConversationScroll();
  if (isAtBottom) return null;
  return (
    <Button
      className={cn("absolute bottom-2 left-[50%] translate-x-[-50%]", className)}
      onClick={scrollToBottom}
      size="xs"
      type="button"
      variant="secondary"
      {...props}
    >
      Scroll to bottom
    </Button>
  );
};
