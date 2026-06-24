"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefCallback } from "react";

/**
 * Distance from the bottom (in pixels) within which the conversation is
 * still considered "stuck to the bottom" — the threshold matches the
 * prior `use-stick-to-bottom` UX so users who are visibly near the
 * latest message keep auto-scrolling on append / streaming delta.
 */
const STICK_TO_BOTTOM_THRESHOLD_PX = 70;

/**
 * `rootMargin` for the top-sentinel IntersectionObserver. Firing
 * `loadMore` ~320px above the visible top makes infinite scroll feel
 * continuous instead of bumpy — the older page is in flight before the
 * user runs out of content to read. Mirrors `src/pages/archive.tsx`.
 */
const LOAD_OLDER_SENTINEL_ROOT_MARGIN = "320px 0px";

type Identifiable = { readonly _id: string };

export interface UseChatScrollArgs<TMessage extends Identifiable> {
  /**
   * Active thread the conversation is rendering. The hook resets every
   * piece of in-memory state (anchor tracking, prepend detection,
   * `didPrepend`) on change so the next thread paints from a clean
   * baseline — no stale scrollTop or prepend state bleeding between
   * threads.
   */
  threadId: string | null;
  /**
   * Ascending-creation-time messages to render. The hook reads
   * `messages[0]._id` and `messages.length` to detect prepend versus
   * append; nothing else about the array shape is required.
   */
  messages: readonly TMessage[] | undefined;
  /**
   * Live streaming-reply tail. When the in-flight assistant content
   * grows, the hook treats it as an append and keeps the view stuck to
   * the bottom (if the user was already there). Pass `null` outside of
   * a streaming window.
   */
  streamingSignal?: string | null;
  /**
   * Whether the paginated query reports `CanLoadMore`. The hook only
   * mounts the sentinel observer while this is true; flipping to
   * `false` (Exhausted) tears the observer down so a steady-state
   * conversation pays no observer cost.
   */
  canLoadOlder: boolean;
  /**
   * Trigger the paginated query's `loadMore`. The hook captures the
   * current `scrollHeight` / `scrollTop` immediately before invoking so
   * the anchor restore can run against a stable snapshot.
   */
  onLoadOlder: () => void;
}

export interface UseChatScrollResult {
  /** Attach to the scrollable container (the element with overflow). */
  setScrollContainer: RefCallback<HTMLDivElement>;
  /** Attach to the inner content wrapper inside the scroll container. */
  setContent: RefCallback<HTMLDivElement>;
  /**
   * Attach above the first message. When the sentinel becomes visible
   * the hook fires `onLoadOlder`. Returns a no-op when `canLoadOlder`
   * is false (the observer is disposed) — the consuming component can
   * unconditionally render the sentinel without an extra `canLoadOlder`
   * gate.
   */
  setSentinel: RefCallback<HTMLDivElement | null>;
  /** True when the viewport bottom is within the stick-to-bottom threshold. */
  isAtBottom: boolean;
  /** Manually scroll the viewport to the bottom (used by the scroll button). */
  scrollToBottom: () => void;
  /**
   * Flips to `true` the first time an older page is prepended on the
   * current thread, and resets to `false` on thread change. A
   * dependent parent (e.g. the chat panel's entrance animation gate)
   * reads this directly and re-renders when the state flips.
   */
  didPrepend: boolean;
}

/**
 * Custom scroll controller for the chat conversation. Replaces
 * `use-stick-to-bottom`, which assumed append-only growth and would
 * fight any prepended content (the hook used `ResizeObserver` to
 * re-anchor the bottom on every height change). The chat panel needs
 * **both** append-anchored sticking and prepend-anchored anchor
 * preservation:
 *
 *  - **Append** (a new message or streaming delta): if the user was
 *    near the bottom, follow the new content down. Otherwise stay put
 *    so a long stream doesn't yank the user out of the part they were
 *    reading.
 *  - **Prepend** (an older page arrived): keep the user's eye on the
 *    same message by setting `scrollTop = newScrollHeight − prevScrollHeight + prevScrollTop`.
 *    Real DOM nodes have real measured heights, so this is a one-shot
 *    arithmetic restore — no measurement race, no virtualizer
 *    trampoline. (This is the same arithmetic Slack / GitHub / Linear
 *    use for backfill scrolling.)
 *
 * The hook also owns the load-older sentinel observer, prefers-
 * reduced-motion handling, and `threadId`-keyed reset, so the
 * `Conversation` ai-element can stay thin and presentational.
 */
