"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefCallback } from "react";

/**
 * `rootMargin` for the top-sentinel IntersectionObserver. Firing
 * `loadMore` before the user reaches the absolute top keeps paginated
 * history loading continuous.
 */
const LOAD_OLDER_SENTINEL_ROOT_MARGIN = "320px 0px";

type Identifiable = { readonly _id: string };

export interface UseChatScrollArgs<TMessage extends Identifiable> {
  /**
   * Active thread the conversation is rendering. Resets prepend
   * detection so entrance animation state never leaks between threads.
   */
  threadId: string | null;
  /**
   * Ascending-creation-time rows in the transcript. Only the first id
   * and length are read so the hook can detect prepended history.
   */
  messages: readonly TMessage[] | undefined;
  /**
   * Accepted for the historical call sites. Streaming follow behavior
   * now belongs to MessageScrollerProvider's `autoScroll`.
   */
  streamingSignal?: string | null;
  /**
   * Whether the paginated query reports `CanLoadMore`.
   */
  canLoadOlder: boolean;
  /**
   * Trigger the paginated query's `loadMore`.
   */
  onLoadOlder: () => void;
}

export interface UseChatScrollResult {
  /** Attach to the MessageScroller viewport. */
  setScrollContainer: RefCallback<HTMLDivElement>;
  /** Kept for compatibility with the older ConversationContent API. */
  setContent: RefCallback<HTMLDivElement>;
  /** Attach above the first row while older history can load. */
  setSentinel: RefCallback<HTMLDivElement | null>;
  /** Legacy shape; MessageScroller owns scrollable state now. */
  isAtBottom: boolean;
  /** Legacy imperative fallback for call sites outside MessageScroller. */
  scrollToBottom: () => void;
  /**
   * Flips to `true` the first time an older page is prepended on the
   * current thread, and resets to `false` on thread change.
   */
  didPrepend: boolean;
}

/**
 * History-loader bridge for chat surfaces that use MessageScroller.
 *
 * MessageScroller owns opening position, stream following, anchoring,
 * and prepend scroll preservation. This hook only keeps Systify's
 * paginated-history sentinel and the existing `didPrepend` signal that
 * suppresses entrance animations after backfilling older rows.
 */
export function useChatScroll<TMessage extends Identifiable>({
  threadId,
  messages,
  canLoadOlder,
  onLoadOlder,
}: UseChatScrollArgs<TMessage>): UseChatScrollResult {
  const [scrollContainer, setScrollContainerEl] = useState<HTMLDivElement | null>(null);
  const [sentinelEl, setSentinelEl] = useState<HTMLDivElement | null>(null);
  const [didPrepend, setDidPrepend] = useState(false);

  const prevSnapshotRef = useRef<{ threadId: string | null; length: number; firstId: string | null } | null>(null);

  const setScrollContainer = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setScrollContainerEl(node);
  }, []);

  const setContent = useCallback<RefCallback<HTMLDivElement>>(() => {}, []);

  const setSentinel = useCallback<RefCallback<HTMLDivElement | null>>((node) => {
    setSentinelEl(node);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollContainer;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [scrollContainer]);

  useEffect(() => {
    setDidPrepend(false);
    prevSnapshotRef.current = {
      threadId,
      length: messages?.length ?? 0,
      firstId: messages?.[0]?._id ?? null,
    };
    // This reset is intentionally thread-keyed. MessageScroller handles
    // scroll position for message changes inside the same thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    const prev = prevSnapshotRef.current;
    const length = messages?.length ?? 0;
    const firstId = messages?.[0]?._id ?? null;

    if (!prev || prev.threadId !== threadId) {
      prevSnapshotRef.current = { threadId, length, firstId };
      return;
    }

    if (length === prev.length && firstId === prev.firstId) {
      return;
    }

    if (length > prev.length && firstId !== prev.firstId) {
      setDidPrepend(true);
    }

    prevSnapshotRef.current = { threadId, length, firstId };
    // Same exhaustive-deps caveat as the reset effect: this effect is
    // keyed on the stable scroll-relevant snapshot, not the array object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages?.length, messages?.[0]?._id, threadId]);

  const onLoadOlderRef = useRef(onLoadOlder);
  useEffect(() => {
    onLoadOlderRef.current = onLoadOlder;
  }, [onLoadOlder]);

  useEffect(() => {
    const node = sentinelEl;
    const container = scrollContainer;
    if (!node || !container || !canLoadOlder) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        onLoadOlderRef.current();
      },
      { root: container, rootMargin: LOAD_OLDER_SENTINEL_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [sentinelEl, scrollContainer, canLoadOlder]);

  return useMemo(
    () => ({
      setScrollContainer,
      setContent,
      setSentinel,
      isAtBottom: true,
      scrollToBottom,
      didPrepend,
    }),
    [setScrollContainer, setContent, setSentinel, scrollToBottom, didPrepend],
  );
}
