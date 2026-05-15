// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ArtifactId, WorkspaceId } from "@/lib/types";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

// Override only the two router hooks `useLibraryTabs` consumes; everything
// else (`matchRoutes`, used transitively by `@/route-paths`) stays real.
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
    // The hook only reads `?open=` from this in its lazy initializer; the
    // debounced writer reads `window.location.search` directly. Seeding from
    // the live URL keeps both code paths consistent in the test.
    useSearchParams: () => [new URLSearchParams(window.location.search), vi.fn()],
  };
});

import { useLibraryTabs } from "./use-library-tabs";

const workspaceId = "ws_libtabs" as WorkspaceId;
const artifactA = "artifact_a" as ArtifactId;
const artifactB = "artifact_b" as ArtifactId;

// This test runner ships only a partial `localStorage` (no `clear()`); swap in
// a memory-backed store so the hook's first-paint cache is deterministic.
// Mirrors `use-persisted-state.test.ts`.
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
  vi.useFakeTimers();
  navigateMock.mockReset();
  ensureTestLocalStorage();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLibraryTabs — URL writer", () => {
  test("preserves the page-owned ?ask= param when it writes ?open=", () => {
    // The page owns `?ask=`; this hook owns `?open=`. The debounced writer
    // must seed from the live URL so it does not clobber the Ask thread.
    window.history.replaceState({}, "", `/w/${workspaceId}/library?ask=thread_x`);

    const { result } = renderHook(() => useLibraryTabs(workspaceId, null));

    act(() => {
      result.current.openTab(artifactA);
      result.current.openTab(artifactB);
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(navigateMock).toHaveBeenCalled();
    const calls = navigateMock.mock.calls;
    const target = calls[calls.length - 1]?.[0] as string;
    expect(target).toContain("ask=thread_x");
    expect(target).toContain(`open=${artifactA}%2C${artifactB}`);
    expect(target.startsWith(`/w/${workspaceId}/library/a/${artifactB}`)).toBe(true);
  });

  test("clears a stale ?open= when the open set drops to one tab, keeping ?ask=", () => {
    window.history.replaceState(
      {},
      "",
      `/w/${workspaceId}/library/a/${artifactA}?ask=thread_x&open=${artifactA}%2C${artifactB}`,
    );

    const { result } = renderHook(() => useLibraryTabs(workspaceId, artifactA));

    act(() => {
      result.current.closeTab(artifactB);
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    const calls = navigateMock.mock.calls;
    const target = calls[calls.length - 1]?.[0] as string;
    expect(target).toContain("ask=thread_x");
    expect(target).not.toContain("open=");
  });
});