export function useChatScroll<TMessage extends Identifiable>({
  threadId,
  messages,
  streamingSignal = null,
  canLoadOlder,
  onLoadOlder,
}: UseChatScrollArgs<TMessage>): UseChatScrollResult {
  // The hook deliberately holds raw element refs instead of using
  // `useRef`-of-Element so it can react to (re-)mounts via ref
  // callbacks. The `RefCallback`s wrap a state setter so attaching the
  // container triggers a re-render that wires up listeners against the
  // freshly-mounted DOM node.
  const [scrollContainer, setScrollContainerEl] = useState<HTMLDivElement | null>(null);
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const [sentinelEl, setSentinelEl] = useState<HTMLDivElement | null>(null);

  const setScrollContainer = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setScrollContainerEl(node);
  }, []);
  const setContent = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setContentEl(node);
  }, []);
  const setSentinel = useCallback<RefCallback<HTMLDivElement | null>>((node) => {
    setSentinelEl(node);
  }, []);

  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  // Syncing ref during render is intentional: provides synchronous access to the latest isAtBottom
  // for layout effects/callbacks, which run before state updates propagate. Safe because the ref
  // is only read in effects/callbacks (not during render), and this sync pattern avoids stale
  // closures in the scroll/resize observers. See react-hooks/rules-of-hooks lint.
  isAtBottomRef.current = isAtBottom;

  const [didPrepend, setDidPrepend] = useState(false);

  // Tracks the most recent (length, firstId) snapshot of the messages
  // array so the layout-effect below can classify changes as
  // prepend / append / replace.
  const prevSnapshotRef = useRef<{ threadId: string | null; length: number; firstId: string | null } | null>(null);
  // Pre-load snapshot of (scrollHeight, scrollTop) captured by the
  // sentinel just before `onLoadOlder` fires, so the layout effect can
  // restore the visual anchor against a known baseline.
  const pendingAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const resizeFollowFrameRef = useRef<number | null>(null);

  // Track `prefers-reduced-motion` reactively so users who flip the
  // OS setting mid-session immediately get non-animated scrolls.
  const prefersReducedMotion = usePrefersReducedMotion();

  const scrollToBottom = useCallback(() => {
    const el = scrollContainer;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }, [scrollContainer, prefersReducedMotion]);

  /**
   * `isAtBottom` detection. Subscribes to the container's `scroll`
   * event and writes the latest classification into both the state
   * (drives the scroll button) and the ref (read synchronously by the
   * layout effect for append-time auto-scroll decisions, since state
   * updates lag the effect by one tick).
   */
  useEffect(() => {
    const el = scrollContainer;
    if (!el) return;
    const update = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distance <= STICK_TO_BOTTOM_THRESHOLD_PX;
      isAtBottomRef.current = atBottom;
      setIsAtBottom((prev) => (prev === atBottom ? prev : atBottom));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      el.removeEventListener("scroll", update);
    };
  }, [scrollContainer]);

  /**
   * Thread-keyed reset + initial snap-to-bottom. Runs synchronously
   * before paint so a thread switch never flashes the new thread at
   * the wrong scroll position. The reset clears `didPrepend` and the
   * pending-anchor snapshot — anchor restore must not fire against a
   * snapshot captured against a prior thread's DOM heights.
   */
  useLayoutEffect(() => {
    const el = scrollContainer;
    if (!el) return;
    setDidPrepend(false);
    pendingAnchorRef.current = null;
    prevSnapshotRef.current = {
      threadId,
      length: messages?.length ?? 0,
      firstId: messages?.[0]?._id ?? null,
    };
    // `scrollTop = scrollHeight` instead of `scrollTo({ behavior: "smooth" })`
    // because this is the first-paint hop on a new thread — animating
    // would be visual noise across a route change. Stays "instant"
    // even when prefers-reduced-motion is off.
    el.scrollTop = el.scrollHeight;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    // The eslint deps-exhaustive lint would push us to depend on
    // `messages`, but we *only* want this effect to fire on thread
    // change. Message-length growth inside the same thread is handled
    // by the second layout effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, scrollContainer]);

  /**
   * Classify each messages-array change and react accordingly.
   *
   *  - **Prepend** (length grew, `firstId` changed): restore the
   *    captured anchor so the user keeps reading the same message.
   *    Flip `didPrepend` so a parent can skip prepend-incompatible
   *    entrance animations.
   *  - **Append** (length grew, `firstId` unchanged): scroll to the
   *    bottom *only if* the user was already there. Otherwise leave
   *    them parked — the scroll button surfaces so they can opt in.
   *  - **Replace** (length stayed the same but `firstId` changed):
   *    treat as a thread-internal reset; clear anchor state but don't
   *    auto-scroll.
   */
  useLayoutEffect(() => {
    const el = scrollContainer;
    if (!el) return;

    const prev = prevSnapshotRef.current;
    const length = messages?.length ?? 0;
    const firstId = messages?.[0]?._id ?? null;

    if (!prev || prev.threadId !== threadId) {
      // First settled snapshot for this thread, or a thread change the
      // reset effect hasn't yet committed. Either way: don't classify;
      // the reset effect is the authority on first-paint scroll position.
      prevSnapshotRef.current = { threadId, length, firstId };
      return;
    }

    if (length === prev.length && firstId === prev.firstId) {
      return;
    }

    const grew = length > prev.length;
    const firstIdChanged = firstId !== prev.firstId;

    if (grew && firstIdChanged) {
      // Prepend: restore the captured visual anchor.
      const pending = pendingAnchorRef.current;
      if (pending) {
        const nextScrollTop = el.scrollHeight - pending.scrollHeight + pending.scrollTop;
        el.scrollTop = nextScrollTop;
        pendingAnchorRef.current = null;
      }
      setDidPrepend(true);
    } else if (grew && !firstIdChanged) {
      // Append: follow the new content down only if the user was
      // already near the bottom.
      if (isAtBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    }

    prevSnapshotRef.current = { threadId, length, firstId };
    // Same exhaustive-deps caveat as the reset effect — we drive the
    // classification on the (length, firstId) signal we already pulled
    // off `messages`. Depending on `messages` itself would re-fire on
    // every reactive ping that doesn't change those fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages?.length, messages?.[0]?._id, threadId, scrollContainer]);

  /**
   * Streaming-delta auto-scroll. Mirrors the append branch above but
   * keyed on the live in-flight content rather than the persisted
   * message list — a streaming reply rewrites the last bubble's body
   * many times per second without changing `messages.length`, so the
   * messages effect never fires.
   */
  useLayoutEffect(() => {
    if (streamingSignal === null) return;
    const el = scrollContainer;
    if (!el) return;
    if (!isAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [streamingSignal, scrollContainer]);

  /**
   * Top-sentinel `IntersectionObserver`. Disposes when `canLoadOlder`
   * flips to false (Exhausted) so a fully-loaded conversation pays
   * zero observer cost. Mirrors `src/pages/archive.tsx`'s stable-
   * onLoadMoreRef pattern: the observer is keyed only on the
   * sentinel + canLoadOlder, while the callback is held in a ref so
   * the observer never re-installs.
   */
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
        // Capture the pre-prepend anchor *before* requesting the new
        // page. The classification effect above reads this snapshot to
        // place the user back on the same message after the prepend
        // commits. Without the snapshot the restore arithmetic has no
        // baseline and the view would jump to the top.
        pendingAnchorRef.current = {
          scrollHeight: container.scrollHeight,
          scrollTop: container.scrollTop,
        };
        onLoadOlderRef.current();
      },
      { root: container, rootMargin: LOAD_OLDER_SENTINEL_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [sentinelEl, scrollContainer, canLoadOlder]);

  // Track the inner content element for resize-driven re-anchor. When
  // streamdown or a fenced code block lazy-loads (Shiki / Mermaid /
  // KaTeX), the content height can grow without a corresponding
  // `messages` change. If the user was at the bottom, follow the new
  // height down.
  useEffect(() => {
    const el = scrollContainer;
    const inner = contentEl;
    if (!el || !inner) return;
    if (typeof ResizeObserver === "undefined") return;
    let lastScrollHeight = inner.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (!isAtBottomRef.current || resizeFollowFrameRef.current !== null) {
        return;
      }
      resizeFollowFrameRef.current = requestAnimationFrame(() => {
        resizeFollowFrameRef.current = null;
        if (!isAtBottomRef.current) return;
        const nextScrollHeight = inner.scrollHeight;
        if (nextScrollHeight === lastScrollHeight) return;
        lastScrollHeight = nextScrollHeight;
        el.scrollTop = el.scrollHeight;
      });
    });
    observer.observe(inner);
    return () => {
      if (resizeFollowFrameRef.current !== null) {
        cancelAnimationFrame(resizeFollowFrameRef.current);
        resizeFollowFrameRef.current = null;
      }
      observer.disconnect();
    };
  }, [scrollContainer, contentEl]);

  return useMemo(
    () => ({
      setScrollContainer,
      setContent,
      setSentinel,
      isAtBottom,
      scrollToBottom,
      didPrepend,
    }),
    [setScrollContainer, setContent, setSentinel, isAtBottom, scrollToBottom, didPrepend],
  );
}

/**
 * Tracks the user's `prefers-reduced-motion` setting reactively.
 * Returns `false` when window/`matchMedia` is unavailable (SSR /
 * minimal JSDOM) so callers default to motion-friendly behavior.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => {
      setReduced(event.matches);
    };
    mql.addEventListener("change", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
    };
  }, []);
  return reduced;
}
