// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useLibraryAskTabs } from "./use-library-ask-tabs";
import type { ThreadId, WorkspaceId } from "@/lib/types";

const workspaceId = "ws_asktabs" as WorkspaceId;
const t1 = "thread_1" as ThreadId;
const t2 = "thread_2" as ThreadId;
const t3 = "thread_3" as ThreadId;

// This test runner ships only a partial `localStorage` (no `clear()`); swap in
// a memory-backed store so the hook's first-paint cache is deterministic.
// Mirrors `use-library-tabs.test.ts`.
const localStorageBackingStore = new Map<string, string>();

function ensureTestLocalStorage() {
  if (typeof window.localStorage.clear !== "function") {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return localStorageBackingStore.size;
        },
        clear: () => localStorageBackingStore.clear(),
        getItem: (key: string) => localStorageBackingStore.get(key) ?? null,
        key: (index: number) => Array.from(localStorageBackingStore.keys())[index] ?? null,
        removeItem: (key: string) => {
          localStorageBackingStore.delete(key);
        },
        setItem: (key: string, value: string) => {
          localStorageBackingStore.set(key, String(value));
        },
      } satisfies Storage,
    });
  }
}

beforeEach(() => {
  ensureTestLocalStorage();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useLibraryAskTabs", () => {
  test("ensureOpen appends a tab and is idempotent on an unchanged entry", () => {
    const { result } = renderHook(() => useLibraryAskTabs(workspaceId));

    act(() => {
      result.current.ensureOpen({ id: t1, title: "First" });
    });
    expect(result.current.openThreads).toEqual([{ id: t1, title: "First" }]);

    const before = result.current.openThreads;
    act(() => {
      result.current.ensureOpen({ id: t1, title: "First" });
    });
    // Same id + title → same array reference, no churn.
    expect(result.current.openThreads).toBe(before);
  });

  test("ensureOpen refreshes a cached title in place (rename), keeping position", () => {
    const { result } = renderHook(() => useLibraryAskTabs(workspaceId));

    act(() => {
      result.current.ensureOpen({ id: t1, title: "First" });
      result.current.ensureOpen({ id: t2, title: "Second" });
    });
    act(() => {
      result.current.ensureOpen({ id: t1, title: "First (renamed)" });
    });

    expect(result.current.openThreads).toEqual([
      { id: t1, title: "First (renamed)" },
      { id: t2, title: "Second" },
    ]);
  });

  test("closeTab removes the tab and returns the right neighbour as next-active", () => {
    const { result } = renderHook(() => useLibraryAskTabs(workspaceId));
    act(() => {
      result.current.ensureOpen({ id: t1, title: "First" });
      result.current.ensureOpen({ id: t2, title: "Second" });
      result.current.ensureOpen({ id: t3, title: "Third" });
    });

    let next: ThreadId | null = null;
    act(() => {
      next = result.current.closeTab(t2);
    });
    expect(next).toBe(t3);
    expect(result.current.openThreads.map((t) => t.id)).toEqual([t1, t3]);
  });

  test("closeTab on the rightmost tab falls back to the left neighbour, then null when empty", () => {
    const { result } = renderHook(() => useLibraryAskTabs(workspaceId));
    act(() => {
      result.current.ensureOpen({ id: t1, title: "First" });
      result.current.ensureOpen({ id: t2, title: "Second" });
    });

    let next: ThreadId | null = null;
    act(() => {
      next = result.current.closeTab(t2);
    });
    expect(next).toBe(t1);

    act(() => {
      next = result.current.closeTab(t1);
    });
    expect(next).toBeNull();
    expect(result.current.openThreads).toEqual([]);
  });

  test("persists the open set to localStorage and restores it on a fresh mount", () => {
    const first = renderHook(() => useLibraryAskTabs(workspaceId));
    act(() => {
      first.result.current.ensureOpen({ id: t1, title: "First" });
      first.result.current.ensureOpen({ id: t2, title: "Second" });
    });
    first.unmount();

    const second = renderHook(() => useLibraryAskTabs(workspaceId));
    expect(second.result.current.openThreads).toEqual([
      { id: t1, title: "First" },
      { id: t2, title: "Second" },
    ]);
  });
});
