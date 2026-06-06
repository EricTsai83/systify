// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useStableLoadMoreState } from "./use-stable-load-more-state";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useStableLoadMoreState", () => {
  test("keeps loading visible briefly after a requested load settles with no more pages", () => {
    const { result, rerender } = renderHook(
      ({ canLoadMore, isLoadingMore }) =>
        useStableLoadMoreState({
          canLoadMore,
          isLoadingMore,
          settleMs: 100,
        }),
      {
        initialProps: { canLoadMore: true, isLoadingMore: false },
      },
    );

    act(() => {
      result.current.markLoadMoreStarted();
    });
    rerender({ canLoadMore: true, isLoadingMore: true });

    expect(result.current).toMatchObject({
      canLoadMore: true,
      isLoadingMore: true,
      shouldRender: true,
    });

    rerender({ canLoadMore: false, isLoadingMore: false });

    expect(result.current).toMatchObject({
      canLoadMore: false,
      isLoadingMore: true,
      shouldRender: true,
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current).toMatchObject({
      canLoadMore: false,
      isLoadingMore: false,
      shouldRender: false,
    });
  });

  test("shows the idle control after the settle window when more pages remain", () => {
    const { result, rerender } = renderHook(
      ({ canLoadMore, isLoadingMore }) =>
        useStableLoadMoreState({
          canLoadMore,
          isLoadingMore,
          settleMs: 100,
        }),
      {
        initialProps: { canLoadMore: true, isLoadingMore: false },
      },
    );

    act(() => {
      result.current.markLoadMoreStarted();
    });
    rerender({ canLoadMore: true, isLoadingMore: true });
    rerender({ canLoadMore: true, isLoadingMore: false });

    expect(result.current.isLoadingMore).toBe(true);
    expect(result.current.shouldRender).toBe(true);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current).toMatchObject({
      canLoadMore: true,
      isLoadingMore: false,
      shouldRender: true,
    });
  });
});
