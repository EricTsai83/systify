import { useCallback, useEffect, useState } from "react";

const DEFAULT_SETTLE_MS = 160;

/**
 * `usePaginatedQuery` can briefly report an idle state between `LoadingMore`
 * and the final settled state. Keep the footer in its loading presentation
 * for one short settle window so exhausted pages disappear directly from
 * "Loading" instead of flashing back to "Next" / "Load more" first.
 */
export function useStableLoadMoreState({
  canLoadMore,
  isLoadingMore,
  settleMs = DEFAULT_SETTLE_MS,
}: {
  canLoadMore: boolean;
  isLoadingMore: boolean;
  settleMs?: number;
}): {
  canLoadMore: boolean;
  isLoadingMore: boolean;
  shouldRender: boolean;
  markLoadMoreStarted: () => void;
} {
  const [isSettlingAfterLoad, setIsSettlingAfterLoad] = useState(false);
  const markLoadMoreStarted = useCallback(() => {
    setIsSettlingAfterLoad(true);
  }, []);

  useEffect(() => {
    if (isLoadingMore) return;
    if (!isSettlingAfterLoad) return;
    const timer = window.setTimeout(() => {
      setIsSettlingAfterLoad(false);
    }, settleMs);
    return () => window.clearTimeout(timer);
  }, [isLoadingMore, isSettlingAfterLoad, settleMs]);

  const stableIsLoadingMore = isLoadingMore || isSettlingAfterLoad;
  return {
    canLoadMore,
    isLoadingMore: stableIsLoadingMore,
    shouldRender: canLoadMore || stableIsLoadingMore,
    markLoadMoreStarted,
  };
}
